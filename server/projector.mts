// The note projector: edwind tells brain what each note file holds (brain's docs/API.md, POST /v1/projection), so
// brain knows the notes, their ids and their links while the text stays in the files. One record per file: the
// entries that have an Org id (the file, a heading) with title, aliases, tags, the id above and the link names
// written under them. A file without ids sends an empty record, as a file that is gone does; brain drops what
// the path listed before.
//
// Only saved text is projected: a file open in a buffer with unsaved changes waits for its save. A ledger in
// stateDir (path -> hash of the record brain last took) says what is owed, so a restart sends only what changed
// while edwind was down, and a lost ledger costs one resend of everything, which brain takes as no change. A
// file is gone only when it is neither in the index nor on disk, and never while the index is empty: what the
// index leaves out or has not reached, and a notes directory that failed to mount, delete nothing in brain.
//
// One request at a time. A failed one is retried with a growing delay, after the other files; a record brain
// itself refuses (400, 409, 413 with its JSON error) waits until the file changes. Off unless edit.json has
// `brain`.
//
// The token is a LoadCredential file, read for each request and never logged; it is not among the credentials
// Scheme can name (models.credentials). Plain http goes only to this host: loopback, or an address one of its
// interfaces holds, checked when the request is made.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { writeAtomic } from './files.mts';
import { Credential, isLoopback, readSecret } from './models.mts';
import type { Server, Log } from './main.mts';
import type { Notes, IndexEntry } from './notes.mts';
import type { ParseResult } from './notes-parse.mts';

export const name = 'projector';
/* How long after a change the index is compared with the ledger: a burst of changes is one pass. */
export const SETTLE_MS = Number(process.env.EDWIND_PROJECTOR_SETTLE_MS) || 2000;
export const RETRY_MIN_MS = Number(process.env.EDWIND_PROJECTOR_RETRY_MS) || 1000;
export const RETRY_MAX_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;
/* How much of brain's answer is read: enough for its error object. */
const ANSWER_BYTES = 64 * 1024;
/* brain's limits (brain_server.py): longer values are cut or left out here so one of them does not refuse the file. */
const MAX_ID = 200, MAX_TITLE = 1000, MAX_NAME = 1000, MAX_LINK = 2048;
export const SCOPE = /^(pub|ref|work|infra|self)(\.[a-z0-9_]+)*$/;
/* A link target that names something by a scheme (task:12, doi:…); `id:` links are the index's kind 'title'. */
const SCHEMED = /^[a-z][a-z0-9-]*:\S/i;
/* Syncthing's copies of a conflicting edit carry the ids of the file they copy. */
const CONFLICT = /\.sync-conflict-/;
const REFUSED = new Set([400, 409, 413]);
/* brain's own word that it will not take a record, as against an error page from anything else that answers. */
function refusal(text: string): boolean {
  try { const o = JSON.parse(text); return !!o && typeof o.error === 'string'; } catch (e) { return false; }
}
/* The first N UTF-16 units of S, without half a surrogate pair at the end. */
const cut = (s: string, n: number): string => s.length <= n ? s : s.slice(0, /[\uD800-\uDBFF]/.test(s[n - 1]) ? n - 1 : n);

export interface ProjectedNote { id: string; title: string; aliases?: string[]; tags?: string[]; parent?: string; links?: string[] }
export interface ProjectedFile { path: string; scope: string; notes: ProjectedNote[] }

/* What the file ID holds for brain: REC is its parse, null when the file is gone. SCOPE is the scope of a file
   that names none with `#+brain_scope:`. */
