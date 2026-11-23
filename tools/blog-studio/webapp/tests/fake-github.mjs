// In-memory fake of the parts of the GitHub REST API the web Studio uses.
import {createHash} from 'node:crypto';

export class FakeRepo {
  constructor({isPrivate = false, files = null} = {}) {
    this.isPrivate = isPrivate;
    this.blobs = new Map(); this.trees = new Map(); this.commits = new Map();
    this.ref = null;
    this.calls = 0;
    this.runs = [];            // fake GitHub Actions runs: {id, head_sha, status, conclusion}
    this.jobs = {};            // run id -> jobs
    this.actionsNeedNoToken = false;  // like a token without Actions permission
    if (files) {
      const tree = {};
      for (const [path, text] of Object.entries(files)) tree[path] = this.addBlob(Buffer.from(text).toString('base64'));
      this.ref = this.addCommit(this.addTree(tree), []);
    }
  }
  sha(kind, data) { return createHash('sha1').update(kind + JSON.stringify(data) + Math.random()).digest('hex'); }
  addBlob(b64) { const sha = createHash('sha1').update(b64).digest('hex'); this.blobs.set(sha, b64); return sha; }
  addTree(map) { const sha = this.sha('tree', map); this.trees.set(sha, {...map}); return sha; }
  addCommit(tree, parents) { const sha = this.sha('commit', tree); this.commits.set(sha, {tree, parents}); return sha; }
  files() {
    const tree = this.trees.get(this.commits.get(this.ref).tree);
    return Object.fromEntries(Object.entries(tree).map(([p, s]) => [p, Buffer.from(this.blobs.get(s), 'base64')]));
  }
  text(path) { return this.files()[path]?.toString(); }
  // Simulate someone else committing (e.g. the Codespaces Studio).
  push(changes) {
    const tree = {...this.trees.get(this.commits.get(this.ref).tree)};
    for (const [p, t] of Object.entries(changes)) {
      if (t === null) delete tree[p]; else tree[p] = this.addBlob(Buffer.from(t).toString('base64'));
    }
    this.ref = this.addCommit(this.addTree(tree), [this.ref]);
  }
  handle(method, path, body, authorized = true) {
    this.calls++;
    if (path.startsWith('/actions/')) {
      if (this.actionsNeedNoToken && authorized) return [403, {message: 'Resource not accessible by personal access token'}];
      let a;
      if ((a = path.match(/^\/actions\/runs\?head_sha=(\w+)/))) return [200, {workflow_runs: this.runs.filter(r => r.head_sha === a[1]).map(r => ({...r, html_url: `https://github.com/run/${r.id}`}))}];
      if ((a = path.match(/^\/actions\/runs\/(\d+)\/jobs$/))) return [200, {jobs: this.jobs[a[1]] || []}];
    }
    const m = (re) => path.match(re);
    if (method === 'GET' && path === '') return [200, {default_branch: 'main', private: this.isPrivate, permissions: {push: true}}];
    if (method === 'GET' && path === '/git/ref/heads/main') return this.ref ? [200, {object: {sha: this.ref}}] : [409, {message: 'Git Repository is empty.'}];
    if (method === 'PUT' && path === '/contents/README.md') {
      this.ref = this.addCommit(this.addTree({'README.md': this.addBlob(body.content)}), []);
      return [201, {}];
    }
    let r;
    if (method === 'GET' && (r = m(/^\/git\/commits\/(\w+)$/))) return [200, {tree: {sha: this.commits.get(r[1]).tree}}];
    if (method === 'GET' && (r = m(/^\/git\/trees\/(\w+)\?recursive=1$/))) {
      const tree = this.trees.get(r[1]);
      return [200, {truncated: false, tree: Object.entries(tree).map(([p, sha]) => ({path: p, type: 'blob', sha, size: Buffer.from(this.blobs.get(sha), 'base64').length}))}];
    }
    if (method === 'GET' && (r = m(/^\/git\/blobs\/(\w+)$/))) return [200, {content: this.blobs.get(r[1]).replace(/(.{60})/g, '$1\n')}];
    if (method === 'POST' && path === '/git/blobs') return [201, {sha: this.addBlob(body.content)}];
    if (method === 'POST' && path === '/git/trees') {
      const tree = {...this.trees.get(body.base_tree)};
      for (const e of body.tree) {
        if (e.sha === null) {
          if (!(e.path in tree)) return [422, {message: `delete of missing ${e.path}`}];
          delete tree[e.path];
        } else {
          if (!this.blobs.has(e.sha)) return [422, {message: 'unknown blob'}];
          tree[e.path] = e.sha;
        }
      }
      return [201, {sha: this.addTree(tree)}];
    }
    if (method === 'POST' && path === '/git/commits') return [201, {sha: this.addCommit(body.tree, body.parents)}];
    if (method === 'PATCH' && path === '/git/refs/heads/main') {
      if (this.commits.get(body.sha).parents[0] !== this.ref) return [422, {message: 'Update is not a fast forward'}];
      this.ref = body.sha;
      return [200, {}];
    }
    return [404, {message: `unhandled ${method} ${path}`}];
  }
}

export function fakeFetch(repos) {
  return async (url, options) => {
    const match = url.match(/^https:\/\/api\.github\.com\/repos\/([\w.-]+\/[\w.-]+)(.*)$/);
    const repo = repos[match[1]];
    if (repo.delay) await new Promise(r => setTimeout(r, repo.delay));  // simulate a slow network
    const [status, data] = repo.handle(options.method, match[2], options.body ? JSON.parse(options.body) : undefined, Boolean(options.headers?.Authorization));
    return {status, ok: status < 300, json: async () => data};
  };
}

