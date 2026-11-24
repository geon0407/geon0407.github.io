// Browser Blog Studio — data layer.
// Everything goes through the GitHub REST API with the user's own token:
//   site repo  (public, e.g. geon0407/geon0407.github.io): published posts, settings, uploads
//   data repo  (private, e.g. geon0407/blog-studio-data):  drafts/, uploads/, trash/, pending.json
// pending.json holds saved-but-unpublished changes to the site repo; "publish" turns them
// into one commit on the site repo, exactly like the Codespaces Studio's pending list.
import yaml from 'js-yaml';

export const CONFIG = 'site/_data/studio.yml';
export const CATEGORIES = 'site/_data/blog_categories.yml';
export const UPLOAD_LIMIT = 20 * 1024 * 1024;
export const VIDEO_LIMIT = 50 * 1024 * 1024;
const VIDEO_EXTENSIONS = ['.mp4', '.webm'];
export const EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.pdf', '.txt', '.csv', '.zip', '.docx', '.xlsx', '.pptx', ...VIDEO_EXTENSIONS];
const UPLOAD_REF = /\/uploads\/(\d{4}\/\d{2}\/[A-Za-z0-9_-]+\.[a-z0-9]+)/g;
const UPLOAD_NAME = /^\d{4}\/\d{2}\/[A-Za-z0-9_-]+\.[a-z0-9]+$/;
const RECORD_PATH = /^site\/collections\/_(posts|projects)\/[A-Za-z0-9_.-]+\.md$/;
const DRAFT_ID = /^draft-[0-9a-f]{24}$/;
const TRASH_ID = /^\d{8}-\d{6}-[0-9a-f]{8}$/;

