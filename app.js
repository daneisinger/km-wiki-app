// km-wiki web app: screens only. All GitHub access and file-format logic is in core.js.
import * as core from './core.js';
import { marked } from './vendor/marked.esm.js';

// Shown under Settings so you can tell which copy a device is running. Raise it with every change to the app.
const APP_VERSION = '2026-11-24.1';
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
    if (!/\.md(#.*)?$/i.test(href)) {   // a file kept with a note (an email attachment, an original): fetched when tapped
      const file = core.resolvePath(path, href.split('#')[0]);
      if (file.startsWith('raw/')) { a.setAttribute('href', '#'); a.dataset.file = file; } else a.removeAttribute('href');
      continue;
    }
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
  for (const a of box.querySelectorAll('a[data-file]')) a.addEventListener('click', (e) => { e.preventDefault(); openFile(a.dataset.file); });
  return box;
}

const imageUrls = new Map();   // repo path -> blob URL, so an image is fetched once per visit

async function imageUrl(path) {
  if (!imageUrls.has(path)) imageUrls.set(path, URL.createObjectURL(await (await repo.raw(path)).blob()));
  return imageUrls.get(path);
}

/** Download a file from the repo (the repo is private, so a plain link would not work) and hand it to the browser. */
async function openFile(path) {
  try {
    const url = URL.createObjectURL(await (await repo.raw(path)).blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop();
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    toast(`Could not open the file: ${e.message}`, 7000);
  }
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

/** A picker for a topic's kind: general, project or profile. */
const kindSelect = (id, value = 'project') => h('select', { id, 'aria-label': 'Kind' },
  core.KINDS.map(([k, label]) => h('option', { value: k, selected: k === value }, label)));
const KIND_HELP = 'Project: a piece of work with tasks. General: an ongoing subject, such as a job, a hobby or a group. Profile: a person or an organization.';

async function home() {
  const o = await refreshChrome();
  fill(view, 
    h('h1', {}, 'Topics'),
    o.questions.length || o.inboxCount || (o.health && o.health.count) ? h('div', { class: 'cards' },
      o.questions.length ? h('a', { class: 'card attn', href: '#/q' }, h('h3', {}, `${o.questions.length} question${o.questions.length > 1 ? 's' : ''} for you`), h('div', { class: 'muted' }, 'Answer them to keep the wiki accurate.')) : null,
      o.inboxCount ? h('a', { class: 'card attn', href: '#/page/wiki/inbox.md' }, h('h3', {}, `${o.inboxCount} in the inbox`), h('div', { class: 'muted' }, 'Notes or parts of notes without a topic.')) : null,
      o.health && o.health.count ? h('a', { class: 'card attn', href: '#/review' }, h('h3', {}, `${o.health.count} thing${o.health.count > 1 ? 's' : ''} to review`), h('div', { class: 'muted' }, `From the health check on ${o.health.checked}.`)) : null,
    ) : null,
    [['project', 'Projects'], ['general', 'General'], ['profile', 'Profiles']].map(([kind, heading]) => {
      const group = o.projects.filter((p) => (p.kind || 'project') === kind);
      return group.length ? [h('h2', {}, heading), h('div', { class: 'cards' }, group.map((p) => {
        const number = p.aliases.find((a) => /^\d+$/.test(a));
        return h('a', { class: 'card', href: '#/p/' + p.slug },
          h('h3', {}, p.name), number ? h('div', { class: 'num' }, number) : null,
          h('div', { class: 'counts' },
            h('span', {}, h('b', {}, p.counts.open), ' open'),
            h('span', {}, h('b', {}, p.counts.question), ' questions'),
            h('span', {}, h('b', {}, p.counts.done), ' done')));
      }))] : null;
    }),
    h('div', { class: 'row' },
      h('a', { class: 'btn', href: '#/new' }, 'New topic'),
      h('a', { class: 'btn', href: '#/page/wiki/index.md' }, 'All notes'),
      h('a', { class: 'btn', href: '#/review' }, 'Health check'),
      h('a', { class: 'btn', href: '#/ask' }, 'Ask'),
      h('a', { class: 'btn', href: '#/setup' }, 'Settings')),
  );
}

async function project(slug) {
  await refreshChrome();
  const p = registry.find((x) => x.slug === slug);
  const dir = `wiki/projects/${slug}/`;
  const md = await repo.text(dir + 'project.md');
  if (!p || md == null) throw new Error(`There is no topic "${slug}".`);
  const tasksMd = await repo.text(dir + 'tasks.md');
  const pages = (await repo.list(dir)).filter((f) => f.endsWith('.md') && !/\/(project|tasks)\.md$/.test(f));
  const titles = await Promise.all(pages.map(async (f) => core.titleOf(await repo.text(f), f.split('/').pop())));
  fill(view, 
    crumb({ href: '#/', label: 'Topics' }, { label: p.name }),
    kindLine(p),
    projectPage(slug, md, p),
    h('h2', {}, 'Tasks'),
    taskSection(slug, tasksMd),
    h('h2', {}, 'Pages'),
    h('div', { class: 'row' }, pages.map((f, i) => h('a', { class: 'btn', href: '#/page/' + f }, titles[i])),
      h('a', { class: 'btn primary', href: '#/add/' + slug }, 'Add a note here'),
      h('a', { class: 'btn', href: '#/ask/' + slug }, 'Ask about this topic')),
    h('h2', {}, 'Tell the wiki'),
    h('p', { class: 'muted' }, 'Say what to change in this topic in your own words: tasks, log, description, glossary or decisions. The model makes the changes and lists them.'),
    instructBox(slug, 'project:' + slug, null, 'For example: T-030 is done; the clevis is only on the anchor end'),
  );
}

/** "Kind: General", with a way to change it. The change is applied on GitHub like any other request. */
function kindLine(p) {
  const line = h('p', { class: 'muted' });
  const show = (kind, pending) => fill(line, `Kind: ${core.kindLabel(kind)}`, pending ? ' (pending)' : '', ' ',
    pending ? null : h('button', { class: 'btn small', type: 'button', onclick: edit }, 'Change'));
  const edit = () => {
    const select = kindSelect(`kind-${p.slug}`, p.kind);
    fill(line, h('label', { for: select.id }, 'Kind'), select,
      h('p', { class: 'help' }, KIND_HELP),
      h('div', { class: 'row tight' },
        h('button', { class: 'btn small primary', type: 'button', onclick: async (e) => {
          if (select.value === p.kind) { show(p.kind); return; }
          e.target.disabled = true;
          try {
            addPending(await core.setKind(repo, p.slug, select.value), '');
            toast('Saved. It changes within a minute or two.', 5000);
            show(select.value, true);
          } catch (err) { e.target.disabled = false; toast(`Could not send: ${err.message}`, 7000); }
        } }, 'Save'),
        h('button', { class: 'btn small', type: 'button', onclick: () => show(p.kind) }, 'Cancel')));
  };
  show(p.kind || 'project');
  return line;
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

function projectPage(slug, md, topic = {}) {
  const path = `wiki/projects/${slug}/project.md`;
  const parts = core.projectParts(md);
  if (topic.kind === 'profile') {   // a profile always shows its contact details and the topics it is linked from, even empty
    const at = Math.max(0, parts.sections.findIndex((s) => s.name === 'Description') + 1);
    if (!parts.sections.some((s) => s.name === 'Contact')) parts.sections.splice(at, 0, { name: 'Contact', text: '' });
    const after = parts.sections.findIndex((s) => s.name === 'Contact') + 1;
    if (!parts.sections.some((s) => s.name === 'Linked from')) parts.sections.splice(after, 0, { name: 'Linked from', text: '' });
  }
  const names = parts.sections.map((s) => s.name);
  const fixed = (n) => core.FIXED_SECTIONS.includes(n);
  // Sections added from this device that GitHub has not written yet.
  const added = pendingFixes(`sections:${slug}`).filter((f) => !names.some((n) => n.toLowerCase() === f.name.toLowerCase()));
  const adder = addSectionBlock(slug, () => [...names, ...added.map((f) => f.name)]);
  const out = [parts.pre ? renderMarkdown(parts.pre, path) : null];
  let placed = false;
  const place = () => { if (!placed) { placed = true; out.push(added.map((f) => sectionBlock(slug, f.name, f.text, path, { fresh: true })), adder); } };
  for (const s of parts.sections) {
    if (['Glossary', 'People and suppliers', 'Pages'].includes(s.name)) place();
    out.push(s.name === 'Glossary' ? tableBlock(slug, 'glossary', s, path)
      : s.name === 'People and suppliers' ? tableBlock(slug, 'people', s, path)
      : s.name === 'Contact' ? tableBlock(slug, 'contact', s, path, topic)
      : s.name === 'Linked from' ? linkedBlock(slug, s, path)
      : fixed(s.name) ? renderMarkdown(`## ${s.name}\n\n${s.text}`, path)
      : sectionBlock(slug, s.name, s.text, path, { names }));
  }
  place();
  return h('div', {}, out);
}

const sectionKey = (slug, name) => `section:${slug}:${name.toLowerCase()}`;

function addSectionBlock(slug, existing) {
  const box = h('div', { class: 'addsection' });
  let draft = null;   // {name, text} while adding
  const draw = () => {
    if (!draft) {
      fill(box, h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => { draft = { name: '', text: '' }; draw(); box.querySelector('input').focus(); } }, 'Add a section')));
      return;
    }
    fill(box, h('form', { class: 'fixedit', onsubmit: async (e) => {
      e.preventDefault();
      const name = draft.name.replace(/\s+/g, ' ').replace(/^#+\s*/, '').trim();
      const text = draft.text.trim();
      if (!name) { toast('Give the section a name.'); return; }
      if (core.FIXED_SECTIONS.concat('Description').some((n) => n.toLowerCase() === name.toLowerCase())) { toast(`"${name}" is a built-in section. Choose another name.`); return; }
      if (existing().some((n) => n.toLowerCase() === name.toLowerCase())) { toast(`There is already a section called "${name}".`); return; }
      if (!text) { toast('Write something in the section first.'); return; }
      if (await sendFix(e.submitter || e.target.querySelector('button'), `sections:${slug}`, { name, text }, () => core.correctSection(repo, slug, { was: '', name, text }))) {
        draft = null;
        route(false);   // show the new section in its place, marked as pending
      }
    } },
      h('label', {}, 'Section name', h('input', { type: 'text', value: draft.name, placeholder: 'For example: Site contacts', oninput: (e) => { draft.name = e.target.value; } })),
      h('label', {}, 'Text', h('textarea', { rows: 5, oninput: (e) => { draft.text = e.target.value; } }, draft.text)),
      h('p', { class: 'help' }, 'A blank line starts a new paragraph. Lists and ### subheadings work. The model reads this section when it files notes, but does not change it.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'submit' }, 'Add section'),
        h('button', { class: 'btn', type: 'button', onclick: () => { draft = null; draw(); } }, 'Cancel'))));
  };
  draw();
  return box;
}

/**
 * One editable section of a project page. Description can only be edited; sections the owner
 * added can also be renamed and removed. `fresh` marks one that GitHub has not written yet.
 */
function sectionBlock(slug, name, text, path, { names = [], fresh = false } = {}) {
  const isDesc = name === 'Description';
  const key = isDesc ? `desc:${slug}` : sectionKey(slug, name);
  const box = h('section', { class: 'fixable' });
  let draft = null;   // {name, text, confirmRemove} while editing
  const draw = () => {
    const pending = pendingFixes(key).pop();
    if (pending && pending.remove) { fill(box, h('p', { class: 'help pending' }, `Removing the section "${name}". GitHub is applying this change.`)); return; }
    const shownName = pending && pending.name ? pending.name : name;
    const shown = pending ? pending.text : text;
    const send = (button, data) => sendFix(button, key, data, () => (isDesc ? core.correctDescription(repo, slug, data.text)
      : core.correctSection(repo, slug, { was: name, name: data.name || name, text: data.text || '', remove: !!data.remove })));
    if (draft == null) {
      fill(box,
        h('h2', {}, shownName, fresh || pending ? null : editButton(isDesc ? 'Edit the description' : `Edit ${name}`, () => { draft = { name, text: core.plainText(shown) }; draw(); box.querySelector('textarea').focus(); })),
        renderMarkdown(shown, path), fresh || pending ? pendingNote() : null);
      return;
    }
    fill(box,
      h('h2', {}, isDesc ? 'Description' : 'Edit section'),
      h('form', { class: 'fixedit', onsubmit: async (e) => {
        e.preventDefault();
        const next = draft.text.trim();
        const newName = isDesc ? name : draft.name.replace(/\s+/g, ' ').replace(/^#+\s*/, '').trim();
        if (!next) { toast(isDesc ? 'The description cannot be empty.' : 'The section is empty. To delete it, use Remove.'); return; }
        if (!newName) { toast('Give the section a name.'); return; }
        if (newName.toLowerCase() !== name.toLowerCase() && (core.FIXED_SECTIONS.concat('Description').concat(names).some((n) => n.toLowerCase() === newName.toLowerCase()))) { toast(`There is already a section called "${newName}".`); return; }
        if (next === core.plainText(shown) && newName === name) { draft = null; draw(); return; }
        if (await send(e.submitter || e.target.querySelector('button'), { name: newName, text: next })) draft = null;
        draw();
      } },
        isDesc ? null : h('label', {}, 'Section name', h('input', { type: 'text', value: draft.name, oninput: (e) => { draft.name = e.target.value; } })),
        h('textarea', { 'aria-label': isDesc ? 'Description' : `Text of ${name}`, rows: Math.max(4, draft.text.split('\n').length + 2), oninput: (e) => { draft.text = e.target.value; } }, draft.text),
        h('p', { class: 'help' }, 'A blank line starts a new paragraph. Paragraphs you leave alone keep their sources.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
          h('button', { class: 'btn', type: 'button', onclick: () => { draft = null; draw(); } }, 'Cancel'),
          isDesc ? null : h('button', { class: 'btn danger', type: 'button', onclick: async (e) => {
            if (!draft.confirmRemove) { draft.confirmRemove = true; e.target.textContent = 'Tap again to remove'; return; }
            if (await send(e.target, { remove: true })) draft = null;
            draw();
          } }, 'Remove section'))));
  };
  draw();
  return box;
}


/**
 * The Glossary, the People and suppliers, or a profile's Contact table, with each row editable and a way to add one.
 * A person's name can be linked to their profile; a Contact table can be downloaded as a contact card.
 */
function tableBlock(slug, target, section, path, topic = {}) {
  const words = target === 'glossary' ? { first: 'Term', second: 'Meaning', add: 'Add a term', one: 'term' }
    : target === 'contact' ? { first: 'Field', second: 'Value', add: 'Add a contact detail', one: 'field' }
    : { first: 'Name', second: 'Role', add: 'Add a person or supplier', one: 'name' };
  const key = `${target}:${slug}`;
  const box = h('section', { class: 'fixable' });
  const plain = (t) => t.replace(/ *\[src\]\([^)]*\)/g, '').trim();
  const profiles = registry.filter((p) => p.kind === 'profile' && p.slug !== slug).sort((a, b) => a.name.localeCompare(b.name));
  let draft = null;   // {was, term, meaning, profile, confirmRemove}; was === '' for a new row
  const draw = () => {
    const rows = core.tableRows(section.text);
    for (const fix of pendingFixes(key)) {
      const at = rows.findIndex((r) => r.key.toLowerCase() === (fix.was || fix.term).toLowerCase());
      if (fix.remove) { if (at >= 0) rows.splice(at, 1); continue; }
      const row = { term: fix.term, key: fix.term, meaning: fix.meaning, status: 'confirmed', pending: true, profile: fix.profile || '' };
      if (at >= 0) rows[at] = row; else rows.push(row);
    }
    const form = () => {
      const d = draft;
      const send = async (button, data) => { if (await sendFix(button, key, data, () => core.correctRow(repo, slug, target, data))) draft = null; draw(); };
      const pick = target === 'people' ? h('select', { 'aria-label': 'Profile', onchange: (e) => { d.profile = e.target.value; } },
        h('option', { value: '', selected: !d.profile }, 'No profile'),
        profiles.map((p) => h('option', { value: p.slug, selected: d.profile === p.slug }, p.name)),
        h('option', { value: '\u0000new', selected: d.profile === '\u0000new' }, 'Create a profile for this name')) : null;
      return h('form', { class: 'fixedit', onsubmit: (e) => {
        e.preventDefault();
        const term = d.term.trim(), meaning = d.meaning.trim();
        if (!term) { toast(`Give the ${words.one} first.`); return; }
        if (target === 'contact' && !meaning) { toast('Give the value first. To delete a detail, use Remove.'); return; }
        if (rows.some((r) => r.key.toLowerCase() === term.toLowerCase() && r.key.toLowerCase() !== d.was.toLowerCase())) { toast(`"${term}" is already in the list.`); return; }
        const data = { was: d.was, term, meaning };
        if (target === 'people') {
          if (d.profile === '\u0000new') data.newProfile = true;
          else data.profile = d.profile;
        }
        send(e.submitter || e.target.querySelector('button'), data);
      } },
        h('label', {}, words.first, h('input', { type: 'text', value: d.term, autocapitalize: 'off', list: target === 'contact' ? 'contact-fields' : null, oninput: (e) => { d.term = e.target.value; } })),
        target === 'contact' ? h('datalist', { id: 'contact-fields' }, core.CONTACT_FIELDS.map((f) => h('option', { value: f }))) : null,
        h('label', {}, words.second, h('textarea', { rows: 2, oninput: (e) => { d.meaning = e.target.value; } }, d.meaning)),
        pick ? h('label', {}, 'Profile', pick) : null,
        pick ? h('p', { class: 'help' }, 'Links the name to the profile of this person or organization, where their contact details are kept.') : null,
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
          h('button', { class: 'btn', type: 'button', onclick: () => { draft = null; draw(); } }, 'Cancel'),
          d.was ? h('button', { class: 'btn danger', type: 'button', onclick: (e) => {
            if (!d.confirmRemove) { d.confirmRemove = true; e.target.textContent = 'Tap again to remove'; return; }
            send(e.target, { was: d.was, remove: true });
          } }, 'Remove') : null));
    };
    const editingRow = (r) => draft && draft.was && draft.was.toLowerCase() === r.key.toLowerCase();
    const download = target === 'contact' && rows.length ? h('button', { class: 'btn', type: 'button', onclick: () => {
      const blob = new Blob([core.vcardFor(topic.name || slug, rows)], { type: 'text/vcard' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `${(topic.name || slug).replace(/[^\w\- ]+/g, '_')}.vcf` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    } }, 'Download contact') : null;
    fill(box,
      h('h2', {}, section.name),
      rows.length ? h('div', { class: 'md' }, h('div', { class: 'tablewrap' }, h('table', { class: 'fixtable' },
        h('thead', {}, h('tr', {}, h('th', {}, words.first), h('th', {}, words.second), h('th', {}, 'Status'), h('th', {}, h('span', { class: 'sr' }, 'Edit')))),
        h('tbody', {}, rows.map((r) => (editingRow(r) ? h('tr', {}, h('td', { colspan: 4 }, form()))
          : h('tr', { class: r.pending ? 'pendingrow' : null },
            h('td', {}, renderMarkdown(r.term, path)), h('td', {}, renderMarkdown(target === 'contact' ? callable(r) : r.meaning, path)),
            h('td', {}, renderMarkdown(r.status, path), r.pending ? h('span', { class: 'chip' }, 'pending') : null),
            h('td', {}, editButton(`Edit ${r.key}`, () => { draft = { was: r.key, term: r.key, meaning: plain(r.meaning), profile: r.profile || '' }; draw(); box.querySelector('.fixedit textarea').focus(); })))))))))
        : h('p', { class: 'muted' }, target === 'contact' ? 'No contact details yet. Add them here, add a contact card (.vcf) with Add a note, or forward an email from them.' : 'Nothing here yet.'),
      draft && !draft.was ? form() : h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: () => { draft = { was: '', term: '', meaning: '', profile: '' }; draw(); box.querySelector('.fixedit input').focus(); } }, words.add),
        download));
  };
  draw();
  return box;
}

