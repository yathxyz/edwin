// Agent steering: ordinary shared Markdown drafts; HTTP mutations go only through AgentBackend.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomId, type IndexEntry } from './journal.mts';
import { sha256, diskState } from './files.mts';
import { lexicalPath } from './buffers.mts';
import type { SBuf } from './buffers.mts';
import type { Server } from './main.mts';
import type { AgentBackend } from './agent-sessions.mts';
import type { CallResult } from './proto.mts';

interface Block { type: string; [key: string]: unknown }
interface Target { sid: string; epoch: number | null }
interface Delivery {
  key: string; targets: Target[]; acknowledged: Target[]; possiblySent: Target[];
}
interface Draft extends Delivery {
  blocks: Block[]; baseText: string; name?: string;
}
interface Preview { draft: string; targets: Target[]; possiblySent: Target[]; blocks: Block[] }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v); // any: ACP JSON
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const fail = (message: string): never => { throw new Error(message); };
const text = (v: unknown, what: string): string => typeof v === 'string' && v.length ? v : fail(`${what} must be a nonempty string`);
const sidOf = (v: unknown): string => { const s = text(v, 'Session'); if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) fail('Not an ACP session id'); return s; };
const epochOf = (v: unknown): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : fail('A captured session incarnation (epoch) is required');
const targetKey = (v: Target): string => `${v.sid}/${v.epoch}`;
function requireUnsent(d: Delivery, target: Target) {
  const same = (t: Target) => t.sid === target.sid && t.epoch === target.epoch;
  if (d.acknowledged.some(same)) fail(`This prompt was already acknowledged by ${target.sid} (${target.epoch}); it will not be sent again`);
  if (d.possiblySent.some(same)) fail(`This prompt was possibly sent to ${target.sid} (${target.epoch}); check the session before sending a new prompt`);
}
const uncertain = (d: Delivery) => d.possiblySent.length ? ` Possibly sent to: ${d.possiblySent.map(targetKey).join(', ')}; these destinations will not be retried.` : '';
function targetsOf(v: unknown, retained = false): Target[] {
  if (!Array.isArray(v)) fail('Targets must be an array of {sid, epoch} destinations');
  const targets = (v as unknown[]).map(t => {
    if (retained && typeof t === 'string') return { sid: sidOf(t), epoch: null };
    if (!object(t)) return fail('Each destination needs its captured session id and epoch');
    return { sid: sidOf(t.sid), epoch: retained && t.epoch === null ? null : epochOf(t.epoch) };
  });
  return [...new Map(targets.map(t => [targetKey(t), t])).values()];
}
function blocksOf(v: unknown): Block[] {
  if (!Array.isArray(v) || !v.every(b => object(b) && typeof b.type === 'string')) fail('Blocks must be ACP content blocks');
  return copy(v as Block[]);
}
const promptText = (blocks: Block[]) => blocks.filter(b => b.type === 'text').map(b => typeof b.text === 'string' ? b.text : '').join('\n\n');
const keyOf = (v: unknown): string => {
  const s = text(v, 'Draft'), m = /^(?:name:)?\*Agent Prompt: ([a-zA-Z0-9_-]+)\*$/.exec(s);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]+$/.test(s)) return s;
  return fail('Not an agent prompt draft');
};
const nameOf = (d: Draft) => `*Agent Prompt: ${d.key}*`;
const idOf = (d: Draft) => `name:${nameOf(d)}`;

// A process without the prompt writer lock must not open or heal the writer's draft journals.
export function isPromptDraft(dir: string, e: IndexEntry): boolean {
  const key = /^name:\*Agent Prompt: ([A-Za-z0-9_-]+)\*$/.exec(e.id)?.[1];
  return !!key && e.file === path.join(dir, `${key}.md`);
}

