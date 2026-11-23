#!/usr/bin/env python3
"""Private, repository-local Blog Studio. Never deploy this server to Pages."""
import argparse
import base64
import datetime as dt
import hashlib
import html
import http.cookies
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote
import yaml

ROOT = Path(__file__).resolve().parents[2]
WEB = Path(__file__).parent / 'web'
STATE = Path(__file__).parent / '.state'
CONFIG = 'site/_data/studio.yml'
LIMIT = 28 * 1024 * 1024
EXTENSIONS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.pdf', '.txt', '.csv', '.zip', '.docx', '.xlsx', '.pptx'}
LOCK = threading.RLock()
BOOT_KEY = secrets.token_urlsafe(32)
SESSIONS = {}

class Problem(Exception):
    def __init__(self, message, status=400): self.message, self.status = message, status

def digest(data): return hashlib.sha256(data).hexdigest()
def read_json(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default

def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp-' + secrets.token_hex(4))
    temp.write_bytes(data)
    os.replace(temp, path)

def safe_path(relative):
    path = (ROOT / relative).resolve()
    if not path.is_relative_to(ROOT.resolve()): raise Problem('허용되지 않은 경로입니다')
    return path

def pending(): return read_json(STATE / 'pending.json', [])
def mark(relative):
    paths = set(pending()); paths.add(relative)
    atomic(STATE / 'pending.json', json.dumps(sorted(paths)).encode())

def write_repo(relative, content):
    path = safe_path(relative)
    if path.exists():
        backup = STATE / 'backups' / (dt.datetime.now().strftime('%Y%m%d-%H%M%S-') + secrets.token_hex(4)) / relative
        atomic(backup, path.read_bytes())
    atomic(path, content)
    mark(relative)

def version(path): return digest(path.read_bytes()) if path.exists() else ''
def check_version(path, expected):
    if version(path) != expected: raise Problem('다른 탭 또는 작업에서 파일이 변경됐습니다. 목록을 다시 열어 최신 내용을 확인하세요', 409)

def yaml_bytes(data): return yaml.safe_dump(data, allow_unicode=True, sort_keys=False).encode()
def split_doc(text):
    parts = text.split('---', 2)
    if len(parts) != 3 or parts[0].strip(): raise Problem('이 파일의 YAML 머리말을 읽을 수 없습니다')
    meta = yaml.safe_load(parts[1]) or {}
    return meta, parts[2].lstrip('\r\n')

def clean_json(data): return json.loads(json.dumps(data, default=str, ensure_ascii=False))
def text(value, maxlen=5000):
    if not isinstance(value, str) or len(value) > maxlen: raise Problem('입력 길이 또는 형식을 확인하세요')
    return value

def url(value):
    text(value)
    if value and not (value.startswith('/') and not value.startswith('//')) and urlparse(value).scheme not in ('https', 'http'):
        raise Problem('주소는 /로 시작하는 사이트 경로 또는 https:// 주소여야 합니다')
    return value

def validate_config(data):
    current = yaml.safe_load(safe_path(CONFIG).read_text())
    # Exact schema for settings except repeatable timeline entries.
    def shape(value, sample, key=''):
        if key == 'timeline':
            if not isinstance(value, list) or len(value)>100: raise Problem('연혁은 100개 이하로 입력하세요')
            allowed = {'period','period_ko','title','title_ko','detail','detail_ko','url','group'}
            for entry in value:
                if not isinstance(entry,dict) or set(entry)-allowed: raise Problem('연혁 형식이 잘못됐습니다')
                for v in entry.values(): text(v)
                if not entry.get('title') or not entry.get('title_ko'): raise Problem('연혁 제목은 한국어와 영어를 입력하세요')
                if entry.get('group','research') not in ('background','research'): raise Problem('연혁 구분이 잘못됐습니다')
                url(entry.get('url',''))
            return
        if isinstance(sample, dict):
            if not isinstance(value,dict) or set(value)!=set(sample): raise Problem('설정 항목이 변경됐습니다. 새로고침 후 다시 저장하세요')
            for k in sample: shape(value[k],sample[k],k)
        elif isinstance(sample,bool):
            if type(value)!=bool: raise Problem('표시 옵션을 확인하세요')
        elif isinstance(sample,(int,float)):
            if type(value) not in (int,float): raise Problem('숫자를 입력하세요')
        else: text(value or '')
    shape(data,current)
    for mode in ('light','dark'):
        for color in data['design']['colors'][mode].values():
            if not re.fullmatch(r'#[0-9a-fA-F]{6}',color): raise Problem('색상은 #RRGGBB 형식이어야 합니다')
    ranges={'body_size':(16,22),'line_height':(1.4,2),'width':(960,1440),'radius':(0,32),'section_gap':(24,120),'columns':(1,3)}
    for key,(lo,hi) in ranges.items():
        if not lo <= data['design'][key] <= hi: raise Problem(f'{key} 범위는 {lo}~{hi}입니다')
    if data['design']['columns'] not in (1,2,3): raise Problem('열 수는 1, 2, 3 중 선택하세요')
    if data['home']['order'] not in ('projects-first','posts-first'): raise Problem('섹션 순서를 확인하세요')
    for v in [data['home']['image'],data['profile']['portrait']['path'],data['profile']['feature_photo']['path'],data['site']['avatar'],data['site']['github'],data['site']['instagram']]: url(v or '')
    return data

def save_config(data):
    path=safe_path(CONFIG);check_version(path,data.get('version'))
    config=validate_config(data['config'])
    write_repo(CONFIG,yaml_bytes(config))
    general=yaml.safe_load(safe_path('site/_data/general_settings.yml').read_text())
    general.update(title=config['site']['title'],description=config['site']['description'])
    write_repo('site/_data/general_settings.yml',yaml_bytes(general))
    author=yaml.safe_load(safe_path('site/_data/author.yml').read_text())
    author.update(author_name=config['site']['author'],author_image=config['site']['avatar'])
    write_repo('site/_data/author.yml',yaml_bytes(author))
    social=yaml.safe_load(safe_path('site/_data/social_links.yml').read_text())
    for item in social.get('social',[]):
        for kind in ('github','instagram'):
            if kind in item.get('icon','').lower() or kind in item.get('link','').lower():item['link']=config['site'][kind]
    write_repo('site/_data/social_links.yml',yaml_bytes(social))
    return {'version':version(path)}

def record_path(identifier):
    if re.fullmatch(r'draft-[0-9a-f]{24}',identifier): return STATE/'drafts'/(identifier+'.json')
    if not re.fullmatch(r'site/collections/_(posts|projects)/[A-Za-z0-9_.-]+\.md',identifier):raise Problem('허용되지 않은 글 경로입니다')
    return safe_path(identifier)

def record(identifier):
    path=record_path(identifier)
    if not path.exists():raise Problem('글을 찾을 수 없습니다',404)
    if identifier.startswith('draft-'): data=read_json(path)
    else:
        meta,body=split_doc(path.read_text());data={'kind':'post' if '/_posts/' in identifier else 'project','meta':meta,'body':body,'draft':False}
    return {**clean_json(data),'id':identifier,'version':version(path)}

def list_records():
    result=[]
    for kind in ('posts','projects'):
        for path in sorted((ROOT/'site/collections'/('_'+kind)).glob('*.md')):
            result.append(record(str(path.relative_to(ROOT))))
    for path in sorted((STATE/'drafts').glob('*.json')): result.append(record(path.stem))
    return sorted(result,key=lambda x:str(x['meta'].get('date','')),reverse=True)

def save_record(data):
    kind=data.get('kind'); identifier=data.get('id','')
    if kind not in ('post','project'):raise Problem('글 종류가 잘못됐습니다')
    old=None
    if identifier:
        path=record_path(identifier);check_version(path,data.get('version'));old=record(identifier)
        if old['kind']!=kind:raise Problem('기존 글 종류는 변경할 수 없습니다')
    meta=data.get('meta',{});text(meta.get('title',''),300)
    if not meta.get('title','').strip():raise Problem('제목을 입력하세요')
    text(meta.get('description',''),3000);text(meta.get('subtitle',''),1000)
    url(meta.get('image',''))
    try:dt.date.fromisoformat(str(meta.get('date',''))[:10])
    except ValueError:raise Problem('날짜를 확인하세요')
    for key in ('tags','categories'):
        if not isinstance(meta.get(key,[]),list) or len(meta.get(key,[]))>30:raise Problem('태그 또는 카테고리를 확인하세요')
        for v in meta.get(key,[]):text(v,100)
    if any(v not in ('diary','thoughts','paper-reviews','algorithms') for v in meta.get('categories',[])):raise Problem('카테고리를 확인하세요')
    body=text(data.get('body',''),2_000_000)
    draft=bool(data.get('draft'))
    source_id = old.get('source_id', '') if old else ''
    if draft and old and not old['draft']:
        source_id = identifier
    original=dict(old['meta']) if old else {}
    for key in ('title','description','subtitle','image','date','tags','categories','lang'):original[key]=meta.get(key,'' if key not in ('tags','categories') else [])
    original.update(layout=kind,render_with_liquid=False)
    original.pop('published',None)
    slug = text(data.get('slug', ''), 100).strip()
    number = str(meta.get('studio_number') or '').strip()
    peers = [record for record in list_records()
             if record['kind'] == kind and record['id'] != identifier]
    used_numbers = {str(record['meta'].get('studio_number')) for record in peers}
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
        identifier = identifier if identifier.startswith('draft-') else 'draft-' + secrets.token_hex(12)
        atomic(record_path(identifier), json.dumps({
            'kind': kind, 'meta': original, 'body': body, 'draft': True,
            'slug': slug, 'source_id': source_id,
        }, ensure_ascii=False).encode())
        if old and not old['draft']:
            mark(source_id)
            record_path(source_id).unlink()
    else:
        if source_id:
            identifier = source_id
            if record_path(identifier).exists():
                raise Problem('기존 주소의 파일이 이미 존재합니다', 409)
        elif not identifier or identifier.startswith('draft-'):
            if not slug:
                slug = f'{kind}-{number}'
            used_slugs = {
                str(peer['meta'].get('slug') or re.sub(
                    r'^\d{4}-\d{2}-\d{2}-' if kind == 'post' else r'(?!)',
                    '', Path(peer.get('source_id') or peer['id']).stem))
                for peer in peers if not peer['draft'] or peer.get('source_id')
            }
            if slug in used_slugs:
                raise Problem('같은 주소의 글이 있습니다. 주소를 바꿔주세요', 409)
            if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*',slug):raise Problem('주소는 영문 소문자·숫자·하이픈으로 입력하세요')
            filename=(str(original['date'])[:10]+'-' if kind=='post' else '')+slug+'.md'
            identifier='site/collections/_'+('posts' if kind=='post' else 'projects')+'/'+filename
            if record_path(identifier).exists():raise Problem('같은 주소의 글이 있습니다. 주소를 바꿔주세요',409)
        write_repo(identifier,b'---\n'+yaml_bytes(original)+b'---\n\n'+body.encode()+(b'' if body.endswith('\n') else b'\n'))
        if old and old['draft']:record_path(old['id']).unlink()
    return record(identifier)

def archive_record(data):
    identifier=data['id'];path=record_path(identifier);check_version(path,data.get('version'))
    target=STATE/'trash'/(dt.datetime.now().strftime('%Y%m%d-%H%M%S-')+path.name)
    atomic(target,path.read_bytes());path.unlink()
    if not identifier.startswith('draft-'):mark(identifier)
    return {'ok':True}

def upload(data):
    filename=text(data.get('name',''),300);ext=Path(filename).suffix.lower()
    if ext not in EXTENSIONS:raise Problem('지원 파일: PNG/JPG/GIF/WebP/AVIF, PDF, TXT, CSV, ZIP, Office 문서')
    try:content=base64.b64decode(data.get('data',''),validate=True)
    except Exception:raise Problem('파일 데이터를 읽을 수 없습니다')
    if not content or len(content)>20*1024*1024:raise Problem('파일은 20MB 이하여야 합니다')
    relative='site/uploads/'+dt.datetime.now().strftime('%Y/%m/')+secrets.token_hex(12)+ext
    atomic(STATE / 'uploads' / relative.removeprefix('site/uploads/'),content)
    return {'url':'/'+relative.removeprefix('site/'),'name':filename}

def command(args,timeout=120):
    try:r=subprocess.run(args,cwd=ROOT,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=timeout)
    except subprocess.TimeoutExpired:raise Problem('작업 시간이 초과됐습니다. 터미널에서 상태를 확인하세요',504)
    if r.returncode:raise Problem(r.stdout[-12000:],422)
    return r.stdout.strip()

def collect_public_assets():
    for path in [safe_path(CONFIG), *[record_path(r['id']) for r in list_records() if not r['draft']]]:
        for relative in re.findall(r'/uploads/(\d{4}/\d{2}/[a-f0-9]{24}\.[a-z0-9]+)', path.read_text()):
            asset = STATE / 'uploads' / relative
            destination = 'site/uploads/' + relative
            if asset.is_file() and not safe_path(destination).exists():
                write_repo(destination, asset.read_bytes())

def build():
    collect_public_assets()
    log=command(['npm','run','build'],180)
    if not (ROOT/'_site/index.html').exists():raise Problem('빌드 결과를 찾지 못했습니다',422)
    return {'url':'/preview/','log':log[-5000:]}

def publish():
    if command(['git','branch','--show-current'])!='main':raise Problem('발행은 main 브랜치에서 실행하세요')
    command(['git','fetch','origin','main'])
    behind=int(command(['git','rev-list','--count','HEAD..origin/main']))
    if behind:raise Problem('원격 저장소에 새 변경이 있습니다. 먼저 터미널에서 git pull --rebase origin main을 실행하세요',409)
    collect_public_assets()
    tracked = set(command(['git', 'ls-files']).splitlines())
    paths = [p for p in pending() if p.startswith(('site/', 'component-library/'))
             and (safe_path(p).exists() or p in tracked)]
    staged=command(['git','diff','--cached','--name-only']).splitlines()
    if set(staged)-set(paths):raise Problem('관리 화면 밖에서 스테이징한 파일이 있습니다. 먼저 해당 커밋을 정리하세요',409)
    build()
    if paths:
        command(['git','add','--',*paths])
        if command(['git','diff','--cached','--name-only']):
            command(['git','commit','-m','content(studio): update blog content and appearance'])
    command(['git','push','origin','main'])
    atomic(STATE/'pending.json',b'[]')
    return {'ok':True,'message':'GitHub에 업로드했습니다. Actions 배포 완료 후 공개 사이트에 반영됩니다.','url':'https://github.com/geon0407/geon0407.github.io/actions'}

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def respond(self,data,status=200,headers=None):
        body=json.dumps(data,ensure_ascii=False,default=str).encode()
        self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Cache-Control','no-store')
        for k,v in (headers or {}).items():self.send_header(k,v)
        self.end_headers();self.wfile.write(body)
    def session(self):
        try:
            c=http.cookies.SimpleCookie(self.headers.get('Cookie',''));value=c['studio_session'].value
            return SESSIONS.get(value)
        except (KeyError,http.cookies.CookieError):return None
    def authenticated(self):
        session=self.session()
        if not session:raise Problem('터미널의 관리 화면 주소를 다시 열어 로그인하세요',401)
        return session
    def origin_check(self):
        origin=self.headers.get('Origin','')
        fetch_site = self.headers.get('Sec-Fetch-Site')
        if fetch_site == 'same-origin':
            return
        if fetch_site in ('cross-site', 'same-site') or origin not in self.server.origins:raise Problem('다른 사이트에서 보낸 요청은 허용하지 않습니다',403)
    def json_body(self):
        size=int(self.headers.get('Content-Length','0'))
        if size<1 or size>LIMIT:raise Problem('요청 크기를 확인하세요',413)
        if not self.headers.get('Content-Type','').startswith('application/json'):raise Problem('JSON 요청만 허용됩니다',415)
        return json.loads(self.rfile.read(size))
    def do_POST(self):
        try:
            self.origin_check();path=urlparse(self.path).path
            if path=='/api/session':
                data=self.json_body()
                if not secrets.compare_digest(str(data.get('key','')),BOOT_KEY):raise Problem('관리 키가 맞지 않습니다',403)
                token=secrets.token_urlsafe(32);SESSIONS[token]=secrets.token_urlsafe(32)
                secure='; Secure' if self.headers.get('Origin','').startswith('https:') else ''
                return self.respond({'ok':True},headers={'Set-Cookie':f'studio_session={token}; HttpOnly; SameSite=Strict; Path=/{secure}'})
            csrf=self.authenticated()
            if not secrets.compare_digest(self.headers.get('X-Studio-CSRF',''),csrf):raise Problem('페이지를 새로고침 후 다시 시도하세요',403)
            data=self.json_body()
            with LOCK:
                actions={'/api/settings':save_config,'/api/save':save_record,'/api/archive':archive_record,'/api/upload':upload,'/api/build':lambda _:build(),'/api/publish':lambda _:publish()}
                if path not in actions:raise Problem('잘못된 요청입니다',404)
                result=actions[path](data)
            self.respond(result)
        except Problem as e:self.respond({'error':e.message},e.status)
        except Exception as e:self.respond({'error':str(e)},400)
    def send_file(self,path):
        if not path.is_file():raise Problem('파일을 찾을 수 없습니다',404)
        content=path.read_bytes();self.send_response(200)
        mime=mimetypes.guess_type(str(path))[0] or 'application/octet-stream'
        self.send_header('Content-Type',mime);self.send_header('X-Content-Type-Options','nosniff');self.send_header('Cache-Control','no-store')
        self.end_headers();self.wfile.write(content)
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
            digest = base64.b64encode(hashlib.sha256(script.encode('utf-8')).digest()).decode('ascii')
            script_hashes.append(f"'sha256-{digest}'")
            page = re.sub(r'</body>', lambda match: f'<script>{script}</script>' + match[0],
                          page, count=1, flags=re.I)
        allowed_scripts = ' '.join(script_hashes)
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Security-Policy', f"sandbox allow-same-origin allow-scripts; script-src {allowed_scripts}; form-action 'none'; object-src 'none'")
        self.end_headers()
        self.wfile.write(page.encode('utf-8'))

    def do_GET(self):
        try:
            route=unquote(urlparse(self.path).path)
            if route=='/studio' or route=='/':
                return self.send_file(WEB/'index.html')
            if route.startswith('/studio/'):
                path=(WEB/route.removeprefix('/studio/')).resolve()
                if not path.is_relative_to(WEB.resolve()):raise Problem('잘못된 경로입니다',403)
                return self.send_file(path)
            csrf=self.authenticated()
            if route=='/api/state':
                with LOCK:
                    return self.respond({'csrf':csrf,'config':yaml.safe_load(safe_path(CONFIG).read_text()),'version':version(safe_path(CONFIG)),'records':list_records(),'pending':pending()})
            if route.startswith('/uploads/'):
                path=safe_path('site'+route)
                if not path.is_file():
                    path=(STATE/'uploads'/route.removeprefix('/uploads/')).resolve()
                    if not path.is_relative_to((STATE/'uploads').resolve()):raise Problem('잘못된 경로입니다',403)
            else:
                relative=route.removeprefix('/preview') if route.startswith('/preview/') else route
                path=(ROOT/'_site'/relative.lstrip('/')).resolve()
                if not path.is_relative_to((ROOT/'_site').resolve()):raise Problem('잘못된 경로입니다',403)
                if path.is_dir():path=path/'index.html'
                if path.suffix == '.html':
                    return self.send_preview_page(path)
            self.send_file(path)
        except Problem as e:self.respond({'error':e.message},e.status)
        except Exception as e:self.respond({'error':str(e)},400)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8787);args=parser.parse_args()
    STATE.mkdir(parents=True,exist_ok=True)
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    origin=f'http://localhost:{args.port}'
    server.origins={origin,f'http://127.0.0.1:{args.port}'}
    if os.getenv('CODESPACE_NAME'):
        domain=os.getenv('GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN','app.github.dev')
        origin=f'https://{os.environ["CODESPACE_NAME"]}-{args.port}.{domain}'
        server.origins.add(origin)
        try:
            subprocess.run(['gh','codespace','ports','visibility',f'{args.port}:private','-c',os.environ['CODESPACE_NAME']],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=20)
        except Exception:
            print('Ports 탭에서 8787의 Visibility가 Private인지 확인하세요.',flush=True)
    print('\nBlog Studio — 아래 주소를 본인 브라우저에서 열어주세요 (주소 공유 금지)\n'+origin+'/studio#key='+BOOT_KEY+'\n',flush=True)
    server.serve_forever()
if __name__=='__main__':main()
