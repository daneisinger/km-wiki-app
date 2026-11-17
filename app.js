// km-wiki web app: screens only. All GitHub access and file-format logic is in core.js.
import * as core from './core.js';
import { marked } from './vendor/marked.esm.js';

// Shown under Settings so you can tell which copy a device is running. Raise it with every change to the app.
const APP_VERSION = '2026-11-17.1';
const APP_FILES = ['./', 'index.html', 'app.js', 'core.js', 'app.css', 'vendor/marked.esm.js', 'manifest.webmanifest'];

const view = document.getElementById('view');
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem('kmwiki.' + key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('kmwiki.' + key, JSON.stringify(value)); } catch { /* private mode: carry on without */ } },
};
let repo = null;
let registry = [];
let lastSignature = '';

// ---------- small DOM helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, children);
  return el;
}

/** Append children, flattening nested lists and skipping null and false. */
function add(el, ...children) {
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
}

/** Replace an element's content. */
function fill(el, ...children) {
  el.replaceChildren();
  add(el, children);
}

function toast(message, ms = 4000) {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

const crumb = (...items) => h('p', { class: 'crumb' }, items.flatMap((it, i) => [
  i ? h('span', { 'aria-hidden': 'true' }, '›') : null,
  it.href ? h('a', { href: it.href }, it.label) : h('b', {}, it.label),
]));

// ---------- markdown ----------

const STATE_CLASS = { ' ': 'open', x: 'done', X: 'done', '?': 'question', '-': 'dropped' };

function preprocess(md) {
  let fenced = false;
  return md.split('\n').map((line) => {
    if (line.trimStart().startsWith('```')) fenced = !fenced;
    if (fenced) return line;
    line = line.replace(/^(\s*)- \[([ xX?\-])\] /, (_, sp, s) => `${sp}- <span class="cb cb-${STATE_CLASS[s]}"></span> `);
    return line
      .replace(/\{focus\}/g, '<span class="chip focus">focus</span>')
      .replace(/\{attention\}/g, '<span class="chip attention">attention</span>')
      .replace(/\{due: ([^}]+)\}/g, '<span class="chip due">due $1</span>')
      .replace(/\{added: ([^}]+)\}/g, '<span class="chip added">added $1</span>')
      .replace(/\{done: ([^}]+)\}/g, '<span class="chip donedate">done $1</span>')
      .replace(/==(.+?)==/g, '<mark>$1</mark>');
  }).join('\n');
}

