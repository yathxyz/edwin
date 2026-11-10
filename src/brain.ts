/* Nodes from brain (docs/steps.md, "Nodes from brain"). brain is the graph that holds what the notes are (their
   Org ids, titles, aliases and links, sent by edwind's projector) beside tasks, memories and references. Here
   Edwin finds a node by name, links to one, opens one and lists what links to the note at point.

   A frame holds no token: it asks edwind (server/brain.mts), with the commands brain-titles and brain-node.
   So there is a brain only where Edwin is attached to an edwind that reads one; everywhere else the commands
   say why not, in a sentence.

   A note opens as its file, with point on its entry. Anything else opens as a record: a read-only buffer in
   brain-mode, written as Org so its links are links. The backlinks of the note at point are such a buffer too,
   in a side window that follows point. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks, EC = globalThis.EvilCore;
const { intern, signal, CMD } = L;
const cur = () => E.current;
const { bol, eol } = Ed;

/* A row of brain-titles: ALIAS is the alias that matched when the title did not, ORG_ID the node's Org id when
   it has one, PATH the file of a note under the notes root. */
interface BrainRow { id: string; kind: string; title: string; alias: string | null; scope: string; org_id: string | null; path: string | null }
/* A link of a node, as brain-node lists it: REL is the edge type, or its inverse name on a link that arrives. */
interface BrainLink { rel: string; id: string; kind: string; title: string }
interface BrainNode {
  id: string; kind: string; title: string; body: string | null; props: Record<string, unknown> | null; scope: string; trust: string;
  identifiers: { scheme: string; value: string }[]; links: BrainLink[];
}
interface BrainReply { value?: unknown; error?: { condition: string; report: string } }

/* ---------- asking ---------- */
const attached = () => !!(Ed.sync && Ed.sync.started);
/* One question to brain, through edwind. The answer, or why there is none: edwind's own words when it has
   some (no token to read with, brain unreachable, brain's refusal). */
async function reply(cmd: string, arg: unknown): Promise<BrainReply> {
  if (!attached()) return { error: { condition: 'brain-unavailable', report: 'No brain here: this Edwin is not attached to edwind' } };
  const r = await Ed.sync.call({ cmd, args: [arg] });
  if (!r.error) return { value: r.value };
  return { error: { condition: r.error.condition, report: r.error.condition === 'offline' ? 'Not connected to edwind' : r.error.report || r.error.condition } };
}
async function ask(cmd: string, arg: unknown): Promise<unknown> {
  const r = await reply(cmd, arg);
  if (r.error) signal('user-error', r.error.report);
  return r.value;
}
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
/* As many names as the minibuffer can show at once and narrow from. */
const LIMIT = 50;
async function titles(q: string, kind?: string): Promise<BrainRow[]> {
  const v = await ask('brain-titles', kind ? { q, kind, limit: LIMIT } : { q, limit: LIMIT });
  const rows = isObj(v) && Array.isArray(v.results) ? v.results : [];
  return rows.filter((r): r is BrainRow => isObj(r) && typeof r.id === 'string' && typeof r.kind === 'string' && typeof r.title === 'string');
}
/* The row of ROWS whose title, or the alias that matched, is TEXT whatever the case; null with none. */
function named(rows: BrainRow[], text: string) {
  const t = text.toLowerCase();
  return rows.find(r => r.title.toLowerCase() === t || (r.alias || '').toLowerCase() === t) || null;
}
const titled = async (text: string, kind?: string) => named(await titles(text, kind), text);
/* The node REF: brain's id of it, or scheme:value (org-id:ID). */
async function node(ref: string): Promise<BrainNode> {
  const v = await ask('brain-node', ref);
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.title !== 'string') signal('user-error', 'brain answered with something that is not a node');
  const n = v as unknown as BrainNode;
  return { ...n, identifiers: Array.isArray(n.identifiers) ? n.identifiers.filter(isObj) : [], links: linksOf(n) };
}
const linksOf = (n: { links?: unknown }): BrainLink[] =>
  (Array.isArray(n.links) ? n.links : []).filter((l): l is BrainLink => isObj(l) && typeof l.rel === 'string' && typeof l.id === 'string' && typeof l.title === 'string');
const orgId = (n: BrainNode) => { const i = n.identifiers.find(x => x.scheme === 'org-id'); return i && typeof i.value === 'string' ? i.value : null; };
/* The reference of the note whose title or alias is TITLE; null with none, and where there is no edwind to ask:
   only brain knows the notes by their titles. */
async function noteTitled(title: string) { const r = attached() ? await titled(title, 'note') : null; return r ? r.id : null; }

