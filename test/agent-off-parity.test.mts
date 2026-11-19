// Off-mode parity: real edit protocol, state files, CLI and served frame. No hub or credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { EDWIN, MAIN, EditClient, makeDir, nodeFlags, readPrimitiveRegistry, startEdwind, stopEdwind, transport } from './edit-client.mts';
import type { EdwindChild, Msg, TestDir } from './edit-client.mts';
import { createHost, loadEdwin, memoryStorage } from './headless.mts';
import { assertOrdinaryFrameInput } from './frame-input.mts';

const exec = promisify(execFile);
const fixtureEnv = { CREDENTIALS_DIRECTORY: undefined };
const rootBypassesMode = process.getuid?.() === 0 && 'root bypasses directory and file mode restrictions';
async function connect(dir: TestDir) {
  const client = new EditClient(dir.cfg.socket);
  await client.connect();
  const welcome = await client.hello();
  assert.equal(welcome.t, 'welcome'); assert.deepEqual(welcome.caps, {}, 'main advertises no capabilities');
  return client;
}
async function expectStartupFailure(dir: TestDir, message: RegExp) {
  await assert.rejects(async () => {
    const unexpected = await startEdwind(dir, { env: fixtureEnv });
    await stopEdwind(unexpected, 'SIGKILL'); assert.fail('edwind unexpectedly listened');
  }, message);
}

// Compare every row and field, including its source. Offsets shift when unrelated lines are added:
// identify the definer by its file and the actual line at that offset, not just its basename or number.
function registryDigest(registry: ReturnType<typeof readPrimitiveRegistry>, tree: string) {
  const lines = new Map<string, string[]>(), prefix = (tree + '/').slice((tree + '/').indexOf('/edwin/') + 1);
  const rows = registry.map(row => {
    assert.ok(row.source && row.source.startsWith(prefix), `${row.name}: ${row.source}`);
    const match = /^((?:src|server)\/[^/]+):(\d+)$/.exec(row.source.slice(prefix.length));
    assert.ok(match, `${row.name}: ${row.source}`);
    const [, file, number] = match;
    if (!lines.has(file)) lines.set(file, fs.readFileSync(path.join(tree, file), 'utf8').split('\n'));
    const line = lines.get(file)![Number(number) - 1];
    assert.ok(line, `${row.name}: missing definition at ${row.source}`);
    return { ...row, source: [file, line.trim()] };
  });
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

// An observer in the fixture daemon, not a replacement filesystem: all observed calls go to Node unchanged.
// This distinguishes a stat from an open even as root, and lets the FIFO writer wait for the reader.
function observe(dir: TestDir, files: string[]) {
  const preload = path.join(dir.root, 'observe.cjs'), trace = path.join(dir.root, 'access.jsonl');
  fs.writeFileSync(trace, '');
  fs.writeFileSync(preload, `
    const fs = require('node:fs'), files = new Set(${JSON.stringify(files)});
    for (const op of ['statSync', 'openSync', 'readFileSync']) {
      const original = fs[op];
      fs[op] = function(file, ...args) {
        if (files.has(file)) fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify([file, op]) + '\\n');
        return original.call(this, file, ...args);
      };
    }
  `);
  function ops(file: string) {
    return fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as [string, string]).filter(([p]) => p === file).map(([, op]) => op);
  }
  return { preload, ops, clear: () => fs.truncateSync(trace), async until(file: string, op: string) {
    const deadline = Date.now() + 5000;
    while (!ops(file).includes(op)) {
      assert.ok(Date.now() < deadline, `edwind never entered ${op}(${file}); saw ${ops(file)}`);
      await delay(10);
    }
  } };
}

