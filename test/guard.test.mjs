import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, TARGETS, Guard, configFor, loadConfig, decide, inspectCli, redact, readJson, rootOf, rotate, startHarnessArgs, summarizeStatus, safeRuntimeEvents, acquireLock } from '../guard.mjs';

const base = () => ({ version: 1, restarts: [], checkedAt: null, candidate: null, failureSince: null });
const failed = { kind: 'connection_stuck', runtimeId: 'runtime-a', pid: 300 };
const policy = { ...CONFIG, intervalMs: 30, unhealthyMs: 120, cooldownMs: 600 };
const advance = (state, sample, from, until, paused = false, config = policy) => {
  for (let t = from; t <= until; t += config.intervalMs) state = decide(state, sample, t, paused, config);
  return state;
};
const rawStatus = () => ({ spaceId: CONFIG.spaceId, local: {
  pid: 123, runtimeId: 'runtime-a', root: CONFIG.home, spaceId: CONFIG.spaceId, harnesses: ['pi', 'codex'],
  state: 'ready', harnessConnected: true, workspaceConnected: true,
}, remote: { online: true, runtimeId: 'runtime-a', workspace: { online: true } }, remoteError: null, nativeSyncError: null });

test('only a continuous confirmed outage reaches recovery', () => {
  let s = advance(base(), failed, 0, 90);
  assert.equal(s.action, 'observe');
  s = decide(s, failed, 120, false, policy);
  assert.equal(s.action, 'recover');
  assert.equal(decide(s, { kind: 'healthy' }, 150, false, policy).failureSince, null);
});
test('network failure, permission failure and unknown ownership never trigger restart', () => {
  for (const kind of ['remote_unavailable', 'probe_error', 'config_error', 'scope_changed', 'another_runtime', 'attention']) {
    const s = advance(base(), { kind }, 0, 600);
    assert.equal(s.action, 'observe');
    assert.equal(s.failureSince, null);
  }
});
test('pause, uncertain probe, replacement Runtime and monitoring gap reset the outage timer', () => {
  const s = advance(base(), failed, 0, 90);
  assert.equal(decide(s, failed, 120, true, policy).failureSince, null);
  assert.equal(decide(s, { kind: 'probe_error' }, 120, false, policy).failureSince, null);
  assert.equal(decide(s, { ...failed, runtimeId: 'new' }, 120, false, policy).failureSince, 120);
  assert.equal(decide(s, failed, 1000, false, policy).failureSince, 1000);
});
test('process death also requires confirmation, cooldown and hourly circuit breaker survive restarts', () => {
  const down = { kind: 'process_down', runtimeId: null, pid: null };
  assert.equal(advance(base(), down, 0, 120).action, 'recover');
  const s = advance({ ...base(), restarts: [0] }, failed, 0, 120);
  assert.equal(s.reason, 'cooldown');
  assert.equal(advance(s, failed, 150, 600).action, 'recover');
  const limited = advance({ ...base(), restarts: [0, 10, 20] }, failed, 1000, 1120);
  assert.equal(limited.reason, 'rate_limited');
});
test('malformed status is not interpreted as offline', () => {
  assert.throws(() => summarizeStatus({}), /Invalid/);
  const r = rawStatus();
  delete r.remote.workspace;
  assert.throws(() => summarizeStatus(r), /Missing remote/);
  assert.equal(summarizeStatus(rawStatus()).kind, 'healthy');
  const offline = rawStatus(); offline.local = null; offline.remote.online = false;
  assert.equal(summarizeStatus(offline).kind, 'process_down');
  const network = rawStatus(); network.remote = null; network.remoteError = 'fetch failed';
  assert.equal(summarizeStatus(network).kind, 'remote_unavailable');
  const conflict = rawStatus(); conflict.remote.runtimeId = 'other';
  assert.equal(summarizeStatus(conflict).kind, 'another_runtime');
});
test('log projection excludes commands, prompts, credentials and stacks', () => {
  const e = safeRuntimeEvents([{ event: 'error', data: { code: 1006, cmd: 'PRIVATE_COMMAND', prompt: 'PRIVATE_PROMPT' },
    error: { message: 'Bearer PRIVATE_TOKEN https://u:password@host/?token=secret', stack: 'PRIVATE_STACK' } }]);
  const text = JSON.stringify(e);
  for (const secret of ['PRIVATE_COMMAND', 'PRIVATE_PROMPT', 'PRIVATE_TOKEN', 'PRIVATE_STACK', 'password@', 'token=secret']) assert.ok(!text.includes(secret));
  assert.equal(redact({ apiToken: 'secret' }).apiToken, '[REDACTED]');
});

