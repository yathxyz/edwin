// Agent steering: ordinary shared Markdown drafts; HTTP mutations go only through AgentBackend.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomId } from './journal.mts';
import { writeAtomic, sha256, diskState } from './files.mts';
import { lexicalPath } from './buffers.mts';
import { realPath } from './paths.mts';
import type { SBuf } from './buffers.mts';
import type { Server } from './main.mts';
import type { AgentBackend } from './agent-sessions.mts';
import type { CallResult } from './proto.mts';

interface Block { type: string; [key: string]: unknown }
interface Draft {
  key: string; targets: string[]; blocks: Block[]; baseText: string;
  name?: string;
}
interface Preview { draft: string; targets: string[]; blocks: Block[] }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v); // any: ACP JSON
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const fail = (message: string): never => { throw new Error(message); };
const text = (v: unknown, what: string): string => typeof v === 'string' && v.length ? v : fail(`${what} must be a nonempty string`);
const sidOf = (v: unknown): string => { const s = text(v, 'Session'); if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) fail('Not an ACP session id'); return s; };
const targetsOf = (v: unknown): string[] => { if (!Array.isArray(v)) fail('Targets must be an array of session ids'); return [...new Set((v as unknown[]).map(sidOf))]; };
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

export async function installPrompts(server: Server, backend: AgentBackend): Promise<{ stop(): Promise<void> }> {
  const buffers = server.buffers, dir = path.join(server.cfg.stateDir, 'agent-prompts');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const drafts = new Map<string, Draft>(), sending = new Set<string>(), owned = new Map<SBuf, Draft>();
  const markdown = (d: Draft) => path.join(dir, `${d.key}.md`);
  const record = (d: Draft) => path.join(dir, `${d.key}.json`);
  const persist = (d: Draft) => writeAtomic(record(d), JSON.stringify(d) + '\n');
  function draft(v: unknown): Draft { const d = drafts.get(keyOf(v)); return d || fail('No such agent prompt draft'); }
  function writable(d: Draft) { if (sending.has(d.key)) fail('This prompt is being sent'); }
  function meta(sb: SBuf, d: Draft) {
    owned.set(sb, d);
    const original = sb.meta.bind(sb);
    sb.meta = () => { const m = original(); m.locals = { ...m.locals, agentPrompt: { id: sb.id, targets: [...d.targets], name: d.name || null, resources: d.blocks.reduce((n, b) => n + Number(b.type !== 'text'), 0) } }; return m; };
  }
  function open(d: Draft): SBuf {
    const live = buffers.live(idOf(d));
    if (live) return live;
    const body = fs.readFileSync(markdown(d), 'utf8');
    const sb = buffers.create({ id: idOf(d), jid: randomId(), name: nameOf(d), file: markdown(d), text: body });
    server.Ed.switchMajorMode(sb.ed, 'markdown-mode');
    meta(sb, d); buffers.startJournal(sb);
    return sb;
  }
  function durable(sb: SBuf, d: Draft): string {
    const body = sb.text;
    writeAtomic(markdown(d), body);
    sb.savedText = body; sb.savedHash = sha256(body); sb.savedVer = sb.ver;
    sb.disk = diskState(fs.statSync(markdown(d)));
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
    return { draft: sb.id, targets: [...d.targets], blocks };
  }
  async function create(value: unknown): Promise<string> {
    const a = object(value) ? value : {}, targets = targetsOf(a.targets ?? (a.sid ? [a.sid] : []));
    for (const sid of targets) await backend.requireSession(sid);
    const blocks = a.blocks === undefined ? [{ type: 'text', text: typeof a.text === 'string' ? a.text : '' }] : blocksOf(a.blocks);
    const d: Draft = { key: randomId(), targets, blocks, baseText: promptText(blocks) };
    writeAtomic(markdown(d), d.baseText); persist(d); drafts.set(d.key, d); open(d);
    return idOf(d);
  }
  for (const file of fs.readdirSync(dir)) {
    if (!/^[A-Za-z0-9_-]+\.json$/.test(file) || file === 'named.json') continue;
    const d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Draft;
    if (!object(d) || d.key !== file.slice(0, -5) || typeof d.baseText !== 'string') fail('Invalid persisted agent prompt');
    d.targets = targetsOf(d.targets); d.blocks = blocksOf(d.blocks); drafts.set(d.key, d);
    const live = buffers.live(idOf(d));
    if (live) { server.Ed.switchMajorMode(live.ed, 'markdown-mode'); meta(live, d); durable(live, d); }
    else open(d);
  }
  const offBatch = buffers.on('afterBatch', sb => {
    const d = owned.get(sb);
    if (!d) return;
    try { durable(sb, d); }
    catch (e) { sb.setReadOnly('Agent prompt persistence failed; draft journal retained'); server.log.error('agent-prompt', { error: backend.clean(String(e.message || e)) }); }
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
  command('agent-prompt-drafts', () => [...drafts.values()].map(d => ({ id: idOf(d), targets: [...d.targets], name: d.name || null })));
  command('agent-prompt-open', ([id]) => { const d = draft(id); open(d); return idOf(d); });
  command('agent-prompt-preview', async (args, buf) => snapshot(selected(args, buf)));
  command('agent-prompt-abandon', async (args, buf) => { const d = selected(args, buf); await snapshot(d); persist(d); return idOf(d); });
  command('agent-prompt-targets', async ([id, targets]) => {
    const d = draft(id); if (targets === undefined) return [...d.targets]; writable(d);
    const next = targetsOf(targets); for (const sid of next) await backend.requireSession(sid);
    writable(d);
    const changed = { ...d, targets: next }; persist(changed); d.targets = next; buffers.sendMeta(open(d)); return next;
  });
  command('agent-prompt-send', async (args, buf) => {
    const d = selected(args, buf); writable(d); sending.add(d.key);
    try {
      const p = await snapshot(d), sent: string[] = [];
      if (!p.targets.length) fail('This draft has no remaining destinations');
      if (!p.blocks.length || p.blocks.every(b => b.type === 'text' && !b.text)) fail('This prompt is empty');
      for (const sid of p.targets) {
        try {
          const session = await backend.requireSession(sid);
          const caps = session.promptCapabilities ?? session.acp?.promptCapabilities ?? session.session?.promptCapabilities ?? session.info?.promptCapabilities;
          if (object(caps)) for (const b of p.blocks) {
            const capability = b.type === 'resource' ? 'embeddedContext' : b.type === 'image' ? 'image' : b.type === 'audio' ? 'audio' : null;
            if (capability && caps[capability] !== true) fail(`${sid} does not support ${capability} prompt blocks`);
          }
          await backend.request('POST', `sessions/${encodeURIComponent(sid)}/prompt`, { blocks: p.blocks });
          // Never resend a positively acknowledged destination, even if a later destination fails.
          const targets = d.targets.filter(t => t !== sid); persist({ ...d, targets }); d.targets = targets; sent.push(sid); buffers.sendMeta(open(d));
        } catch (e) { fail(`${backend.clean(String(e.message || e))}. Sent: ${sent.join(', ') || 'none'}; retained for retry: ${d.targets.join(', ')}. A lost reply may already have sent this prompt.`); }
      }
      return { sent, remaining: [...d.targets], draft: idOf(d) };
    } finally { sending.delete(d.key); }
  });

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
    const absolute = lexicalPath(server.auth, name); server.auth.checkRead(absolute);
    const real = realPath(absolute); if (!real.exists) fail('No such embedded file'); server.auth.checkRead(real.real);
    const data = fs.readFileSync(real.real), uri = pathToFileURL(real.real).href;
    return attach(d, { type: 'resource', resource: { uri, mimeType, ...(mimeType.startsWith('text/') || /(?:json|xml|javascript|yaml)/.test(mimeType) ? { text: data.toString('utf8') } : { blob: data.toString('base64') }) } });
  });
  for (const kind of ['buffer', 'region']) command(`agent-prompt-attach-${kind}`, ([id, resource]) => {
    if (!object(resource) || typeof resource.text !== 'string') fail(`Attach ${kind} needs an immutable text snapshot`);
    const r = resource as Record<string, unknown>, uri = text(r.uri, 'Resource URI'); new URL(uri);
    return attach(draft(id), { type: 'resource', resource: { uri, text: r.text, mimeType: typeof r.mimeType === 'string' ? r.mimeType : 'text/plain' } });
  });
  const namedFile = path.join(dir, 'named.json');
  let named: Record<string, { blocks: Block[] }> = Object.create(null);
  if (fs.existsSync(namedFile)) {
    const value = JSON.parse(fs.readFileSync(namedFile, 'utf8'));
    if (!object(value)) fail('Invalid saved agent prompts');
    for (const [name, v] of Object.entries(value)) { if (!object(v)) fail('Invalid saved agent prompt'); named[name] = { blocks: blocksOf((v as Record<string, unknown>).blocks) }; }
  }
  command('agent-prompt-list', () => Object.keys(named).sort());
  command('agent-prompt-save', async ([id, name]) => {
    const d = draft(id), label = text(name, 'Prompt name'), p = await snapshot(d);
    const next = Object.assign(Object.create(null), named, { [label]: { blocks: p.blocks } }); writeAtomic(namedFile, JSON.stringify(next) + '\n'); named = next;
    persist({ ...d, name: label }); d.name = label; buffers.sendMeta(open(d)); return label;
  });
  command('agent-prompt-load', ([name, targets]) => {
    const label = text(name, 'Prompt name'); if (!Object.hasOwn(named, label)) fail('No saved prompt by that name');
    return create({ blocks: named[label].blocks, targets: targets ?? [] });
  });
  command('agent-session-recall', async ([sid, seq]) => create({ sid, blocks: blocksOf(await backend.promptBlocks(sidOf(sid), Number(seq))) }));
  return { async stop() {
    for (const d of drafts.values()) { const sb = buffers.live(idOf(d)); if (sb) { if (buffers.seq.flushHold) buffers.seq.flushHold(sb); if (sb.journal) await sb.journal.drain(); durable(sb, d); } persist(d); }
    offBatch(); offKill(); if (buffers.save === saveOwned) buffers.save = save;
    if (buffers.hooks.beforeKill === beforeKill) buffers.hooks.beforeKill = previousBeforeKill;
    for (const name of commands) server.commands.delete(name);
  } };
}
