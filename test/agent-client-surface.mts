// The same unconfigured edwind boots both sides; fresh realms isolate the classic scripts' globals.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { coreSource, createHost } from './headless.mts';
import type { Edwin } from './headless.mts';
import { transport } from './edit-client.mts';
import { makeDocument } from './frame-input.mts';
import type { FakeElement } from './frame-input.mts';

// Walk named maps AND Evil's per-mode/state maps, including unnamed prefix maps, shared submaps and parents.
function keymaps(Ed: Edwin, L: Edwin) {
  const ids = new Map<Edwin, number>(), maps: unknown[] = [];
  function ref(map: Edwin): number {
    if (ids.has(map)) return ids.get(map)!;
    const id = ids.size; ids.set(map, id);
    maps[id] = [map.name, map.parent ? ref(map.parent) : null, [...map.map].map(([key, binding]) =>
      [key, binding instanceof Ed.Keymap ? ref(binding) : schemeValue(L, binding)])];
    return id;
  }
  const globals = [...L.variableNames()].map(name => [name, L.get(name)]).filter(([, v]) => v instanceof Ed.Keymap);
  return { globals: globals.map(([name, v]) => [name, ref(v)]), evil: [...Ed.E.aux].map(([name, v]) => [name, ref(v)]), maps };
}

function schemeValue(L: Edwin, v: Edwin) {
  if (typeof v === 'function') return v.src ? L.write(v.src) : String(v);
  return typeof v === 'symbol' ? String(v) : L.write(v);
}

function domListeners(el: FakeElement, at: string, out: unknown[]) {
  for (const [type, fn, opts] of el.listeners) out.push([at, type, String(fn), JSON.stringify(opts)]);
  el.children.forEach((child, i) => domListeners(child, `${at}/${child.localName}[${i}]`, out));
}

export async function clientSurface(socket: string, files: string[], kind: 'browser' | 'node') {
  const doc = makeDocument(), head = doc.createElement('head'); doc.documentElement.insertBefore(head, doc.body);
  Object.assign(doc, { head, readyState: 'complete' });
  // Record requests AND cancellation, before any script runs. Freeze elapsed time: a slow daemon reply must
  // not arbitrarily run one realm's timeout before its peer's. Paint the frame explicitly after ready.
  const timers: unknown[] = [];
  const schedule = (kind: string) => (fn: Function, ms = 0) => timers.push([kind, ms, String(fn)]);
  const cancel = (kind: string) => (id: number) => { timers.push([kind, id]); };
  // Window and document share a listener array in makeDocument; keep the actual target and options too.
  const registrations: unknown[] = [];
  function observe(target: Edwin, label: string, names: string[]) {
    for (const name of names) {
      const original = target[name];
      target[name] = function (...args: unknown[]) {
        registrations.push([label, name, ...args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a))]);
        return original.apply(this, args);
      };
    }
  }
  observe(doc, 'document', ['addEventListener', 'removeEventListener']);
  observe(doc.defaultView, 'window', ['addEventListener', 'removeEventListener']);
  const ctx = vm.createContext({ console, performance, queueMicrotask, TextEncoder, TextDecoder, URL,
    setTimeout: schedule('timeout'), setInterval: schedule('interval'), clearTimeout: cancel('clearTimeout'), clearInterval: cancel('clearInterval') });
  if (kind === 'browser') {
    Object.assign(ctx, doc.defaultView, { document: doc, requestAnimationFrame: schedule('frame'), cancelAnimationFrame: cancel('cancelFrame'),
      requestIdleCallback: schedule('idle'), cancelIdleCallback: cancel('cancelIdle') });
    doc.defaultView = ctx.window = ctx.self = vm.runInContext('globalThis', ctx);
    const s = coreSource('host-browser'); vm.runInContext(s.text, ctx, { filename: s.filename });
  } else {
    ctx.EdHost = createHost({ workers: false });
    ctx.EdHost.nextFrame = schedule('frame'); ctx.EdHost.idle = schedule('idle');
  }
  // These registrations are private or no-ops on some hosts; observe the boundary as well as the DOM.
  observe(ctx.EdHost, 'host', ['onSuspend', 'whenLoaded', 'onCspViolation']);
  observe(ctx.EdHost.page, 'page', ['onResize', 'onMedia', 'onFontsLoaded']);
  for (const name of files) {
    const s = coreSource(name); vm.runInContext(s.text, ctx, { filename: s.filename });
    if (name === 'editor-core') observe(ctx.Ed, 'Ed', ['onFrameEvent']);
  }
  const { Ed, L } = ctx;
  const manifest = JSON.parse(readFileSync(new URL('../console/manifest.json', import.meta.url), 'utf8')) as { scm: string[] };
  const sources = kind === 'browser' ? Object.fromEntries(manifest.scm.map(p => [p.slice(4), readFileSync(new URL('../' + p, import.meta.url), 'utf8')])) : undefined;
  try {
    const boot = Ed.bootServed({ sources, transport: transport(socket), device: 'inert-client-test' });
    // As on the console page, frame wiring precedes the welcome, and survives completion of served boot.
    const el = doc.createElement('div'); doc.body.appendChild(el);
    Ed.makeFrame(el, { buffer: Ed.getBuffer('*scratch*'), kind: 'console' });
    const sync = await boot; await Ed.whenIdle(); Ed.frameRender();
    assert.equal(sync.ready, true); assert.deepEqual(Object.keys(sync.welcome.caps), []);
    assert.ok(Ed.getBuffer('*scratch*') && L.isCommand(L.intern('evil-normal-state')) && el.querySelector('.ml-name'));
    const dom: unknown[] = []; domListeners(doc.documentElement, 'html', dom);
    const names = (obj: object) => Reflect.ownKeys(obj).map(String).sort();
    const shape = (obj: Edwin) => Object.fromEntries(names(obj).map(n => [n, typeof obj[n]]));
    return {
      globals: names(vm.runInContext('globalThis', ctx)), ed: shape(Ed), runtime: shape(L), host: shape(ctx.EdHost),
      schemeGlobals: [...L.S.globals.keys()].sort(),
      commands: [...L.commandNames()].map(name => {
        const f = L.get(name);
        return [name, f.procName, schemeValue(L, f), schemeValue(L, f.interactive), f.jsSpec, f.doc, L.write(f.params),
          f.arity, f.optional, f.rest, f.where, [...(f.props || [])].map(([k, v]) => [schemeValue(L, k), schemeValue(L, v)])];
      }),
      keymaps: keymaps(Ed, L), hooks: Object.entries(Ed.hooks).map(([name, f]) => [name, String(f)]),
      registrations, dom, page: doc.listeners.map(([type, fn]) => [type, String(fn)]),
      syncListeners: [...sync.listeners].map(([ev, listeners]) => [ev, Array.from(listeners as Function[], String)]),
      timers, editorTimers: [...Ed.E.timers],
    };
  } finally { Ed.sync.shutdown(); }
}