export async function installPrompts(server: Server, backend: AgentBackend): Promise<{ stop(): Promise<void> }> {
  const buffers = server.buffers, auth = server.auth.agent!;
  const store = auth.promptStore ?? fail('Agent prompt store is not locked');
  const dir = store.dir;
  const drafts = new Map<string, Draft>(), sending = new Set<string>(), owned = new Map<SBuf, Draft>();
  const markdown = (d: Draft) => path.join(dir, `${d.key}.md`);
  const persist = <T extends Delivery,>(d: T) => store.writeReceipt(`${d.key}.json`, JSON.stringify(d) + '\n');
  function draft(v: unknown): Draft { const d = drafts.get(keyOf(v)); return d || fail('No such agent prompt draft'); }
  function writable(d: Delivery) { if (sending.has(d.key)) fail('This prompt is being sent'); }
  function meta(sb: SBuf, d: Draft) {
    owned.set(sb, d);
    sb.replayMeta = true;
    const original = sb.meta.bind(sb);
    sb.meta = () => { const m = original(); m.locals = { ...m.locals, agentPrompt: { id: sb.id, targets: d.targets, possiblySent: d.possiblySent, name: d.name || null, resources: d.blocks.reduce((n, b) => n + Number(b.type !== 'text'), 0) } }; return m; };
  }
  function open(d: Draft): SBuf {
    const live = buffers.live(idOf(d));
    if (live) return live;
    const body = store.read(`${d.key}.md`);
    const sb = buffers.create({ id: idOf(d), jid: randomId(), name: nameOf(d), file: markdown(d), text: body });
    server.Ed.switchMajorMode(sb.ed, 'markdown-mode');
    meta(sb, d); buffers.startJournal(sb); buffers.index.write();
    return sb;
  }
  function durable(sb: SBuf, d: Draft): string {
    const body = sb.text;
    const stat = store.write(`${d.key}.md`, body);
    sb.savedText = body; sb.savedHash = sha256(body); sb.savedVer = sb.ver;
    sb.disk = diskState(stat);
    return body;
  }
  async function snapshot(d: Draft): Promise<Preview> {
    const sb = open(d);
    if (buffers.seq.flushHold) buffers.seq.flushHold(sb);
    if (sb.journal) await sb.journal.drain();
    if (sb.readOnly) fail(String(sb.readOnly));
    const body = durable(sb, d);
    let blocks = copy(d.blocks);
    // Recalled blocks are immutable until the editable text actually changes. Resource order stays intact.
    if (body !== d.baseText) {
      let placed = false;
      blocks = blocks.flatMap(b => b.type !== 'text' ? [b] : placed ? [] : (placed = true, [{ type: 'text', text: body }]));
      if (!placed && body) blocks.unshift({ type: 'text', text: body });
    }
    return { draft: sb.id, targets: d.targets, possiblySent: d.possiblySent, blocks };
  }
  async function create(value: unknown): Promise<string> {
    const a = object(value) ? value : {}, targets = targetsOf(a.targets ?? (a.sid ? [{ sid: a.sid, epoch: a.epoch }] : []));
    for (const target of targets) await backend.requireSession(target.sid, epochOf(target.epoch));
    const blocks = a.blocks === undefined ? [{ type: 'text', text: typeof a.text === 'string' ? a.text : '' }] : blocksOf(a.blocks);
    const d: Draft = { key: randomId(), targets, acknowledged: [], possiblySent: [], blocks, baseText: backend.clean(promptText(blocks)) };
    store.write(`${d.key}.md`, d.baseText); persist(d); drafts.set(d.key, d); open(d);
    return idOf(d);
  }
  const entries = store.entries();
  for (const file of entries) {
    if (!/^[A-Za-z0-9_-]+\.json$/.test(file) || file === 'named.json' || file.startsWith('direct-')) continue;
    try {
      const d = JSON.parse(store.read(file)) as Draft;
      if (!object(d) || d.key !== file.slice(0, -5) || typeof d.baseText !== 'string') fail('Invalid persisted agent prompt');
      d.acknowledged = targetsOf(d.acknowledged === undefined ? [] : d.acknowledged);
      d.possiblySent = targetsOf(d.possiblySent === undefined ? [] : d.possiblySent);
      d.targets = targetsOf(d.targets, true); d.blocks = blocksOf(d.blocks);
      const live = buffers.live(idOf(d));
      if (live) { server.Ed.switchMajorMode(live.ed, 'markdown-mode'); meta(live, d); durable(live, d); }
      else open(d);
      drafts.set(d.key, d);
    } catch { server.log.warn('agent-prompt', { error: 'Skipped unreadable retained draft' }); }
  }
  const offBatch = buffers.on('afterBatch', sb => {
    const d = owned.get(sb);
    if (!d) return;
    try { durable(sb, d); }
    catch (e) { sb.setReadOnly('Agent prompt persistence failed; draft journal retained'); server.log.error('agent-prompt', { error: backend.cleanDiagnostic(String(e.message || e)) }); }
  });
  const previousBeforeKill = buffers.hooks.beforeKill;
  const beforeKill = (sb: SBuf) => {
    if (previousBeforeKill) previousBeforeKill(sb);
    const d = owned.get(sb);
    if (d) { durable(sb, d); persist(d); }
  };
  buffers.hooks.beforeKill = beforeKill;
  const offKill = buffers.on('killed', sb => {
    const d = owned.get(sb);
    if (d) owned.delete(sb);
  });
  // Only these owned files bypass the general write authority; stateDir is never a writable root.
  const save = buffers.save;
  const saveOwned: typeof save = async function (sb) {
    const d = owned.get(sb);
    if (!d) return save.call(buffers, sb);
    await snapshot(d); buffers.sendMeta(sb); buffers.emit('saved', sb);
    return { buf: sb.id, ver: sb.ver, saved: true };
  };
  buffers.save = saveOwned;
  const commands: string[] = [];
  function command(name: string, fn: (args: unknown[], buf?: string) => unknown | Promise<unknown>) {
    commands.push(name);
    server.defineCommand(name, async (_client, args, _ctx, buf): Promise<CallResult> => {
      try { return { value: backend.clean(await fn(args, buf)) }; }
      catch (e) { return { error: { condition: 'agent-prompt-error', report: backend.clean(String(e.message || e)), restarts: [], backtrace: [] } }; }
    });
  }
  const selected = (args: unknown[], buf?: string) => draft(args[0] ?? buf);
  command('agent-prompt-create', ([a]) => create(a));
  command('agent-prompt-drafts', () => [...drafts.values()].map(d => ({ id: idOf(d), targets: d.targets, possiblySent: d.possiblySent, name: d.name || null })));
  command('agent-prompt-open', ([id]) => { const d = draft(id); open(d); return idOf(d); });
  command('agent-prompt-preview', async (args, buf) => snapshot(selected(args, buf)));
  command('agent-prompt-abandon', async (args, buf) => { const d = selected(args, buf); await snapshot(d); persist(d); return idOf(d); });
  command('agent-prompt-targets', async ([id, targets]) => {
    const d = draft(id); if (targets === undefined) return [...d.targets]; writable(d);
    const next = targetsOf(targets);
    for (const target of next) {
      requireUnsent(d, target);
      await backend.requireSession(target.sid, epochOf(target.epoch));
    }
    writable(d);
    for (const target of next) requireUnsent(d, target);
    const changed = { ...d, targets: next }; persist(changed); d.targets = next; buffers.sendMeta(open(d)); return next;
  });
  async function deliver(d: Delivery, target: Target, content: { blocks: Block[] } | { text: string }) {
    const { sid } = target, remaining = d.targets, earlier = d.possiblySent;
    if (target.epoch === null) fail(`${sid} has an unbound legacy destination; explicitly retarget this draft before sending`);
    requireUnsent(d, target);
    const epoch = epochOf(target.epoch);
    if ('blocks' in content) {
      const session = await backend.requireSession(sid, epoch);
      const caps = session.promptCapabilities ?? session.acp?.promptCapabilities ?? session.session?.promptCapabilities ?? session.info?.promptCapabilities;
      if (object(caps)) for (const b of content.blocks) {
        const capability = b.type === 'resource' ? 'embeddedContext' : b.type === 'image' ? 'image' : b.type === 'audio' ? 'audio' : null;
        if (capability && caps[capability] !== true) fail(`${sid} does not support ${capability} prompt blocks`);
      }
    }
    await backend.requireSession(sid, epoch);
    let awaitingReply = false;
    try {
      const reply = await backend.request('POST', `sessions/${sid}/prompt`, { epoch, ...content }, () => {
        const targets = remaining.filter(t => t !== target), possiblySent = [...earlier, target];
        persist({ ...d, targets, possiblySent }); d.targets = targets; d.possiblySent = possiblySent;
        awaitingReply = true;
      });
      awaitingReply = false;
      const acknowledged = [...d.acknowledged, target];
      try { persist({ ...d, acknowledged, possiblySent: earlier }); }
      catch (e) { fail(`Prompt acknowledged by ${sid}, but durable send receipt failed: ${backend.clean(String(e.message || e))}. On restart this destination may be marked possibly sent; it will not be retried`); }
      finally { d.acknowledged = acknowledged; d.possiblySent = earlier; }
      return reply;
    } catch (e) {
      // Only a definite client-error refusal (e.g. busy) releases the durable intent.
      if (awaitingReply && e.status >= 400 && e.status < 500 && e.status !== 408) {
        try { persist({ ...d, targets: remaining, possiblySent: earlier }); d.targets = remaining; d.possiblySent = earlier; }
        catch (err) { fail(`${e.message || e}. Could not record refusal: ${err.message || err}`); }
      }
      throw e;
    }
  }
  if (server.cfg.agentHub?.steer) {
    command('agent-prompt-send', async (args, buf) => {
      const d = selected(args, buf); writable(d); sending.add(d.key);
      try {
        const p = await snapshot(d), sent: string[] = [];
        if (!p.targets.length) fail(`This draft has no remaining destinations.${uncertain(d)}`);
        if (!p.blocks.length || p.blocks.every(b => b.type === 'text' && !b.text)) fail('This prompt is empty');
        try {
          for (const target of p.targets) {
            try { await deliver(d, target, { blocks: p.blocks }); }
            finally {
              if (d.acknowledged.includes(target)) sent.push(target.sid);
              buffers.sendMeta(open(d));
            }
          }
        } catch (e) {
          fail(`${e.message || e}. Sent: ${sent.join(', ') || 'none'}; retained for retry: ${d.targets.map(t => t.sid).join(', ') || 'none'}.${uncertain(d)}`);
        }
        return { sent, remaining: d.targets, possiblySent: d.possiblySent, draft: idOf(d) };
      } finally { sending.delete(d.key); }
    });
    command('agent-session-prompt', async ([sid, input]) => {
      if (!object(input) || typeof input.submissionId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.submissionId))
        return fail('A retained submissionId (1–64 letters, digits, underscores or hyphens) is required');
      const target = { sid: sidOf(sid), epoch: epochOf(input.epoch) }, body = text(input.text, 'Prompt text');
      const key = `direct-${input.submissionId}`, digest = sha256(JSON.stringify([target.sid, target.epoch, body]));
      const d: Delivery & { digest: string } = { key, digest, targets: [target], acknowledged: [], possiblySent: [] };
      writable(d); sending.add(key);
      try {
        // Direct sends have no editor buffer. Read their compact receipt on demand, failing closed
        // on corrupt or inaccessible state; only an absent record starts a fresh submission.
        let raw: string | undefined;
        try { raw = store.read(`${key}.json`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (raw !== undefined) {
          const prior = JSON.parse(raw);
          if (!object(prior) || prior.key !== key || prior.digest !== digest) fail('The submissionId does not match the recorded prompt and destination');
          const ledger = { key, targets: targetsOf(prior.targets), acknowledged: targetsOf(prior.acknowledged), possiblySent: targetsOf(prior.possiblySent) };
          const all = [...ledger.targets, ...ledger.acknowledged, ...ledger.possiblySent];
          if (all.length !== 1 || targetKey(all[0]) !== targetKey(target)) fail('Invalid direct prompt delivery record');
          requireUnsent(ledger, target);
        }
        try { return await deliver(d, target, { text: body }); }
        catch (e) { fail(`${e.message || e}${uncertain(d)}`); }
      } finally { sending.delete(key); }
    });
  }

  // Prompt engineering: resources never become pasted prompt text; named prompts snapshot exact ACP blocks.
  function attach(d: Draft, block: Block) {
    writable(d); const blocks = [...d.blocks, block]; persist({ ...d, blocks }); d.blocks = blocks; buffers.sendMeta(open(d)); return block;
  }
  command('agent-prompt-attach-file', ([id, file, options]) => {
    const d = draft(id), name = text(file, 'File'), o = object(options) ? options : {};
    const mimeType = typeof o.mimeType === 'string' ? o.mimeType : 'text/plain';
    if (!o.embed) {
      // This URI is interpreted on the agent's host. Never stat/read an agent-side path here.
      const uri = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(name) ? new URL(name).href : name.startsWith('/') ? pathToFileURL(name).href : fail('An agent file link needs an absolute path or URI');
      return attach(d, { type: 'resource_link', uri, name: path.basename(name), mimeType });
    }
    const absolute = lexicalPath(auth, name);
    // Reject non-files before opening so an embedded FIFO cannot block the daemon.
    const entry = fs.statSync(absolute, { throwIfNoEntry: false });
    if (entry && !entry.isFile()) fail('Not a regular file');
    // Embedded resources send local bytes to the hub; read only from the checked descriptor.
    const block = auth.withRead(absolute, fd => {
      const st = fs.fstatSync(fd), real = fs.realpathSync.native(absolute);
      const isText = mimeType.startsWith('text/') || /(?:json|xml|javascript|yaml)/.test(mimeType);
      const limit = isText ? backend.requestBodyLimit : 3 * Math.floor(backend.requestBodyLimit / 4);
      if (st.size > limit) fail('Embedded file exceeds the agent request body limit');
      // Read only the checked descriptor and never chase a growing file beyond its original size.
      const data = Buffer.allocUnsafe(st.size + 1);
      let bytes = 0;
      while (bytes < data.length) {
        const n = fs.readSync(fd, data, bytes, data.length - bytes, bytes);
        if (!n) break;
        bytes += n;
      }
      if (bytes !== st.size) fail('Embedded file changed size while reading');
      const uri = pathToFileURL(real).href;
      return { type: 'resource', resource: { uri, mimeType, ...(isText ? { text: data.toString('utf8', 0, bytes) } : { blob: data.toString('base64', 0, bytes) }) } };
    });
    return attach(d, block);
  });
  for (const kind of ['buffer', 'region']) command(`agent-prompt-attach-${kind}`, ([id, resource]) => {
    if (!object(resource) || typeof resource.text !== 'string') fail(`Attach ${kind} needs an immutable text snapshot`);
    const r = resource as Record<string, unknown>, uri = text(r.uri, 'Resource URI'); new URL(uri);
    return attach(draft(id), { type: 'resource', resource: { uri, text: r.text, mimeType: typeof r.mimeType === 'string' ? r.mimeType : 'text/plain' } });
  });
  const namedFile = 'named.json';
  let named: Record<string, { blocks: Block[] }> = Object.create(null);
  let namedReadable = true;
  if (entries.includes(namedFile)) {
    try {
      const value = JSON.parse(store.read(namedFile));
      if (!object(value)) fail('Invalid saved agent prompts');
      for (const [name, v] of Object.entries(value)) { if (!object(v)) fail('Invalid saved agent prompt'); named[name] = { blocks: blocksOf((v as Record<string, unknown>).blocks) }; }
    } catch {
      named = Object.create(null); namedReadable = false;
      server.log.warn('agent-prompt', { error: 'Skipped unreadable named prompts' });
    }
  }
  command('agent-prompt-list', () => Object.keys(named).sort());
  command('agent-prompt-save', async ([id, name]) => {
    if (!namedReadable) fail('Cannot overwrite unreadable named prompts');
    const d = draft(id), label = text(name, 'Prompt name'), p = await snapshot(d);
    const next = Object.assign(Object.create(null), named, { [label]: { blocks: p.blocks } }); store.write(namedFile, JSON.stringify(next) + '\n'); named = next;
    persist({ ...d, name: label }); d.name = label; buffers.sendMeta(open(d)); return label;
  });
  command('agent-prompt-load', ([name, targets]) => {
    const label = text(name, 'Prompt name'); if (!Object.hasOwn(named, label)) fail('No saved prompt by that name');
    return create({ blocks: named[label].blocks, targets: targets ?? [] });
  });
  command('agent-session-recall', async ([sid, seq, epoch]) => create({ sid, epoch: epochOf(epoch), blocks: blocksOf(await backend.promptBlocks(sidOf(sid), Number(seq), epochOf(epoch))) }));
  return { async stop() {
    for (const d of drafts.values()) { const sb = buffers.live(idOf(d)); if (sb) { if (buffers.seq.flushHold) buffers.seq.flushHold(sb); if (sb.journal) await sb.journal.drain(); durable(sb, d); } persist(d); }
    offBatch(); offKill(); if (buffers.save === saveOwned) buffers.save = save;
    if (buffers.hooks.beforeKill === beforeKill) buffers.hooks.beforeKill = previousBeforeKill;
    for (const name of commands) server.commands.delete(name);
  } };
}
