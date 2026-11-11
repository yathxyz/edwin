/* Nodes and tasks from brain (docs/steps.md, "Nodes from brain" and "Tasks from brain"). brain is the graph that
   holds what the notes are (their Org ids, titles, aliases and links, sent by edwind's projector) beside tasks,
   memories and references. Here Edwin finds a node by name, links to one, opens one, lists what links to the
   note at point, shows the agenda and the open tasks, and adds and changes a task.

   A frame holds no token: it asks edwind (server/brain.mts), with the commands brain-titles, brain-node,
   brain-agenda, brain-tasks, brain-task-add, brain-task-set and brain-tasks-follow. So there is a brain only
   where Edwin is attached to an edwind that reads one; everywhere else the commands say why not, in a sentence.

   A note opens as its file, with point on its entry. Anything else opens as a record: a read-only buffer in
   brain-mode, written as Org so its links are links. The backlinks of the note at point are such a buffer too,
   in a side window that follows point. The agenda is a read-only buffer in brain-agenda-mode, a line a task;
   while a window shows it, it follows brain: a task changed anywhere is in it without r. */
(function () {
'use strict';
const L = globalThis.L, Ed = globalThis.Ed, E = Ed.E, H = Ed.hooks, EC = globalThis.EvilCore;
const { intern, signal, CMD } = L;
const cur = () => E.current;
const { bol, eol, lineNoB, lineStartB } = Ed;

/* A row of brain-titles: ALIAS is the alias that matched when the title did not, ORG_ID the node's Org id when
   it has one, PATH the file of a note under the notes root. */
interface BrainRow { id: string; kind: string; title: string; alias: string | null; tags: string[]; org_id: string | null; path: string | null }
/* A link of a node, as brain-node lists it: REL is the edge type, or its inverse name on a link that arrives. */
interface BrainLink { rel: string; id: string; kind: string; title: string }
interface BrainNode {
  id: string; kind: string; title: string; body: string | null; props: Record<string, unknown> | null; tags: string[]; trust: string;
  identifiers: { scheme: string; value: string }[]; links: BrainLink[];
}
interface BrainReply { value?: unknown; error?: { condition: string; report: string } }

/* ---------- asking ---------- */
const attached = () => !!(Ed.sync && Ed.sync.started);
const NO_EDWIND = 'No brain here: this Edwin is not attached to edwind';
/* One question to brain, through edwind. The answer, or why there is none: edwind's own words when it has
   some (no token to read with, brain unreachable, brain's refusal). */
async function reply(cmd: string, ...args: unknown[]): Promise<BrainReply> {
  if (!attached()) return { error: { condition: 'brain-unavailable', report: NO_EDWIND } };
  const r = await Ed.sync.call({ cmd, args });
  if (!r.error) return { value: r.value };
  return { error: { condition: r.error.condition, report: r.error.condition === 'offline' ? 'Not connected to edwind' : r.error.report || r.error.condition } };
}
async function ask(cmd: string, ...args: unknown[]): Promise<unknown> {
  const r = await reply(cmd, ...args);
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
/* A title on one line: a line break or a control character would break a candidate or a heading, and one that
   turns the direction of text would draw a line as another. */
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').trim();
/* A title as the text of a link: a bracket would end the link early, or start another. */
/* The tags of a record as Org writes them, :a:b:, and '' for one that has none. */
const tagsOf = (x: unknown): string[] => (Array.isArray(x) ? x : []).filter((t): t is string => typeof t === 'string').map(oneLine).filter(t => t);
const tagText = (x: unknown) => { const ts = tagsOf(x); return ts.length ? `:${ts.join(':')}:` : ''; };
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
/* The kind, then where a note is (and its title, when the candidate is an alias) or the tags of anything else. */
const annotation = (r: BrainRow | undefined) => (!r ? '' : r.kind.padEnd(10) + ' ' + (r.kind === 'note' ? (r.path || '') + (r.alias ? `  → ${oneLine(r.title)}` : '') : tagText(r.tags)));
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
/* A node that is not a file: its title, kind · :tags: · trust, the props that are plain values, its body, its links. */
function recordText(n: BrainNode) {
  const lines = [`#+title: ${oneLine(n.title)}`, [n.kind, tagText(n.tags), n.trust].filter(x => typeof x === 'string' && x).join(' · '), ''];
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
    /* brain has a note until the projector has read that its file is gone. A visit would make the file
       again, empty, so edwind is asked first whether it is there. */
    const at = await reply('fs-stat', { path: src });
    if (at.error || !isObj(at.value) || !at.value.entry) signal('user-error', `brain has the note "${oneLine(n.title)}" in ${src}, and that file is not there${at.error ? ` (${at.error.report})` : ''}`);
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

/* ---------- tasks ---------- */
/* A task as brain answers it: its node with NUMBER (task:N) and who made it. On a row of the agenda WHY says
   which date put it there, and on an overdue one DAY is that date's day. */
interface BrainTask {
  id: string; title: string; tags: string[]; trust: string; revision: number; number: number | null; props: Record<string, unknown>;
  created_by_title?: unknown; why?: string; day?: string;
}
/* A line of the agenda: its text, the spans of it that have a face (start, end, face) and the task it shows. */
interface AgendaLine { text: string; spans: [number, number, number][]; task?: BrainTask }
type AgendaView = 'week' | 'list';
/* OWN: the window was made for the agenda, so q closes it. STALE: a task changed in brain and the view could
   not be asked for again, so its lines are not what brain has. ASKED: which question to brain it answers,
   counted in `fills`. */
interface Agenda { view: AgendaView; lines: AgendaLine[]; win: EdWinConfig | null; own: boolean; stale: boolean; asked: number }
let fills = 0;
interface AgendaLex { ver: number; from: number; to: number; cls: Uint8Array; names: string[] }
const AGENDA = '*Agenda*';
/* The open states in the order the task list shows them, and the key of each state. */
const OPEN: [string, string][] = [['next', 'Next'], ['todo', 'To do'], ['waiting', 'Waiting'], ['hold', 'Hold'], ['someday', 'Someday']];
const STATE_KEYS: Record<string, string> = { t: 'todo', n: 'next', w: 'waiting', h: 'hold', s: 'someday', d: 'done', c: 'cancelled' };
const DAYS = 7;
/* brain's largest page, and the most tasks the list shows. */
const PAGE = 200, MOST = 2000;
L.defvar('brain-task-tags', '', 'The tags of a task added with brain-task-add: a string of them with spaces between, "" for none.');

/* A task brain holds with no title is a task still: it is shown, with none. */
function tasksOf(x: unknown): BrainTask[] {
  return (Array.isArray(x) ? x : []).filter((t): t is BrainTask => isObj(t) && typeof t.id === 'string' && typeof t.revision === 'number')
    .map(t => ({ ...t, title: typeof t.title === 'string' ? t.title : '', tags: tagsOf(t.tags), props: isObj(t.props) ? t.props : {} }));
}
const taskOf = (x: unknown): BrainTask => { const t = tasksOf([x])[0]; if (!t) signal('user-error', 'brain answered with something that is not a task'); return t; };
const prop = (t: BrainTask, k: string) => { const v = t.props[k]; return typeof v === 'string' ? oneLine(v) : ''; };
const taskState = (t: BrainTask) => prop(t, 'state') || 'todo';
const refOfTask = (t: BrainTask) => (typeof t.number === 'number' ? `task:${t.number}` : 'task');
/* The time of day of a due or scheduled value, as it is written (with its offset when it has one); '' for a day. */
const timeOf = (v: string) => { const m = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})(?::\d{2})?(Z|[+-]\d{2}:\d{2})?$/.exec(v); return m ? m[1] + (m[2] || '') : ''; };
const dayNumber = (ymd: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : NaN; };

/* The faces of an agenda buffer. */
const AF = ['', 'ba-title', 'ba-head', 'ba-today', 'ba-ref', 'ba-label', 'ba-over', 'ba-time', 'ba-state', 'ba-pri', 'ba-tags', 'ba-dim'];
const F = { TITLE: 1, HEAD: 2, TODAY: 3, REF: 4, LABEL: 5, OVER: 6, TIME: 7, STATE: 8, PRI: 9, TAGS: 10, DIM: 11 };
function agendaLine(parts: [string, number][], task?: BrainTask): AgendaLine {
  const l: AgendaLine = { text: '', spans: [], task };
  for (const [text, face] of parts) { if (face && text) l.spans.push([l.text.length, l.text.length + text.length, face]); l.text += text; }
  return l;
}
/* A task's line: task:N, LABEL (why it is on this day, when it is there for one; OVER marks one that is late),
   the time, the state, [#P], the title, :tags:, who made it when its trust is not the owner's (an
   agent's task) and, with DATES, its dates. */
function taskLine(t: BrainTask, label: string | null, over: boolean, time: string, dates: boolean) {
  const tags = tagText(t.tags);
  const pr = prop(t, 'priority'), parts: [string, number][] = [['  ', 0], [refOfTask(t).padEnd(9), F.REF], [' ', 0]];
  if (label !== null) parts.push([label.padEnd(11), over ? F.OVER : F.LABEL], [' ', 0]);
  if (time) parts.push([time, F.TIME], [' ', 0]);
  parts.push([taskState(t).toUpperCase(), F.STATE], [' ', 0]);
  if (pr) parts.push([`[#${pr}]`, F.PRI], [' ', 0]);
  parts.push([oneLine(t.title) || '(no title)', 0]);
  if (tags) parts.push(['  ', 0], [tags, F.TAGS]);
  if (t.trust !== 'owner' && typeof t.created_by_title === 'string' && t.created_by_title) parts.push(['  ', 0], [`by ${oneLine(t.created_by_title)}`, F.DIM]);
  if (dates) for (const k of ['due', 'scheduled']) if (prop(t, k)) parts.push(['  ', 0], [`${k} ${prop(t, k).replace('T', ' ')}`, F.TIME]);
  return agendaLine(parts, t);
}
const dayHeader = (d: Date) => `${Org.strftime('%A', d).padEnd(10)} ${Org.strftime('%e %B %Y', d)}`;
/* The week from today: what is overdue, then each day with what is due or scheduled on it, then the next
   actions with no date. TODAY is the line of today's header. */
async function weekView(): Promise<{ lines: AgendaLine[]; today: number }> {
  const now = Org.ORG.now(), from = Org.strftime('%F', now);
  const v = await ask('brain-agenda', { from, days: DAYS }), a = isObj(v) ? v : {};
  const lines = [agendaLine([[`Agenda for ${DAYS} days from ${from}`, F.TITLE]])];
  const overdue = tasksOf(a.overdue);
  if (overdue.length) lines.push(agendaLine([['Overdue', F.HEAD]]));
  for (const t of overdue) {
    const n = dayNumber(from) - dayNumber(t.day || ''), late = isNaN(n) ? '' : String(n);
    lines.push(taskLine(t, t.why === 'scheduled' ? `Sched. ${late}x:` : `${late} d. ago:`, true, '', false));
  }
  const byDay = new Map<string, BrainTask[]>();
  for (const d of Array.isArray(a.dated) ? a.dated : []) if (isObj(d) && typeof d.date === 'string') byDay.set(d.date, tasksOf(d.tasks));
  const today = lines.length;
  for (let k = 0; k < DAYS; k++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + k);
    lines.push(agendaLine([[dayHeader(day), k ? F.HEAD : F.TODAY]]));
    for (const t of byDay.get(Org.strftime('%F', day)) || []) lines.push(taskLine(t, t.why === 'scheduled' ? 'Scheduled:' : 'Due:', false, timeOf(prop(t, t.why === 'scheduled' ? 'scheduled' : 'due')), false));
  }
  const next = tasksOf(a.next);
  if (next.length) lines.push(agendaLine([['Next', F.HEAD]]));
  for (const t of next) lines.push(taskLine(t, null, false, '', false));
  return { lines, today };
}
/* Every open task, by state, in brain's order within one: asked for a page at a time. */
async function listView(): Promise<{ lines: AgendaLine[]; today: number }> {
  const all: BrainTask[] = [];
  let more = true;
  for (let offset = 0; more && offset < MOST; offset += PAGE) {
    const v = await ask('brain-tasks', { state: 'open', limit: PAGE, offset }), page = isObj(v) && Array.isArray(v.tasks) ? v.tasks : [];
    all.push(...tasksOf(page)); more = page.length >= PAGE;
  }
  /* A last page that is full does not say that more follow it. */
  if (more) { const v = await ask('brain-tasks', { state: 'open', limit: 1, offset: MOST }); more = isObj(v) && Array.isArray(v.tasks) && v.tasks.length > 0; }
  const groups = new Map<string, BrainTask[]>(OPEN.map(([st]) => [st, []]));
  for (const t of all) { const st = taskState(t); if (!groups.has(st)) groups.set(st, []); groups.get(st)!.push(t); }
  const lines = [agendaLine([[`Open tasks (${all.length}${more ? ', and more that are not shown' : ''})`, F.TITLE]])];
  const names = new Map(OPEN);
  for (const [st, ts] of groups) {
    if (!ts.length) continue;
    lines.push(agendaLine([[`${names.get(st) || st} (${ts.length})`, F.HEAD]]));
    for (const t of ts) lines.push(taskLine(t, null, false, '', true));
  }
  return { lines, today: -1 };
}
/* Ask brain and write VIEW into the agenda buffer. brain is asked first, so a brain that cannot answer leaves
   the buffer as it was. With KEEP point stays on its task where the new view has it, else on its line; without,
   it goes to today's line, or the first task. */
async function fillAgenda(view: AgendaView, keep: boolean) {
  const mine = ++fills, built = view === 'list' ? await listView() : await weekView();
  const b = Ed.getBufferCreate(AGENDA), old = b.mode === 'brain-agenda-mode' ? b.agenda as Agenda | undefined : undefined;
  /* The agenda can be asked for again while brain answers (it follows brain, below): an answer to an earlier
     question than the one the buffer shows is not written over it. */
  if (old && mine < old.asked) return b;
  const was = keep && old ? lineNoB(b, b.pt) - 1 : -1, held = was >= 0 && old!.lines[was] ? old!.lines[was].task : undefined;
  b.mode = 'brain-agenda-mode'; b.readOnly = true; b.evilState = 'motion';
  b.text = built.lines.map(l => l.text).join('\n') + '\n';
  b.agenda = { view, lines: built.lines, win: old ? old.win : null, own: old ? old.own : false, stale: false, asked: mine };
  b.modified = false; b.undo = []; b.redo = [];
  let line = built.today >= 0 ? built.today : Math.max(0, built.lines.findIndex(l => l.task));
  if (was >= 0) {
    /* The task's line nearest to where it was: a task can be on two days. */
    const same = held ? built.lines.map((l, i) => (l.task && l.task.id === held.id ? i : -1)).filter(i => i >= 0) : [];
    line = same.length ? same.reduce((x, y) => (Math.abs(y - was) < Math.abs(x - was) ? y : x)) : Math.min(was, built.lines.length - 1);
  }
  b.pt = lineStartB(b, line + 1);
  /* A window that is not the selected one keeps a point of its own, which would be a place in the old text. */
  for (const w of Ed.windowList()) if (w.buffer === b) w.pt = b.pt;
  /* The same text can have other faces: what a title said can now be a field. */
  b._balx = undefined;
  return b;
}
/* Show VIEW. The agenda takes a window of its own below, or one that is there: the popup window it is asked
   for from, else another window. The window is its own when it was made for it, now or earlier (a record
   opened from the agenda is shown in the agenda's window): q closes that one, and gives any other window back
   what it showed. */
async function showAgenda(view: AgendaView) {
  /* edwind follows brain's tasks before brain is asked for them, so no change falls between the two. */
  await watch(true);
  const b = await fillAgenda(view, false), ag = b.agenda as Agenda, shown = Ed.windowFor(b);
  if (shown) { Ed.selectWindow(shown); return; }
  const sel = E.sel!, before = Ed.windowList().length;
  ag.win = Ed.winConfig();
  let w = sel;
  if (sel.popup && before > 1) Ed.setWindowBuffer(b); else w = Ed.popToBuffer(b, true);
  ag.own = Ed.windowList().length > before || w.prev.includes(b);
}
/* The agenda that is shown, asked for again. What was done is said either way: SAID alone, or with why the
   agenda still shows what it did. Its lines are then of revisions brain has moved on from, and a change made
   from one would be made twice (a task that repeats, closed again, moves on again), so the agenda takes no
   change until it is asked for again. */
async function refreshed(said: string) {
  const b = Ed.getBuffer(AGENDA);
  if (!b || b.mode !== 'brain-agenda-mode' || !b.agenda || !Ed.windowFor(b)) return said;
  try { await fillAgenda((b.agenda as Agenda).view, true); Ed.scheduleRender(); return said; }
  catch (e) { (b.agenda as Agenda).stale = true; return `${said}; the agenda is not refreshed (r asks again): ${Ed.errorText(e)}`; }
}
/* The agenda follows brain. While a window shows it, edwind is asked to say when a task changed in brain
   (brain-tasks-follow): from the CLI, a phone, another frame, or here. It says only that one did, and the
   agenda is then asked for again as r asks, once the changes have rested for LIVE_MS: point stays on its task
   in every window, and the selected window and the minibuffer are left alone. An agenda that cannot be asked
   for is left as it is and takes no change until it can (STALE); that is said once. Without an edwind, or with
   one that has no brain to read, nothing follows and r asks again, as before. */
const LIVE_MS = 300;
/* WATCHING: what edwind was last told. DEAF: it could not follow, and is not asked again on this connection. */
let watching = false, deaf = false, listening = false, liveTimer: ReturnType<typeof setTimeout> | undefined;
let asking = false, again = false, liveFailed = false;
const agendaShown = () => { const b = Ed.getBuffer(AGENDA); return b && b.mode === 'brain-agenda-mode' && b.agenda && Ed.windowFor(b) ? b : null; };
async function live() {
  if (asking) { again = true; return; }
  asking = true;
  try {
    do {
      again = false;
      const b = agendaShown();
      if (!b) break;
      try { await fillAgenda((b.agenda as Agenda).view, true); liveFailed = false; }
      catch (e) {
        if (b.agenda) (b.agenda as Agenda).stale = true;
        if (!liveFailed) { liveFailed = true; Ed.message(`The agenda could not follow a change in brain (r asks again): ${Ed.errorText(e)}`); }
      }
      Ed.scheduleRender();
    } while (again);
  } finally { asking = false; }
}
function soon() { clearTimeout(liveTimer); liveTimer = setTimeout(() => { void live(); }, LIVE_MS); }
/* Tell edwind whether this frame watches the tasks. True when it now follows them for it. */
async function watch(on: boolean): Promise<boolean> {
  if (on === watching || !attached() || (on && deaf)) return false;
  if (!listening) {
    listening = true;
    Ed.sync.on('tasks', soon);
    /* A connection is a new client to edwind, which does not follow for it yet: it is asked again, and so is
       the agenda, for what changed while there was none. */
    Ed.sync.on('state', state => {
      watching = false;
      if (state !== 'online') return;
      deaf = false;
      if (agendaShown()) void watch(true).then(soon);
    });
  }
  watching = on;
  const r = await Ed.sync.call({ cmd: 'brain-tasks-follow', args: [on] });
  if (on && r.error) { deaf = true; watching = false; }
  return on && !r.error;
}
{
  const prev = H.postCommand;
  H.postCommand = (def, b, failed) => {
    if (prev) prev(def, b, failed);
    const shown = !!agendaShown();
    if (shown === watching) return;
    /* Shown some other way than asked for: what changed before edwind followed is not in it. */
    if (shown) void watch(true).then(follows => { if (follows) soon(); }); else void watch(false);
  };
}
const prevLexSeg = H.lexSeg;
H.lexSeg = (b, from, to, seg) => {
  if (b.mode !== 'brain-agenda-mode' || !b.agenda) return prevLexSeg ? prevLexSeg(b, from, to, seg) : null;
  const c = b._balx as AgendaLex | undefined;
  if (c && c.ver === b.ver && c.from === from && c.to === to) return c;
  const lines = (b.agenda as Agenda).lines, text = seg as string, cls = new Uint8Array(text.length);
  /* The segment starts at FROM, which need not start a line: OFF is where its first line starts, from FROM. */
  let n = lineNoB(b, from) - 1, off = lineStartB(b, n + 1) - from;
  for (; off < text.length && n < lines.length; n++) {
    for (const [s, e, face] of lines[n].spans) cls.fill(face, Math.max(0, off + s), Math.max(0, Math.min(text.length, off + e)));
    off += lines[n].text.length + 1;
  }
  return b._balx = { ver: b.ver, from, to, cls, names: AF };
};
Ed.host.page.addStyle('brain-css', `
.text .ba-title { font-weight: 700; color: var(--fn); }
.text .ba-head { font-weight: 700; color: var(--fg); }
.text .ba-today { font-weight: 700; color: var(--kw); }
.text .ba-ref { color: var(--dim); }
.text .ba-dim { color: var(--dim); }
.text .ba-label { color: var(--co); }
.text .ba-time { color: var(--co); }
.text .ba-over { color: var(--rb1); font-weight: 600; }
.text .ba-state { color: var(--org-todo, var(--rb1)); font-weight: 700; }
.text .ba-pri { color: var(--kw); font-weight: 600; }
.text .ba-tags { color: var(--dim); background: var(--org-tag-bg, rgb(127 127 127 / 0.12)); border-radius: 3px; }
`);

Ed.MODE_NAMES['brain-agenda-mode'] = 'Agenda';
const agendaOf = (b: EdBuffer) => { if (b.mode !== 'brain-agenda-mode' || !b.agenda) signal('user-error', 'Not in the agenda'); return b.agenda as Agenda; };
function taskAt(): BrainTask {
  const b = cur(), l = agendaOf(b).lines[lineNoB(b, b.pt) - 1];
  if (!l || !l.task) signal('user-error', 'No task on this line');
  return l.task!;
}
/* The task a command changes: the agenda's task whose id is ID, else the one at point. A command that reads
   in the minibuffer names the task that was at point before it read, since point can move meanwhile. */
function taskFor(id: SchemeValue): BrainTask {
  if (typeof id !== 'string' || !id) return taskAt();
  const b = Ed.getBuffer(AGENDA), l = b && b.mode === 'brain-agenda-mode' && b.agenda ? (b.agenda as Agenda).lines.find(x => x.task && x.task.id === id) : null;
  if (!l) signal('user-error', 'The agenda does not show that task any more');
  return l!.task!;
}
const given = (x: SchemeValue, what: string) => { const t = typeof x === 'string' ? x.trim() : ''; if (!t) signal('user-error', `No ${what}`); return t; };
const brief = (x: unknown) => { const t = oneLine(typeof x === 'string' ? x : x === null || x === undefined ? 'nothing' : JSON.stringify(x)); return t.length > 60 ? t.slice(0, 60) + '…' : t; };
/* Change the task ID names, or the one at point: FIELDS go to brain as a change to the revision its line
   shows, so what changed in brain since is kept, and where it changed one of FIELDS too, brain takes this one
   and says so (`clashes`). The echo area says what SAY makes of the task brain answers, and what was replaced. */
async function change(fields: Record<string, unknown>, say: (t: BrainTask) => string, id?: SchemeValue) {
  const t = taskFor(id), b = Ed.getBuffer(AGENDA);
  if (b && b.agenda && (b.agenda as Agenda).stale) signal('user-error', 'The agenda does not show the last change: r asks brain again');
  const v = await ask('brain-task-set', t.id, { ...fields, base_revision: t.revision }), now = taskOf(v);
  const clashes = (isObj(v) && Array.isArray(v.clashes) ? v.clashes : []).filter(isObj);
  const replaced = clashes.length ? `; replaced what had changed since: ${clashes.map(c => `${brief(c.field)} was ${brief(c.was)}`).join(', ')}` : '';
  Ed.message(await refreshed(`${refOfTask(now)}: ${say(now)}${replaced}`));
  return false;
}
/* C-u before the key, not a count. */
const prefixed = () => Array.isArray(E.prefixArg);
/* A date read in the minibuffer as brain takes it: a day, or a day and a time when one was typed. */
async function readWhen(prompt: string) { const d = await Org.readDate(prompt, ''); return Org.strftime(d.time ? '%FT%H:%M' : '%F', d.date); }
/* A field's value as brain takes it: the text, or null (the field is cleared) for #f. */
const orNull = (x: SchemeValue, what: string) => { if (x === false) return null; return given(x, what); };

CMD('brain-agenda', async () => [await Org.keyOf('Agenda: [a] agenda  [t] all open tasks ', ['a', 't'])],
  'KEY', 'Show brain\'s tasks: with KEY "a" the agenda of the week from today (what is overdue, each day, the next actions), with "t" every open task by state (SPC m a).',
  async ([k]: SchemeValue[]) => { await showAgenda(String(k)[0] === 't' ? 'list' : 'week'); return false; });
CMD('brain-agenda-redo', '', '', 'Ask brain again for what the agenda shows (r, g r).', async () => { await fillAgenda(agendaOf(cur()).view, true); return false; });
CMD('brain-agenda-quit', '', '', 'Leave the agenda: close its window when it was opened for it, else bring back the windows as they were (q).', () => {
  const b = cur(), ag = agendaOf(b), w = Ed.windowFor(b), win = ag.win;
  ag.win = null;
  if (w && ag.own && w.popup && Ed.windowList().length > 1) { Ed.deleteWindow(w); return false; }
  if (win) { try { Ed.restoreWinConfig(win); return false; } catch (e) { /* the windows are not those any more */ } }
  return L.call('quit-window', []);
});
CMD('brain-agenda-open', '', '', 'Open the record of the task at point (RET).', async () => { await open(taskAt().id); return false; });
/* TASK in the commands below is the id of a task the agenda shows, for the task at point when it is not given. */
CMD('brain-task-state', async () => { const id = taskAt().id; return [STATE_KEYS[await Org.keyOf('State: [t]odo [n]ext [w]aiting [h]old [s]omeday [d]one [c]ancelled ', Object.keys(STATE_KEYS))], id]; },
  'STATE &optional TASK', 'Set the state of the task at point: todo, next, waiting, hold, someday, done or cancelled (t).',
  ([st, id]: SchemeValue[]) => change({ state: given(st, 'state') }, t => taskState(t), id));
CMD('brain-task-done', '', '', 'Close the task at point as done. A task that repeats moves to its next date instead (x).',
  () => change({ state: 'done' }, t => (taskState(t) === 'done' ? 'done' : `done; it repeats, ${['due', 'scheduled'].filter(k => prop(t, k)).map(k => `${k} ${prop(t, k).replace('T', ' ')}`).join(', ') || taskState(t)}`)));
for (const [name, field, key, prompt] of [['brain-task-schedule', 'scheduled', 's', 'Schedule on'], ['brain-task-due', 'due', 'd', 'Due on']]) {
  CMD(name, async () => { const id = taskAt().id; return [prefixed() ? false : await readWhen(`${prompt} (default today): `), id]; },
    'WHEN &optional TASK', `Set when the task at point is ${field}: WHEN is a day (2026-10-20) or a day and a time (2026-10-20T10:00), read in the minibuffer, today by default. With WHEN #f, or C-u, it has none (${key}).`,
    ([w, id]: SchemeValue[]) => change({ [field]: orNull(w, 'date') }, t => (prop(t, field) ? `${field} ${prop(t, field).replace('T', ' ')}` : `not ${field}`), id));
}
CMD('brain-task-priority', async () => { const id = taskAt().id, k = await Org.keyOf('Priority: [a] [b] [c], space for none ', ['a', 'b', 'c', 'A', 'B', 'C', ' ']); return [k === ' ' ? false : k.toUpperCase(), id]; },
  'PRIORITY &optional TASK', 'Set the priority of the task at point: "A", "B" or "C", or #f for none (p).',
  ([pr, id]: SchemeValue[]) => change({ priority: orNull(pr, 'priority') }, t => (prop(t, 'priority') ? `priority ${prop(t, 'priority')}` : 'no priority'), id));
CMD('brain-task-title', async () => { const t = taskAt(); return [await Ed.readMini('Title: ', oneLine(t.title)), t.id]; },
  'TITLE &optional TASK', 'Give the task at point the title TITLE (e).',
  ([title, id]: SchemeValue[]) => change({ title: given(title, 'title') }, t => oneLine(t.title), id));
CMD('brain-task-tag', async () => { const id = taskAt().id; return [await Ed.readMini('Tags (+a -b): ', ''), id]; },
  'TAGS &optional TASK', 'Change the tags of the task at point: TAGS is words with spaces between, where +a or a adds the tag a and -b removes the tag b (:).',
  ([tags, id]: SchemeValue[]) => {
    const add: string[] = [], remove: string[] = [];
    for (const w of given(tags, 'tags').split(/\s+/)) {
      const tag = /^[+-]/.test(w) ? w.slice(1) : w;
      if (!tag) signal('user-error', `${w} names no tag`);
      (w[0] === '-' ? remove : add).push(tag);
    }
    return change({ ...(add.length ? { add_tags: add } : {}), ...(remove.length ? { remove_tags: remove } : {}) }, t => tagText(t.tags) || 'no tags', id);
  });
CMD('brain-task-add', async () => {
  /* Before a title is typed for a task that cannot be added. */
  if (!attached()) signal('user-error', NO_EDWIND);
  const b = cur(), id = Org.idAtPoint(b);
  const sel = EC.stateOf(b) === 'visual' && b.mark !== null ? (([s, e]) => b.rope.slice(s, e).trim())(EC.visualRange(b, true)) : '';
  const title = await Ed.readMini('Task: ', '');
  /* The note is named by its id alone: a tag may hide its title from those who can read the task. */
  return [title, [sel, id ? `[[id:${id}]]` : ''].filter(x => x).join('\n\n') || false];
}, 'TITLE &optional BODY', 'Add a task titled TITLE to brain, with the tags of brain-task-tags and the text BODY. Interactively the title is read in the minibuffer, and the body is the Visual selection, then a link to the note at point when it has an Org id (SPC o, a in the agenda).',
  async ([title, body]: SchemeValue[]) => {
    const named = L.get('brain-task-tags');
    if (typeof named !== 'string') signal('user-error', 'brain-task-tags is not a string of tags');
    const tags = (named as string).split(/\s+/).filter(x => x);
    const t = taskOf(await ask('brain-task-add', { title: given(title, 'title'), ...(tags.length ? { tags } : {}), ...(typeof body === 'string' && body.trim() ? { body } : {}) }));
    Ed.message(await refreshed(`${refOfTask(t)} added${tagText(t.tags) ? ' ' + tagText(t.tags) : ''}`));
    return false;
  });
for (const n of ['brain-node-find', 'brain-node-insert', 'brain-backlinks', 'brain-follow', 'brain-agenda', 'brain-agenda-redo', 'brain-agenda-quit', 'brain-agenda-open',
  'brain-task-state', 'brain-task-done', 'brain-task-schedule', 'brain-task-due', 'brain-task-priority', 'brain-task-title', 'brain-task-tag', 'brain-task-add']) L.put(intern(n), 'evil-repeat', intern('abort'));

globalThis.Brain = { open, noteTitled };
})();
