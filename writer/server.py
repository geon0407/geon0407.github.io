import hashlib
import json
import re
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock

import bleach
import markdown
import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
LOCK = Lock()
NAME = re.compile(r'content/(notes|journal)/[a-z0-9-]+\.md')
TAGS = 'p h1 h2 h3 h4 h5 h6 pre code br strong em ul ol li a img blockquote hr table thead tbody tr th td'.split()

def version(data):
    return hashlib.sha256(data).hexdigest()

def read(path):
    data = path.read_bytes()
    parts = re.split(r'(?m)^---[ \t]*\r?\n', data.decode('utf-8'), maxsplit=2)
    if len(parts) != 3 or parts[0]:
        raise ValueError('글의 메타데이터 구분선을 확인하세요.')
    meta = yaml.safe_load(parts[1])
    if not isinstance(meta, dict):
        raise ValueError('글의 메타데이터를 확인하세요.')
    return data, parts[1], meta, parts[2]

def target(name):
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise ValueError('기술 노트 또는 일기의 올바른 파일 경로가 필요합니다.')
    path = ROOT / name
    if path.resolve() != path:
        raise ValueError('심볼릭 링크는 편집할 수 없습니다.')
    return path

class Handler(BaseHTTPRequestHandler):
    def reply(self, status, value, mime='application/json; charset=utf-8'):
        data = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/':
            return self.reply(200, (HERE/'index.html').read_bytes(), 'text/html; charset=utf-8')
        if self.path == '/api/posts':
            names = [p.relative_to(ROOT).as_posix() for section in ('notes', 'journal')
                     for p in (ROOT/'content'/section).glob('*.md') if NAME.fullmatch(p.relative_to(ROOT).as_posix()) and not p.is_symlink()]
            return self.reply(200, sorted(names))
        self.reply(404, {'error':'찾을 수 없습니다.'})

    def do_POST(self):
        if self.headers.get('X-Blog-Editor') != '1' or self.headers.get_content_type() != 'application/json':
            return self.reply(403, {'error':'편집기에서 다시 시도하세요.'})
        try:
            size = int(self.headers.get('Content-Length', 0))
            if not 0 < size <= 1500000:
                raise ValueError('요청이 비었거나 너무 큽니다.')
            req = json.loads(self.rfile.read(size))
            path = target(req['path'])
            if self.path == '/api/open':
                data, _, meta, body = read(path)
                rendered = markdown.markdown(body, extensions=['fenced_code','tables'])
                html = bleach.clean(rendered, tags=TAGS, attributes={'a':['href'], 'img':['src','alt'], 'code':['class'], 'ol':['start']}, strip=True)
                return self.reply(200, {'meta': meta | {'date': str(meta.get('date',''))}, 'html':html,'version':version(data)})
            if self.path != '/api/save':
                return self.reply(404, {'error':'찾을 수 없습니다.'})
            fields = req['meta']
            date.fromisoformat(fields['date'])
            if not fields['title'].strip() or not isinstance(fields['tags'],list) or not all(isinstance(t,str) for t in fields['tags']):
                raise ValueError('제목과 태그를 확인하세요.')
            with LOCK:
                old = req.get('version')
                if path.exists():
                    data, _, meta, original_body = read(path)
                    if old != version(data):
                        return self.reply(409, {'error':'이미 있는 파일이거나 다른 곳에서 수정됐습니다. 다시 열거나 다른 파일명을 사용하세요.'})
                elif old:
                    return self.reply(409, {'error':'파일이 이동되거나 삭제됐습니다.'})
                else:
                    meta = {'draft':False}
                    original_body = ''
                for key in ('title','date','summary','tags'):
                    meta[key] = fields[key]
                body = req['body']
                body = original_body if body is None else '\n'+body.strip()+'\n'
                rendered = ('---\n'+yaml.safe_dump(meta, allow_unicode=True, sort_keys=False)+'---\n'+body).encode()
                path.parent.mkdir(parents=True,exist_ok=True)
                tmp = path.with_suffix('.tmp')
                tmp.write_bytes(rendered)
                tmp.replace(path)
            self.reply(200, {'version':version(rendered)})
        except (ValueError, TypeError, KeyError, FileNotFoundError, yaml.YAMLError) as exc:
            self.reply(400, {'error':str(exc)})

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 8787), Handler).serve_forever()
