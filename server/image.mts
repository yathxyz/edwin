// The image log (spec §4.4, R4.14–R4.21, R7.19, R13.9, §18.2 Q2): how one image spans many runtimes and
// survives restarts. It records definitions, not effects.
//
// image.jsonl in stateDir is one JSON object per line:
//   {t:"epoch", epoch, at}              the image epoch (R4.20); rewritten by reset, compaction and revert
//   {t:"form", gen, at, by, form}       one definitional form: its generation, the time, the caller's by()
//                                       (origin cli:<session> for wb eval, R13.9) and the form as `write` prints it
// A torn last line is dropped at load, and cut off the file before the next append. A replay failure is kept in
// memory on the entry (`failed`) and never written: the next start replays again.
//
// The epoch line also carries `gen`, the generation floor: after a rollback the entries' highest generation can
// be lower than the last one handed out, and generations never repeat.
//
// Generations (snapshots of the log) live in stateDir/generations: <id>.jsonl is a copy of image.jsonl as it
// was, index.jsonl one {id, gen, epoch, entries, bytes, sha256, build, at, origin, label, reason} line per copy.
// A copy is made at every start whose replay had no failure (the last good image), before compaction, revert,
// reset and rollback, and on request (image-checkpoint). Identical logs share one copy unless labelled. The
// newest EDWIND_IMAGE_GENERATIONS (32) are kept; labelled ones go last. A rollback replaces the log by a copy;
// the server image keeps what it has defined until it restarts (image-restart), frames rebuild at once.
//
// Safe mode (the recovery image): stateDir/boot.json counts starts that did not settle (listen, then
// EDWIND_BOOT_SETTLE_MS of uptime, or a clean stop). After two such starts in a row, or with EDWIND_SAFE=1,
// edwind boots the shipped Scheme only: no init.scm, no image replay, frames get only what is defined from
// then on. The log is kept, so image-generations and image-rollback repair it; image-restart leaves safe mode.
//
// The module installs the server commands image-log, image-compact, image-reset, image-save-to-init,
// image-problems, image-revert-entry, image-entries, image-checkpoint, image-generations, image-rollback and
// image-restart (§4.6, reached by call{cmd}), the server-only primitives %image-server?, %declare-definitional,
// %share-variable, %image-command, %image-record and %edwin-source, and the status fields.
// main.mts calls record() from evalForm and replay() from start(); session.mts calls sendAfter() for image?.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeAtomic, sha256 } from './files.mts';
import { ProtoError } from './proto.mts';
import type { By, ImageMsg, VarMsg, EchoMsg } from './proto.mts';
import type { Server, Lisp, SchemeValue } from './main.mts';
import type { Client } from './session.mts';
import type { SBuf } from './buffers.mts';

type Scheme = Lisp['S'];
/* One {t:"form"} line of image.jsonl; `failed` is set in memory by a replay failure and never written. */
export interface ImageEntry { t: 'form'; gen: number; at: number; by: By; form: string; build?: string; failed?: { error: string; at: number } }
/* A shared variable as var{name, value} sends it. */
export interface SharedValue { name: string; value: unknown }
/* The result of an image server command. */
export interface ImageResult { value: unknown; msg?: string }
export type ImageCommand = (image: ImageLog, client: Client | null, args: unknown[]) => ImageResult | Promise<ImageResult>;

export const name = 'image';

/* Limits (R4.21); the environment lowers them for the gate suite. */
const envNum = (k: string, dflt: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : dflt; };
export const ENTRY_MAX = envNum('EDWIND_IMAGE_ENTRY_BYTES', 1 << 20);
export const COMPACT_ENTRIES = envNum('EDWIND_IMAGE_COMPACT_ENTRIES', 10000);
export const COMPACT_BYTES = envNum('EDWIND_IMAGE_COMPACT_BYTES', 16 << 20);
export const VAR_MAX = 64 * 1024;
export const GENERATIONS_KEEP = envNum('EDWIND_IMAGE_GENERATIONS', 32);
export const GENERATIONS_DIR = 'generations';
/* Starts that did not settle before safe mode (R4.19 amendment) and the uptime that settles one. */
export const SAFE_AFTER = 2;
export const SETTLE_MS = envNum('EDWIND_BOOT_SETTLE_MS', 30000);
/* The exit code of image-restart: the service manager (Restart=on-failure) starts edwind again. */
export const RESTART_EXIT = 75;
/* The shipped tree (share/edwin) that %edwin-source reads. */
const EDWIN_TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOG_BUFFER = '*image-log*';
export const LOG_BUFFER_ID = 'name:' + LOG_BUFFER;

/* The definitional heads of R4.14, plus the E2 forms of R4.16–R4.18 and declare-definitional itself (so a
   declaration made at run time is logged and reaches every runtime). */
export const HEADS = ['define', 'define-command', 'define-record-type', 'define-syntax', 'define-macro', 'define-minor-mode', 'define-derived-mode', 'defvar', 'defvar-local', 'defcustom', 'defface', 'set!', 'setq', 'setq-default', 'add-hook!', 'remove-hook!', 'advice-add', 'advice-remove', 'define-key', 'keymap-set', 'global-set-key', 'evil-define-key', 'evil-ex-define-cmd', 'define-snippet', 'put', 'provide', 'require', 'defvar-shared', 'on-server', 'on-frames', 'declare-definitional'];
/* Heads whose second element names what they define: a later entry with the same name supersedes an earlier
   one at compaction. Every other head (set!, define-key, add-hook!, on-server, ...) is keyed by its whole form. */
const NAMED = new Set(['define', 'define-command', 'define-record-type', 'define-syntax', 'define-macro', 'define-minor-mode', 'define-derived-mode', 'defvar', 'defvar-local', 'defvar-shared', 'defcustom', 'defface', 'define-snippet', 'evil-ex-define-cmd']);