/* ---------- reading a node in the minibuffer ---------- */
/* A title on one line: a line break or a control character would break a candidate or a heading. */
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
/* A title as the text of a link: a bracket would end the link early, or start another. */
const linkText = (s: string) => oneLine(s).replace(/\[/g, '(').replace(/\]/g, ')');
/* The candidates for ROWS, in brain's order. A row goes by the alias that matched, else by its title, so the
   minibuffer's own filter keeps what brain matched. Each label names one row: where two rows share one they
   take their kind, and where that is shared too, the end of their id. */
function labelRows(rows: BrainRow[]) {
  const count = (ls: string[]) => { const n = new Map<string, number>(); for (const l of ls) n.set(l, (n.get(l) || 0) + 1); return n; };
  const base = rows.map(r => oneLine(r.alias || r.title)), shared = count(base);
  const kinded = base.map((l, i) => (shared.get(l)! > 1 ? `${l} (${rows[i].kind})` : l)), still = count(kinded);
  const labels: string[] = [], by = new Map<string, BrainRow>();
  kinded.forEach((l, i) => {
    const label = still.get(l)! > 1 ? `${base[i]} (${rows[i].kind} ${rows[i].id.replace(/[^0-9a-f]/gi, '').slice(-8)})` : l;
    if (!by.has(label)) { by.set(label, rows[i]); labels.push(label); }
  });
  return { labels, by };
}
/* The kind, then where a note is (and its title, when the candidate is an alias) or the scope of anything else. */
const annotation = (r: BrainRow | undefined) => (!r ? '' : r.kind.padEnd(10) + ' ' + (r.kind === 'note' ? (r.path || '') + (r.alias ? `  → ${oneLine(r.title)}` : '') : r.scope || ''));
/* Typing pauses this long before brain is asked again. */
const DEBOUNCE_MS = 120;
/* Read a node: the candidates are brain's names for the input, asked for again as it changes (empty: the nodes
   changed last). The completer answers with the rows of the last answer. While they are the answer for the input
   shown they are shown as brain gave them, since brain matched them and the minibuffer's own filter reads
   capitals and regexp characters otherwise; meanwhile the minibuffer filters them. An answer replaces them when
   it is for the input still shown, and one that is not is dropped.
   The answer is the row picked, or the text when it names none: one last question finds the row whose title is
   exactly that text. RET typed ahead of brain's answer picks nothing from the names of an earlier input: brain
   is asked for what was typed, and the row is the one titled exactly so, else the first, as RET on the
   candidates would have taken. */
async function readNode(prompt: string, initial: string): Promise<{ row: BrainRow | null; text: string }> {
  let shown = labelRows(await titles(initial)), answered = initial, typed = initial, timer = 0;
  /* Whether the candidates are for the input: brain's answer for it, or the input is one of them, completed. */
  const current = () => typed === answered || shown.by.has(typed);
  const onChange = (text: string) => {
    const m = E.mini;
    typed = text; clearTimeout(timer);
    if (!m || current()) return;
    timer = setTimeout(() => {
      titles(text).then(rows => {
        if (E.mini !== m || E.minibuf.text !== text) return;
        /* A candidate the highlight was moved to stays highlighted where the new answer has it. */
        const c = m.cache, held = c && m.index > 0 && m.index < c.length ? c[m.index] : null;
        shown = labelRows(rows); answered = text;
        /* The minibuffer caches the candidates by input: these are new ones for the same input. */
        m.cache = null; m.scroll = 0; if (m.index > 0) m.index = Math.max(0, held === null ? 0 : shown.labels.indexOf(held));
        Ed.scheduleRender();
      }, e => { if (E.mini === m) { E.miniFlash = ` [${Ed.errorText(e)}]`; Ed.scheduleRender(); } });
    }, DEBOUNCE_MS);
  };
  let text: string;
  try { text = (await Ed.readMini(prompt, initial, () => shown.labels, { kind: 'brain-node', keepOrder: true, filtered: t => t === answered, annotate: l => annotation(shown.by.get(l)), onChange })); }
  finally { clearTimeout(timer); }
  if (current()) return { row: shown.by.get(text) || (text.trim() ? await titled(text.trim()) : null), text: text.trim() };
  const name = typed.trim(), rows = name ? await titles(name) : [];
  return { row: named(rows, name) || rows[0] || null, text: name };
}

/* ---------- a node as a buffer ---------- */
Ed.MODE_NAMES['brain-mode'] = 'Brain';
CMD('brain-mode', '', '', 'Switch the current buffer to Brain mode.', () => Ed.switchMajorMode(cur(), 'brain-mode'));
/* TEXT in the read-only brain buffer B, which shows WHAT. */
function show(b: EdBuffer, text: string, what: unknown) {
  b.mode = 'brain-mode'; b.readOnly = true; b.evilState = 'motion';
  if (b.text !== text) { b.text = text; b.pt = Math.min(b.pt, b.rope.length); b.modified = false; b.undo = []; b.redo = []; }
  b.brain = what;
}
/* The links of a node as Org: a heading per relation in the order brain gives them, then a heading per node
   with its kind. FIRST names a relation that comes first, and is there with none, under the heading AS. */