async function fixture(t, target = CONFIG, rootName = null) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cohub-guard-test-'));
  const dir = path.join(home, 'cli');
  const config = { ...target, home, identity: 'prod:test-user', node: process.execPath,
    cli: path.join(dir, 'bin/cohub.js'), recoveryCli: null, worker: path.join(dir, 'dist/runtime/worker.js'),
    directory: path.join(home, 'guard'), compatibilityFile: path.join(home, 'compatibility.json'),
    graceMs: 150, codex: '/unused/codex', pi: '/unused/pi',
    ...(rootName ? { root: path.join(home, rootName) } : {}) };
  if (!rootName) delete config.root;  // without a test folder, the fixture home is the served directory
  if (rootName) await fs.mkdir(config.root, { recursive: true });
  await fs.mkdir(path.dirname(config.cli), { recursive: true });
  await fs.mkdir(path.dirname(config.worker), { recursive: true });
  const here = path.dirname(fileURLToPath(import.meta.url));
  await fs.copyFile(path.join(here, 'fixtures/cli.mjs'), config.cli);
  await fs.copyFile(path.join(here, 'fixtures/worker.mjs'), config.worker);
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: '@neta-art/cohub-cli', type: 'module', version: '10.0.0' }));
  await fs.mkdir(path.join(dir, 'dist/commands'), { recursive: true });
  for (const name of ['runtime', 'auth', 'run']) await fs.writeFile(path.join(dir, 'dist/commands', `${name}.js`), '');
  const inspected = await inspectCli(config.cli);
  await fs.writeFile(config.compatibilityFile, JSON.stringify({ schemaVersion: 1,
    reviewedVersion: inspected.version, fingerprint: inspected.fingerprint }));
  await fs.writeFile(path.join(home, 'fixture.json'), JSON.stringify({ identity: config.identity, spaceId: config.spaceId, worker: config.worker,
    root: rootOf(config), harnesses: config.harnesses }));
  const g = new Guard(config);
  g.systemProxyReader = async () => '<dictionary> {}';
  g.networkSourceEnv = {};
  g.proxyProbe = async endpoint => ({ ...endpoint, ok: true });
  g.network = async () => [{ host: 'fixture.invalid', httpStatus: 200 }];
  await g.init();
  await fs.mkdir(path.dirname(g.nativeFile), { recursive: true });
  await fs.writeFile(g.nativeFile, JSON.stringify({ version: 2, identity: config.identity, root: rootOf(config), spaceId: config.spaceId,
    harnesses: config.harnesses, codexShared: false, enabledAt: new Date().toISOString() }));
  await fs.mkdir(path.join(home, '.config/cohub'), { recursive: true });
  await fs.writeFile(path.join(home, '.config/cohub/runtime-spaces.json'), JSON.stringify({ version: 1,
    bindings: [{ root: rootOf(config), key: config.identity, spaceId: config.spaceId }] }));
  t.after(async () => {
    const o = await g.owner();
    if (o && o.pid !== process.pid && await g.processIdentity(o.pid)) process.kill(o.pid, 'SIGKILL');
    await fs.rm(home, { recursive: true, force: true });
  });
  return g;
}
async function setFixture(g, patch) {
  const f = path.join(g.config.home, 'fixture.json');
  await fs.writeFile(f, JSON.stringify({ ...await readJson(f), ...patch }));
}

