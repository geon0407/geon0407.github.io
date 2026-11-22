"""Markdown -> portable static pages. Run with --drafts for a private preview."""
from pathlib import Path
from html import escape as e
from urllib.parse import quote
from datetime import date
import argparse, json, shutil, re
import markdown, yaml

ROOT = Path(__file__).resolve().parent
CATEGORIES = {'projects': '프로젝트', 'notes': '기술 노트', 'journal': '일기'}


def build(drafts=False):
    cfg = json.loads((ROOT/'site.json').read_text())
    base = cfg['base_path'].rstrip('/')
    if base and (not base.startswith('/') or '..' in base):
        raise ValueError('base_path must be empty or an absolute URL path')
    out = ROOT/'dist'
    if out.exists(): shutil.rmtree(out)
    out.mkdir()
    shutil.copytree(ROOT/'assets', out/'assets')
    url = lambda path: base + '/' + path.lstrip('/')
    shutil.copytree(ROOT/'admin', out/'admin')
    def md(text, toc=False):
        engine = markdown.Markdown(extensions=['fenced_code', 'tables', 'toc', 'codehilite'], extension_configs={'codehilite': {'guess_lang': False}})
        text = text.replace('{{base}}',base)
        # Protect inline TeX delimiters and underscores from Markdown processing.
        text = re.sub(r'\\\((.*?)\\\)', lambda m: engine.htmlStash.store('<span class="math">' + e(m.group(0)) + '</span>'), text)
        body = engine.convert(text)
        return (body, engine.toc) if toc else body
    entries=[]
    for category in CATEGORIES:
        for file in sorted((ROOT/'content'/category).glob('*.md')):
            if not re.fullmatch(r'[a-z0-9-]+', file.stem): raise ValueError(f'Use ASCII slugs: {file.name}')
            text=file.read_text()
            parts=re.split(r'(?m)^---[ \t]*\n', text, maxsplit=2)
            if len(parts)!=3 or parts[0].strip(): raise ValueError(f'Missing frontmatter: {file}')
            meta=yaml.safe_load(parts[1])
            if not isinstance(meta.get('title'),str): raise ValueError(f'Missing title: {file}')
            if type(meta.get('draft',False)) is not bool: raise ValueError('draft must be true or false')
            if meta.get('draft') and not drafts: continue
            if category!='projects': date.fromisoformat(str(meta['date']))
            tags=meta.get('tags',[])
            if not isinstance(tags,list) or not all(isinstance(t,str) for t in tags): raise ValueError('tags must be strings')
            entries.append(dict(meta,category=category,slug=file.stem,body=parts[2],path=f'{category}/{file.stem}/'))
    def rows(items):
        if not items: return '<p class="empty">아직 공개한 글이 없습니다.</p>'
        html=''
        for x in items:
            cover=x.get('cover','')
            image=f'<img class="cover" loading="lazy" src="{e(url(cover))}" alt="">' if cover else ''
            html+=f'<article class="entry" data-search="{e((x["title"]+" "+x.get("summary","")+" "+" ".join(x.get("tags",[]))).lower())}" data-tags="{e(json.dumps(x.get("tags",[]),ensure_ascii=False))}">{image}<div class="meta">{CATEGORIES[x["category"]]} · {e(str(x.get("date","")))} {"· 초안" if x.get("draft") else ""}</div><h2><a href="{e(url(x["path"]))}">{e(x["title"])}</a></h2><p>{e(x.get("summary",""))}</p><div class="tags">{e(" · ".join(x.get("tags",[])))}</div></article>'
        return html
    def page(path,title,body,section='',description=None,math=False):
        nav=''.join(f'<a href="{e(url(p))}" {"aria-current=page" if section==k else ""}>{v}</a>' for k,p,v in [('about','','소개')]+[(k,k+'/',v) for k,v in CATEGORIES.items()])
        photo=f'<img class="portrait" src="{e(url(cfg["photo"]))}" alt="{e(cfg["name"])}">' if cfg.get('photo') else ''
        email=f'<a href="mailto:{e(cfg["email"])}">이메일</a>' if cfg.get('email') else ''
        maths='''<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css"><script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script><script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js" onload="renderMathInElement(document.querySelector('main'),{delimiters:[{left:'$$',right:'$$',display:true},{left:'\\\\(',right:'\\\\)',display:false}],throwOnError:false})"></script>''' if math else ''
        canonical=cfg['url'].rstrip('/')+url(path)
        html=f'''<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{e(title)} | {e(cfg['name'])}</title><meta name="description" content="{e(description or cfg['description'])}"><link rel="canonical" href="{e(canonical)}"><meta property="og:title" content="{e(title)}"><meta property="og:description" content="{e(description or cfg['description'])}"><meta property="og:type" content="website"><script src="{url('assets/theme.js')}"></script><link rel="stylesheet" href="{url('assets/style.css')}"><script defer src="{url('assets/site.js')}"></script>{maths}</head><body><a class="skip" href="#main">본문으로 이동</a><div id="site"><header><a class="brand" href="{url('')}">{e(cfg['english_name'])}</a><nav aria-label="메뉴">{nav}</nav><div class="theme-switch" role="group" aria-label="화면 테마"><button data-theme="system">자동</button><button data-theme="light">라이트</button><button data-theme="dark">다크</button></div></header><div class="frame"><aside>{photo}<h2>{e(cfg['name'])}</h2><p>{e(cfg['affiliation'])}</p><a href="{e(cfg['github'])}">GitHub</a>{email}</aside><main id="main">{body}</main></div><footer><span>© {date.today().year} {e(cfg['name'])}</span><span id="theme-status" aria-live="polite"></span></footer></div></body></html>'''
        target=out/path/'index.html' if path else out/'index.html'
        target.parent.mkdir(parents=True,exist_ok=True);target.write_text(html)
    projects=sorted([x for x in entries if x['category']=='projects'],key=lambda x:x.get('order',100))
    posts=sorted([x for x in entries if x['category']!='projects'],key=lambda x:str(x['date']),reverse=True)
    about=(ROOT/'content/about.md').read_text()
    if about.startswith('---\n'):
        parts=re.split(r'(?m)^---[ \t]*\n', about, maxsplit=2)
        if len(parts)==3: about=parts[2]
    intro=f'<h1 class="name">{e(cfg["name"])}<span>{e(cfg["english_name"])}</span></h1>'+md(about)
    page('', '소개', intro+'<h2 class="section">프로젝트</h2>'+rows(projects[:2])+'<h2 class="section">최근 기록</h2>'+rows(posts[:4]),'about')
    for cat,label in CATEGORIES.items():
        items=projects if cat=='projects' else [x for x in posts if x['category']==cat]
        tags=sorted(set(t for x in items for t in x.get('tags',[])))
        options=''.join(f'<option>{e(t)}</option>' for t in tags)
        controls=f'<div class="filters"><label>검색<input type="search" id="search" placeholder="제목·요약·태그"></label><label>분류<select id="tag"><option value="">전체</option>{options}</select></label></div>' if items else ''
        page(cat+'/',label,f'<h1>{label}</h1>{controls}<div class="entries">{rows(items)}</div><p id="no-results" hidden aria-live="polite">검색 결과가 없습니다.</p>',cat)
    for x in entries:
        content,toc=md(x['body'],True)
        toc_html=f'<details class="toc" open><summary>목차</summary>{toc}</details>' if x['category']!='journal' and '<li>' in toc else ''
        cover=f'<img class="hero-photo" src="{e(url(x["cover"]))}" alt="">' if x.get('cover') else ''
        loc=f'<p class="meta">{e(x["location"])}</p>' if x.get('location') else ''
        body=f'<a class="back" href="{url(x["category"]+"/")}">{CATEGORIES[x["category"]]} 목록</a><div class="meta">{e(str(x.get("date","")))} {"· 검토용 초안" if x.get("draft") else ""}</div><h1>{e(x["title"])}</h1>{loc}{cover}{toc_html}<div class="prose">{content}</div>'
        page(x['path'],x['title'],body,x['category'],x.get('summary'),True)
    page('404','페이지를 찾을 수 없습니다',f'<h1>페이지를 찾을 수 없습니다.</h1><a href="{url("")}">처음으로</a>')
    shutil.move(out/'404/index.html',out/'404.html');(out/'404').rmdir()
    (out/'.nojekyll').touch()
    paths=['','projects/','notes/','journal/']+[x['path'] for x in entries]
    (out/'sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+''.join(f'<url><loc>{e(cfg["url"].rstrip("/")+url(p))}</loc></url>' for p in paths)+'</urlset>')
    print(f'Built {len(paths)} pages; drafts={drafts}')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--drafts',action='store_true');build(parser.parse_args().drafts)