/** Render markdown from the file at `path` into a safe DOM fragment with working in-app links and images. */
function renderMarkdown(md, path) {
  const doc = new DOMParser().parseFromString(marked.parse(preprocess(md), { gfm: true }), 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,form,link,meta').forEach((n) => n.remove());
  for (const el of doc.body.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
    }
  }
  for (const a of doc.body.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^[a-z]+:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener'; continue; }
    if (href.startsWith('#')) continue;
    if (!/\.md(#.*)?$/i.test(href)) { a.removeAttribute('href'); continue; }   // originals are not viewable in the app yet
    a.setAttribute('href', '#/page/' + core.resolvePath(path, href));
    if (a.textContent === 'src') a.className = 'src';
  }
  for (const img of doc.body.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (/^(https?:|data:)/i.test(src)) continue;
    img.dataset.path = core.resolvePath(path, src);
    img.removeAttribute('src');
  }
  doc.body.querySelectorAll('table').forEach((t) => {
    const wrap = doc.createElement('div');
    wrap.className = 'tablewrap';
    t.replaceWith(wrap);
    wrap.append(t);
  });
  const box = h('div', { class: 'md' });
  box.append(...doc.body.childNodes);
  loadImages(box);
  return box;
}

const imageUrls = new Map();   // repo path -> blob URL, so an image is fetched once per visit

async function imageUrl(path) {
  if (!imageUrls.has(path)) imageUrls.set(path, URL.createObjectURL(await (await repo.raw(path)).blob()));
  return imageUrls.get(path);
}

async function loadImages(box) {
  for (const img of box.querySelectorAll('img[data-path]')) {
    try { img.src = await imageUrl(img.dataset.path); }
    catch { img.alt = (img.alt || 'image') + ' (could not be loaded)'; }
  }
}

/** The lines a question is about, when it concerns one group of lines in a note. */
async function linesFor(q) {
  try {
    const record = JSON.parse((await repo.text(`raw/${q.note}/ingest.json`)) || '{}');
    return ((record.waiting || []).find((w) => w.label === q.label) || {}).lines || null;
  } catch { return null; }
}

/** The note a question is about, shown inside the card: page images first, transcription folded below. */
function notePanel(noteId, label) {
  const box = h('div', { class: 'notepanel' }, h('p', { class: 'muted' }, 'Loading the note…'));
  core.loadNote(repo, noteId).then((note) => {
    if (!note) { fill(box, h('p', { class: 'muted' }, 'The note could not be found.')); return; }
    fill(box,
      h('div', { class: 'meta' }, h('span', {}, note.title), note.meta.captured && note.meta.captured !== 'null' ? h('span', {}, note.meta.captured) : null),
      note.images.map((path, i) => {
        const img = h('img', { alt: `${note.title}, page ${i + 1}`, 'data-path': path });
        const frame = h('button', { class: 'zoombox', type: 'button', 'aria-label': 'Page image. Tap to zoom in or out.', onclick: () => frame.classList.toggle('zoom') }, img);
        return frame;
      }),
      note.images.length ? h('p', { class: 'help' }, 'Tap the page to zoom in, then drag to move around.') : null,
      h('details', {}, h('summary', {}, 'Transcription'), renderMarkdown(note.transcription, `raw/${noteId}/source.md`)),
      h('p', {}, h('a', { href: `#/page/raw/${noteId}/source.md` }, 'Open the full note page')));
    loadImages(box);
  }).catch((e) => fill(box, h('p', { class: 'muted' }, `The note could not be loaded: ${e.message}`)));
  return box;
}

const inline = (text) => {
  const span = h('span', { html: marked.parseInline(text.replace(/==(.+?)==/g, '<mark>$1</mark>')) });
  span.querySelectorAll('script,style,iframe').forEach((n) => n.remove());
  return span;
};

// ---------- pending requests (sent, not yet applied by the workflow) ----------

function pendingRequests(files) {
  const now = Date.now();
  const list = store.get('pending', []).filter((p) => (files ? files.has(p.path) : true) || now - p.at < 90_000);
  store.set('pending', list);
  return list;
}

function addPending(path, question) {
  store.set('pending', [...store.get('pending', []), { path, question: question || '', at: Date.now() }]);
}

async function refreshChrome() {
  const files = await repo.tree();
  const overview = await core.loadOverview(repo);
  registry = overview.projects;
  const badge = document.getElementById('badge-questions');
  badge.hidden = !overview.questions.length;
  badge.textContent = overview.questions.length;
  const working = overview.pending.length;
  const notice = document.getElementById('notice');
  notice.hidden = !working;
  notice.textContent = working ? `${working} item${working > 1 ? 's' : ''} waiting to be processed on GitHub. Results appear here within a minute or two.` : '';
  pendingRequests(files);
  return overview;
}

window.addEventListener('error', (e) => toast(`Something went wrong: ${e.message}`, 8000));
window.addEventListener('unhandledrejection', (e) => toast(`Something went wrong: ${e.reason && e.reason.message || e.reason}`, 8000));

// ---------- screens ----------

async function home() {
  const o = await refreshChrome();
  fill(view, 
    h('h1', {}, 'Projects'),
    o.questions.length || o.inboxCount || (o.health && o.health.count) ? h('div', { class: 'cards' },
      o.questions.length ? h('a', { class: 'card attn', href: '#/q' }, h('h3', {}, `${o.questions.length} question${o.questions.length > 1 ? 's' : ''} for you`), h('div', { class: 'muted' }, 'Answer them to keep the wiki accurate.')) : null,
      o.inboxCount ? h('a', { class: 'card attn', href: '#/page/wiki/inbox.md' }, h('h3', {}, `${o.inboxCount} in the inbox`), h('div', { class: 'muted' }, 'Notes or parts of notes without a project.')) : null,
      o.health && o.health.count ? h('a', { class: 'card attn', href: '#/review' }, h('h3', {}, `${o.health.count} thing${o.health.count > 1 ? 's' : ''} to review`), h('div', { class: 'muted' }, `From the health check on ${o.health.checked}.`)) : null,
    ) : null,
    h('div', { class: 'cards' }, o.projects.map((p) => {
      const number = p.aliases.find((a) => /^\d+$/.test(a));
      return h('a', { class: 'card', href: '#/p/' + p.slug },
        h('h3', {}, p.name), number ? h('div', { class: 'num' }, number) : null,
        h('div', { class: 'counts' },
          h('span', {}, h('b', {}, p.counts.open), ' open'),
          h('span', {}, h('b', {}, p.counts.question), ' questions'),
          h('span', {}, h('b', {}, p.counts.done), ' done')));
    })),
    h('div', { class: 'row' },
      h('a', { class: 'btn', href: '#/new' }, 'New project'),
      h('a', { class: 'btn', href: '#/page/wiki/index.md' }, 'All notes'),
      h('a', { class: 'btn', href: '#/review' }, 'Health check'),
      h('a', { class: 'btn', href: '#/setup' }, 'Settings')),
  );
}

async function project(slug) {
  await refreshChrome();
  const p = registry.find((x) => x.slug === slug);
  const dir = `wiki/projects/${slug}/`;
  const md = await repo.text(dir + 'project.md');
  if (!p || md == null) throw new Error(`There is no project "${slug}".`);
  const tasksMd = await repo.text(dir + 'tasks.md');
  const pages = (await repo.list(dir)).filter((f) => f.endsWith('.md') && !/\/(project|tasks)\.md$/.test(f));
  const titles = await Promise.all(pages.map(async (f) => core.titleOf(await repo.text(f), f.split('/').pop())));
  fill(view, 
    crumb({ href: '#/', label: 'Projects' }, { label: p.name }),
    projectPage(slug, md),
    h('h2', {}, 'Tasks'),
    taskSection(slug, tasksMd),
    h('h2', {}, 'Pages'),
    h('div', { class: 'row' }, pages.map((f, i) => h('a', { class: 'btn', href: '#/page/' + f }, titles[i])),
      h('a', { class: 'btn primary', href: '#/add/' + slug }, 'Add a note to this project')),
  );
}

// ---------- corrections: edit what the wiki says, in place ----------

const sentFixes = [];   // corrections sent from this device and not yet applied: {path, at, key, data}

/** Corrections for `key` that GitHub has not applied yet, oldest first. They are shown as if applied, marked as pending. */
function pendingFixes(key) {
  const files = repo && repo.files;
  return sentFixes.filter((f) => f.key === key && ((files && files.has(f.path)) || Date.now() - f.at < 15000)).map((f) => f.data);
}

/** Send a correction; on success remember it so the page can show it while GitHub applies it. */
async function sendFix(button, key, data, action) {
  button.disabled = true;
  try {
    sentFixes.push({ path: await action(), at: Date.now(), key, data });
    toast('Saved. It shows as pending until GitHub has applied it, usually within a minute or two.', 6000);
    refreshChrome().catch(() => {});
    return true;
  } catch (e) {
    button.disabled = false;
    toast(`Could not save: ${e.message}`, 7000);
    return false;
  }
}

const editButton = (label, onclick) => h('button', { class: 'editbtn', type: 'button', 'aria-label': label, onclick }, label.split(' ')[0]);
const pendingNote = () => h('p', { class: 'help pending' }, 'Pending: GitHub is applying this change.');

function projectPage(slug, md) {
  const path = `wiki/projects/${slug}/project.md`;
  const parts = core.projectParts(md);
  return h('div', {},
    parts.pre ? renderMarkdown(parts.pre, path) : null,
    parts.sections.map((s) => (s.name === 'Description' ? descriptionBlock(slug, s.text, path)
      : s.name === 'Glossary' ? tableBlock(slug, 'glossary', s, path)
      : s.name === 'People and suppliers' ? tableBlock(slug, 'people', s, path)
      : renderMarkdown(`## ${s.name}\n\n${s.text}`, path))));
}

function descriptionBlock(slug, text, path) {
  const box = h('section', { class: 'fixable' });
  let draft = null;   // the text being edited, or null when not editing
  const draw = () => {
    const pending = pendingFixes(`desc:${slug}`).pop();
    const shown = pending ? pending.text : text;
    const area = draft == null ? null : h('textarea', { 'aria-label': 'Description', rows: Math.max(4, draft.split('\n').length + 2), oninput: (e) => { draft = e.target.value; } }, draft);
    fill(box,
      h('h2', {}, 'Description', draft == null ? editButton('Edit the description', () => { draft = core.plainText(shown); draw(); box.querySelector('textarea').focus(); }) : null),
      draft == null ? [renderMarkdown(shown, path), pending ? pendingNote() : null]
        : h('form', { class: 'fixedit', onsubmit: async (e) => {
          e.preventDefault();
          const next = draft.trim();
          if (!next) { toast('The description cannot be empty.'); return; }
          if (next === core.plainText(shown)) { draft = null; draw(); return; }
          if (await sendFix(e.submitter || e.target.querySelector('button'), `desc:${slug}`, { text: next }, () => core.correctDescription(repo, slug, next))) draft = null;
          draw();
        } },
          area,
          h('p', { class: 'help' }, 'A blank line starts a new paragraph. Paragraphs you leave alone keep their sources.'),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
            h('button', { class: 'btn', type: 'button', onclick: () => { draft = null; draw(); } }, 'Cancel'))));
  };
  draw();
  return box;
}

/** The Glossary or the People and suppliers table, with each row editable and a way to add one. */
function tableBlock(slug, target, section, path) {
  const words = target === 'glossary' ? { first: 'Term', second: 'Meaning', add: 'Add a term', one: 'term' } : { first: 'Name', second: 'Role', add: 'Add a person or supplier', one: 'name' };
  const key = `${target}:${slug}`;
  const box = h('section', { class: 'fixable' });
  const plain = (t) => t.replace(/ *\[src\]\([^)]*\)/g, '').trim();
  let draft = null;   // {was, term, meaning, confirmRemove}; was === '' for a new row
  const draw = () => {
    const rows = core.tableRows(section.text);
    for (const fix of pendingFixes(key)) {
      const at = rows.findIndex((r) => r.term.toLowerCase() === (fix.was || fix.term).toLowerCase());
      if (fix.remove) { if (at >= 0) rows.splice(at, 1); continue; }
      const row = { term: fix.term, meaning: fix.meaning, status: 'confirmed', pending: true };
      if (at >= 0) rows[at] = row; else rows.push(row);
    }
    const form = () => {
      const d = draft;
      const send = async (button, data) => { if (await sendFix(button, key, data, () => core.correctRow(repo, slug, target, data))) draft = null; draw(); };
      return h('form', { class: 'fixedit', onsubmit: (e) => {
        e.preventDefault();
        const term = d.term.trim(), meaning = d.meaning.trim();
        if (!term) { toast(`Give the ${words.one} first.`); return; }
        if (rows.some((r) => r.term.toLowerCase() === term.toLowerCase() && r.term.toLowerCase() !== d.was.toLowerCase())) { toast(`"${term}" is already in the list.`); return; }
        send(e.submitter || e.target.querySelector('button'), { was: d.was, term, meaning });
      } },
        h('label', {}, words.first, h('input', { type: 'text', value: d.term, autocapitalize: 'off', oninput: (e) => { d.term = e.target.value; } })),
        h('label', {}, words.second, h('textarea', { rows: 2, oninput: (e) => { d.meaning = e.target.value; } }, d.meaning)),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
          h('button', { class: 'btn', type: 'button', onclick: () => { draft = null; draw(); } }, 'Cancel'),
          d.was ? h('button', { class: 'btn danger', type: 'button', onclick: (e) => {
            if (!d.confirmRemove) { d.confirmRemove = true; e.target.textContent = 'Tap again to remove'; return; }
            send(e.target, { was: d.was, remove: true });
          } }, 'Remove') : null));
    };
    const editingRow = (r) => draft && draft.was && draft.was.toLowerCase() === r.term.toLowerCase();
    fill(box,
      h('h2', {}, section.name),
      rows.length ? h('div', { class: 'md' }, h('div', { class: 'tablewrap' }, h('table', { class: 'fixtable' },
        h('thead', {}, h('tr', {}, h('th', {}, words.first), h('th', {}, words.second), h('th', {}, 'Status'), h('th', {}, h('span', { class: 'sr' }, 'Edit')))),
        h('tbody', {}, rows.map((r) => (editingRow(r) ? h('tr', {}, h('td', { colspan: 4 }, form()))
          : h('tr', { class: r.pending ? 'pendingrow' : null },
            h('td', {}, renderMarkdown(r.term, path)), h('td', {}, renderMarkdown(r.meaning, path)),
            h('td', {}, renderMarkdown(r.status, path), r.pending ? h('span', { class: 'chip' }, 'pending') : null),
            h('td', {}, editButton(`Edit ${r.term}`, () => { draft = { was: r.term, term: r.term, meaning: plain(r.meaning) }; draw(); box.querySelector('.fixedit textarea').focus(); })))))))))
        : h('p', { class: 'muted' }, 'Nothing here yet.'),
      draft && !draft.was ? form() : h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => { draft = { was: '', term: '', meaning: '' }; draw(); box.querySelector('.fixedit input').focus(); } }, words.add)));
  };
  draw();
  return box;
}