test('integration: dead process starts once, without replaying any task', async t => {
  const g = await fixture(t);
  const before = await g.probe();
  assert.equal(before.kind, 'process_down');
  const result = await g.recover(before);
  assert.equal(result.outcome, 'recovered');
  assert.equal((await g.probe()).kind, 'healthy');
  const calls = (await fs.readFile(path.join(g.config.home, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(a => a[1] === 'up').length, 1);
  const up = calls.find(a => a[1] === 'up');
  assert.ok(up.includes('--no-display'));
  assert.ok(!up.includes('--display'));
  assert.ok(calls.every(a => !a.includes('prompt') && !a.includes('import')));
});
test('status probes have an explicit timeout and never report a killed command as error 0', async t => {
  const g = await fixture(t);
  g.cli = async (args, timeout) => {
    assert.deepEqual(args, ['runtime', 'status', '--space', g.config.spaceId, '--json']);
    assert.equal(timeout, 30_000);
    return { ok: false, killed: true, code: 0, stdout: '', stderr: '' };
  };
  await assert.rejects(g.probe(), /timed out after 30000 ms/);
});
test('integration: graceful stop restarts only the fixture worker', async t => {
  const g = await fixture(t);
  g.config = { ...g.config, graceMs: CONFIG.graceMs };
  await g.cli(['runtime', 'up']);
  await setFixture(g, { stuck: true });
  const before = await g.probe();
  const result = await g.recover(before);
  assert.equal(result.outcome, 'recovered');
  assert.notEqual(result.pid, before.pid);
  assert.equal(await g.processIdentity(before.pid), null);
  assert.ok(!(await fs.readFile(g.logFile, 'utf8')).includes('forced_stop'));
});
test('integration: stuck graceful stop verifies identity then force-stops and restarts', async t => {
  const g = await fixture(t);
  await g.cli(['runtime', 'up']);
  await setFixture(g, { stuck: true, refuseStop: true });
  const before = await g.probe();
  const result = await g.recover(before);
  assert.equal(result.outcome, 'recovered');
  assert.equal(await g.processIdentity(before.pid), null);
  assert.ok((await fs.readFile(g.logFile, 'utf8')).includes('forced_stop'));
});
test('changed consent, invalid CLI package and malformed state fail closed', async t => {
  const g = await fixture(t);
  const original = await fs.readFile(g.nativeFile, 'utf8');
  await fs.writeFile(g.nativeFile, original.replace('"codexShared":false', '"codexShared":true'));
  await assert.rejects(g.preflight(), /configuration changed/);
  await fs.writeFile(g.nativeFile, original);
  const packageFile = path.join(path.dirname(g.config.cli), '../package.json');
  const originalPackage = await fs.readFile(packageFile, 'utf8');
  await fs.writeFile(packageFile, JSON.stringify({ version: '99.0.0' }));
  await assert.rejects(g.preflight(), /invalid package/);
  await fs.writeFile(packageFile, originalPackage);
  await fs.writeFile(g.stateFile, '{broken');
  await assert.rejects(g.loadState(), SyntaxError);
  assert.equal(await fs.readFile(g.stateFile, 'utf8'), '{broken');
});
test('replacement Runtime or paused control prevents destructive commands', async t => {
  const g = await fixture(t);
  await g.cli(['runtime', 'up']);
  const result = await g.recover({ ...await g.probe(), kind: 'connection_stuck', runtimeId: 'old' });
  assert.equal(result.outcome, 'skipped');
  await fs.writeFile(g.controlFile, JSON.stringify({ version: 1, paused: true }));
  assert.equal((await g.recover(await g.probe())).reason, 'paused');
  const calls = await fs.readFile(path.join(g.config.home, 'calls.jsonl'), 'utf8');
  assert.ok(!calls.includes('"down"'));
});
test('a PID occupied by an unrelated process is never killed or replaced', async t => {
  const g = await fixture(t);
  const ownerDir = path.dirname(g.ownerFile);
  await fs.mkdir(ownerDir, { recursive: true });
  await fs.writeFile(g.ownerFile, JSON.stringify({ pid: process.pid, runtimeId: 'occupied', nonce: 'fixture', socket: path.join(ownerDir, 'control.sock') }));
  await setFixture(g, { stuck: true });
  await assert.rejects(g.recover(await g.probe()), /approved Runtime/);
  assert.ok(!(await fs.readFile(path.join(g.config.home, 'calls.jsonl'), 'utf8')).includes('"down"'));
});
test('an owner change during graceful shutdown prevents forced termination', async t => {
  const g = await fixture(t);
  await g.cli(['runtime', 'up']);
  await setFixture(g, { stuck: true, refuseStop: true });
  const sample = await g.probe();
  const cli = g.cli.bind(g);
  g.cli = async (args, timeout) => {
    const result = await cli(args, timeout);
    if (args[1] === 'down') await fs.writeFile(g.ownerFile, JSON.stringify({ ...await g.owner(), nonce: 'changed-owner' }));
    return result;
  };
  await assert.rejects(g.recover(sample), /replaced/);
  assert.ok(await g.processIdentity(sample.pid));
});
test('child processes prevent forced parent termination', async t => {
  const g = await fixture(t);
  await g.cli(['runtime', 'up']);
  await setFixture(g, { stuck: true, refuseStop: true });
  const sample = await g.probe();
  const command = g.command.bind(g);
  g.command = (file, args, timeout) => args[0] === '-axo' ?
    Promise.resolve({ ok: true, stdout: `99999 ${sample.pid}\n`, stderr: '' }) : command(file, args, timeout);
  await assert.rejects(g.recover(sample), /child processes/);
  assert.ok(await g.processIdentity(sample.pid));
});
test('uncertain probes do not stop or start a Runtime', async t => {
  const g = await fixture(t);
  g.probe = async () => { throw new Error('fetch failed'); };
  const state = await g.tick({ ...base(), checkedAt: Date.now(), candidate: 'process_down:absent', failureSince: 0 });
  assert.equal(state.sample.kind, 'probe_error');
  assert.equal(state.restarts.length, 0);
  const calls = await fs.readFile(path.join(g.config.home, 'calls.jsonl'), 'utf8');
  assert.ok(!calls.includes('"down"') && !calls.includes('"up"'));
});
test('tick records failures, bounded incident logs, rate limit and successful healing', async t => {
  const g = await fixture(t);
  const now = Date.now();
  g.config = { ...g.config, unhealthyMs: 0 };
  const state = await g.tick({ ...base(), checkedAt: now - 30, candidate: 'process_down:absent', failureSince: now - 120 });
  assert.equal(state.lastRecovery.outcome, 'recovered');
  assert.equal(state.restarts.length, 1);
  assert.equal((await g.loadState()).restarts.length, 1);
  const files = await fs.readdir(path.join(g.config.directory, 'incidents'));
  assert.ok(files.length >= 1);
  for (const file of files) assert.ok(!(await fs.readFile(path.join(g.config.directory, 'incidents', file), 'utf8')).includes('private command'));
});
test('singleton lock, corrupt lock and log rotation are safe', async t => {
  const g = await fixture(t);
  const unlock = await acquireLock(g.config.directory);
  await assert.rejects(acquireLock(g.config.directory), /already running/);
  await unlock();
  const lock = path.join(g.config.directory, 'lock.json');
  await fs.writeFile(lock, '{broken');
  await assert.rejects(acquireLock(g.config.directory), SyntaxError);
  assert.equal(await fs.readFile(lock, 'utf8'), '{broken');
  await fs.writeFile(g.logFile, '12345');
  await rotate(g.logFile, 4, 2);
  assert.equal(await fs.readFile(`${g.logFile}.1`, 'utf8'), '12345');
});

// Verify isolation between independently configured workspaces and optional hooks.
const calls = async g => (await fs.readFile(path.join(g.config.home, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
const hookRuns = async g => (await calls(g)).filter(a => a[0] === '-s' && a[2] === 'run');

test('the home target keeps its scope, start command and no hook runs', () => {
  assert.equal(configFor(), CONFIG);
  assert.equal(configFor('home'), CONFIG);
  assert.equal(rootOf(CONFIG), os.homedir());
  assert.deepEqual(startHarnessArgs(CONFIG), ['--harness', 'codex', '--harness', 'pi', '--pi', CONFIG.pi, '--codex', CONFIG.codex]);
  assert.equal(CONFIG.readyHooks, false);
  assert.equal(CONFIG.shareScreen, false);
  assert.throws(() => configFor('nope'), /Unknown target preset/);
});
test('the Pi workspace target guards only its own Space, folder and harness', () => {
  const bot = configFor('pi-only');
  assert.equal(rootOf(bot), path.join(os.homedir(), 'pi-workspace'));
  assert.deepEqual(startHarnessArgs(bot), ['--harness', 'pi', '--pi', bot.pi]);
  assert.notEqual(bot.directory, CONFIG.directory);
  assert.notEqual(bot.spaceId, CONFIG.spaceId);
  assert.equal(bot.shareScreen, false);
  const r = rawStatus();
  Object.assign(r, { spaceId: bot.spaceId });
  Object.assign(r.local, { spaceId: bot.spaceId, root: rootOf(bot), harnesses: ['pi'] });
  assert.equal(summarizeStatus(r, bot).kind, 'healthy');
  assert.equal(summarizeStatus({ ...r, local: { ...r.local, harnesses: ['codex', 'pi'] } }, bot).kind, 'scope_changed');
  assert.equal(summarizeStatus({ ...r, local: { ...r.local, root: CONFIG.home } }, bot).kind, 'scope_changed');
});
test('integration: the Pi workspace target restarts its own folder with only Pi', async t => {
  const g = await fixture(t, TARGETS['pi-only'], 'Pi workspace');
  const result = await g.recover(await g.probe());
  assert.equal(result.outcome, 'recovered');
  const up = (await calls(g)).find(a => a[1] === 'up');
  assert.deepEqual(up, ['runtime', 'up', path.join(g.config.home, 'Pi workspace'), '--space', g.config.spaceId, '--harness', 'pi', '--pi', '/unused/pi', '--no-display', '-d', '--yes', '--json']);
});
test('integration: workspace-ready hooks run once per new Runtime, JSON ready hooks only', async t => {
  const g = await fixture(t, TARGETS['pi-only'], 'Pi workspace');
  const hooks = path.join(g.config.root, '.cohub/hooks');
  await fs.mkdir(hooks, { recursive: true });
  await fs.writeFile(path.join(hooks, 'a-ready.json'), JSON.stringify({ schema: 'cohub.space-hook.v1', on: { event: 'space.workspace.ready' }, run: "python3 '/x/Pi workspace/recover.py'" }));
  await fs.writeFile(path.join(hooks, 'b-finalized.json'), JSON.stringify({ schema: 'cohub.space-hook.v1', on: { event: 'session.turn.finalized' }, run: 'echo finalized' }));
  await fs.writeFile(path.join(hooks, 'c.yml'), 'on: {event: space.workspace.ready}\nrun: echo yaml\n');
  await fs.writeFile(path.join(hooks, 'd-broken.json'), '{');
  await fs.symlink(path.join(hooks, 'a-ready.json'), path.join(hooks, 'e-link.json'));
  await g.cli(['runtime', 'up']);
  let state = await g.tick({ ...base(), checkedAt: Date.now() });
  let runs = await hookRuns(g);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].slice(0, 6), ['-s', g.config.spaceId, 'run', '--async', '--json', '--command']);
  assert.equal(runs[0][6], `COHUB_HOOK_SPACE_ID=${g.config.spaceId} COHUB_HOOK_EVENT_TYPE=space.workspace.ready COHUB_HOOK_SESSION_ID= COHUB_HOOK_TURN_ID= python3 '/x/Pi workspace/recover.py'`);
  assert.deepEqual(state.lastReadyHooks.results.map(r => [r.hook, r.outcome]),
    [['a-ready.json', 'queued'], ['c.yml', 'skipped'], ['d-broken.json', 'invalid'], ['e-link.json', 'skipped']]);
  assert.equal(state.readyRuntimeId, (await g.probe()).runtimeId);
  state = await g.tick(await g.loadState());
  assert.equal((await hookRuns(g)).length, 1);
  const owner = await g.owner();
  process.kill(owner.pid, 'SIGKILL');
  for (let n = 0; n < 40 && await g.processIdentity(owner.pid); n++) await new Promise(r => setTimeout(r, 25));
  await g.cli(['runtime', 'up']);
  state = await g.tick(await g.loadState());
  assert.equal((await hookRuns(g)).length, 2);
  assert.notEqual(state.readyRuntimeId, owner.runtimeId);
});
test('integration: the home target never runs hooks', async t => {
  const g = await fixture(t);
  const hooks = path.join(g.config.home, '.cohub/hooks');
  await fs.mkdir(hooks, { recursive: true });
  await fs.writeFile(path.join(hooks, 'a-ready.json'), JSON.stringify({ schema: 'cohub.space-hook.v1', on: { event: 'space.workspace.ready' }, run: 'echo ready' }));
  await g.cli(['runtime', 'up']);
  const state = await g.tick({ ...base(), checkedAt: Date.now() });
  assert.equal((await hookRuns(g)).length, 0);
  assert.equal(state.lastReadyHooks, undefined);
});
test('a malformed ready-hook marker in the state is not overwritten', async t => {
  const g = await fixture(t, TARGETS['pi-only'], 'Pi workspace');
  await fs.writeFile(g.stateFile, JSON.stringify({ ...base(), readyRuntimeId: 42 }));
  await assert.rejects(g.loadState(), /Invalid guard state/);
  assert.equal(JSON.parse(await fs.readFile(g.stateFile, 'utf8')).readyRuntimeId, 42);
});

test('compatible CLI version changes are accepted without a version pin', async t => {
  const g = await fixture(t);
  const file = path.join(path.dirname(g.config.cli), '../package.json');
  const pkg = await readJson(file);
  await fs.writeFile(file, JSON.stringify({ ...pkg, version: '10.0.1' }));
  assert.equal((await g.checkCompatibility()).version, '10.0.1');
  await g.preflight();
  assert.equal((await g.recover(await g.probe())).outcome, 'recovered');
});

test('changed Runtime code blocks recovery even when the version is unchanged', async t => {
  const g = await fixture(t);
  await fs.appendFile(g.config.worker, '\n// changed startup behavior\n');
  await assert.rejects(g.preflight(), /CLI compatibility/);
  const state = await g.tick(base());
  assert.equal(state.compatibility.status, 'review_required');
  assert.equal(state.reason, 'compatibility_error');
  assert.equal(state.action, 'observe');
  assert.equal(state.restarts.length, 0);
  await assert.rejects(fs.access(path.join(g.config.home, 'calls.jsonl')), { code: 'ENOENT' });
});

test('missing compatibility evidence fails closed without rewriting it', async t => {
  const g = await fixture(t);
  await fs.writeFile(g.config.compatibilityFile, '{broken');
  await assert.rejects(g.preflight(), SyntaxError);
  assert.equal(await fs.readFile(g.config.compatibilityFile, 'utf8'), '{broken');
});

test('dependency changes and prerelease builds need review, unrelated command edits do not', async t => {
  const g = await fixture(t);
  const root = path.resolve(path.dirname(g.config.cli), '..');
  await fs.writeFile(path.join(root, 'dist/commands/boards.js'), '// unrelated feature\n');
  await g.checkCompatibility();
  const file = path.join(root, 'package.json');
  const pkg = await readJson(file);
  await fs.writeFile(file, JSON.stringify({ ...pkg, version: '11.0.0-rc.1' }));
  await assert.rejects(g.checkCompatibility(), /release version/);
  await fs.mkdir(path.join(root, 'node_modules/ws'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules/ws/package.json'), JSON.stringify({ name: 'ws', version: '99.0.0' }));
  await fs.writeFile(file, JSON.stringify({ ...pkg, dependencies: { ws: '^99.0.0' } }));
  await assert.rejects(g.checkCompatibility(), /dependencies changed/);
});

test('compatibility monitoring does not execute an unreviewed CLI or spend restart cooldown', async t => {
  const g = await fixture(t);
  const original = await fs.readFile(g.config.worker);
  await fs.appendFile(g.config.worker, '\n// upgrade\n');
  const blocked = await g.tick({ ...base(), candidate: 'process_down:absent', failureSince: 0, checkedAt: Date.now() });
  assert.equal(blocked.sample.kind, 'compatibility_error');
  assert.deepEqual(blocked.restarts, []);
  assert.equal(blocked.failureSince, null);
  await fs.writeFile(g.config.worker, original);
  const restored = await g.tick(blocked);
  assert.equal(restored.compatibility.status, 'compatible');
  assert.equal(restored.sample.kind, 'process_down');
  assert.equal(restored.action, 'observe');
});

async function pinFixture(g, updateWorker = true) {
  const source = path.resolve(path.dirname(g.config.cli), '..');
  const destination = path.join(g.config.home, 'reviewed-cli');
  await fs.cp(source, destination, { recursive: true, dereference: true });
  g.config = { ...g.config, recoveryCli: path.join(destination, 'bin/cohub.js') };
  if (updateWorker) await setFixture(g, { worker: path.join(destination, 'dist/runtime/worker.js') });
}

test('global CLI upgrade cannot disable recovery or execute changed startup code', async t => {
  const g = await fixture(t);
  await pinFixture(g);
  const pkgFile = path.resolve(path.dirname(g.config.cli), '../package.json');
  await fs.writeFile(pkgFile, JSON.stringify({ ...await readJson(pkgFile), version: '10.1.0' }));
  await fs.writeFile(g.config.cli, 'throw new Error("Unreviewed CLI executed");\n');
  const status = await g.checkCompatibility();
  assert.equal(status.status, 'compatible');
  assert.equal(status.upgradeStatus, 'review_required');
  assert.equal(status.installedVersion, '10.1.0');
  assert.equal(status.version, '10.0.0');
  assert.equal((await g.recover(await g.probe())).outcome, 'recovered');
  assert.equal((await g.probe()).kind, 'healthy');
});

test('half-installed or missing global CLI still allows the reviewed recovery copy', async t => {
  const g = await fixture(t);
  await pinFixture(g);
  await fs.rename(path.resolve(path.dirname(g.config.cli), '..'), path.join(g.config.home, 'upgrade-in-progress'));
  const status = await g.checkCompatibility();
  assert.equal(status.status, 'compatible');
  assert.equal(status.upgradeStatus, 'unavailable');
  assert.match(status.installedError, /ENOENT/);
  assert.equal((await g.recover(await g.probe())).outcome, 'recovered');
});

test('a damaged reviewed copy fails closed even when the global CLI is healthy', async t => {
  const g = await fixture(t);
  await pinFixture(g);
  await fs.appendFile(g.config.recoveryCli, '\n// unexpected modification\n');
  const state = await g.tick(base());
  assert.equal(state.sample.kind, 'compatibility_error');
  assert.deepEqual(state.restarts, []);
  await assert.rejects(fs.access(path.join(g.config.home, 'calls.jsonl')), { code: 'ENOENT' });
});

test('reviewed recovery copy can safely replace a Runtime launched by the global CLI', async t => {
  const g = await fixture(t);
  assert.equal((await g.recover(await g.probe())).outcome, 'recovered');
  const previous = await g.owner();
  await pinFixture(g);
  await setFixture(g, { stuck: true });
  await fs.writeFile(g.config.cli, 'throw new Error("Unreviewed CLI executed");\n');
  assert.equal((await g.recover(await g.probe())).outcome, 'recovered');
  assert.notEqual((await g.owner()).pid, previous.pid);
  assert.equal(await g.processIdentity(previous.pid), null);
  assert.equal((await g.probe()).kind, 'healthy');
  const calls = (await fs.readFile(path.join(g.config.home, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(args => !args.includes('prompt') && !args.includes('import')));
});

test('global CLI replacement between stop and start does not interrupt recovery', async t => {
  const g = await fixture(t);
  await pinFixture(g);
  await g.recover(await g.probe());
  await setFixture(g, { stuck: true });
  const invoke = g.cli.bind(g);
  g.cli = async (args, timeout) => {
    const result = await invoke(args, timeout);
    if (args[1] === 'down') {
      await fs.rename(path.resolve(path.dirname(g.config.cli), '..'), path.join(g.config.home, 'global-being-upgraded'));
    }
    return result;
  };
  assert.equal((await g.recover(await g.probe())).outcome, 'recovered');
  assert.equal((await g.probe()).kind, 'healthy');
  assert.equal((await g.checkCompatibility()).upgradeStatus, 'unavailable');
});

test('public configuration requires explicit scope and an independent recovery CLI', async t => {
  const g = await fixture(t);
  await pinFixture(g);
  const file = path.join(g.config.home, 'config.local.json');
  const input = { home: g.config.home, root: g.config.home, spaceId: 'synthetic-config-space',
    identity: g.config.identity, cli: g.config.cli, recoveryCli: g.config.recoveryCli,
    compatibilityFile: g.config.compatibilityFile, directory: g.config.directory,
    harnesses: ['codex', 'pi'], codex: '/test/bin/codex', pi: '/test/bin/pi' };
  await fs.writeFile(file, JSON.stringify(input));
  const loaded = await loadConfig(file);
  assert.equal(loaded.worker, g.config.worker);
  assert.equal(loaded.shareScreen, false);
  assert.equal(loaded.readyHooks, false);
  await assert.rejects(loadConfig(), /explicit --config/);
  for (const patch of [{ spaceId: CONFIG.spaceId }, { identity: CONFIG.identity }, { root: '~/workspace' },
    { recoveryCli: input.cli }, { harnesses: ['codex', 'codex'] }, { typo: true }, { shareScreen: 'false' }, { graceMs: 0 }]) {
    await fs.writeFile(file, JSON.stringify({ ...input, ...patch }));
    await assert.rejects(loadConfig(file));
  }
  const missing = { ...input }; delete missing.identity;
  await fs.writeFile(file, JSON.stringify(missing));
  await assert.rejects(loadConfig(file), /Missing configuration field/);
  const alias = path.join(g.config.home, 'aliased-cli');
  await fs.symlink(input.cli, alias);
  await fs.writeFile(file, JSON.stringify({ ...input, recoveryCli: alias }));
  await assert.rejects(loadConfig(file), /must not link/);
  await fs.rename(path.resolve(path.dirname(input.cli), '..'), path.join(g.config.home, 'install-in-progress'));
  await fs.writeFile(file, JSON.stringify(input));
  assert.equal((await loadConfig(file)).recoveryCli, input.recoveryCli);
});

test('proxy configuration and proxy-enabled subprocess flags are applied on every CLI call', async t => {
  const g = await fixture(t);
  g.networkSourceEnv = { HTTPS_PROXY: 'http://127.0.0.1:7893' };
  let result = await g.cli(['network-env']);
  assert.equal(JSON.parse(result.stdout).httpsProxy, 'http://127.0.0.1:7893/');
  g.networkSourceEnv = { HTTPS_PROXY: 'http://127.0.0.1:7894' };
  result = await g.cli(['network-env']);
  assert.equal(JSON.parse(result.stdout).httpsProxy, 'http://127.0.0.1:7894/');
  const node = await fs.realpath(g.config.node);
  g.command = async () => ({ ok: true, stdout: `${process.getuid()} Thu Oct 15 08:00:00 2026 ${node} --use-env-proxy ${g.config.worker}\n` });
  assert.match(await g.processIdentity(123), /--use-env-proxy/);
  g.command = async () => ({ ok: true, stdout: `${process.getuid()} Thu Oct 15 08:00:00 2026 ${node} --require /untrusted.js ${g.config.worker}\n` });
  await assert.rejects(g.processIdentity(123), /approved Runtime worker/);
});

test('an unavailable proxy never spends restart budget; recovery resumes after route restoration and confirmed outage', async t => {
  const g = await fixture(t);
  g.networkSourceEnv = { HTTPS_PROXY: 'http://127.0.0.1:7893' };
  g.proxyProbe = async endpoint => ({ ...endpoint, ok: false, code: 'proxy_refused' });
  const blocked = await g.tick(base());
  assert.equal(blocked.network.code, 'proxy_refused');
  assert.equal(blocked.action, 'observe');
  assert.deepEqual(blocked.restarts, []);
  assert.equal(blocked.failureSince, null);
  g.proxyProbe = async endpoint => ({ ...endpoint, ok: true });
  const retry = await g.tick(blocked);
  assert.equal(retry.action, 'observe');
  assert.deepEqual(retry.restarts, []);
  const recovered = await g.tick({ ...retry, failureSince: Date.now() - g.config.unhealthyMs - 1, checkedAt: Date.now() });
  assert.equal(recovered.lastRecovery.outcome, 'recovered');
  assert.equal(recovered.restarts.length, 1);
  assert.equal((await g.probe()).kind, 'healthy');
});

test('invalid proxy configuration and failed account preflight neither execute destructive commands nor spend budget', async t => {
  const g = await fixture(t);
  g.networkSourceEnv = { HTTPS_PROXY: 'socks5://user:secret@proxy.invalid:1080' };
  const invalid = await g.tick(base());
  assert.equal(invalid.network.code, 'unsupported_proxy_protocol');
  assert.deepEqual(invalid.restarts, []);
  assert.ok(!JSON.stringify(invalid).includes('user:secret'));
  await assert.rejects(fs.access(path.join(g.config.home, 'calls.jsonl')), { code: 'ENOENT' });
  g.networkSourceEnv = {};
  const pending = await g.tick(invalid);
  g.preflight = async () => { throw Error('Account verification unavailable'); };
  const deferred = await g.tick({ ...pending, failureSince: Date.now() - g.config.unhealthyMs - 1, checkedAt: Date.now() });
  assert.equal(deferred.lastRecovery.outcome, 'deferred');
  assert.deepEqual(deferred.restarts, []);
  assert.ok((await calls(g)).every(args => !args.includes('up') && !args.includes('down')));
});

test('corrupt network monitor state is preserved rather than reset', async t => {
  const g = await fixture(t);
  await fs.writeFile(g.stateFile, JSON.stringify({ ...base(), network: { code: 'proxy_refused' } }));
  await assert.rejects(g.loadState(), /Invalid guard state/);
  assert.equal(JSON.parse(await fs.readFile(g.stateFile, 'utf8')).network.code, 'proxy_refused');
});

test('a proxy change immediately before stop defers recovery without consuming budget or stopping the existing worker', async t => {
  const g = await fixture(t);
  await g.recover(await g.probe());
  const owner = await g.owner();
  await setFixture(g, { stuck: true });
  const pending = await g.tick(base());
  const invoke = g.cli.bind(g);
  g.cli = async (args, timeout, beforeExecute) => {
    if (args[1] === 'down') g.networkSourceEnv = { HTTPS_PROXY: 'socks5://proxy.invalid:1080' };
    return invoke(args, timeout, beforeExecute);
  };
  const result = await g.tick({ ...pending, failureSince: Date.now() - g.config.unhealthyMs - 1, checkedAt: Date.now() });
  assert.equal(result.lastRecovery.outcome, 'deferred');
  assert.deepEqual(result.restarts, []);
  assert.ok(await g.processIdentity(owner.pid));
  assert.ok((await calls(g)).every(args => !args.includes('down')));
});
