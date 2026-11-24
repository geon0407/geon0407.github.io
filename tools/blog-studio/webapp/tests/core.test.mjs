// Tests for the browser Studio data layer against an in-memory fake of the GitHub Git API.
// Run: node --test tools/blog-studio/webapp/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {FakeRepo, fakeFetch} from './fake-github.mjs';
import {readFileSync, readdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const {GitHub, Studio, Problem, splitDoc, b64ToText, textToB64} = await import('../src/core.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

// Fixed test data (a copy of the site's _data plus sample posts), so editing the real blog never breaks tests.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
function siteFiles() {
  const files = {};
  for (const dir of ['site/_data', 'site/collections/_posts', 'site/collections/_projects']) {
    for (const name of readdirSync(join(FIXTURES, dir))) files[`${dir}/${name}`] = readFileSync(join(FIXTURES, dir, name), 'utf8');
  }
  return files;
}

async function setup({dataPrivate = true} = {}) {
  const site = new FakeRepo({files: siteFiles()});
  const data = new FakeRepo({isPrivate: dataPrivate});
  const fetch = fakeFetch({'me/site': site, 'me/data': data});
  const make = () => new Studio({site: new GitHub({token: 't', repo: 'me/site', fetch}), data: new GitHub({token: 't', repo: 'me/data', fetch})});
  const studio = make();
  await studio.connect();
  return {studio, site, data, make};
}

const draftPost = (extra = {}) => ({
  kind: 'post', id: '', version: '', draft: true, slug: 'first-post',
  meta: {title: '한글 테스트', date: '2026-01-01', tags: ['C++'], categories: ['algorithms'], image: '', description: '요약', subtitle: '', lang: 'ko'},
  body: '## 표\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```cpp\n{{ literal }}\n```', ...extra,
});

test('connect initializes the private data repo and refuses a public one', async () => {
  const {data} = await setup();
  assert.ok(data.text('README.md').includes('Blog Studio'));
  await assert.rejects(setup({dataPrivate: false}), /비공개/);
});

test('draft stays private; publishing writes the post and clears pending', async () => {
  const {studio, site, data} = await setup();
  const saved = await studio.saveRecord(draftPost());
  assert.match(saved.id, /^draft-/);
  assert.ok(data.text(`drafts/${saved.id}.json`));
  assert.deepEqual(await studio.changes(), []);
  const ready = await studio.saveRecord({...saved, draft: false});
  assert.equal(ready.id, 'site/collections/_posts/2026-01-01-first-post.md');
  assert.equal(data.text(`drafts/${saved.id}.json`), undefined);
  assert.deepEqual((await studio.changes()).map(i => [i.label, i.status, i.title]), [['게시글', 'added', '한글 테스트']]);
  const result = await studio.publish();
  assert.match(result.message, /발행/);
  const [meta, body] = splitDoc(site.text(ready.id));
  assert.equal(meta.render_with_liquid, false);
  assert.equal(meta.date, '2026-01-01');
  assert.equal(meta.studio_number, 2);  // the existing "Post Test" owns #1
  assert.equal(body.trim(), draftPost().body.trim());
  assert.deepEqual(JSON.parse(data.text('pending.json')).writes, {});
  await assert.rejects(studio.saveRecord({...draftPost(), draft: false}), /같은 주소/);
});

test('editing an existing post keeps its fields; no-op edits leave nothing pending', async () => {
  const {studio} = await setup();
  const post = (await studio.listRecords()).find(r => r.meta.title === 'Post Test');
  const same = await studio.saveRecord({...post, slug: ''});
  assert.deepEqual(await studio.changes(), []);
  await studio.saveRecord({...same, body: same.body + '\n추가\n'});
  const [item] = await studio.changes();
  assert.deepEqual([item.status, item.title], ['modified', 'Post Test']);
  assert.equal((await studio.record(post.id)).meta.studio_number, 1);
});

test('stale versions are rejected', async () => {
  const {studio} = await setup();
  const post = (await studio.listRecords()).find(r => r.meta.title === 'Post Test');
  await studio.saveRecord({...post, body: 'one'});
  await assert.rejects(studio.saveRecord({...post, body: 'two'}), e => e.status === 409);
});

test('making a post private and public again restores the same address', async () => {
  const {studio} = await setup();
  const post = (await studio.listRecords()).find(r => r.meta.title === 'Post Test');
  const hidden = await studio.saveRecord({...post, draft: true});
  assert.equal(hidden.source_id, post.id);
  assert.deepEqual((await studio.changes()).map(i => i.status), ['deleted']);
  const back = await studio.saveRecord({...hidden, draft: false});
  assert.equal(back.id, post.id);
  assert.deepEqual(await studio.changes(), []);
});

test('trash: archive, restore, conflict and purge', async () => {
  const {studio} = await setup();
  const post = (await studio.listRecords()).find(r => r.meta.title === 'Post Test');
  await studio.archiveRecord(post);
  assert.deepEqual((await studio.changes()).map(i => i.status), ['deleted']);
  const [entry] = await studio.listTrash();
  assert.equal(entry.title, 'Post Test');
  assert.equal(entry.draft, false);
  await studio.restoreTrash({id: entry.id});
  assert.deepEqual(await studio.changes(), []);
  const draft = await studio.saveRecord(draftPost());
  await studio.archiveRecord(draft);
  await studio.saveRecord({...draftPost(), id: ''});  // a new draft, different id: restore still fine
  const [d] = await studio.listTrash();
  assert.equal((await studio.restoreTrash({id: d.id})).public, false);
  await studio.archiveRecord(await studio.record(draft.id));
  await studio.purgeTrash({id: 'all'});
  assert.deepEqual(await studio.listTrash(), []);
  await assert.rejects(studio.restoreTrash({id: '../x'}), Problem);
});

test('uploads: published with the post, unused ones can be trashed and restored', async () => {
  const {studio, site} = await setup();
  const used = await studio.upload({name: 'a.png', data: textToB64('hello')});
  const unused = await studio.upload({name: 'b.png', data: textToB64('bye')});
  await assert.rejects(studio.upload({name: 'x.html', data: textToB64('<script>')}), /지원 파일/);
  const saved = await studio.saveRecord({...draftPost(), draft: false, body: `![a](${used.url})`});
  const usedRel = used.url.slice(9), unusedRel = unused.url.slice(9);
  const files = Object.fromEntries((await studio.listUploads()).map(f => [f.path, f]));
  assert.equal(files[usedRel].used, true);
  assert.equal(files[unusedRel].used, false);
  assert.deepEqual((await studio.changes()).map(i => i.label), ['게시글', '첨부파일']);
  await studio.publish();
  assert.equal(site.text('site/uploads/' + usedRel), 'hello');
  assert.equal(site.text('site/uploads/' + unusedRel), undefined);
  await assert.rejects(studio.deleteUpload({path: usedRel}), /사용 중/);
  await studio.deleteUpload({path: unusedRel});
  assert.ok(!(await studio.listUploads()).some(f => f.path === unusedRel));
  const [entry] = await studio.listTrash();
  await studio.restoreTrash({id: entry.id});
  assert.ok((await studio.listUploads()).some(f => f.path === unusedRel));
  assert.ok(saved.id);
});

test('deleting a published unused upload removes it from the site on publish, and restore brings it back', async () => {
  const {studio, site} = await setup();
  const file = await studio.upload({name: 'c.png', data: textToB64('img')});
  const rel = file.url.slice(9);
  const post = await studio.saveRecord({...draftPost(), draft: false, body: `![c](${file.url})`});
  await studio.publish();
  await studio.saveRecord({...(await studio.record(post.id)), body: 'no image'});
  await studio.publish();
  await studio.deleteUpload({path: rel});
  assert.deepEqual((await studio.changes()).map(i => [i.label, i.status]), [['첨부파일', 'deleted']]);
  await studio.publish();
  assert.equal(site.text('site/uploads/' + rel), undefined);
  const [entry] = await studio.listTrash();
  assert.equal((await studio.restoreTrash({id: entry.id})).public, true);
  await studio.publish();
  assert.equal(site.text('site/uploads/' + rel), 'img');
});

test('publish refuses when the same file changed elsewhere, but rebases over unrelated changes', async () => {
  const {studio, site} = await setup();
  const post = (await studio.listRecords()).find(r => r.meta.title === 'Post Test');
  await studio.saveRecord({...post, body: 'web edit'});
  site.push({'README.md': 'changed elsewhere'});
  await studio.publish();
  assert.match(site.text(post.id), /web edit/);
  assert.equal(site.text('README.md'), 'changed elsewhere');
  const again = await studio.record(post.id);
  await studio.saveRecord({...again, body: 'second web edit'});
  site.push({[post.id]: site.text(post.id) + '\ncodespace edit'});
  await assert.rejects(studio.publish(), e => e.status === 409 && e.message.includes(post.id));
  await studio.discard({path: post.id});
  assert.deepEqual(await studio.changes(), []);
});

test('a stale pending change is caught even after reloading (no silent overwrite)', async () => {
  const {studio, site} = await setup();
  const {config, version} = await studio.config();
  config.site.title = 'Edited in an old tab';
  await studio.saveConfig({config, version});
  // Someone changes the same file elsewhere; this tab then reloads (the "새로고침" button).
  site.push({'site/_data/studio.yml': site.text('site/_data/studio.yml') + '# changed elsewhere\n'});
  await studio.reload();
  assert.deepEqual(studio.stalePaths(), ['site/_data/studio.yml']);
  await assert.rejects(studio.publish(), e => e.status === 409 && e.message.includes('studio.yml'));
  const again = await studio.config();
  await assert.rejects(studio.saveConfig(again), e => e.status === 409);
  assert.match(site.text('site/_data/studio.yml'), /# changed elsewhere/);
  await studio.discard({path: 'site/_data/studio.yml'});
  assert.deepEqual(studio.stalePaths(), []);
  const fresh = await studio.config();
  fresh.config.site.title = 'Edited on top of the latest';
  await studio.saveConfig(fresh);
  await studio.publish();
  assert.match(site.text('site/_data/studio.yml'), /Edited on top of the latest/);
});

test('two studio sessions writing the data repo: the stale one gets a 409', async () => {
  const {studio, make} = await setup();
  const other = make();
  await other.connect();
  await studio.saveRecord(draftPost());
  await assert.rejects(other.saveRecord(draftPost({slug: 'x'})), e => e.status === 409);
  await other.reload();
  await other.saveRecord(draftPost({slug: 'x'}));
});

test('settings: validated, and synced into the other data files', async () => {
  const {studio, site} = await setup();
  const {config, version} = await studio.config();
  config.site.title = 'New name';
  config.site.github = 'https://github.com/example';
  await studio.saveConfig({config, version});
  const labels = (await studio.changes()).map(i => i.title).sort();
  // author.yml is unchanged (same author/avatar), so only these three are pending.
  assert.deepEqual(labels, ['general_settings.yml', 'social_links.yml', 'studio.yml']);
  const bad = (await studio.config());
  const badEmail = await studio.config();
  badEmail.config.profile.contact.email = 'not an email';
  await assert.rejects(studio.saveConfig(badEmail), /이메일/);
  bad.config.design.colors.dark.ink = 'red; } body {';
  await assert.rejects(studio.saveConfig(bad), /색상/);
  await studio.publish();
  assert.match(site.text('site/_data/general_settings.yml'), /title: New name/);
  assert.match(site.text('site/_data/studio.yml'), /period: '2026\.08'/);  // stays a string, not a number
});

test('categories come from the site data file', async () => {
  const {studio} = await setup();
  assert.deepEqual((await studio.categories()).map(c => c.slug), ['diary', 'thoughts', 'paper-reviews', 'algorithms']);
  await assert.rejects(studio.saveRecord(draftPost({meta: {...draftPost().meta, categories: ['nope']}})), /카테고리/);
});

test('deploy status after publishing: waiting, running, failure with the failed step, success', async () => {
  const {studio, site, make} = await setup();
  assert.equal(await studio.deployStatus(), null);
  const post = (await studio.listRecords()).find(r => r.meta.title === 'Post Test');
  await studio.saveRecord({...post, body: 'deploy me'});
  await studio.publish();
  const sha = site.ref;
  assert.equal((await studio.deployStatus()).state, 'running');  // no run yet: queued
  site.actionsNeedNoToken = true;  // token lacks Actions permission: anonymous fallback
  site.runs.push({id: 7, head_sha: sha, status: 'in_progress', conclusion: null});
  assert.equal((await studio.deployStatus()).state, 'running');
  site.runs[0] = {id: 7, head_sha: sha, status: 'completed', conclusion: 'failure'};
  site.jobs[7] = [{name: 'build', conclusion: 'failure', steps: [{name: 'Set up', conclusion: 'success'}, {name: 'Run npm run build', conclusion: 'failure'}]}, {name: 'deploy', conclusion: 'skipped'}];
  const failed = await studio.deployStatus();
  assert.equal(failed.state, 'failure');
  assert.match(failed.detail, /build → Run npm run build/);
  assert.equal(failed.url, 'https://github.com/run/7');
  const reopened = make();  // closing and reopening the tab still shows it
  await reopened.connect();
  assert.equal((await reopened.deployStatus()).state, 'failure');
  site.runs[0].conclusion = 'success';
  assert.equal((await reopened.deployStatus()).state, 'success');
});

test('video uploads: mp4/webm up to 50MB, published like images', async () => {
  const {studio, site} = await setup();
  const big = Buffer.alloc(21 * 1024 * 1024).toString('base64');
  const clip = await studio.upload({name: 'clip.mp4', data: big});
  await assert.rejects(studio.upload({name: 'photo.png', data: big}), /20MB/);
  await assert.rejects(studio.upload({name: 'clip.mov', data: textToB64('x')}), /지원 파일/);
  const html = `<div class="video-embed video-file"><video src="${clip.url}" controls preload="metadata" playsinline></video></div>`;
  await studio.saveRecord({...draftPost(), draft: false, body: '영상\n\n' + html});
  assert.ok((await studio.listUploads()).find(f => f.url === clip.url).used);
  await studio.publish();
  assert.equal(site.files()['site/uploads/' + clip.url.slice(9)].length, 21 * 1024 * 1024);
});

test('project period fields are validated and saved', async () => {
  const {studio} = await setup();
  const project = meta => ({kind: 'project', id: '', version: '', draft: false, slug: 'robot', body: 'x',
    meta: {title: '탁구 로봇', date: '2026-08-24', tags: [], categories: [], image: '', description: '', subtitle: '부제', lang: 'ko', ...meta}});
  let saved = await studio.saveRecord(project({period_start: '2026-07', period_end: '2026-08', ongoing: false}));
  assert.deepEqual([saved.meta.period_start, saved.meta.period_end, saved.meta.ongoing], ['2026-07', '2026-08', false]);
  saved = await studio.saveRecord({...saved, meta: {...saved.meta, ongoing: true}});
  assert.deepEqual([saved.meta.period_end, saved.meta.ongoing], ['', true]);
  for (const bad of [{period_start: '2026-13'}, {period_start: '2026/07'}, {period_start: '2026-08', period_end: '2026-07'}]) {
    await assert.rejects(studio.saveRecord(project({...bad, title: 'x' + Math.random()})), Problem);
  }
  const post = await studio.saveRecord({...draftPost(), draft: false});
  assert.equal(post.meta.period_start, undefined);
});

test('encoding helpers round-trip Korean text', () => {
  assert.equal(b64ToText(textToB64('안녕 👋')), '안녕 👋');
});