/** A Contact row's value with a phone number made tappable (tel: link). */
function callable(r) {
  const value = core.cellText(r.meaning);
  const digits = value.replace(/[^\d+]/g, '');
  return /^Phone/i.test(r.key) && !/^Phone \((work |home )?fax\)/i.test(r.key) && digits.length >= 7 && !/\]\(tel:/.test(r.meaning)
    ? r.meaning.replace(value, `[${value}](tel:${digits})`) : r.meaning;
}

/** On a profile: the topics whose people tables link to it (generated by the ingest script), and a way to add one. */
function linkedBlock(slug, section, path) {
  const key = `linked:${slug}`;
  const box = h('section', { class: 'fixable' });
  let draft = null;   // {topic, role} while adding
  const draw = () => {
    const text = section.text.replace(/<!--[\s\S]*?-->/g, '').trim();
    const pending = pendingFixes(key).filter((f) => !text.includes(`](../${f.topic}/project.md)`));
    const topics = registry.filter((p) => p.slug !== slug).sort((a, b) => a.name.localeCompare(b.name));
    fill(box,
      h('h2', {}, 'Linked from'),
      text ? renderMarkdown(text, path) : (pending.length ? null : h('p', { class: 'muted' }, 'Not listed under People and suppliers in any topic yet.')),
      pending.length ? h('ul', {}, pending.map((f) => h('li', { class: 'pendingrow' }, (registry.find((p) => p.slug === f.topic) || { name: f.topic }).name,
        f.role ? `: ${f.role}` : '', ' ', h('span', { class: 'chip' }, 'pending')))) : null,
      draft ? h('form', { class: 'fixedit', onsubmit: async (e) => {
        e.preventDefault();
        if (!draft.topic) { toast('Choose a topic first.'); return; }
        const data = { topic: draft.topic, role: draft.role.trim() };
        if (await sendFix(e.submitter || e.target.querySelector('button'), key, data, () => core.linkProfile(repo, slug, data.topic, data.role))) draft = null;
        draw();
      } },
        h('label', {}, 'Topic', h('select', { onchange: (e) => { draft.topic = e.target.value; } },
          h('option', { value: '' }, 'Choose a topic'),
          topics.map((p) => h('option', { value: p.slug, selected: draft.topic === p.slug }, p.name)))),
        h('label', {}, 'Role in that topic (optional)', h('input', { type: 'text', value: draft.role, placeholder: 'For example: Onsite GC contact', oninput: (e) => { draft.role = e.target.value; } })),
        h('p', { class: 'help' }, 'Lists this profile under People and suppliers on that topic, linked back here. If the name is already listed there, it is linked.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', type: 'submit' }, 'Add'),
          h('button', { class: 'btn', type: 'button', onclick: () => { draft = null; draw(); } }, 'Cancel')))
        : h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => { draft = { topic: '', role: '' }; draw(); box.querySelector('.fixedit select').focus(); } }, 'Add to a topic')));
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
  const trail = [{ href: '#/', label: 'Topics' }];
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

