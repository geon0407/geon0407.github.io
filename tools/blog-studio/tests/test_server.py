import importlib.util
import json
import threading
import time
import urllib.error
import urllib.request
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('studio',Path(__file__).parents[1]/'server.py')
studio=importlib.util.module_from_spec(spec);spec.loader.exec_module(studio)
SOURCE=studio.ROOT

class StudioTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();studio.ROOT=Path(self.temp.name)/'repo';studio.ROOT.mkdir();studio.STATE=Path(self.temp.name)/'private'
        shutil.copytree(SOURCE/'site/_data',studio.ROOT/'site/_data')
    def tearDown(self):self.temp.cleanup()
    def post(self,**kwargs):
        data={'kind':'post','id':'','version':'','draft':True,'slug':'first-post','meta':{'title':'한글 테스트','date':'2026-01-01','tags':['C++'],'categories':['algorithms'],'image':'','description':'요약','subtitle':'','lang':'ko'},'body':'## 표\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```cpp\n{{ literal }}\n```'}
        data.update(kwargs);return data
    def test_draft_is_not_under_site_and_publishing_preserves_body(self):
        saved=studio.save_record(self.post());self.assertTrue(saved['id'].startswith('draft-'));self.assertEqual(studio.pending(),[])
        data={**saved,'slug':'first-post','draft':False};published=studio.save_record(data)
        path=studio.record_path(published['id']);meta,body=studio.split_doc(path.read_text())
        self.assertFalse(meta['render_with_liquid']);self.assertEqual(body.strip(),data['body'].strip());self.assertFalse(studio.record_path(saved['id']).exists())
        with self.assertRaises(studio.Problem):studio.save_record(data)
    def test_existing_post_conflict_and_archive(self):
        saved=studio.save_record(self.post(draft=False));path=studio.record_path(saved['id']);path.write_text(path.read_text()+'\nexternal')
        with self.assertRaises(studio.Problem) as error:studio.save_record(saved)
        self.assertEqual(error.exception.status,409)
        saved=studio.record(saved['id']);studio.archive_record(saved);self.assertFalse(path.exists());self.assertEqual(len(list((studio.STATE/'trash').iterdir())),1)
    def test_path_and_upload_restrictions(self):
        for value in ['../../etc/passwd','site/collections/_posts/../../a.md','site/js/evil.md']:
            with self.assertRaises(studio.Problem):studio.record_path(value)
        for value in ['x.html','x.svg','x.js']:
            with self.assertRaises(studio.Problem):studio.upload({'name':value,'data':'aGVsbG8='})
        file=studio.upload({'name':'report.pdf','data':'JVBERi0xLjQ='});self.assertTrue(file['url'].startswith('/uploads/'))
    def test_project_period(self):
        project=lambda **meta:{'kind':'project','id':'','version':'','draft':False,'slug':'robot','body':'x',
            'meta':{'title':'탁구 로봇','date':'2026-08-24','tags':[],'categories':[],'image':'','description':'','subtitle':'부제','lang':'ko',**meta}}
        saved=studio.save_record(project(period_start='2026-07',period_end='2026-08',ongoing=False))
        self.assertEqual({k:saved['meta'][k] for k in ('period_start','period_end','ongoing')},{'period_start':'2026-07','period_end':'2026-08','ongoing':False})
        saved=studio.save_record({**saved,'meta':{**saved['meta'],'ongoing':True}})
        self.assertEqual((saved['meta']['period_end'],saved['meta']['ongoing']),('',True))  # ongoing drops the end month
        for bad in [{'period_start':'2026-13'},{'period_start':'2026/07'},{'period_start':'2026-08','period_end':'2026-07'}]:
            with self.assertRaises(studio.Problem):studio.save_record(project(**bad))
        saved=studio.save_record({**saved,'meta':{**saved['meta'],'card_title':' 탁구 로봇 ','card_subtitle':'카드 부제목'}})
        self.assertEqual((saved['meta']['card_title'],saved['meta']['card_subtitle'],saved['meta']['subtitle']),('탁구 로봇','카드 부제목','부제'))
        post=studio.save_record(self.post(draft=False))
        self.assertNotIn('period_start',post['meta'])
        self.assertNotIn('card_title',post['meta']);self.assertNotIn('card_subtitle',post['meta'])  # posts do not get project fields
    def test_video_uploads(self):
        mp4=studio.upload({'name':'clip.MP4','data':'AAAAGGZ0eXBtcDQy'});self.assertTrue(mp4['url'].endswith('.mp4'))
        big=__import__('base64').b64encode(b'0'*(21*1024*1024)).decode()
        self.assertTrue(studio.upload({'name':'clip.webm','data':big})['url'].endswith('.webm'))  # videos may exceed 20MB
        with self.assertRaises(studio.Problem):studio.upload({'name':'photo.png','data':big})
        with self.assertRaises(studio.Problem):studio.upload({'name':'clip.mov','data':'AAAA'})
        with patch.object(studio,'VIDEO_LIMIT',10):
            with self.assertRaises(studio.Problem):studio.upload({'name':'clip.mp4','data':'AAAAGGZ0eXBtcDQy'})
    def test_config_validation_and_identity_sync(self):
        config=studio.yaml.safe_load(studio.safe_path(studio.CONFIG).read_text());config['site']['title']='New name';config['site']['github']='https://github.com/example'
        studio.save_config({'config':config,'version':studio.version(studio.safe_path(studio.CONFIG))})
        self.assertEqual(studio.yaml.safe_load(studio.safe_path('site/_data/general_settings.yml').read_text())['title'],'New name')
        social={s['icon']:s['link'] for s in studio.yaml.safe_load(studio.safe_path('site/_data/social_links.yml').read_text())['social']}
        self.assertEqual(social['github'],'https://github.com/example')
        self.assertEqual(social['linkedin'],'https://www.linkedin.com/in/geonhyoung-kim-63b521438/')
        bad=studio.yaml.safe_load(studio.safe_path(studio.CONFIG).read_text());bad['profile']['contact']['email']='not an email'
        with self.assertRaises(studio.Problem):studio.validate_config(bad)
        bad['profile']['contact']['email']='';studio.validate_config(bad)  # empty hides the contact
        config['design']['colors']['dark']['ink']='red; } body {'
        with self.assertRaises(studio.Problem):studio.validate_config(config)
    def test_publish_only_owned_changes_and_push(self):
        remote=Path(self.temp.name)/'remote.git'
        subprocess.run(['git','init','--bare',str(remote)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        for args in [['init','-b','main'],['config','user.name','Test'],['config','user.email','test@example.invalid'],['add','.'],['commit','-m','initial'],['remote','add','origin',str(remote)],['push','-u','origin','main']]:studio.command(['git',*args])
        studio.save_record(self.post(draft=False));(studio.ROOT/'unrelated.txt').write_text('do not publish')
        with patch.object(studio,'build',return_value={'ok':True}):studio.publish()
        self.assertEqual(studio.pending(),[])
        self.assertNotIn('unrelated.txt',studio.command(['git','ls-tree','-r','--name-only','HEAD']))
        self.assertEqual(studio.command(['git','rev-parse','HEAD']),studio.command(['git','rev-parse','origin/main']))
        studio.command(['git','add','unrelated.txt'])
        with self.assertRaises(studio.Problem):studio.publish()

    def git_repo(self):
        remote=Path(self.temp.name)/'remote.git'
        subprocess.run(['git','init','--bare',str(remote)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        for args in [['init','-b','main'],['config','user.name','Test'],['config','user.email','test@example.invalid'],['add','.'],['commit','-m','initial'],['remote','add','origin',str(remote)],['push','-u','origin','main']]:studio.command(['git',*args])
    def test_categories_come_from_site_data(self):
        slugs=[c['slug'] for c in studio.categories()]
        self.assertIn('algorithms',slugs)
        with self.assertRaises(studio.Problem):studio.save_record(self.post(meta={**self.post()['meta'],'categories':['nope']}))
    def test_trash_restore_and_purge(self):
        public=studio.save_record(self.post(draft=False));draft=studio.save_record(self.post(slug='second'))
        studio.archive_record(public);studio.archive_record(draft)
        self.assertFalse(studio.record_path(public['id']).exists());self.assertIn(public['id'],studio.pending())
        items=studio.list_trash();self.assertEqual(len(items),2)
        for item in items:
            result=studio.restore_trash({'id':item['id']})
            self.assertEqual(result['public'],not item['draft'])
        self.assertTrue(studio.record_path(public['id']).exists());self.assertTrue(studio.record_path(draft['id']).exists())
        self.assertEqual(studio.list_trash(),[])
        studio.archive_record(studio.record(draft['id']));studio.save_record(self.post(slug='third'))
        studio.purge_trash({'id':'all'});self.assertEqual(studio.list_trash(),[])
        with self.assertRaises(studio.Problem):studio.restore_trash({'id':'../../etc'})
    def test_restore_refuses_to_overwrite(self):
        public=studio.save_record(self.post(draft=False));studio.archive_record(public)
        studio.save_record(self.post(draft=False))
        with self.assertRaises(studio.Problem) as error:studio.restore_trash({'id':studio.list_trash()[0]['id']})
        self.assertEqual(error.exception.status,409)
    def test_legacy_trash_is_migrated(self):
        (studio.STATE/'trash').mkdir(parents=True)
        (studio.STATE/'trash'/'20261123-053807-project-1.md').write_text('---\ntitle: Old\nlayout: project\n---\n\nbody\n')
        [item]=studio.list_trash();self.assertEqual((item['title'],item['type']),('Old','project'))
        self.assertEqual(item['targets'],[{'where':'repo','path':'site/collections/_projects/project-1.md'}])
        studio.restore_trash({'id':item['id']});self.assertTrue((studio.ROOT/'site/collections/_projects/project-1.md').exists())
    def test_unused_uploads_can_be_trashed_but_used_cannot(self):
        used=studio.upload({'name':'a.png','data':'aGVsbG8='});unused=studio.upload({'name':'b.png','data':'aGVsbG8='})
        studio.save_record(self.post(body=f'![a]({used["url"]})'))
        files={f['path']:f for f in studio.list_uploads()}
        used_path,unused_path=used['url'].removeprefix('/uploads/'),unused['url'].removeprefix('/uploads/')
        self.assertTrue(files[used_path]['used']);self.assertFalse(files[unused_path]['used'])
        with self.assertRaises(studio.Problem):studio.delete_upload({'path':used_path})
        studio.delete_upload({'path':unused_path});self.assertNotIn(unused_path,{f['path'] for f in studio.list_uploads()})
        studio.restore_trash({'id':studio.list_trash()[0]['id']});self.assertIn(unused_path,{f['path'] for f in studio.list_uploads()})
    def test_changes_and_commit_message(self):
        self.git_repo()
        saved=studio.save_record(self.post(draft=False))
        image=studio.upload({'name':'c.png','data':'aGVsbG8='})
        studio.save_record({**saved,'body':f'![c]({image["url"]})'})
        items=studio.changes()
        self.assertEqual([(i['label'],i['status']) for i in items],[('게시글','added'),('첨부파일','added')])
        message=studio.commit_message(items)
        self.assertTrue(message.startswith('content(studio): add post "한글 테스트"; 1 attachment'))
        with patch.object(studio,'build',return_value={'ok':True}):studio.publish()
        self.assertIn('add post',studio.command(['git','log','-1','--format=%s']))
        studio.archive_record(studio.record(saved['id']))
        self.assertEqual([(i['label'],i['status'],i['title']) for i in studio.changes()],[('게시글','deleted','한글 테스트')])

class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();studio.ROOT=Path(self.temp.name)/'repo';studio.STATE=Path(self.temp.name)/'private'
        shutil.copytree(SOURCE/'site/_data',studio.ROOT/'site/_data');(studio.ROOT/'secret.html').write_text('<script>x</script>')
        self.server=studio.ThreadingHTTPServer(('127.0.0.1',0),studio.Handler);self.base=f'http://127.0.0.1:{self.server.server_port}'
        self.server.origins={self.base};threading.Thread(target=self.server.serve_forever,daemon=True).start()
    def tearDown(self):self.server.shutdown();self.server.server_close();studio.SESSIONS.clear();self.temp.cleanup()
    def call(self,path,data=None,cookie='',csrf=''):
        headers={'Origin':self.base,'Cookie':cookie,'X-Studio-CSRF':csrf}
        if data is not None:headers['Content-Type']='application/json'
        request=urllib.request.Request(self.base+path,data=None if data is None else json.dumps(data).encode(),headers=headers)
        try:
            with urllib.request.urlopen(request) as r:return r.status,r.headers,r.read()
        except urllib.error.HTTPError as e:return e.code,e.headers,e.read()
    def login(self):
        status,headers,_=self.call('/api/session',{'key':studio.BOOT_KEY});self.assertEqual(status,200)
        return headers['Set-Cookie'].split(';')[0]
    def test_upload_route_cannot_escape_upload_folders(self):
        cookie=self.login()
        for path in ['/uploads/%2e%2e/%2e%2e/secret.html','/uploads/../../secret.html','/uploads/2026/11/x.html']:
            self.assertIn(self.call(path,cookie=cookie)[0],(403,404))
        file=studio.upload({'name':'ok.png','data':'aGVsbG8='})
        status,_,body=self.call(file['url'],cookie=cookie);self.assertEqual((status,body),(200,b'hello'))
    def test_session_idle_expiry_and_logout(self):
        cookie=self.login();self.assertEqual(self.call('/api/state',cookie=cookie)[0],200)
        token=cookie.split('=',1)[1];csrf=studio.SESSIONS[token]['csrf']
        studio.SESSIONS[token]['seen']=time.time()-studio.SESSION_IDLE_SECONDS-1
        self.assertEqual(self.call('/api/state',cookie=cookie)[0],401)
        cookie=self.login();token=cookie.split('=',1)[1]
        self.assertEqual(self.call('/api/logout',{},cookie=cookie,csrf=studio.SESSIONS[token]['csrf'])[0],200)
        self.assertEqual(self.call('/api/state',cookie=cookie)[0],401)

if __name__=='__main__':unittest.main()