export function recordOf(id: string, rec: ParseResult | null, scope: string): ProjectedFile {
  const out: ProjectedFile = { path: id, scope, notes: [] };
  if (!rec) return out;
  const named = rec.file.props.brain_scope;
  if (named && SCOPE.test(named)) out.scope = named;
  const byId = new Map<string, ProjectedNote>();
  const strings = (xs: string[]) => xs.filter(x => x.length <= MAX_NAME);
  const note = (orgId: string | null, title: string, tags: string[], aliases: string[], parent: string | null): string | null => {
    const oid = (orgId || '').trim();
    if (!oid || oid.length > MAX_ID) return null;
    if (byId.has(oid)) return oid;   // a copied heading: the first entry with the id is the note
    const n: ProjectedNote = { id: oid, title: cut(title, MAX_TITLE) };
    if (aliases.length) n.aliases = strings(aliases);
    if (tags.length) n.tags = strings(tags);
    if (parent && parent !== oid) n.parent = parent;
    byId.set(oid, n); out.notes.push(n);
    return oid;
  };
  const fileId = note(rec.file.orgId, rec.file.title ?? id, rec.file.tags, rec.file.aliases, null);
  /* owners[i] is the note the text under heading i belongs to: its own id, else that of the nearest heading
     above that has one, else the file's. */
  const stack: { level: number; owner: string | null }[] = [], owners: { line: number; owner: string | null }[] = [];
  for (const h of rec.headings) {
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    const above = stack.length ? stack[stack.length - 1].owner : fileId;
    const owner = note(h.orgId, h.title, h.tags, [], above) ?? above;
    stack.push({ level: h.level, owner }); owners.push({ line: h.line, owner });
  }
  let at = -1;
  for (const l of rec.links) {
    if (!(l.kind === 'title' || (l.kind === 'wiki' && SCHEMED.test(l.dst))) || l.dst.length > MAX_LINK) continue;
    if (at >= 0 && owners[at].line > l.line) at = -1;
    while (at + 1 < owners.length && owners[at + 1].line <= l.line) at++;
    const owner = at >= 0 ? owners[at].owner : fileId;
    if (!owner) continue;
    const n = byId.get(owner)!;
    if (!n.links) n.links = [];
    if (!n.links.includes(l.dst)) n.links.push(l.dst);
  }
  return out;
}
const hashOf = (record: ProjectedFile): string => crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
/* Whether HOST, a URL's hostname, is an address of this machine. */
const localAddress = (host: string): boolean => { const h = host.replace(/^\[|\]$/g, ''); return Object.values(os.networkInterfaces()).some(list => (list || []).some(a => a.address === h)); };