function linkLines(links: BrainLink[], first?: { rel: string; as: string }) {
  const by = new Map<string, BrainLink[]>();
  if (first) by.set(first.rel, []);
  for (const l of links) { if (!by.has(l.rel)) by.set(l.rel, []); by.get(l.rel)!.push(l); }
  const out: string[] = [];
  for (const [rel, ls] of by) {
    out.push(`* ${first && rel === first.rel ? first.as : oneLine(rel).replace(/_/g, ' ')} (${ls.length})`);
    for (const l of ls) out.push(`** [[brain:${l.id.replace(/[\][\s]/g, '')}][${linkText(l.title) || l.id}]] · ${oneLine(String(l.kind))}`);
  }
  return out;
}
/* A node that is not a file: its title, kind · scope · trust, the props that are plain values, its body, its links. */
function recordText(n: BrainNode) {
  const lines = [`#+title: ${oneLine(n.title)}`, [n.kind, n.scope, n.trust].filter(x => typeof x === 'string' && x).join(' · '), ''];
  const props = Object.entries(n.props || {}).filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');
  for (const [k, v] of props) lines.push(`${oneLine(k)}: ${oneLine(String(v))}`);
  if (props.length) lines.push('');
  /* A line of the body that starts with a star is text here, not a headline. */
  if (typeof n.body === 'string' && n.body.trim()) lines.push(n.body.replace(/\s+$/, '').replace(/^\*/gm, ' *'), '');
  return [...lines, ...linkLines(n.links)].join('\n').replace(/\n+$/, '') + '\n';
}
/* Open the node REF in the selected window. A note that a file holds is that file, with point on the note's
   entry; the visit may have to open the file first, and is waited for. Anything else is its record. */
async function open(ref: string): Promise<EdBuffer | false> {
  const n = await node(ref), src = n.kind === 'note' && n.props && Array.isArray(n.props.sources) ? n.props.sources[0] : null;
  if (typeof src === 'string' && src) {
    const b = await Org.visitNote(src);
    if (!(b instanceof Ed.Buffer)) return false;
    Org.gotoId(b, orgId(n));
    return b;
  }
  const b = Ed.getBufferCreate(`*brain: ${oneLine(n.title) || n.id}*`);
  show(b, recordText(n), { ref: n.id }); b.pt = 0;
  Ed.setWindowBuffer(b);
  return b;
}

/* ---------- the commands ---------- */
const refOf = (x: SchemeValue) => (typeof x === 'string' && x.trim() ? x.trim() : null);
const titleOf = (x: SchemeValue) => { const t = typeof x === 'string' ? x.trim() : ''; if (!t) signal('user-error', 'No title'); return t; };
CMD('brain-node-find', async () => { const { row, text } = await readNode('Node: ', ''); return [row ? row.id : false, row ? row.title : text]; },
  'REF &optional TITLE', 'Open the node REF of brain (its id, or scheme:value such as org-id:ID): a note as its file, anything else as a record. With REF #f, make a note titled TITLE from a template and visit it (SPC n r f).',
  async ([ref, title]: SchemeValue[]) => {
    const r = refOf(ref);
    if (r) { await open(r); return false; }
    const nd = await Org.createNote(titleOf(title)), b = await Org.visitNote(nd.file);
    if (b instanceof Ed.Buffer) b.pt = Math.min(nd.cursor, b.rope.length);
    Ed.message(`New note ${nd.file}`); return false;
  });
CMD('brain-node-insert', async () => {
  const b = cur(); let sel = null;
  if (b.readOnly) signal('buffer-read-only', b);
  if (EC.stateOf(b) === 'visual' && b.mark !== null) { const [s, e] = EC.visualRange(b, true); sel = { s, e, text: b.rope.slice(s, e) }; }
  const { row, text } = await readNode('Node: ', sel ? sel.text : '');
  return [row ? row.id : false, row ? row.title : text, sel ? sel.s + 1 : false, sel ? sel.e + 1 : false, sel ? sel.text : false];
}, 'REF &optional TITLE BEG END DESCRIPTION', 'Insert a link to the node REF of brain: [[id:ID][Title]] to a note with an Org id, [[brain:UUID][Title]] to anything else ([Title](id:ID) in Markdown). With REF #f, a note titled TITLE is made from a template and linked. The text from BEG to END, when given, is replaced, and DESCRIPTION stands for the title (SPC n r i, C-c n i).',
  async ([ref, title, s, e, desc]: SchemeValue[]) => {
    const b = cur(), r = refOf(ref);
    /* Before a note is made for a link that cannot be written. */
    if (b.readOnly) signal('buffer-read-only', b);
    let target: string, name: string;
    if (r) { const n = await node(r), id = orgId(n); target = id ? 'id:' + id : 'brain:' + n.id; name = n.title; }
    else { name = titleOf(title); target = 'id:' + (await Org.createNote(name)).id; }
    const d = linkText(typeof desc === 'string' && desc ? desc : name) || target;
    const text = b.mode === 'markdown-mode' ? `[${d}](${target})` : `[[${target}][${d}]]`;
    if (typeof s === 'number') { Ed.replaceText(b, s - 1, (e as number) - 1, text); b.pt = s - 1 + text.length; } else Ed.insertText(b, text);
    return false;
  });

