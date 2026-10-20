import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const home = process.env.HOME;
const setup = JSON.parse(await fs.readFile(path.join(home, 'fixture.json'), 'utf8'));
const args = process.argv.slice(2);
await fs.appendFile(path.join(home, 'calls.jsonl'), JSON.stringify(args) + '\n');
const key = createHash('sha256').update(`${setup.identity}\0${setup.spaceId}`).digest('hex').slice(0, 24);
const dir = path.join(home, '.local/state/cohub/instances', key);
const ownerFile = path.join(dir, 'owner.json');
async function owner() {
  try { return JSON.parse(await fs.readFile(ownerFile, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
const emit = x => console.log(JSON.stringify(x));
if (args[0] === 'network-env') {
  emit({ httpProxy: process.env.HTTP_PROXY, httpsProxy: process.env.HTTPS_PROXY, noProxy: process.env.NO_PROXY });
} else if (args[0] === 'auth') {
  emit({ source: 'logto', user: { profile: { logtoUserId: setup.identity.slice(5) } } });
} else if (args[1] === 'logs') {
  const o = await owner();
  emit(setup.events ?? [{ timestamp: setup.disconnectAt ?? '2020-01-01T00:00:00Z', runtimeId: o?.runtimeId,
    event: 'runtime.websocket.closed', data: { code: 1006, activeExecutions: 2, fatal: false, conflict: false, cmd: 'private command' } }]);
} else if (args[1] === 'status') {
  const o = await owner();
  const running = o && alive(o.pid);
  const healthy = running && !setup.stuck;
  emit({ spaceId: setup.spaceId, local: running ? {
    pid: o.pid, runtimeId: o.runtimeId, root: setup.root ?? home, spaceId: setup.spaceId,
    harnesses: setup.harnesses ?? ['codex', 'pi'], state: healthy ? 'ready' : 'reconnecting',
    harnessConnected: !!healthy, workspaceConnected: !!healthy,
  } : null, remote: { online: !!healthy, runtimeId: healthy ? o.runtimeId : null, workspace: { online: !!healthy } },
  remoteError: null, nativeSyncError: null, pendingLocalArchives: 0 });
} else if (args[1] === 'down') {
  const o = await owner();
  if (setup.refuseStop) { console.error('Runtime is still stopping'); process.exitCode = 1; }
  else if (o && alive(o.pid)) {
    process.kill(o.pid, 'SIGTERM');
    for (let n = 0; n < 50 && alive(o.pid); n++) await sleep(20);
    emit({ stopped: !alive(o.pid) });
  } else emit({ stopped: true });
} else if (args[1] === 'up') {
  const o = await owner();
  if (o && alive(o.pid)) throw new Error('Duplicate Runtime');
  const child = spawn(process.execPath, [setup.worker], { detached: true, stdio: 'ignore', env: { HOME: home } });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(ownerFile, JSON.stringify({ pid: child.pid, nonce: randomUUID(), runtimeId: randomUUID(), socket: path.join(dir, 'control.sock') }));
  await fs.writeFile(path.join(home, 'fixture.json'), JSON.stringify({ ...setup, stuck: false }));
  child.unref();
  emit({ state: 'ready', pid: child.pid });
} else if (args[0] === '-s' && args[2] === 'run') {
  emit({ taskRunId: randomUUID() });
} else throw new Error('Unexpected fixture command');
