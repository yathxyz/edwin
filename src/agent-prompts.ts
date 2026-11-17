// Agent steering and prompt engineering. Frame-side commands never hold an API credential.
(function () {
'use strict';
const Ed = globalThis.Ed, E = Ed.E, L = globalThis.L, H = Ed.hooks;
const { CMD, signal, intern } = L;
type Json = Record<string, any>; // any: ACP and JSON Schema wire values
type Target = { sid: string; epoch: number };
const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const api = () => Ed.agentSessions;
const rpc = (cmd: string, args: unknown[] = []) => api().rpc(cmd, args);
const cur = () => E.current;
const metadata = (b: EdBuffer): Json | null => { const m = b.meta?.locals?.agentPrompt; return object(m) ? m : null; };
const windows = new Map<string, EdWinConfig>();
async function sessions(): Promise<Target[]> {
  const v = await rpc('agent-session-list');
  const rows = Array.isArray(v) ? v : object(v) && Array.isArray(v.sessions) ? v.sessions : [];
  return rows.filter((s: Json) => (s.kind === 'acp' || s.kind === undefined) && typeof s.sid === 'string' && typeof s.createdAt === 'number').map((s: Json) => ({ sid: s.sid, epoch: s.createdAt }));
}
async function readSession(prompt = 'Agent session: '): Promise<Target> {
  const targets = await sessions(), labels = targets.map(t => `${t.sid} (${t.epoch})`);
  const selected = await Ed.readMini(prompt, '', () => labels, { require: true });
  return targets[labels.indexOf(selected)];
}
async function targetOrRead(given?: SchemeValue): Promise<Target> {
  const sid = typeof given === 'string' && given ? given : undefined, locals = cur().meta?.locals;
  if (!sid && (locals?.agentSession || locals?.agentList)) return api().identity();
  if (sid) {
    const displayed = E.buffers.some(b => {
      const shown = b.meta?.locals as Json | undefined;
      return shown?.agentSession?.sid === sid || shown?.agentList?.rows?.some((r: Json) => r.sid === sid);
    });
    if (displayed) return api().identity(sid);
    const target = (await sessions()).find(t => t.sid === sid);
    return target || signal('user-error', 'No such ACP session') as never;
  }
  return readSession();
}
async function chooseDraft(given?: unknown): Promise<string> {
  if (typeof given === 'string' && given) return given;
  const m = metadata(cur()); if (m) return m.id;
  const list = await rpc('agent-prompt-drafts') as Json[];
  if (!list.length) signal('user-error', 'No prompt drafts; use agent-session-prompt first');
  if (list.length === 1) return list[0].id;
  const labels = list.map(d => `${d.id}  ${d.name || d.targets.map((t: Json) => `${t.sid} (${t.epoch ?? 'unbound'})`).join(', ')}`);
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
  await showDraft(await rpc('agent-prompt-create', [target]) as string); return false;
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
  const target = await targetOrRead(sid), body = typeof value === 'string' ? value : await Ed.readMini(`Prompt ${target.sid}: `, '');
  const id = await rpc('agent-prompt-create', [{ ...target, text: body }]) as string;
  try { await rpc('agent-prompt-send', [id]); Ed.message(`Prompt sent to ${target.sid}`); }
  catch (e) { await showDraft(id); throw e; }
  return false;
});
CMD('agent-session-revive', '', '&optional SID', 'Explicitly revive the selected dead ACP session.', async ([sid]: SchemeValue[]) => { const target = await targetOrRead(sid); await rpc('agent-session-revive', [target.sid, { epoch: target.epoch }]); return false; });
CMD('agent-session-mode', '', '&optional MODE SID', 'Choose an offered ACP mode; hub errors remain errors.', async ([value, sid]: SchemeValue[]) => {
  const target = await targetOrRead(sid), info = await rpc('agent-session-details', [target.sid, target.epoch]) as Json;
  const modes = info.modes?.availableModes || info.availableModes || [];
  if (!modes.length) signal('user-error', 'This session offers no modes');
  const labels = modes.map((m: Json) => `${m.id}: ${m.name || m.id}`);
  const mode = typeof value === 'string' ? value : modes[labels.indexOf(await Ed.readMini('Mode: ', '', () => labels, { require: true }))].id;
  if (!modes.some((m: Json) => m.id === mode)) signal('user-error', 'That mode was not offered');
  await rpc('agent-session-mode', [target.sid, { modeId: mode, epoch: target.epoch }]); return false;
});
CMD('agent-session-config', '', '&optional ID VALUE SID', 'Set an ACP configuration option; older hubs report this route as unsupported.', async ([id, value, sid]: SchemeValue[]) => {
  const target = await targetOrRead(sid), info = await rpc('agent-session-details', [target.sid, target.epoch]) as Json, options = info.configOptions || [];
  if (!options.length) signal('user-error', 'This session offers no configuration options');
  const labels = options.map((o: Json) => `${o.id}: ${o.name || o.id}`);
  const chosen = typeof id === 'string' ? options.find((o: Json) => o.id === id) : options[labels.indexOf(await Ed.readMini('Option: ', '', () => labels, { require: true }))];
  if (!chosen) signal('user-error', 'That option was not offered');
  const choices: Json[] = (chosen.options || []).flatMap((o: Json) => Array.isArray(o.options) ? o.options : [o]);
  const values = choices.map(o => String(o.value));
  const selected = value === undefined ? await Ed.readMini(`${chosen.name || chosen.id}: `, String(chosen.currentValue ?? ''), () => values, { require: true }) : value;
  const option = choices.find(o => String(o.value) === String(selected));
  if (!option) return signal('user-error', 'That value was not offered');
  await rpc('agent-session-config', [target.sid, { id: chosen.id, value: option.value, epoch: target.epoch }]); return false;
});
async function fieldValue(name: string, schema: Json, required: boolean): Promise<unknown> {
  const label = `${schema.title || name}${required ? '' : ' (optional, blank skips)'} [${schema.type || 'string'}]: `;
  if (schema.type === 'boolean') {
    const choices = required ? ['true', 'false'] : ['true', 'false', 'skip'];
    const v = await Ed.readMini(label, '', () => choices, { require: true }); return v === 'skip' ? undefined : v === 'true';
  }
  const choices = Array.isArray(schema.enum) ? schema.enum.map(String) : null;
  let v: string;
  if (choices && !required) {
    const selected = await Ed.readMini(label, 'Skip field', () => ['Skip field', ...choices.map((v: string) => 'Use: ' + v)], { require: true });
    if (selected === 'Skip field') return undefined;
    v = selected.slice(5);
  } else v = await Ed.readMini(label, schema.default === undefined ? '' : typeof schema.default === 'string' ? schema.default : JSON.stringify(schema.default), choices ? () => choices : null, { require: !!choices });
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
  const request = await rpc('agent-session-request', [chosen.sid, chosen.req, chosen.epoch]) as Json;
  if (request.epoch !== chosen.epoch || (request.req !== undefined && request.req !== chosen.req)) signal('user-error', 'Agent session was replaced; refresh pending requests');
  const captured = { req: chosen.req, epoch: chosen.epoch }, kind = request.kind || request.e || chosen.kind;
  if (kind === 'permission') {
    const previous = Ed.winConfig();
    try {
      jsonView('*Agent Permission Request*', { sid: chosen.sid, createdAt: chosen.epoch, req: chosen.req, request });
      const options = request.options || request.event?.options || [];
      const choices = options.map((o: Json) => `${o.optionId}: ${o.name || o.kind || o.optionId}`), cancelled = 'Cancel request';
      const selected = await Ed.readMini('Permission: ', '', () => [...choices, cancelled], { require: true });
      const outcome = selected === cancelled ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: options[choices.indexOf(selected)].optionId };
      await rpc('agent-session-permission', [chosen.sid, { ...captured, outcome }]);
    } finally { Ed.restoreWinConfig(previous); }
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

// Prompt-engineering stage: immutable resource snapshots, multiple targets, and named reuse.
CMD('agent-prompt-targets', '', '&optional TARGETS ID', 'Choose several ACP destinations, separated by commas, with session completion.', async ([targets, value]: SchemeValue[]) => {
  const id = await chooseDraft(value), current = await rpc('agent-prompt-targets', [id]) as Array<{ sid: string; epoch: number | null }>, available = await sessions(), labels = available.map(t => `${t.sid}@${t.epoch}`);
  const input = typeof targets === 'string' ? targets : await Ed.readMini('Targets (comma separated): ', current.map(t => `${t.sid}@${t.epoch ?? 'unbound'}`).join(', '), t => { const prefix = t.slice(0, t.lastIndexOf(',') + 1); return labels.map(s => prefix + (prefix ? ' ' : '') + s); });
  const values = typeof targets !== 'string' && targets !== undefined ? L.arr(targets).map(String) : input.split(/[\s,]+/).filter(Boolean);
  const chosen = values.map(value => available.find(t => t.sid === value || `${t.sid}@${t.epoch}` === value) || signal('user-error', `No such offered ACP session incarnation: ${value}`));
  await rpc('agent-prompt-targets', [id, chosen]); return false;
});
CMD('agent-prompt-attach-file', '', '&optional FILE EMBED ID', 'Attach an agent-side file URI as resource_link, or explicitly embed an Edwin-side file after authority checks; never paste into prompt text.', async ([file, embed, value]: SchemeValue[]) => {
  const source = cur(), id = await chooseDraft(value);
  const method = embed === undefined ? await Ed.readMini('Attach file (link/embed): ', 'link', () => ['link', 'embed'], { require: true }) : embed === false ? 'link' : 'embed';
  const filename = typeof file === 'string' ? file : method === 'embed' ? await ((H.readFileName && H.readFileName('Embed Edwin file: ')) || Ed.readMini('Embed Edwin file: ', source.file || '')) : await Ed.readMini('Agent-side absolute path or URI: ', '');
  const mimeType = await Ed.readMini('MIME type: ', 'text/plain');
  await rpc('agent-prompt-attach-file', [id, filename, { embed: method === 'embed', mimeType }]); Ed.message('File attached as a resource'); return false;
});
function resource(b: EdBuffer, start = 0, end = b.rope.length) {
  return { uri: `edwin-buffer:${encodeURIComponent(b.shared ? b.id : b.name)}?start=${start}&end=${end}`, name: b.name, text: b.rope.slice(start, end), mimeType: b.mode === 'markdown-mode' ? 'text/markdown' : 'text/plain' };
}
CMD('agent-prompt-attach-buffer', '', '&optional BUFFER ID', 'Attach the source buffer as an immutable embedded resource, even when the draft is in another window.', async ([name, value]: SchemeValue[]) => {
  const source = name === undefined ? cur() : Ed.toBuffer(name), snapshot = resource(source), id = await chooseDraft(value);
  if (source.shared) await synced(String(source.id));
  await rpc('agent-prompt-attach-buffer', [id, snapshot]); Ed.message('Buffer attached as a resource'); return false;
});
CMD('agent-prompt-attach-region', '', '&optional ID', 'Attach the current source region as an immutable resource; it is never inserted into prompt text.', async ([value]: SchemeValue[]) => {
  const source = cur();
  let start = Math.min(source.pt, source.mark ?? source.pt), end = Math.max(source.pt, source.mark ?? source.pt);
  if (E.evil && globalThis.EvilCore.stateOf(source) === 'visual') [start, end] = globalThis.EvilCore.visualRange(source);
  if (start === end) signal('user-error', 'No source region is selected');
  const snapshot = resource(source, start, end), id = await chooseDraft(value);
  await rpc('agent-prompt-attach-region', [id, snapshot]); Ed.message('Region attached as a resource'); return false;
});
CMD('agent-prompt-save', '', '&optional NAME ID', 'Save exact text and resource blocks as a named reusable prompt.', async ([name, value]: SchemeValue[]) => {
  const id = await chooseDraft(value); await synced(id); const names = await rpc('agent-prompt-list') as string[];
  const label = typeof name === 'string' ? name : await Ed.readMini('Save prompt as: ', '', () => names);
  await rpc('agent-prompt-save', [id, label]); Ed.message(`Saved prompt ${label}`); return false;
});
CMD('agent-prompt-load', '', '&optional NAME SID', 'Reuse a named prompt and its resources in a new editable draft.', async ([name, sid]: SchemeValue[]) => {
  const names = await rpc('agent-prompt-list') as string[];
  if (!names.length) signal('user-error', 'No named prompts have been saved');
  const label = typeof name === 'string' ? name : await Ed.readMini('Reuse prompt: ', '', () => names, { require: true });
  const target = await targetOrRead(sid);
  await showDraft(await rpc('agent-prompt-load', [label, [target]]) as string); return false;
});
CMD('agent-prompt-list', '', '', 'List saved prompt names; agent-prompt-load reuses one with completion.', async () => { jsonView('*Agent Named Prompts*', await rpc('agent-prompt-list')); return false; });
})();