/** A note's page with each part of its transcription correctable in place. Null if this file has no transcription to correct. */
function notePage(path, md) {
  const id = path.split('/')[1];
  const parts = core.noteParts(md);
  if (!parts.sections.length || ['app', 'chat'].includes(parts.meta.device)) return null;
  const box = h('div');
  let editing = null;   // index of the section being corrected
  let draft = '';
  const draw = () => {
    fill(box,
      parts.pre ? renderMarkdown(parts.pre, path) : null,
      parts.sections.map((s) => {
        const key = `note:${id}:${s.index}`;
        const pending = pendingFixes(key).pop();
        const shown = pending ? pending.text : s.text;
        const on = editing === s.index;
        return h('section', { class: 'fixable' },
          h('h2', {}, s.heading, on ? null : editButton('Correct this transcription', () => {
            editing = s.index; draft = shown; draw();
            const area = box.querySelector('.fixedit textarea');
            area.style.height = `${Math.min(area.scrollHeight + 4, Math.round(window.innerHeight * 0.7))}px`;   // show as much as fits, wrapped lines included
            area.focus();
          })),
          s.images.map((line) => {
            const m = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)/);
            const frame = h('button', { class: 'zoombox', type: 'button', 'aria-label': 'Page image. Tap to zoom in or out.', onclick: () => frame.classList.toggle('zoom') },
              h('img', { alt: m[1] || 'page', 'data-path': core.resolvePath(path, m[2]) }));
            return frame;
          }),
          on ? h('form', { class: 'fixedit', onsubmit: async (e) => {
            e.preventDefault();
            const next = draft.replace(/^\n+|\s+$/g, '');
            if (!next.trim()) { toast('The transcription cannot be empty.'); return; }
            if (next === shown) { editing = null; draw(); return; }
            if (await sendFix(e.submitter || e.target.querySelector('button'), key, { text: next }, () => core.correctTranscription(repo, id, s.index, next))) editing = null;
            draw();
          } },
            h('textarea', { class: 'mono', 'aria-label': `Transcription, ${s.heading}`, rows: Math.min(40, Math.max(8, draft.split('\n').length + 2)), spellcheck: 'false', oninput: (e) => { draft = e.target.value; } }, draft),
            h('p', { class: 'help' }, 'Fix what was read wrong and leave the rest. Marks: [x] ticked, [ ] not ticked, (star), (circle), ~~crossed out~~, ==highlighted==. After you save, tasks and log entries that came from this note are checked against the corrected text.'),
            h('div', { class: 'row' },
              h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
              h('button', { class: 'btn', type: 'button', onclick: () => { editing = null; draw(); } }, 'Cancel')))
            : [renderMarkdown(shown, path), pending ? pendingNote() : null]);
      }),
      parts.notes ? renderMarkdown(parts.notes, path) : null);
    loadImages(box);
  };
  draw();
  return box;
}

const NEW_GROUP = '\u0000new';
let holdRedraw = false;   // true while a task is being edited, so the periodic refresh does not close the editor

