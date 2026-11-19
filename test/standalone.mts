// Run SCRIPT (an async function body returning a string) in a fresh standalone page.
// By default the page boots unmodified; beforeBoot hands the page's boot options to SCRIPT instead.
// The page's window, document and editor are `win`, `doc` and `Ed`. Strip sources to .js first.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';

export async function inStandalonePage(t: TestContext, script: string, beforeBoot = false): Promise<string> {
  const driver = `<!doctype html><style>body{margin:0}iframe{width:100vw;height:90vh;border:0}</style>
    <output>waiting for the editor</output><script>
    async function drive(frame, bootOptions) {
      const win = frame.contentWindow, doc = frame.contentDocument, out = document.querySelector('output');
      try {
        if (!bootOptions) while (!doc.querySelector('.ml-name')?.textContent.includes('*scratch*')) await new Promise(r => setTimeout(r, 10));
        const Ed = win.Ed;
        out.textContent = 'running page test';
        out.textContent = 'done:' + encodeURIComponent(await (async () => { ${script} })());
      } catch (e) { out.textContent = 'error:' + e; }
    }
    </script><iframe src="/index.html" ${beforeBoot ? '' : 'onload="drive(this)"'}></iframe>`;
  const server = createServer((req, res) => {
    const url = req.url || '/';
    res.setHeader('Content-Security-Policy', "connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'");
    if (url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(driver); return; }
    if (!/^\/(index\.html|src\/[\w-]+\.js|scm\/[\w-]+\.scm)$/.test(url)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', url.endsWith('.html') ? 'text/html; charset=utf-8' : url.endsWith('.js') ? 'text/javascript' : 'text/plain; charset=utf-8');
    try {
      const file = new URL('..' + url, import.meta.url);
      // Keep the standalone DOM, loading order, host and frame construction. Only defer the boot call.
      if (beforeBoot && url === '/index.html') res.end(readFileSync(file, 'utf8').replace('Ed.boot(', 'parent.drive(frameElement, '));
      else res.end(readFileSync(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); });
  const home = mkdtempSync(path.join(tmpdir(), 'edwin-standalone-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { stdout, stderr } = await promisify(execFile)(process.env.CHROMIUM || 'chromium', [
    '--headless', '--disable-gpu', '--disable-background-networking', '--disable-dev-shm-usage', '--no-first-run',
    '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', `--user-data-dir=${home}/profile`,
    ...(process.env.NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    '--dump-dom', '--virtual-time-budget=5000', '--enable-logging=stderr',
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
  ], { env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(), DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent', DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/nonexistent' }, timeout: 30000 });
  const result = /<output>([^<]*)<\/output>/.exec(stdout)?.[1];
  if (!result?.startsWith('done:')) throw Error(`Standalone page: ${result ?? stdout.slice(-1800)}\n${stderr.split('\n').filter(s => s.includes('CONSOLE')).join('\n')}`);
  return decodeURIComponent(result.slice(5));
}