test('without agentHub ordinary daemon and frame behavior matches main', async t => {
  const dir = makeDir({ writablePaths: [] }), { state, config } = dir.dirs;
  let daemon: EdwindChild | undefined, c: EditClient | undefined;
  t.after(async () => {
    c?.close();
    // Even an unexpectedly blocked FIFO reader cannot stall cleanup.
    if (daemon) await stopEdwind(daemon, 'SIGKILL');
    fs.rmSync(dir.root, { recursive: true, force: true });
  });
  const store = path.join(state, 'agent-prompts');
  assert.equal(fs.lstatSync(store, { throwIfNoEntry: false }), undefined);
  daemon = await startEdwind(dir, { env: fixtureEnv }); c = await connect(dir);
  assert.equal(fs.lstatSync(store, { throwIfNoEntry: false }), undefined, 'fresh unconfigured boot must not create agent-prompts');
  // An ordinary user can later create this path. Its files must then edit and recover normally.
  fs.mkdirSync(store);
  const draft = path.join(store, 'ordinary'), headerOnly = 'name:jid-only', unreadable = path.join(config, 'unreadable');
  const base = 'disk base\n', insert = 'not saved: ';
  fs.writeFileSync(draft, base); fs.writeFileSync(unreadable, base);
  for (const id of [draft, headerOnly, unreadable]) {
    const opened = await c.open(id, { create: id === headerOnly });
    assert.equal(opened.text, id === headerOnly ? '' : base, id);
    assert.equal((await c.edit(id, 0, [[0, '', insert]], { g: 'parity' })).t, 'ack');
  }
  c.close(); await stopEdwind(daemon);

  const indexFile = path.join(state, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as { format: number; buffers: Msg[] };
  const row = (id: string) => { const r = index.buffers.find(r => r.id === id); assert.ok(r, id); return r; };
  const journal = (r: Msg, ext: string) => path.join(state, 'buffers', r.jid + ext);
  // Format 1 on main: the index points at a jid; the journal itself contains the canonical id and base.
  const missingId = row(headerOnly);
  index.buffers[index.buffers.indexOf(missingId)] = { jid: missingId.jid };
  fs.writeFileSync(indexFile, JSON.stringify(index));
  // Neither disk nor .saved can supply the old base (including when the test runner is root).
  assert.equal(fs.readFileSync(journal(row(unreadable), '.snap'), 'utf8'), base);
  fs.unlinkSync(journal(row(unreadable), '.saved'));
  if (rootBypassesMode) { fs.unlinkSync(unreadable); fs.mkdirSync(unreadable); } // EISDIR even for root
  else { fs.chmodSync(unreadable, 0); }
  assert.throws(() => fs.readFileSync(unreadable), { code: rootBypassesMode ? 'EISDIR' : 'EACCES' });
  const notesIndex = path.join(state, 'notes-index', 'index.json');
  fs.mkdirSync(path.dirname(notesIndex), { recursive: true });
  fs.rmSync(notesIndex, { force: true }); fs.symlinkSync('index.json', notesIndex);

  const watched = path.join(config, 'watched'), metadata = path.join(dir.root, 'metadata'), fifo = path.join(config, 'fifo');
  const probe = observe(dir, [watched, metadata, fifo]);
  // Debugger.defSource recognizes the packaged /edwin/ path. Use that spelling even in renamed worktrees.
  const tree = path.join(dir.root, 'edwin'); fs.symlinkSync(EDWIN, tree);
  const launch = { main: path.join(tree, 'server/main.mts'), nodeArgs: [...nodeFlags(), '--preserve-symlinks', '--preserve-symlinks-main'] };
  daemon = await startEdwind(dir, { ...launch, env: fixtureEnv, nodeArgs: [...launch.nodeArgs, '--require', probe.preload] });
  const client = c = await connect(dir);
  await t.test('an unreadable notes snapshot reports its underlying error and file path', () => {
    assert.ok(daemon!.logs.split('\n').some(l => l.startsWith('warn notes ') && l.includes('"snapshot":"unreadable"') && l.includes('ELOOP') && l.includes(notesIndex)));
  });
  fs.unlinkSync(notesIndex);
  const runNode = (args: string[]) => exec(process.execPath, args, {
    env: { ...process.env, ...fixtureEnv, HOME: dir.dirs.home }, timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
  });

  await t.test('index rows and unreadable backing recover; live --export uses the same state', async () => {
    const listed = (await client.call('buffer-list')).value as Msg[];
    for (const id of [draft, headerOnly, unreadable]) {
      assert.ok(listed.some(b => b.id === id && b.ver === 1 && b.modified), `recovered ${id} before anyone opened it`);
      const opened = await client.open(id);
      assert.equal(opened.text, insert + (id === headerOnly ? '' : base));
      assert.equal(opened.meta?.readOnly, false);
    }
    assert.equal(fs.readFileSync(draft, 'utf8'), base, 'draft-looking ordinary file still has unsaved edits');
    const out = path.join(dir.root, 'export');
    await runNode([...nodeFlags(), MAIN, '--config', dir.file, '--export', out]);
    for (const id of [draft, headerOnly, unreadable]) {
      const name = id.replace(/^\//, '').replace(/[/:]/g, '%2F');
      assert.equal(fs.readFileSync(path.join(out, name), 'utf8'), insert + (id === headerOnly ? '' : base));
    }
  });

  await t.test('/dev/null opens empty; directory reads retain their path and errno; symlink loops are visible', async () => {
    const dev = await client.open('/dev/null');
    assert.equal(dev.text, ''); assert.equal(dev.meta?.readOnly, 'outside the writable paths');
    const directory = await client.open(config);
    assert.equal(directory.error?.code, 'refused_path'); assert.equal(directory.error?.msg, `${config}: EISDIR`);
    const loop = path.join(config, 'self-link'); fs.symlinkSync('self-link', loop);
    const st = fs.lstatSync(loop), entry = { name: 'self-link', kind: 'link', size: st.size, mtime: Math.floor(st.mtimeMs), mode: st.mode & 0o7777, target: 'self-link' };
    const ls = await client.call('fs-list', [{ dir: config }]);
    assert.deepEqual(ls.value.entries.find((e: Msg) => e.name === 'self-link'), entry);
    assert.deepEqual((await client.call('fs-stat', [{ path: loop }])).value, { path: loop, id: loop, entry });
    const init = path.join(config, 'init.scm'); fs.mkdirSync(init);
    try {
      const reply = await client.call('user-init');
      assert.equal(reply.code, 'refused_path'); assert.equal(reply.msg, `${init}: EISDIR`);
    } finally { fs.rmdirSync(init); }
  });

  await t.test('an unchanged watch and metadata-only visits do not open the file', async () => {
    fs.writeFileSync(metadata, Buffer.from([255]), { mode: 0 });
    assert.deepEqual((await client.call('visit-id', [metadata])).value, { buf: metadata, readOnly: 'outside the writable paths' });
    assert.ok(probe.ops(metadata).includes('statSync'));
    assert.ok(probe.ops(metadata).every(op => op === 'statSync'));
    fs.writeFileSync(watched, 'unchanged'); assert.equal((await client.open(watched)).text, 'unchanged');
    assert.ok(probe.ops(watched).includes('readFileSync'), 'observer saw the initial content read');
    probe.clear();
    fs.chmodSync(watched, 0);  // queues an fs.watch check, without changing ino, size or mtime
    await probe.until(watched, 'statSync');
    assert.deepEqual((await client.call('visit-id', [watched])).value, { buf: watched, readOnly: false });
    assert.ok(probe.ops(watched).every(op => op === 'statSync'), `unchanged watch/live visit: ${probe.ops(watched)}`);
  });

  await t.test('save of an empty write-only file and rename in a writable, search-only directory commit', { skip: rootBypassesMode }, async () => {
    const parent = path.join(config, 'search-only'), from = path.join(parent, 'before'), to = path.join(parent, 'after');
    fs.mkdirSync(parent); fs.writeFileSync(from, ''); assert.equal((await client.open(from)).text, '');
    fs.chmodSync(parent, 0o300); fs.chmodSync(from, 0o200);
    try {
      assert.equal((await client.edit(from, 0, [[0, '', 'changed']])).t, 'ack');
      assert.equal((await client.request({ t: 'save', buf: from })).value?.saved, true);
      assert.deepEqual((await client.call('rename-file', [from, to])).value, { ok: true, src: from, dst: to, from, to });
      assert.equal((await client.open(from)).moved, to); assert.equal((await client.open(to)).text, 'changed');
      assert.equal(fs.existsSync(from), false); assert.equal(fs.statSync(to).mode & 0o777, 0o200);
      fs.chmodSync(to, 0o600); assert.equal(fs.readFileSync(to, 'utf8'), 'changed\n');
      const savedIndex = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      assert.ok(savedIndex.buffers.some((r: Msg) => r.id === to && r.file === to));
    } finally { fs.chmodSync(parent, 0o700); }
  });

  await t.test('served unconfigured frame: another window’s modeline selects it, immediate real mouse still works', async () => {
    const Ed = loadEdwin(createHost({ storage: memoryStorage(), workers: false }));
    const sync = await Ed.bootServed({ transport: transport(dir.cfg.socket), device: 'parity-frame' });
    try {
      await Ed.whenIdle();
      const file = path.join(config, 'frame'); fs.writeFileSync(file, 'first line\nsecond line\nthird line\n');
      await assertOrdinaryFrameInput(Ed, await sync.open(file));
    } finally { sync.shutdown(); }
  });

  await t.test('FIFO open waits for a writer and reads its bytes as text', async () => {
    execFileSync('mkfifo', [fifo]);
    // Do not open the writer in this test thread: a refused read must fail, not wedge the suite.
    const [opened] = await Promise.all([client.open(fifo), (async () => {
      await probe.until(fifo, 'readFileSync');
      await runNode(['-e', "require('node:fs').writeFileSync(process.argv[1], 'from FIFO\\n')", fifo]);
    })()]);
    assert.equal(opened.error, null); assert.equal(opened.text, 'from FIFO\n');
    assert.equal((await client.call('kill-buffer', [fifo])).value, true);
  });

  await t.test('live primitives and --primitives with the identical config match the whole main registry', async () => {
    const live = (await client.call('primitives')).value;
    assert.ok(fs.lstatSync(dir.cfg.socket).isSocket());
    // Run after the last new connection: main's metadata CLI unlinks the configured socket on exit.
    const registry = readPrimitiveRegistry(dir, launch);
    assert.deepEqual(live, registry);
    // Measured from the packaged layout of origin/main (8fe116b), with an empty user image.
    assert.equal(registryDigest(registry, tree), '4025a3be862f99d54908d56ae56332bb78cbd89c7ba466b7d7ed16cd1a2ebb22');
    assert.equal(fs.lstatSync(dir.cfg.socket, { throwIfNoEntry: false }), undefined);
    assert.equal((await client.call('status')).t, 'result', 'the already connected client still works');
  });

  await t.test('a literal null index row fails at startup on main, unlike a jid-only row', async () => {
    const bad = makeDir();
    try {
      fs.writeFileSync(path.join(bad.dirs.state, 'index.json'), JSON.stringify({ format: 1, buffers: [null] }));
      await expectStartupFailure(bad, /Cannot read properties of null \(reading 'jid'\)/);
    } finally { fs.rmSync(bad.root, { recursive: true, force: true }); }
  });

  await t.test('read-only stateDir cannot create main’s boot marker', { skip: rootBypassesMode }, async () => {
    const ro = makeDir();
    try {
      // Pre-existing image epoch: the first mandatory write on restart is boot.json, not image.jsonl.
      fs.writeFileSync(path.join(ro.dirs.state, 'image.jsonl'), JSON.stringify({ t: 'epoch', epoch: '1234567890abcdef' }) + '\n');
      fs.chmodSync(ro.dirs.state, 0o500);
      await expectStartupFailure(ro, /EACCES[^\n]*\.boot\.json\./);
    } finally { fs.chmodSync(ro.dirs.state, 0o700); fs.rmSync(ro.root, { recursive: true, force: true }); }
  });
});