export class Projector {
  declare server: Server; declare log: Log; declare notes: Notes;
  declare url: URL; declare credential: Credential; declare scope: string;
  declare ledgerFile: string;
  /* path -> the hash of the record brain last took for it; `!hash` for one brain refused. */
  declare ledger: Map<string, string>;
  declare hashes: WeakMap<ParseResult, string>;
  declare timer: NodeJS.Timeout | null;
  /* started: the index has finished its first scan, so what it lacks is gone. dirty: the ledger changed since it was written. */
  declare started: boolean; declare running: boolean; declare stopped: boolean; declare dirty: boolean; declare retryMs: number;
  declare request: http.ClientRequest | null;
  /* The file whose request failed last: it goes after the others, so one brain cannot take does not hold them up. */
  declare failed: string | null;
  constructor(server: Server, notes: Notes) {
    const cfg = server.cfg.brain!;
    this.server = server; this.log = server.log; this.notes = notes;
    this.url = new URL('v1/projection', cfg.url.endsWith('/') ? cfg.url : cfg.url + '/');
    this.credential = new Credential(cfg.credential, this.url.origin); this.scope = cfg.scope;
    this.ledgerFile = path.join(server.cfg.stateDir, 'projector.json');
    this.ledger = new Map(); this.hashes = new WeakMap();
    this.timer = null; this.started = false; this.running = false; this.stopped = false; this.dirty = false; this.retryMs = 0; this.request = null; this.failed = null;
    this.load();
  }
  load() {
    let saved: any; // any: the ledger file, checked below
    try { saved = JSON.parse(fs.readFileSync(this.ledgerFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') this.log.warn('projector', { ledger: 'unreadable', error: e.message }); return; }
    /* A ledger kept for another brain says nothing about this one. */
    if (!saved || saved.v !== 1 || saved.to !== this.url.origin || !saved.files || typeof saved.files !== 'object') return;
    for (const [id, h] of Object.entries(saved.files)) if (typeof h === 'string') this.ledger.set(id, h);
  }
  save() {
    if (!this.dirty) return;
    this.dirty = false;
    try { writeAtomic(this.ledgerFile, JSON.stringify({ v: 1, to: this.url.origin, files: Object.fromEntries(this.ledger) })); }
    catch (e) { this.log.warn('projector', { ledger: 'not written', error: e.message }); }
  }
  /* Whether the index entry E of the file ID is its saved text: an open buffer with unsaved changes, or one
     edited since its last parse, is not yet. */
  saved(id: string, e: IndexEntry): boolean {
    const sb = this.notes.bufferFor(id);
    return sb ? !sb.modified && !this.notes.bufferTimers.has(sb) : !e.fromBuffer;
  }
  hash(id: string, rec: ParseResult): string {
    let h = this.hashes.get(rec);
    if (!h) { h = hashOf(recordOf(id, rec, this.scope)); this.hashes.set(rec, h); }
    return h;
  }
  /* Whether the note file ID is gone: neither in the index nor on disk. A file the index leaves out (too
     large, unreadable) or has not reached holds what it held, and a notes directory that is missing or empty
     (a mount that failed) is not a thousand deleted notes. The index says when to look: a file it left out
     that is then deleted is seen at the next pass. */
  gone(id: string): boolean {
    if (this.notes.files.has(id) || !this.notes.files.size || !this.notes.exists()) return false;
    try { fs.lstatSync(path.join(this.notes.root, id)); return false; } catch (e) { return e.code === 'ENOENT' || e.code === 'ENOTDIR'; }
  }
  /* The files whose record brain does not hold: changed or new ones, then those that are gone. */
  owed(): string[] {
    const out: string[] = [];
    for (const [id, e] of this.notes.files) {
      if (CONFLICT.test(id) || !this.saved(id, e)) continue;
      const have = this.ledger.get(id), h = this.hash(id, e.rec);
      if (have !== h && have !== '!' + h) out.push(id);
    }
    for (const id of this.ledger.keys()) if (this.gone(id)) out.push(id);
    const i = this.failed === null ? -1 : out.indexOf(this.failed);
    if (i >= 0) out.push(out.splice(i, 1)[0]);
    return out;
  }
  schedule(ms: number = SETTLE_MS) {
    if (!this.started || this.stopped || this.running || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.run().catch(e => this.log.error('projector', { error: e.message })); }, ms);
    this.timer.unref();
  }
  async run() {
    if (this.running || this.stopped) return;
    this.running = true;
    let sent = 0, refused = 0, at: string | null = null;
    const t0 = Date.now();
    try {
      for (let list = this.owed(); list.length && !this.stopped; list = this.owed()) {
        for (const id of list) {
          if (this.stopped) return;
          /* The index may have moved on while the last request was out. */
          const e = this.notes.files.get(id);
          if (e ? !this.saved(id, e) : !this.gone(id)) continue;
          const record = recordOf(id, e ? e.rec : null, this.scope);
          at = id;
          const status = await this.send(record);
          this.retryMs = 0;
          if (this.failed === id) this.failed = null;
          if (REFUSED.has(status)) { refused++; this.log.warn('projector', { file: id, refused: status }); }
          else sent++;
          if (e) this.ledger.set(id, (REFUSED.has(status) ? '!' : '') + hashOf(record));
          else this.ledger.delete(id);
          this.dirty = true;
        }
      }
    } catch (e) {
      if (this.stopped) return;
      this.failed = at;
      this.retryMs = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, this.retryMs * 2));
      this.log.warn('projector', { error: e.message, retryMs: this.retryMs });
    } finally {
      this.running = false;
      this.save();
      if (sent || refused) this.log.info('projector', { sent, refused, ms: Date.now() - t0 });
      if (this.retryMs) this.schedule(this.retryMs);
    }
  }
  /* POST RECORD; resolves to the status when brain took it (2xx) or refused it for good, rejects otherwise. */
  send(record: ProjectedFile): Promise<number> {
    return new Promise((resolve, reject) => {
      const u = this.url;
      if (u.protocol === 'http:' && !isLoopback(u.href) && !localAddress(u.hostname)) { reject(new Error(`plain http only to this host, and ${u.hostname} is not an address of it`)); return; }
      const token = readSecret(this.credential);
      if (!token) { reject(new Error(`the credential ${this.credential.name} is not readable`)); return; }
      const body = Buffer.from(JSON.stringify(record));
      const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', timeout: REQUEST_TIMEOUT_MS, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': body.length } }, res => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (d: Buffer) => { if (size < ANSWER_BYTES) { chunks.push(d); size += d.length; } });
        res.on('end', () => {
          this.request = null;
          const s = res.statusCode || 0;
          if ((s >= 200 && s < 300) || (REFUSED.has(s) && refusal(Buffer.concat(chunks).toString()))) resolve(s);
          else reject(new Error(`brain answered ${s}`));
        });
        res.on('error', e => { this.request = null; reject(e); });
      });
      this.request = req;
      req.on('timeout', () => req.destroy(new Error('brain did not answer in time')));
      req.on('error', e => { this.request = null; reject(e); });
      req.end(body);
    });
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.request) this.request.destroy();
    this.save();
  }
}

let projector: Projector | null = null;
export async function install(server: Server): Promise<void> {
  const notes = server.notes;
  if (!server.cfg.brain || !notes) return;
  const p = projector = new Projector(server, notes);
  notes.onChange.push(() => p.schedule());
  /* A save changes no parse, only whether the buffer's text is the file's. */
  server.buffers.on('saved', () => p.schedule());
  notes.ready.then(() => { p.started = true; p.schedule(0); });
}
export async function shutdown(): Promise<void> { if (projector) projector.stop(); projector = null; }