export class Problem extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// ------------------------------------------------------------------ encoding helpers

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToBytes(b64) {
  const s = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
export const textToB64 = text => bytesToB64(encoder.encode(text));
export const b64ToText = b64 => decoder.decode(b64ToBytes(b64));
const byteLength = text => encoder.encode(text).length;

export function hex(bytes) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, b => b.toString(16).padStart(2, '0')).join('');
}
// Small non-cryptographic hash, used only to notice edits made in another tab/PC.
export function hash(text) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
function stamp(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}-${hex(4)}`;
}
function localIso(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}
const clone = x => JSON.parse(JSON.stringify(x));

// YAML: read without turning dates into Date objects; write quoting anything ambiguous (like PyYAML).
export const loadYaml = text => yaml.load(text, {schema: yaml.CORE_SCHEMA});
export const dumpYaml = data => yaml.dump(data, {lineWidth: -1, noRefs: true, noArrayIndent: true, quotingType: "'", schema: yaml.DEFAULT_SCHEMA});

export function splitDoc(text) {
  const parts = text.split('---');
  if (parts.length < 3 || parts[0].trim()) throw new Problem('이 파일의 YAML 머리말을 읽을 수 없습니다');
  const meta = loadYaml(parts[1]) || {};
  return [meta, parts.slice(2).join('---').replace(/^[\r\n]+/, '')];
}

// ------------------------------------------------------------------ GitHub client

function githubMessage(status, data) {
  if (status === 401) return 'GitHub 토큰이 맞지 않거나 만료됐습니다. 토큰을 다시 입력하세요';
  if (status === 403 && /rate limit/i.test(data?.message || '')) return 'GitHub API 사용 한도를 넘었습니다. 잠시 후 다시 시도하세요';
  if (status === 403) return '이 토큰에 저장소 쓰기 권한이 없습니다. 토큰의 Contents 권한을 Read and write로 설정하세요';
  if (status === 404) return '저장소를 찾을 수 없습니다. 저장소 이름과 토큰의 저장소 접근 범위를 확인하세요';
  return `GitHub 요청 실패 (${status}): ${data?.message || ''}`;
}

export class GitHub {
  constructor({token, repo, fetch: fetchImpl}) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Problem('저장소는 owner/name 형식으로 입력하세요');
    this.token = token;
    this.repo = repo;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.blobs = new Map();
    this.branch = 'main';
  }
  async api(method, path, body, {anonymous = false} = {}) {
    const response = await this.fetch('https://api.github.com' + path, {
      method,
      cache: 'no-store',
      headers: {
        ...(anonymous ? {} : {Authorization: `Bearer ${this.token}`}),
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? {'Content-Type': 'application/json'} : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Problem(githubMessage(response.status, data), response.status);
    return data;
  }
  path(p = '') { return `/repos/${this.repo}${p}`; }
  // Actions data. The token only has Contents permission; for a public repo the same
  // data is readable without a token, so fall back to an anonymous request.
  async actions(p) {
    try {
      return await this.api('GET', this.path('/actions' + p));
    } catch (e) {
      if (e.status !== 403 && e.status !== 404) throw e;
      return this.api('GET', this.path('/actions' + p), undefined, {anonymous: true});
    }
  }
  async info() {
    const info = await this.api('GET', this.path());
    this.branch = info.default_branch || 'main';
    return info;
  }
  async head() {
    try {
      return (await this.api('GET', this.path(`/git/ref/heads/${encodeURIComponent(this.branch)}`))).object.sha;
    } catch (e) {
      if (e.status === 404 || e.status === 409) return null;  // empty repository
      throw e;
    }
  }
  async initialize() {
    await this.api('PUT', this.path('/contents/README.md'), {
      message: 'Initialize Blog Studio data',
      content: textToB64('# Blog Studio data\n\n비공개 초안·첨부파일·휴지통을 보관하는 저장소입니다. 공개하지 마세요.\n'),
    });
  }
  async tree(commitSha) {
    const commit = await this.api('GET', this.path(`/git/commits/${commitSha}`));
    const tree = await this.api('GET', this.path(`/git/trees/${commit.tree.sha}?recursive=1`));
    if (tree.truncated) throw new Problem('저장소 파일이 너무 많아 목록을 다 읽지 못했습니다', 500);
    const files = {};
    for (const entry of tree.tree) if (entry.type === 'blob') files[entry.path] = {sha: entry.sha, size: entry.size};
    return {treeSha: commit.tree.sha, files};
  }
  async blob(sha) {
    if (!this.blobs.has(sha)) {
      const promise = this.api('GET', this.path(`/git/blobs/${sha}`)).then(b => b.content.replace(/\s/g, ''));
      promise.catch(() => this.blobs.delete(sha));
      this.blobs.set(sha, promise);
    }
    return this.blobs.get(sha);
  }
  async createBlob(b64) {
    return (await this.api('POST', this.path('/git/blobs'), {content: b64, encoding: 'base64'})).sha;
  }
  async commit({base, baseTree, entries, message}) {
    const tree = await this.api('POST', this.path('/git/trees'), {base_tree: baseTree, tree: entries});
    const commit = await this.api('POST', this.path('/git/commits'), {message, tree: tree.sha, parents: [base]});
    try {
      await this.api('PATCH', this.path(`/git/refs/heads/${encodeURIComponent(this.branch)}`), {sha: commit.sha, force: false});
    } catch (e) {
      if (e.status === 422 || e.status === 409) throw new Problem('다른 곳(다른 탭·PC 또는 Codespace)에서 먼저 저장했습니다. 새로고침 후 다시 시도하세요', 409);
      throw e;
    }
    return {commit: commit.sha, tree: tree.sha};
  }
}

// ------------------------------------------------------------------ studio

export class Studio {
  constructor({site, data}) {
    this.site = site;   // GitHub (public blog repo)
    this.data = data;   // GitHub (private data repo)
  }

  async connect() {
    const [siteInfo, dataInfo] = await Promise.all([this.site.info(), this.data.info()]);
    if (!siteInfo.permissions?.push) throw new Problem(`${this.site.repo}에 쓰기 권한이 없습니다`, 403);
    if (!dataInfo.private) throw new Problem(`${this.data.repo}는 공개 저장소입니다. 초안이 공개되지 않도록 비공개(Private) 저장소를 지정하세요`, 400);
    if (!dataInfo.permissions?.push) throw new Problem(`${this.data.repo}에 쓰기 권한이 없습니다`, 403);
    if (!(await this.data.head())) await this.data.initialize();
    await this.reload();
  }

  async reload() {
    const [siteHead, dataHead] = await Promise.all([this.site.head(), this.data.head()]);
    if (!siteHead) throw new Problem('블로그 저장소가 비어 있습니다', 400);
    this.siteHead = siteHead;
    this.dataHead = dataHead;
    const [siteTree, dataTree] = await Promise.all([this.site.tree(siteHead), this.data.tree(dataHead)]);
    this.siteTree = siteTree.files;
    this.dataTreeSha = dataTree.treeSha;
    this.dataTree = dataTree.files;
    const pending = await this.dataText('pending.json');
    this.pending = pending ? JSON.parse(pending) : {writes: {}, deletes: {}, base: {}};
  }

  // ---------------------------------------------------------------- reading

  async dataText(path) {
    const entry = this.dataTree[path];
    return entry ? b64ToText(await this.data.blob(entry.sha)) : null;
  }
  async originalSiteText(path) {
    const entry = this.siteTree[path];
    return entry ? b64ToText(await this.site.blob(entry.sha)) : null;
  }
  // What the site will contain after the next publish.
  async siteText(path) {
    const write = this.pending.writes[path];
    if (write && 'text' in write) return write.text;
    if (write) return null;  // binary pending write; not readable as text
    if (this.pending.deletes[path]) return null;
    return this.originalSiteText(path);
  }
  siteExists(path) {
    if (this.pending.writes[path]) return true;
    if (this.pending.deletes[path]) return false;
    return Boolean(this.siteTree[path]);
  }
  sitePaths(prefix) {
    const paths = new Set(Object.keys(this.siteTree).filter(p => p.startsWith(prefix)));
    for (const p of Object.keys(this.pending.writes)) if (p.startsWith(prefix)) paths.add(p);
    for (const p of Object.keys(this.pending.deletes)) paths.delete(p);
    return [...paths].sort();
  }
  pendingPaths() {
    return [...new Set([...Object.keys(this.pending.writes), ...Object.keys(this.pending.deletes)])].sort();
  }

  // ---------------------------------------------------------------- writing

  // Run a change; if any step fails, forget the in-memory edits to pending.json.
  async mutate(fn) {
    const snapshot = clone(this.pending);
    try { return await fn(); } catch (e) { this.pending = snapshot; throw e; }
  }

  rememberBase(path) {
    if (!(path in this.pending.base)) this.pending.base[path] = this.siteTree[path]?.sha || null;
  }
  forget(path) {
    delete this.pending.writes[path];
    delete this.pending.deletes[path];
    delete this.pending.base[path];
  }
  async setSiteText(path, text) {
    if (text === await this.originalSiteText(path)) { this.forget(path); return; }
    this.rememberBase(path);
    delete this.pending.deletes[path];
    this.pending.writes[path] = {text};
  }
  setSiteFromData(path, dataPath) {
    this.rememberBase(path);
    delete this.pending.deletes[path];
    this.pending.writes[path] = {data: dataPath};
  }
  removeSite(path) {
    if (!this.siteTree[path]) { this.forget(path); return; }
    this.rememberBase(path);
    delete this.pending.writes[path];
    this.pending.deletes[path] = true;
  }

  // Commit `changes` (path -> text | {b64} | {sha} | null) plus pending.json to the data repo.
  async dataCommit(changes = {}, message = 'studio: update') {
    const all = {...changes, 'pending.json': JSON.stringify(this.pending, null, 1)};
    const entries = [], sizes = {};
    for (const [path, value] of Object.entries(all)) {
      if (value === null) {
        if (this.dataTree[path]) entries.push({path, mode: '100644', type: 'blob', sha: null});
        continue;
      }
      let sha;
      if (typeof value === 'string') { sha = await this.data.createBlob(textToB64(value)); sizes[path] = byteLength(value); }
      else if (value.b64) { sha = await this.data.createBlob(value.b64); sizes[path] = b64ToBytes(value.b64).length; }
      else { sha = value.sha; sizes[path] = value.size || 0; }
      entries.push({path, mode: '100644', type: 'blob', sha});
    }
    const result = await this.data.commit({base: this.dataHead, baseTree: this.dataTreeSha, entries, message});
    this.dataHead = result.commit;
    this.dataTreeSha = result.tree;
    for (const entry of entries) {
      if (entry.sha === null) delete this.dataTree[entry.path];
      else this.dataTree[entry.path] = {sha: entry.sha, size: sizes[entry.path]};
    }
  }

  // ---------------------------------------------------------------- categories & settings

  async categories() {
    const text = await this.siteText(CATEGORIES);
    const result = [];
    for (const group of (text ? loadYaml(text) : null) || []) {
      for (const topic of group.topics || []) {
        result.push({
          slug: topic.slug, title: topic.title || topic.slug, title_ko: topic.title_ko || topic.title || topic.slug,
          group: group.title || '', group_ko: group.title_ko || group.title || '',
        });
      }
    }
    return result;
  }

  async config() {
    const text = await this.siteText(CONFIG);
    return {config: loadYaml(text), version: hash(text)};
  }

  async saveConfig({config, version}) {
    return this.mutate(async () => {
      const current = await this.config();
      if (current.version !== version) throw new Problem('다른 탭 또는 작업에서 설정이 변경됐습니다. 새로고침 후 다시 저장하세요', 409);
      validateConfig(config, current.config);
      await this.setSiteText(CONFIG, dumpYaml(config));
      const general = loadYaml(await this.siteText('site/_data/general_settings.yml'));
      Object.assign(general, {title: config.site.title, description: config.site.description});
      await this.setSiteText('site/_data/general_settings.yml', dumpYaml(general));
      const author = loadYaml(await this.siteText('site/_data/author.yml'));
      Object.assign(author, {author_name: config.site.author, author_image: config.site.avatar});
      await this.setSiteText('site/_data/author.yml', dumpYaml(author));
      const social = loadYaml(await this.siteText('site/_data/social_links.yml'));
      for (const item of social.social || []) {
        for (const kind of ['linkedin', 'github', 'instagram']) {
          if ((item.icon || '').toLowerCase().includes(kind) || (item.link || '').toLowerCase().includes(kind)) item.link = config.site[kind];
        }
      }
      await this.setSiteText('site/_data/social_links.yml', dumpYaml(social));
      await this.dataCommit({}, 'studio: save site settings');
      return {version: (await this.config()).version};
    });
  }

  // ---------------------------------------------------------------- posts & projects

  async record(id) {
    if (DRAFT_ID.test(id)) {
      const text = await this.dataText(`drafts/${id}.json`);
      if (text === null) throw new Problem('글을 찾을 수 없습니다', 404);
      return {...JSON.parse(text), id, version: hash(text)};
    }
    if (!RECORD_PATH.test(id)) throw new Problem('허용되지 않은 글 경로입니다');
    const text = await this.siteText(id);
    if (text === null) throw new Problem('글을 찾을 수 없습니다', 404);
    const [meta, body] = splitDoc(text);
    return {kind: id.includes('/_posts/') ? 'post' : 'project', meta, body, draft: false, id, version: hash(text)};
  }

  async listRecords() {
    const ids = [
      ...this.sitePaths('site/collections/_posts/').filter(p => RECORD_PATH.test(p)),
      ...this.sitePaths('site/collections/_projects/').filter(p => RECORD_PATH.test(p)),
      ...Object.keys(this.dataTree).filter(p => /^drafts\/draft-[0-9a-f]{24}\.json$/.test(p)).map(p => p.slice(7, -5)),
    ];
    const records = await Promise.all(ids.map(id => this.record(id)));
    return records.sort((a, b) => String(b.meta.date || '').localeCompare(String(a.meta.date || '')));
  }

  async saveRecord(data) {
    return this.mutate(async () => {
      const kind = data.kind;
      let identifier = data.id || '';
      if (!['post', 'project'].includes(kind)) throw new Problem('글 종류가 잘못됐습니다');
      let old = null;
      if (identifier) {
        old = await this.record(identifier);
        if (old.version !== data.version) throw new Problem('다른 탭 또는 작업에서 글이 변경됐습니다. 목록을 다시 열어 최신 내용을 확인하세요', 409);
        if (old.kind !== kind) throw new Problem('기존 글 종류는 변경할 수 없습니다');
      }
      const meta = data.meta || {};
      text(meta.title || '', 300);
      if (!String(meta.title || '').trim()) throw new Problem('제목을 입력하세요');
      text(meta.description || '', 3000);
      text(meta.subtitle || '', 1000);
      url(meta.image || '');
      if (!/^\d{4}-\d{2}-\d{2}/.test(String(meta.date || '')) || Number.isNaN(Date.parse(String(meta.date).slice(0, 10)))) throw new Problem('날짜를 확인하세요');
      for (const key of ['tags', 'categories']) {
        const values = meta[key] || [];
        if (!Array.isArray(values) || values.length > 30) throw new Problem('태그 또는 카테고리를 확인하세요');
        values.forEach(v => text(v, 100));
      }
      const known = new Set((await this.categories()).map(c => c.slug));
      if ((meta.categories || []).some(v => !known.has(v))) throw new Problem('카테고리를 확인하세요');
      const body = text(data.body || '', 2_000_000);
      const draft = Boolean(data.draft);

      let sourceId = old?.source_id || '';
      if (draft && old && !old.draft) sourceId = identifier;

      const original = old ? {...old.meta} : {};
      for (const key of ['title', 'description', 'subtitle', 'image', 'date', 'tags', 'categories', 'lang']) {
        original[key] = meta[key] ?? (['tags', 'categories'].includes(key) ? [] : '');
      }
      if (kind === 'project') {
        // Shown on the project card: "2026.07 – 2026.08" or "2026.09 – Ongoing".
        for (const key of ['period_start', 'period_end']) {
          const value = text(String(meta[key] || ''), 7);
          if (value && !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Problem('기간은 YYYY-MM 형식으로 입력하세요');
          original[key] = value;
        }
        original.ongoing = Boolean(meta.ongoing);
        for (const key of ['card_title', 'card_subtitle']) original[key] = text(String(meta[key] || ''), 1000).trim();
        if (original.ongoing) original.period_end = '';
        if (original.period_start && original.period_end && original.period_end < original.period_start) throw new Problem('종료 연월이 시작 연월보다 빠릅니다');
      }
      Object.assign(original, {layout: kind, render_with_liquid: false});
      delete original.published;

      let slug = text(data.slug || '', 100).trim();
      let number = String(meta.studio_number ?? '').trim();
      const peers = (await this.listRecords()).filter(r => r.kind === kind && r.id !== identifier);
      const usedNumbers = new Set(peers.map(r => String(r.meta.studio_number)));
      if (number && !/^[1-9][0-9]{0,8}$/.test(number)) throw new Problem('번호는 1 이상 9자리 이하의 정수로 입력하세요');
      if (number && usedNumbers.has(number)) throw new Problem('같은 종류의 글에 이미 사용 중인 번호입니다', 409);
      if (!draft && !number) {
        let candidate = 1;
        while (usedNumbers.has(String(candidate))) candidate++;
        number = String(candidate);
      }
      if (number) original.studio_number = Number(number);
      else delete original.studio_number;

      if (draft) {
        if (!identifier.startsWith('draft-')) identifier = 'draft-' + hex(12);
        const changes = {[`drafts/${identifier}.json`]: JSON.stringify({kind, meta: original, body, draft: true, slug, source_id: sourceId})};
        if (old && !old.draft) this.removeSite(sourceId);
        await this.dataCommit(changes, 'studio: save draft');
        return this.record(identifier);
      }

      if (sourceId) {
        identifier = sourceId;
        if (this.siteExists(identifier)) throw new Problem('기존 주소의 파일이 이미 존재합니다', 409);
      } else if (!identifier || identifier.startsWith('draft-')) {
        if (!slug) slug = `${kind}-${number}`;
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Problem('주소는 영문 소문자·숫자·하이픈으로 입력하세요');
        const usedSlugs = new Set(peers.filter(p => !p.draft || p.source_id).map(p => publishedSlug(p, kind)));
        if (usedSlugs.has(slug)) throw new Problem('같은 주소의 글이 있습니다. 주소를 바꿔주세요', 409);
        const filename = (kind === 'post' ? String(original.date).slice(0, 10) + '-' : '') + slug + '.md';
        identifier = `site/collections/_${kind}s/${filename}`;
        if (this.siteExists(identifier)) throw new Problem('같은 주소의 글이 있습니다. 주소를 바꿔주세요', 409);
      }
      await this.setSiteText(identifier, '---\n' + dumpYaml(original) + '---\n\n' + body + (body.endsWith('\n') ? '' : '\n'));
      const changes = old?.draft ? {[`drafts/${old.id}.json`]: null} : {};
      await this.dataCommit(changes, 'studio: save post');
      return this.record(identifier);
    });
  }

  // ---------------------------------------------------------------- trash
  // trash/<id>.json: {type, title, draft, deleted_at, targets: [{where: site|data, path}], content?}
  // Uploads keep their bytes at trash/files/<id> (a tree entry, so git never drops the blob).

  async listTrash() {
    const ids = Object.keys(this.dataTree).filter(p => /^trash\/[^/]+\.json$/.test(p)).map(p => p.slice(6, -5)).sort().reverse();
    return Promise.all(ids.map(async id => {
      const entry = JSON.parse(await this.dataText(`trash/${id}.json`));
      const size = entry.type === 'file' ? (this.dataTree[`trash/files/${id}`]?.size || 0) : byteLength(entry.content || '');
      delete entry.content;
      return {...entry, id, size};
    }));
  }

  async archiveRecord({id, version}) {
    return this.mutate(async () => {
      const item = await this.record(id);
      if (item.version !== version) throw new Problem('다른 탭 또는 작업에서 글이 변경됐습니다. 목록을 다시 열어 최신 내용을 확인하세요', 409);
      const content = item.draft ? await this.dataText(`drafts/${id}.json`) : await this.siteText(id);
      const target = item.draft ? {where: 'data', path: `drafts/${id}.json`} : {where: 'site', path: id};
      const trashId = stamp();
      const changes = {[`trash/${trashId}.json`]: JSON.stringify({
        type: item.kind, title: item.meta.title || '', draft: item.draft, deleted_at: localIso(), targets: [target], content,
      })};
      if (item.draft) changes[`drafts/${id}.json`] = null;
      else this.removeSite(id);
      await this.dataCommit(changes, 'studio: move to trash');
      return {ok: true};
    });
  }

  trashId(id) {
    if (!TRASH_ID.test(id || '') || !this.dataTree[`trash/${id}.json`]) throw new Problem('휴지통 항목을 찾을 수 없습니다', 404);
    return id;
  }

  async restoreTrash({id}) {
    return this.mutate(async () => {
      this.trashId(id);
      const entry = JSON.parse(await this.dataText(`trash/${id}.json`));
      for (const target of entry.targets) {
        const exists = target.where === 'site' ? this.siteExists(target.path) : Boolean(this.dataTree[target.path]);
        if (exists) throw new Problem('같은 위치에 이미 파일이 있어 복구할 수 없습니다. 기존 글의 주소를 확인하세요', 409);
      }
      const changes = {[`trash/${id}.json`]: null};
      const file = this.dataTree[`trash/files/${id}`];
      for (const target of entry.targets) {
        if (entry.type === 'file') {
          if (target.where === 'data') changes[target.path] = {...file};
          else this.setSiteFromData(target.path, 'uploads/' + target.path.replace(/^site\/uploads\//, ''));
        } else if (target.where === 'data') changes[target.path] = entry.content;
        else await this.setSiteText(target.path, entry.content);
      }
      if (entry.type === 'file') {
        changes[`trash/files/${id}`] = null;
        // A public-only file comes back through the private copy, so make sure there is one.
        const rel = (entry.targets[0].path).replace(/^(site\/)?uploads\//, '');
        if (!changes['uploads/' + rel] && !this.dataTree['uploads/' + rel]) changes['uploads/' + rel] = {...file};
      }
      await this.dataCommit(changes, 'studio: restore from trash');
      return {ok: true, public: entry.targets.some(t => t.where === 'site')};
    });
  }

  async purgeTrash({id}) {
    return this.mutate(async () => {
      const ids = id === 'all' ? Object.keys(this.dataTree).filter(p => /^trash\/[^/]+\.json$/.test(p)).map(p => p.slice(6, -5)) : [this.trashId(id)];
      const changes = {};
      for (const each of ids) {
        changes[`trash/${each}.json`] = null;
        changes[`trash/files/${each}`] = null;
      }
      await this.dataCommit(changes, 'studio: empty trash');
      return {ok: true};
    });
  }

  // ---------------------------------------------------------------- uploads

  async upload({name, data}) {
    return this.mutate(async () => {
      const ext = (String(name).match(/\.[^.]+$/)?.[0] || '').toLowerCase();
      if (!EXTENSIONS.includes(ext)) throw new Problem('지원 파일: PNG/JPG/GIF/WebP/AVIF, MP4/WebM 동영상, PDF, TXT, CSV, ZIP, Office 문서');
      const size = b64ToBytes(data).length;
      if (VIDEO_EXTENSIONS.includes(ext)) {
        if (!size || size > VIDEO_LIMIT) throw new Problem('동영상은 50MB 이하여야 합니다. 긴 영상은 유튜브에 올려 넣어주세요');
      } else if (!size || size > UPLOAD_LIMIT) throw new Problem('파일은 20MB 이하여야 합니다');
      const now = new Date();
      const rel = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${hex(12)}${ext}`;
      await this.dataCommit({['uploads/' + rel]: {b64: data}}, 'studio: upload file');
      return {url: '/uploads/' + rel, name};
    });
  }

  // Text that may mention uploads: the published site's posts/data, drafts and trashed posts.
  async referenceTexts() {
    const sitePaths = [...this.sitePaths('site/collections/'), ...this.sitePaths('site/_data/')].filter(p => /\.(md|markdown|html|ya?ml|json)$/.test(p));
    const dataPaths = Object.keys(this.dataTree).filter(p => /^drafts\/.+\.json$/.test(p) || /^trash\/[^/]+\.json$/.test(p));
    return [
      ...await Promise.all(sitePaths.map(p => this.siteText(p))),
      ...await Promise.all(dataPaths.map(p => this.dataText(p))),
    ].filter(Boolean);
  }
  async uploadReferences() {
    const refs = new Set();
    for (const text of await this.referenceTexts()) for (const m of text.matchAll(UPLOAD_REF)) refs.add(m[1]);
    return refs;
  }
  async publicReferences() {
    const refs = new Set();
    const paths = [...this.sitePaths('site/collections/'), ...this.sitePaths('site/_data/')].filter(p => /\.(md|markdown|html|ya?ml|json)$/.test(p));
    for (const p of paths) {
      const t = await this.siteText(p);
      if (t) for (const m of t.matchAll(UPLOAD_REF)) refs.add(m[1]);
    }
    return refs;
  }

  async listUploads() {
    const refs = await this.uploadReferences();
    const files = new Map();
    const add = (rel, where, size) => {
      if (!UPLOAD_NAME.test(rel)) return;
      const item = files.get(rel) || {path: rel, url: '/uploads/' + rel, size, where: [], used: refs.has(rel)};
      item.where.push(where);
      files.set(rel, item);
    };
    for (const [p, e] of Object.entries(this.dataTree)) if (p.startsWith('uploads/')) add(p.slice(8), 'state', e.size);
    for (const p of this.sitePaths('site/uploads/')) add(p.slice(13), 'repo', this.siteTree[p]?.size || 0);
    return [...files.values()].sort((a, b) => b.path.localeCompare(a.path));
  }

  async deleteUpload({path: rel}) {
    return this.mutate(async () => {
      if (!UPLOAD_NAME.test(rel || '')) throw new Problem('파일 경로가 잘못됐습니다');
      if ((await this.uploadReferences()).has(rel)) throw new Problem('글이나 설정에서 사용 중인 파일은 삭제할 수 없습니다', 409);
      const targets = [];
      const dataEntry = this.dataTree['uploads/' + rel];
      if (dataEntry) targets.push({where: 'data', path: 'uploads/' + rel});
      if (this.siteExists('site/uploads/' + rel)) targets.push({where: 'site', path: 'site/uploads/' + rel});
      if (!targets.length) throw new Problem('파일을 찾을 수 없습니다', 404);
      const trashId = stamp();
      const changes = {[`trash/${trashId}.json`]: JSON.stringify({type: 'file', title: rel, draft: false, deleted_at: localIso(), targets})};
      if (dataEntry) {
        changes[`trash/files/${trashId}`] = {...dataEntry};
        changes['uploads/' + rel] = null;
      } else {
        const siteEntry = this.siteTree['site/uploads/' + rel];
        changes[`trash/files/${trashId}`] = {b64: await this.site.blob(siteEntry.sha)};
      }
      if (this.siteExists('site/uploads/' + rel)) this.removeSite('site/uploads/' + rel);
      await this.dataCommit(changes, 'studio: move file to trash');
      return {ok: true};
    });
  }

  // Bytes of an upload for display in the editor (private files are not on the public site yet).
  async uploadBytes(rel) {
    const entry = this.dataTree['uploads/' + rel];
    if (entry) return b64ToBytes(await this.data.blob(entry.sha));
    const siteEntry = this.siteTree['site/uploads/' + rel];
    if (siteEntry) return b64ToBytes(await this.site.blob(siteEntry.sha));
    return null;
  }

  // ---------------------------------------------------------------- publish

  async missingPublicAssets() {
    const missing = [];
    for (const rel of await this.publicReferences()) {
      if (this.dataTree['uploads/' + rel] && !this.siteExists('site/uploads/' + rel)) missing.push(rel);
    }
    return missing.sort();
  }

  async describe(path) {
    const match = path.match(/^site\/collections\/_(posts|projects)\/.+\.md$/);
    if (match) {
      const label = match[1] === 'posts' ? '게시글' : '프로젝트';
      const source = (await this.siteText(path)) ?? (await this.originalSiteText(path));
      try { return [label, String(splitDoc(source)[0].title || path.split('/').pop())]; } catch { return [label, path.split('/').pop()]; }
    }
    if (path.startsWith('site/uploads/')) return ['첨부파일', path.slice(13)];
    if (path.startsWith('site/_data/')) return ['사이트 설정', path.split('/').pop()];
    return ['파일', path];
  }

  async changes() {
    const items = [];
    for (const path of this.pendingPaths()) {
      const write = this.pending.writes[path];
      if (write && 'text' in write && write.text === await this.originalSiteText(path)) continue;
      if (!write && !this.siteTree[path]) continue;
      const status = !write ? 'deleted' : this.siteTree[path] ? 'modified' : 'added';
      const [label, title] = await this.describe(path);
      items.push({path, status, label, title});
    }
    for (const rel of await this.missingPublicAssets()) {
      items.push({path: 'site/uploads/' + rel, status: 'added', label: '첨부파일', title: rel});
    }
    const order = {'게시글': 0, '프로젝트': 1, '사이트 설정': 2, '첨부파일': 3, '파일': 4};
    return items.sort((a, b) => order[a.label] - order[b.label] || a.path.localeCompare(b.path));
  }

  async discard({path}) {
    return this.mutate(async () => {
      this.forget(path);
      await this.dataCommit({}, 'studio: discard change');
      return {ok: true};
    });
  }

  async publish() {
    return this.mutate(async () => {
      // Someone (another PC, the Codespaces Studio) may have pushed since we loaded.
      const head = await this.site.head();
      if (head !== this.siteHead) {
        const fresh = await this.site.tree(head);
        const conflicts = this.pendingPaths().filter(p => (fresh.files[p]?.sha || null) !== (this.pending.base[p] ?? this.siteTree[p]?.sha ?? null));
        if (conflicts.length) {
          throw new Problem('발행하지 않은 변경과 같은 파일이 다른 곳에서 먼저 바뀌었습니다. 발행 창에서 해당 항목을 버리고 다시 작성하세요:\n' + conflicts.join('\n'), 409);
        }
        this.siteHead = head;
        this.siteTree = fresh.files;
      }
      const items = await this.changes();
      if (!items.length) return {ok: true, message: '발행할 변경이 없습니다.'};
      const entries = [];
      for (const item of items) {
        const write = this.pending.writes[item.path];
        let sha = null;
        if (item.status !== 'deleted') {
          let b64;
          if (write && 'text' in write) b64 = textToB64(write.text);
          else {
            const dataPath = write?.data || 'uploads/' + item.path.slice(13);
            const entry = this.dataTree[dataPath];
            if (!entry) throw new Problem(`첨부파일을 찾을 수 없습니다: ${dataPath}`, 404);
            b64 = await this.data.blob(entry.sha);
          }
          sha = await this.site.createBlob(b64);
        }
        entries.push({path: item.path, mode: '100644', type: 'blob', sha});
      }
      const baseTree = (await this.site.api('GET', this.site.path(`/git/commits/${this.siteHead}`))).tree.sha;
      const message = commitMessage(items);
      const result = await this.site.commit({base: this.siteHead, baseTree, entries, message});
      // Remembered (in the private repo) so a failed deploy is still shown after closing the tab.
      this.pending = {writes: {}, deletes: {}, base: {}, last_publish: {sha: result.commit, at: localIso(), summary: message.split('\n')[0]}};
      await this.dataCommit({}, 'studio: published');
      await this.reload();
      return {ok: true, message: 'GitHub에 발행했습니다. 배포 결과를 확인하는 중입니다.'};
    });
  }

  // Result of the GitHub Actions deploy for the last publish made from the web Studio.
  //   state: running | success | failure | unknown
  async deployStatus() {
    const last = this.pending.last_publish;
    if (!last) return null;
    const base = {sha: last.sha, at: last.at, summary: last.summary, url: `https://github.com/${this.site.repo}/actions`};
    let runs;
    try {
      runs = (await this.site.actions(`/runs?head_sha=${last.sha}&per_page=10`)).workflow_runs || [];
    } catch (e) {
      return {...base, state: 'unknown', detail: '배포 상태를 읽지 못했습니다: ' + e.message};
    }
    if (!runs.length) {
      const minutes = (Date.now() - Date.parse(last.at)) / 60000;
      return {...base, state: minutes < 10 ? 'running' : 'unknown', detail: minutes < 10 ? '배포 대기 중' : '이 발행에 대한 배포 기록을 찾지 못했습니다'};
    }
    const run = runs[0];
    const result = {...base, url: run.html_url || base.url};
    if (run.status !== 'completed') return {...result, state: 'running', detail: '배포 중'};
    if (run.conclusion === 'success') return {...result, state: 'success', detail: '배포 완료'};
    let detail = `배포 ${run.conclusion === 'cancelled' ? '취소' : '실패'}`;
    try {
      const jobs = (await this.site.actions(`/runs/${run.id}/jobs`)).jobs || [];
      const job = jobs.find(j => j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'skipped');
      const step = job?.steps?.find(s => s.conclusion === 'failure');
      if (job) detail += ` · 단계: ${job.name}${step ? ' → ' + step.name : ''}`;
    } catch { /* the run link is enough */ }
    return {...result, state: 'failure', detail};
  }
}

