/* Mesh session UI. Text and registries belong to edwind; frames hold no API token (Step AS1). */
globalThis.Ed.installAgentSessions = function (steer: boolean) {
'use strict';
const Ed = globalThis.Ed, L = globalThis.L, E = Ed.E, H = Ed.hooks;
const { CMD, signal, intern } = L;
type Row = { sid?: string; epoch?: number; observedId?: string; waiting?: boolean; line: number };
type List = { rows: Row[]; status: string; exited: { expanded: boolean; total: number; hidden: number; line: number | null } };
/* Presentation commands run in this replica; mutations still go through edwind. */
const presentationCommands: Record<string, true> = {
  'agent-session-toggle-fold': true, 'agent-session-open-folds': true, 'agent-session-close-folds': true,
  'agent-session-next-prompt': true, 'agent-session-previous-prompt': true,
};
const listeners = new WeakMap<EdBuffer, Set<(state: EdAgentSessionState) => void>>();
const revisions = new WeakMap<EdBuffer, string>();
function state(b: EdBuffer): EdAgentSessionState {
  const value = b.meta?.locals?.agentState;
  if (!value || typeof value !== 'object') return signal('user-error', 'No agent session state in this buffer') as never;
  return value as EdAgentSessionState;
}
function onChange(b: EdBuffer, fn: (value: EdAgentSessionState) => void): () => void {
  const current = state(b);
  let list = listeners.get(b); if (!list) listeners.set(b, list = new Set());
  list.add(fn);
  try { fn(current); } catch (e) { list.delete(fn); throw e; }
  return () => { list!.delete(fn); };
}
async function rpc(cmd: string, args: unknown[] = []): Promise<unknown> {
  if (Object.hasOwn(presentationCommands, cmd)) return L.call(cmd, args as SchemeValue[]);
  if (!Ed.sync?.started) return signal('user-error', 'No agent hub here: this Edwin is not attached to edwind');
  const r = await Ed.sync.call({ cmd, args });
  if (r.error) return signal('user-error', r.error.report || r.error.condition);
  return r.value;
}
async function show(id: string): Promise<EdBuffer> {
  const b = (await Ed.sync.open(id))!; Ed.setWindowBuffer(b); E.current = b; Ed.scheduleRender(); return b;
}
async function open(sid: string, epoch?: number): Promise<EdBuffer> { return show(await rpc('agent-session-open', epoch === undefined ? [sid] : [sid, epoch]) as string); }
function row(): Row | undefined {
  const list = E.current.meta?.locals?.agentList as List | undefined, line = Ed.lineNoB(E.current, E.current.pt);
  return list?.rows.find(r => r.line === line);
}
function selected(): string {
  const r = row(), s = E.current.meta?.locals?.agentSession as { sid: string; observed?: boolean } | undefined;
  if (r?.observedId || s?.observed) return signal('user-error', 'Reported session is read-only and cannot be steered') as never;
  const sid = r?.sid || s?.sid;
  return sid || signal('user-error', 'No agent session here') as never;
}
function identity(sid = selected()): { sid: string; epoch: number } {
  // Prefer the selected view's displayed incarnation, not newer control-state metadata.
  for (const b of [E.current, ...E.buffers.filter(b => b !== E.current)]) {
    const session = b.meta?.locals?.agentSession as { sid: string; observed?: boolean; epoch?: number } | undefined, list = b.meta?.locals?.agentList as List | undefined;
    if (session?.sid === sid && !session.observed && typeof session.epoch === 'number') return { sid, epoch: session.epoch };
    const r = list?.rows.find(r => r.sid === sid);
    if (typeof r?.epoch === 'number') return { sid, epoch: r.epoch };
  }
  return signal('user-error', 'No displayed incarnation for this session; select it explicitly') as never;
}
async function refresh() {
  const s = E.current.meta?.locals?.agentSession as { sid: string } | undefined;
  return s ? open(s.sid) : show(await rpc('agent-sessions') as string);
}
Ed.agentSessions = { rpc, show, open, selected, identity, refresh, state, onChange };
CMD('agent-sessions', '', '', 'List hub-run and reported agent sessions, waiting first.', async () => { await show(await rpc('agent-sessions') as string); return false; });
CMD('agent-session-open', async () => [await Ed.readMini('Session: ', '', null)], 'SID', 'Show the session journal in its stable shared buffer.', async ([sid]: SchemeValue[]) => {
  const r = row(); await open(typeof sid === 'string' && sid ? sid : r?.sid || r?.observedId || selected()); return false;
});
CMD('agent-session-open-row', '', '', 'Open the session incarnation on this list row.', async () => { const r = row(); if (!r) signal('user-error', 'No session on this line'); await open((r!.sid || r!.observedId)!, r!.epoch); return false; });
CMD('agent-sessions-refresh', '', '', 'Refresh the session list or current transcript.', async () => { await refresh(); return false; });
CMD('agent-sessions-toggle-exited', '', '', 'Show all exited sessions, or only the latest five; callable through agentSessions.rpc without keys.', async () => {
  if (!E.current.meta?.locals?.agentList) return signal('user-error', 'No agent session list here');
  await show(await rpc('agent-sessions-toggle-exited') as string); return false;
});
CMD('agent-sessions-toggle-exited-row', '', '', 'Toggle exited sessions on the list group line.', async () => {
  const list = E.current.meta?.locals?.agentList as List | undefined;
  if (!list || list.exited.line !== Ed.lineNoB(E.current, E.current.pt)) return signal('user-error', 'No exited-session group on this line');
  await show(await rpc('agent-sessions-toggle-exited') as string); return false;
});
if (steer) {
CMD('agent-session-start', '', '', 'Start an agent on a configured host, in a directory.', async () => {
  const info = await rpc('agent-session-info') as { host: string; agents: { name: string }[]; hosts: { name: string; agents: { name: string }[] }[] };
  const hosts = [info.host, ...(info.hosts || []).map(h => h.name)];
  const host = await Ed.readMini('Host: ', info.host, () => hosts, { require: true });
  const agents = host === info.host ? info.agents : info.hosts.find(h => h.name === host)?.agents || [];
  const agent = await Ed.readMini('Agent: ', '', () => agents.map(a => a.name), { require: true });
  const cwd = await Ed.readMini('Agent directory (on ' + host + '): ', '', null);
  await show(await rpc('agent-session-start', [{ agent, host, cwd }]) as string); return false;
});
CMD('agent-session-cancel', '', '', 'Cancel the displayed session turn, without ending the session.', async () => { const shown = identity(); await rpc('agent-session-cancel', [shown.sid, { epoch: shown.epoch }]); return false; });
CMD('agent-session-remove', '', '', 'End and forget the selected hub session, after confirmation.', async () => {
  const shown = identity(); if (await Ed.readMini(`Remove ${shown.sid} (createdAt ${shown.epoch})? (yes/no) `, '', null) === 'yes') await rpc('agent-session-remove', [shown.sid, { epoch: shown.epoch }]); return false;
});
}
{
  const map = new Ed.Keymap(); L.set('agent-sessions-mode-map', map); Ed.modeParents.set('agent-sessions-mode', 'special-mode');
  E.aux.set('agent-sessions-mode:motion', map); E.aux.set('agent-sessions-mode:normal', map);
  for (const [key, cmd] of [['RET', 'agent-session-open-row'], ['TAB', 'agent-sessions-toggle-exited-row'], ['e', 'agent-sessions-toggle-exited'], ['r', 'agent-sessions-refresh'], ['g r', 'agent-sessions-refresh'], ['p', 'agent-prompt-compose'], ['q', 'quit-window']]) Ed.defineKey(map, Ed.kbd(key), intern(cmd));
  if (steer) for (const [key, cmd] of [['a', 'agent-session-start'], ['c', 'agent-session-cancel'], ['D', 'agent-session-remove'], ['!', 'agent-session-answer']]) Ed.defineKey(map, Ed.kbd(key), intern(cmd));
}
const prevMeta = H.bufferMeta;
H.bufferMeta = (b, locals, ver) => {
  if (prevMeta) prevMeta(b, locals, ver);
  if (locals.agentList || locals.agentSession) b.evilState = 'motion';
  if (locals.agentState) {
    const value = state(b), revision = JSON.stringify(value);
    if (revision !== revisions.get(b)) {
      revisions.set(b, revision);
      for (const fn of [...(listeners.get(b) || [])]) { try { fn(value); } catch (e) { Ed.reportError(e); } }
    }
  }
};
Ed.MODE_NAMES['agent-sessions-mode'] = 'Agent Sessions';
Ed.installAgentTranscript(steer); Ed.installAgentPrompts(steer);
};
