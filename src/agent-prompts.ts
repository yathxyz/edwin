// Agent steering and prompt engineering. Frame-side commands never hold an API credential.
(function () {
'use strict';
const Ed = globalThis.Ed, E = Ed.E, L = globalThis.L, H = Ed.hooks;
const { CMD, signal, intern } = L;
type Json = Record<string, any>; // any: ACP and JSON Schema wire values
const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const api = () => Ed.agentSessions;
const rpc = (cmd: string, args: unknown[] = []) => api().rpc(cmd, args);
const cur = () => E.current;
const metadata = (b: EdBuffer): Json | null => { const m = b.meta?.locals?.agentPrompt; return object(m) ? m : null; };
const sessionId = (v?: SchemeValue): string => typeof v === 'string' && v ? v : api().selected();
const windows = new Map<string, EdWinConfig>();
async function sessions(): Promise<string[]> {
  const v = await rpc('agent-session-list');
  const rows = Array.isArray(v) ? v : object(v) && Array.isArray(v.sessions) ? v.sessions : [];
  return rows.filter((s: Json) => s.kind === 'acp' || s.kind === undefined).map((s: Json) => s.sid).filter((s: unknown): s is string => typeof s === 'string');
}
async function readSession(prompt = 'Agent session: '): Promise<string> {
  const ids = await sessions(); return Ed.readMini(prompt, '', () => ids, { require: true });
}
async function targetOrRead(given?: SchemeValue): Promise<string> {
  if (typeof given === 'string' && given) return given;
  const locals = cur().meta?.locals;
  if (locals?.agentSession || locals?.agentList) return api().selected();
  return readSession();
}
async function chooseDraft(given?: unknown): Promise<string> {
  if (typeof given === 'string' && given) return given;
  const m = metadata(cur()); if (m) return m.id;
  const list = await rpc('agent-prompt-drafts') as Json[];
  if (!list.length) signal('user-error', 'No prompt drafts; use agent-session-prompt first');
  if (list.length === 1) return list[0].id;
  const labels = list.map(d => `${d.id}  ${d.name || d.targets.join(', ')}`);
  const picked = await Ed.readMini('Prompt draft: ', '', () => labels, { require: true });
  return list[labels.indexOf(picked)].id;
}
async function synced(id: string): Promise<EdBuffer> {
  const b = E.buffers.find(b => b.shared && b.id === id) || await Ed.sync.open(id);
  await Ed.sync.whenSynced(b);
  return b;
}
async function showDraft(id: string) {
  const previous = Ed.winConfig(), b = await api().show(id);
  if (!windows.has(id)) windows.set(id, previous);
  Ed.makeLocal(b, 'agent-prompt-enabled'); b.locals!.set('agent-prompt-enabled', true);
  if (E.evil) globalThis.EvilCore.enterInsert(b, 1, false);
  Ed.message('C-c C-c sends; C-c C-k leaves this durable draft; C-c C-p previews exact blocks');
  return b;
}
function leave(id: string) {
  const saved = windows.get(id); windows.delete(id);
  if (saved) { try { Ed.restoreWinConfig(saved); return; } catch (e) { /* a window was closed meanwhile */ } }
  L.call('quit-window', []);
}
function jsonView(name: string, value: unknown) {
  const b = Ed.getBufferCreate(name);
  Ed.withOrigin('server', () => { b.text = JSON.stringify(value, null, 2) + '\n'; });
  b.readOnly = true; b.modified = false; b.undo = []; b.redo = [];
  Ed.popToBuffer(b, false); return b;
}
const previousMeta = H.bufferMeta;
H.bufferMeta = (b, locals, ver) => {
  if (previousMeta) previousMeta(b, locals, ver);
  if (!object(locals.agentPrompt)) return;
  Ed.makeLocal(b, 'agent-prompt-enabled'); b.locals!.set('agent-prompt-enabled', true);
};
const previousSetup = H.setup;
H.setup = () => {
  if (previousSetup) previousSetup();
  const map = new Ed.Keymap('agent-prompt-mode-map');
  Ed.defineMinorMode({ name: 'agent-prompt-mode', keymap: map, lighter: ' Prompt', pretty: 'Agent prompt', doc: 'Ordinary Markdown editing, with C-c C-c send, C-c C-k leave retaining the draft, and C-c C-p exact JSON preview.' });
  for (const [key, cmd] of [['C-c C-c', 'agent-prompt-send'], ['C-c C-k', 'agent-prompt-abandon'], ['C-c C-p', 'agent-prompt-preview']]) Ed.defineKey(map, Ed.kbd(key), intern(cmd));
  const stateMaps = H.stateMaps;
  H.stateMaps = b => metadata(b) ? [map, ...(stateMaps ? stateMaps(b) : [])] : stateMaps ? stateMaps(b) : [];
  // Answer requests from any buffer; no transcript needs to be selected.
  Ed.defineKey(L.get('global-map') as EdKeymap, Ed.kbd('C-c a !'), intern('agent-session-answer'));
  Ed.defineKey(L.get('global-map') as EdKeymap, Ed.kbd('C-c a p'), intern('agent-session-prompt'));
};

// Steering stage: durable compose, exact preview, and globally reachable pending answers.
CMD('agent-session-prompt', '', '&optional SID', 'Compose in a shared Markdown draft for SID; no existing journal text is changed.', async ([sid]: SchemeValue[]) => {
  const target = await targetOrRead(sid);
  await showDraft(await rpc('agent-prompt-create', [{ sid: target }]) as string); return false;
});
CMD('agent-prompt-open', '', '&optional ID', 'Reopen a durable draft, including one whose buffer was killed.', async ([id]: SchemeValue[]) => {
  await showDraft(await rpc('agent-prompt-open', [await chooseDraft(id)]) as string); return false;
});
CMD('agent-prompt-preview', '', '&optional ID', 'Show the exact JSON content blocks and destinations that send will snapshot.', async ([value]: SchemeValue[]) => {
  const id = await chooseDraft(value); await synced(id);
  jsonView('*Agent Prompt Preview*', await rpc('agent-prompt-preview', [id])); return false;
});
CMD('agent-prompt-send', '', '&optional ID', 'Send sequenced draft text/resources. Retain the draft on any failure, removing successful destinations durably.', async ([value]: SchemeValue[]) => {
  const id = await chooseDraft(value); await synced(id);
  const result = await rpc('agent-prompt-send', [id]) as Json;
  leave(id); Ed.message(`Prompt sent to ${(result.sent || []).join(', ')}; draft retained`); return false;
});
CMD('agent-prompt-abandon', '', '&optional ID', 'Leave this view without sending or deleting the durable draft.', async ([value]: SchemeValue[]) => {
  const id = await chooseDraft(value); await synced(id); await rpc('agent-prompt-abandon', [id]); leave(id); return false;
});
CMD('agent-session-quick-prompt', '', '&optional TEXT SID', 'Send a minibuffer prompt through a durable draft; a failed/ambiguous reply leaves it recoverable.', async ([value, sid]: SchemeValue[]) => {
  const target = sessionId(sid), body = typeof value === 'string' ? value : await Ed.readMini(`Prompt ${target}: `, '');
  const id = await rpc('agent-prompt-create', [{ sid: target, text: body }]) as string;
  try { await rpc('agent-prompt-send', [id]); Ed.message(`Prompt sent to ${target}`); }
  catch (e) { await showDraft(id); throw e; }
  return false;
});
CMD('agent-session-revive', '', '&optional SID', 'Explicitly revive the selected dead ACP session.', async ([sid]: SchemeValue[]) => { await rpc('agent-session-revive', [sessionId(sid)]); return false; });
CMD('agent-session-mode', '', '&optional MODE SID', 'Choose an offered ACP mode; hub errors remain errors.', async ([value, sid]: SchemeValue[]) => {
  const target = sessionId(sid), info = await rpc('agent-session-details', [target]) as Json;
  const modes = info.modes?.availableModes || info.availableModes || [];
  if (!modes.length) signal('user-error', 'This session offers no modes');
  const labels = modes.map((m: Json) => `${m.id}: ${m.name || m.id}`);
  const mode = typeof value === 'string' ? value : modes[labels.indexOf(await Ed.readMini('Mode: ', '', () => labels, { require: true }))].id;
  if (!modes.some((m: Json) => m.id === mode)) signal('user-error', 'That mode was not offered');
  await rpc('agent-session-mode', [target, { modeId: mode }]); return false;
});
CMD('agent-session-config', '', '&optional ID VALUE SID', 'Set an ACP configuration option; older hubs report this route as unsupported.', async ([id, value, sid]: SchemeValue[]) => {
  const target = sessionId(sid), info = await rpc('agent-session-details', [target]) as Json, options = info.configOptions || [];
  if (!options.length) signal('user-error', 'This session offers no configuration options');
  const labels = options.map((o: Json) => `${o.id}: ${o.name || o.id}`);
  const chosen = typeof id === 'string' ? options.find((o: Json) => o.id === id) : options[labels.indexOf(await Ed.readMini('Option: ', '', () => labels, { require: true }))];
  if (!chosen) signal('user-error', 'That option was not offered');
  const choices: Json[] = (chosen.options || []).flatMap((o: Json) => Array.isArray(o.options) ? o.options : [o]);
  const values = choices.map(o => String(o.value));
  const selected = value === undefined ? await Ed.readMini(`${chosen.name || chosen.id}: `, String(chosen.currentValue ?? ''), () => values, { require: true }) : value;
  const option = choices.find(o => String(o.value) === String(selected));
  if (!option) return signal('user-error', 'That value was not offered');
  await rpc('agent-session-config', [target, { id: chosen.id, value: option.value }]); return false;
});
async function fieldValue(name: string, schema: Json, required: boolean): Promise<unknown> {
  const label = `${schema.title || name}${required ? '' : ' (optional, blank skips)'} [${schema.type || 'string'}]: `;
  if (schema.type === 'boolean') {
    const choices = required ? ['true', 'false'] : ['true', 'false', 'skip'];
    const v = await Ed.readMini(label, '', () => choices, { require: true }); return v === 'skip' ? undefined : v === 'true';
  }
  const choices = Array.isArray(schema.enum) ? schema.enum.map(String) : null;
  const v = await Ed.readMini(label, schema.default === undefined ? '' : typeof schema.default === 'string' ? schema.default : JSON.stringify(schema.default), choices ? () => choices : null, { require: !!choices });
  if (!required && !v) return undefined;
  if (schema.type === 'array') {
    let a: unknown; try { a = JSON.parse(v); } catch (e) { signal('user-error', `${name} needs a JSON string array`); }
    if (!Array.isArray(a) || !a.every(s => typeof s === 'string')) signal('user-error', `${name} needs a JSON string array`);
    return a;
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    const n = Number(v); if (!v.trim() || !Number.isFinite(n) || (schema.type === 'integer' && !Number.isInteger(n))) signal('user-error', `${name} needs a ${schema.type}`); return n;
  }
  if (schema.type && schema.type !== 'string') signal('user-error', `Unsupported elicitation field type: ${schema.type}`);
  return v;
}
CMD('agent-session-answer', '', '', 'Answer a pending permission or elicitation globally, capturing its exact request id and epoch. URLs are shown in full and never opened.', async () => {
  const pending = await rpc('agent-session-pending') as Json[];
  if (!pending.length) signal('user-error', 'No pending agent requests');
  const labels = pending.map(p => `${p.sid} #${p.req} ${p.kind}: ${p.title || ''}`);
  const chosen = pending.length === 1 ? pending[0] : pending[labels.indexOf(await Ed.readMini('Pending request: ', '', () => labels, { require: true }))];
  const request = await rpc('agent-session-request', [chosen.sid, chosen.req]) as Json;
  const captured = { req: request.req ?? chosen.req, epoch: request.epoch ?? chosen.epoch }, kind = request.kind || request.e || chosen.kind;
  if (kind === 'permission') {
    const options = request.options || request.event?.options || [];
    const choices = options.map((o: Json) => `${o.optionId}: ${o.name || o.kind || o.optionId}`), cancelled = 'Cancel request';
    const selected = await Ed.readMini('Permission: ', '', () => [...choices, cancelled], { require: true });
    const outcome = selected === cancelled ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: options[choices.indexOf(selected)].optionId };
    await rpc('agent-session-permission', [chosen.sid, { ...captured, outcome }]);
  } else if (kind === 'elicitation') {
    const q = request.request || request.event?.request || request;
    if (q.url) { jsonView('*Agent Elicitation URL*', { message: q.message, url: q.url, origin: new URL(q.url).origin }); Ed.message(`Agent URL (not opened): ${q.url}`); }
    const action = await Ed.readMini(`${q.message || 'Elicitation'} (accept/decline/cancel): `, '', () => ['accept', 'decline', 'cancel'], { require: true });
    const response: Json = { action };
    if (action === 'accept' && !q.url) {
      const schema = q.requestedSchema || q.schema || {}, required = schema.required || [], content: Json = {};
      for (const [name, field] of Object.entries(schema.properties || {})) {
        const value = await fieldValue(name, field as Json, required.includes(name)); if (value !== undefined) content[name] = value;
      }
      response.content = content;
    }
    await rpc('agent-session-elicitation', [chosen.sid, { ...captured, response }]);
  } else signal('user-error', 'Unknown pending request type');
  Ed.message('Agent request answered'); return false;
});

})();
