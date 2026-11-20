/* Read-only live-hub inspection, not a suite: node tools/agent-live.mts [--allow-cleartext] URL TOKEN_FILE [SID]
   Constructs AgentSessions and real daemon buffers in-process, in disposable state. It never calls
   Server.start(), agent-sessions.install() or installPrompts(). The core's agent-sessions/agent-prompts
   UI modules are also omitted: prompt, cancel, permission, mode, config, start and remove commands
   are never registered or invoked. The transcript module is used only for frame fold installation.
   The GET-only request override also refuses writes before they reach HTTP. Only the feature's
   token() reads the token file; neither credentials nor headers are logged. No user init is loaded.
   Previews use the frame's fold/line/glyph code, as unwrapped logical lines without faces or cursor.
   openMs excludes core boot and the initial stream snapshot. Hub I/O deadline: 120 seconds. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { AgentSessions, validateAgentHub } from '../server/agent-sessions.mts';
import { Buffers } from '../server/buffers.mts';
import { AgentAuthority } from '../server/agent-files.mts';
import type { Ed, EdBuffer, Log, Server } from '../server/main.mts';

const { createHost, coreSource, FILES } = createRequire(import.meta.url)('../src/host-node.cts');
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LINES = 60, OPEN_WIDTH = 200;
const BOUND_MARKER = '[EVENT CONTENT TRUNCATED: rendered event limit is 1048576 UTF-16 code units]';

class ReadOnlySessions extends AgentSessions {
  declare failure: Error | undefined;
  override async request(method: 'GET' | 'POST' | 'DELETE', route: string, body?: unknown) {
    if (method !== 'GET' || body !== undefined) throw new Error('agent-live refuses every non-GET request');
    try { return await super.request('GET', route); }
    catch (e) {
      const message = typeof e.status === 'number'
        ? `HTTP ${e.status}${[401, 403].includes(e.status) ? ' (authentication/authorization refused)' : ''}`
        : String(e.message || e);
      this.failure ??= new Error(this.clean(`GET /v1/${route}: ${message}`));
      throw this.failure;
    }
  }
  override changed() {
    if (!this.stopped && this.status.startsWith('offline'))
      this.failure ??= new Error(`Agent hub stream refused or disconnected: ${this.status}`);
    super.changed();
  }
  check() { if (this.failure) throw this.failure; }
}

async function until(hub: ReadOnlySessions, ready: () => boolean) {
  for (;;) { hub.check(); if (ready()) return; await sleep(20); }
}

function preview(Ed: Ed, b: EdBuffer, count: number, width?: number): string[] {
  const from = Ed.vLineStart(b, Math.max(1, count));
  const rows: unknown[] = Ed.renderBuffer(b, { from, count: LINES, runs: true, html: false, pt: -1 });
  return rows.map(row => {
    const glyphs: { t: string }[] = Ed.display.glyphsOf(row);
    const text = glyphs.map(g => g.t).join('');
    if (width === undefined) return text;
    let out = '', n = 0;
    for (const ch of text) { if (n++ === width) break; out += ch; }
    return out;
  });
}
function excerpts(Ed: Ed, b: EdBuffer, width?: number): string[] {
  const total = Ed.vLineCount(b);
  return [`Visible logical lines: ${total}`, `--- first ${LINES} ---`, ...preview(Ed, b, 1, width),
    `--- last ${LINES} (overlaps first for short buffers) ---`, ...preview(Ed, b, total - LINES + 1, width)];
}

async function main() {
  const args = process.argv.slice(2);
  const allowCleartext = args[0] === '--allow-cleartext';
  if (allowCleartext) args.shift();
  if (args.length < 2 || args.length > 3) throw new Error('Usage: node tools/agent-live.mts [--allow-cleartext] URL TOKEN_FILE [SID]');
  const config = validateAgentHub({ url: args[0], tokenFile: path.resolve(args[1]), allowCleartext }), sid = args[2];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edwin-agent-live-'));
  let buffers: Buffers | undefined, hub: ReadOnlySessions | undefined, deadline: NodeJS.Timeout | undefined;
  try {
    const stateDir = path.join(root, 'state'), configDir = path.join(root, 'config'), notesDir = path.join(root, 'notes');
    for (const dir of [stateDir, configDir, notesDir]) fs.mkdirSync(dir, { mode: 0o700 });
    const host = createHost({ scmDir: path.join(ROOT, 'scm'), configDir, workers: false });
    host.userConfig = () => null;
    // The host's exact source order/stripper, excluding modules that register agent mutation commands.
    const globals = globalThis as typeof globalThis & { EdHost: unknown; SCHEME_MODE: string; Ed: Ed };
    globals.EdHost = host; globals.SCHEME_MODE = 'gen';
    for (const file of FILES as string[]) {
      if (file === 'agent-sessions' || file === 'agent-prompts') continue;
      const source = coreSource(file); vm.runInThisContext(source.text, { filename: source.filename });
    }
    const Ed = globals.Ed;
    Ed.boot({ host }); await Ed.whenIdle();
    Ed.installAgentTranscript(false);
    const log: Log = { debug() {}, info() {}, warn() {}, error() {} };
    const auth = new AgentAuthority({ stateDir, configDir, notesDir }, config.tokenFile, null);
    buffers = new Buffers({ Ed, auth, stateDir, log });
    // Deliberately no defineCommand, module installer, listener socket, user image or prompt store.
    const server = { cfg: { agentHub: config }, buffers, auth, log, clients: [] } as unknown as Server;
    hub = new ReadOnlySessions(server);
    const live = hub;
    const idle = () => !live.replaying.size && !live.retries.size && !live.factReads.size && !live.factRetries.size && !live.publications.size && !live.listJob &&
      [...live.requests].every(req => req === live.stream);
    deadline = setTimeout(() => {
      live.failure ??= new Error('Agent hub inspection timed out after 120 seconds'); live.stop();
    }, 120000);
    hub.start();
    await until(hub, () => live.status === 'connected');
    const header = 'Edwin agent-live — READ ONLY: GET requests only; no agent mutation commands installed.\n';
    if (sid === undefined) {
      const id = await hub.list();
      await until(hub, idle);
      const text = buffers.get(id).text;
      hub.stop();
      process.stdout.write(hub.clean(header + '\n' + text));
      return;
    }
    const start = performance.now(), id = await hub.open(sid);
    await until(hub, () => {
      if (!idle()) return false;
      const t = live.transcripts.get(sid), s = live.sessions.get(sid);
      return !t || t.epoch === s?.createdAt && t.head === (s.acp?.headSeq || 0);
    });
    const elapsed = performance.now() - start, sb = buffers.get(id), meta = sb.meta();
    const t = hub.transcripts.get(sid), view = t?.render(), state = hub.clean(hub.snapshot(sid));
    const eventCount = t?.journal.length ?? null;
    hub.check(); hub.stop(); // Freeze the caught-up snapshot before changing presentation-only folds.
    const b = sb.ed;
    b.meta = meta;
    Ed.hooks.bufferMeta(b, meta.locals, meta.ver);
    const spans = view?.spans || [];
    const metrics = { bufferId: id, openMs: Number(elapsed.toFixed(2)), journalEvents: eventCount,
      epoch: state.epoch, head: view?.head ?? null, spans: spans.length, defaultFolds: b.folds?.length || 0 };
    const boundMarkers = spans.flatMap(s => {
      const text = b.rope.slice(s.start, s.end) as string;
      let occurrences = 0, at = text.indexOf(BOUND_MARKER);
      while (at >= 0) { occurrences++; at = text.indexOf(BOUND_MARKER, at + BOUND_MARKER.length); }
      return occurrences ? [{ seq: s.seq, kind: s.kind, occurrences }] : [];
    });
    const output = [header, '=== Open (milliseconds; journalEvents=null means a reported/PTY record, not an ACP journal) ===',
      JSON.stringify(metrics, null, 2), '\n=== Default folds (frame glyphs, unwrapped, no cursor/faces) ===', ...excerpts(Ed, b)];
    b.folds = []; b._foldVer = (b._foldVer || 0) + 1;
    output.push(`\n=== All folds open (each line cut to ${OPEN_WIDTH} Unicode characters) ===`, ...excerpts(Ed, b, OPEN_WIDTH),
      '\n=== Host-page pending requests and control state ===', JSON.stringify(state, null, 2),
      '\n=== Truncation / bounds ===', JSON.stringify({ journalAvailable: !!t, replayTruncated: view?.truncated ?? null,
        from: view?.from ?? null, gaps: view?.gaps ?? [], localDropThrough: view?.droppedThrough ?? null, renderedBoundMarker: BOUND_MARKER, boundMarkers,
        note: 'Bound-marker occurrences include literal agent quotations. Preview clipping to 200 characters is not journal truncation.' }, null, 2));
    process.stdout.write(hub.clean(output.join('\n') + '\n'));
  } catch (e) {
    // No stack, request object, response body or headers. Feature-owned redaction remains live after stop().
    throw new Error(hub ? hub.clean(String((hub.failure || e).message || e)) : String(e.message || e));
  } finally {
    clearTimeout(deadline);
    const work = hub ? [...hub.replaying.values(), ...hub.factReads.values(), ...hub.publications.values(), ...(hub.listJob ? [hub.listJob] : [])] : [];
    hub?.stop();
    await Promise.allSettled(work);
    if (buffers) {
      buffers.watcher.close();
      clearTimeout(buffers.index.timer ?? undefined);
      for (const sb of buffers.all()) { clearTimeout(sb.autosave ?? undefined); sb.journal?.close(); }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

try { await main(); }
catch (e) {
  // Error text only, escaped like display control characters; never dump an HTTP error object.
  console.error('agent-live: ' + String(e.message || e).replace(/[\x00-\x1f\x7f-\x9f]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`));
  process.exitCode = 1;
}
