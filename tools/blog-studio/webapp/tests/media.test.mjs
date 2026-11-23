// Video / YouTube nodes: URL parsing and Markdown round trips through the real editor (in jsdom).
import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="e"></div>', {pretendToBeVisual: true});
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'DOMParser', 'getComputedStyle', 'MutationObserver']) {
  if (!(key in globalThis) || key === 'window' || key === 'document') {
    Object.defineProperty(globalThis, key, {value: key === 'window' ? dom.window : dom.window[key], configurable: true, writable: true});
  }
}
dom.window.document.elementFromPoint = () => null;
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0});

const media = await import('../../shared/media.js');
const {createEditor} = await import('../src/editor.js');

test('youtube links of every common shape', () => {
  const id = 'dQw4w9WgXcQ';
  for (const link of [id, `https://www.youtube.com/watch?v=${id}&t=1m30s`, `youtu.be/${id}?t=90`, `https://m.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`, `https://www.youtube-nocookie.com/embed/${id}?start=90`]) {
    assert.equal(media.youtubeId(link), id, link);
  }
  assert.equal(media.youtubeStart(`https://youtu.be/${id}?t=1m30s`), 90);
  assert.equal(media.youtubeStart(`https://youtu.be/${id}`), 0);
  for (const bad of ['https://example.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com/watch?v=short', 'not a url']) assert.equal(media.youtubeId(bad), null, bad);
});

test('video and youtube survive Markdown → editor → Markdown', async () => {
  const markdown = [
    '앞 문단',
    media.videoHtml('/uploads/2026/11/0123456789abcdef01234567.mp4'),
    media.youtubeHtml({videoId: 'dQw4w9WgXcQ', start: 90}),
    '뒤 문단',
  ].join('\n\n');
  const editor = createEditor(document.getElementById('e'), markdown, () => {}, () => {}, async src => src);
  const json = editor.getJSON();
  assert.deepEqual(json.content.map(n => n.type), ['paragraph', 'video', 'youtube', 'paragraph']);
  assert.equal(json.content[1].attrs.src, '/uploads/2026/11/0123456789abcdef01234567.mp4');
  assert.deepEqual({...json.content[2].attrs}, {videoId: 'dQw4w9WgXcQ', start: 90});
  assert.equal(editor.getMarkdown().trim(), markdown);
  editor.commands.setContent('', {contentType: 'markdown'});
  editor.commands.setYoutube({videoId: 'abcdefghijk', start: 0});
  editor.commands.setVideo('/uploads/2026/11/aaaaaaaaaaaaaaaaaaaaaaaa.webm');
  const out = editor.getMarkdown();
  assert.match(out, /youtube-nocookie\.com\/embed\/abcdefghijk"/);
  assert.match(out, /<video src="\/uploads\/2026\/11\/a{24}\.webm" controls/);
  editor.destroy();
});