function taskSection(slug, tasksMd) {
  let md = tasksMd || '';
  let groups = core.parseTasks(md);
  const all = () => groups.flatMap((g) => g.tasks);
  const seenAll = store.get('seen', {});
  const firstVisit = !seenAll[slug];
  const seen = new Set(seenAll[slug] || []);
  const markSeen = () => { seenAll[slug] = all().map((t) => t.id).filter(Boolean); store.set('seen', seenAll); };
  markSeen();   // highlight shows once: everything on screen now counts as seen

  const box = h('div');
  let showDone = false;
  let editing = null;    // {id, text, due, focus, state, group, newGroup}: the task being edited and what has been typed
  let adding = null;     // {text, due, focus, group, newGroup}: the new task being typed
  let busy = false;
  const justDone = new Set();
  const justAdded = new Set();
  const saving = new Set();
  const shown = (t) => showDone || (t.state !== 'done' && t.state !== 'dropped') || justDone.has(t.id) || !!(editing && editing.id === t.id);
  const load = (text) => { md = text; groups = core.parseTasks(md); markSeen(); };
  const hold = () => { holdRedraw = !!(editing || adding); };

  /** Run a save, show the result, and report whether it worked. */
  const save = async (work, done) => {
    busy = true; draw();
    let ok = true;
    try { done(await work()); } catch (e) { ok = false; toast(`Could not save: ${e.message}`, 7000); }
    busy = false; hold(); draw();
    return ok;
  };

  const groupPicker = (draft, current) => {
    const names = core.taskGroups(md);
    if (current && !names.includes(current)) names.unshift(current);
    if (!names.length) names.push('General');
    if (!draft.group) draft.group = current || names[0];
    const other = h('input', { type: 'text', placeholder: 'Name of the new group', 'aria-label': 'Name of the new group', value: draft.newGroup || '',
      hidden: draft.group !== NEW_GROUP, oninput: (e) => { draft.newGroup = e.target.value; } });
    const select = h('select', { 'aria-label': 'Group', onchange: (e) => { draft.group = e.target.value; other.hidden = draft.group !== NEW_GROUP; if (!other.hidden) other.focus(); } },
      names.map((n) => h('option', { value: n, selected: draft.group === n }, n)),
      h('option', { value: NEW_GROUP, selected: draft.group === NEW_GROUP }, 'New group…'));
    return [select, other];
  };
  const chosenGroup = (draft) => (draft.group === NEW_GROUP ? (draft.newGroup || '').trim() : draft.group);

  const fields = (draft, label) => [
    h('textarea', { 'aria-label': label, placeholder: label === 'New task' ? 'New task' : null, rows: 2, oninput: (e) => { draft.text = e.target.value; } }, draft.text),
    h('div', { class: 'fieldrow' },
      h('label', {}, 'Due', h('input', { type: 'date', value: draft.due || '', oninput: (e) => { draft.due = e.target.value; } })),
      h('label', { class: 'tick' }, h('input', { type: 'checkbox', checked: draft.focus, onchange: (e) => { draft.focus = e.target.checked; } }), 'Star (focus)')),
  ];

  const editor = (t, g) => {
    const d = editing;
    // Done and dropped tasks that are not on screen are passed over, so each move is visible.
    const skip = new Set(all().filter((x) => x.id !== t.id && !shown(x)).map((x) => x.id));
    const canMove = (dir) => core.moveTask(md, t.id, dir, skip) != null;
    const move = (dir) => save(() => core.shiftTask(repo, slug, t.id, dir, skip), load);
    const submit = async () => {
      const text = core.cleanTaskText(d.text);
      const group = chosenGroup(d);
      if (!text) { toast('A task needs some text. To remove it, set its status to Dropped.'); return; }
      if (!group) { toast('Name the new group first.'); return; }
      const changes = { text, due: d.due || null, focus: !!d.focus, state: d.state, ...(group !== g.name ? { group } : {}) };
      const was = t.state;
      if (await save(() => core.saveTask(repo, slug, t.id, changes), (out) => {
        load(out);
        if (d.state !== was && (d.state === 'done' || d.state === 'dropped')) justDone.add(t.id);
        editing = null;
      })) toast(`${t.id} saved.`);
    };
    return h('li', { class: 'task editing', style: `margin-left:${t.depth * 22}px` },
      h('form', { class: 'taskedit', onsubmit: (e) => { e.preventDefault(); submit(); } },
        h('div', { class: 'id' }, t.id),
        fields(d, `Text of ${t.id}`),
        h('div', { class: 'fieldrow' },
          h('label', {}, 'Status', h('select', { onchange: (e) => { d.state = e.target.value; } },
            [['open', 'Open'], ['question', 'Open question'], ['done', 'Done'], ['dropped', 'Dropped']].map(([v, name]) => h('option', { value: v, selected: d.state === v }, name)))),
          h('label', {}, 'Group', groupPicker(d, g.name))),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', type: 'submit', disabled: busy }, 'Save'),
          h('button', { class: 'btn', type: 'button', disabled: busy, onclick: () => { editing = null; hold(); draw(); } }, 'Cancel'),
          h('button', { class: 'btn', type: 'button', disabled: busy || !canMove(-1), onclick: () => move(-1) }, 'Move up'),
          h('button', { class: 'btn', type: 'button', disabled: busy || !canMove(1), onclick: () => move(1) }, 'Move down'))));
  };

  const addForm = () => {
    const d = adding;
    const submit = async () => {
      const group = chosenGroup(d);
      if (!core.cleanTaskText(d.text)) { toast('Type the task first.'); return; }
      if (!group) { toast('Name the new group first.'); return; }
      const name = (registry.find((x) => x.slug === slug) || {}).name || slug;
      let id = null;
      if (await save(() => core.newTask(repo, slug, name, group, d.text, { due: d.due || null, focus: !!d.focus }), (out) => {
        load(out.md); id = out.id; justAdded.add(id); adding = null;
      })) toast(`${id} added.`);
    };
    return h('form', { class: 'taskedit adding', onsubmit: (e) => { e.preventDefault(); submit(); } },
      fields(d, 'New task'),
      h('div', { class: 'fieldrow' }, h('label', {}, 'Group', groupPicker(d, null))),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'submit', disabled: busy }, 'Add task'),
        h('button', { class: 'btn', type: 'button', disabled: busy, onclick: () => { adding = null; hold(); draw(); } }, 'Cancel')));
  };

  const draw = () => {
    const counts = core.countTasks(groups);
    const total = counts.open + counts.question + counts.done || 1;
    const hidden = counts.done + counts.dropped;
    fill(box,
      groups.length ? h('div', { class: 'bar-progress', role: 'img', 'aria-label': `${counts.done} of ${total} done` },
        ['done', 'open', 'question'].map((k) => counts[k] ? h('span', { class: 'seg-' + k, style: `flex:${counts[k]}` }) : null)) : null,
      h('div', { class: 'row' },
        groups.length ? h('span', { class: 'muted' }, `${counts.open} open · ${counts.question} questions · ${counts.done} done` + (counts.dropped ? ` · ${counts.dropped} dropped` : ''))
          : h('span', { class: 'muted' }, 'No tasks yet.'),
        hidden ? h('button', { class: 'btn', type: 'button', onclick: () => { showDone = !showDone; draw(); } },
          `${showDone ? 'Hide' : 'Show'} ${[counts.done ? 'done' : '', counts.dropped ? 'dropped' : ''].filter(Boolean).join(' and ')}`) : null,
        adding ? null : h('button', { class: 'btn', type: 'button', 'data-add': '1', disabled: busy }, 'Add task')),
      adding ? addForm() : null,
      groups.map((g) => {
        const rows = g.tasks.filter(shown);
        return rows.length ? [h('h3', {}, g.name), h('ul', { class: 'tasks' }, rows.map((t) => (editing && editing.id === t.id ? editor(t, g) : row(t))))] : null;
      }),
    );
  };
  const row = (t) => {
    const isNew = (!firstVisit && t.id && !seen.has(t.id) && !t.manual) || justAdded.has(t.id);
    const check = h('button', {
      class: 'check', type: 'button', 'data-state': t.state, 'data-task': t.id || '',
      'aria-label': `${t.id || 'Task'}: ${t.state}. ${t.state === 'done' ? 'Reopen' : 'Mark done'}`,
    });
    return h('li', { class: `task ${t.state}${isNew ? ' new' : ''}`, style: `margin-left:${t.depth * 22}px` },
      check,
      h('div', { class: 'text' },
        t.id ? h('span', { class: 'id' }, t.id) : null, inline(t.text),
        isNew ? h('span', { class: 'chip isnew' }, 'new') : null,
        t.focus ? h('span', { class: 'chip focus' }, 'focus') : null,
        t.attention ? h('span', { class: 'chip attention' }, 'attention') : null,
        t.due ? h('span', { class: 'chip due' }, 'due ' + t.due) : null,
        t.sources.slice(0, 2).map((s) => h('a', { class: 'src', href: '#/page/' + core.resolvePath(`wiki/projects/${slug}/tasks.md`, s) }, 'src')),
        h('div', {},
          t.added ? h('span', { class: 'chip added' }, (t.manual ? 'added by you ' : 'added ') + t.added) : null,
          t.done ? h('span', { class: 'chip donedate' }, 'done ' + t.done) : null,
          t.edited ? h('span', { class: 'chip added' }, 'edited ' + t.edited) : null)),
      t.id ? h('button', { class: 'editbtn', type: 'button', 'data-edit': t.id, 'aria-label': `Edit ${t.id}` }, 'Edit') : null);
  };
  const toggle = async (t) => {
    if (t.state === 'dropped' || saving.has(t.id)) return;
    const done = t.state !== 'done';
    t.state = done ? 'done' : 'open';
    if (done) justDone.add(t.id); else justDone.delete(t.id);
    saving.add(t.id);
    draw();
    try {
      const out = await core.toggleTask(repo, slug, t.id, done);
      if (out != null) load(out);
      toast(done ? `${t.id} marked done.` : `${t.id} reopened.`);
    } catch (e) {
      load(md);   // back to what is saved
      justDone.delete(t.id);
      toast(`Could not save ${t.id}: ${e.message}`, 7000);
    }
    saving.delete(t.id);
    draw();
  };
  // One listener on the list itself, so it keeps working however often the rows are redrawn.
  box.addEventListener('click', (e) => {
    const hit = (name) => { const el = e.target instanceof Element ? e.target.closest(`[data-${name}]`) : null; return el && box.contains(el) ? el : null; };
    const check = hit('task'), edit = hit('edit'), plus = hit('add');
    if (check) {
      e.preventDefault();
      const t = all().find((x) => x.id === check.dataset.task);
      if (t) toggle(t); else toast('This task has no ID yet, so it cannot be ticked here.');
    } else if (edit && !busy) {
      const t = all().find((x) => x.id === edit.dataset.edit);
      if (!t) return;
      editing = { id: t.id, text: t.text, due: t.due || '', focus: t.focus, state: t.state, group: '', newGroup: '' };
      adding = null;
      hold(); draw();
      const field = box.querySelector('.task.editing textarea');
      if (field) field.focus();
    } else if (plus && !busy) {
      adding = { text: '', due: '', focus: false, group: '', newGroup: '' };
      editing = null;
      hold(); draw();
      const field = box.querySelector('.taskedit.adding textarea');
      if (field) field.focus();
    }
  });
  holdRedraw = false;
  draw();
  return box;
}

