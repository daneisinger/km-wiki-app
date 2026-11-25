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

// Every wiki entry is a topic of one of these kinds. Folders, files and request fields still say
// "project" for all kinds, so the iPhone Shortcut, the Supernote plugin and the Gmail script keep working.
export const KINDS = [['general', 'General'], ['project', 'Project'], ['profile', 'Profile']];
export const kindLabel = (kind) => (KINDS.find(([k]) => k === kind) || KINDS[1])[1];

export function parseRegistry(yaml) {
  const out = [];
  for (const block of yaml.split(/^\s*- slug:/m).slice(1)) {
    const clean = block.replace(/\s+#.*$/gm, '');
    const name = clean.match(/^\s*name:\s*(.+)$/m);
    const aliases = clean.match(/^\s*aliases:\s*(\[.*\])\s*$/m);
    const status = clean.match(/^\s*status:\s*(.+)$/m);
    const kind = (clean.match(/^\s*kind:\s*(\S+)/m) || [])[1];
    let list = [];
    try { list = aliases ? JSON.parse(aliases[1]) : []; } catch { /* leave empty */ }
    const slug = clean.trim().split(/\s+/)[0];
    out.push({ slug, name: name ? name[1].trim().replace(/^"|"$/g, '') : slug, aliases: list, status: status ? status[1].trim() : '',
      kind: KINDS.some(([k]) => k === kind) ? kind : 'project' });
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
      edited: tag('edited'), manual: /\{manual\}/.test(rest),
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

// ---------- editing tasks ----------
//
// Each function takes the text of tasks.md and returns the new text, so they can be used
// inside Repo.edit and tested without GitHub. A task line is laid out as:
//   - [ ] **T-012** text {tags} [src](link)

const indentOf = (line) => line.match(/^\s*/)[0].length;
const TAGS = /\{[^}]*\}/g;

function splitTaskLine(line) {
  const m = line.match(TASK);
  if (!m) return null;
  return {
    indent: m[1], mark: m[2] === 'X' ? 'x' : m[2], id: m[3] || null,
    text: m[4].replace(TAGS, '').replace(/\s*\[src\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim(),
    tags: m[4].match(TAGS) || [],
    srcs: m[4].match(/\[src\]\([^)]*\)/g) || [],
  };
}

const joinTaskLine = (p) => `${p.indent}- [${p.mark}] ${p.id ? `**${p.id}** ` : ''}${[p.text, ...p.tags, ...p.srcs].join(' ')}`;

/** Set `{name: value}` (or `{name}` for true), or remove it for null or false. New tags go first or last. */
function setTag(tags, name, value, first = false) {
  const at = tags.findIndex((t) => new RegExp(`^\\{${name}(:|\\})`).test(t));
  const tag = value === true ? `{${name}}` : `{${name}: ${value}}`;
  if (value == null || value === false || value === '') { if (at >= 0) tags.splice(at, 1); }
  else if (at >= 0) tags[at] = tag;
  else if (first) tags.unshift(tag);
  else tags.push(tag);
}

/** Text typed by the owner, made safe to sit on one task line. */
export function cleanTaskText(text) {
  return String(text || '').replace(/[{]/g, '(').replace(/[}]/g, ')').replace(/\s+/g, ' ').trim();
}

const findTask = (lines, id) => lines.findIndex((l) => l.includes(`**${id}**`) && TASK.test(l));

/** The task's line and the nested lines under it: [start, end). */
function taskBlock(lines, i) {
  let end = i + 1;
  while (end < lines.length && lines[end].trim() && indentOf(lines[end]) > indentOf(lines[i])) end++;
  return [i, end];
}

/** Names of every group heading in tasks.md, in order, including groups with no tasks. */
export function taskGroups(md) {
  return [...splitFrontMatter(md || '').body.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
}

const STATE_MARK = { open: ' ', done: 'x', question: '?', dropped: '-' };

/**
 * Change a task's wording, due date, focus star or state. `changes` holds only what changes:
 * {text, due (a date or null), focus (true/false), state ('open'|'done'|'question'|'dropped')}.
 * The line is marked {edited: date}. Returns null if the task is not found.
 */
export function editTask(md, id, changes, date = today()) {
  const lines = md.split('\n');
  const i = findTask(lines, id);
  if (i < 0) return null;
  const p = splitTaskLine(lines[i]);
  if ('text' in changes && cleanTaskText(changes.text)) p.text = cleanTaskText(changes.text);
  if ('due' in changes) setTag(p.tags, 'due', changes.due || null, true);
  if ('focus' in changes) setTag(p.tags, 'focus', !!changes.focus, true);
  if (changes.state && STATE_MARK[changes.state] !== undefined && STATE_MARK[changes.state] !== p.mark) {
    p.mark = STATE_MARK[changes.state];
    setTag(p.tags, 'done', changes.state === 'done' ? date : null);
  }
  if (joinTaskLine(p) === joinTaskLine(splitTaskLine(lines[i]))) return md;   // nothing actually changed
  setTag(p.tags, 'edited', null);
  setTag(p.tags, 'edited', date);
  lines[i] = joinTaskLine(p);
  return lines.join('\n');
}

/**
 * Move a task (with anything nested under it) one place up (-1) or down (+1) among its neighbours.
 * Neighbours whose IDs are in `skip` (tasks not on screen, such as done ones) are passed over,
 * so one move always changes what the owner sees. Null if it cannot move.
 */
export function moveTask(md, id, dir, skip = new Set()) {
  const lines = md.split('\n');
  let moved = false;
  for (;;) {
    const i = findTask(lines, id);
    if (i < 0) return null;
    const [, end] = taskBlock(lines, i);
    const depth = indentOf(lines[i]);
    const sibling = (k) => k >= 0 && k < lines.length && TASK.test(lines[k]) && indentOf(lines[k]) === depth;
    let passed;
    if (dir < 0) {
      let j = i - 1;
      while (j >= 0 && lines[j].trim() && indentOf(lines[j]) > depth) j--;
      if (!sibling(j)) break;
      passed = splitTaskLine(lines[j]).id;
      lines.splice(j, end - j, ...lines.slice(i, end), ...lines.slice(j, i));
    } else {
      if (!sibling(end)) break;
      passed = splitTaskLine(lines[end]).id;
      const [, nextEnd] = taskBlock(lines, end);
      lines.splice(i, nextEnd - i, ...lines.slice(end, nextEnd), ...lines.slice(i, end));
    }
    moved = true;
    if (!skip.has(passed)) break;
  }
  return moved ? lines.join('\n') : null;
}

/** Put `block` (task lines) at the end of the group called `group`, adding the group at the end of the file if it is new. */
function appendToGroup(lines, group, block) {
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const heads = lines.map((l, k) => (/^## /.test(l) ? k : -1)).filter((k) => k >= 0);
  const h = heads.find((k) => lines[k].slice(3).trim().toLowerCase() === group.trim().toLowerCase());
  if (h === undefined) {
    lines.push('', `## ${group.trim()}`, '', ...block);
  } else {
    const next = heads.find((k) => k > h) ?? lines.length;
    let last = next - 1;
    while (last > h && !lines[last].trim()) last--;
    lines.splice(last + 1, 0, ...(last === h ? ['', ...block] : block));
  }
  lines.push('');
  return lines;
}

/** Move a task (with anything nested under it) to the end of another group. A group that does not exist yet is created. */
export function moveTaskToGroup(md, id, group) {
  const lines = md.split('\n');
  const i = findTask(lines, id);
  if (i < 0 || !group || !group.trim()) return null;
  let h = i;
  while (h >= 0 && !/^## /.test(lines[h])) h--;
  const depth = indentOf(lines[i]);
  if (h >= 0 && depth === 0 && lines[h].slice(3).trim().toLowerCase() === group.trim().toLowerCase()) return md;
  const [, end] = taskBlock(lines, i);
  const block = lines.splice(i, end - i).map((l) => l.slice(depth));
  return appendToGroup(lines, group, block).join('\n');
}

/**
 * Add a task typed by the owner. It gets the next free ID and is marked {manual}, which
 * stands in for the link to a note that tasks from notes carry. Returns {md, id}, or null if the text is empty.
 */
export function addTask(md, group, text, { due, focus } = {}, date = today()) {
  const clean = cleanTaskText(text);
  if (!clean) return null;
  const next = Math.max(0, ...[...md.matchAll(/\bT-(\d+)\b/g)].map((m) => Number(m[1]))) + 1;
  const id = `T-${String(next).padStart(3, '0')}`;
  const tags = [];
  if (due) tags.push(`{due: ${due}}`);
  if (focus) tags.push('{focus}');
  tags.push(`{added: ${date}}`, '{manual}');
  const line = joinTaskLine({ indent: '', mark: ' ', id, text: clean, tags, srcs: [] });
  return { md: appendToGroup(md.split('\n'), group && group.trim() ? group : 'General', [line]).join('\n'), id };
}

// ---------- questions ----------

/**
 * Open questions from questions.md, each classified so a screen can offer the right control:
 *   project  - "Which topic does X belong to?"    -> pick a topic (older questions say "project")
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
    const unknown = raw.match(/has lines for "([^"]+)", which is not a known (?:project|topic)/);
    const decision = raw.match(/\[decision\]\(([^)]+)\)/);
    const loose = raw.match(/has lines with no clear project \(([^)]+)\)/);
    if (loose) {
      q.kind = 'loose';
      q.label = loose[1];
      q.guess = (raw.match(/Best guess: ([^.]+)\./) || [])[1] || null;
      q.text = q.text.replace(/ \(group \d+\)/, '').replace(/\s*Best guess: [^.]+\./, '');
    } else if (/You edited this task by hand/.test(raw)) {
      q.kind = 'reword';   // a corrected wording held back because the owner had edited the task
    } else if (/^Which (?:project|topic) does /.test(raw)) {
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

/** File a note under a project. Pass `newProject` ({name, desc}) with an empty `slug` to create the project first. */
export const fileNote = (repo, q, slug, newProject) =>
  sendRequest(repo, { type: 'file', question: q.raw, note: q.note, slug: slug || '',
    ...(newProject ? { new_project: { name: newProject.name, desc: newProject.desc || '', kind: newProject.kind || 'project' } } : {}),
    ...(q.kind === 'loose' ? { label: q.label } : {}) });

export const createProject = (repo, { name, aliases, desc, kind }, q) =>
  sendRequest(repo, { type: 'new-project', question: q ? q.raw : '', name, aliases: aliases || [], desc: desc || '', kind: kind || 'project' });

/** Change a topic's kind (general, project or profile). */
export const setKind = (repo, slug, kind) => sendRequest(repo, { type: 'set-kind', slug, kind });

/** File lines of one note under different projects: `lines` is [{text, to}] where `to` is a slug, 'ignore' or 'new:<name>'. */
export const assignLines = (repo, q, lines, projects) =>
  sendRequest(repo, { type: 'assign', question: q.raw, note: q.note, label: q.label, lines, projects: projects || [] });

export const dismissLines = (repo, q) =>
  sendRequest(repo, { type: 'dismiss', question: q.raw, note: q.note, label: q.label });

/** Leave a whole note out of the wiki: it leaves the inbox and its questions are closed. The original is kept. */
export const discardNote = (repo, q) =>
  sendRequest(repo, { type: 'discard', question: q.raw, note: q.note });

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

// ---------- corrections ----------
//
// The owner's fixes to what the wiki says: a project's description, its glossary and people
// tables, and the transcription of a note. Each is sent as a request; the ingest script
// stores it as a raw item of its own and applies it.

const stripSrc = (text) => text.replace(/ *\[src\]\([^)]*\)/g, '');

/** A project page as the text before its first section, then each "## name" section in order. */
export function projectParts(md) {
  const chunks = projectBody(md).body.split(/^## (.+)$/m);
  const sections = [];
  for (let i = 1; i < chunks.length; i += 2) sections.push({ name: chunks[i].trim(), text: chunks[i + 1].trim() });
  return { pre: chunks[0].trim(), sections };
}

/** Section text as the owner edits it: paragraphs without their source links. */
export const plainText = (text) => stripSrc(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).join('\n\n');

/**
 * Rows of a three-column table (Term | Meaning | Status): [{term, meaning, status, key, profile}]. The header
 * row is left out. `key` is the first cell without a link around it; `profile` is the slug of the profile a
 * linked name points to ("[Ryan](../ryan/project.md)"), or ''.
 */
export function tableRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (!cells[0] || /^[-: ]+$/.test(cells[0])) continue;
    const link = cells[0].match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    const profile = link ? ((link[2].match(/^\.\.\/([^/]+)\/project\.md$/) || [])[1] || '') : '';
    rows.push({ term: cells[0], meaning: cells[1] || '', status: cells[2] || '', key: link ? link[1].trim() : cells[0], profile });
  }
  return rows.slice(1);
}

/**
 * A note's source.md split for correcting: the text before the transcription, each transcription
 * section ({index, heading, images: markdown image lines, text}), and the Notes at the end.
 * `sections` is empty for a file that has no transcription to correct.
 */
export function noteParts(md) {
  const { meta, body } = splitFrontMatter(md || '');
  const heads = [...body.matchAll(/^## (?:Transcription|Page \d+[^\n]*)[ \t]*$/gm)];
  if (!heads.length) return { meta, pre: body, sections: [], notes: '' };
  const notesAt = [...body.matchAll(/^## Notes[ \t]*$/gm)].map((m) => m.index).filter((i) => i > heads[heads.length - 1].index).pop();
  const stop = notesAt ?? body.length;
  const sections = heads.map((m, i) => {
    const lines = body.slice(m.index + m[0].length, i + 1 < heads.length ? heads[i + 1].index : stop).split('\n');
    const images = [];
    let k = 0;
    for (; k < lines.length; k++) {
      if (!lines[k].trim()) continue;
      if (!/^!\[[^\]]*\]\([^)]*\)[ \t]*$/.test(lines[k])) break;
      images.push(lines[k].trim());
    }
    return { index: i, heading: m[0].slice(3).trim(), images, text: lines.slice(k).join('\n').replace(/^\n+|\n+$/g, '') };
  });
  return { meta, pre: body.slice(0, heads[0].index).trim(), sections, notes: notesAt != null ? body.slice(notesAt).trim() : '' };
}

/** Sections of a project page that keep their own form: the script writes them, or they have editors of their own. */
export const FIXED_SECTIONS = ['Tasks', 'Glossary', 'People and suppliers', 'Pages', 'Contact', 'Linked from'];

/**
 * Add, change, rename or remove one of the owner's sections on a project page.
 * `was` is its current name ('' to add one); `name` its name after the change.
 */
export const correctSection = (repo, slug, { was = '', name, text = '', remove = false }) =>
  sendRequest(repo, { type: 'correct', target: 'section', slug, was, name: name || was, text, remove });

export const correctDescription = (repo, slug, text) =>
  sendRequest(repo, { type: 'correct', target: 'description', slug, text });

/**
 * `target` is 'glossary', 'people' or 'contact'. `row` is {was, term, meaning} to change or add a row, or {was, remove: true}.
 * For people, `profile` links the name to that profile ('' for no link; leave it out to keep the link there is),
 * and `newProfile: true` creates a profile for the name first.
 */
export const correctRow = (repo, slug, target, row) =>
  sendRequest(repo, { type: 'correct', target, slug, was: row.was || '', term: row.term || '', meaning: row.meaning || '', remove: !!row.remove,
    ...(row.profile !== undefined ? { profile: row.profile } : {}), ...(row.newProfile ? { new_profile: true } : {}) });

// ---------- profiles and contact details ----------

/** Fields offered when adding a contact detail. Any other name can be typed. */
export const CONTACT_FIELDS = ['Organization', 'Title', 'Email', 'Email (work)', 'Email (home)', 'Phone (mobile)', 'Phone (work)',
  'Phone (home)', 'Phone (fax)', 'Address (work)', 'Address (home)', 'Website', 'Birthday', 'Note'];

/** List a profile in another topic's people table, linked to the profile. */
export const linkProfile = (repo, profile, topic, role) => sendRequest(repo, { type: 'link-profile', profile, topic, role: role || '' });

/** A topic slug a markdown link points to ("[Acme](../acme/project.md)" -> "acme"), or ''. */
export const linkedSlug = (cell) => ((cell || '').match(/\]\(\.\.\/([^/)]+)\/project\.md\)/) || [])[1] || '';

/** Text of a table cell without source links and with links reduced to their text. */
export const cellText = (cell) => stripSrc(cell || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();

/**
 * A vCard 3.0 for a profile, from its name and its Contact rows ({key, meaning}). `isOrg` writes an organization's
 * card (no first and last name). Phones, emails and addresses keep their labels as TYPE.
 */
export function vcardFor(name, rows, isOrg = false) {
  const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
  const TYPES = { mobile: 'CELL', work: 'WORK', home: 'HOME', main: 'MAIN', fax: 'FAX', 'work fax': 'WORK,FAX', 'home fax': 'HOME,FAX', pager: 'PAGER', other: 'OTHER' };
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(name)}`];
  const parts = name.trim().split(/\s+/);
  lines.push(isOrg || parts.length < 2 ? `N:${esc(isOrg ? '' : name)};;;;` : `N:${esc(parts.slice(-1)[0])};${esc(parts.slice(0, -1).join(' '))};;;`);
  let org = isOrg ? name : '';
  for (const r of rows) {
    const value = cellText(r.meaning);
    const m = r.key.match(/^(\w+)(?:\s*\(([^)]*)\))?/);
    if (!value || !m) continue;
    const field = m[1].toLowerCase();
    const type = m[2] ? (TYPES[m[2].toLowerCase()] || m[2].toUpperCase().replace(/[^A-Z,]/g, '')) : '';
    const t = type ? `;TYPE=${type}` : '';
    if (field === 'organization') org = value;
    else if (field === 'title') lines.push(`TITLE:${esc(value)}`);
    else if (field === 'email') lines.push(`EMAIL;TYPE=INTERNET${type ? ',' + type : ''}:${value}`);
    else if (field === 'phone') lines.push(`TEL${t}:${value}`);
    else if (field === 'address') lines.push(`ADR${t}:;;${esc(value)};;;;`);
    else if (field === 'website') lines.push(`URL${t}:${value}`);
    else if (field === 'birthday' && /^\d{4}-\d{2}-\d{2}$/.test(value)) lines.push(`BDAY:${value}`);
    else if (field === 'note') lines.push(`NOTE:${esc(value)}`);
  }
  if (org) lines.splice(4, 0, `ORG:${esc(org)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n') + '\r\n';
}

/** Replace the text of one transcription section of a note; the wiki is then checked against it. */
export const correctTranscription = (repo, note, index, text) =>
  sendRequest(repo, { type: 'correct', target: 'transcription', note, sections: [{ index, text }] });

// ---------- health check ----------
//
// tools/health.py writes wiki/health.md. Items the owner leaves as they are go in
// wiki/health-ignored.json (key: {project, kind, text, on}) and are not raised again.

export const HEALTH_IGNORED = 'wiki/health-ignored.json';

/** The report as {checked, basicOnly, groups: [{name, slug, items: [{key, kind, text, project}]}]}, or null if there is none yet. */
export function parseHealth(md) {
  if (!md) return null;
  const { meta, body } = splitFrontMatter(md);
  const groups = [];
  let cur = null;
  for (const line of body.split('\n')) {
    const head = line.match(/^## (.+?)(?:\s*<!-- project: (\S+) -->)?\s*$/);
    if (head) { cur = { name: head[1].trim(), slug: head[2] || null, items: [] }; groups.push(cur); continue; }
    const item = line.match(/^- \*\*(.+?):\*\* (.*?)\s*<!-- key: (\S+) -->\s*$/);
    if (item && cur) cur.items.push({ kind: item[1], text: item[2], key: item[3], project: cur.slug });
  }
  return { checked: meta.checked || '', basicOnly: /model check did not run/.test(body), groups };
}

export function parseIgnored(text) {
  try { return JSON.parse(text || '{}') || {}; } catch { return {}; }
}

/** The report without the items left as they are. */
export function visibleHealth(report, ignored) {
  if (!report) return null;
  const groups = report.groups.map((g) => ({ ...g, items: g.items.filter((i) => !ignored[i.key]) })).filter((g) => g.items.length);
  return { ...report, groups, count: groups.reduce((n, g) => n + g.items.length, 0) };
}

/** Record that the owner wants an item left as it is. */
export async function ignoreFinding(repo, item, date = today()) {
  const entry = { project: item.project, kind: item.kind, text: stripSrc(item.text).replace(/\s*\[[^\]]*\]\([^)]*\)/g, '').trim(), on: date };
  const write = (o) => `${JSON.stringify({ ...o, [item.key]: entry }, null, 1)}\n`;
  const message = `Leave as is: ${item.key}`;
  if (!(await repo.tree(true)).has(HEALTH_IGNORED)) {
    await repo.put(HEALTH_IGNORED, toBase64(write({})), message);
    return;
  }
  const out = await repo.edit(HEALTH_IGNORED, message, (text) => {
    const o = parseIgnored(text);
    return o[item.key] ? null : write(o);
  });
  if (out == null) throw new Error('The list changed on GitHub at the same moment. Try again.');
}

// ---------- ask ----------
//
// Questions are answered by a model called straight from the device, with the owner's key for
// Anthropic's API (sk-ant-...) or for OpenRouter, so no server is needed. The whole wiki goes in one call while it is small enough:
// every wiki page and every note's transcription, each headed by its path so answers can link to it.

export const ASK_DEFAULTS = { model: 'anthropic/claude-haiku-5.5', maxChars: 600000, base: 'https://openrouter.ai/api/v1' };

/** Model and size limit from tools/ingest_config.json ("ask_model", "ask_max_chars"), with defaults. */
export async function askSettings(repo) {
  let cfg = {};
  try { cfg = JSON.parse((await repo.text('tools/ingest_config.json')) || '{}'); } catch { /* defaults */ }
  return { model: cfg.ask_model || ASK_DEFAULTS.model, maxChars: Number(cfg.ask_max_chars) || ASK_DEFAULTS.maxChars,
    anthropic: cfg.anthropic || {} };
}

/** True for a key to Anthropic's own API; any other key is taken to be an OpenRouter key. */
export const isAnthropicKey = (key) => /^sk-ant-/.test(String(key || '').trim());

/** anthropic/claude-haiku-5.5 -> claude-haiku-5-5. Names already in Anthropic's form are left alone. */
export const anthropicModel = (model) => (model.startsWith('anthropic/') ? model.slice(10).replace(/\./g, '-') : model);

/** Estimated cost in USD of an Anthropic reply, from its token counts and the prices in the config. */
export function anthropicCost(model, usage = {}, cfg = {}) {
  const p = (cfg.prices || {})[model];
  if (!p) return 0;
  const inp = usage.input_tokens || 0, out = usage.output_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0, read = usage.cache_read_input_tokens || 0;
  const long = (cfg.long_prompt || {})[model];
  const m = long && inp + write + read > long.over_tokens ? long.multiplier : 1;
  return m * (inp * p.input + out * p.output + write * (p.cache_write ?? p.input) + read * (p.cache_read ?? p.input)) / 1e6;
}

/** Paths sent as context: wiki pages and note transcriptions. Generated lists and the health report are left out. */
export function askPaths(paths) {
  return [...paths].filter((p) => (/^wiki\/.+\.md$/.test(p) && p !== 'wiki/health.md') || /^raw\/[^/]+\/source\.md$/.test(p)).sort();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Arrange files as one context block. If it is over `maxChars`, notes from other projects go first
 * (oldest first), then other projects' pages, so a question about `slug` keeps what matters most.
 * Returns {text, count, dropped}.
 */
export function buildContext(files, slug = null, maxChars = ASK_DEFAULTS.maxChars) {
  const mine = (f) => !!slug && (f.path.startsWith(`wiki/projects/${slug}/`)
    || (f.path.startsWith('raw/') && new RegExp(`^projects?:.*\\b${slug.replace(/[-]/g, '\\-')}\\b`, 'm').test(f.text)));
  let kept = files.filter((f) => f.text && f.text.trim());
  const size = () => kept.reduce((n, f) => n + f.path.length + f.text.length + 20, 0);
  const drop = (test) => { for (const f of [...kept]) { if (size() <= maxChars) return; if (test(f)) kept = kept.filter((x) => x !== f); } };
  drop((f) => f.path.startsWith('raw/') && !mine(f));
  drop((f) => f.path.startsWith('wiki/projects/') && !mine(f));
  drop((f) => f.path.startsWith('raw/'));
  const text = kept.map((f) => `=== FILE: ${f.path} ===\n${f.text.trim()}\n`).join('\n');
  return { text, count: kept.length, dropped: files.length - kept.length };
}

/** Read the wiki for a question. */
export async function askContext(repo, slug = null, maxChars = ASK_DEFAULTS.maxChars) {
  const paths = askPaths((await repo.tree()).keys());
  const texts = await mapLimit(paths, 8, (p) => repo.text(p));
  return buildContext(paths.map((path, i) => ({ path, text: texts[i] || '' })), slug, maxChars);
}

/**
 * Ask the model. `turns` is the conversation so far, [{q, a}], ending with the new question (no `a`).
 * The wiki goes first in a block marked for caching, so a follow-up within a few minutes costs less.
 * Returns {text, cost}.
 */
export async function askModel({ key, model, system, context, turns, base = ASK_DEFAULTS.base, scope = '', anthropic = {}, fetchImpl = fetch }) {
  if (!key) throw new Error('Ask needs an API key. Add it under Settings.');
  const viaAnthropic = isAnthropicKey(key);
  const who = viaAnthropic ? 'Anthropic' : 'OpenRouter';
  const first = [
    { type: 'text', text: `# The wiki\n\n${context}`, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: (scope ? `Asked from the page of the project: ${scope}.\n\n` : '') + `# Question\n\n${turns[0].q}` },
  ];
  const later = [];
  turns.slice(0, -1).forEach((t, i) => { later.push({ role: 'assistant', content: t.a || '' }, { role: 'user', content: turns[i + 1].q }); });
  let url, headers, body;
  if (viaAnthropic) {
    model = anthropicModel(model);
    url = 'https://api.anthropic.com/v1/messages';
    headers = { 'Content-Type': 'application/json', 'x-api-key': key.trim(), 'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true' };   // the key is the owner's own, kept in this browser
    body = { model, max_tokens: 4000, system, messages: [{ role: 'user', content: first }, ...later] };
    if ((anthropic.thinking || {})[model]) body.thinking = anthropic.thinking[model];
    if ((anthropic.effort || {})[model]) body.output_config = { effort: anthropic.effort[model] };
  } else {
    url = `${base.replace(/\/$/, '')}/chat/completions`;
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'X-Title': 'km-wiki ask' };
    if (typeof location !== 'undefined' && location.origin && location.origin.startsWith('http')) headers['HTTP-Referer'] = location.origin;
    body = { model, temperature: 0.2, max_tokens: 4000, usage: { include: true },
      messages: [{ role: 'system', content: system }, { role: 'user', content: first }, ...later] };
  }
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (e) { throw new Error(`Could not reach ${who} (${e.message}). Check the connection.`); }
  let data = {};
  try { data = await res.json(); } catch { /* handled below */ }
  if (!res.ok || data.error) {
    const msg = (data.error && (data.error.message || JSON.stringify(data.error))) || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error(`${who} refused the key. Check it under Settings.`);
    if (res.status === 402) throw new Error(`The ${who} account is out of credit.`);
    if (viaAnthropic && /credit balance/i.test(msg)) throw new Error('The Anthropic account is out of credit.');
    throw new Error(`${who}: ${msg}`.slice(0, 300));
  }
  let text, cut, cost;
  if (viaAnthropic) {
    if (data.stop_reason === 'refusal') throw new Error('The model declined to answer this question.');
    text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
    cut = data.stop_reason === 'max_tokens';
    cost = anthropicCost(model, data.usage || {}, anthropic);
  } else {
    const choice = (data.choices || [])[0] || {};
    text = (choice.message || {}).content || '';
    if (Array.isArray(text)) text = text.map((x) => x.text || '').join('');
    cut = choice.finish_reason === 'length';
    cost = (data.usage || {}).cost || 0;
  }
  if (!text.trim()) throw new Error('The model gave an empty answer. Try again.');
  if (cut) text += '\n\n*(The answer was cut off at its length limit.)*';
  return { text, cost };
}

/** The id the script gives a saved answer, chosen now so the app can link to it. */
export function questionId(now = new Date()) {
  const iso = now.toISOString();
  return `${iso.slice(0, 10)}-question-${iso.slice(11, 19).replace(/:/g, '')}`;
}

/** Keep a conversation from Ask in the wiki as a record. Returns the record's id. */
export async function saveAnswer(repo, turns, slug = null) {
  const record = questionId();
  await sendRequest(repo, { type: 'save-answer', record, project: slug,
    turns: turns.filter((t) => t.a).map((t) => ({ q: t.q, a: t.a })) });
  return record;
}

// ---------- instructions ----------

/** The id the script gives the record of an instruction sent now, so the app can link to it straight away. */
export function instructionId(now = new Date()) {
  const iso = now.toISOString();
  return `${iso.slice(0, 10)}-instruction-${iso.slice(11, 19).replace(/:/g, '')}`;
}

/**
 * Send the owner's instruction about a project. `finding` is the health check item it replies to, if any.
 * The text model turns it into changes on GitHub. Returns the id of the record that will list them.
 */
export async function instructWiki(repo, slug, instruction, finding = null) {
  const text = String(instruction || '').trim();
  if (!text) throw new Error('Type the instruction first.');
  const record = instructionId();
  await sendRequest(repo, { type: 'instruct', slug, instruction: text, record,
    finding: finding ? { key: finding.key, kind: finding.kind, text: finding.text } : null });
  return record;
}

/** Ask the workflow to run the health check now. */
export const requestHealthCheck = (repo) => sendRequest(repo, { type: 'health' });

const tasksPath = (slug) => `wiki/projects/${slug}/tasks.md`;

/** Run one of the editing functions above against tasks.md on GitHub. Returns the saved text. */
async function changeTasks(repo, slug, message, change) {
  const out = await repo.edit(tasksPath(slug), message, (md) => {
    const next = change(md);
    if (next == null) throw new Error('That task is no longer in the list. Reload the page and try again.');
    return next;
  });
  if (out == null) throw new Error('The task list changed on GitHub at the same moment. Try again.');
  return out;
}

/** Save an edit to one task. `changes` is as for editTask, plus an optional `group` to move it to. */
export const saveTask = (repo, slug, id, changes) =>
  changeTasks(repo, slug, `Edit ${id} (${slug})`, (md) => {
    const out = editTask(md, id, changes);
    return out != null && changes.group ? moveTaskToGroup(out, id, changes.group) : out;
  });

export const shiftTask = (repo, slug, id, dir, skip) =>
  changeTasks(repo, slug, `Move ${id} (${slug})`, (md) => moveTask(md, id, dir, skip) ?? (findTask(md.split('\n'), id) < 0 ? null : md));

/** Add a task typed by the owner; creates tasks.md if the project has none. Returns {md, id}. */
export async function newTask(repo, slug, name, group, text, options) {
  let id = null;
  const add = (md) => { const out = addTask(md, group, text, options); id = out.id; return out.md; };
  if (!cleanTaskText(text)) throw new Error('Type the task first.');
  if (!(await repo.tree(true)).has(tasksPath(slug))) {
    const md = add(`---\ntype: tasks\nproject: ${slug}\nupdated: ${today()}\n---\n\n# Tasks: ${name}\n`);
    await repo.put(tasksPath(slug), toBase64(md), `Add ${id} (${slug})`);
    return { md, id };
  }
  const md = await changeTasks(repo, slug, `Add a task (${slug})`, add);
  return { md, id };
}

// ---------- loading pages ----------

/** Everything a home screen needs. */
export async function loadOverview(repo) {
  const [yaml, questions, inbox, health, ignored] = await Promise.all([
    repo.text('wiki/projects.yaml'), repo.text('wiki/questions.md'), repo.text('wiki/inbox.md'),
    repo.text('wiki/health.md'), repo.text(HEALTH_IGNORED),
  ]);
  const projects = parseRegistry(yaml || '');
  await Promise.all(projects.map(async (p) => {
    p.counts = countTasks(parseTasks(await repo.text(`wiki/projects/${p.slug}/tasks.md`)));
  }));
  const waiting = ((inbox || '').split('\n## ')[0].match(/^- .*\]\(\.\.\/raw\//gm) || []).length;
  const pending = (await repo.list('inbox/')).filter((p) => !p.endsWith('README.txt'));
  return { projects, questions: parseQuestions(questions), inboxCount: waiting, pending, health: visibleHealth(parseHealth(health), parseIgnored(ignored)) };
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