const instructed = new Map();   // health item key or 'project:<slug>' -> [record ids] sent from this device

/** A box for telling the model what to change, and links to the results of what was sent. */
function instructBox(slug, key, finding, placeholder, extra = null) {
  const box = h('div', { class: 'instruct' });
  let draft = '';
  const draw = () => {
    const sent = instructed.get(key) || [];
    const area = h('textarea', { rows: 2, placeholder, 'aria-label': 'Instruction', oninput: (e) => { draft = e.target.value; } }, draft);
    fill(box,
      finding && sent.length ? null : area,
      sent.map((id) => h('p', { class: 'help pending' }, 'Instruction sent. ',
        h('a', { href: '#/page/raw/' + id + '/source.md' }, 'What changed'), ' shows once GitHub has applied it.' + (finding ? ' This item drops off when the check confirms the fix.' : ''))),
      h('div', { class: 'row' }, finding && sent.length ? null : h('button', { class: 'btn primary', type: 'button', onclick: async (e) => {
        if (!draft.trim()) { toast('Type the instruction first.'); return; }
        e.target.disabled = true;
        try {
          const id = await core.instructWiki(repo, slug, draft, finding);
          instructed.set(key, [...sent, id]);
          draft = '';
          toast('Sent. The changes are made on GitHub within a few minutes.', 6000);
          refreshChrome().catch(() => {});
        } catch (err) { toast(`Could not send: ${err.message}`, 7000); }
        draw();
      } }, 'Send instruction'), extra));
  };
  draw();
  return box;
}

