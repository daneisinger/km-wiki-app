// km-wiki core: everything that talks to GitHub or understands the wiki's file formats.
//
// No DOM, no browser-only APIs beyond fetch, atob/btoa and TextEncoder/TextDecoder,
// so this file can be imported unchanged by the web app and by a React Native
// (Supernote) plugin. All screens and rendering live elsewhere.

export const today = () => new Date().toISOString().slice(0, 10);

// ---------- text helpers ----------

export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function splitFrontMatter(text) {
  if (!text.startsWith('---\n')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 4);
  if (end < 0) return { meta: {}, body: text };
  const meta = {};
  for (const line of text.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, body: text.slice(end + 4).replace(/^\n+/, '') };
}

/** Resolve a relative link found in `fromPath` to a repo path. */
export function resolvePath(fromPath, link) {
  const parts = fromPath.split('/').slice(0, -1);
  for (const seg of link.split('#')[0].split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

// ---------- GitHub ----------

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class Repo {
  /** @param {{owner:string, repo:string, branch?:string, token:string, apiBase?:string}} cfg */
  constructor(cfg) {
    this.cfg = { branch: 'master', apiBase: 'https://api.github.com', ...cfg };
    this.files = null;      // path -> blob sha
    this.treeAt = 0;
    this.cache = new Map(); // blob sha -> text
  }

  get base() {
    return `${this.cfg.apiBase.replace(/\/$/, '')}/repos/${this.cfg.owner}/${this.cfg.repo}`;
  }

  async request(path, { method = 'GET', body, raw = false } = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (!res.ok) {
      let msg = `${res.status}`;
      try { msg = (await res.json()).message || msg; } catch { /* not JSON */ }
      const hint = res.status === 401 ? 'The access token was rejected.'
        : res.status === 404 ? 'Not found. Check the owner, repo and branch, and that the token can read this repo.'
        : res.status === 403 ? 'Not allowed. The token may lack Contents read and write permission.'
        : res.status === 409 || res.status === 422 ? 'The file changed on GitHub in the meantime.' : '';
      throw new GitHubError(res.status, `${hint} (${msg})`.trim());
    }
    return res;
  }

  /** List every file in the repo. Cached for a few seconds unless `force`. */
  async tree(force = false) {
    if (!force && this.files && Date.now() - this.treeAt < 8000) return this.files;
    const res = await this.request(`/git/trees/${encodeURIComponent(this.cfg.branch)}?recursive=1`);
    const data = await res.json();
    this.files = new Map(data.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
    this.treeAt = Date.now();
    return this.files;
  }

  async exists(path) {
    return (await this.tree()).has(path);
  }

  async list(prefix) {
    return [...(await this.tree()).keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  url(path) {
    return `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(this.cfg.branch)}`;
  }

  /** Text of a file, or null if it does not exist. Cached by content hash. */
  async text(path) {
    const sha = (await this.tree()).get(path);
    if (!sha) return null;
    if (this.cache.has(sha)) return this.cache.get(sha);
    const text = await (await this.request(this.url(path), { raw: true })).text();
    this.cache.set(sha, text);
    return text;
  }

  /** Raw fetch Response for a binary file (an image). */
  async raw(path) {
    return this.request(this.url(path), { raw: true });
  }

  /** Create or replace a file. `content` is base64. Returns the new blob sha. */
  async put(path, contentBase64, message, sha) {
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await this.request(`/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
          method: 'PUT',
          body: { message, content: contentBase64, branch: this.cfg.branch, ...(sha ? { sha } : {}) },
        });
        break;
      } catch (e) {
        // A new file can be refused for a moment while another commit (the workflow, or the
        // previous request) is landing on the branch. That is safe to try again.
        if (sha || attempt >= 3 || !(e instanceof GitHubError) || e.status !== 409) throw e;
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      }
    }
    const data = await res.json();
    const newSha = data.content && data.content.sha;
    if (this.files && newSha) this.files.set(path, newSha);
    return newSha;
  }

  /**
   * Read a text file fresh, change it, and write it back. Retries once if someone
   * else (the ingest workflow, another device) changed the file in between.
   * `change(text)` returns the new text, or null to do nothing.
   */
  async edit(path, message, change) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const meta = await (await this.request(this.url(path))).json();
      const before = fromBase64(meta.content);
      const after = change(before);
      if (after == null || after === before) return before;
      try {
        const sha = await this.put(path, toBase64(after), message, meta.sha);
        if (sha) this.cache.set(sha, after);
        return after;
      } catch (e) {
        if (attempt === 1 || !(e instanceof GitHubError) || ![409, 422].includes(e.status)) throw e;
      }
    }
    return null;
  }
}

// ---------- registry ----------

export function parseRegistry(yaml) {
  const out = [];
  for (const block of yaml.split(/^\s*- slug:/m).slice(1)) {
    const clean = block.replace(/\s+#.*$/gm, '');
    const name = clean.match(/^\s*name:\s*(.+)$/m);
    const aliases = clean.match(/^\s*aliases:\s*(\[.*\])\s*$/m);
    const status = clean.match(/^\s*status:\s*(.+)$/m);
    let list = [];
    try { list = aliases ? JSON.parse(aliases[1]) : []; } catch { /* leave empty */ }
    const slug = clean.trim().split(/\s+/)[0];
    out.push({ slug, name: name ? name[1].trim().replace(/^"|"$/g, '') : slug, aliases: list, status: status ? status[1].trim() : '' });
  }
  return out;
}

// ---------- tasks ----------

const TASK = /^(\s*)- \[([ xX?\-])\] (?:\*\*(T-\d+)\*\*\s*)?(.*)$/;

/** Parse tasks.md into groups of tasks. */
export function parseTasks(md) {
  const { body } = splitFrontMatter(md || '');
  const groups = [];
  let group = null;
  for (const line of body.split('\n')) {
    const h = line.match(/^## (.+)$/);
    if (h) { group = { name: h[1].trim(), tasks: [] }; groups.push(group); continue; }
    const m = line.match(TASK);
    if (!m) continue;
    if (!group) { group = { name: 'Tasks', tasks: [] }; groups.push(group); }
    let rest = m[4];
    const tag = (name) => { const t = rest.match(new RegExp(`\\{${name}: ([^}]+)\\}`)); return t ? t[1].trim() : null; };
    const task = {
      id: m[3] || null,
      state: { ' ': 'open', x: 'done', X: 'done', '?': 'question', '-': 'dropped' }[m[2]],
      depth: Math.floor(m[1].length / 2),
      added: tag('added'), due: tag('due'), done: tag('done'),
      focus: /\{focus\}/.test(rest), attention: /\{attention\}/.test(rest),
      sources: [...rest.matchAll(/\[src\]\(([^)]+)\)/g)].map((x) => x[1]),
    };
    task.text = rest.replace(/\{[^}]*\}/g, '').replace(/\s*\[src\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
    group.tasks.push(task);
  }
  return groups.filter((g) => g.tasks.length);
}

export function countTasks(groups) {
  const c = { open: 0, done: 0, question: 0, dropped: 0 };
  for (const g of groups) for (const t of g.tasks) c[t.state]++;
  return c;
}

/** Return tasks.md with task `id` ticked (done=true) or reopened. Null if the task is not found. */
export function setTaskDone(md, id, done, date = today()) {
  const lines = md.split('\n');
  const i = lines.findIndex((l) => l.includes(`**${id}**`) && TASK.test(l));
  if (i < 0) return null;
  let line = lines[i].replace(/\s*\{done: [^}]*\}/, '');
  line = line.replace(/^(\s*- )\[[ xX?\-]\]/, `$1[${done ? 'x' : ' '}]`);
  if (done) {
    const at = line.search(/\s*\[src\]\(/);
    const tag = ` {done: ${date}}`;
    line = at >= 0 ? line.slice(0, at) + tag + line.slice(at) : line + tag;
  }
  lines[i] = line;
  return lines.join('\n');
}

// ---------- questions ----------

/**
 * Open questions from questions.md, each classified so a screen can offer the right control:
 *   project  - "Which project does X belong to?"  -> pick a project
 *   unknown  - lines for a project that does not exist -> create it, or ignore the lines
 *   decision - an inferred decision to confirm     -> yes / no, with a reason
 *   text     - anything else                        -> free text
 */
export function parseQuestions(md) {
  const { body } = splitFrontMatter(md || '');
  const start = body.indexOf('## Open');
  if (start < 0) return [];
  let open = body.slice(start + 7);
  const next = open.indexOf('\n## ');
  if (next >= 0) open = open.slice(0, next);
  const out = [];
  for (const chunk of open.split(/^(?=\d+\. )/m)) {
    const m = chunk.match(/^(\d+)\.\s+([\s\S]*\S)/);
    if (!m) continue;
    const raw = m[2].replace(/\s+/g, ' ');
    const note = (raw.match(/\(\.\.\/raw\/([^/]+)\//) || [])[1] || null;
    const q = { n: Number(m[1]), raw, note, kind: 'text' };
    q.project = (raw.match(/\]\(projects\/([^/)]+)\//) || [])[1] || null;
    q.text = raw.replace(/\s*\[(src|project)\]\([^)]*\)/g, '').replace(/\s*To (create it|file the whole note)[^`]*`[^`]*`\.?.*$/, '').trim();
    const unknown = raw.match(/has lines for "([^"]+)", which is not a known project/);
    const decision = raw.match(/\[decision\]\(([^)]+)\)/);
    const loose = raw.match(/has lines with no clear project \(([^)]+)\)/);
    if (loose) {
      q.kind = 'loose';
      q.label = loose[1];
      q.guess = (raw.match(/Best guess: ([^.]+)\./) || [])[1] || null;
      q.text = q.text.replace(/ \(group \d+\)/, '').replace(/\s*Best guess: [^.]+\./, '');
    } else if (/^Which project does /.test(raw)) {
      q.kind = 'project';
      q.guess = (raw.match(/Best guess: ([^.]+)\./) || [])[1] || null;
    } else if (unknown) {
      q.kind = 'unknown';
      q.label = unknown[1];
      q.number = (unknown[1].match(/\d{3,}/) || [])[0] || '';
      q.name = unknown[1].replace(/\d{3,}/, '').replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '');
    } else if (decision) {
      q.kind = 'decision';
      q.decision = 'wiki/' + decision[1];
      q.text = q.text.replace(/\s*\[decision\]\([^)]*\)/, '').trim();
    }
    out.push(q);
  }
  return out;
}

// ---------- writes that go through the ingest workflow ----------

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/** Where the request about a given question line is kept until the workflow applies it. */
export function requestPath(question) {
  let hash = 0x811c9dc5;
  for (const ch of new TextEncoder().encode(question)) hash = Math.imul(hash ^ ch, 0x01000193) >>> 0;
  return `inbox/requests/q-${hash.toString(16).padStart(8, '0')}.json`;
}

/** Queue a request for the ingest workflow. Returns the path it was written to. */
export async function sendRequest(repo, request) {
  // A request about a question always gets the same file name, so sending it twice
  // (a double tap, a second device, coming back to the page) cannot queue it twice.
  const path = request.question ? requestPath(request.question)
    : `inbox/requests/${stamp()}-${Math.random().toString(36).slice(2, 6)}.json`;
  if (request.question && (await repo.tree(true)).has(path)) return path;
  await repo.put(path, toBase64(JSON.stringify({ ...request, sent: new Date().toISOString() }, null, 1)), `Request: ${request.type}`);
  return path;
}

export const answerQuestion = (repo, q, choice, answer) =>
  sendRequest(repo, { type: 'answer', question: q.raw, choice: choice || '', answer: answer || '' });

export const fileNote = (repo, q, slug) =>
  sendRequest(repo, { type: 'file', question: q.raw, note: q.note, slug, ...(q.kind === 'loose' ? { label: q.label } : {}) });

export const createProject = (repo, { name, aliases, desc }, q) =>
  sendRequest(repo, { type: 'new-project', question: q ? q.raw : '', name, aliases: aliases || [], desc: desc || '' });

/** File lines of one note under different projects: `lines` is [{text, to}] where `to` is a slug, 'ignore' or 'new:<name>'. */
export const assignLines = (repo, q, lines, projects) =>
  sendRequest(repo, { type: 'assign', question: q.raw, note: q.note, label: q.label, lines, projects: projects || [] });

export const dismissLines = (repo, q) =>
  sendRequest(repo, { type: 'dismiss', question: q.raw, note: q.note, label: q.label });

/**
 * Add a note to the inbox. `base64` is the file content. A caption, if given, is written
 * first as a sidecar file so it is already there when the note itself triggers ingest.
 */
export async function uploadNote(repo, { name, base64, project, caption }) {
  let clean = name.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '') || 'note';
  if (!/20\d{2}[-_]?\d{2}[-_]?\d{2}/.test(clean)) {
    const s = stamp();
    clean = `${s.slice(0, 8)}_${s.slice(8)}_${clean}`;
  }
  const path = `inbox/${project ? project + '/' : ''}${clean}`;
  if (caption && caption.trim()) {
    await repo.put(`${path}.json`, toBase64(JSON.stringify({ caption: caption.trim() })), `Caption for ${clean}`);
  }
  await repo.put(path, base64, `Add note ${clean}`);
  return path;
}

/** Tick or reopen a task directly (no workflow round trip needed). */
export const toggleTask = (repo, slug, id, done) =>
  repo.edit(`wiki/projects/${slug}/tasks.md`, `${done ? 'Complete' : 'Reopen'} ${id} (${slug})`, (md) => setTaskDone(md, id, done));

// ---------- loading pages ----------

/** Everything a home screen needs. */
export async function loadOverview(repo) {
  const [yaml, questions, inbox] = await Promise.all([
    repo.text('wiki/projects.yaml'), repo.text('wiki/questions.md'), repo.text('wiki/inbox.md'),
  ]);
  const projects = parseRegistry(yaml || '');
  await Promise.all(projects.map(async (p) => {
    p.counts = countTasks(parseTasks(await repo.text(`wiki/projects/${p.slug}/tasks.md`)));
  }));
  const waiting = ((inbox || '').split('\n## ')[0].match(/^- .*\]\(\.\.\/raw\//gm) || []).length;
  const pending = (await repo.list('inbox/')).filter((p) => !p.endsWith('README.txt'));
  return { projects, questions: parseQuestions(questions), inboxCount: waiting, pending };
}

/**
 * What a question card needs to show the note it is about without leaving the page:
 * the note's title, its page images (repo paths), its transcription, and any lines
 * still waiting for an unknown project.
 */
export async function loadNote(repo, id) {
  const dir = `raw/${id}/`;
  const md = await repo.text(dir + 'source.md');
  if (md == null) return null;
  const { meta, body } = splitFrontMatter(md);
  const images = [...body.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => resolvePath(dir + 'source.md', m[1]));
  let waiting = [];
  try { waiting = JSON.parse((await repo.text(dir + 'ingest.json')) || '{}').waiting || []; } catch { /* no record */ }
  return {
    id, meta, title: titleOf(md, id), images: [...new Set(images)], waiting,
    transcription: body.replace(/^# .*\n/, '').replace(/^!\[[^\]]*\]\([^)]*\)\s*$/gm, '').trim(),
  };
}

/** A project page without its generated task section and page list. */
export function projectBody(md) {
  const { meta, body } = splitFrontMatter(md || '');
  const clean = body.replace(/<!-- tasks:start -->[\s\S]*?<!-- tasks:end -->\n*/, '').split(/^## Pages\s*$/m)[0].trim();
  return { meta, body: clean };
}

/** Title of a markdown file: its first heading. */
export function titleOf(md, fallback = '') {
  const m = splitFrontMatter(md || '').body.match(/^# (.+)$/m);
  return m ? m[1].trim() : fallback;
}