export const randomEpoch = () => randomBytes(8).toString('hex');
/* The origin shown in image-log and the Q2 banner. */
export const originOf = (by: By | null | undefined): string => {
  if (!by || !by.kind) return 'server';
  if (by.kind === 'cli') return by.session ? 'cli:' + by.session : 'cli@' + (by.device || '?');
  if (by.kind === 'frame' || by.kind === 'web') return by.kind + '@' + (by.device || by.cid || '?');
  if (by.kind === 'agent' && by.agent) return by.agent;
  return by.kind;
};
/* The lines of a log file: the epoch (with its generation floor) and the well-formed form entries. */
export function parseLog(text: string): { epoch: string | null; floor: number; entries: ImageEntry[]; bytes: number } {
  let epoch: string | null = null, floor = 0, bytes = 0;
  const entries: ImageEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o: any; try { o = JSON.parse(line); } catch (e) { continue; } // a torn last line; any: a parsed line, checked field by field
    if (o.t === 'epoch') { epoch = o.epoch; if (Number.isInteger(o.gen)) floor = Math.max(floor, o.gen); continue; }
    if (o.t === 'form' && Number.isInteger(o.gen) && typeof o.form === 'string') { entries.push({ t: 'form', gen: o.gen, at: o.at, by: o.by, form: o.form, ...(typeof o.build === 'string' ? { build: o.build } : {}) }); bytes += line.length + 1; }
  }
  return { epoch, floor, entries, bytes };
}
/* One generation (a copy of the log) as index.jsonl lists it. */
export interface Generation { id: number; gen: number; epoch: string | null; entries: number; bytes: number; sha256: string; build: string | null; at: number; origin: string; label: string | null; reason: string }
/* What boot.json holds and what safe mode reports. */
export interface SafeMode { reason: string; unsettled: number }
const stamp = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const SERVER_BY: By = { kind: 'server' };

/* A Scheme value as JSON for var{name, value} (R4.18): booleans, numbers, strings, proper lists and vectors
   (both arrays), hash tables with string keys (objects). Anything else is refused by name. */
export function toJSON(S: Scheme, v: SchemeValue, name: string): unknown {
  const bad = (what: string) => new S.SchemeError('error', `${name}: a shared variable holds JSON-serialisable values only; ${what}`, []);
  const conv = (x: SchemeValue): unknown => {
    if (x === true || x === false || typeof x === 'string') return x;
    if (typeof x === 'number') { if (!Number.isFinite(x)) throw bad(`${x} is not finite`); return x; }
    if (typeof x === 'bigint') { if (x > BigInt(Number.MAX_SAFE_INTEGER) || x < -BigInt(Number.MAX_SAFE_INTEGER)) throw bad(`${x} is beyond 2^53`); return Number(x); }
    if (x === S.NIL) return [];
    if (x instanceof S.Pair) { const out: unknown[] = []; let p = x; while (p instanceof S.Pair) { out.push(conv(p.car)); p = p.cdr; } if (p !== S.NIL) throw bad('an improper list'); return out; }
    if (Array.isArray(x)) return x.map(conv);
    if (x instanceof Map) { const o: Record<string, unknown> = {}; for (const [k, val] of x) { if (typeof k !== 'string') throw bad('a hash table key that is not a string'); o[k] = conv(val); } return o; }
    if (x instanceof S.Sym) throw bad(`the symbol ${x.name} (use a string)`);
    if (x === undefined) throw bad('an unbound value');
    throw bad(`${S.write(x)} has no JSON form`);
  };
  const json = conv(v);
  const bytes = Buffer.byteLength(JSON.stringify(json));
  if (bytes > VAR_MAX) throw new S.SchemeError('error', `${name}: a shared variable's value is at most ${VAR_MAX >> 10} KiB (this one is ${bytes} bytes)`, []);
  return json;
}
/* JSON back to a Scheme value (the inverse of toJSON): arrays become lists, objects hash tables. */
export function fromJSON(S: Scheme, j: unknown): SchemeValue {
  if (j === null || j === undefined) return false;
  if (Array.isArray(j)) return S.listOf(j.map(x => fromJSON(S, x)));
  if (typeof j === 'object') { const m = new Map(); for (const [k, v] of Object.entries(j)) m.set(k, fromJSON(S, v)); return m; }
  if (typeof j === 'number' && Number.isInteger(j)) return BigInt(j);
  return j;
}
/* A server command's JSON result as a Scheme value for %image-command: objects become alists. */
function resultToScheme(S: Scheme, j: unknown): SchemeValue {
  if (j === null || j === undefined) return false;
  if (Array.isArray(j)) return S.listOf(j.map(x => resultToScheme(S, x)));
  if (typeof j === 'object') return S.listOf(Object.entries(j).map(([k, v]) => S.cons(S.intern(k), resultToScheme(S, v))));
  if (typeof j === 'number' && Number.isInteger(j)) return BigInt(j);
  return j;
}
/* A Scheme argument of %image-command as JSON (symbols become strings, alists stay lists). */
function argToJSON(S: Scheme, x: SchemeValue): unknown {
  if (x instanceof S.Sym) return x.name;
  if (typeof x === 'bigint') return Number(x);
  if (x === S.NIL) return [];
  if (x instanceof S.Pair) return S.arr(x).map((y: SchemeValue) => argToJSON(S, y));
  if (x === undefined) return null;
  return x;
}

