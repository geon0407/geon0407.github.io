// End-to-end smoke test of the built web Studio (site/studio/) in jsdom, against the fake GitHub.
// Run `npm run build:web` first; `npm run test:web` runs this together with the core tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {readFileSync, readdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {webcrypto} from 'node:crypto';
import {FakeRepo, fakeFetch} from './fake-github.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fixed test data (a copy of the site's _data plus sample posts), so editing the real blog never breaks tests.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
function siteFiles() {
  const files = {};
  for (const dir of ['site/_data', 'site/collections/_posts', 'site/collections/_projects']) {
    for (const name of readdirSync(join(FIXTURES, dir))) files[`${dir}/${name}`] = readFileSync(join(FIXTURES, dir, name), 'utf8');
  }
  return files;
}

function openStudio({site, data}) {
  const html = readFileSync(join(ROOT, 'site/studio/index.html'), 'utf8').replace('<script src="app.js"></script>', '');
  const dom = new JSDOM(html, {url: 'https://geon0407.github.io/studio/', runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', e => errors.push(e.message));
  w.console.error = (...a) => errors.push(a.join(' '));
  // Browser APIs jsdom lacks.
  Object.defineProperty(w, 'crypto', {value: webcrypto});
  Object.assign(w, {TextEncoder, TextDecoder, fetch: fakeFetch({'me/site': site, 'me/data': data}), confirm: () => true, prompt: () => null});
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.URL.createObjectURL = () => 'blob:fake';
  w.URL.revokeObjectURL = () => {};
  w.document.elementFromPoint = () => null;
  w.Range.prototype.getClientRects = () => [];
  w.Range.prototype.getBoundingClientRect = () => ({left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0});
  w.Element.prototype.scrollIntoView = () => {};
  if (!w.Blob.prototype.arrayBuffer) {  // jsdom's File/Blob lack arrayBuffer(); browsers have it
    w.Blob.prototype.arrayBuffer = function () {
      return new Promise((resolve, reject) => {
        const reader = new w.FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsArrayBuffer(this);
      });
    };
  }
  w.eval(readFileSync(join(ROOT, 'site/studio/app.js'), 'utf8'));
  const $ = s => w.document.querySelector(s);
  const idle = async () => {
    await sleep(30);
    for (let i = 0; i < 300 && w.document.body.classList.contains('busy'); i++) await sleep(20);
    await sleep(30);
  };
  const notice = () => ($('#notice').hidden ? '' : $('#notice').textContent);
  return {w, $, idle, notice, errors, close: () => w.close()};
}

test('web Studio: connect, write, publish, deploy status, every screen', async t => {
  const site = new FakeRepo({files: siteFiles()});
  const data = new FakeRepo({isPrivate: true});
  const {w, $, idle, notice, errors, close} = openStudio({site, data});
  t.after(close);
  await idle();
  assert.ok(!$('#login').hidden && !$('#connect-form').hidden, 'login screen');

  $('#token').value = 'github_pat_test';
  $('#site-repo').value = 'me/site';
  $('#data-repo').value = 'me/data';
  $('#remember').checked = true;
  $('#remember').dispatchEvent(new w.Event('change'));
  $('#vault-password').value = $('#vault-password2').value = 'correct horse';
  $('#connect-form').dispatchEvent(new w.Event('submit', {cancelable: true}));
  for (let i = 0; i < 100 && $('#app').hidden; i++) await sleep(30);
  await idle();
  assert.ok(!$('#app').hidden, 'app visible: ' + $('#login-error').textContent);
  // The vault is written after connecting (PBKDF2 takes a moment).
  for (let i = 0; i < 200 && !w.localStorage.getItem('blog-studio-web:vault'); i++) await sleep(20);
  const vault = w.localStorage.getItem('blog-studio-web:vault');
  assert.ok(vault && !vault.includes('github_pat_test'), 'token remembered only encrypted');
  assert.match($('#record-list').textContent, /Post Test/);

  $('#new-record').click();
  await idle();
  assert.ok($('#editor .ProseMirror'), 'editor opened');
  $('[data-meta="title"]').value = '웹에서 쓴 글';
  $('[data-meta="title"]').dispatchEvent(new w.Event('input'));
  $('#slug').value = 'web-post';
  w.prompt = () => 'https://youtu.be/dQw4w9WgXcQ?t=90';
  w.document.querySelector('[data-command="youtube"]').click();
  w.prompt = () => null;
  assert.ok($('#editor iframe[src*="youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90"]'), 'youtube shown in editor');
  $('#save-record').click();
  await idle();
  const draftText = Object.entries(data.files()).find(([p]) => p.startsWith('drafts/'))[1].toString();
  assert.match(JSON.parse(draftText).body, /<div class="video-embed youtube"><iframe class="reframe-off" src="https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?start=90"/);
  assert.equal(Object.keys(data.files()).filter(p => p.startsWith('drafts/')).length, 1, notice());

  $('#ready-record').click();
  await idle();
  assert.ok($('#preview-dialog').open && $('#site-preview').srcdoc.includes('웹에서 쓴 글'), 'preview: ' + notice());
  $('#close-preview').click();
  assert.match($('#pending').textContent, /1개/);

  $('#publish').click();
  await idle();
  assert.ok($('#publish-dialog').open && $('#publish-list').textContent.includes('웹에서 쓴 글'));
  $('#publish-confirm').click();
  await idle();
  assert.ok(Object.keys(site.files()).some(p => p.endsWith('-web-post.md')), 'published: ' + notice());
  for (let i = 0; i < 50 && $('#deploy').hidden; i++) await sleep(20);
  assert.match($('#deploy').className, /running/, 'deploy banner while waiting');

  site.actionsNeedNoToken = true;
  site.runs.push({id: 9, head_sha: site.ref, status: 'completed', conclusion: 'failure'});
  site.jobs[9] = [{name: 'build', conclusion: 'failure', steps: [{name: 'Run npm run build', conclusion: 'failure'}]}];
  $('#reload').click();
  await idle();
  for (let i = 0; i < 50 && !$('#deploy').className.includes('failure'); i++) await sleep(20);
  assert.match($('#deploy').className, /failure/);
  assert.match($('#deploy').textContent, /Run npm run build/);
  assert.match($('#deploy a').href, /\/run\/9$/);

  for (const v of ['home', 'profile', 'design', 'settings', 'files', 'trash', 'projects', 'posts']) {
    w.document.querySelector(`[data-view="${v}"]`).click();
    await idle();
    assert.ok($('#main').children.length && !$('#notice').classList.contains('error'), `view ${v}: ${notice()}`);
  }

  w.document.querySelector('[data-view="settings"]').click();
  await idle();
  $('[data-config="site.title"]').value = 'GeonHyoung Kim (web)';
  $('[data-config="site.title"]').dispatchEvent(new w.Event('input'));
  $('#save-settings').click();
  await idle();
  assert.match(notice(), /설정을 저장/);

  w.document.querySelector('[data-view="posts"]').click();
  await idle();
  [...w.document.querySelectorAll('[data-open]')].find(b => b.dataset.open.includes('web-post')).click();
  await idle();
  $('#delete-record').click();
  await idle();
  assert.ok(!$('#notice').classList.contains('error'), 'move to trash: ' + notice());
  assert.match(notice(), /휴지통으로 옮겼습니다/);
  w.document.querySelector('[data-view="trash"]').click();
  await idle();
  assert.match($('#main').textContent, /웹에서 쓴 글/);
  assert.deepEqual(errors, []);
});

test('clicking the menu while a slow delete runs does not break it', async t => {
  const site = new FakeRepo({files: siteFiles()});
  const data = new FakeRepo({isPrivate: true});
  const {w, $, idle, notice, close} = openStudio({site, data});
  t.after(close);
  await idle();
  $('#token').value = 'github_pat_test';
  $('#site-repo').value = 'me/site';
  $('#data-repo').value = 'me/data';
  $('#connect-form').dispatchEvent(new w.Event('submit', {cancelable: true}));
  for (let i = 0; i < 100 && $('#app').hidden; i++) await sleep(30);
  await idle();
  [...w.document.querySelectorAll('[data-open]')].find(b => b.dataset.open.includes('post-1')).click();
  await idle();
  data.delay = site.delay = 40;
  $('#delete-record').click();
  await sleep(20);
  w.document.querySelector('[data-view="trash"]').click();  // user clicks around while it runs
  assert.match(notice(), /진행 중인 작업/);
  await idle();
  assert.ok(!$('#notice').classList.contains('error'), notice());
  assert.match(notice(), /휴지통으로 옮겼습니다/);
});

test('project editor: period fields and ongoing checkbox are saved', async t => {
  const site = new FakeRepo({files: siteFiles()});
  const data = new FakeRepo({isPrivate: true});
  const {w, $, idle, notice, close} = openStudio({site, data});
  t.after(close);
  await idle();
  $('#token').value = 'github_pat_test';
  $('#site-repo').value = 'me/site';
  $('#data-repo').value = 'me/data';
  $('#connect-form').dispatchEvent(new w.Event('submit', {cancelable: true}));
  for (let i = 0; i < 100 && $('#app').hidden; i++) await sleep(30);
  await idle();
  w.document.querySelector('[data-view="projects"]').click();
  await idle();
  $('[data-open]').click();
  await idle();
  $('[data-meta="card_title"]').value = '짧은 카드 제목';
  $('[data-meta="card_subtitle"]').value = '카드 부제목';
  $('[data-meta="period_start"]').value = '2026-07';
  $('[data-meta="period_end"]').value = '2026-08';
  $('[data-meta="ongoing"]').checked = true;
  $('[data-meta="ongoing"]').dispatchEvent(new w.Event('change'));
  assert.ok($('[data-meta="period_end"]').disabled, 'end month disabled while ongoing');
  $('#save-record').click();
  await idle();
  assert.match(notice(), /저장했습니다/);
  w.document.querySelector('[data-view="projects"]').click();
  await idle();
  $('[data-open]').click();
  await idle();
  assert.equal($('[data-meta="period_start"]').value, '2026-07');
  assert.equal($('[data-meta="card_title"]').value, '짧은 카드 제목');
  assert.equal($('[data-meta="card_subtitle"]').value, '카드 부제목');
  assert.equal($('[data-meta="subtitle"]').value, 'Test');
  assert.equal($('[data-meta="period_end"]').value, '');
  assert.ok($('[data-meta="ongoing"]').checked);
});

test('CV: upload a PDF from the About settings, then publish it with the settings', async t => {
  const site = new FakeRepo({files: siteFiles()});
  const data = new FakeRepo({isPrivate: true});
  const {w, $, idle, notice, close} = openStudio({site, data});
  t.after(close);
  await idle();
  $('#token').value = 'github_pat_test';
  $('#site-repo').value = 'me/site';
  $('#data-repo').value = 'me/data';
  $('#connect-form').dispatchEvent(new w.Event('submit', {cancelable: true}));
  for (let i = 0; i < 100 && $('#app').hidden; i++) await sleep(30);
  await idle();
  w.document.querySelector('[data-view="profile"]').click();
  await idle();
  assert.equal($('[data-config="profile.contact.cv.path"]').value, '');
  $('[data-pdf-field="profile.contact.cv.path"]').click();
  const input = $('#upload');
  assert.match(input.accept, /pdf/);
  Object.defineProperty(input, 'files', {value: [new w.File(['%PDF-1.4 test'], 'cv.pdf', {type: 'application/pdf'})], configurable: true});
  input.dispatchEvent(new w.Event('change'));
  await idle();
  const path = $('[data-config="profile.contact.cv.path"]').value;
  assert.match(path, /^\/uploads\/\d{4}\/\d{2}\/[0-9a-f]{24}\.pdf$/, notice());
  assert.match($('[data-config="profile.contact.cv.updated"]').value, /^\d{4}-\d{2}-\d{2}$/);
  $('#save-settings').click();
  await idle();
  $('#publish').click();
  await idle();
  $('#publish-confirm').click();
  await idle();
  assert.match(site.text('site/_data/studio.yml'), new RegExp(`path: ${path.replace(/\//g, '\\/')}`));
  assert.equal(site.text('site' + path), '%PDF-1.4 test');
});

test('home news: add, edit and save from the Home screen', async t => {
  const site = new FakeRepo({files: siteFiles()});
  const data = new FakeRepo({isPrivate: true});
  const {w, $, idle, notice, close} = openStudio({site, data});
  t.after(close);
  await idle();
  $('#token').value = 'github_pat_test';
  $('#site-repo').value = 'me/site';
  $('#data-repo').value = 'me/data';
  $('#connect-form').dispatchEvent(new w.Event('submit', {cancelable: true}));
  for (let i = 0; i < 100 && $('#app').hidden; i++) await sleep(30);
  await idle();
  w.document.querySelector('[data-view="home"]').click();
  await idle();
  const before = w.document.querySelectorAll('[data-news-remove]').length;
  $('#add-news').click();
  assert.equal(w.document.querySelectorAll('[data-news-remove]').length, before + 1);
  const set = (path, value) => { const el = $(`[data-config="${path}"]`); el.value = value; el.dispatchEvent(new w.Event('input')); };
  set('home.news.0.emoji', '🎉');
  set('home.news.0.text', 'Paper [accepted](https://example.com).');
  set('home.news.0.text_ko', '논문이 [채택](https://example.com)됐습니다.');
  $('#save-settings').click();
  await idle();
  assert.match(notice(), /설정을 저장/);
  $('#publish').click();
  await idle();
  $('#publish-confirm').click();
  await idle();
  const yml = site.text('site/_data/studio.yml');
  assert.match(yml, /text: Paper \[accepted\]\(https:\/\/example\.com\)\./);
  assert.match(yml, /emoji: 🎉/);
});

test('history: one panel per category; adding in a panel sets that category', async t => {
  const site = new FakeRepo({files: siteFiles()});
  const data = new FakeRepo({isPrivate: true});
  const {w, $, idle, notice, close} = openStudio({site, data});
  t.after(close);
  await idle();
  $('#token').value = 'github_pat_test';
  $('#site-repo').value = 'me/site';
  $('#data-repo').value = 'me/data';
  $('#connect-form').dispatchEvent(new w.Event('submit', {cancelable: true}));
  for (let i = 0; i < 100 && $('#app').hidden; i++) await sleep(30);
  await idle();
  w.document.querySelector('[data-view="profile"]').click();
  await idle();
  const titles = [...w.document.querySelectorAll('.panel h2')].map(h => h.textContent.replace(/\s+/g, ' ').trim()).filter(t => t.startsWith('연혁'));
  assert.deepEqual(titles.map(t => t.replace(/ \d+$/, '')), ['연혁 · 학력', '연혁 · 연구', '연혁 · 수상', '연혁 · 경력']);
  assert.equal(w.document.querySelectorAll('[data-config$=".group"]').length, 0, 'no group picker any more');
  $('[data-add-timeline="award"]').click();
  await idle();
  const awardPanel = [...w.document.querySelectorAll('.panel')].find(p => p.querySelector('h2').textContent.includes('수상'));
  const first = awardPanel.querySelector('[data-config$=".title"]');
  first.value = 'Test Award';
  first.dispatchEvent(new w.Event('input'));
  const ko = awardPanel.querySelector('[data-config$=".title_ko"]');
  ko.value = '테스트 수상';
  ko.dispatchEvent(new w.Event('input'));
  $('#save-settings').click();
  await idle();
  assert.match(notice(), /설정을 저장/);
  $('#publish').click();
  await idle();
  $('#publish-confirm').click();
  await idle();
  const yml = site.text('site/_data/studio.yml');
  assert.match(yml, /group: award\n\s+title: Test Award|title: Test Award[\s\S]*?group: award|group: award[\s\S]{0,200}title: Test Award/);
});