function publishedSlug(peer, kind) {
  let stem = (peer.source_id || peer.id).split('/').pop().replace(/\.md$/, '');
  if (kind === 'post') stem = stem.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  return String(peer.meta.slug || stem);
}

export function commitMessage(items) {
  const verbs = {added: 'add', modified: 'update', deleted: 'remove'};
  const parts = [];
  for (const item of items) {
    if (item.label === '게시글' || item.label === '프로젝트') {
      const title = item.title.length <= 40 ? item.title : item.title.slice(0, 39) + '…';
      parts.push(`${verbs[item.status]} ${item.label === '게시글' ? 'post' : 'project'} "${title}"`);
    }
  }
  if (items.some(i => i.label === '사이트 설정')) parts.push('update site settings');
  const files = items.filter(i => i.label === '첨부파일').length;
  if (files) parts.push(`${files} attachment${files > 1 ? 's' : ''}`);
  const subject = parts.slice(0, 3).join('; ') + (parts.length > 3 ? ` and ${parts.length - 3} more` : '');
  const body = items.map(i => `- ${verbs[i.status]}: ${i.path}`).join('\n');
  return `content(studio-web): ${subject || 'update blog content'}\n\n${body}`.trim();
}

// ------------------------------------------------------------------ validation

function text(value, maxlen = 5000) {
  if (typeof value !== 'string' || value.length > maxlen) throw new Problem('입력 길이 또는 형식을 확인하세요');
  return value;
}
function url(value) {
  text(value);
  const sitePath = value.startsWith('/') && !value.startsWith('//');
  if (value && !sitePath && !/^https?:\/\//i.test(value)) throw new Problem('주소는 /로 시작하는 사이트 경로 또는 https:// 주소여야 합니다');
  return value;
}

// Text that may contain Markdown links [label](url); refuse script links.
function richText(value, maxlen = 5000) {
  text(value, maxlen);
  if (/\]\(\s*(javascript|data|vbscript):/i.test(value)) throw new Problem('링크 주소는 https:// 또는 /로 시작해야 합니다');
  return value;
}

export function validateConfig(data, current) {
  const shape = (value, sample, key = '') => {
    if (key === 'news') {
      if (!Array.isArray(value) || value.length > 200) throw new Problem('뉴스는 200개 이하로 입력하세요');
      for (const entry of value) {
        if (!entry || typeof entry !== 'object' || Object.keys(entry).some(k => !['date', 'emoji', 'text', 'text_ko'].includes(k))) throw new Problem('뉴스 형식이 잘못됐습니다');
        Object.values(entry).forEach(v => richText(v, 2000));
        if ((entry.emoji || '').length > 16) throw new Problem('뉴스 이모지는 한두 글자로 입력하세요');
        if (!entry.text && !entry.text_ko) throw new Problem('뉴스 내용을 입력하세요');
      }
      return;
    }
    if (key === 'timeline') {
      if (!Array.isArray(value) || value.length > 100) throw new Problem('연혁은 100개 이하로 입력하세요');
      const allowed = new Set(['period', 'period_ko', 'title', 'title_ko', 'detail', 'detail_ko', 'url', 'group']);
      for (const entry of value) {
        if (!entry || typeof entry !== 'object' || Object.keys(entry).some(k => !allowed.has(k))) throw new Problem('연혁 형식이 잘못됐습니다');
        Object.values(entry).forEach(v => richText(v));
        if (!entry.title || !entry.title_ko) throw new Problem('연혁 제목은 한국어와 영어를 입력하세요');
        if (!['background', 'research'].includes(entry.group ?? 'research')) throw new Problem('연혁 구분이 잘못됐습니다');
        url(entry.url || '');
      }
      return;
    }
    if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
      const keys = Object.keys(sample).sort().join(), given = value && typeof value === 'object' ? Object.keys(value).sort().join() : null;
      if (keys !== given) throw new Problem('설정 항목이 변경됐습니다. 새로고침 후 다시 저장하세요');
      for (const k of Object.keys(sample)) shape(value[k], sample[k], k);
    } else if (typeof sample === 'boolean') {
      if (typeof value !== 'boolean') throw new Problem('표시 옵션을 확인하세요');
    } else if (typeof sample === 'number') {
      if (typeof value !== 'number' || Number.isNaN(value)) throw new Problem('숫자를 입력하세요');
    } else text(value ?? '');
  };
  shape(data, current);
  const design = data.design;
  for (const mode of ['light', 'dark']) {
    for (const color of Object.values(design.colors[mode])) if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Problem('색상은 #RRGGBB 형식이어야 합니다');
  }
  const ranges = {body_size: [16, 22], line_height: [1.4, 2], width: [960, 1440], radius: [0, 32], section_gap: [24, 120], columns: [1, 3]};
  for (const [key, [lo, hi]] of Object.entries(ranges)) if (!(lo <= design[key] && design[key] <= hi)) throw new Problem(`${key} 범위는 ${lo}~${hi}입니다`);
  if (![1, 2, 3].includes(design.columns)) throw new Problem('열 수는 1, 2, 3 중 선택하세요');
  const email = String(data.profile.contact.email || '').trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Problem('이메일 주소 형식을 확인하세요');
  const cv = data.profile.contact.cv;
  url(cv.path || '');
  if (cv.path && !/\.pdf$/i.test(cv.path)) throw new Problem('CV는 PDF 파일만 연결할 수 있습니다');
  if (cv.updated && !/^\d{4}-\d{2}-\d{2}$/.test(cv.updated)) throw new Problem('CV 업데이트 날짜를 확인하세요');
  if (!['projects-first', 'posts-first'].includes(data.home.order)) throw new Problem('섹션 순서를 확인하세요');
  for (const v of [data.home.image, data.profile.portrait.path, data.profile.feature_photo.path, data.site.avatar, data.site.linkedin, data.site.github, data.site.instagram]) url(v || '');
  return data;
}