export class ImageLog {
  declare file: string;
  declare gen: number;
  declare entries: ImageEntry[];
  declare epoch: string | null;
  /* The bytes of the form lines (the epoch line not counted). */
  declare bytes: number;
  declare heads: Set<string>;
  declare shared: Map<string, { doc: string | null }>;
  declare server: Server | null;
  declare refreshTimer: NodeJS.Timeout | null;
  declare epochTimer: NodeJS.Timeout | null;
  declare autoFloor: { entries: number; bytes: number };
  /* Set by bootGuard() when this start is in safe mode; safeFloor is the generation at boot (frames get only
     the entries after it). */
  declare safe: SafeMode | null;
  declare safeFloor: number;
  declare settleTimer: NodeJS.Timeout | null;
  constructor(file: string) {
    this.file = file; this.gen = 0; this.entries = []; this.epoch = null; this.bytes = 0;
    this.heads = new Set(HEADS); this.shared = new Map();
    this.server = null; this.refreshTimer = null; this.epochTimer = null; this.settleTimer = null;
    this.safe = null; this.safeFloor = 0;
    /* After an automatic compaction that left the log over a limit, the next one waits for a tenth more. */
    this.autoFloor = { entries: 0, bytes: 0 };
    this.load();
  }
  get dir() { return path.dirname(this.file); }
  get genDir() { return path.join(this.dir, GENERATIONS_DIR); }
  load() {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const p = parseLog(text);
    this.epoch = p.epoch; this.entries = p.entries; this.bytes = p.bytes;
    this.gen = this.entries.reduce((g, e) => Math.max(g, e.gen), p.floor);
    /* The next append must start a line of its own: a torn last line is cut off, a whole one gets its newline.
       Glued to the tail, the next form would be lost with it at the next load. */
    if (text && !text.endsWith('\n')) {
      const last = text.slice(text.lastIndexOf('\n') + 1);
      let whole = true; try { JSON.parse(last); } catch (e) { whole = false; }
      if (whole) fs.appendFileSync(this.file, '\n'); else fs.truncateSync(this.file, Buffer.byteLength(text) - Buffer.byteLength(last));
    }
  }
  /* The epoch changes only when the image is reset, compacted or an entry is reverted (R4.20); a fresh log gets one. */
  ensureEpoch(make: () => string = randomEpoch): string {
    if (this.epoch) return this.epoch;
    this.epoch = make();
    fs.appendFileSync(this.file, JSON.stringify({ t: 'epoch', epoch: this.epoch, at: Date.now() }) + '\n', { mode: 0o600 });
    return this.epoch;
  }
  /* Append a definitional form with the next generation; the line is on disk (fdatasync) when this returns. */
  append(form: string, by: By): ImageEntry {
    const entry: ImageEntry = { t: 'form', gen: this.gen + 1, at: Date.now(), by, form, ...(this.server ? { build: this.server.build } : {}) };
    const line = JSON.stringify(entry) + '\n';
    const fd = fs.openSync(this.file, 'a', 0o600);
    try { fs.writeSync(fd, line); fs.fdatasyncSync(fd); } finally { fs.closeSync(fd); }
    this.entries.push(entry); this.gen = entry.gen; this.bytes += line.length;
    return entry;
  }
  after(gen: number): ImageEntry[] { return this.entries.filter(e => e.gen > gen); }
  /* Write the whole log fresh: the epoch line, then the entries (reset, compaction, revert). */
  rewrite() {
    const text = this.serialize();
    writeAtomic(this.file, text);
    this.bytes = text.length - text.indexOf('\n') - 1;
  }
  /* The log as rewrite() writes it: the epoch line with the generation floor, then the entries. */
  serialize(): string {
    const lines = [JSON.stringify({ t: 'epoch', epoch: this.epoch, at: Date.now(), gen: this.gen })];
    for (const e of this.entries) lines.push(JSON.stringify({ t: 'form', gen: e.gen, at: e.at, by: e.by, form: e.form, ...(e.build ? { build: e.build } : {}) }));
    return lines.join('\n') + '\n';
  }

