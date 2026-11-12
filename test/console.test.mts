// The console page's frame (console/index.html, the page edwin-front serves) against a real edwind and a
// loopback provider: booted with exactly the Scheme the page fetches, as the browser boots it, and driven by
// keys. The frame suite boots on the Node host, which reads every file under scm/, so a file the page does not
// fetch, or a command of the page that shadows edwind's, shows only here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { makeDir, startEdwind, stopEdwind, EDWIN, transport } from './edit-client.mts';
import type { TestDir, EdwindChild } from './edit-client.mts';

type EdwinCore = any; // any: Edwin's core (src) is outside this program's types

const require = createRequire(import.meta.url);
const { createHost, loadEdwin, memoryStorage } = require('../src/host-node.cts');

const KEY = 'sk-test-' + randomBytes(12).toString('hex');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/* The provider: the Messages API, answering every request "Hello" and counting them. */
let requests = 0;
const provider = http.createServer((req, res) => {
  let body = ''; req.setEncoding('utf8'); req.on('data', d => { body += d; });
  req.on('end', () => {
    if (req.headers['x-api-key'] !== KEY) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"message":"bad key"}}'); return; }
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type: string, o: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
    ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: JSON.parse(body).model, content: [], stop_reason: null, usage: { input_tokens: 9, output_tokens: 0 } } });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello' } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
    ev('message_stop', {}); res.end();
  });
});

let dir: TestDir, child: EdwindChild, Ed: EdwinCore, E: EdwinCore, L: EdwinCore, sync: EdwinCore;
async function until(pred: () => unknown, what: string, ms = 8000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}; *Messages*: ${messages().slice(-600)}`); await sleep(10); } }
const note = (name: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir.dirs.notes, name)), { recursive: true }); fs.writeFileSync(path.join(dir.dirs.notes, name), text); return name; };
const keys = async (s: string) => { for (const k of Ed.kbd(s).split(' ')) Ed.feedKey(k); await Ed.whenIdle(); };
const messages = (): string => Ed.getBuffer('*Messages*').text;
const bound = (key: string, b: EdwinCore): string => { const f = Ed.lookupKey(Ed.kbd(key), b); return typeof f === 'symbol' ? f.description! : f && f.procName || String(f); };
/* Visit the note NAME with point at its end, as the selected buffer. */
async function visit(name: string) { const b = await sync.open(name); Ed.setWindowBuffer(b); E.current = b; b.pt = b.text.length; await Ed.whenIdle(); return b; }

before(async () => {
  const origin = await new Promise<string>(r => provider.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(provider.address() as AddressInfo).port}`)));
  dir = makeDir({ models: { anthropic: { baseUrl: origin, credential: 'anthropic-api-key' }, tiers: { default: 'tier-default', quick: 'tier-quick' } } });
  const creds = path.join(dir.root, 'creds');
  fs.mkdirSync(creds, { mode: 0o700 }); fs.writeFileSync(path.join(creds, 'anthropic-api-key'), KEY, { mode: 0o400 });
  child = await startEdwind(dir, { env: { CREDENTIALS_DIRECTORY: creds } });
  /* What the page does: fetch the files of its SCM list, and boot served with them as the only sources. */
  const html = fs.readFileSync(path.join(EDWIN, 'console/index.html'), 'utf8');
  const names: string[] = JSON.parse(/const SCM = (\[[^\]]*\])/.exec(html)![1].replace(/'/g, '"'));
  const sources: Record<string, string> = {};
  for (const n of names) sources[n + '.scm'] = fs.readFileSync(path.join(EDWIN, 'scm', n + '.scm'), 'utf8');
  Ed = loadEdwin(createHost({ storage: memoryStorage(), workers: false })); E = Ed.E; L = (globalThis as unknown as { L: EdwinCore }).L;
  sync = await Ed.bootServed({ sources, transport: transport(dir.cfg.socket), device: 'console-test' });
  await Ed.whenIdle();
});
after(async () => {
  if (sync) sync.shutdown(); if (child) await stopEdwind(child);
  await new Promise<void>(r => provider.close(() => r()));
  fs.rmSync(dir.root, { recursive: true, force: true });
});

test('the page boots with the files it fetches: no load error, and the AI commands are edwind\'s', () => {
  assert.doesNotMatch(messages(), /Error in |Cannot open load file/);
  for (const f of ['markdown', 'babel', 'pi', 'gptel']) assert.equal(L.truthy(L.evalText(`(featurep '${f})`)), true, `(provide '${f})`);
  for (const c of ['pi', 'pi-send', 'pi-abort', 'pi-model', 'gptel-send', 'gptel-abort', 'model-usage']) assert.ok(L.isCommand(L.intern(c)), `M-x ${c}`);
  for (const c of ['pi-send', 'pi-abort', 'gptel-send', 'gptel-abort', 'model-usage']) assert.equal(L.evalText(`(command-where '${c})`).name, 'server', c);
});

test('C-c RET in a markdown note sends the chat to a pi agent in edwind, and C-c C-u lists unlinked mentions', async () => {
  const b = await visit(note('pi/t.md', '## You\n\nhello\n'));
  assert.equal(bound('C-c RET', b), 'pi-send'); assert.equal(bound('C-c C-m', b), 'pi-send', 'C-c C-m is C-c RET');
  assert.equal(bound('C-c C-k', b), 'pi-abort'); assert.equal(bound('C-c C-u', b), 'markdown-unlinked-mentions');
  const before = requests;
  await keys('C-c RET');
  await until(() => /## pi\n\nHello[\s\S]*## You\n\n$/.test(b.text), 'the answer in the chat');
  assert.equal(requests, before + 1);
});

test('M-x pi visits the chat note of the default session', async () => {
  await Ed.runCommand(L.intern('pi')); await Ed.whenIdle();
  await until(() => sync.buffers.get('pi/chat.md'), 'pi/chat.md');
  const b = sync.buffers.get('pi/chat.md');
  /* Point is under the heading: normal state keeps it on the last line, not past the final newline. */
  await until(() => b.text === '## You\n\n' && b.pt >= 7, `the first heading, with point under it; the note is ${JSON.stringify(b.text)} and point ${b.pt}`);
});

test('SPC g j, C-c i and Org\'s C-c RET run gptel-send in edwind: the answer streams in after the text', async () => {
  const md = await visit(note('plain.md', 'Say hello.\n'));
  let before = requests;
  await keys('SPC g j');
  await until(() => md.text.includes('Hello'), 'the answer after SPC g j');
  assert.equal(requests, before + 1);

  const md2 = await visit(note('insert.md', 'Say hello again.'));
  before = requests;
  await keys('A C-c i');
  await until(() => md2.text.includes('Hello'), 'the answer after C-c i');
  assert.equal(requests, before + 1);
  await keys('ESC');

  const org = await visit(note('o.org', '* Ask\nSay hello.\n'));
  assert.equal(bound('C-c RET', org), 'gptel-send'); assert.equal(bound('C-c C-k', org), 'gptel-abort');
  before = requests;
  await keys('C-c RET');
  await until(() => org.text.includes('Hello'), 'the answer after C-c RET in Org');
  assert.equal(requests, before + 1);
  assert.doesNotMatch(messages(), /published artifact|server-only/);
});