async function page(path) {
  await refreshChrome();
  const md = await repo.text(path);
  if (md == null) throw new Error(`There is no page at ${path}.`);
  const { meta, body } = core.splitFrontMatter(md);
  const parts = path.split('/');
  const trail = [{ href: '#/', label: 'Projects' }];
  if (parts[1] === 'projects' && parts[2]) {
    const p = registry.find((x) => x.slug === parts[2]);
    trail.push({ href: '#/p/' + parts[2], label: p ? p.name : parts[2] });
  } else if (parts[0] === 'raw') trail.push({ href: '#/page/wiki/index.md', label: 'All notes' });
  trail.push({ label: core.titleOf(md, parts[parts.length - 1]) });
  if (parts[1] === 'projects' && parts[3] === 'tasks.md') {   // the full task list is interactive wherever it is opened
    fill(view, crumb(...trail), h('h1', {}, core.titleOf(md, 'Tasks')), taskSection(parts[2], md));
    return;
  }
  const facts = ['type', 'status', 'captured', 'device', 'project', 'origin_file', 'corrected'].filter((k) => meta[k] && meta[k] !== 'null');
  const note = /^raw\/[^/]+\/source\.md$/.test(path) ? notePage(path, md) : null;   // a note's transcription can be corrected in place
  fill(view, 
    crumb(...trail),
    facts.length ? h('div', { class: 'meta' }, facts.map((k) => h('span', {}, `${k.replace('_', ' ')}: ${meta[k]}`))) : null,
    note || renderMarkdown(body, path),
  );
}

let healthAsked = null;   // {at, checked}: when "Run the check now" was used, and the report date then

async function review() {
  const [md, ign] = await Promise.all([repo.text('wiki/health.md'), repo.text(core.HEALTH_IGNORED)]);
  const ignored = core.parseIgnored(ign);
  const report = core.visibleHealth(core.parseHealth(md), ignored);
  if (healthAsked && (Date.now() - healthAsked.at > 15 * 60000 || (report && report.checked !== healthAsked.checked))) healthAsked = null;
  const left = Object.keys(ignored).length;
  const run = h('button', { class: 'btn', type: 'button', disabled: !!healthAsked, onclick: async (e) => {
    e.target.disabled = true;
    try {
      await core.requestHealthCheck(repo);
      healthAsked = { at: Date.now(), checked: report ? report.checked : '' };
      e.target.textContent = 'Check requested';
      toast('The check runs on GitHub. Results appear here in a few minutes.', 6000);
    } catch (err) { e.target.disabled = false; toast(`Could not send: ${err.message}`, 7000); }
  } }, healthAsked ? 'Check requested' : 'Run the check now');
  const card = (item) => {
    const box = h('div', { class: 'qcard health' },
      h('p', {}, h('b', {}, item.kind)),
      renderMarkdown(item.text, 'wiki/health.md'),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: async (e) => {
        e.target.disabled = true;
        try {
          await core.ignoreFinding(repo, item);
          box.remove();
          toast('Left as is. It will not be raised again.');
        } catch (err) { e.target.disabled = false; toast(`Could not save: ${err.message}`, 7000); }
      } }, 'Leave as is')));
    return box;
  };
  fill(view,
    crumb(),
    h('h1', {}, 'Health check'),
    h('p', { class: 'muted' }, report
      ? `Checked ${report.checked}. Runs every Monday morning. ` + (report.count ? 'Follow a link to fix something; once fixed, it drops off at the next check.' : 'Nothing to look at.')
      : 'The check has not run yet. It runs every Monday morning.'),
    report && report.basicOnly ? h('p', { class: 'help' }, 'The model check did not run last time. Anything it found in an earlier check is still listed.') : null,
    healthAsked ? h('p', { class: 'help pending' }, 'A check was requested. Results appear here in a few minutes.') : null,
    report ? report.groups.map((g) => [h('h2', {}, g.slug ? h('a', { href: '#/p/' + g.slug }, g.name) : g.name), g.items.map(card)]) : null,
    h('div', { class: 'row' }, run),
    left ? h('p', { class: 'muted' }, `${left} item${left > 1 ? 's' : ''} left as they are.`) : null);
}