// ---------- ask ----------

const askThreads = new Map();   // '*' or a project slug -> {turns: [{q, a, cost, error, saved}], busy}
const ASK_FALLBACK = 'Answer the owner\'s questions from his wiki, given below. Link every fact to the file it comes from, using the path in its "=== FILE:" line.';

function askHistory() { return store.get('ask', []); }
function rememberAsk(scope, turns) {
  const list = askHistory().filter((x) => !(x.scope === scope && x.turns[0] && x.turns[0].q === turns[0].q));
  list.unshift({ scope, at: new Date().toISOString(), turns: turns.filter((t) => t.a).map(({ q, a, cost, saved }) => ({ q, a, cost, saved })) });
  store.set('ask', list.slice(0, 30));
}

async function askScreen(slug) {
  slug = slug || '';
  const name = slug ? ((registry.find((x) => x.slug === slug) || {}).name || slug) : '';
  const ai = store.get('ai', {});
  const scope = slug || '*';
  const title = name ? `Ask about ${name}` : 'Ask the wiki';
  const trail = [{ href: '#/', label: 'Topics' }, ...(name ? [{ href: '#/p/' + slug, label: name }] : []), { label: 'Ask' }];
  if (!ai.key) {
    fill(view, crumb(...trail), h('h1', {}, title),
      h('p', {}, 'Ask sends your question and the wiki to a model straight from this device. It needs an Anthropic API key (or an OpenRouter key), stored only in this browser.'),
      h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/setup' }, 'Add the key in Settings')));
    return;
  }
  if (!askThreads.has(scope)) askThreads.set(scope, { turns: [], busy: false });
  const thread = askThreads.get(scope);
  const box = h('div', { class: 'ask' });
  let draft = '';

  const send = async (q) => {
    q = q.trim();
    if (!q || thread.busy) return;
    thread.turns.push({ q });
    thread.busy = true;
    draft = '';
    draw();
    const turn = thread.turns[thread.turns.length - 1];
    try {
      const [settings, system] = await Promise.all([core.askSettings(repo), repo.text('tools/prompts/ask.md')]);
      const context = await core.askContext(repo, slug || null, settings.maxChars);
      const out = await core.askModel({ key: ai.key, model: ai.model || settings.model, system: system || ASK_FALLBACK,
        context: context.text, turns: thread.turns, scope: name, anthropic: settings.anthropic });
      turn.a = out.text; turn.cost = out.cost; turn.dropped = context.dropped;
      rememberAsk(scope, thread.turns);
    } catch (e) { turn.error = e.message || String(e); }
    thread.busy = false;
    if (location.hash === (slug ? `#/ask/${slug}` : '#/ask')) draw();
  };

  const turnView = (t, i) => {
    const saveBtn = t.a && !t.saved ? h('button', { class: 'btn', type: 'button', onclick: async (e) => {
      e.target.disabled = true;
      try {
        t.saved = await core.saveAnswer(repo, thread.turns.slice(0, i + 1), slug || null);
        rememberAsk(scope, thread.turns);
        toast('Saved. It becomes a record in the wiki within a minute or two.', 6000);
        refreshChrome().catch(() => {});
        draw();
      } catch (err) { e.target.disabled = false; toast(`Could not save: ${err.message}`, 7000); }
    } }, 'Save to wiki') : null;
    return h('div', { class: 'turn' },
      h('p', { class: 'askq' }, t.q),
      t.error ? h('div', { class: 'error' }, h('p', {}, t.error),
        i === thread.turns.length - 1 ? h('button', { class: 'btn', type: 'button', onclick: () => { thread.turns.pop(); send(t.q); } }, 'Try again') : null)
        : t.a ? h('div', { class: 'aska' },
          renderMarkdown(t.a, 'ask.md'),
          h('p', { class: 'help' }, (t.cost ? `Cost: $${t.cost.toFixed(4)}. ` : '') + (t.dropped ? `${t.dropped} older files were left out to fit the size limit. ` : '')),
          t.saved ? h('p', { class: 'help' }, 'Saved: ', h('a', { href: `#/page/raw/${t.saved}/source.md` }, 'the record'), ' appears once GitHub has added it.') : null,
          h('div', { class: 'row' }, saveBtn),
          slug && i === thread.turns.length - 1 ? h('details', { class: 'askfix' }, h('summary', {}, 'Change the wiki based on this'),
            instructBox(slug, `ask:${slug}:${thread.turns.length}`, null, 'Say what to change, for example: mark T-030 done')) : null)
        : h('p', { class: 'muted thinking' }, 'Reading the wiki and thinking…'));
  };

  const draw = () => {
    const history = askHistory().filter((x) => x.scope === scope);
    const area = h('textarea', { rows: 3, 'aria-label': 'Question', placeholder: thread.turns.length ? 'Ask a follow-up question' : (name ? `Ask anything about ${name}` : 'Ask anything in your wiki'),
      oninput: (e) => { draft = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(draft); } } }, draft);
    fill(box,
      thread.turns.map(turnView),
      h('form', { class: 'askform', onsubmit: (e) => { e.preventDefault(); send(draft); } },
        area,
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', type: 'submit', disabled: thread.busy }, thread.turns.length ? 'Ask again' : 'Ask'),
          thread.turns.length ? h('button', { class: 'btn', type: 'button', disabled: thread.busy, onclick: () => { thread.turns = []; draft = ''; draw(); } }, 'New question') : null)),
      !thread.turns.length && history.length ? [h('h2', {}, 'Asked on this device'),
        h('ul', { class: 'asklist' }, history.slice(0, 10).map((x) => h('li', {}, h('a', { href: '#', onclick: (e) => {
          e.preventDefault(); thread.turns = x.turns.map((t) => ({ ...t })); draw(); window.scrollTo(0, 0);
        } }, x.turns[0].q), h('span', { class: 'muted' }, ` ${x.at.slice(0, 10)}`))))] : null);
    loadImages(box);
  };
  fill(view, crumb(...trail), h('h1', {}, title),
    h('p', { class: 'muted' }, 'Answers come from the wiki and the notes behind it, with links. They stay on this device unless you save them.'),
    box);
  draw();
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
    let box = null;
    const leave = h('button', { class: 'btn', type: 'button', onclick: async (e) => {
      e.target.disabled = true;
      try {
        await core.ignoreFinding(repo, item);
        box.remove();
        toast('Left as is. It will not be raised again.');
      } catch (err) { e.target.disabled = false; toast(`Could not save: ${err.message}`, 7000); }
    } }, 'Leave as is');
    box = h('div', { class: 'qcard health' },
      h('p', {}, h('b', {}, item.kind)),
      renderMarkdown(item.text, 'wiki/health.md'),
      item.project ? instructBox(item.project, item.key, item, 'Tell the model how to fix it, for example: drop T-022, it is the same as T-013', leave)
        : h('div', { class: 'row' }, leave));
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
    crumb({ href: '#/', label: 'Topics' }, { label: 'Questions' }),
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
  const fresh = drafts.get(`${q.raw}|new`) || [];     // [{name, number, kind}] topics to create
  drafts.set(`${q.raw}|new`, fresh);
  const guess = registry.find((p) => p.name === q.guess);

  let selects = [];
  const names = () => fresh.map((p) => p.name.trim()).filter(Boolean);
  // A new topic's name changed: update the pickers in place, leaving the fields being typed in alone.
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
    selects = items.map((it, i) => h('select', { 'aria-label': `Topic for line ${i + 1}`, onchange: (e) => { it.to = e.target.value; drafts.set(`${q.raw}|to${i}`, it.to); } }, options(it)));
    fill(body,
      guess ? h('p', { class: 'help' }, `Best guess for some of these: ${guess.name}.`) : null,
      items.map((it, i) => h('div', { class: 'assign' },
        h('pre', { class: 'lines' }, it.text),
        selects[i])),
      fresh.length ? h('p', { class: 'help' }, 'New topics. Name one, then pick it for its lines above.') : null,
      fresh.map((p, i) => h('div', { class: 'newproj' },
        h('input', { type: 'text', placeholder: 'New topic name', 'aria-label': 'New topic name', value: p.name, oninput: (e) => { p.name = e.target.value; refresh(); } }),
        h('input', { type: 'text', placeholder: 'Number (optional)', 'aria-label': 'Number or other alias', inputmode: 'numeric', value: p.number, oninput: (e) => { p.number = e.target.value; } }),
        (() => { const k = kindSelect(`q${q.n}-kind${i}`, p.kind || 'project'); k.addEventListener('change', () => { p.kind = k.value; }); return k; })(),
        h('button', { class: 'btn small', type: 'button', 'aria-label': 'Remove this new topic', onclick: () => { fresh.splice(i, 1); draw(); } }, 'Remove'))),
      h('div', { class: 'row tight' }, h('button', { class: 'btn small', type: 'button', onclick: () => { fresh.push({ name: '', number: '', kind: 'project' }); draw(); const rows = body.querySelectorAll('.newproj'); rows[rows.length - 1].querySelector('input').focus(); } }, 'Add a new topic')),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', onclick: (e) => {
          const missing = items.findIndex((it) => !it.to);
          if (missing >= 0) { toast(`Choose where line ${missing + 1} goes first.`); return; }
          const used = fresh.filter((p) => items.some((it) => it.to === 'new:' + p.name.trim()));
          submit(e.target, () => core.assignLines(repo, q, items.map((it) => ({ text: it.text, to: it.to })),
            used.map((p) => ({ name: p.name.trim(), kind: p.kind || 'project', aliases: p.number.split(',').map((x) => x.trim()).filter(Boolean) }))), 'Filing the lines.');
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
    // Pick an existing topic, or "New topic…" to name one and file the note under it in one go.
    const NEW = '__new';
    const select = h('select', { id: `q${q.n}-project`, 'aria-label': 'Topic' },
      registry.map((p) => h('option', { value: p.slug, selected: p.name === q.guess }, p.name)),
      h('option', { value: NEW }, 'New topic…'));
    const name = h('input', { type: 'text', id: `q${q.n}-name` });
    const kind = kindSelect(`q${q.n}-kind`);
    const desc = h('textarea', { id: `q${q.n}-desc`, placeholder: 'One or two sentences about the topic (optional)' });
    const fresh = h('div', { hidden: true },
      h('label', { for: name.id }, 'Topic name'), name,
      h('label', { for: kind.id }, 'Kind'), kind, h('p', { class: 'help' }, KIND_HELP),
      h('label', { for: desc.id }, 'Description'), desc);
    const go = h('button', { class: 'btn primary', type: 'button', onclick: (e) => {
      if (select.value !== NEW) { submit(e.target, () => core.fileNote(repo, q, select.value), 'Filing it.'); return; }
      const wanted = name.value.trim();
      if (!wanted) { toast('Give the topic a name first.'); return; }
      const same = registry.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
      if (same) { submit(e.target, () => core.fileNote(repo, q, same.slug), 'Filing it.'); return; }
      submit(e.target, () => core.fileNote(repo, q, '', { name: wanted, desc: desc.value, kind: kind.value }), 'Creating the topic and filing it.');
    } }, 'File under this topic');
    const sync = () => {
      const making = select.value === NEW;
      fresh.hidden = !making;
      go.textContent = making ? 'Create topic and file' : 'File under this topic';
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
    const kind = kindSelect(`q${q.n}-kind`);
    const desc = h('textarea', { id: `q${q.n}-desc`, placeholder: 'One or two sentences about the topic (optional)' });
    add(card, 
      h('label', { for: name.id }, 'Topic name'), name,
      h('label', { for: kind.id }, 'Kind'), kind, h('p', { class: 'help' }, KIND_HELP),
      h('label', { for: number.id }, 'Number or other alias'), number,
      h('label', { for: desc.id }, 'Description'), desc,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', onclick: (e) => {
          if (!name.value.trim()) { toast('Give the topic a name first.'); return; }
          submit(e.target, () => core.createProject(repo, { name: name.value.trim(), kind: kind.value, aliases: number.value.split(',').map((s) => s.trim()).filter(Boolean), desc: desc.value }, q), 'Creating the topic.');
        } }, 'Create topic'),
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
  const file = h('input', { type: 'file', id: 'note-file', accept: 'image/*,application/pdf,.txt,.md,.eml,message/rfc822,.vcf,text/vcard,text/x-vcard' });
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
        h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/add' + (proj.value ? '/' + proj.value : '') }, 'Add another'), h('a', { class: 'btn', href: '#/' }, 'Back to topics')));
      refreshChrome();
    } catch (e) {
      go.disabled = false;
      go.textContent = 'Add to the wiki';
      toast(`Upload failed: ${e.message}`, 7000);
    }
  });
  fill(view, 
    crumb({ href: '#/', label: 'Topics' }, { label: 'Add note' }),
    h('h1', {}, 'Add a note'),
    h('label', { for: 'note-file' }, 'Photo, screenshot, PDF, text file, saved email (.eml) or contact card (.vcf)'), file,
    h('p', { class: 'help' }, 'On a phone this offers the camera, your photo library and Files. An email keeps its attachments: save it as a .eml file (Gmail: ⋮ > Download message; Outlook.com: ⋯ menu, then save or download). A contact card fills in that person\'s profile, creating it if needed; choose a topic to list them there too.'),
    h('label', { for: 'note-text' }, 'Typed note'), typed,
    h('label', { for: 'note-project' }, 'Topic'), proj,
    h('label', { for: 'note-caption' }, 'Caption (optional)'), caption,
    h('p', { class: 'help' }, 'A caption helps most with sketches that have no writing on them.'),
    h('div', { class: 'row' }, go),
  );
}

