/* Mesh session UI. Text and registries belong to edwind; frames hold no API token (Step AS1). */
(function () {
'use strict';
const Ed = globalThis.Ed, L = globalThis.L, E = Ed.E, H = Ed.hooks;
const { CMD, signal, intern } = L;
type Row = { sid?: string; observedId?: string; waiting?: boolean };
type List = { rows: Row[]; status: string };
async function rpc(cmd: string, args: unknown[] = []): Promise<unknown> {
  if (!Ed.sync?.started) return signal('user-error', 'No agent hub here: this Edwin is not attached to edwind');
  const r = await Ed.sync.call({ cmd, args });
  if (r.error) return signal('user-error', r.error.report || r.error.condition);
  return r.value;
}
async function show(id: string): Promise<EdBuffer> {
  const b = await Ed.sync.open(id); Ed.setWindowBuffer(b); E.current = b; Ed.scheduleRender(); return b;
}
async function open(sid: string): Promise<EdBuffer> { return show(await rpc('agent-session-open', [sid]) as string); }
function row(): Row | undefined { const list = E.current.meta?.locals?.agentList as List | undefined; return list?.rows[Ed.lineNoB(E.current, E.current.pt) - 3]; }
function selected(): string {
  const r = row(), s = E.current.meta?.locals?.agentSession as { sid: string; observed?: boolean } | undefined;
  if (r?.observedId || s?.observed) return signal('user-error', 'Reported session is read-only and cannot be steered') as never;
  const sid = r?.sid || s?.sid;
  return sid || signal('user-error', 'No agent session here') as never;
}
async function refresh() {
  const s = E.current.meta?.locals?.agentSession as { sid: string } | undefined;
  return s ? open(s.sid) : show(await rpc('agent-sessions') as string);
}
Ed.agentSessions = { rpc, show, open, selected, refresh };
CMD('agent-sessions', '', '', 'List hub-run and reported agent sessions, waiting first.', async () => { await show(await rpc('agent-sessions') as string); return false; });
CMD('agent-session-open', async () => [await Ed.readMini('Session: ', '', null)], 'SID', 'Show the session journal in its stable shared buffer.', async ([sid]: SchemeValue[]) => {
  const r = row(); await open(typeof sid === 'string' && sid ? sid : r?.sid || r?.observedId || selected()); return false;
});
CMD('agent-session-open-row', '', '', 'Open the session on this list row.', async () => { const r = row(); if (!r) signal('user-error', 'No session on this line'); await open((r!.sid || r!.observedId)!); return false; });
CMD('agent-sessions-refresh', '', '', 'Refresh the session list or current transcript.', async () => { await refresh(); return false; });
CMD('agent-session-start', '', '', 'Start an agent on a configured host, in a directory.', async () => {
  const info = await rpc('agent-session-info') as { host: string; agents: { name: string }[]; hosts: { name: string; agents: { name: string }[] }[] };
  const hosts = [info.host, ...(info.hosts || []).map(h => h.name)];
  const host = await Ed.readMini('Host: ', info.host, () => hosts, { require: true });
  const agents = host === info.host ? info.agents : info.hosts.find(h => h.name === host)?.agents || [];
  const agent = await Ed.readMini('Agent: ', '', () => agents.map(a => a.name), { require: true });
  const cwd = await Ed.readMini('Agent directory (on ' + host + '): ', '', null);
  await show(await rpc('agent-session-start', [{ agent, host, cwd }]) as string); return false;
});
CMD('agent-session-cancel', '', '', 'Cancel the current turn, without ending the session.', async () => { await rpc('agent-session-cancel', [selected()]); return false; });
CMD('agent-session-remove', '', '', 'End and forget the selected hub session, after confirmation.', async () => {
  const sid = selected(); if (await Ed.readMini(`Remove ${sid}? (yes/no) `, '', null) === 'yes') await rpc('agent-session-remove', [sid]); return false;
});
const previousSetup = H.setup;
H.setup = () => {
  if (previousSetup) previousSetup();
  const map = new Ed.Keymap(); L.set('agent-sessions-mode-map', map); Ed.modeParents.set('agent-sessions-mode', 'special-mode');
  E.aux.set('agent-sessions-mode:motion', map); E.aux.set('agent-sessions-mode:normal', map);
  for (const [key, cmd] of [['RET', 'agent-session-open-row'], ['r', 'agent-sessions-refresh'], ['g r', 'agent-sessions-refresh'], ['a', 'agent-session-start'], ['c', 'agent-session-cancel'], ['D', 'agent-session-remove'], ['p', 'agent-session-prompt'], ['!', 'agent-session-answer'], ['q', 'quit-window']]) Ed.defineKey(map, Ed.kbd(key), intern(cmd));
};
const prevMeta = H.bufferMeta;
H.bufferMeta = (b, locals, ver) => {
  if (prevMeta) prevMeta(b, locals, ver);
  if (locals.agentList || locals.agentSession) b.evilState = 'motion';
};
Ed.MODE_NAMES['agent-sessions-mode'] = 'Agent Sessions';
})();