async function questions() {
  const o = await refreshChrome();
  const pending = new Set(pendingRequests().map((p) => p.question));
  const files = await repo.tree();
  for (const q of o.questions) if (files.has(core.requestPath(q.raw))) pending.add(q.raw);
  fill(view, 
    crumb({ href: '#/', label: 'Projects' }, { label: 'Questions' }),
    h('h1', {}, 'Questions for you'),
    o.questions.length ? o.questions.map((q) => questionCard(q, pending.has(q.raw)))
      : h('p', { class: 'muted' }, 'Nothing open.'),
    h('p', {}, h('a', { href: '#/page/wiki/questions.md' }, 'See answered questions')),
  );
}

/**
 * Lines of a note that no project claimed: each line gets its own picker, because they
 * often belong to different projects. New projects can be named right on the card.
 */
function looseForm(q, text, body, submit) {
  if (!text) { fill(body, h('p', { class: 'muted' }, 'The lines could not be loaded. Open the note to see them.')); return; }
  // An indented line, or one that is not a list item, hangs from the line above it.
  const items = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (items.length && !/^- /.test(line)) items[items.length - 1].text += '\n' + line;
    else items.push({ text: line, to: drafts.get(`${q.raw}|to${items.length}`) || '' });
  }
  const fresh = drafts.get(`${q.raw}|new`) || [];     // [{name, number}] projects to create
  drafts.set(`${q.raw}|new`, fresh);
  const guess = registry.find((p) => p.name === q.guess);

  let selects = [];
  const names = () => fresh.map((p) => p.name.trim()).filter(Boolean);
  // A new project's name changed: update the pickers in place, leaving the fields being typed in alone.
  const refresh = () => {
    for (const it of items) if (it.to.startsWith('new:') && !names().includes(it.to.slice(4))) it.to = '';
    selects.forEach((sel, i) => fill(sel, options(items[i])));
  };
  const options = (it) => [
      h('option', { value: '', disabled: true, selected: !it.to }, 'Choose…'),
      registry.map((p) => h('option', { value: p.slug, selected: it.to === p.slug }, p.name)),
      names().map((n) => h('option', { value: 'new:' + n, selected: it.to === 'new:' + n }, `New: ${n}`)),
      h('option', { value: 'ignore', selected: it.to === 'ignore' }, 'Ignore this line'),
    ];
  const draw = () => {
    for (const it of items) if (it.to.startsWith('new:') && !names().includes(it.to.slice(4))) it.to = '';
    selects = items.map((it, i) => h('select', { 'aria-label': `Project for line ${i + 1}`, onchange: (e) => { it.to = e.target.value; drafts.set(`${q.raw}|to${i}`, it.to); } }, options(it)));
    fill(body,
      guess ? h('p', { class: 'help' }, `Best guess for some of these: ${guess.name}.`) : null,
      items.map((it, i) => h('div', { class: 'assign' },
        h('pre', { class: 'lines' }, it.text),
        selects[i])),
      fresh.length ? h('p', { class: 'help' }, 'New projects. Name one, then pick it for its lines above.') : null,
      fresh.map((p, i) => h('div', { class: 'newproj' },
        h('input', { type: 'text', placeholder: 'New project name', 'aria-label': 'New project name', value: p.name, oninput: (e) => { p.name = e.target.value; refresh(); } }),
        h('input', { type: 'text', placeholder: 'Number (optional)', 'aria-label': 'Project number or other alias', inputmode: 'numeric', value: p.number, oninput: (e) => { p.number = e.target.value; } }),
        h('button', { class: 'btn small', type: 'button', 'aria-label': 'Remove this new project', onclick: () => { fresh.splice(i, 1); draw(); } }, 'Remove'))),
      h('div', { class: 'row tight' }, h('button', { class: 'btn small', type: 'button', onclick: () => { fresh.push({ name: '', number: '' }); draw(); const rows = body.querySelectorAll('.newproj'); rows[rows.length - 1].querySelector('input').focus(); } }, 'Add a new project')),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', onclick: (e) => {
          const missing = items.findIndex((it) => !it.to);
          if (missing >= 0) { toast(`Choose where line ${missing + 1} goes first.`); return; }
          const used = fresh.filter((p) => items.some((it) => it.to === 'new:' + p.name.trim()));
          submit(e.target, () => core.assignLines(repo, q, items.map((it) => ({ text: it.text, to: it.to })),
            used.map((p) => ({ name: p.name.trim(), aliases: p.number.split(',').map((x) => x.trim()).filter(Boolean) }))), 'Filing the lines.');
        } }, 'File these lines'),
        h('button', { class: 'btn', type: 'button', onclick: (e) => submit(e.target, () => core.dismissLines(repo, q), 'Ignoring those lines.') }, 'Ignore them all')));
  };
  draw();
}

const drafts = new Map();      // half-written answers, by question
const openNotes = new Set();   // questions whose note is showing, so a redraw of the page does not close them