  /* ---------- generations ---------- */
  /* The content hash of the entries (not the epoch or the times): identical logs share one generation. */
  contentHash(entries: ImageEntry[] = this.entries): string { return sha256(entries.map(e => e.form).join('\n\u0000')); }
  generations(): Generation[] {
    let text = '';
    try { text = fs.readFileSync(path.join(this.genDir, 'index.jsonl'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const out: Generation[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      let o: any; try { o = JSON.parse(line); } catch (e) { continue; } // any: a parsed line, checked below
      if (!Number.isInteger(o.id) || typeof o.sha256 !== 'string') continue;
      if (o.drop) { const i = out.findIndex(g => g.id === o.id); if (i >= 0) out.splice(i, 1); continue; }
      if (fs.existsSync(this.genFile(o.id))) out.push(o);
    }
    return out;
  }
  genFile(id: number) { return path.join(this.genDir, `${id}.jsonl`); }
  private indexAppend(obj: object) {
    fs.mkdirSync(this.genDir, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(path.join(this.genDir, 'index.jsonl'), 'a', 0o600);
    try { fs.writeSync(fd, JSON.stringify(obj) + '\n'); fs.fdatasyncSync(fd); } finally { fs.closeSync(fd); }
  }
  /* Copy the log as it is now into a new generation, unless a kept one has the same entries (and no label is
     asked for). Returns the generation and whether it was made now. */
  checkpoint({ label = null, reason = 'checkpoint', by = SERVER_BY }: { label?: string | null; reason?: string; by?: By } = {}): { generation: Generation; made: boolean } {
    const gens = this.generations();
    const sha = this.contentHash();
    const same = gens.filter(g => g.sha256 === sha).pop();
    if (same && !label) return { generation: same, made: false };
    const id = gens.reduce((n, g) => Math.max(n, g.id), this.lastGenId()) + 1;
    const text = this.serialize();
    fs.mkdirSync(this.genDir, { recursive: true, mode: 0o700 });
    writeAtomic(this.genFile(id), text);
    const g: Generation = { id, gen: this.gen, epoch: this.epoch, entries: this.entries.length, bytes: Buffer.byteLength(text), sha256: sha, build: this.server ? this.server.build : null, at: Date.now(), origin: originOf(by), label: label ? String(label).slice(0, 200) : null, reason };
    this.indexAppend(g);
    this.prune([...gens, g], g);
    if (this.server) this.server.log.info('image', { event: 'checkpoint', id, gen: this.gen, entries: g.entries, reason });
    return { generation: g, made: true };
  }
  /* The highest id ever used, dropped ones too, so an id never names two copies. */
  private lastGenId(): number {
    let n = 0;
    try { for (const f of fs.readdirSync(this.genDir)) { const m = /^(\d+)\.jsonl$/.exec(f); if (m) n = Math.max(n, Number(m[1])); } } catch (e) { /* none yet */ }
    let text = ''; try { text = fs.readFileSync(path.join(this.genDir, 'index.jsonl'), 'utf8'); } catch (e) { /* none yet */ }
    for (const line of text.split('\n')) { try { const o = JSON.parse(line); if (Number.isInteger(o.id)) n = Math.max(n, o.id); } catch (e) { /* torn */ } }
    return n;
  }
  /* Keep the newest GENERATIONS_KEEP; unlabelled ones are dropped first, and the copy just made (KEEP) never:
     it is the recovery copy of the change that made it. The index is compacted when it is four times longer
     than what it lists. */
  private prune(gens: Generation[], keep: Generation) {
    const drop: Generation[] = [];
    let live = [...gens];
    while (live.length > Math.max(1, GENERATIONS_KEEP)) {
      const victim = live.find(g => !g.label && g !== keep) || live.find(g => g !== keep)!;
      live = live.filter(g => g !== victim); drop.push(victim);
    }
    for (const g of drop) { this.indexAppend({ id: g.id, sha256: g.sha256, drop: true }); try { fs.unlinkSync(this.genFile(g.id)); } catch (e) { /* gone */ } }
    const index = path.join(this.genDir, 'index.jsonl');
    let lines = 0; try { lines = fs.readFileSync(index, 'utf8').split('\n').filter(Boolean).length; } catch (e) { /* none */ }
    if (lines > 4 * Math.max(live.length, 8)) writeAtomic(index, live.map(g => JSON.stringify(g)).join('\n') + '\n');
  }
  /* Replace the log by generation ID. The current log is copied first, so a rollback is itself undone by
     rolling back to that copy. Frames rebuild at once (a new epoch); the server image keeps its definitions
     until it restarts. */
  rollback(id: number, by: By = SERVER_BY): { id: number; before: number; entries: number; gen: number; epoch: string | null } | null {
    const g = this.generations().find(x => x.id === id);
    if (!g) return null;
    const p = parseLog(fs.readFileSync(this.genFile(id), 'utf8'));
    const before = this.checkpoint({ reason: `before rollback to ${id}`, by }).generation.id;
    this.entries = p.entries; this.gen = Math.max(this.gen, p.floor, ...p.entries.map(e => e.gen));
    this.changeEpoch(`rolled back to generation ${id}`);
    return { id, before, entries: this.entries.length, gen: this.gen, epoch: this.epoch };
  }

  /* ---------- safe mode ---------- */
  private bootFile() { return path.join(this.dir, 'boot.json'); }
  /* Called at start, before the boot files run: count this start and decide on safe mode. */
  bootGuard(env: NodeJS.ProcessEnv = process.env): SafeMode | null {
    let unsettled = 0;
    try { const o = JSON.parse(fs.readFileSync(this.bootFile(), 'utf8')); if (Number.isInteger(o.unsettled)) unsettled = o.unsettled; } catch (e) { /* first start, or torn */ }
    if (env.EDWIND_SAFE === '1') this.safe = { reason: 'EDWIND_SAFE=1', unsettled };
    else if (unsettled >= SAFE_AFTER) this.safe = { reason: `${unsettled} starts in a row ended before settling`, unsettled };
    writeAtomic(this.bootFile(), JSON.stringify({ unsettled: unsettled + 1, at: Date.now() }) + '\n');
    this.safeFloor = this.gen;
    return this.safe;
  }
  /* This start settled: listening for SETTLE_MS, or a clean stop. */
  settled() {
    if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; }
    try { writeAtomic(this.bootFile(), JSON.stringify({ unsettled: 0, at: Date.now() }) + '\n'); } catch (e) { /* the next start counts one more */ }
  }
  settleLater() {
    if (this.settleTimer) return;
    this.settleTimer = setTimeout(() => { this.settleTimer = null; this.settled(); }, SETTLE_MS);
    this.settleTimer.unref();
  }
  /* The epoch frames see: in safe mode a different one, so a frame drops what it replayed from the full log. */
  servedEpoch(): string { return this.safe ? 'safe-' + this.epoch : this.epoch!; }

  /* ---------- the server side ---------- */
  /* Bind to the server once Edwin is loaded: the primitives of the Scheme side (emacs.scm, "image log"). */
  attach(server: Server) {
    if (this.server) return;
    this.server = server;
    const { L } = server, S = L.S;
    const serverOnly = (fn: SchemeValue) => { fn.where = 'server'; return fn; };
    serverOnly(L.D('%image-server?', '', '#t in the server image. Frames have no such primitive; emacs.scm tests for it.', () => true));
    serverOnly(L.D('%declare-definitional', 'symbol', 'Make forms whose head is SYMBOL definitional (R4.14): logged and replicated.', ([h]: SchemeValue[]) => { this.heads.add(S.sym(h, 'declare-definitional').name); return S.intern(S.sym(h).name); }));
    serverOnly(L.D('%share-variable', 'symbol [doc]', 'Replicate the global SYMBOL: every assignment broadcasts var{name, value} (R4.18).', ([n, doc]: SchemeValue[]) => this.shareVariable(S.sym(n, 'defvar-shared').name, typeof doc === 'string' ? doc : null)));
    serverOnly(L.D('%image-command', 'name . args', 'Run the image server command NAME (image-log, image-compact, image-reset, image-save-to-init, image-problems, image-revert-entry, image-entries) as the server.', ([n, ...args]: SchemeValue[]) => {
      const cmd: string = typeof n === 'string' ? n : S.sym(n, '%image-command').name;
      if (!COMMANDS[cmd]) throw new S.SchemeError('error', `%image-command: unknown command ${cmd}`, []);
      const r = COMMANDS[cmd](this, null, args.map(a => argToJSON(S, a)));
      if (r && typeof (r as Promise<ImageResult>).then === 'function') { (r as Promise<ImageResult>).catch(e => server.log.warn('image', { cmd, error: e.message })); return S.intern(cmd); }
      return resultToScheme(S, (r as ImageResult).value);
    }));
    serverOnly(L.D('%image-record', 'text [check]', 'Log the forms of TEXT, already evaluated in the server image, as image entries of the running thread (an agent, a command): persisted, replayed at start and sent to every frame. Every form must be definitional; returns the new generations. With CHECK true, only check that and return #t.', ([t, check]: SchemeValue[]) => {
      const text = S.str(t, '%image-record');
      const forms = L.readAll(text);
      if (!forms.length) throw new S.SchemeError('error', '%image-record: no form', []);
      for (const f of forms) if (!this.isDefinitional(f)) throw new S.SchemeError('error', `%image-record: ${S.write(f).slice(0, 80)} is not definitional (define, set!, define-key, add-hook!, ...); evaluate it with eval instead`, []);
      if (check !== undefined && check !== false) return true;
      const t0 = server.threads && server.threads.current;
      const by: By = t0 ? t0.by : SERVER_BY;
      const before = this.gen;
      const note = this.record(by, forms);
      if (note) throw new S.SchemeError('error', note, []);
      return S.listOf(this.after(before).map(e => BigInt(e.gen)));
    }));
    serverOnly(L.D('%edwin-find-source', 'name', 'Where the shipped Scheme (scm/*.scm) defines NAME: (file line), or #f. A textual scan for (define (NAME, (define NAME, (define-command (NAME and the like.', ([n]: SchemeValue[]) => {
      const nm = n instanceof S.Sym ? n.name : S.str(n, '%edwin-find-source');
      const esc = nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^\\s*\\((?:define|define-command|define-syntax|define-macro|defvar|defcustom|define-minor-mode|define-derived-mode|define-pi-tool)\\s+\\(?'?${esc}(?=[\\s)])`);
      let names: string[] = []; try { names = fs.readdirSync(path.join(EDWIN_TREE, 'scm')).filter(f => f.endsWith('.scm')).sort(); } catch (e) { return false; }
      for (const f of names) {
        const lines = fs.readFileSync(path.join(EDWIN_TREE, 'scm', f), 'utf8').split('\n');
        const i = lines.findIndex(l => re.test(l));
        if (i >= 0) return S.listOf([`edwin/scm/${f}`, BigInt(i + 1)]);
      }
      return false;
    }));
    serverOnly(L.D('%edwin-source', 'file line [count]', 'COUNT lines (default 40, at most 400) of the shipped source FILE (as find-definition-location names it, edwin/scm/emacs.scm) from LINE. Read-only; nothing outside the shipped tree.', ([f, ln, n]: SchemeValue[]) => {
      const rel = S.str(f, '%edwin-source').replace(/^edwin\//, '');
      const real = path.resolve(EDWIN_TREE, rel);
      if (!real.startsWith(EDWIN_TREE + path.sep) || rel.split('/').includes('node_modules')) throw new S.SchemeError('error', `%edwin-source: ${rel} is not in the shipped tree`, []);
      let text: string; try { text = fs.readFileSync(real, 'utf8'); } catch (e) { throw new S.SchemeError('error', `%edwin-source: no file ${rel}`, []); }
      const lines = text.split('\n'), from = Math.max(1, Number(ln) || 1), count = Math.min(400, Math.max(1, n === undefined ? 40 : Number(n) || 40));
      return lines.slice(from - 1, from - 1 + count).map((l, i) => `${from + i}: ${l}`).join('\n');
    }));
  }
  /* Replay the log after the boot files (R4.19, R15.9): a failing form is kept, marked and never stops the start.
     In safe mode nothing is replayed. A start whose replay had no failure is copied as a generation (the last
     good image), unless the newest one has the same entries. */
  replay(server: Server) {
    this.attach(server);
    const { L, Ed, log } = server;
    if (this.safe) { log.warn('image', { event: 'safe_mode', reason: this.safe.reason, entries: this.entries.length, gen: this.gen }); return; }
    let failed = 0;
    for (const e of this.entries) {
      delete e.failed;
      try { L.resetOps(); L.evalText(e.form); } catch (err) { e.failed = { error: Ed.errorText(err), at: Date.now() }; failed++; log.warn('image', { event: 'replay_failed', gen: e.gen, error: e.failed.error }); }
      finally { L.resetOps(); L.S.resetStack(); }
    }
    log.info('image', { event: 'replay', entries: this.entries.length, failed, epoch: this.epoch, gen: this.gen });
    if (!failed && this.entries.length) { try { this.checkpoint({ reason: 'start' }); } catch (e) { log.warn('image', { event: 'checkpoint', error: e.message }); } }
  }
  /* Is FORM (a read datum) definitional (R4.14)? begin and progn of only such forms count. */
  isDefinitional(form: SchemeValue): boolean {
    const S = this.server!.L.S;
    if (!(form instanceof S.Pair) || !(form.car instanceof S.Sym)) return false;
    const head = form.car.name;
    if (head === 'begin' || head === 'progn') { let p = form.cdr, n = 0; while (p instanceof S.Pair) { if (!this.isDefinitional(p.car)) return false; p = p.cdr; n++; } return p === S.NIL && n > 0; }
    if (!this.heads.has(head)) return false;
    if (head === 'set!' || head === 'setq') return form.cdr instanceof S.Pair && form.cdr.car instanceof S.Sym;
    return true;
  }
  /* The compaction key of a form text (R4.20, R4.21): "head name" for the heads that name a definition, else
     the form itself. A begin of definitions is keyed as a whole. */
  keyOf(text: string): string {
    const S = this.server!.L.S;
    try {
      const f = S.read(text);
      if (f instanceof S.Pair && f.car instanceof S.Sym && NAMED.has(f.car.name) && f.cdr instanceof S.Pair) {
        let n = f.cdr.car;
        if (n instanceof S.Pair) n = n.car; // (define (name . args) ...)
        if (n instanceof S.Sym) return `${f.car.name} ${n.name}`;
      }
    } catch (e) { /* keyed by text */ }
    return text;
  }
  /* The name a form defines, for the Q2 banner; null for an effect. */
  nameOf(text: string): string | null { const k = this.keyOf(text); return k === text ? null : k.slice(k.indexOf(' ') + 1); }

  /* After evalForm evaluated FORMS (read data) without a condition, for a client (BY is its by()) or a thread
     (%image-record): log and broadcast the definitional ones (R4.15). Returns a note for the echo area, or null. */
  record(by: By, forms: SchemeValue[]): string | null {
    const { L, log } = this.server!, S = L.S;
    const notes: string[] = [], texts: string[] = [], gens: number[] = [];
    for (const f of forms) {
      if (!this.isDefinitional(f)) continue;
      const text: string = S.write(f);
      const bytes = Buffer.byteLength(text);
      if (bytes > ENTRY_MAX) { notes.push(`Not logged to the image: a form of ${bytes} bytes is over the ${ENTRY_MAX >> 10} KiB limit (R4.21)`); log.warn('image', { event: 'too_large', bytes, by: by.kind }); continue; }
      const entry = this.append(text, by);
      texts.push(text); gens.push(entry.gen);
      log.info('image', { gen: entry.gen, by: by.kind });
    }
    if (texts.length) {
      this.broadcast({ t: 'image', gen: gens[gens.length - 1], forms: texts });
      if (by.kind === 'cli' || by.kind === 'agent') { // Q2: every frame hears that an agent or a shell changed the image
        const names = texts.map(t => this.nameOf(t) || (t.length > 60 ? t.slice(0, 57) + '...' : t)).join(', ');
        this.broadcast({ t: 'msg', text: `Image changed by ${originOf(by)}: ${names} (M-x image-log)`, level: 'info' }, true);
      }
      this.scheduleRefresh();
      if (this.overLimit()) this.compact({ auto: true });
    }
    return notes.length ? notes.join('\n') : null;
  }
  /* To every frame and web client (never cli): image, var and msg (R4.15, R4.18). */
  broadcast(obj: ImageMsg | VarMsg | EchoMsg, bulkish = false) {
    for (const c of this.server!.clients) if (c.hello && !c.closed && (c.kind === 'frame' || c.kind === 'web')) { if (bulkish) c.sendBulkish(obj); else c.sendBulk(obj); }
  }
  /* image?{from} (§7.4): the entries after FROM as image messages of at most 100 forms, then the current
     value of every shared variable (an assignment made inside a procedure is not a logged form). */
  sendAfter(client: Client, from: number): { gen: number } {
    if (this.safe && client.kind !== 'cli' && from <= this.safeFloor) client.sendBulkish({ t: 'msg', text: `edwind is in safe mode (${this.safe.reason}): init.scm and the image log were not run. M-x image-generations, image-rollback, image-restart`, level: 'warn' });
    const entries = this.after(this.safe ? Math.max(from, this.safeFloor) : from);
    for (let i = 0; i < entries.length; i += 100) { const slice = entries.slice(i, i + 100); client.sendBulk({ t: 'image', gen: slice[slice.length - 1].gen, forms: slice.map(e => e.form) }); }
    if (client.kind !== 'cli') for (const v of this.sharedValues()) client.sendBulk({ t: 'var', ...v });
    return { gen: this.gen };
  }

  /* ---------- shared variables (R4.18) ---------- */
  shareVariable(name: string, doc: string | null): SchemeValue {
    const { L } = this.server!, S = L.S;
    const box = S.gbox(name);
    const desc = Object.getOwnPropertyDescriptor(box, 'value');
    let cur: SchemeValue = desc && desc.get ? desc.get.call(box) : box.value;
    if (cur !== undefined) toJSON(S, cur, name); // the initial value must be shareable too
    this.shared.set(name, { doc });
    L.magic(name, () => cur, (v: SchemeValue) => { const json = toJSON(S, v, name); cur = v; this.broadcast({ t: 'var', name, value: json }); }, doc || undefined);
    if (cur !== undefined) this.broadcast({ t: 'var', name, value: toJSON(S, cur, name) });
    return S.intern(name);
  }
  /* The current values, for a client that (re)connects. */
  sharedValues(): SharedValue[] {
    const { L } = this.server!, S = L.S, out: SharedValue[] = [];
    for (const name of this.shared.keys()) { let v: SchemeValue; try { v = L.get(name); } catch (e) { continue; } if (v !== undefined) { try { out.push({ name, value: toJSON(S, v, name) }); } catch (e) { /* not shareable now */ } } }
    return out;
  }

  /* ---------- managing the world (R4.20, R4.21, Q2) ---------- */
  /* A new epoch after the log changed shape: the file is rewritten under it, and every frame and web client is
     told and disconnected, so its reconnect sees welcome.imageEpoch differ and starts a fresh runtime (R7.19).
     The disconnect is deferred so the caller's result goes out first. */
  changeEpoch(reason: string): string {
    this.epoch = randomEpoch();
    this.rewrite();
    this.server!.log.info('image', { event: 'epoch', reason, epoch: this.epoch, entries: this.entries.length, gen: this.gen });
    this.scheduleRefresh();
    if (this.epochTimer) clearTimeout(this.epochTimer);
    this.epochTimer = setTimeout(() => {
      this.epochTimer = null;
      for (const c of [...this.server!.clients]) if (c.hello && !c.closed && (c.kind === 'frame' || c.kind === 'web')) { c.send({ t: 'msg', text: `Image ${reason}: the frame runtime restarts`, level: 'info' }); c.destroy(); }
    }, 20);
    this.epochTimer.unref();
    return this.epoch;
  }
  overLimit(): boolean {
    return (this.entries.length > COMPACT_ENTRIES && this.entries.length >= this.autoFloor.entries) || (this.bytes > COMPACT_BYTES && this.bytes >= this.autoFloor.bytes);
  }
  /* Keep the last definition per name (R4.20); effects keyed by their text are deduplicated the same way. */
  compact({ auto = false }: { auto?: boolean } = {}) {
    this.checkpointQuiet(auto ? 'before automatic compaction' : 'before compaction');
    const last = new Map();
    for (const e of this.entries) last.set(this.keyOf(e.form), e.gen);
    const before = this.entries.length;
    this.entries = this.entries.filter(e => last.get(this.keyOf(e.form)) === e.gen);
    const dropped = before - this.entries.length;
    this.changeEpoch(auto ? 'compacted automatically' : 'compacted');
    this.autoFloor = { entries: this.entries.length + Math.ceil(COMPACT_ENTRIES / 10), bytes: this.bytes + Math.ceil(COMPACT_BYTES / 10) };
    return { kept: this.entries.length, dropped, gen: this.gen, epoch: this.epoch, auto };
  }
  /* Move the log aside as image.<time>.jsonl and start fresh at generation 0. */
  reset(reason = 'reset') {
    this.checkpointQuiet(`before ${reason}`);
    const archived = path.join(path.dirname(this.file), `image.${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    try { fs.renameSync(this.file, archived); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.entries = []; this.gen = 0; this.safeFloor = 0; // in safe mode, what is defined after the reset reaches frames
    this.changeEpoch(reason);
    return { archived, gen: 0, epoch: this.epoch };
  }
  /* Append the live entries to <configDir>/init.scm, then reset (R4.20). Failed entries go in as comments. */
  saveToInit(configDir: string) {
    const file = path.join(configDir, 'init.scm');
    const lines = [`\n;;; image log saved ${stamp(Date.now())} (${this.entries.length} entries)`];
    let saved = 0;
    for (const e of this.entries) {
      lines.push(`;; gen ${e.gen}, ${stamp(e.at)}, ${originOf(e.by)}`);
      if (e.failed) { lines.push(`;; failed at replay: ${e.failed.error}`); for (const l of e.form.split('\n')) lines.push(';; ' + l); }
      else { lines.push(e.form); saved++; }
    }
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
    const r = this.reset('saved to init.scm');
    return { file, saved, ...r };
  }
  /* Q2: remove one entry. A definition cannot be undone in place, so the epoch changes and every frame
     rebuilds from the log without it; the server image keeps the definition until its next start. */
  revertEntry(gen: number) {
    const i = this.entries.findIndex(e => e.gen === gen);
    if (i < 0) return null;
    this.checkpointQuiet(`before reverting entry ${gen}`);
    const [e] = this.entries.splice(i, 1);
    this.changeEpoch(`entry ${gen} reverted`);
    return { gen: e.gen, form: e.form, by: e.by, epoch: this.epoch };
  }
  /* A checkpoint before a change of shape; a failure to copy is logged and never stops the change. */
  checkpointQuiet(reason: string) {
    if (!this.entries.length) return;
    try { this.checkpoint({ reason }); } catch (e) { if (this.server) this.server.log.warn('image', { event: 'checkpoint', reason, error: e.message }); }
  }
  problems() { return this.entries.filter(e => e.failed).map(e => ({ gen: e.gen, at: e.at, by: e.by, origin: originOf(e.by), form: e.form, error: e.failed!.error })); }
  list() { return this.entries.map(e => ({ gen: e.gen, at: e.at, by: e.by, origin: originOf(e.by), form: e.form, failed: e.failed ? e.failed.error : undefined })); }

  /* ---------- the *image-log* buffer (R4.20) ---------- */
  render(): string {
    const out = [`Image log: ${this.entries.length} entries, generation ${this.gen}, epoch ${this.epoch}`, `(${this.file})`, ''];
    if (this.safe) out.splice(2, 0, `SAFE MODE (${this.safe.reason}): init.scm and these entries were not run; M-x image-rollback, image-restart`);
    const gens = this.generations();
    if (gens.length) out.splice(out.length - 1, 0, `${gens.length} generations, newest ${gens[gens.length - 1].id} (M-x image-generations)`);
    for (const e of this.entries) {
      out.push(`#${e.gen}  ${stamp(e.at)}  ${originOf(e.by)}${e.failed ? '  FAILED AT REPLAY: ' + e.failed.error : ''}`);
      out.push(e.form, '');
    }
    return out.join('\n');
  }
  /* The shared buffer for the log, made on demand: Edwin's read-only special buffer, shared as name:*image-log*. */
  logBuffer(create: boolean): SBuf | null {
    const { Ed, buffers } = this.server!;
    let sb = buffers.byId.get(LOG_BUFFER_ID);
    if (sb || !create) return sb || null;
    const ed = Ed.getBufferCreate(LOG_BUFFER); ed.mode = 'special-mode'; ed.readOnly = true;
    sb = buffers.resolve(LOG_BUFFER_ID, false) as SBuf;
    sb.readOnly = 'server special buffer';
    return sb;
  }
  /* Put the current rendering in the buffer as one server batch, so attached clients see it (R6.4). */
  async refresh(create = false): Promise<SBuf | null> {
    const sb = this.logBuffer(create);
    if (!sb) return null;
    await this.server!.buffers.replaceText(sb, this.render(), SERVER_BY);
    sb.savedText = sb.text; sb.savedHash = sha256(sb.savedText); // a rendering is never "modified"
    return sb;
  }
  scheduleRefresh() {
    if (this.refreshTimer || !this.server || !this.server.buffers || !this.server.buffers.byId.has(LOG_BUFFER_ID)) return;
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.refresh().catch(e => this.server!.log.warn('image', { event: 'refresh', error: e.message })); }, 0);
  }
}

/* The server commands: (image, client or null, args) -> result. */
const needForce = (args: unknown[], cmd: string) => { const a = args[0]; if (a === true || (a && typeof a === 'object' && (a as { force?: unknown }).force === true)) return; throw new ProtoError('bad_request', `${cmd} needs {force: true}: the caller confirms`); };
const COMMANDS: Record<string, ImageCommand> = {
  'image-log': async (image, client) => {
    const sb = (await image.refresh(true))!;
    if (client) client.send({ t: 'display', buf: sb.id, how: 'other-window' });
    return { value: { buf: sb.id, entries: image.entries.length, gen: image.gen }, msg: `Image log: ${image.entries.length} entries` };
  },
  'image-entries': image => ({ value: image.list() }),
  'image-problems': image => { const p = image.problems(); return { value: p, msg: p.length ? `${p.length} image entr${p.length === 1 ? 'y' : 'ies'} failed at replay` : 'Every image entry replayed' }; },
  'image-compact': image => { const r = image.compact(); return { value: r, msg: `Image compacted: ${r.dropped} superseded entr${r.dropped === 1 ? 'y' : 'ies'} dropped, ${r.kept} kept` }; },
  'image-reset': (image, client, args) => { needForce(args, 'image-reset'); const r = image.reset(); return { value: r, msg: `Image reset; the old log is ${path.basename(r.archived)}` }; },
  'image-save-to-init': (image, client, args) => { needForce(args, 'image-save-to-init'); const r = image.saveToInit(image.server!.cfg.configDir); return { value: r, msg: `${r.saved} entr${r.saved === 1 ? 'y' : 'ies'} appended to ${r.file}; image reset` }; },
  'image-revert-entry': (image, client, args) => {
    const a = args[0], gen = Number.isInteger(a) ? a as number : (a && typeof a === 'object' && Number.isInteger((a as { gen?: unknown }).gen) ? (a as { gen: number }).gen : null);
    if (gen === null) throw new ProtoError('bad_request', 'image-revert-entry needs {gen}');
    const r = image.revertEntry(gen);
    if (!r) throw new ProtoError('bad_request', `no image entry with generation ${gen}`);
    return { value: r, msg: `Image entry ${gen} reverted; frames rebuild without it (the server keeps it until restart)` };
  },
  /* Generations: [label] or {label}. */
  'image-checkpoint': (image, client, args) => {
    const a = args[0], label = typeof a === 'string' ? a : (a && typeof a === 'object' && typeof (a as { label?: unknown }).label === 'string' ? (a as { label: string }).label : null);
    const r = image.checkpoint({ label: label || null, reason: 'checkpoint', by: client ? client.by() : SERVER_BY });
    return { value: r.generation, msg: r.made ? `Image generation ${r.generation.id}: ${r.generation.entries} entries` : `The image is unchanged since generation ${r.generation.id}` };
  },
  'image-generations': image => { const g = image.generations(); return { value: g, msg: g.length ? `${g.length} image generations, newest ${g[g.length - 1].id}` : 'No image generation yet' }; },
  /* [id, force, restart] or {id, force, restart}: replace the log by generation ID, then optionally restart. */
  'image-rollback': (image, client, args) => {
    const a = args[0];
    const o = (a && typeof a === 'object' && !Array.isArray(a) ? a : { id: a, force: args[1], restart: args[2] }) as { id?: unknown; force?: unknown; restart?: unknown };
    if (!Number.isInteger(o.id)) throw new ProtoError('bad_request', 'image-rollback needs {id} (image-generations lists them)');
    if (o.force !== true) throw new ProtoError('bad_request', 'image-rollback needs {force: true}: the caller confirms');
    const r = image.rollback(o.id as number, client ? client.by() : SERVER_BY);
    if (!r) throw new ProtoError('bad_request', `no image generation ${o.id}`);
    const restart = o.restart === true;
    if (restart) image.server!.restart(`image rolled back to generation ${r.id}`);
    return { value: { ...r, restart }, msg: `Image rolled back to generation ${r.id} (${r.entries} entries; the log before it is generation ${r.before}). ${restart ? 'edwind restarts' : 'Frames rebuild now; the server keeps its definitions until M-x image-restart'}` };
  },
  'image-restart': (image, client, args) => { needForce(args, 'image-restart'); image.server!.restart('image-restart'); return { value: { exit: RESTART_EXIT }, msg: 'edwind restarts: the server image is rebuilt from the boot files, init.scm and the image log' }; },
};

export async function install(server: Server) {
  const image = server.image;
  image.attach(server);
  for (const [cmd, fn] of Object.entries(COMMANDS)) server.defineCommand(cmd, (client, args) => fn(image, client, args || []));
  server.statusProviders.push(() => ({ imageGen: image.gen, imageEpoch: image.epoch, imageEntries: image.entries.length, imageBytes: image.bytes, imageProblems: image.problems().length, imageSafe: image.safe, imageGenerations: image.generations().length }));
}
export async function shutdown(server: Server) {
  const image = server.image;
  if (image.refreshTimer) { clearTimeout(image.refreshTimer); image.refreshTimer = null; }
  if (image.epochTimer) { clearTimeout(image.epochTimer); image.epochTimer = null; }
  image.settled();
}
