// Monthly scorecard, step 2 of 3: start each planned server and list its tools. This is the step that
// runs other people's packages, so the workflow runs it inside a container with no GitHub token, and
// build.mjs checks everything it writes before using it.
//
//   node scorecard/scan.mjs <plan.json> <out dir> [--jobs N] [--timeout ms]
//
// Writes <out dir>/<id>.json for each server: { id, ok, ms, server, tools } or { id, ok: false, error }.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const [planFile, outDir] = process.argv.slice(2);
if (!planFile || !outDir) { console.error('usage: node scorecard/scan.mjs <plan.json> <out dir> [--jobs N] [--timeout ms]'); process.exit(2); }
const opt = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : dflt; };
const JOBS = opt('--jobs', 4);
const TIMEOUT = opt('--timeout', 180000);
const MAX_OUTPUT = 20 * 1024 * 1024;
const one = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scan-one.mjs');

// Scratch folders for the servers that need one (Filesystem, Memory, Git). In the container this is /work.
const work = process.env.SCORECARD_WORK ?? path.join(os.tmpdir(), 'scorecard-work');
mkdirSync(path.join(work, 'files'), { recursive: true });
mkdirSync(path.join(work, 'repo'), { recursive: true });
if (!existsSync(path.join(work, 'files', 'hello.txt'))) writeFileSync(path.join(work, 'files', 'hello.txt'), 'hello\n');
// The Git server refuses a folder that isn't a repository.
if (!existsSync(path.join(work, 'repo', '.git'))) spawnSync('git', ['init', '-q', path.join(work, 'repo')], { stdio: 'ignore' });
mkdirSync(outDir, { recursive: true });

const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const runnable = plan.servers.filter((s) => !s.problem && (s.url || s.command?.length));

function scan(s) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [one, Buffer.from(JSON.stringify(s)).toString('base64'), work], { cwd: work, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    let out = '';
    p.stdout.on('data', (d) => { if (out.length < MAX_OUTPUT) out += d; });
    const kill = () => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { kill(); resolve({ id: s.id, ok: false, error: `no answer within ${TIMEOUT / 1000} s`, ms: TIMEOUT }); }, TIMEOUT);
    p.on('close', () => {
      clearTimeout(timer);
      kill();  // whatever the server left running
      const line = out.trim().split('\n').at(-1);
      try { resolve(JSON.parse(line)); } catch { resolve({ id: s.id, ok: false, error: 'exited without listing tools' }); }
    });
  });
}

let next = 0;
async function worker() {
  while (next < runnable.length) {
    const s = runnable[next++];
    const r = await scan(s);
    writeFileSync(path.join(outDir, `${s.id}.json`), JSON.stringify(r));
    console.log(`${r.ok ? 'listed' : 'failed'} ${s.id.padEnd(40)} ${r.ok ? `${r.tools.length} tools` : r.error}`);
  }
}
await Promise.all(Array.from({ length: JOBS }, worker));
console.log(`scanned ${runnable.length} servers`);
process.exit(0);