function questionCard(q, alreadySent) {
  const card = h('div', { class: 'qcard' + (alreadySent ? ' sent' : '') });
  let panel = null;
  const noteLink = q.note ? h('button', { class: 'btn small', type: 'button', 'aria-expanded': 'false', onclick: (e) => {
    const open = !panel;
    if (open) { panel = notePanel(q.note, q.label); slot.append(panel); } else { panel.remove(); panel = null; }
    if (open) openNotes.add(q.raw); else openNotes.delete(q.raw);
    e.currentTarget.textContent = open ? 'Hide the note' : 'Show the note';
    e.currentTarget.setAttribute('aria-expanded', String(open));
  } }, 'Show the note') : null;
  const slot = h('div');
  const sent = (msg) => { card.classList.add('sent'); fill(card, h('p', {}, inline(q.text)), h('p', { class: 'muted' }, msg)); };
  if (alreadySent) { sent('Sent. It will be applied within a minute or two.'); return card; }

  const submit = async (button, action, label) => {
    button.disabled = true;
    try {
      const path = await action();
      addPending(path, q.raw);
      sent(`${label} It will be applied within a minute or two.`);
      refreshChrome();
    } catch (e) { button.disabled = false; toast(`Could not send: ${e.message}`, 7000); }
  };

  const proj = registry.find((p) => p.slug === q.project);
  add(card, proj ? h('div', { class: 'meta' }, h('a', { href: '#/p/' + proj.slug }, proj.name)) : null, h('p', {}, inline(q.text)),
    noteLink ? h('div', { class: 'row tight' }, noteLink) : null, slot);
  if (noteLink && q.kind === 'unknown') linesFor(q).then((lines) => { if (lines) slot.before(h('pre', { class: 'lines' }, lines)); });
  if (noteLink && openNotes.has(q.raw)) noteLink.click();   // the page was redrawn (a request landed, the workflow finished): keep open notes open
  if (q.kind === 'loose') {
    const body = h('div', {}, h('p', { class: 'muted' }, 'Loading the lines…'));
    add(card, body);
    linesFor(q).then((text) => looseForm(q, text, body, submit));
  } else if (q.kind === 'project') {
    // Pick an existing project, or "New project…" to name one and file the note under it in one go.
    const NEW = '__new';
    const select = h('select', { id: `q${q.n}-project`, 'aria-label': 'Project' },
      registry.map((p) => h('option', { value: p.slug, selected: p.name === q.guess }, p.name)),
      h('option', { value: NEW }, 'New project…'));
    const name = h('input', { type: 'text', id: `q${q.n}-name` });
    const desc = h('textarea', { id: `q${q.n}-desc`, placeholder: 'One or two sentences about the project (optional)' });
    const fresh = h('div', { hidden: true },
      h('label', { for: name.id }, 'Project name'), name,
      h('label', { for: desc.id }, 'Description'), desc);
    const go = h('button', { class: 'btn primary', type: 'button', onclick: (e) => {
      if (select.value !== NEW) { submit(e.target, () => core.fileNote(repo, q, select.value), 'Filing it.'); return; }
      const wanted = name.value.trim();
      if (!wanted) { toast('Give the project a name first.'); return; }
      const same = registry.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
      if (same) { submit(e.target, () => core.fileNote(repo, q, same.slug), 'Filing it.'); return; }
      submit(e.target, () => core.fileNote(repo, q, '', { name: wanted, desc: desc.value }), 'Creating the project and filing it.');
    } }, 'File under this project');
    const sync = () => {
      const making = select.value === NEW;
      fresh.hidden = !making;
      go.textContent = making ? 'Create project and file' : 'File under this project';
    };
    select.addEventListener('change', sync);
    if (!registry.length) select.value = NEW;
    sync();
    add(card, select, fresh, h('div', { class: 'row' }, go));
  } else if (q.kind === 'reword') {
    add(card, h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', onclick: (e) => submit(e.target, () => core.answerQuestion(repo, q, 'yes', ''), 'Changing the task.') }, 'Use the corrected wording'),
      h('button', { class: 'btn', type: 'button', onclick: (e) => submit(e.target, () => core.answerQuestion(repo, q, 'no', ''), 'Keeping your wording.') }, 'Keep mine')));
  } else if (q.kind === 'unknown') {
    const name = h('input', { type: 'text', id: `q${q.n}-name`, value: q.name });
    const number = h('input', { type: 'text', id: `q${q.n}-number`, value: q.number, inputmode: 'numeric' });
    const desc = h('textarea', { id: `q${q.n}-desc`, placeholder: 'One or two sentences about the project (optional)' });
    add(card, 
      h('label', { for: name.id }, 'Project name'), name,
      h('label', { for: number.id }, 'Project number or other alias'), number,
      h('label', { for: desc.id }, 'Description'), desc,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', onclick: (e) => {
          if (!name.value.trim()) { toast('Give the project a name first.'); return; }
          submit(e.target, () => core.createProject(repo, { name: name.value.trim(), aliases: number.value.split(',').map((s) => s.trim()).filter(Boolean), desc: desc.value }, q), 'Creating the project.');
        } }, 'Create project'),
        h('button', { class: 'btn', type: 'button', onclick: (e) => submit(e.target, () => core.dismissLines(repo, q), 'Ignoring those lines.') }, 'Ignore these lines')));
  } else {
    const text = h('textarea', { id: `q${q.n}-answer`, 'aria-label': 'Your answer', placeholder: q.kind === 'decision' ? 'The reason, if you remember it (optional)' : 'Your answer' });
    const buttons = q.kind === 'decision'
      ? [h('button', { class: 'btn primary', type: 'button', onclick: (e) => submit(e.target, () => core.answerQuestion(repo, q, 'yes', text.value), 'Confirmed.') }, 'Yes, that is right'),
         h('button', { class: 'btn', type: 'button', onclick: (e) => submit(e.target, () => core.answerQuestion(repo, q, 'no', text.value), 'Recorded as not right.') }, 'No')]
      : [h('button', { class: 'btn primary', type: 'button', onclick: (e) => {
           if (!text.value.trim()) { toast('Type an answer first, or choose one of the other buttons.'); return; }
           submit(e.target, () => core.answerQuestion(repo, q, '', text.value), 'Answer sent.');
         } }, 'Send answer')];
    if (q.kind === 'decision') add(card, h('p', {}, h('a', { href: '#/page/' + q.decision }, 'Open the decision page')));
    add(card, text, h('div', { class: 'row' }, buttons,
      h('button', { class: 'btn', type: 'button', onclick: (e) => submit(e.target, () => core.answerQuestion(repo, q, 'dont-remember', ''), 'Recorded as not remembered.') }, "Don't remember"),
      h('button', { class: 'btn', type: 'button', onclick: (e) => submit(e.target, () => core.answerQuestion(repo, q, 'skip', ''), 'Skipped.') }, 'Skip')));
  }
  // Anything typed or chosen survives a redraw of the page too.
  card.querySelectorAll('input, textarea, select').forEach((field, i) => {
    const key = `${q.raw}|${i}`;
    if (drafts.has(key)) field.value = drafts.get(key);
    const save = () => drafts.set(key, field.value);
    field.addEventListener('input', save);
    field.addEventListener('change', save);
  });
  return card;
}

// ---------- adding notes ----------

const fileToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(new Error('The file could not be read.'));
  r.readAsDataURL(blob);
});

/** Phone photos are far larger than the reader needs: shrink anything over 2600 px on its long side. */
async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return { blob: file, name: file.name };
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return { blob: file, name: file.name };
  const long = Math.max(bitmap.width, bitmap.height);
  if (long <= 2600 && file.size < 4_000_000) return { blob: file, name: file.name };
  const scale = Math.min(1, 2600 / long);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
  return { blob, name: file.name.replace(/\.[^.]+$/, '') + '.jpg' };
}

