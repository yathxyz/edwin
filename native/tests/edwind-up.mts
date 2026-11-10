// For tests/terminal.rs: an edwind on a fresh directory with one note, a.md. Prints {socket, notes}; on a
// line from stdin, prints a.md as edwind and the disk have it, the notes edwind opened and the directory commands
// it ran, stops edwind and exits.
import fs from 'node:fs';
import path from 'node:path';
import { makeDir, startEdwind, stopEdwind, EditClient } from '../../test/edit-client.mts';
const dir = makeDir();
fs.writeFileSync(path.join(dir.dirs.notes, 'a.md'), '# Shared page\n');
const child = await startEdwind(dir);
console.log(JSON.stringify({ socket: dir.cfg.socket, notes: dir.dirs.notes }));
process.stdin.once('data', async () => {
  const c = new EditClient(dir.cfg.socket);
  await c.connect(); await c.hello();
  const o = await c.open('a.md');
  c.close();
  const opened = [...new Set([...child.logs.matchAll(/\bopen \{"buf":"([^"]+)"/g)].map(m => m[1]))];
  /* The directory commands edwind ran (server/fs.mts logs each), named only by a test that used them. */
  const ran = [...child.logs.matchAll(/\bfs-(\w+) \{/g)].map(m => m[1]);
  console.log(JSON.stringify({ server: o.text, disk: fs.readFileSync(path.join(dir.dirs.notes, 'a.md'), 'utf8'), opened, ...(ran.length ? { fs: ran } : {}) }));
  await stopEdwind(child);
  process.exit(0);
});
