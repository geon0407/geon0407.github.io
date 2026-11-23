#!/usr/bin/env python3
"""Private, repository-local Blog Studio. Never deploy this server to Pages."""
import argparse
import base64
import datetime as dt
import hashlib
import http.cookies
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote
import yaml

ROOT = Path(__file__).resolve().parents[2]
WEB = Path(__file__).parent / 'web'
STATE = Path(__file__).parent / '.state'
CONFIG = 'site/_data/studio.yml'
CATEGORIES = 'site/_data/blog_categories.yml'
REQUEST_LIMIT = 70 * 1024 * 1024  # a 50MB video, base64-encoded in JSON
UPLOAD_LIMIT = 20 * 1024 * 1024
VIDEO_LIMIT = 50 * 1024 * 1024
VIDEO_EXTENSIONS = {'.mp4', '.webm'}
EXTENSIONS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.pdf', '.txt', '.csv',
              '.zip', '.docx', '.xlsx', '.pptx', *VIDEO_EXTENSIONS}
TEXT_SUFFIXES = {'.md', '.markdown', '.html', '.yml', '.yaml', '.json', '.js', '.css', '.scss', '.txt'}
UPLOAD_REF = re.compile(r'/uploads/(\d{4}/\d{2}/[A-Za-z0-9_-]+\.[a-z0-9]+)')
UPLOAD_NAME = re.compile(r'\d{4}/\d{2}/[A-Za-z0-9_-]+\.[a-z0-9]+')
TRASH_ID = re.compile(r'\d{8}-\d{6}-[0-9a-f]{8}')
SESSION_IDLE_SECONDS = 12 * 60 * 60
LOCK = threading.RLock()
BOOT_KEY = secrets.token_urlsafe(32)
SESSIONS = {}  # token -> {'csrf': str, 'seen': float}