async function addNote(presetSlug) {
  await refreshChrome();
  const file = h('input', { type: 'file', id: 'note-file', accept: 'image/*,application/pdf,.txt,.md' });
  const typed = h('textarea', { id: 'note-text', placeholder: 'Or type a note here' });
  const proj = h('select', { id: 'note-project' },
    h('option', { value: '' }, 'Let the AI decide'),
    registry.map((p) => h('option', { value: p.slug, selected: p.slug === presetSlug }, p.name)));
  const caption = h('input', { type: 'text', id: 'note-caption', placeholder: 'For example: access panel proposal for the bench body' });
  const go = h('button', { class: 'btn primary', type: 'button' }, 'Add to the wiki');
  go.addEventListener('click', async () => {
    const f = file.files[0];
    if (!f && !typed.value.trim()) { toast('Choose a file or type a note first.'); return; }
    go.disabled = true;
    go.textContent = 'Uploading…';
    try {
      let name, base64;
      if (f) {
        const small = await shrinkImage(f);
        name = small.name;
        base64 = await fileToBase64(small.blob);
      } else {
        name = 'typed-note.md';
        base64 = core.toBase64(typed.value.trim() + '\n');
      }
      await core.uploadNote(repo, { name, base64, project: proj.value, caption: caption.value });
      fill(view, 
        h('h1', {}, 'Note added'),
        h('p', {}, 'It is being read and filed on GitHub. It will appear in the wiki within a minute or two.'),
        h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/add' + (proj.value ? '/' + proj.value : '') }, 'Add another'), h('a', { class: 'btn', href: '#/' }, 'Back to projects')));
      refreshChrome();
    } catch (e) {
      go.disabled = false;
      go.textContent = 'Add to the wiki';
      toast(`Upload failed: ${e.message}`, 7000);
    }
  });
  fill(view, 
    crumb({ href: '#/', label: 'Projects' }, { label: 'Add note' }),
    h('h1', {}, 'Add a note'),
    h('label', { for: 'note-file' }, 'Photo, screenshot, PDF or text file'), file,
    h('p', { class: 'help' }, 'On a phone this offers the camera, your photo library and Files.'),
    h('label', { for: 'note-text' }, 'Typed note'), typed,
    h('label', { for: 'note-project' }, 'Project'), proj,
    h('label', { for: 'note-caption' }, 'Caption (optional)'), caption,
    h('p', { class: 'help' }, 'A caption helps most with sketches that have no writing on them.'),
    h('div', { class: 'row' }, go),
  );
}

async function newProject() {
  await refreshChrome();
  const name = h('input', { type: 'text', id: 'np-name' });
  const alias = h('input', { type: 'text', id: 'np-alias', placeholder: 'For example: 25014, Lobby piece' });
  const desc = h('textarea', { id: 'np-desc', placeholder: 'One or two sentences. This is given to the AI every time it reads a note for this project.' });
  const go = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    if (!name.value.trim()) { toast('Give the project a name first.'); return; }
    go.disabled = true;
    try {
      const path = await core.createProject(repo, { name: name.value.trim(), aliases: alias.value.split(',').map((s) => s.trim()).filter(Boolean), desc: desc.value });
      addPending(path, '');
      fill(view, h('h1', {}, 'Project requested'), h('p', {}, `"${name.value.trim()}" will appear in the project list within a minute or two.`),
        h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/' }, 'Back to projects')));
      refreshChrome();
    } catch (e) { go.disabled = false; toast(`Could not send: ${e.message}`, 7000); }
  } }, 'Create project');
  fill(view, 
    crumb({ href: '#/', label: 'Projects' }, { label: 'New project' }),
    h('h1', {}, 'New project'),
    h('label', { for: 'np-name' }, 'Name'), name,
    h('label', { for: 'np-alias' }, 'Number and other names, separated by commas'), alias,
    h('label', { for: 'np-desc' }, 'Description'), desc,
    h('div', { class: 'row' }, go),
  );
}

function setup(message) {
  const cfg = store.get('cfg', {});
  const field = (id, label, value, type = 'text', help) => [h('label', { for: id }, label), h('input', { type, id, value: value || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }), help ? h('p', { class: 'help' }, help) : null];
  const go = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    const val = (id) => document.getElementById(id).value.trim();
    const next = { owner: val('s-owner'), repo: val('s-repo'), branch: val('s-branch') || 'master', token: val('s-token'), apiBase: val('s-api') || 'https://api.github.com' };
    go.disabled = true;
    try {
      await new core.Repo(next).tree(true);
      store.set('cfg', next);
      repo = new core.Repo(next);
      location.hash = '#/';
      route();
    } catch (e) { go.disabled = false; toast(`Could not connect. ${e.message}`, 8000); }
  } }, 'Connect');
  fill(view, 
    h('h1', {}, 'Connect to your wiki'),
    message ? h('p', { class: 'error' }, message) : null,
    h('p', {}, 'This app reads and writes your wiki repo on GitHub directly from this device. The details below are stored only in this browser.'),
    field('s-owner', 'GitHub user or organisation', cfg.owner),
    field('s-repo', 'Repository', cfg.repo || 'km-wiki'),
    field('s-branch', 'Branch', cfg.branch || 'master'),
    field('s-token', 'Access token', cfg.token, 'password',
      'On GitHub: Settings › Developer settings › Fine-grained tokens. Give it access to this one repository only, with Contents set to Read and write.'),
    h('details', {}, h('summary', {}, 'Advanced'), field('s-api', 'API address', cfg.apiBase || 'https://api.github.com')),
    h('div', { class: 'row' }, go,
      cfg.token ? h('button', { class: 'btn danger', type: 'button', onclick: () => { ['cfg', 'pending', 'seen'].forEach((k) => localStorage.removeItem('kmwiki.' + k)); repo = null; setup('This device has been disconnected.'); } }, 'Disconnect this device') : null),
    aboutApp(),
  );
}

/** The newest version on the server, read straight from app.js without using the browser's saved copy. */
async function latestVersion() {
  const res = await fetch('app.js', { cache: 'no-store' });
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  const found = /const APP_VERSION = '([^']+)'/.exec(await res.text());
  if (!found) throw new Error('no version found in the app on the server');
  return found[1];
}

/** Fetch every app file fresh, replacing the browser's saved copies, then restart the app. */
async function reloadApp() {
  await Promise.all(APP_FILES.map((f) => fetch(f, { cache: 'reload' }).then((r) => { if (!r.ok) throw new Error(`${f}: the server answered ${r.status}`); })));
  location.reload();
}

function aboutApp() {
  const status = h('p', { class: 'help', id: 'app-latest' }, 'Checking for a newer version…');
  const reload = h('button', { class: 'btn', type: 'button', onclick: async () => {
    reload.disabled = true;
    try { await reloadApp(); } catch (e) { reload.disabled = false; toast(`Could not reload. ${e.message}`, 7000); }
  } }, 'Reload app');
  latestVersion().then((latest) => {
    status.textContent = latest === APP_VERSION ? 'This is the latest version.' : `Version ${latest} is available. Tap Reload app to get it.`;
  }, () => { status.textContent = 'Could not check for a newer version.'; });
  return h('section', { class: 'about' },
    h('h2', {}, 'This app'),
    h('p', { id: 'app-version' }, `Version ${APP_VERSION}`), status,
    h('div', { class: 'row' }, reload));
}

// ---------- routing ----------

async function route(scroll = true) {
  const hash = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const cfg = store.get('cfg', null);
  if (!cfg || !cfg.token || hash === 'setup') { setup(); return; }
  repo = repo || new core.Repo(cfg);
  try {
    if (hash === '') await home();
    else if (hash === 'q') await questions();
    else if (hash === 'review') await review();
    else if (hash === 'new') await newProject();
    else if (hash === 'add' || hash.startsWith('add/')) await addNote(hash.slice(4));
    else if (hash.startsWith('p/')) await project(hash.slice(2));
    else if (hash.startsWith('page/')) await page(hash.slice(5));
    else await home();
    lastSignature = await signature();
    if (scroll) window.scrollTo(0, 0);
  } catch (e) {
    fill(view, h('div', { class: 'error' }, h('p', {}, e.message || String(e)),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/' }, 'Projects'), h('a', { class: 'btn', href: '#/setup' }, 'Settings'))));
  }
}

async function signature() {
  const files = await repo.tree();
  return [...files].filter(([p]) => p.startsWith('wiki/') || p.startsWith('inbox/')).map(([p, s]) => p + s).join('|');
}

// While something is being processed on GitHub, look for the result and redraw when it lands.
setInterval(async () => {
  if (!repo || document.hidden) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName)) return;
  if ((holdRedraw && view.querySelector('.taskedit')) || view.querySelector('.fixedit')) return;   // something is being edited: do not redraw under it
  try {
    await repo.tree(true);
    const now = await signature();
    if (now !== lastSignature) route(false);
  } catch { /* offline or rate limited: try again next time */ }
}, 20000);

window.addEventListener('hashchange', () => route());
route();