async function newProject() {
  await refreshChrome();
  const name = h('input', { type: 'text', id: 'np-name' });
  const alias = h('input', { type: 'text', id: 'np-alias', placeholder: 'For example: 25014, Lobby piece' });
  const kind = kindSelect('np-kind');
  const desc = h('textarea', { id: 'np-desc', placeholder: 'One or two sentences. This is given to the AI every time it reads a note for this topic.' });
  const go = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    if (!name.value.trim()) { toast('Give the topic a name first.'); return; }
    go.disabled = true;
    try {
      const path = await core.createProject(repo, { name: name.value.trim(), kind: kind.value, aliases: alias.value.split(',').map((s) => s.trim()).filter(Boolean), desc: desc.value });
      addPending(path, '');
      fill(view, h('h1', {}, 'Topic requested'), h('p', {}, `"${name.value.trim()}" will appear in the list within a minute or two.`),
        h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/' }, 'Back to topics')));
      refreshChrome();
    } catch (e) { go.disabled = false; toast(`Could not send: ${e.message}`, 7000); }
  } }, 'Create topic');
  fill(view, 
    crumb({ href: '#/', label: 'Topics' }, { label: 'New topic' }),
    h('h1', {}, 'New topic'),
    h('label', { for: 'np-name' }, 'Name'), name,
    h('label', { for: 'np-kind' }, 'Kind'), kind, h('p', { class: 'help' }, KIND_HELP),
    h('label', { for: 'np-alias' }, 'Number and other names, separated by commas'), alias,
    h('label', { for: 'np-desc' }, 'Description'), desc,
    h('div', { class: 'row' }, go),
  );
}