class Problem(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message, self.status = message, status


# ---------------------------------------------------------------- files

def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def stamp():
    return dt.datetime.now().strftime('%Y%m%d-%H%M%S-') + secrets.token_hex(4)


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp-' + secrets.token_hex(4))
    temp.write_bytes(data)
    os.replace(temp, path)


def inside(path, base):
    """Resolve path and refuse anything that escapes base."""
    resolved, base = Path(path).resolve(), Path(base).resolve()
    if not resolved.is_relative_to(base):
        raise Problem('허용되지 않은 경로입니다', 403)
    return resolved


def safe_path(relative):
    return inside(ROOT / relative, ROOT)


def pending():
    return read_json(STATE / 'pending.json', [])


def mark(relative):
    paths = set(pending())
    paths.add(relative)
    atomic(STATE / 'pending.json', json.dumps(sorted(paths)).encode())


def write_repo(relative, content):
    path = safe_path(relative)
    if path.exists():
        atomic(STATE / 'backups' / stamp() / relative, path.read_bytes())
    atomic(path, content)
    mark(relative)


def version(path):
    return digest(path.read_bytes()) if path.exists() else ''


def check_version(path, expected):
    if version(path) != expected:
        raise Problem('다른 탭 또는 작업에서 파일이 변경됐습니다. 목록을 다시 열어 최신 내용을 확인하세요', 409)


def yaml_bytes(data):
    return yaml.safe_dump(data, allow_unicode=True, sort_keys=False).encode()


def split_doc(text_value):
    parts = text_value.split('---', 2)
    if len(parts) != 3 or parts[0].strip():
        raise Problem('이 파일의 YAML 머리말을 읽을 수 없습니다')
    meta = yaml.safe_load(parts[1]) or {}
    return meta, parts[2].lstrip('\r\n')


def clean_json(data):
    return json.loads(json.dumps(data, default=str, ensure_ascii=False))


# ---------------------------------------------------------------- validation

def text(value, maxlen=5000):
    if not isinstance(value, str) or len(value) > maxlen:
        raise Problem('입력 길이 또는 형식을 확인하세요')
    return value


def url(value):
    text(value)
    is_site_path = value.startswith('/') and not value.startswith('//')
    if value and not is_site_path and urlparse(value).scheme not in ('https', 'http'):
        raise Problem('주소는 /로 시작하는 사이트 경로 또는 https:// 주소여야 합니다')
    return value


def categories():
    """Blog categories, read from the same file the public site uses."""
    path = safe_path(CATEGORIES)
    groups = (yaml.safe_load(path.read_text()) if path.exists() else None) or []
    result = []
    for group in groups:
        for topic in group.get('topics') or []:
            result.append({
                'slug': topic['slug'],
                'title': topic.get('title', topic['slug']),
                'title_ko': topic.get('title_ko') or topic.get('title', topic['slug']),
                'group': group.get('title', ''),
                'group_ko': group.get('title_ko') or group.get('title', ''),
            })
    return result


def validate_config(data):
    current = yaml.safe_load(safe_path(CONFIG).read_text())

    # Exact schema for settings except repeatable timeline entries.
    def shape(value, sample, key=''):
        if key == 'timeline':
            if not isinstance(value, list) or len(value) > 100:
                raise Problem('연혁은 100개 이하로 입력하세요')
            allowed = {'period', 'period_ko', 'title', 'title_ko', 'detail', 'detail_ko', 'url', 'group'}
            for entry in value:
                if not isinstance(entry, dict) or set(entry) - allowed:
                    raise Problem('연혁 형식이 잘못됐습니다')
                for v in entry.values():
                    text(v)
                if not entry.get('title') or not entry.get('title_ko'):
                    raise Problem('연혁 제목은 한국어와 영어를 입력하세요')
                if entry.get('group', 'research') not in ('background', 'research'):
                    raise Problem('연혁 구분이 잘못됐습니다')
                url(entry.get('url', ''))
            return
        if isinstance(sample, dict):
            if not isinstance(value, dict) or set(value) != set(sample):
                raise Problem('설정 항목이 변경됐습니다. 새로고침 후 다시 저장하세요')
            for k in sample:
                shape(value[k], sample[k], k)
        elif isinstance(sample, bool):
            if type(value) != bool:
                raise Problem('표시 옵션을 확인하세요')
        elif isinstance(sample, (int, float)):
            if type(value) not in (int, float):
                raise Problem('숫자를 입력하세요')
        else:
            text(value or '')

    shape(data, current)
    design = data['design']
    for mode in ('light', 'dark'):
        for color in design['colors'][mode].values():
            if not re.fullmatch(r'#[0-9a-fA-F]{6}', color):
                raise Problem('색상은 #RRGGBB 형식이어야 합니다')
    ranges = {'body_size': (16, 22), 'line_height': (1.4, 2), 'width': (960, 1440),
              'radius': (0, 32), 'section_gap': (24, 120), 'columns': (1, 3)}
    for key, (lo, hi) in ranges.items():
        if not lo <= design[key] <= hi:
            raise Problem(f'{key} 범위는 {lo}~{hi}입니다')
    if design['columns'] not in (1, 2, 3):
        raise Problem('열 수는 1, 2, 3 중 선택하세요')
    if data['home']['order'] not in ('projects-first', 'posts-first'):
        raise Problem('섹션 순서를 확인하세요')
    for v in [data['home']['image'], data['profile']['portrait']['path'],
              data['profile']['feature_photo']['path'], data['site']['avatar'],
              data['site']['github'], data['site']['instagram']]:
        url(v or '')
    return data


def save_config(data):
    path = safe_path(CONFIG)
    check_version(path, data.get('version'))
    config = validate_config(data['config'])
    write_repo(CONFIG, yaml_bytes(config))

    general = yaml.safe_load(safe_path('site/_data/general_settings.yml').read_text())
    general.update(title=config['site']['title'], description=config['site']['description'])
    write_repo('site/_data/general_settings.yml', yaml_bytes(general))

    author = yaml.safe_load(safe_path('site/_data/author.yml').read_text())
    author.update(author_name=config['site']['author'], author_image=config['site']['avatar'])
    write_repo('site/_data/author.yml', yaml_bytes(author))

    social = yaml.safe_load(safe_path('site/_data/social_links.yml').read_text())
    for item in social.get('social', []):
        for kind in ('github', 'instagram'):
            if kind in item.get('icon', '').lower() or kind in item.get('link', '').lower():
                item['link'] = config['site'][kind]
    write_repo('site/_data/social_links.yml', yaml_bytes(social))
    return {'version': version(path)}


# ---------------------------------------------------------------- posts & projects

def record_path(identifier):
    if re.fullmatch(r'draft-[0-9a-f]{24}', identifier):
        return STATE / 'drafts' / (identifier + '.json')
    if not re.fullmatch(r'site/collections/_(posts|projects)/[A-Za-z0-9_.-]+\.md', identifier):
        raise Problem('허용되지 않은 글 경로입니다')
    return safe_path(identifier)


def record(identifier):
    path = record_path(identifier)
    if not path.exists():
        raise Problem('글을 찾을 수 없습니다', 404)
    if identifier.startswith('draft-'):
        data = read_json(path)
    else:
        meta, body = split_doc(path.read_text())
        kind = 'post' if '/_posts/' in identifier else 'project'
        data = {'kind': kind, 'meta': meta, 'body': body, 'draft': False}
    return {**clean_json(data), 'id': identifier, 'version': version(path)}


def list_records():
    result = []
    for kind in ('posts', 'projects'):
        for path in sorted((ROOT / 'site/collections' / ('_' + kind)).glob('*.md')):
            result.append(record(path.relative_to(ROOT).as_posix()))
    for path in sorted((STATE / 'drafts').glob('*.json')):
        result.append(record(path.stem))
    return sorted(result, key=lambda x: str(x['meta'].get('date', '')), reverse=True)


def published_slug(peer, kind):
    """The URL slug a record owns (or will get back when it is republished)."""
    stem = Path(peer.get('source_id') or peer['id']).stem
    if kind == 'post':
        stem = re.sub(r'^\d{4}-\d{2}-\d{2}-', '', stem)
    return str(peer['meta'].get('slug') or stem)


def save_record(data):
    kind = data.get('kind')
    identifier = data.get('id', '')
    if kind not in ('post', 'project'):
        raise Problem('글 종류가 잘못됐습니다')
    old = None
    if identifier:
        path = record_path(identifier)
        check_version(path, data.get('version'))
        old = record(identifier)
        if old['kind'] != kind:
            raise Problem('기존 글 종류는 변경할 수 없습니다')

    meta = data.get('meta', {})
    if not isinstance(meta, dict):
        raise Problem('글 정보 형식이 잘못됐습니다')
    text(meta.get('title', ''), 300)
    if not meta.get('title', '').strip():
        raise Problem('제목을 입력하세요')
    text(meta.get('description', ''), 3000)
    text(meta.get('subtitle', ''), 1000)
    url(meta.get('image', ''))
    try:
        dt.date.fromisoformat(str(meta.get('date', ''))[:10])
    except ValueError:
        raise Problem('날짜를 확인하세요')
    for key in ('tags', 'categories'):
        values = meta.get(key, [])
        if not isinstance(values, list) or len(values) > 30:
            raise Problem('태그 또는 카테고리를 확인하세요')
        for v in values:
            text(v, 100)
    known = {c['slug'] for c in categories()}
    if any(v not in known for v in meta.get('categories', [])):
        raise Problem('카테고리를 확인하세요')
    body = text(data.get('body', ''), 2_000_000)
    draft = bool(data.get('draft'))

    # A public record turned private remembers where it came from.
    source_id = old.get('source_id', '') if old else ''
    if draft and old and not old['draft']:
        source_id = identifier

    original = dict(old['meta']) if old else {}
    for key in ('title', 'description', 'subtitle', 'image', 'date', 'tags', 'categories', 'lang'):
        original[key] = meta.get(key, [] if key in ('tags', 'categories') else '')
    original.update(layout=kind, render_with_liquid=False)
    original.pop('published', None)

    slug = text(data.get('slug', ''), 100).strip()
    number = str(meta.get('studio_number') or '').strip()
    peers = [r for r in list_records() if r['kind'] == kind and r['id'] != identifier]
    used_numbers = {str(r['meta'].get('studio_number')) for r in peers}
    if number and not re.fullmatch(r'[1-9][0-9]{0,8}', number):
        raise Problem('번호는 1 이상 9자리 이하의 정수로 입력하세요')
    if number and number in used_numbers:
        raise Problem('같은 종류의 글에 이미 사용 중인 번호입니다', 409)
    if not draft and not number:
        candidate = 1
        while str(candidate) in used_numbers:
            candidate += 1
        number = str(candidate)
    if number:
        original['studio_number'] = int(number)
    else:
        original.pop('studio_number', None)

    if draft:
        if not identifier.startswith('draft-'):
            identifier = 'draft-' + secrets.token_hex(12)
        atomic(record_path(identifier), json.dumps({
            'kind': kind, 'meta': original, 'body': body, 'draft': True,
            'slug': slug, 'source_id': source_id,
        }, ensure_ascii=False).encode())
        if old and not old['draft']:
            mark(source_id)
            record_path(source_id).unlink()
        return record(identifier)

    if source_id:
        identifier = source_id
        if record_path(identifier).exists():
            raise Problem('기존 주소의 파일이 이미 존재합니다', 409)
    elif not identifier or identifier.startswith('draft-'):
        if not slug:
            slug = f'{kind}-{number}'
        if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', slug):
            raise Problem('주소는 영문 소문자·숫자·하이픈으로 입력하세요')
        used_slugs = {published_slug(p, kind) for p in peers if not p['draft'] or p.get('source_id')}
        if slug in used_slugs:
            raise Problem('같은 주소의 글이 있습니다. 주소를 바꿔주세요', 409)
        filename = (str(original['date'])[:10] + '-' if kind == 'post' else '') + slug + '.md'
        identifier = f"site/collections/_{kind}s/{filename}"
        if record_path(identifier).exists():
            raise Problem('같은 주소의 글이 있습니다. 주소를 바꿔주세요', 409)
    content = b'---\n' + yaml_bytes(original) + b'---\n\n' + body.encode()
    write_repo(identifier, content if body.endswith('\n') else content + b'\n')
    if old and old['draft']:
        record_path(old['id']).unlink()
    return record(identifier)


# ---------------------------------------------------------------- trash
# Each entry is STATE/trash/<id>/ with `data` (file bytes) and `entry.json`:
#   {type: post|project|file, title, draft, deleted_at, targets: [{where: repo|state, path}]}
# `targets` says where restoring puts the bytes back.

def target_path(target):
    if target['where'] == 'repo':
        return safe_path(target['path'])
    return inside(STATE / target['path'], STATE)


def trash_put(content, info, deleted_at=None):
    entry = STATE / 'trash' / stamp()
    atomic(entry / 'data', content)
    info = {**info, 'deleted_at': (deleted_at or dt.datetime.now()).isoformat(timespec='seconds')}
    atomic(entry / 'entry.json', json.dumps(info, ensure_ascii=False).encode())


def migrate_legacy_trash():
    """Older versions stored deleted files flat as <stamp>-<filename>."""
    folder = STATE / 'trash'
    for path in list(folder.glob('*')) if folder.exists() else []:
        if not path.is_file():
            continue
        match = re.match(r'(\d{8}-\d{6})-', path.name)
        name = path.name[match.end():] if match else path.name
        deleted_at = dt.datetime.strptime(match[1], '%Y%m%d-%H%M%S') if match else None
        content = path.read_bytes()
        try:
            if name.endswith('.json'):
                data = json.loads(content)
                info = {'type': data['kind'], 'title': data['meta'].get('title', ''), 'draft': True,
                        'targets': [{'where': 'state', 'path': 'drafts/' + name}]}
            else:
                meta, _ = split_doc(content.decode())
                kind = 'post' if meta.get('layout') == 'post' else 'project'
                info = {'type': kind, 'title': meta.get('title', name), 'draft': False,
                        'targets': [{'where': 'repo', 'path': f'site/collections/_{kind}s/{name}'}]}
        except Exception:
            continue
        trash_put(content, info, deleted_at)
        path.unlink()


def trash_entry(entry_id):
    if not isinstance(entry_id, str) or not TRASH_ID.fullmatch(entry_id):
        raise Problem('휴지통 항목을 찾을 수 없습니다', 404)
    folder = STATE / 'trash' / entry_id
    if not (folder / 'entry.json').exists():
        raise Problem('휴지통 항목을 찾을 수 없습니다', 404)
    return folder


def list_trash():
    migrate_legacy_trash()
    result = []
    for folder in sorted((STATE / 'trash').glob('*'), reverse=True):
        if (folder / 'entry.json').exists():
            info = read_json(folder / 'entry.json')
            result.append({**info, 'id': folder.name, 'size': (folder / 'data').stat().st_size})
    return result


def archive_record(data):
    identifier = data.get('id', '')
    path = record_path(identifier)
    check_version(path, data.get('version'))
    item = record(identifier)
    target = ({'where': 'state', 'path': 'drafts/' + path.name} if item['draft']
              else {'where': 'repo', 'path': identifier})
    trash_put(path.read_bytes(), {'type': item['kind'], 'title': item['meta'].get('title', ''),
                                  'draft': item['draft'], 'targets': [target]})
    path.unlink()
    if not item['draft']:
        mark(identifier)
    return {'ok': True}


def restore_trash(data):
    folder = trash_entry(data.get('id'))
    info = read_json(folder / 'entry.json')
    content = (folder / 'data').read_bytes()
    for target in info['targets']:
        if target_path(target).exists():
            raise Problem('같은 위치에 이미 파일이 있어 복구할 수 없습니다. 기존 글의 주소를 확인하세요', 409)
    for target in info['targets']:
        if target['where'] == 'repo':
            write_repo(target['path'], content)
        else:
            atomic(target_path(target), content)
    shutil.rmtree(folder)
    return {'ok': True, 'public': any(t['where'] == 'repo' for t in info['targets'])}


def purge_trash(data):
    if data.get('id') == 'all':
        for folder in (STATE / 'trash').glob('*'):
            shutil.rmtree(folder) if folder.is_dir() else folder.unlink()
    else:
        shutil.rmtree(trash_entry(data.get('id')))
    return {'ok': True}


# ---------------------------------------------------------------- uploads

def upload(data):
    filename = text(data.get('name', ''), 300)
    ext = Path(filename).suffix.lower()
    if ext not in EXTENSIONS:
        raise Problem('지원 파일: PNG/JPG/GIF/WebP/AVIF, MP4/WebM 동영상, PDF, TXT, CSV, ZIP, Office 문서')
    try:
        content = base64.b64decode(data.get('data', ''), validate=True)
    except Exception:
        raise Problem('파일 데이터를 읽을 수 없습니다')
    if ext in VIDEO_EXTENSIONS:
        if not content or len(content) > VIDEO_LIMIT:
            raise Problem('동영상은 50MB 이하여야 합니다. 긴 영상은 유튜브에 올려 넣어주세요')
    elif not content or len(content) > UPLOAD_LIMIT:
        raise Problem('파일은 20MB 이하여야 합니다')
    relative = dt.datetime.now().strftime('%Y/%m/') + secrets.token_hex(12) + ext
    atomic(STATE / 'uploads' / relative, content)
    return {'url': '/uploads/' + relative, 'name': filename}


def upload_file(relative):
    """Locate an uploaded file for serving; only inside the two upload folders."""
    if not UPLOAD_NAME.fullmatch(relative) or Path(relative).suffix.lower() not in EXTENSIONS:
        raise Problem('파일을 찾을 수 없습니다', 404)
    for base in (ROOT / 'site/uploads', STATE / 'uploads'):
        path = inside(base / relative, base)
        if path.is_file():
            return path
    raise Problem('파일을 찾을 수 없습니다', 404)


def upload_references():
    """Every /uploads/ path mentioned by site sources, drafts or trashed posts."""
    sources = []
    site = ROOT / 'site'
    for path in site.rglob('*') if site.exists() else []:
        relative = path.relative_to(site)
        if (path.is_file() and path.suffix.lower() in TEXT_SUFFIXES and relative.parts[0] != 'uploads'
                and not any(part.startswith('.') for part in relative.parts)):
            sources.append(path)
    sources += (STATE / 'drafts').glob('*.json')
    for folder in (STATE / 'trash').glob('*'):
        info = read_json(folder / 'entry.json', {}) if folder.is_dir() else {}
        if info.get('type') in ('post', 'project'):
            sources.append(folder / 'data')
    refs = set()
    for path in sources:
        refs.update(UPLOAD_REF.findall(path.read_text(errors='ignore')))
    return refs


def list_uploads():
    refs = upload_references()
    files = {}
    for where, base in (('state', STATE / 'uploads'), ('repo', ROOT / 'site/uploads')):
        for path in base.rglob('*') if base.exists() else []:
            relative = path.relative_to(base).as_posix()
            if path.is_file() and UPLOAD_NAME.fullmatch(relative):
                item = files.setdefault(relative, {'path': relative, 'url': '/uploads/' + relative,
                                                   'size': path.stat().st_size, 'where': [],
                                                   'mtime': path.stat().st_mtime, 'used': relative in refs})
                item['where'].append(where)
    return sorted(files.values(), key=lambda f: f['mtime'], reverse=True)


def delete_upload(data):
    relative = data.get('path', '')
    if not isinstance(relative, str) or not UPLOAD_NAME.fullmatch(relative):
        raise Problem('파일 경로가 잘못됐습니다')
    if relative in upload_references():
        raise Problem('글이나 설정에서 사용 중인 파일은 삭제할 수 없습니다', 409)
    targets = [t for t in ({'where': 'state', 'path': 'uploads/' + relative},
                           {'where': 'repo', 'path': 'site/uploads/' + relative})
               if target_path(t).is_file()]
    if not targets:
        raise Problem('파일을 찾을 수 없습니다', 404)
    trash_put(target_path(targets[0]).read_bytes(),
              {'type': 'file', 'title': relative, 'draft': False, 'targets': targets})
    for target in targets:
        target_path(target).unlink()
        if target['where'] == 'repo':
            mark(target['path'])
    return {'ok': True}


# ---------------------------------------------------------------- build & publish

def command(args, timeout=120, strip=True, env=None):
    try:
        r = subprocess.run(args, cwd=ROOT, text=True, encoding='utf-8', errors='replace',
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout,
                           env={**os.environ, **(env or {})})
    except FileNotFoundError:
        raise Problem(f'{args[0]} 명령을 찾을 수 없습니다. 설치 안내(README)를 확인하세요', 500)
    except subprocess.TimeoutExpired:
        raise Problem('작업 시간이 초과됐습니다. 터미널에서 상태를 확인하세요', 504)
    if r.returncode:
        raise Problem(r.stdout[-12000:], 422)
    return r.stdout.strip() if strip else r.stdout


def missing_public_assets():
    """Uploads referenced by public content that still only live in the private state."""
    missing = set()
    for path in [safe_path(CONFIG), *[record_path(r['id']) for r in list_records() if not r['draft']]]:
        for relative in UPLOAD_REF.findall(path.read_text()):
            if (STATE / 'uploads' / relative).is_file() and not safe_path('site/uploads/' + relative).exists():
                missing.add(relative)
    return sorted(missing)


def collect_public_assets():
    for relative in missing_public_assets():
        write_repo('site/uploads/' + relative, (STATE / 'uploads' / relative).read_bytes())


def owned_paths():
    """Pending Studio changes that git can stage."""
    tracked = set(command(['git', 'ls-files']).splitlines())
    return [p for p in pending() if p.startswith(('site/', 'component-library/'))
            and (safe_path(p).exists() or p in tracked)]


def describe(path):
    match = re.fullmatch(r'site/collections/_(posts|projects)/.+\.md', path)
    if match:
        label = '게시글' if match[1] == 'posts' else '프로젝트'
        try:
            source = safe_path(path).read_text() if safe_path(path).exists() else command(
                ['git', 'show', 'HEAD:' + path], strip=False)
            return label, str(split_doc(source)[0].get('title') or Path(path).stem)
        except Problem:
            return label, Path(path).stem
    if path.startswith('site/uploads/'):
        return '첨부파일', path.removeprefix('site/uploads/')
    if path.startswith('site/_data/'):
        return '사이트 설정', Path(path).name
    return '파일', path


def changes():
    """What the next publish will add, modify or delete."""
    items = []
    paths = owned_paths()
    if paths:
        out = command(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', *paths],
                      strip=False)
        for entry in filter(None, out.split('\0')):
            code, path = entry[:2], entry[3:]
            status = 'added' if code == '??' or code[0] == 'A' else 'deleted' if 'D' in code else 'modified'
            label, title = describe(path)
            items.append({'path': path, 'status': status, 'label': label, 'title': title})
    known = {i['path'] for i in items}
    for relative in missing_public_assets():
        if 'site/uploads/' + relative not in known:
            items.append({'path': 'site/uploads/' + relative, 'status': 'added',
                          'label': '첨부파일', 'title': relative})
    order = {'게시글': 0, '프로젝트': 1, '사이트 설정': 2, '첨부파일': 3, '파일': 4}
    return sorted(items, key=lambda i: (order[i['label']], i['path']))


def commit_message(items):
    verbs = {'added': 'add', 'modified': 'update', 'deleted': 'remove'}
    parts = []
    for item in items:
        if item['label'] in ('게시글', '프로젝트'):
            kind = 'post' if item['label'] == '게시글' else 'project'
            title = item['title'] if len(item['title']) <= 40 else item['title'][:39] + '…'
            parts.append(f'{verbs[item["status"]]} {kind} "{title}"')
    if any(i['label'] == '사이트 설정' for i in items):
        parts.append('update site settings')
    files = sum(i['label'] == '첨부파일' for i in items)
    if files:
        parts.append(f'{files} attachment' + ('s' if files > 1 else ''))
    subject = '; '.join(parts[:3]) + (f' and {len(parts) - 3} more' if len(parts) > 3 else '')
    body = '\n'.join(f'- {verbs[i["status"]]}: {i["path"]}' for i in items)
    return f'content(studio): {subject or "update blog content"}\n\n{body}'.strip()


def publish_summary():
    try:
        ahead = int(command(['git', 'rev-list', '--count', 'origin/main..HEAD']))
    except Problem:
        ahead = 0
    return {'items': changes(), 'ahead': ahead}


def build():
    collect_public_assets()
    log = command(['npm', 'run', 'build'], 300)
    if not (ROOT / '_site/index.html').exists():
        raise Problem('빌드 결과를 찾지 못했습니다', 422)
    return {'url': '/preview/', 'log': log[-5000:]}


def publish():
    if command(['git', 'branch', '--show-current']) != 'main':
        raise Problem('발행은 main 브랜치에서 실행하세요')
    command(['git', 'fetch', 'origin', 'main'])
    if int(command(['git', 'rev-list', '--count', 'HEAD..origin/main'])):
        raise Problem('원격 저장소에 새 변경이 있습니다. 먼저 터미널에서 git pull --rebase origin main을 실행하세요', 409)
    collect_public_assets()
    paths = owned_paths()
    staged = command(['git', 'diff', '--cached', '--name-only']).splitlines()
    if set(staged) - set(paths):
        raise Problem('관리 화면 밖에서 스테이징한 파일이 있습니다. 먼저 해당 커밋을 정리하세요', 409)
    build()
    if paths:
        items = changes()
        command(['git', 'add', '--', *paths])
        if command(['git', 'diff', '--cached', '--name-only']):
            command(['git', 'commit', '-m', commit_message(items)])
    command(['git', 'push', 'origin', 'main'])
    atomic(STATE / 'pending.json', b'[]')
    return {'ok': True, 'message': 'GitHub에 업로드했습니다. Actions 배포 완료 후 공개 사이트에 반영됩니다.',
            'url': 'https://github.com/geon0407/geon0407.github.io/actions'}


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, data, status=200, headers=None):
        body = json.dumps(data, ensure_ascii=False, default=str).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def session_token(self):
        try:
            return http.cookies.SimpleCookie(self.headers.get('Cookie', ''))['studio_session'].value
        except (KeyError, http.cookies.CookieError):
            return None

    def authenticated(self):
        """Return the session's CSRF token, refreshing its idle timer."""
        token = self.session_token()
        session = SESSIONS.get(token)
        if session and time.time() - session['seen'] > SESSION_IDLE_SECONDS:
            SESSIONS.pop(token, None)
            session = None
        if not session:
            raise Problem('로그인이 필요합니다. 관리 키를 입력하거나 터미널의 관리 화면 주소를 다시 여세요', 401)
        session['seen'] = time.time()
        return session['csrf']

    def origin_check(self):
        origin = self.headers.get('Origin', '')
        fetch_site = self.headers.get('Sec-Fetch-Site')
        if fetch_site == 'same-origin':
            return
        if fetch_site in ('cross-site', 'same-site') or origin not in self.server.origins:
            raise Problem('다른 사이트에서 보낸 요청은 허용하지 않습니다', 403)

    def json_body(self):
        size = int(self.headers.get('Content-Length', '0'))
        if size < 1 or size > REQUEST_LIMIT:
            raise Problem('요청 크기를 확인하세요', 413)
        if not self.headers.get('Content-Type', '').startswith('application/json'):
            raise Problem('JSON 요청만 허용됩니다', 415)
        data = json.loads(self.rfile.read(size))
        if not isinstance(data, dict):
            raise Problem('요청 형식이 잘못됐습니다')
        return data

    def do_POST(self):
        try:
            self.origin_check()
            path = urlparse(self.path).path
            if path == '/api/session':
                return self.login()
            csrf = self.authenticated()
            if not secrets.compare_digest(self.headers.get('X-Studio-CSRF', ''), csrf):
                raise Problem('페이지를 새로고침 후 다시 시도하세요', 403)
            data = self.json_body()
            if path == '/api/logout':
                SESSIONS.pop(self.session_token(), None)
                return self.respond({'ok': True}, headers={
                    'Set-Cookie': 'studio_session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/'})
            actions = {
                '/api/settings': save_config,
                '/api/save': save_record,
                '/api/archive': archive_record,
                '/api/restore': restore_trash,
                '/api/purge': purge_trash,
                '/api/upload': upload,
                '/api/delete-upload': delete_upload,
                '/api/build': lambda _: build(),
                '/api/publish': lambda _: publish(),
            }
            if path not in actions:
                raise Problem('잘못된 요청입니다', 404)
            with LOCK:
                result = actions[path](data)
            self.respond(result)
        except Problem as e:
            self.respond({'error': e.message}, e.status)
        except Exception as e:
            self.respond({'error': str(e)}, 400)

    def login(self):
        data = self.json_body()
        if not secrets.compare_digest(str(data.get('key', '')), BOOT_KEY):
            raise Problem('관리 키가 맞지 않습니다', 403)
        token = secrets.token_urlsafe(32)
        SESSIONS[token] = {'csrf': secrets.token_urlsafe(32), 'seen': time.time()}
        secure = '; Secure' if self.headers.get('Origin', '').startswith('https:') else ''
        return self.respond({'ok': True}, headers={
            'Set-Cookie': f'studio_session={token}; HttpOnly; SameSite=Strict; Path=/{secure}'})

    def send_file(self, path):
        if not path.is_file():
            raise Problem('파일을 찾을 수 없습니다', 404)
        content = path.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', mimetypes.guess_type(str(path))[0] or 'application/octet-stream')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(content)

    def send_preview_page(self, path):
        if not path.is_file():
            raise Problem('미리보기 페이지를 찾을 수 없습니다', 404)
        page = path.read_text(encoding='utf-8')
        # The preview sandbox disables the theme script that clears the loading overlay.
        style = '<style>body::after{display:none!important}.lazy{opacity:1!important}</style>'
        page = re.sub(r'</head>', lambda match: style + match[0], page, count=1, flags=re.I)
        page = re.sub(r"""(\bhref=["'])/(?=["'])""", r'\g<1>/preview/', page, flags=re.I)
        script_hashes = []
        for name in ('theme.js', 'language.js'):
            script = (ROOT / 'site' / 'js' / name).read_text(encoding='utf-8')
            script = re.sub(r'</script', lambda match: '<\\/' + match[0][2:], script, flags=re.I)
            script_digest = base64.b64encode(hashlib.sha256(script.encode('utf-8')).digest()).decode('ascii')
            script_hashes.append(f"'sha256-{script_digest}'")
            page = re.sub(r'</body>', lambda match: f'<script>{script}</script>' + match[0],
                          page, count=1, flags=re.I)
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Security-Policy',
                         f"sandbox allow-same-origin allow-scripts; script-src {' '.join(script_hashes)}; "
                         "form-action 'none'; object-src 'none'")
        self.end_headers()
        self.wfile.write(page.encode('utf-8'))

    def do_GET(self):
        try:
            route = unquote(urlparse(self.path).path)
            if route in ('/studio', '/'):
                return self.send_file(WEB / 'index.html')
            if route.startswith('/studio/'):
                return self.send_file(inside(WEB / route.removeprefix('/studio/'), WEB))
            csrf = self.authenticated()
            api = {
                '/api/changes': publish_summary,
                '/api/trash': lambda: {'items': list_trash()},
                '/api/uploads': lambda: {'items': list_uploads()},
            }
            if route == '/api/state':
                with LOCK:
                    return self.respond({
                        'csrf': csrf, 'config': yaml.safe_load(safe_path(CONFIG).read_text()),
                        'version': version(safe_path(CONFIG)), 'records': list_records(),
                        'pending': pending(), 'categories': categories(),
                    })
            if route in api:
                with LOCK:
                    return self.respond(api[route]())
            if route.startswith('/uploads/'):
                return self.send_file(upload_file(route.removeprefix('/uploads/')))
            relative = route.removeprefix('/preview') if route.startswith('/preview/') else route
            path = inside(ROOT / '_site' / relative.lstrip('/'), ROOT / '_site')
            if path.is_dir():
                path = path / 'index.html'
            if path.suffix == '.html':
                return self.send_preview_page(path)
            self.send_file(path)
        except Problem as e:
            self.respond({'error': e.message}, e.status)
        except Exception as e:
            self.respond({'error': str(e)}, 400)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8787)
    args = parser.parse_args()
    STATE.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    origin = f'http://localhost:{args.port}'
    server.origins = {origin, f'http://127.0.0.1:{args.port}'}
    if os.getenv('CODESPACE_NAME'):
        domain = os.getenv('GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN', 'app.github.dev')
        origin = f'https://{os.environ["CODESPACE_NAME"]}-{args.port}.{domain}'
        server.origins.add(origin)
        try:
            subprocess.run(['gh', 'codespace', 'ports', 'visibility', f'{args.port}:private',
                            '-c', os.environ['CODESPACE_NAME']],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=20)
        except Exception:
            print('Ports 탭에서 8787의 Visibility가 Private인지 확인하세요.', flush=True)
    print('\nBlog Studio — 아래 주소를 본인 브라우저에서 열어주세요 (주소 공유 금지)\n'
          + origin + '/studio#key=' + BOOT_KEY + '\n', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
