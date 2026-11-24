// Browser Blog Studio — UI. Mirrors tools/blog-studio/web/studio.js (the Codespaces
// version) screen for screen; only the data access, login and preview differ.
import {GitHub, Studio, Problem, bytesToB64} from './core.js';
import {createEditor} from './editor.js';
import * as media from '../../shared/media.js';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

const SESSION_KEY = 'blog-studio-web:session';  // this tab only
const VAULT_KEY = 'blog-studio-web:vault';      // encrypted, this browser
const DEFAULT_SITE = 'geon0407/geon0407.github.io';
const DEFAULT_DATA = 'geon0407/blog-studio-data';

let studio;       // core.Studio
let state;        // snapshot used by the screens
let view = 'posts';
let config, editor, current;
let dirty = false, sourceMode = false, editorChanged = false, originalBody = '', busy = false;

const labels = {
  posts: '게시글', projects: '프로젝트', home: '홈', profile: '소개 · 이력', design: '색상 · 레이아웃',
  settings: '기본 설정', files: '첨부파일', trash: '휴지통',
};
const statusNames = {added: '추가', modified: '수정', deleted: '삭제'};
const typeNames = {post: '게시글', project: '프로젝트', file: '첨부파일'};
const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;
const MIME = {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', mp4: 'video/mp4', webm: 'video/webm'};

// ------------------------------------------------------------------ basics

function notice(message, error = false) {
  const box = $('#notice');
  box.hidden = false;
  box.classList.toggle('error', error);
  box.textContent = message;
}

// Same call names as the Codespaces server API, answered by the GitHub-backed Studio.
async function api(path, data) {
  try {
    switch (path) {
      case 'state': {
        const [{config: cfg, version}, records, categories] = await Promise.all([studio.config(), studio.listRecords(), studio.categories()]);
        return {config: cfg, version, records, categories, pending: studio.pendingPaths()};
      }
      case 'settings': return await studio.saveConfig(data);
      case 'save': return await studio.saveRecord(data);
      case 'archive': return await studio.archiveRecord(data);
      case 'restore': return await studio.restoreTrash(data);
      case 'purge': return await studio.purgeTrash(data);
      case 'upload': return await studio.upload(data);
      case 'delete-upload': return await studio.deleteUpload(data);
      case 'uploads': return {items: await studio.listUploads()};
      case 'trash': return {items: await studio.listTrash()};
      case 'changes': return {items: await studio.changes(), ahead: 0};
      case 'discard': return await studio.discard(data);
      case 'publish': return await studio.publish();
      default: throw new Problem('잘못된 요청입니다', 404);
    }
  } catch (e) {
    if (e.status === 401) showLogin(e.message);
    throw e;
  }
}

async function job(fn) {
  if (busy) return;
  busy = true;
  document.body.classList.add('busy');
  try { await fn(); } catch (e) { notice(e.message || String(e), true); } finally {
    busy = false;
    document.body.classList.remove('busy');
  }
}

const clone = x => JSON.parse(JSON.stringify(x));
const get = (obj, path) => path.split('.').reduce((x, k) => x?.[k], obj);
function set(obj, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  parts.reduce((x, k) => x[k], obj)[last] = value;
}
function size(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
function categoryName(slug) {
  return state.categories.find(c => c.slug === slug)?.title_ko || slug;
}

// ------------------------------------------------------------------ images
// Uploads may exist only in the private repo, so show them from the API instead of the site URL.

const imageCache = new Map();
function uploadRel(src) {
  return /^\/uploads\/(\d{4}\/\d{2}\/[A-Za-z0-9_-]+\.[a-z0-9]+)$/.exec(src || '')?.[1] || null;
}
function resolveImage(src) {
  const rel = uploadRel(src);
  if (!rel || !studio) return Promise.resolve(src);
  if (!imageCache.has(rel)) {
    const type = MIME[rel.split('.').pop()] || 'application/octet-stream';
    imageCache.set(rel, studio.uploadBytes(rel)
      .then(bytes => (bytes ? URL.createObjectURL(new Blob([bytes], {type})) : src))
      .catch(() => src));
  }
  return imageCache.get(rel);
}
function hydrate(root = document) {
  root.querySelectorAll('img[data-src]').forEach(img => resolveImage(img.dataset.src).then(u => { img.src = u; }));
  root.querySelectorAll('a[data-href]').forEach(a => resolveImage(a.dataset.href).then(u => { a.href = u; }));
}
async function dataUrl(src) {
  const rel = uploadRel(src);
  if (!rel) return src;
  const bytes = await studio.uploadBytes(rel);
  return bytes ? `data:${MIME[rel.split('.').pop()] || 'application/octet-stream'};base64,${bytesToB64(bytes)}` : src;
}

function renderPending() {
  const count = state.pending.length;
  $('#pending').innerHTML = count
    ? `저장된 변경 ${count}개 · 아직 공개 사이트에 반영되지 않았습니다 <button type="button" class="link-button" id="show-changes">변경 내역 보기</button>`
    : '저장된 사이트 변경 없음 · 초안은 발행 대상에서 제외됩니다';
  if (count) $('#show-changes').onclick = () => job(openPublishDialog);
}

async function refresh() {
  state = await api('state');
  config = clone(state.config);
  renderPending();
}

// ------------------------------------------------------------------ site settings

function field(label, path, type = 'text', wide = false, options = null) {
  const v = get(config, path);
  let input;
  if (type === 'textarea') input = `<textarea data-config="${path}">${esc(v)}</textarea>`;
  else if (type === 'checkbox') input = `<input type="checkbox" data-config="${path}" ${v ? 'checked' : ''}> 표시`;
  else if (type === 'select') input = `<select data-config="${path}">${options.map(([value, title]) => `<option value="${value}" ${String(value) === String(v) ? 'selected' : ''}>${title}</option>`).join('')}</select>`;
  else input = `<input type="${type === 'image' ? 'text' : type}" data-config="${path}" value="${esc(v)}" ${type === 'number' ? 'step="any"' : ''}>`;
  if (type === 'pdf') {
    input = `<div class="row"><input type="text" data-config="${path}" value="${esc(v)}" readonly placeholder="아직 올린 파일이 없습니다">`
      + `<button type="button" data-pdf-field="${path}">PDF 올리기</button>${v ? `<button type="button" data-clear-pdf="${path}">지우기</button>` : ''}</div>`
      + (v ? `<span class="hint"><a data-href="${esc(v)}" href="${esc(v)}" target="_blank" rel="noopener">현재 CV 열기</a></span>` : '');
  }
  if (type === 'image') {
    input = `<div class="row">${input}<button type="button" data-image-field="${path}">사진 선택</button></div>`
      + (v ? `<img class="image-cover" data-src="${esc(v)}" alt="현재 사진">` : '');
  }
  return `<label class="${wide ? 'wide' : ''}">${label}${input}</label>`;
}
const pair = (label, path, type = 'text') => field(label + ' · English', path + '.en', type) + field(label + ' · 한국어', path + '.ko', type);
const panel = (title, body, hint = '') => `<section class="panel"><h2>${title}</h2>${hint ? `<p>${hint}</p>` : ''}${body}</section>`;
const grid = body => `<div class="form-grid">${body}</div>`;
const saveBar = () => '<div class="sticky-actions"><button class="primary" id="save-settings">변경 저장</button><button id="reset-settings">저장 전으로 되돌리기</button></div>';

function collectConfig() {
  $$('[data-config]').forEach(el => {
    const path = el.dataset.config;
    const numeric = el.type === 'number' || typeof get(config, path) === 'number';
    set(config, path, el.type === 'checkbox' ? el.checked : numeric ? Number(el.value) : el.value);
  });
}

function bindConfig() {
  $$('[data-config]').forEach(el => el.addEventListener('input', () => { dirty = true; collectConfig(); }));
  // CV: upload a PDF, remember today as its update date; "지우기" hides the CV links.
  $$('[data-pdf-field]').forEach(btn => btn.onclick = () => chooseFile(async files => {
    if (!/\.pdf$/i.test(files[0].name)) throw Error('CV는 PDF 파일로 올려주세요');
    const result = await uploadFile(files[0]);
    set(config, btn.dataset.pdfField, result.url);
    set(config, btn.dataset.pdfField.replace(/\.path$/, '.updated'), localDate());
    dirty = true;
    renderConfig();
    notice('CV를 올렸습니다. 변경 저장 후 발행하면 사이트에 CV 링크가 나타납니다.');
  }, 'application/pdf,.pdf'));
  $$('[data-clear-pdf]').forEach(btn => btn.onclick = () => {
    if (!confirm('CV 연결을 지울까요? 저장 후 발행하면 사이트에서 CV 링크가 사라집니다.')) return;
    collectConfig();
    set(config, btn.dataset.clearPdf, '');
    set(config, btn.dataset.clearPdf.replace(/\.path$/, '.updated'), '');
    dirty = true;
    renderConfig();
  });
  $$('[data-image-field]').forEach(btn => btn.onclick = () => chooseFile(async files => {
    const result = await uploadFile(files[0]);
    set(config, btn.dataset.imageField, result.url);
    dirty = true;
    renderConfig();
  }, 'image/*'));
  $('#save-settings').onclick = () => job(saveSettings);
  $('#reset-settings').onclick = () => {
    if (confirm('저장하지 않은 변경을 되돌릴까요?')) { config = clone(state.config); dirty = false; renderConfig(); }
  };
}

async function saveSettings() {
  collectConfig();
  await api('settings', {config, version: state.version});
  dirty = false;
  await refresh();
  notice('설정을 저장했습니다. 발행하면 공개 사이트에 반영됩니다.');
  renderConfig();
}

function renderConfig() {
  let out = '';
  if (view === 'home') {
    out = panel('첫 인사', grid(pair('인사말', 'home.greeting') + field('메인 사진', 'home.image', 'image', true) + field('사진 설명', 'home.image_alt', 'text', true)))
      + panel('홈 섹션', grid(field('최근 프로젝트', 'home.show_projects', 'checkbox') + field('최근 글', 'home.show_posts', 'checkbox')
        + field('섹션 순서', 'home.order', 'select', true, [['projects-first', '프로젝트 다음 게시글'], ['posts-first', '게시글 다음 프로젝트']])
        + pair('프로젝트 영역 제목', 'home.projects_title') + pair('게시글 영역 제목', 'home.posts_title')));
    const newsCards = config.home.news.map((e, i) => `<div class="timeline-card">
      <div class="timeline-bar"><strong>${esc([e.date, e.emoji, e.text_ko || e.text].filter(Boolean).join(' ') || '새 소식')}</strong><div>
        <button data-news-move="${i}" data-dir="-1">위로</button><button data-news-move="${i}" data-dir="1">아래로</button><button data-news-remove="${i}">삭제</button>
      </div></div>
      ${grid(field('날짜 (예: 2026.11)', `home.news.${i}.date`) + field('이모지 (선택, 예: 🎉)', `home.news.${i}.emoji`)
        + field('내용 · English', `home.news.${i}.text`, 'textarea') + field('내용 · 한국어', `home.news.${i}.text_ko`, 'textarea'))}
    </div>`).join('');
    out += panel('뉴스', newsCards + '<button id="add-news">뉴스 추가</button>',
      '홈 인사말 아래 뉴스 상자에 위에서부터 순서대로 표시됩니다. 최신 소식을 위에 두세요. 다섯 개 정도가 보이고 나머지는 상자 안에서 스크롤됩니다. 내용에 [보이는 글자](https://주소) 형식으로 링크를 넣을 수 있습니다. 모두 지우면 뉴스 상자가 숨겨집니다.');
  }
  if (view === 'profile') {
    out = panel('소개', grid(pair('이름', 'profile.name') + pair('소개글', 'profile.bio', 'textarea') + pair('마무리 인사', 'profile.closing', 'textarea')
      + pair('성경 구절', 'profile.verse', 'textarea') + pair('성경 출처', 'profile.verse_source')
      + field('왼쪽 인물 사진', 'profile.portrait.path', 'image', true) + field('인물 사진 설명', 'profile.portrait.alt')
      + field('오른쪽 사진', 'profile.feature_photo.path', 'image', true) + field('오른쪽 사진 설명', 'profile.feature_photo.alt')));
    const cards = config.profile.timeline.map((e, i) => `<div class="timeline-card">
      <div class="timeline-bar"><strong>${esc(e.title_ko || '새 항목')}</strong><div>
        <button data-move="${i}" data-dir="-1">위로</button><button data-move="${i}" data-dir="1">아래로</button><button data-remove="${i}">삭제</button>
      </div></div>
      ${grid(field('구분', `profile.timeline.${i}.group`, 'select', true, [['background', '이력'], ['research', '연구 및 수상']])
        + field('기간 · English', `profile.timeline.${i}.period`) + field('기간 · 한국어', `profile.timeline.${i}.period_ko`)
        + field('제목 · English', `profile.timeline.${i}.title`) + field('제목 · 한국어', `profile.timeline.${i}.title_ko`)
        + field('설명 · English', `profile.timeline.${i}.detail`, 'textarea') + field('설명 · 한국어', `profile.timeline.${i}.detail_ko`, 'textarea')
        + field('관련 링크', `profile.timeline.${i}.url`, 'text', true))}
    </div>`).join('');
    out += panel('연락처', grid(field('이메일', 'profile.contact.email', 'email', true) + pair('소속', 'profile.contact.affiliation')
      + field('CV (영문 PDF)', 'profile.contact.cv.path', 'pdf', true) + field('CV 업데이트 날짜', 'profile.contact.cv.updated', 'date')),
      '홈 인사말 아래와 소개 페이지의 소개글 옆에 표시됩니다. CV는 PDF를 올리면 소개 페이지 연락처 카드와 홈 이메일 줄에 “CV” 링크로 나타나고, 올린 날짜가 업데이트 날짜로 기록됩니다. 이메일은 스팸 수집을 막기 위해 페이지 코드에 뒤집힌 형태로 저장되고, 화면에서는 정상적으로 보입니다. 비우면 표시하지 않습니다.');
    out += panel('이력 · 연구 및 수상', cards + '<button id="add-timeline">이력 항목 추가</button>', '화면에 표시할 순서를 직접 정할 수 있습니다. 비어 있는 설명은 표시하지 않습니다. 설명에는 [보이는 글자](https://주소) 형식으로 원하는 부분에 링크를 넣을 수 있고, 링크는 새 탭에서 열립니다.');
  }
  if (view === 'design') {
    const colorLabels = {page_bg: '페이지 배경', surface: '카드·메뉴 배경', ink: '주요 글자', muted: '보조 글자', line: '구분선', accent: '포인트', selected: '선택 배경'};
    out = panel('레이아웃과 글자', grid(field('본문 크기 (16~22px)', 'design.body_size', 'number') + field('줄 간격 (1.4~2)', 'design.line_height', 'number')
      + field('본문 최대 너비 (960~1440px)', 'design.width', 'number') + field('카드 모서리 (0~32px)', 'design.radius', 'number')
      + field('홈 섹션 간격 (24~120px)', 'design.section_gap', 'number') + field('PC 카드 열 수', 'design.columns', 'select', false, [[1, '1열'], [2, '2열'], [3, '3열']])),
      '구조는 Vonge를 유지하면서 홈·소개·프로젝트·블로그에 공통 적용합니다. 모바일에서는 1열로 표시됩니다.');
    for (const [mode, title] of [['light', '라이트 모드'], ['dark', '다크 모드']]) {
      out += panel(title, grid(Object.entries(colorLabels).map(([key, label]) => field(label, `design.colors.${mode}.${key}`, 'color')).join('')));
    }
  }
  if (view === 'settings') {
    out = panel('기본 정보', grid(field('사이트 이름', 'site.title') + field('작성자 이름', 'site.author') + field('사이트 설명', 'site.description', 'textarea', true)
      + field('작성자 사진', 'site.avatar', 'image', true) + field('LinkedIn 링크', 'site.linkedin') + field('GitHub 링크', 'site.github') + field('Instagram 링크', 'site.instagram')))
      + panel('페이지 제목', grid(pair('프로젝트 페이지', 'pages.projects') + pair('블로그 페이지', 'pages.blog')));
  }
  $('#main').innerHTML = out + saveBar();
  hydrate($('#main'));
  bindConfig();
  if (view === 'home') {
    const news = config.home.news;
    const month = localDate().slice(0, 7).replace('-', '.');
    $('#add-news').onclick = () => { collectConfig(); news.unshift({date: month, emoji: '', text: '', text_ko: ''}); dirty = true; renderConfig(); };
    $$('[data-news-move]').forEach(b => b.onclick = () => {
      collectConfig();
      const i = +b.dataset.newsMove, j = i + (+b.dataset.dir);
      if (j >= 0 && j < news.length) { [news[i], news[j]] = [news[j], news[i]]; dirty = true; renderConfig(); }
    });
    $$('[data-news-remove]').forEach(b => b.onclick = () => {
      if (confirm('이 뉴스를 삭제할까요? 저장 전에는 되돌릴 수 있습니다.')) { collectConfig(); news.splice(+b.dataset.newsRemove, 1); dirty = true; renderConfig(); }
    });
  }
  if (view === 'profile') {
    const timeline = config.profile.timeline;
    $('#add-timeline').onclick = () => {
      collectConfig();
      timeline.unshift({group: 'background', period: '', period_ko: '', title: 'New entry', title_ko: '새 항목', detail: '', detail_ko: '', url: ''});
      dirty = true;
      renderConfig();
    };
    $$('[data-move]').forEach(b => b.onclick = () => {
      collectConfig();
      const i = +b.dataset.move, j = i + (+b.dataset.dir);
      if (j >= 0 && j < timeline.length) { [timeline[i], timeline[j]] = [timeline[j], timeline[i]]; dirty = true; renderConfig(); }
    });
    $$('[data-remove]').forEach(b => b.onclick = () => {
      if (confirm('이 항목을 목록에서 삭제할까요? 저장 전에는 되돌릴 수 있습니다.')) {
        collectConfig();
        timeline.splice(+b.dataset.remove, 1);
        dirty = true;
        renderConfig();
      }
    });
  }
}

function normaliseConfig() {
  config.home.news ??= [];
  config.home.news.forEach(e => { for (const k of ['date', 'emoji', 'text', 'text_ko']) e[k] ??= ''; });
  config.profile.timeline.forEach(e => {
    for (const k of ['period', 'period_ko', 'title', 'title_ko', 'detail', 'detail_ko', 'url']) e[k] ??= '';
    e.group ??= 'research';
  });
}

// ------------------------------------------------------------------ navigation

function navigate(next) {
  if (dirty && !confirm('저장하지 않은 변경이 있습니다. 이 화면을 떠날까요?')) return;
  editor?.destroy();
  editor = null;
  current = null;
  dirty = false;
  view = next;
  config = clone(state.config);
  normaliseConfig();
  $('#page-title').textContent = labels[view];
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'posts' || view === 'projects') renderList();
  else if (view === 'files') job(renderFiles);
  else if (view === 'trash') job(renderTrash);
  else renderConfig();
}

// ------------------------------------------------------------------ posts & projects

function recordBadge(r) {
  if (r.draft) return r.source_id ? '비공개 보관' : '비공개 초안';
  return state.pending.includes(r.id) ? '발행 대기' : '공개 중';
}

function renderList() {
  const kind = view === 'posts' ? 'post' : 'project';
  const records = state.records.filter(r => r.kind === kind);
  $('#main').innerHTML = `<div class="list-toolbar"><input id="search" placeholder="제목으로 검색" aria-label="글 검색">
    <button id="new-record" class="primary">${kind === 'post' ? '새 게시글' : '새 프로젝트'}</button></div>
    <section class="panel" id="record-list"></section>`;
  const fill = () => {
    const query = $('#search').value.toLowerCase();
    const filtered = records.filter(r => r.meta.title.toLowerCase().includes(query));
    $('#record-list').innerHTML = filtered.length ? filtered.map(r => `<div class="record">
        <div><h3>${esc(r.meta.title)}<span class="badge">${recordBadge(r)}</span></h3>
        <small>${r.meta.studio_number ? `#${esc(r.meta.studio_number)} · ` : ''}${esc(String(r.meta.date || '').slice(0, 10))}${(r.meta.categories || []).length ? ' · ' + esc(r.meta.categories.map(categoryName).join(', ')) : ''}</small></div>
        <button data-open="${esc(r.id)}">편집</button></div>`).join('')
      : `<div class="empty">${query ? '검색 결과가 없습니다.' : '아직 글이 없습니다. 첫 기록을 남겨보세요.'}</div>`;
    $$('[data-open]').forEach(b => b.onclick = () => openRecord(records.find(r => r.id === b.dataset.open)));
  };
  fill();
  $('#search').oninput = fill;
  $('#new-record').onclick = () => openRecord({
    id: '', version: '', kind, draft: true, slug: '',
    meta: {title: '', date: localDate(), description: '', subtitle: '', tags: [], categories: kind === 'post' ? [state.categories[0]?.slug].filter(Boolean) : [], image: '', lang: 'ko'},
    body: '',
  });
}

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function metaField(label, key, type = 'text', wide = false, hint = '') {
  const raw = current.meta[key];
  const value = key === 'tags' ? (raw || []).join(', ') : String(raw ?? '').slice(0, key === 'date' ? 10 : undefined);
  const input = type === 'textarea'
    ? `<textarea data-meta="${key}">${esc(raw)}</textarea>`
    : `<input type="${type}" data-meta="${key}" value="${esc(value)}"${type === 'month' ? ' placeholder="YYYY-MM"' : ''}>`;
  return `<label class="${wide ? 'wide' : ''}">${label}${input}${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
}

function categorySelect() {
  const groups = [...new Set(state.categories.map(c => c.group_ko))];
  const selected = current.meta.categories?.[0];
  return `<label>카테고리<select id="category">${groups.map(g => `<optgroup label="${esc(g)}">${state.categories.filter(c => c.group_ko === g)
    .map(c => `<option value="${esc(c.slug)}" ${c.slug === selected ? 'selected' : ''}>${esc(c.title_ko)}</option>`).join('')}</optgroup>`).join('')}</select></label>`;
}

function openRecord(item) {
  editor?.destroy();
  current = clone(item);
  originalBody = current.body;
  editorChanged = false;
  sourceMode = false;
  dirty = false;
  const isPublic = current.id && !current.draft;
  const hasAddress = current.source_id || isPublic;
  $('#page-title').textContent = current.kind === 'post' ? '게시글 편집' : '프로젝트 편집';

  const address = hasAddress
    ? `<label>글 주소<input value="${esc((current.source_id || current.id).split('/').pop())}" disabled><span class="hint">주소는 처음 발행할 때 정해지며, 날짜를 바꿔도 바뀌지 않습니다.</span></label>`
    : `<label>글 주소<input id="slug" placeholder="비워두면 번호로 자동 생성" value="${esc(current.slug || '')}"></label>`;
  const project = current.kind === 'project';
  const info = grid(metaField(project ? '게시글 제목' : '제목', 'title', 'text', true, project ? '프로젝트 페이지의 큰 제목과 브라우저 탭 제목에 쓰입니다.' : '')
    + (project
      ? metaField('게시글 부제목', 'subtitle', 'text', true, '프로젝트 페이지에서 제목 아래에 표시됩니다.')
        + metaField('카드 제목', 'card_title', 'text', true, '프로젝트 카드에 항상 표시되는 짧은 제목입니다. 비워두면 게시글 제목을 씁니다.')
        + metaField('카드 부제목', 'card_subtitle', 'text', true, '카드에 마우스를 올리면 카드 제목 아래에 펼쳐집니다. 비워두면 게시글 부제목을 씁니다.')
      : '')
    + metaField('날짜', 'date', 'date')
    + `<label>언어<select data-meta="lang"><option value="ko" ${current.meta.lang !== 'en' ? 'selected' : ''}>한국어</option><option value="en" ${current.meta.lang === 'en' ? 'selected' : ''}>English</option></select></label>`
    + metaField('요약 (목록에 표시)', 'description', 'textarea', true)
    + (project
      ? metaField('시작 연월', 'period_start', 'month') + metaField('종료 연월', 'period_end', 'month')
        + `<label class="inline-check wide"><input type="checkbox" data-meta="ongoing" ${current.meta.ongoing ? 'checked' : ''}> 진행 중 (종료 연월 대신 “진행 중”으로 표시)</label>`
      : categorySelect())
    + metaField('태그 (쉼표로 구분)', 'tags') + metaField('번호 (비워두면 자동)', 'studio_number', 'number') + address
    + `<label class="wide">대표 이미지<div class="row"><input data-meta="image" value="${esc(current.meta.image)}"><button id="cover">사진 선택</button></div></label>`);

  const saveLabel = current.draft ? (current.source_id ? '비공개 변경 저장' : '초안 저장') : '수정 저장';
  const readyLabel = current.draft ? (current.source_id ? '다시 공개할 글로 저장' : '공개할 글로 저장') : '저장 후 미리보기';
  $('#main').innerHTML = `<div id="recovery"></div>${panel('기본 정보', info)}
    ${panel('본문', '<div class="toolbar" id="toolbar"></div><div id="editor" class="editor-surface"></div><textarea id="source" hidden aria-label="Markdown 원문"></textarea><div class="editor-foot" id="word-count"></div>',
      '사진을 붙여넣거나 끌어놓을 수 있습니다. 표는 헤더가 있는 일반 표로 저장됩니다.')}
    <div class="sticky-actions">
      <button id="save-record" class="primary">${saveLabel}</button><button id="ready-record">${readyLabel}</button>
      <button id="preview-record">미리보기</button>
      <button id="export">Markdown 내보내기</button><button id="back">목록</button>
      ${isPublic ? '<button id="make-private">비공개로 전환</button>' : ''}
      ${current.id ? '<button id="delete-record" class="danger">휴지통으로</button>' : ''}
    </div>`;

  const toolbar = [['굵게', 'bold'], ['기울임', 'italic'], ['취소선', 'strike'], ['제목 2', 'h2'], ['제목 3', 'h3'], ['본문', 'paragraph'], ['인용', 'quote'],
    ['목록', 'bullet'], ['번호', 'ordered'], ['체크', 'task'], ['구분선', 'hr'], ['인라인 코드', 'code'], ['코드 블록', 'codeblock'], ['링크', 'link'],
    ['표', 'table'], ['행 추가', 'row'], ['열 추가', 'column'], ['행 삭제', 'delrow'], ['열 삭제', 'delcolumn'], ['표 삭제', 'deltable'],
    ['사진', 'image'], ['동영상', 'video'], ['유튜브', 'youtube'], ['파일 첨부', 'file'], ['실행 취소', 'undo'], ['다시 실행', 'redo'], ['Markdown', 'source']];
  const languages = [['plaintext', '일반 텍스트'], ['cpp', 'C++'], ['python', 'Python'], ['javascript', 'JavaScript'], ['typescript', 'TypeScript'],
    ['bash', 'Bash'], ['json', 'JSON'], ['yaml', 'YAML'], ['sql', 'SQL'], ['java', 'Java'], ['c', 'C']];
  $('#toolbar').innerHTML = toolbar.map(([name, key]) => `<button type="button" data-command="${key}">${name}</button>`).join('')
    + `<select id="code-lang" aria-label="코드 언어">${languages.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select>`;

  editor = createEditor($('#editor'), current.body, () => { editorChanged = true; changed(); }, files => job(() => insertFiles(files)), resolveImage);
  $$('[data-meta],#category,#slug').forEach(el => el.addEventListener('input', changed));
  const ongoing = $('[data-meta="ongoing"]');
  if (ongoing) {
    const syncEnd = () => { $('[data-meta="period_end"]').disabled = ongoing.checked; };
    ongoing.addEventListener('change', () => { syncEnd(); changed(); });
    syncEnd();
  }
  $('#source').addEventListener('input', () => { editorChanged = true; changed(); });
  $$('[data-command]').forEach(btn => { btn.onmousedown = e => e.preventDefault(); btn.onclick = () => tool(btn.dataset.command); });
  $('#code-lang').onchange = () => editor.chain().focus().updateAttributes('codeBlock', {language: $('#code-lang').value}).run();
  $('#cover').onclick = () => chooseFile(async files => {
    const result = await uploadFile(files[0]);
    $('[data-meta="image"]').value = result.url;
    changed();
  }, 'image/*');
  $('#save-record').onclick = () => job(() => saveRecord(current.draft));
  $('#ready-record').onclick = () => job(async () => { await saveRecord(false); await previewRecord(); });
  $('#preview-record').onclick = () => job(previewRecord);
  $('#back').onclick = () => { if (!busy) navigate(view); };
  $('#export').onclick = () => download(($('#slug')?.value || 'post') + '.md', bodyText());
  if ($('#make-private')) $('#make-private').onclick = () => job(async () => {
    if (confirm('현재 내용을 비공개로 저장할까요? 다음 발행 때 사이트에서 내려갑니다.')) await saveRecord(true);
  });
  if ($('#delete-record')) $('#delete-record').onclick = () => job(deleteRecord);
  offerRecovery();
  count();
}

// Unsaved-work recovery lives in sessionStorage: other pages of the blog share this origin
// (and load third-party scripts), so private drafts never go to localStorage.
function offerRecovery() {
  const saved = readRecovery();
  if (!saved || saved.body === current.body) return;
  $('#recovery').innerHTML = '<div class="recovery"><span>이 탭에 저장하지 않은 작성 내용이 있습니다.</span><button id="restore">복구</button><button id="discard-recovery">버리기</button></div>';
  $('#restore').onclick = () => {
    for (const [key, value] of Object.entries(saved.meta || {})) {
      const el = $(`[data-meta="${key}"]`);
      if (el && el.type === 'checkbox') el.checked = Boolean(value);
      else if (el) el.value = key === 'tags' ? value.join(', ') : value;
    }
    if ($('#slug')) $('#slug').value = saved.slug || '';
    if ($('#category') && saved.meta.categories?.[0]) $('#category').value = saved.meta.categories[0];
    editor.commands.setContent(saved.body, {contentType: 'markdown'});
    editorChanged = true;
    changed();
    $('#recovery').innerHTML = '';
  };
  $('#discard-recovery').onclick = () => { forgetRecovery(); $('#recovery').innerHTML = ''; };
}

const recoveryKey = (record = current) => 'blog-studio-web:recovery:' + record.kind + ':' + (record.id || 'new');
function readRecovery() { try { return JSON.parse(sessionStorage.getItem(recoveryKey())); } catch { return null; } }
function forgetRecovery(record = current) { try { sessionStorage.removeItem(recoveryKey(record)); } catch {} }
function bodyText() { return sourceMode ? $('#source').value : editorChanged ? editor.getMarkdown() : originalBody; }

function collectRecord() {
  const meta = clone(current.meta);
  $$('[data-meta]').forEach(el => {
    meta[el.dataset.meta] = el.dataset.meta === 'tags' ? el.value.split(',').map(s => s.trim()).filter(Boolean)
      : el.type === 'checkbox' ? el.checked : el.value;
  });
  if ($('#category')) meta.categories = [$('#category').value];
  return {...current, meta, body: bodyText(), slug: $('#slug')?.value || ''};
}

function changed() {
  dirty = true;
  count();
  try { sessionStorage.setItem(recoveryKey(), JSON.stringify(collectRecord())); } catch {
    notice('브라우저 자동 복구 저장공간이 부족합니다. 초안 저장을 눌러주세요.', true);
  }
}

function count() {
  if ($('#word-count') && editor) $('#word-count').textContent = `${bodyText().length.toLocaleString()}자 · 작성 중 내용은 이 탭에 자동 복구용으로 보관됩니다`;
}

async function saveRecord(draft) {
  const record = current;  // the screen may change while saving
  const data = collectRecord();
  data.draft = draft;
  notice('GitHub에 저장하고 있습니다…');
  const saved = await api('save', data);
  forgetRecovery(record);
  dirty = false;
  await refresh();
  openRecord(saved);
  notice(draft ? '초안을 비공개 저장소에 저장했습니다. 공개 사이트에는 포함되지 않습니다.' : '저장했습니다. 발행을 누르면 공개 사이트에 반영됩니다.');
}

async function deleteRecord() {
  const message = !current.draft
    ? '이 글을 휴지통으로 옮길까요?\n다음 발행 때 공개 사이트에서 삭제되며, 그 전후 언제든 휴지통에서 복구할 수 있습니다.'
    : current.source_id
      ? '비공개 보관 중인 이 글을 휴지통으로 옮길까요? 휴지통에서 복구할 수 있습니다.'
      : '이 초안을 휴지통으로 옮길까요? 휴지통에서 복구할 수 있습니다.';
  if (!confirm(message)) return;
  if (dirty && !confirm('저장하지 않은 변경은 휴지통에 포함되지 않습니다. 계속할까요?')) return;
  const record = current;  // the screen may change while the request runs
  await api('archive', {id: record.id, version: record.version});
  forgetRecovery(record);
  dirty = false;
  await refresh();
  navigate(record.kind === 'post' ? 'posts' : 'projects');
  notice('휴지통으로 옮겼습니다.');
}

function tool(action) {
  if (action === 'source') {
    if (sourceMode) { editor.commands.setContent($('#source').value, {contentType: 'markdown'}); editorChanged = true; }
    else $('#source').value = bodyText();
    sourceMode = !sourceMode;
    $('#source').hidden = !sourceMode;
    $('#editor').hidden = sourceMode;
    return;
  }
  if (action === 'image' || action === 'file') { chooseFile(files => insertFiles(files), action === 'image' ? 'image/*' : ''); return; }
  if (action === 'video') { chooseFile(files => insertFiles(files), 'video/mp4,video/webm,.mp4,.webm'); return; }
  if (action === 'youtube') { insertYoutube(); return; }
  if (sourceMode) { notice('서식 버튼을 사용하려면 Markdown 버튼을 눌러 편집 화면으로 돌아오세요.'); return; }
  const chain = editor.chain().focus();
  if (action === 'link') {
    const value = prompt('링크 주소 (비우면 링크 해제)', editor.getAttributes('link').href || 'https://');
    if (value === null) return;
    if (!value) { chain.unsetLink().run(); return; }
    if (!/^(https?:\/\/|\/[^/])/.test(value)) { notice('https:// 주소 또는 /로 시작하는 사이트 경로를 입력하세요', true); return; }
    if (editor.state.selection.empty) {
      const label = prompt('링크에 표시할 글자', value);
      if (label !== null) chain.insertContent({type: 'text', text: label, marks: [{type: 'link', attrs: {href: value}}]}).run();
    } else chain.setLink({href: value}).run();
    return;
  }
  const commands = {
    bold: () => chain.toggleBold(), italic: () => chain.toggleItalic(), strike: () => chain.toggleStrike(),
    h2: () => chain.toggleHeading({level: 2}), h3: () => chain.toggleHeading({level: 3}), paragraph: () => chain.setParagraph(),
    quote: () => chain.toggleBlockquote(), bullet: () => chain.toggleBulletList(), ordered: () => chain.toggleOrderedList(),
    task: () => chain.toggleTaskList(), hr: () => chain.setHorizontalRule(), code: () => chain.toggleCode(),
    codeblock: () => chain.toggleCodeBlock({language: $('#code-lang').value}),
    table: () => chain.insertTable({rows: 3, cols: 3, withHeaderRow: true}), row: () => chain.addRowAfter(), column: () => chain.addColumnAfter(),
    delrow: () => chain.deleteRow(), delcolumn: () => chain.deleteColumn(), deltable: () => chain.deleteTable(),
    undo: () => chain.undo(), redo: () => chain.redo(),
  };
  commands[action]?.().run();
}

// ------------------------------------------------------------------ uploads

function chooseFile(callback, accept = '') {
  const input = $('#upload');
  input.accept = accept;
  input.multiple = true;
  input.value = '';
  input.onchange = () => { if (input.files.length) job(() => callback(Array.from(input.files))); };
  input.click();
}

function insertYoutube() {
  const link = prompt('유튜브 영상 주소 (youtu.be/…, youtube.com/watch?v=…, 쇼츠 링크 모두 가능)');
  if (!link) return;
  const videoId = media.youtubeId(link);
  if (!videoId) { notice('유튜브 영상 주소를 확인하세요. 예: https://youtu.be/영상ID', true); return; }
  const attrs = {videoId, start: media.youtubeStart(link)};
  if (sourceMode) { $('#source').value += `\n${media.youtubeHtml(attrs)}\n`; changed(); }
  else editor.chain().focus().setYoutube(attrs).run();
}

async function uploadFile(file) {
  const isVideo = media.isVideoFile(file.name);
  if (/\.(mov|avi|mkv|wmv|m4v|3gp)$/i.test(file.name)) throw Error('동영상은 mp4 또는 webm만 올릴 수 있습니다. 다른 형식은 mp4로 변환하거나 유튜브에 올린 뒤 유튜브 버튼으로 넣어주세요.');
  if (isVideo && file.size > media.VIDEO_LIMIT) throw Error('동영상은 50MB 이하만 올릴 수 있습니다. 긴 영상은 유튜브에 "일부 공개"로 올린 뒤 유튜브 버튼으로 넣어주세요.');
  if (!isVideo && file.size > 20 * 1024 * 1024) throw Error('첨부파일은 20MB 이하여야 합니다');
  const data = bytesToB64(new Uint8Array(await file.arrayBuffer()));
  notice(`${file.name} 업로드 중…`);
  return api('upload', {name: file.name, data});
}

async function insertFiles(files) {
  for (const file of files) {
    const result = await uploadFile(file);
    const isImage = IMAGE.test(file.name);
    if (media.isVideoFile(file.name)) {
      if (sourceMode) { $('#source').value += `\n${media.videoHtml(result.url)}\n`; changed(); }
      else editor.chain().focus().setVideo(result.url).run();
      continue;
    }
    if (sourceMode) {
      $('#source').value += `\n${isImage ? '!' : ''}[${file.name.replace(/[\[\]]/g, '')}](${result.url})\n`;
      changed();
    } else if (isImage) editor.chain().focus().setImage({src: result.url, alt: file.name}).run();
    else editor.chain().focus().insertContent([{type: 'paragraph', content: [{type: 'text', text: file.name, marks: [{type: 'link', attrs: {href: result.url}}]}]}]).run();
  }
  notice('첨부파일을 업로드했습니다. 글도 저장해주세요.');
}

function download(name, value) {
  const a = document.createElement('a');
  const href = URL.createObjectURL(new Blob([value], {type: 'text/markdown;charset=utf-8'}));
  a.href = href;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

async function renderFiles() {
  const {items} = await api('uploads');
  const unused = items.filter(f => !f.used);
  const total = unused.reduce((sum, f) => sum + f.size, 0);
  $('#main').innerHTML = panel('업로드한 파일',
    `<label class="inline-check"><input type="checkbox" id="only-unused" ${unused.length ? 'checked' : ''}> 사용하지 않는 파일만 보기</label><div id="file-list"></div>`,
    `전체 ${items.length}개 · 사용하지 않는 파일 ${unused.length}개${unused.length ? ` (${size(total)})` : ''}. 글·설정·초안·휴지통 글 어디에서도 쓰지 않는 파일만 삭제할 수 있으며, 삭제한 파일은 휴지통에서 복구할 수 있습니다.`);
  const fill = () => {
    const shown = $('#only-unused').checked ? unused : items;
    $('#file-list').innerHTML = shown.length ? shown.map(f => `<div class="record file-row">
        ${IMAGE.test(f.path) ? `<img class="thumb" data-src="${esc(f.url)}" alt="" loading="lazy">` : `<span class="thumb file-icon">${/\.(mp4|webm)$/i.test(f.path) ? 'VIDEO' : 'FILE'}</span>`}
        <div class="grow"><h3><a data-href="${esc(f.url)}" href="#" target="_blank" rel="noopener">${esc(f.path)}</a>
          <span class="badge ${f.used ? '' : 'warn'}">${f.used ? '사용 중' : '사용 안 함'}</span></h3>
          <small>${size(f.size)} · ${f.where.includes('repo') ? '공개 사이트에 있음' : '발행 전 (비공개 저장소에만 있음)'}</small></div>
        ${f.used ? '' : `<button class="danger" data-delete-file="${esc(f.path)}">삭제</button>`}</div>`).join('')
      : '<div class="empty">정리할 파일이 없습니다.</div>';
    hydrate($('#file-list'));
    $$('[data-delete-file]').forEach(b => b.onclick = () => job(async () => {
      if (!confirm(`${b.dataset.deleteFile} 파일을 휴지통으로 옮길까요?`)) return;
      await api('delete-upload', {path: b.dataset.deleteFile});
      await refresh();
      await renderFiles();
      notice('파일을 휴지통으로 옮겼습니다. 공개 사이트에 있던 파일은 다음 발행 때 삭제됩니다.');
    }));
  };
  fill();
  $('#only-unused').onchange = fill;
}

// ------------------------------------------------------------------ trash

async function renderTrash() {
  const {items} = await api('trash');
  const rows = items.map(t => {
    const when = t.deleted_at ? t.deleted_at.replace('T', ' ').slice(0, 16) : '';
    const badge = t.type === 'file' ? '' : `<span class="badge">${t.draft ? '초안' : '공개했던 글'}</span>`;
    return `<div class="record"><div><h3>${esc(t.title || '(제목 없음)')}${badge}</h3>
      <small>${typeNames[t.type] || t.type} · ${esc(when)} 삭제 · ${size(t.size)}</small></div>
      <div class="row-actions"><button data-restore="${t.id}">복구</button><button class="danger" data-purge="${t.id}">영구 삭제</button></div></div>`;
  }).join('');
  $('#main').innerHTML = panel('휴지통', (items.length ? '<div class="list-toolbar"><span></span><button id="purge-all" class="danger">휴지통 비우기</button></div>' : '')
    + (rows || '<div class="empty">휴지통이 비어 있습니다.</div>'),
    '삭제한 글과 첨부파일은 비공개 저장소에 보관됩니다. 공개했던 글을 복구하면 다음 발행 때 사이트에 다시 반영됩니다.');
  $$('[data-restore]').forEach(b => b.onclick = () => job(async () => {
    const result = await api('restore', {id: b.dataset.restore});
    await refresh();
    await renderTrash();
    notice(result.public ? '복구했습니다. 다음 발행 때 사이트에 다시 반영됩니다.' : '복구했습니다.');
  }));
  $$('[data-purge]').forEach(b => b.onclick = () => job(async () => {
    if (!confirm('이 항목을 영구 삭제할까요? 되돌릴 수 없습니다.')) return;
    await api('purge', {id: b.dataset.purge});
    await renderTrash();
  }));
  if ($('#purge-all')) $('#purge-all').onclick = () => job(async () => {
    if (!confirm(`휴지통의 ${items.length}개 항목을 모두 영구 삭제할까요? 되돌릴 수 없습니다.`)) return;
    await api('purge', {id: 'all'});
    await renderTrash();
  });
}

// ------------------------------------------------------------------ preview & publish
// No Jekyll in the browser: the preview renders the editor's HTML inside the blog's own
// stylesheets with the post page's markup. Close to the real page, not identical.

async function previewRecord() {
  if (!current || !editor) { notice('미리보기는 글 편집 화면에서 볼 수 있습니다. 사이트 설정은 발행 후 공개 사이트에서 확인하세요.'); return; }
  if (sourceMode) { notice('Markdown 버튼을 눌러 편집 화면으로 돌아온 뒤 미리보기를 눌러주세요.'); return; }
  const record = collectRecord();
  let html = editor.getHTML();
  for (const match of new Set(html.match(/\/uploads\/\d{4}\/\d{2}\/[A-Za-z0-9_-]+\.[a-z0-9]+/g) || [])) {
    // Videos go in as blob URLs (a 50MB data: URL would be slow); images inline as data: URLs.
    const url = media.isVideoFile(match) ? await resolveImage(match) : await dataUrl(match);
    html = html.split(`"${match}"`).join(`"${url}"`);
  }
  const cover = record.meta.image ? await dataUrl(record.meta.image) : '';
  const author = state.config.site?.author || '';
  const tags = (record.meta.tags || []).map(t => `<a class="post-tags__tag">${esc(t)}</a>`).join('');
  const doc = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;900&display=swap">
    <link rel="stylesheet" href="/assets/main.css"><link rel="stylesheet" href="/assets/site.css">
    <link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/studio-design.css">
    <style>body::after{display:none!important}.lazy,.animate{opacity:1!important;animation:none!important;transform:none!important}</style></head>
    <body><div class="post-top"><div class="container"><div class="row">
      ${cover ? `<div class="col col-6 col-d-12"><div class="post-image"><img src="${esc(cover)}" alt=""></div></div>` : ''}
      <div class="col col-6 col-d-12"><div class="post__info">${tags ? `<div class="post-tags">${tags}</div>` : ''}
        <h1 class="post__title">${esc(record.meta.title || '(제목 없음)')}</h1>
        <div class="post__meta"><div class="post__meta-bottom"><div class="post__author">${esc(author)}</div>
        <time class="post__date">${esc(String(record.meta.date || '').slice(0, 10))}</time></div></div></div></div>
    </div></div></div>
    <div class="container"><article class="post"><div class="post__content">${html}</div></article></div></body></html>`;
  $('#site-preview').srcdoc = doc;
  $('#preview-dialog').showModal();
  notice('미리보기는 블로그의 스타일로 그린 근사치입니다. 실제 페이지는 발행 후 1~2분 뒤 확인할 수 있습니다.');
}

async function openPublishDialog() {
  const {items} = await api('changes');
  if (!items.length) { notice('발행할 변경이 없습니다.'); return; }
  $('#publish-list').innerHTML = `<ul class="change-list">${items.map(i => `<li>
      <span class="badge status-${i.status}">${statusNames[i.status]}</span>
      <span class="grow"><strong>${esc(i.label)}</strong> ${esc(i.title)}<small>${esc(i.path)}</small></span>
      ${state.pending.includes(i.path) ? `<button class="link-button" data-discard="${esc(i.path)}">버리기</button>` : ''}</li>`).join('')}</ul>
    <p class="hint">비공개 초안은 포함되지 않습니다. 발행하면 블로그 저장소에 커밋되고 Actions가 사이트를 배포합니다.
    웹 버전은 발행 전에 Jekyll 빌드 검사를 하지 않으므로, 배포가 실패하면 GitHub의 Actions 탭에서 원인을 확인하세요.</p>`;
  $$('[data-discard]').forEach(b => b.onclick = () => job(async () => {
    if (!confirm(`${b.dataset.discard}의 발행 전 변경을 버릴까요? 공개 사이트의 현재 내용으로 돌아갑니다.`)) return;
    await api('discard', {path: b.dataset.discard});
    await refresh();
    $('#publish-dialog').close();
    await openPublishDialog();
  }));
  $('#publish-dialog').showModal();
}

async function publishNow() {
  $('#publish-dialog').close();
  notice('GitHub에 발행하고 있습니다. 창을 닫지 마세요.');
  const result = await api('publish', {});
  await refresh();
  if (view === 'posts' || view === 'projects') renderList();
  notice(result.message);
  watchDeploy();
}

// After publishing, follow the GitHub Actions deploy until it finishes. A failure stays
// visible (also after reopening) until the next successful publish.
let deployTimer = null, deployPolls = 0;
async function watchDeploy(first = true) {
  clearTimeout(deployTimer);
  if (first) deployPolls = 0;
  let status;
  try { status = await studio.deployStatus(); } catch { return; }
  renderDeploy(status);
  if (status?.state === 'running' && ++deployPolls < 40) deployTimer = setTimeout(() => watchDeploy(false), 15000);
}
function renderDeploy(s) {
  const box = $('#deploy');
  if (!s || (s.state === 'success' && Date.now() - Date.parse(s.at) > 24 * 3600 * 1000)) { box.hidden = true; return; }
  const text = {
    running: '배포 중입니다. 1~2분 뒤 공개 사이트에 반영됩니다.',
    success: '배포 완료 — 공개 사이트에 반영됐습니다.',
    failure: '배포 실패 — 공개 사이트는 발행 전 상태 그대로입니다.',
    unknown: '배포 결과를 확인하지 못했습니다. Actions 기록에서 직접 확인하세요.',
  }[s.state];
  const help = s.state === 'failure'
    ? `<p>Codespace에서 “웹 Studio 발행(커밋 ${esc(s.sha.slice(0, 7))})의 배포가 실패했다”는 내용으로 원인을 확인해 고칠 수 있습니다. 그 전까지 이 표시는 남아 있습니다.</p>` : '';
  box.hidden = false;
  box.className = 'deploy deploy-' + s.state;
  box.innerHTML = `<div><strong>${esc(text)}</strong>
    <small>${esc(s.at.replace('T', ' ').slice(0, 16))} 발행 · ${esc(s.detail)}${s.summary ? ' · ' + esc(s.summary.replace(/^content\(studio-web\): /, '')) : ''}</small>${help}</div>
    <a href="${esc(s.url)}" target="_blank" rel="noopener">Actions 기록 보기</a>`;
}

$('#preview').onclick = () => job(previewRecord);
$('#close-preview').onclick = () => $('#preview-dialog').close();
$$('[data-width]').forEach(b => b.onclick = () => $('#site-preview').style.width = b.dataset.width);
$('#publish').onclick = () => job(async () => {
  if (dirty) throw Error('먼저 현재 편집 내용을 저장해주세요.');
  await openPublishDialog();
});
$('#publish-confirm').onclick = () => job(publishNow);
$('#publish-cancel').onclick = () => $('#publish-dialog').close();
$('#reload').onclick = () => job(async () => {
  if (dirty && !confirm('저장하지 않은 변경이 있습니다. GitHub에서 다시 불러올까요?')) return;
  dirty = false;
  await studio.reload();
  await refresh();
  navigate(view);
  watchDeploy();
  notice('GitHub에서 최신 내용을 불러왔습니다.');
});
$$('#nav button').forEach(b => b.onclick = () => {
  if (busy) { notice('진행 중인 작업이 끝난 뒤에 이동하세요.'); return; }
  navigate(b.dataset.view);
});
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

// ------------------------------------------------------------------ login
// The token stays in this tab's sessionStorage. "Remember on this PC" stores it in
// localStorage only encrypted (AES-GCM, key from the password via PBKDF2).

const enc = new TextEncoder(), dec = new TextDecoder();
async function vaultKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256'}, base, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}
async function saveVault(session, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, await vaultKey(password, salt), enc.encode(JSON.stringify(session)));
  localStorage.setItem(VAULT_KEY, JSON.stringify({v: 1, salt: bytesToB64(salt), iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(data)), site: session.site, dataRepo: session.data}));
}
async function openVault(password) {
  const vault = JSON.parse(localStorage.getItem(VAULT_KEY));
  const b = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  try {
    const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: b(vault.iv)}, await vaultKey(password, b(vault.salt)), b(vault.data));
    return JSON.parse(dec.decode(plain));
  } catch { throw new Problem('비밀번호가 맞지 않습니다'); }
}
const readJson = (storage, key) => { try { return JSON.parse(storage.getItem(key)); } catch { return null; } };

const loginError = $('#login-error');
function showLogin(message = '') {
  $('#app').hidden = true;
  $('#login').hidden = false;
  const vault = readJson(localStorage, VAULT_KEY);
  $('#unlock-box').hidden = !vault;
  $('#connect-form').hidden = Boolean(vault);
  if (vault) $('#unlock-repos').textContent = `${vault.site} · ${vault.dataRepo}`;
  loginError.textContent = message;
  (vault ? $('#unlock-password') : $('#token')).focus();
}

async function connect(session) {
  const resuming = Boolean(state);
  studio = new Studio({site: new GitHub({token: session.token, repo: session.site}), data: new GitHub({token: session.token, repo: session.data})});
  await studio.connect();
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  await refresh();
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#repo-name').textContent = session.data;
  if (!resuming) navigate('posts');
  watchDeploy();
}

async function withButton(form, fn) {
  loginError.textContent = '';
  const button = form.querySelector('button.primary');
  button.disabled = true;
  try { await fn(); } catch (e) { loginError.textContent = e.message || String(e); } finally { button.disabled = false; }
}

$('#remember').onchange = () => { $('#remember-fields').hidden = !$('#remember').checked; };
$('#connect-form').onsubmit = event => {
  event.preventDefault();
  withButton($('#connect-form'), async () => {
    const session = {token: $('#token').value.trim(), site: $('#site-repo').value.trim(), data: $('#data-repo').value.trim()};
    if (!/^(github_pat_|ghp_)/.test(session.token)) throw new Problem('GitHub 토큰은 github_pat_ 또는 ghp_로 시작합니다');
    if ($('#remember').checked) {
      if ($('#vault-password').value.length < 8) throw new Problem('비밀번호는 8자 이상으로 정하세요');
      if ($('#vault-password').value !== $('#vault-password2').value) throw new Problem('비밀번호 확인이 일치하지 않습니다');
    }
    await connect(session);
    if ($('#remember').checked) await saveVault(session, $('#vault-password').value);
    $('#token').value = $('#vault-password').value = $('#vault-password2').value = '';
  });
};
$('#unlock-form').onsubmit = event => {
  event.preventDefault();
  withButton($('#unlock-form'), async () => {
    await connect(await openVault($('#unlock-password').value));
    $('#unlock-password').value = '';
  });
};
$('#forget').onclick = () => {
  if (!confirm('이 PC에 저장된 연결 정보를 지울까요? 다음에는 토큰을 다시 입력해야 합니다.')) return;
  localStorage.removeItem(VAULT_KEY);
  showLogin();
};
$('#logout').onclick = () => {
  if (dirty && !confirm('저장하지 않은 변경이 있습니다. 로그아웃할까요?')) return;
  dirty = false;
  sessionStorage.removeItem(SESSION_KEY);
  location.reload();
};

(async () => {
  $('#site-repo').value = DEFAULT_SITE;
  $('#data-repo').value = DEFAULT_DATA;
  const session = readJson(sessionStorage, SESSION_KEY);
  if (!session) { showLogin(); return; }
  $('#login').hidden = true;
  try { await connect(session); } catch (e) { showLogin(e.message); }
})();
