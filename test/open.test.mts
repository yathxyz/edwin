// Ed.openUrl (src/proc.ts): a URL or a file in the desktop's application, through the host. A served frame on the
// Node host, attached to a real edwind, with the desktop program's host.openUrl (native/src/open.rs, whose checks
// and argv are its cargo tests) stood in by a recorder: what reaches the host and what comes back; nothing while
// the image replays (R16.15), through the image edwind sends and edwind's init.scm; edwind's own Node host opens
// nothing; an Org https link goes through it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHost, loadEdwin, memoryStorage } from './headless.mts';
import type { Edwin, NodeHost } from './headless.mts';
import { makeDir, startEdwind, stopEdwind, EditClient, transport } from './edit-client.mts';
import type { TestDir, EdwindChild } from './edit-client.mts';

let dir: TestDir, child: EdwindChild, Ed: Edwin, L: Edwin, sync: Edwin, cli: EditClient;
/* What reached the host: [target, confirmed]; what it answers. */
const calls: [string, boolean][] = [];
let answer: string | null = null;
/* What the frame-side probe saw, by tag: Ed.openUrl's result. */
const seen = new Map<string, string | null>();
const until = async (cond: () => unknown, what: string, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = cond(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await new Promise(r => setTimeout(r, 10)); } };
const turn = () => new Promise(r => setTimeout(r, 5));

before(async () => {
  dir = makeDir();
  fs.writeFileSync(path.join(dir.dirs.config, 'init.scm'), '(on-frames (open-probe "from-init"))\n');
  child = await startEdwind(dir);
  const host = createHost({ storage: memoryStorage(), workers: false }) as NodeHost;
  host.openUrl = (target: string, confirmed: boolean) => { calls.push([target, confirmed]); return answer; };
  Ed = loadEdwin(host); L = (globalThis as unknown as { L: Edwin }).L;
  /* A frame-side procedure a replayed form can call, as a command that opens a reference would be called. */
  L.D('open-probe', 'TAG', 'Open https://example.org/TAG.', ([tag]: unknown[]) => { seen.set(String(tag), Ed.openUrl('https://example.org/' + String(tag))); return false; });
  sync = await Ed.bootServed({ transport: transport(dir.cfg.socket), device: 'open-test' });
  await Ed.whenIdle();
  cli = new EditClient(dir.cfg.socket); await cli.connect(); await cli.hello();
});
after(async () => { if (cli) cli.close(); if (sync) sync.shutdown(); if (child) await stopEdwind(child); fs.rmSync(dir.root, { recursive: true, force: true }); });

test('the target and the confirmation reach the host as given, and its answer comes back', async () => {
  await turn();
  const n = calls.length;
  assert.equal(Ed.openUrl('/home/u/paper.pdf'), null);
  assert.equal(Ed.openUrl('/home/u/page.html', { confirmed: true }), null);
  assert.equal(Ed.openUrl('https://example.org/x', { confirmed: 'yes' } as never), null, 'only true confirms');
  answer = 'Not opened: javascript: is not a scheme Edwin opens (http, https, mailto, file)';
  assert.equal(Ed.openUrl('javascript:alert(1)'), answer);
  answer = null;
  assert.deepEqual(calls.slice(n), [['/home/u/paper.pdf', false], ['/home/u/page.html', true], ['https://example.org/x', false], ['javascript:alert(1)', false]]);
  for (const bad of ['', null, 42]) assert.equal(Ed.openUrl(bad as never), 'Nothing to open');
  assert.equal(calls.length, n + 4, 'no target, no call');
});

test('R16.15: a replayed image opens nothing; the same call outside it does', async () => {
  await until(() => seen.has('from-init'), 'the init.scm probe');
  assert.equal(seen.get('from-init'), 'Nothing opens while the image replays');
  assert.equal(calls.some(c => c[0].endsWith('/from-init')), false);
  const n = calls.length;
  const r = await cli.form('(on-frames (open-probe "image"))');
  assert.equal(r.t, 'result', JSON.stringify(r));
  await until(() => seen.has('image'), 'the replayed probe');
  assert.equal(seen.get('image'), 'Nothing opens while the image replays');
  assert.equal(calls.length, n, 'the replay reached the host');
  await turn();
  L.evalText('(open-probe "typed")');
  assert.equal(seen.get('typed'), null);
  assert.deepEqual(calls.slice(n), [['https://example.org/typed', false]]);
});

test('edwind\'s Node host opens nothing', () => {
  const plain = createHost({ storage: memoryStorage(), workers: false }) as NodeHost;
  assert.match(String(plain.openUrl('https://example.org', false)), /^Nothing opens here/);
});

test('an Org https link is opened through it, and what the host says is shown', async () => {
  const messages = (): string => Ed.getBuffer('*Messages*').text;
  L.evalText('(switch-to-buffer "links.org") (org-mode) (insert "[[https://example.org/paper][paper]]") (goto-char 3)');
  const n = calls.length;
  await Ed.callInteractively(L.intern('org-open-at-point'));
  assert.deepEqual(calls.slice(n), [['https://example.org/paper', false]]);
  assert.ok(messages().includes('Opened https://example.org/paper'), messages());
  answer = 'Cannot run xdg-open: No such file or directory';
  await Ed.callInteractively(L.intern('org-open-at-point'));
  answer = null;
  assert.ok(messages().includes('Cannot run xdg-open: No such file or directory'), messages());
});