/* The backlinks: what brain says of the note at point, in a side window on the right. */
const BACKLINKS = '*brain-backlinks*';
/* The Org id the window was last asked to show, the timer of a question not asked yet, and a count that tells
   an answer a later question has overtaken. */
let wanted: string | null = null, pending = 0, asked = 0;
/* A note brain does not know, and a brain that cannot be asked, are said in the buffer: point moving through
   such a note must not raise an error at every step. */
const backlinksText = (id: string, r: BrainReply) =>
  (r.error ? [`#+title: ${id}`, '', r.error.report] : [`#+title: ${oneLine(String((r.value as BrainNode).title))}`, '', ...linkLines(linksOf(r.value as BrainNode), { rel: 'linked from', as: 'Backlinks' })]).join('\n') + '\n';
const noteReply = async (id: string): Promise<BrainReply> => { const r = await reply('brain-node', 'org-id:' + id); return r.error || isObj(r.value) ? r : { error: { condition: 'brain-unavailable', report: 'brain answered with something that is not a node' } }; };
CMD('brain-backlinks', '', '', 'Show what links to the note at point, as brain has it, in a side window that follows point, or hide that window: RET there opens a link, q closes it (SPC n r b, C-c n l).', async () => {
  const rb0 = Ed.getBuffer(BACKLINKS), w0 = rb0 && Ed.windowFor(rb0);
  if (w0) { if (Ed.windowList().length > 1) Ed.deleteWindow(w0); else L.call('quit-window', []); return false; }
  const id = Org.idAtPoint(cur());
  if (!id) signal('user-error', 'No note at point: neither this entry nor its file has an id');
  clearTimeout(pending); const mine = ++asked;
  const r = await noteReply(id!);
  if (r.error && r.error.condition !== 'brain-refused') signal('user-error', r.error.report);
  if (mine !== asked) return false;
  const rb = Ed.getBufferCreate(BACKLINKS);
  show(rb, backlinksText(id!, r), { id }); rb.pt = 0; wanted = id;
  const sel = E.sel, nw = Ed.splitWindow(sel, 'right'); nw.popup = true;
  Ed.setWindowBuffer(rb, nw); Ed.selectWindow(sel!);
  return false;
});
/* The window follows point into another note: asked once point rests, and an answer overtaken is dropped. */
const FOLLOW_MS = 200;
const prevPost = H.postCommand;
H.postCommand = (def, b, failed) => {
  if (prevPost) prevPost(def, b, failed);
  if (E.depth > 0 || E.mini) return;
  const rb = Ed.getBuffer(BACKLINKS), at = E.win;
  if (!rb || !at || at === rb || !Ed.windowFor(rb)) return;
  const id = Org.idAtPoint(at);
  if (!id || id === wanted) return;
  wanted = id;
  clearTimeout(pending);
  pending = setTimeout(() => {
    const mine = ++asked;
    noteReply(id).then(r => { if (mine !== asked || !E.buffers.includes(rb)) return; show(rb, backlinksText(id, r), { id }); Ed.scheduleRender(); });
  }, FOLLOW_MS);
};
CMD('brain-follow', '', '', 'Open the link at point, or the first link of the line (RET in a brain buffer). From the backlinks window it opens in the window beside it.', async () => {
  const b = cur(), r = b.rope, ls = bol(r, b.pt), k = r.slice(ls, eol(r, b.pt)).search(/\[\[|https?:\/\//);
  const lk = Org.linkAt(b, b.pt) || (k >= 0 ? Org.linkAt(b, ls + k) : null);
  if (!lk) signal('user-error', 'No link on this line');
  if (b.name === BACKLINKS) { const ws = Ed.windowList().filter(w => w.buffer !== b), w = ws.find(x => !x.popup) || ws[0]; if (w) Ed.selectWindow(w); }
  await Org.openLink(lk!.target); return false;
});
for (const n of ['brain-node-find', 'brain-node-insert', 'brain-backlinks', 'brain-follow']) L.put(intern(n), 'evil-repeat', intern('abort'));

globalThis.Brain = { open, noteTitled };
})();
