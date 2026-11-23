import importlib.util
import json
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
    def test_config_validation_and_identity_sync(self):
        config=studio.yaml.safe_load(studio.safe_path(studio.CONFIG).read_text());config['site']['title']='New name';config['site']['github']='https://github.com/example'
        studio.save_config({'config':config,'version':studio.version(studio.safe_path(studio.CONFIG))})
        self.assertEqual(studio.yaml.safe_load(studio.safe_path('site/_data/general_settings.yml').read_text())['title'],'New name')
        self.assertEqual(studio.yaml.safe_load(studio.safe_path('site/_data/social_links.yml').read_text())['social'][0]['link'],'https://github.com/example')
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

if __name__=='__main__':unittest.main()