const field = (id, label, value, type = 'text', help) => [h('label', { for: id }, label), h('input', { type, id, value: value || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }), help ? h('p', { class: 'help' }, help) : null];

function setup(message) {
  const cfg = store.get('cfg', {});
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
      cfg.token ? h('button', { class: 'btn danger', type: 'button', onclick: () => { ['cfg', 'pending', 'seen', 'ai', 'ask'].forEach((k) => localStorage.removeItem('kmwiki.' + k)); repo = null; setup('This device has been disconnected.'); } }, 'Disconnect this device') : null),
    cfg.token ? askSettingsSection() : null,
    aboutApp(),
  );
}

function askSettingsSection() {
  const ai = store.get('ai', {});
  const save = h('button', { class: 'btn', type: 'button', onclick: () => {
    const key = document.getElementById('s-orkey').value.trim();
    const model = document.getElementById('s-ormodel').value.trim();
    store.set('ai', { ...(key ? { key } : {}), ...(model ? { model } : {}) });
    toast(key ? 'Saved. Ask is ready on this device.' : 'Key removed from this device.');
  } }, 'Save');
  return h('section', { class: 'about' },
    h('h2', {}, 'Ask'),
    h('p', { class: 'help' }, 'Ask calls a model from this device. The key is stored only in this browser. An Anthropic key (starting sk-ant-, from console.anthropic.com) calls Claude directly; any other key is used with OpenRouter. Making a key just for this lets you revoke it on its own.'),
    field('s-orkey', 'API key (Anthropic or OpenRouter)', ai.key || '', 'password'),
    field('s-ormodel', 'Model (optional)', ai.model || '', 'text', 'Leave empty to use ask_model from tools/ingest_config.json (Claude Haiku 5.5 unless changed). For example anthropic/claude-sonnet-5.5 for harder questions, at a higher cost.'),
    h('div', { class: 'row' }, save));
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
    else if (hash === 'ask' || hash.startsWith('ask/')) await askScreen(hash.slice(4));
    else if (hash === 'new') await newProject();
    else if (hash === 'add' || hash.startsWith('add/')) await addNote(hash.slice(4));
    else if (hash.startsWith('p/')) await project(hash.slice(2));
    else if (hash.startsWith('page/')) await page(hash.slice(5));
    else await home();
    lastSignature = await signature();
    if (scroll) window.scrollTo(0, 0);
  } catch (e) {
    fill(view, h('div', { class: 'error' }, h('p', {}, e.message || String(e)),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/' }, 'Topics'), h('a', { class: 'btn', href: '#/setup' }, 'Settings'))));
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
  if ([...view.querySelectorAll('.instruct textarea')].some((t) => t.value.trim())) return;   // an instruction is being typed
  if (location.hash.startsWith('#/ask')) return;   // the conversation lives on this screen only
  try {
    await repo.tree(true);
    const now = await signature();
    if (now !== lastSignature) route(false);
  } catch { /* offline or rate limited: try again next time */ }
}, 20000);

window.addEventListener('hashchange', () => route());
route();
