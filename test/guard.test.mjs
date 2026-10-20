import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { CONFIG, TARGETS, Guard, configFor, loadConfig, decide, retryDelay, inspectCli, redact, readJson, rootOf, rotate, startHarnessArgs, summarizeStatus, safeRuntimeEvents, acquireLock, executionDisconnect, stateNames, CLI_CONTRACT } from '../guard.mjs';

const base = () => ({ version: 1, restarts: [], checkedAt: null, candidate: null, failureSince: null });
const failed = { kind: 'connection_stuck', runtimeId: 'runtime-a', pid: 300,
  harnessConnected: false, executionActivity: { state: 'idle' } };
const policy = { ...CONFIG, intervalMs: 30, unhealthyMs: 120, retryBaseMs: 50, retryMaxMs: 600 };
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
test('continuous failure retries for hours with only capped exponential backoff', () => {
  const sample = { kind: 'process_down', pid: null, runtimeId: null };
  const config = { ...CONFIG, unhealthyMs: 0 };
  let clock = 1_000_000;
  let state = { ...base(), restarts: [clock - 100, clock - 50, clock],
    lastEscalationAt: clock };
  for (let attempt = 1; attempt <= 200; attempt++) {
    state = decide(state, sample, clock, false, config);
    assert.equal(state.action, 'recover', `attempt ${attempt} must not be capped`);
    state.retry = { attempts: attempt, lastAttemptAt: clock, candidate: state.candidate };
    const delay = Math.min(5000 * 2 ** Math.min(attempt - 1, 4), 60000);
    assert.equal(decide(state, sample, clock + delay - 1, false, config).reason, 'retry_backoff');
    assert.equal(decide(state, sample, clock + delay - 1, false, config).nextEligibleAt, clock + delay);
    clock += delay;
  }
  assert.ok(clock - 1_000_000 > 3 * 3_600_000);
  assert.equal(decide(state, { kind: 'healthy' }, clock, false, config).retry, null);
});
test('short retries never bypass another_runtime protection', () => {
  const config = { ...CONFIG, unhealthyMs: 0 };
  const state = { ...base(), retry: { attempts: 100, lastAttemptAt: 0, candidate: 'process_down:absent' } };
  for (const now of [60_000, 3_600_000, 86_400_000]) {
    const blocked = decide(state, { kind: 'another_runtime', pid: null,
      remoteRuntimeId: 'genuine-competitor', online: true }, now, false, config);
    assert.equal(blocked.action, 'observe');
    assert.equal(blocked.reason, 'another_runtime');
  }
});
test('1006 diagnostic evidence rejects stale, foreign, idle, recovered and fatal events', () => {
  const now = Date.now();
  const sample = { ...failed };
  const event = { timestamp: new Date(now - 100).toISOString(), runtimeId: sample.runtimeId,
    event: 'runtime.websocket.closed', data: { code: 1006, activeExecutions: 1, fatal: false, conflict: false } };
  assert.equal(executionDisconnect([event], sample, now).code, 1006);
  for (const patch of [
    { runtimeId: 'another' }, { timestamp: new Date(now - 16 * 60_000).toISOString() },
    { timestamp: new Date(now + 1).toISOString() }, { data: { ...event.data, activeExecutions: 0 } },
    { data: { ...event.data, fatal: true } }, { data: { ...event.data, conflict: true } },
    { data: { ...event.data, code: 4403 } },
  ]) assert.equal(executionDisconnect([{ ...event, ...patch }], sample, now), null);
  for (const name of ['runtime.ready', 'runtime.websocket.rejected', 'runtime.auth_required']) {
    const later = { ...event, timestamp: new Date(now).toISOString(), event: name };
    assert.equal(executionDisconnect([later, event], sample, now), null);
  }
  assert.equal(executionDisconnect([event], { ...sample, kind: 'healthy' }, now), null);
  assert.throws(() => executionDisconnect({}, sample), /Invalid/);
  assert.throws(() => executionDisconnect([{ ...event, timestamp: 'broken' }], sample), /timestamp/);
});
test('active execution 1006 never accelerates a destructive restart', () => {
  const config = { ...policy, intervalMs: 10, executionDisconnectMs: 20 };
  const sample = { ...failed, executionActivity: { state: 'active' },
    transportFailure: { code: 1006, activeExecutions: 1, closedAt: 0 } };
  let state = decide(base(), sample, 0, false, config);
  state = decide(state, sample, 10, false, config);
  assert.equal(state.action, 'observe');
  state = decide(state, sample, 20, false, config);
  assert.equal(state.action, 'observe');
  assert.equal(state.reason, 'execution_active');
  assert.equal(decide(state, { kind: 'healthy' }, 21, false, config).action, 'observe');
  assert.equal(decide(state, sample, 21, true, config).action, 'observe');
  assert.equal(decide({ ...state, retry: { attempts: 1, lastAttemptAt: 20, candidate: state.candidate } },
    sample, 30, false, config).reason, 'execution_active');
  const replaced = { ...sample, transportFailure: { ...sample.transportFailure, closedAt: 30 } };
  assert.equal(decide(state, replaced, 30, false, config).action, 'observe');
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
test('process death requires initial confirmation but old hourly limits and cooldown records have no effect', () => {
  const down = { kind: 'process_down', runtimeId: null, pid: null };
  assert.equal(advance(base(), down, 0, 120).action, 'recover');
  const s = advance({ ...base(), restarts: [0] }, failed, 0, 120);
  assert.equal(s.action, 'recover');
  const continued = advance({ ...base(), restarts: [0, 10, 20], lastEscalationAt: 1000 }, failed, 1000, 1120);
  assert.equal(continued.action, 'recover');
});
test('backoff grows from five seconds to one minute without overflow', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 100, Number.MAX_SAFE_INTEGER].map(n => retryDelay(n)),
    [5000, 10000, 20000, 40000, 60000, 60000, 60000, 60000]);
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
  await fs.writeFile(path.join(dir, 'dist/client.js'), `
    import fs from 'node:fs/promises';
    export function createClient() { return { space(spaceId) { return { sandbox: { async get() {
      const setup = JSON.parse(await fs.readFile(process.env.HOME + '/fixture.json', 'utf8'));
      if (spaceId !== setup.spaceId) throw new Error('Wrong Space');
      if (setup.remoteRecordFailure) throw new Error('Bearer PRIVATE_TOKEN');
      return { sandbox: setup.remoteRecord ?? null };
    } } }; } }; }
  `);
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: '@neta-art/cohub-cli', type: 'module', version: '10.0.0' }));
  await fs.mkdir(path.join(dir, 'dist/commands'), { recursive: true });
  for (const name of ['runtime', 'auth', 'run']) await fs.writeFile(path.join(dir, 'dist/commands', `${name}.js`), '');
  const inspected = await inspectCli(config.cli);
  await fs.writeFile(config.compatibilityFile, JSON.stringify({ schemaVersion: 1,
    reviewedVersion: inspected.version, fingerprint: inspected.fingerprint }));
  await fs.writeFile(path.join(home, 'fixture.json'), JSON.stringify({ identity: config.identity, spaceId: config.spaceId, worker: config.worker,
    root: rootOf(config), harnesses: config.harnesses }));
  const g = new Guard(config);
  const cli = g.cli.bind(g);
  g.cli = async (args, ...rest) => {
    if (args[1] === 'logs') await setFixture(g, { diagnosticNow: new Date(g.now()).toISOString() });
    return cli(args, ...rest);
  };
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

test('integration: active execution 1006 retains the actual worker without stop, replay or duplicate', async t => {
  const g = await fixture(t);
  g.config = { ...g.config, intervalMs: 10_000, executionDisconnectMs: 20, unhealthyMs: 120_000, graceMs: 30_000 };
  await g.cli(['runtime', 'up']);
  await setFixture(g, { stuck: true, activeExecutions: 2, disconnectAt: new Date().toISOString() });
  const sample = await g.probe();
  assert.equal(sample.transportFailure.code, 1006);
  assert.equal(sample.transportFailure.activeExecutions, 2);
  let state = decide(base(), sample, Date.now() - 25, false, g.config);
  state = await g.tick(state);
  assert.equal(state.reason, 'execution_active');
  assert.equal(state.lastRecovery, undefined);
  assert.equal((await g.probe()).pid, sample.pid);
  assert.ok(await g.processIdentity(sample.pid));
  // An old pending journal must not bypass execution protection.
  assert.equal(decide({ ...state, pendingRecovery: { sourcePid: sample.pid, sourceRuntimeId: sample.runtimeId,
    attempts: 1, lastAttemptAt: 0 } }, sample, Date.now(), false, g.config).reason, 'execution_active');
  const calls = (await fs.readFile(path.join(g.config.home, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(a => a[1] === 'down').length, 0);
  assert.equal(calls.filter(a => a[1] === 'up').length, 1);
  assert.ok(calls.every(a => !a.includes('prompt') && !a.includes('import')));
});

async function overdue(g) {
  const clock = Date.now();
  g.now = () => clock;
  const sample = await g.probe();
  const state = advance(base(), sample, clock - g.config.disconnectedMs,
    clock - g.config.intervalMs, false, g.config);
  return { sample, state };
}

for (const activeExecutions of [0, 2]) {
  test(`integration: sustained reconnecting restarts a real worker with ${activeExecutions} active executions`, async t => {
    const g = await fixture(t);
    await g.cli(['runtime', 'up']);
    await setFixture(g, { stuck: true, activeExecutions });
    const { sample, state } = await overdue(g);
    const recovered = await g.tick(state);
    assert.equal(recovered.reason, 'disconnect_timeout');
    assert.equal(recovered.lastRecovery.outcome, 'recovered');
    assert.equal(await g.processIdentity(sample.pid), null);
    assert.notEqual((await g.probe()).pid, sample.pid);
    const signals = (await fs.readFile(path.join(g.config.home, 'signals.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(signals, [{ pid: sample.pid, signal: 'SIGTERM' }]);
    assert.equal((await calls(g)).filter(a => a[1] === 'down').length, 0);
    assert.equal((await calls(g)).filter(a => a[1] === 'up').length, 2);
    assert.ok(!(await fs.readFile(g.logFile, 'utf8')).includes('forced_stop'));
  });
}

test('integration: overdue active worker gets SIGTERM then SIGKILL without signalling other workers', async t => {
  const g = await fixture(t);
  const other = await fixture(t);
  await other.cli(['runtime', 'up']);
  const otherPid = (await other.owner()).pid;
  await setFixture(g, { ignoreTerm: true });
  await g.cli(['runtime', 'up']);
  await setFixture(g, { stuck: true, activeExecutions: 2 });
  const { sample, state } = await overdue(g);
  const command = g.command.bind(g);
  g.command = (file, args, timeout) => args[0] === '-axo' ?
    Promise.resolve({ ok: true, stdout: `${otherPid} ${sample.pid}\n`, stderr: '' }) : command(file, args, timeout);
  const log = g.log.bind(g);
  g.log = async (event, data) => {
    await log(event, data);
    if (event === 'graceful_stop') await setFixture(g, { localState: 'stopping' });
  };
  const recovered = await g.tick(state);
  assert.equal(recovered.lastRecovery.outcome, 'recovered');
  assert.equal(await g.processIdentity(sample.pid), null);
  assert.ok(await other.processIdentity(otherPid));
  const events = (await fs.readFile(g.logFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.filter(e => ['graceful_stop', 'forced_stop'].includes(e.event)).map(e => e.signal),
    ['SIGTERM', 'SIGKILL']);
  assert.equal(events.find(e => e.event === 'forced_stop').childProcessesRetained, true);
  assert.deepEqual(JSON.parse((await fs.readFile(path.join(g.config.home, 'signals.jsonl'), 'utf8')).trim()),
    { pid: sample.pid, signal: 'SIGTERM' });
  await assert.rejects(fs.access(path.join(other.config.home, 'signals.jsonl')), { code: 'ENOENT' });
});

test('integration: heartbeat timeout evidence alone reaches recovery and healthy status resets its timer', async t => {
  const g = await fixture(t);
  await g.cli(['runtime', 'up']);
  const owner = await g.owner();
  let clock = Date.now();
  g.now = () => clock;
  await setFixture(g, { stuck: true, localState: 'ready', events: [{
    runtimeId: owner.runtimeId, timestamp: new Date(clock).toISOString(),
    event: 'runtime.heartbeat_timeout', data: { activeExecutions: 1, ageMs: 500_000 },
  }] });
  const sample = await g.probe();
  assert.equal(sample.heartbeatTimeoutAt, clock);
  const state = advance(base(), { ...sample, heartbeatTimeoutAt: clock - g.config.disconnectedMs },
    clock - g.config.disconnectedMs, clock - g.config.intervalMs, false, g.config);
  await setFixture(g, { stuck: false });
  const healthy = await g.tick(state);
  assert.equal(healthy.failureSince, null);
  assert.equal(healthy.action, 'observe');
  await setFixture(g, { stuck: true });
  const fresh = await g.tick(healthy);
  assert.equal(fresh.failureSince, clock);
  assert.equal(fresh.action, 'observe');
  let waiting = fresh;
  const began = clock;
  for (clock += g.config.intervalMs; clock < began + g.config.disconnectedMs; clock += g.config.intervalMs)
    waiting = decide(waiting, { ...sample, heartbeatTimeoutAt: clock }, clock, false, g.config);
  await setFixture(g, { events: [{ runtimeId: owner.runtimeId, timestamp: new Date(clock).toISOString(),
    event: 'runtime.heartbeat_timeout', data: { activeExecutions: 1, ageMs: 740_000 } }] });
  const recovered = await g.tick(waiting);
  assert.equal(recovered.lastRecovery.outcome, 'recovered');
  assert.equal(recovered.failureSince, null);
  assert.notEqual((await g.probe()).pid, owner.pid);
});

test('integration: recovery between probes revokes overdue signal authorization', async t => {
  const g = await fixture(t);
  await g.cli(['runtime', 'up']);
  await setFixture(g, { stuck: true, activeExecutions: 1 });
  const { sample, state } = await overdue(g);
  const authorized = decide(state, sample, g.now(), false, g.config);
  await setFixture(g, { events: [{ runtimeId: sample.runtimeId,
    timestamp: new Date(g.now()).toISOString(), event: 'runtime.ready' }] });
  const result = await g.recover(sample, undefined, null, undefined, authorized);
  assert.equal(result.outcome, 'skipped');
  assert.ok(await g.processIdentity(sample.pid));
  await assert.rejects(fs.access(path.join(g.config.home, 'signals.jsonl')), { code: 'ENOENT' });
});

test('integration: an interrupted overdue stop resumes without losing the deadline or double-counting recovery', async t => {
  const g = await fixture(t);
  await setFixture(g, { ignoreTerm: true });
  await g.cli(['runtime', 'up']);
  await setFixture(g, { stuck: true, activeExecutions: 1 });
  const { sample, state } = await overdue(g);
  const log = g.log.bind(g);
  g.log = async (event, data) => {
    await log(event, data);
    if (event === 'graceful_stop') {
      await setFixture(g, { localState: 'stopping' });
      throw new Error('Synthetic interruption after SIGTERM');
    }
  };
  const interrupted = await g.tick(state);
  assert.equal(interrupted.lastRecovery.outcome, 'failed');
  assert.equal(interrupted.pendingRecovery.trigger, 'disconnect_timeout');
  assert.equal(interrupted.pendingRecovery.phase, 'stopping');
  assert.ok(await g.processIdentity(sample.pid));
  const restarted = reopenGuard(g);
  restarted.now = () => interrupted.nextEligibleAt;
  const recovered = await restarted.tick(await restarted.loadState());
  assert.equal(recovered.lastRecovery.outcome, 'recovered');
  assert.equal(recovered.pendingRecovery, null);
  assert.equal(recovered.restarts.length, 1);
  assert.equal(await g.processIdentity(sample.pid), null);
  assert.equal((await calls(g)).filter(a => a[1] === 'up').length, 2);
});

for (const boundary of ['before_term', 'before_kill']) {
  test(`integration: dual-environment conflict ${boundary} blocks the next signal`, async t => {
    const g = await fixture(t);
    await setFixture(g, { ignoreTerm: true });
    await g.cli(['runtime', 'up']);
    await setFixture(g, { stuck: true, activeExecutions: 1 });
    const { sample, state } = await overdue(g);
    const conflict = async () => setFixture(g, {
      remote: { online: true, runtimeId: 'other-environment', workspace: { online: true } },
    });
    if (boundary === 'before_term') {
      const probe = g.probe.bind(g);
      let probes = 0;
      g.probe = async () => {
        if (++probes === 3) await conflict();
        return probe();
      };
    } else {
      const log = g.log.bind(g);
      g.log = async (event, data) => {
        await log(event, data);
        if (event === 'graceful_stop') await conflict();
      };
    }
    const result = await g.tick(state);
    assert.ok(['failed', 'deferred'].includes(result.lastRecovery.outcome));
    assert.ok(await g.processIdentity(sample.pid));
    assert.equal((await calls(g)).filter(a => a[1] === 'up').length, 1);
    assert.ok(!(await fs.readFile(g.logFile, 'utf8')).includes('forced_stop'));
    if (boundary === 'before_term')
      await assert.rejects(fs.access(path.join(g.config.home, 'signals.jsonl')), { code: 'ENOENT' });
  });
}

test('1006 evidence failure is visible and cannot authorize a fast restart', async t => {
  const g = await fixture(t);
  await g.cli(['runtime', 'up']);
  await setFixture(g, { stuck: true, events: {} });
  const sample = await g.probe();
  assert.match(sample.transportEvidenceError, /Invalid Runtime diagnostics/);
  assert.equal(sample.transportFailure, undefined);
  assert.equal(advance(base(), sample, 0, 90).action, 'observe');
});

test('recovery refuses to stop a worker after execution evidence disappears', async t => {
  const g = await fixture(t);
  await g.cli(['runtime', 'up']);
  await setFixture(g, { stuck: true, disconnectAt: new Date().toISOString() });
  const sample = await g.probe();
  assert.equal(sample.executionActivity.state, 'idle');
  await setFixture(g, { events: [] });
  assert.deepEqual(await g.recover(sample), {
    outcome: 'skipped', reason: 'execution_activity_unknown',
  });
  assert.equal((await g.probe()).pid, sample.pid);
  const calls = (await fs.readFile(path.join(g.config.home, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(a => a[1] === 'down').length, 0);
});

test('activity appearing immediately before down prevents the actual stop command', async t => {
  const g = await fixture(t);
  await g.cli(['runtime', 'up']);
  await setFixture(g, { stuck: true });
  const sample = await g.probe();
  const cli = g.cli.bind(g);
  g.cli = async (args, ...rest) => {
    if (args[1] === 'down') await setFixture(g, { activeExecutions: 1 });
    return cli(args, ...rest);
  };
  await assert.rejects(g.recover(sample), /Execution safety changed before stop/);
  assert.ok(await g.processIdentity(sample.pid));
  assert.equal((await calls(g)).filter(a => a[1] === 'down').length, 0);
});

test('unknown diagnostics remain non-destructive beyond the generic deadline', async t => {
  const g = await fixture(t);
  await g.cli(['runtime', 'up']);
  const pid = (await g.owner()).pid;
  await setFixture(g, { stuck: true, events: [] });
  g.config = { ...g.config, unhealthyMs: 0 };
  const state = await g.tick(base());
  assert.equal(state.reason, 'execution_activity_unknown');
  assert.ok(await g.processIdentity(pid));
  assert.equal((await calls(g)).filter(a => a[1] === 'down').length, 0);
});

test('activity discovered after a refused graceful stop prevents forced termination', async t => {
  const g = await fixture(t);
  await g.cli(['runtime', 'up']);
  await setFixture(g, { stuck: true, refuseStop: true });
  const sample = await g.probe();
  const cli = g.cli.bind(g);
  g.cli = async (args, ...rest) => {
    const result = await cli(args, ...rest);
    if (args[1] === 'down') await setFixture(g, { activeExecutions: 1 });
    return result;
  };
  await assert.rejects(g.recover(sample), /Execution safety unknown before forced stop/);
  assert.ok(await g.processIdentity(sample.pid));
  assert.equal((await calls(g)).filter(a => a[1] === 'up').length, 1);
});

test('schema 2 accepts verified versions by contract but rejects tampering and version relabeling', async t => {
  const g = await fixture(t);
  const baseline = { ...await readJson(g.config.compatibilityFile), schemaVersion: 2,
    contract: { id: CLI_CONTRACT, passed: true, checkedAt: new Date().toISOString(), activeExecution1006: 'waits_for_execution' } };
  await fs.writeFile(g.config.compatibilityFile, JSON.stringify(baseline));
  assert.equal((await g.checkCompatibility()).verification.id, CLI_CONTRACT);
  for (const change of [
    { reviewedVersion: '10.6.0' },
    { contract: { ...baseline.contract, passed: false } },
    { contract: { ...baseline.contract, activeExecution1006: 'unknown' } },
  ]) {
    await fs.writeFile(g.config.compatibilityFile, JSON.stringify({ ...baseline, ...change }));
    await assert.rejects(g.checkCompatibility());
  }
});

test('legacy layout retains existing pause, audit history and singleton lock', async t => {
  const g = await fixture(t);
  const legacy = new Guard({ ...g.config, stateLayout: 'legacy-zh' });
  await legacy.init();
  assert.equal(path.basename(legacy.stateFile), '状态.json');
  assert.equal(path.basename(legacy.controlFile), '控制.json');
  assert.equal(path.basename(legacy.logFile), '事件.jsonl');
  assert.throws(() => stateNames('unknown'), /stateLayout/);
  await fs.writeFile(legacy.controlFile, JSON.stringify({ version: 1, paused: true }));
  await legacy.save({ ...base(), restarts: [Date.now()] });
  assert.equal(await legacy.paused(), true);
  assert.equal((await legacy.loadState()).restarts.length, 1);
  const unlock = await acquireLock(g.config.directory, 'legacy-zh');
  try { await assert.rejects(acquireLock(g.config.directory, 'legacy-zh'), /already running/); }
  finally { await unlock(); }
});

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
test('explicit shared mode preserves consent on recovery', async t => {
  assert.equal(CONFIG.codexShared, false);
  assert.equal(TARGETS['pi-only'].codexShared, false);
  const g = await fixture(t);
  g.config = { ...g.config, codexShared: true };
  const consent = { ...await readJson(g.nativeFile), codexShared: true };
  await fs.writeFile(g.nativeFile, JSON.stringify(consent));
  g.sharedServer = async () => ({ state: 'running' });
  await g.preflight();
  assert.equal((await g.recover(await g.probe())).outcome, 'recovered');
  assert.deepEqual(await readJson(g.nativeFile), consent);
  const calls = await fs.readFile(path.join(g.config.home, 'calls.jsonl'), 'utf8');
  assert.ok(!calls.includes('"daemon"') && !calls.includes('"import"'));
  await fs.writeFile(g.nativeFile, JSON.stringify({ ...consent, codexShared: false }));
  await assert.rejects(g.preflight(), /configuration changed/);
});
test('shared daemon absence is confirmed before recovery; repair never stops the Runtime or daemon', async t => {
  const g = await fixture(t);
  g.config = { ...g.config, codexShared: true };
  await fs.writeFile(g.nativeFile, JSON.stringify({ ...await readJson(g.nativeFile), codexShared: true }));
  await g.cli(['runtime', 'up']);
  let running = false;
  g.sharedServer = async () => ({ state: running ? 'running' : 'absent' });
  const command = g.command.bind(g);
  const daemonCalls = [];
  g.command = async (file, args, timeout) => {
    if (file !== g.config.codex) return command(file, args, timeout);
    daemonCalls.push(args);
    running = true;
    return { ok: true, code: 0, stdout: '', stderr: '' };
  };
  const before = await g.probe();
  assert.equal(before.kind, 'shared_server_down');
  assert.equal(advance(base(), before, 0, 90).action, 'observe');
  assert.equal(advance(base(), before, 0, 120).action, 'recover');
  const result = await g.recover(before);
  assert.equal(result.outcome, 'recovered');
  assert.equal((await g.probe()).pid, before.pid);
  assert.deepEqual(daemonCalls, [['app-server', 'daemon', 'start']]);
  assert.ok(!(await fs.readFile(path.join(g.config.home, 'calls.jsonl'), 'utf8')).includes('"down"'));
});
test('shared daemon invalid socket never authorizes restart', async t => {
  const g = await fixture(t);
  g.config = { ...g.config, codexShared: true };
  await g.cli(['runtime', 'up']);
  const socket = path.join(g.config.home, '.codex/app-server-control/app-server-control.sock');
  await fs.mkdir(path.dirname(socket), { recursive: true });
  await fs.writeFile(socket, 'not a socket');
  await assert.rejects(g.sharedServer(), /socket/);
  const state = await g.tick(base());
  assert.equal(state.sample.kind, 'probe_error');
  assert.equal(state.action, 'observe');
  assert.ok(!(await fs.readFile(path.join(g.config.home, 'calls.jsonl'), 'utf8')).includes('"down"'));
});
test('shared daemon probe checks a real socket and rejects failed or malformed version replies', async t => {
  const g = await fixture(t);
  assert.deepEqual(await g.sharedServer(), { state: 'absent' });
  const socket = path.join(g.config.home, '.codex/app-server-control/app-server-control.sock');
  await fs.mkdir(path.dirname(socket), { recursive: true });
  const server = createServer(client => client.end());
  const actualSocket = path.join(g.config.home, 'actual.sock');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(actualSocket, resolve); });
  await fs.symlink(actualSocket, socket);
  t.after(() => new Promise(resolve => server.close(resolve)));
  g.command = async (file, args) => {
    assert.equal(file, g.config.codex);
    assert.deepEqual(args, ['app-server', 'daemon', 'version']);
    return { ok: true, stdout: JSON.stringify({ status: 'running', socketPath: socket, appServerVersion: '0.163.0' }) };
  };
  assert.deepEqual(await g.sharedServer(), { state: 'running', version: '0.163.0' });
  g.command = async () => ({ ok: false, code: 1, stderr: 'permission denied' });
  await assert.rejects(g.sharedServer(), /permission denied/);
  g.command = async () => ({ ok: true, stdout: '{}' });
  await assert.rejects(g.sharedServer(), /Invalid Codex/);
  g.command = async () => ({ ok: true, stdout: '{broken' });
  await assert.rejects(g.sharedServer(), SyntaxError);
});
test('shared daemon startup failure is retained and pause prevents any repair', async t => {
  const g = await fixture(t);
  g.config = { ...g.config, codexShared: true };
  await fs.writeFile(g.nativeFile, JSON.stringify({ ...await readJson(g.nativeFile), codexShared: true }));
  await g.cli(['runtime', 'up']);
  g.sharedServer = async () => ({ state: 'absent' });
  const command = g.command.bind(g);
  let starts = 0;
  g.command = async (file, args, timeout) => {
    if (file !== g.config.codex) return command(file, args, timeout);
    starts++;
    return { ok: false, code: 1, stderr: 'daemon locked' };
  };
  const before = await g.probe();
  await assert.rejects(g.recover(before), /start failed/);
  assert.equal((await g.probe()).pid, before.pid);
  await fs.writeFile(g.controlFile, JSON.stringify({ version: 1, paused: true }));
  assert.equal((await g.recover(before)).reason, 'paused');
  assert.equal(starts, 1);
  assert.ok(!(await fs.readFile(path.join(g.config.home, 'calls.jsonl'), 'utf8')).includes('"down"'));
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
test('tick records failures, bounded incident logs, operation history and successful healing', async t => {
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

test('compatibility monitoring does not execute an unreviewed CLI or record a recovery operation', async t => {
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
  assert.equal(loaded.codexShared, false);
  assert.equal(loaded.disconnectedMs, 240_000);
  await fs.writeFile(file, JSON.stringify({ ...input, disconnectedMs: 180_000 }));
  assert.equal((await loadConfig(file)).disconnectedMs, 180_000);
  const retired = { cooldownMs: 600000, maxRestartsPerHour: 3, resumeRetryMs: 30000,
    maxResumeAttempts: 3, escalationIntervalMs: 900000, staleHeartbeatMs: 120000 };
  await fs.writeFile(file, JSON.stringify({ ...input, ...retired }));
  const migrated = await loadConfig(file);
  for (const field of Object.keys(retired)) assert.equal(Object.hasOwn(migrated, field), false);
  assert.equal(migrated.retryBaseMs, 5000);
  assert.equal(migrated.retryMaxMs, 60000);
  await fs.writeFile(file, JSON.stringify({ ...input, codexShared: true }));
  assert.equal((await loadConfig(file)).codexShared, true);
  await assert.rejects(loadConfig(), /explicit --config/);
  for (const patch of [{ spaceId: CONFIG.spaceId }, { identity: CONFIG.identity }, { root: '~/workspace' },
    { recoveryCli: input.cli }, { harnesses: ['codex', 'codex'] }, { typo: true }, { shareScreen: 'false' }, { graceMs: 0 },
    { codexShared: 'true' }, { codexShared: true, harnesses: ['pi'] },
    { retryBaseMs: 0 }, { retryMaxMs: 60001 }, { retryBaseMs: 5000, retryMaxMs: 1000 },
    ...[0, -1, '240000', null, 1.5].map(disconnectedMs => ({ disconnectedMs })),
    { cooldownMs: 'broken' }]) {
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
  await setFixture(g, { stuck: true, localState: 'ready' });
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

const disconnectedRecord = now => ({
  provider: 'local', status: 'stopped', runtimeStatus: 'stopped',
  stopReason: 'disconnected', lastHeartbeatAt: new Date(now - 180_000).toISOString(),
});
const staleOffline = now => ({
  ...failed, online: false, remoteRuntimeId: 'runtime-a', remoteWorkspaceOnline: false,
  remoteRecord: disconnectedRecord(now),
});

test('remote instance identity and observation time survive status projection', () => {
  const raw = rawStatus();
  raw.remote.observedAt = '2026-10-20T09:35:00.000Z';
  const sample = summarizeStatus(raw);
  assert.equal(sample.remoteRuntimeId, 'runtime-a');
  assert.equal(sample.remoteWorkspaceOnline, true);
  assert.equal(sample.remoteObservedAt, raw.remote.observedAt);
  raw.remote.online = false;
  raw.remote.runtimeId = 42;
  assert.throws(() => summarizeStatus(raw), /remote Runtime/);
});

test('10-20: a stopped worker retries its own stale lease under the same recovery operation', async t => {
  const g = await fixture(t);
  let clock = Date.now();
  g.now = () => clock;
  g.config = { ...g.config, unhealthyMs: 0, graceMs: 30_000 };
  g.remoteRecord = async () => null;
  await g.cli(['runtime', 'up']);
  await setFixture(g, { stuck: true, localState: 'ready' });
  const old = await g.probe();
  const invoke = g.cli.bind(g);
  g.cli = async (args, timeout, beforeExecute) => {
    const result = await invoke(args, timeout, beforeExecute);
    if (args[1] === 'down') await setFixture(g, {
      remote: { online: true, runtimeId: old.runtimeId, workspace: { online: false } },
    });
    return result;
  };
  let state = await g.tick(base());
  assert.equal(state.pendingRecovery.phase, 'starting');
  assert.equal(state.restarts.length, 1);
  assert.equal(state.lastRecovery.outcome, 'failed');
  const operationId = state.pendingRecovery.id;
  state = await g.tick(await g.loadState());
  assert.equal(state.reason, 'retry_backoff');
  assert.equal(state.pendingRecovery.id, operationId);
  clock = state.nextEligibleAt;
  state = await g.tick(await g.loadState());
  assert.equal(state.lastRecovery.outcome, 'failed');
  assert.equal(state.pendingRecovery.attempts, 2);
  assert.equal(state.pendingRecovery.id, operationId);
  await setFixture(g, { remote: null });
  clock = state.nextEligibleAt;
  state = await g.tick(state);
  assert.equal(state.lastRecovery.outcome, 'recovered');
  assert.equal(state.restarts.length, 1);
  assert.equal(state.pendingRecovery, null);
  assert.equal((await calls(g)).filter(a => a[1] === 'down').length, 1);
  assert.equal((await calls(g)).filter(a => a[1] === 'up').length, 4);
});

test('10-20: old exhausted budgets do not prevent a confirmed idle runtime recovery', () => {
  const now = Date.parse('2026-10-20T09:35:37Z');
  const restarts = ['08:56:25.321', '09:10:03.193', '09:20:18.574'].map(s => Date.parse(`2026-10-20T${s}Z`));
  const sample = staleOffline(now);
  const first = advance({ ...base(), restarts }, sample, now - CONFIG.unhealthyMs, now - CONFIG.intervalMs, false, CONFIG);
  const state = decide(first, sample, now, false, CONFIG);
  assert.equal(state.action, 'recover');
  assert.equal(state.reason, 'connection_stuck');
  const again = decide({ ...state, lastEscalationAt: now }, sample, now + 10_000, false, CONFIG);
  assert.equal(again.action, 'recover');
  for (const patch of [
    { remoteRecord: null },
    { remoteRecord: { ...sample.remoteRecord, lastHeartbeatAt: new Date(now).toISOString() } },
    { remoteRecord: { ...sample.remoteRecord, lastHeartbeatAt: 'broken' } },
    { remoteRecord: { ...sample.remoteRecord, lastHeartbeatAt: null } },
    { remoteRecord: { ...sample.remoteRecord, lastHeartbeatAt: new Date(now + 1000).toISOString() } },
  ]) assert.equal(decide(first, { ...sample, ...patch }, now, false, CONFIG).action, 'recover');
  assert.equal(decide(first, { ...sample, kind: 'another_runtime', remoteRuntimeId: 'genuine-other' },
    now, false, CONFIG).action, 'observe');
});

const reopenGuard = g => Object.assign(new Guard(g.config), {
  systemProxyReader: g.systemProxyReader, networkSourceEnv: {}, proxyProbe: g.proxyProbe,
  network: g.network, now: g.now, notify: () => {},
});

test('remote lifecycle probe uses the reviewed client, projects only safe fields and exposes failures', async t => {
  const g = await fixture(t);
  const now = Date.now();
  const record = { ...disconnectedRecord(now), meta: { token: 'PRIVATE_TOKEN' }, secret: 'PRIVATE_SECRET' };
  await setFixture(g, { remoteRecord: record });
  assert.deepEqual(await g.remoteRecord(), disconnectedRecord(now));
  assert.equal((await g.probe()).remoteRecord.lastHeartbeatAt, record.lastHeartbeatAt);
  await setFixture(g, { remoteRecord: { ...record, lastHeartbeatAt: 42 } });
  assert.match((await g.probe()).remoteEvidenceError, /lifecycle probe failed/);
  await setFixture(g, { remoteRecordFailure: true });
  const sample = await g.probe();
  assert.equal(sample.kind, 'process_down');
  assert.equal(sample.remoteRecord, undefined);
  assert.ok(!JSON.stringify(sample).includes('PRIVATE_TOKEN'));
});

test('pending stop survives a guard interruption and completion is charged once', async t => {
  const g = await fixture(t);
  g.config = { ...g.config, unhealthyMs: 0, graceMs: 30_000 };
  let clock = Date.now();
  g.now = () => clock;
  await g.cli(['runtime', 'up']);
  await setFixture(g, { stuck: true, localState: 'ready' });
  const invoke = g.cli.bind(g);
  g.cli = async (args, timeout, beforeExecute) => {
    const result = await invoke(args, timeout, beforeExecute);
    if (args[1] === 'down') throw new Error('Simulated guard interruption after stop');
    return result;
  };
  let state = await g.tick(base());
  assert.equal(state.pendingRecovery.phase, 'stopping');
  const id = state.pendingRecovery.id;
  assert.equal(await g.processIdentity(state.pendingRecovery.sourcePid), null);
  const restarted = reopenGuard(g);
  clock = state.nextEligibleAt;
  state = await restarted.tick(await restarted.loadState());
  assert.equal(state.lastRecovery.outcome, 'recovered');
  assert.equal(state.lastRecovery.operationId, id);
  assert.equal(state.pendingRecovery, null);
  assert.equal(state.restarts.length, 1);
  assert.equal((await calls(g)).filter(a => a[1] === 'down').length, 1);
  assert.equal((await calls(g)).filter(a => a[1] === 'up').length, 2);
});

test('a real competing remote instance is never replaced, even during a pending recovery', async t => {
  const g = await fixture(t);
  g.config = { ...g.config, unhealthyMs: 0, graceMs: 30_000 };
  g.notify = () => {};
  await g.cli(['runtime', 'up']);
  await setFixture(g, { stuck: true, localState: 'ready' });
  const invoke = g.cli.bind(g);
  g.cli = async (args, timeout, beforeExecute) => {
    const result = await invoke(args, timeout, beforeExecute);
    if (args[1] === 'down') await setFixture(g, { remote: {
      online: true, runtimeId: 'genuine-competitor', workspace: { online: true },
    } });
    return result;
  };
  let state = await g.tick(base());
  assert.equal(state.lastRecovery.reason, 'recovery_conflict');
  state = await g.tick(await g.loadState());
  assert.equal(state.reason, 'recovery_conflict');
  assert.equal(state.restarts.length, 1);
  assert.equal((await calls(g)).filter(a => a[1] === 'up').length, 1);
  const events = (await fs.readFile(g.logFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.find(e => e.event === 'startup_probe').sample.remoteRuntimeId, 'genuine-competitor');
});

test('pending recovery retains scope and process identity checks across restarts', async t => {
  const g = await fixture(t);
  g.config = { ...g.config, unhealthyMs: 0, graceMs: 30_000 };
  await g.cli(['runtime', 'up']);
  await setFixture(g, { stuck: true, localState: 'ready' });
  const invoke = g.cli.bind(g);
  g.cli = async (args, timeout, beforeExecute) => {
    if (args[1] === 'down') {
      await beforeExecute();
      throw new Error('Synthetic interruption before stop');
    }
    return invoke(args, timeout, beforeExecute);
  };
  let state = await g.tick(base());
  const old = await g.owner();
  const restarted = reopenGuard(g);
  restarted.now = () => state.pendingRecovery.nextAttemptAt;
  await fs.writeFile(g.ownerFile, JSON.stringify({ ...old, nonce: 'changed-owner' }));
  state = await restarted.tick(await restarted.loadState());
  assert.match(state.lastRecovery.error, /process identity changed/);
  assert.ok(await g.processIdentity(old.pid));
  assert.equal((await calls(g)).filter(a => a[1] === 'down').length, 0);
  const wrongScope = reopenGuard(g);
  wrongScope.config = { ...wrongScope.config, spaceId: 'another-space' };
  const preserved = await fs.readFile(g.stateFile, 'utf8');
  await assert.rejects(wrongScope.tick(await wrongScope.loadState()), /scope changed/);
  assert.equal(await fs.readFile(g.stateFile, 'utf8'), preserved);
});

test('pause, unavailable proxy and failed consent preserve the pending operation without mutation', async t => {
  const g = await fixture(t);
  let clock = Date.now();
  g.now = () => clock;
  g.config = { ...g.config, unhealthyMs: 0 };
  await setFixture(g, { failStart: true });
  let state = await g.tick(base());
  const pendingId = state.pendingRecovery.id;
  clock = state.nextEligibleAt;
  await fs.writeFile(g.controlFile, JSON.stringify({ version: 1, paused: true }));
  state = await g.tick(state);
  assert.equal(state.reason, 'paused');
  await fs.writeFile(g.controlFile, JSON.stringify({ version: 1, paused: false }));
  g.networkSourceEnv = { HTTPS_PROXY: 'http://127.0.0.1:7893' };
  g.proxyProbe = async endpoint => ({ ...endpoint, ok: false, code: 'proxy_refused' });
  state = await g.tick(state);
  assert.equal(state.reason, 'proxy_refused');
  g.networkSourceEnv = {};
  const consent = await readJson(g.nativeFile);
  await fs.writeFile(g.nativeFile, JSON.stringify({ ...consent, enabledAt: null }));
  state = await g.tick(state);
  assert.equal(state.lastRecovery.outcome, 'deferred');
  assert.equal(state.pendingRecovery.id, pendingId);
  assert.equal(state.pendingRecovery.attempts, 1);
  assert.equal(state.restarts.length, 1);
  assert.equal((await calls(g)).filter(a => a[1] === 'up').length, 1);
});

test('failed starts keep retrying for over an hour across guard restarts with a one-minute ceiling', async t => {
  const g = await fixture(t);
  let clock = Date.now();
  g.now = () => clock;
  g.notify = () => {};
  g.config = { ...g.config, unhealthyMs: 0 };
  // No stale-heartbeat proof is required to continue an already confirmed outage.
  g.remoteRecord = async () => null;
  await setFixture(g, { failStart: true });
  const began = clock;
  let state = await g.tick(base());
  const id = state.pendingRecovery.id;
  for (let attempt = 2; attempt <= 67; attempt++) {
    const deadline = state.nextEligibleAt;
    assert.equal(deadline - clock, retryDelay(attempt - 1));
    if (attempt <= 7) {
      clock = deadline - 1;
      state = await g.tick(await g.loadState());
      assert.equal(state.action, 'observe');
      assert.equal(state.reason, 'retry_backoff');
      assert.equal(state.pendingRecovery.attempts, attempt - 1);
    }
    clock = deadline;
    const runner = attempt % 10 === 0 ? reopenGuard(g) : g;
    state = await runner.tick(await runner.loadState());
    assert.equal(state.lastRecovery.outcome, 'failed');
    assert.equal(state.pendingRecovery.attempts, attempt);
    assert.equal(state.pendingRecovery.id, id);
    assert.equal(state.nextEligibleAt - clock, retryDelay(attempt));
  }
  assert.ok(clock - began > 3_600_000);
  assert.equal((await calls(g)).filter(a => a[1] === 'up').length, 67);
  assert.equal(state.restarts.length, 1);
  await setFixture(g, { failStart: false });
  clock = state.nextEligibleAt;
  state = await reopenGuard(g).tick(await g.loadState());
  assert.equal(state.lastRecovery.outcome, 'recovered');
  assert.equal(state.retry, null);
  assert.equal(state.pendingRecovery, null);
  assert.equal(state.nextEligibleAt, null);
  assert.equal((await calls(g)).filter(a => a[1] === 'up').length, 68);
});

test('legacy pending escalation deadlines are replaced by short retries without discarding the journal', async t => {
  const g = await fixture(t);
  let clock = Date.now();
  g.now = () => clock;
  g.config = { ...g.config, unhealthyMs: 0 };
  await setFixture(g, { failStart: true });
  const state = await g.tick(base());
  const id = state.pendingRecovery.id;
  delete state.retry;
  state.lastEscalationAt = clock;
  Object.assign(state.pendingRecovery, { mode: 'escalated', attempts: 8,
    lastAttemptAt: clock, nextAttemptAt: clock + 900_000 });
  await g.save(state);
  const restarted = reopenGuard(g);
  clock += 59_999;
  let after = await restarted.tick(await restarted.loadState());
  assert.equal(after.reason, 'retry_backoff');
  assert.equal(after.nextEligibleAt, clock + 1);
  clock++;
  after = await restarted.tick(await restarted.loadState());
  assert.equal(after.lastRecovery.outcome, 'failed');
  assert.equal(after.pendingRecovery.id, id);
  assert.equal(after.pendingRecovery.attempts, 9);
  assert.equal(after.nextEligibleAt, clock + 60_000);
  assert.equal((await calls(g)).filter(a => a[1] === 'up').length, 2);
});

test('slow recovery failures without a pending start use completion-based backoff, not another confirmation window', async t => {
  const g = await fixture(t);
  let clock = Date.now();
  g.now = () => clock;
  const attempts = [];
  g.recover = async () => {
    attempts.push(clock);
    clock += 120_000;
    throw new Error('Synthetic slow failure before a mutating command');
  };
  let state = await g.tick({ ...base(), checkedAt: clock, candidate: 'process_down:absent',
    failureSince: clock - CONFIG.unhealthyMs });
  assert.equal(state.lastRecovery.outcome, 'deferred');
  assert.equal(state.nextEligibleAt, clock + 5000);
  assert.equal(state.pendingRecovery, undefined);
  const restarted = reopenGuard(g);
  restarted.recover = g.recover;
  clock = state.nextEligibleAt - 1;
  state = await restarted.tick(await restarted.loadState());
  assert.equal(state.reason, 'retry_backoff');
  assert.equal(attempts.length, 1);
  clock++;
  state = await restarted.tick(await restarted.loadState());
  assert.equal(attempts.length, 2);
  assert.equal(state.retry.attempts, 2);
  assert.equal(state.nextEligibleAt, clock + 10_000);
  assert.ok((await calls(g)).every(a => !['up', 'down'].includes(a[1])));
});

test('retry rechecks actual instance identity before any destructive command', async t => {
  const g = await fixture(t);
  const now = Date.now();
  g.now = () => now;
  g.config = { ...g.config, unhealthyMs: 0 };
  const old = staleOffline(now);
  const state = { ...base(), restarts: [now - 2_000_000, now - 1_500_000, now - 1_000_000] };
  let count = 0;
  g.probe = async () => ++count === 1 ? old : {
    ...old, kind: 'another_runtime', remoteRuntimeId: 'genuine-competitor',
  };
  const after = await g.tick(state);
  assert.equal(after.lastRecovery.outcome, 'skipped');
  assert.match(after.lastRecovery.reason, /Runtime changed/);
  assert.deepEqual(after.restarts, state.restarts);
  assert.equal(after.lastEscalationAt, undefined);
  assert.ok((await calls(g)).every(a => !['down', 'up'].includes(a[1])));
});

test('successful recovery ignores legacy limits and clears backoff before a subsequent outage', async t => {
  const g = await fixture(t);
  let clock = Date.now();
  g.now = () => clock;
  g.config = { ...g.config, unhealthyMs: 0, graceMs: 30_000 };
  await g.cli(['runtime', 'up']);
  await setFixture(g, { stuck: true, localState: 'ready', remoteRecord: disconnectedRecord(clock) });
  const before = await g.probe();
  let state = await g.tick({ ...base(), restarts: [clock - 2_000_000, clock - 1_500_000, clock - 1_000_000],
    lastEscalationAt: clock });
  assert.equal(state.lastRecovery.mode, 'normal');
  assert.equal(state.lastRecovery.outcome, 'recovered');
  assert.equal(state.restarts.length, 4);
  assert.equal(state.retry, null);
  assert.equal(await g.processIdentity(before.pid), null);
  await setFixture(g, { stuck: true });
  clock += CONFIG.retryBaseMs;
  state = await reopenGuard(g).tick(await g.loadState());
  assert.equal(state.action, 'recover');
  assert.equal(state.lastRecovery.outcome, 'recovered');
  assert.equal((await calls(g)).filter(a => a[1] === 'down').length, 2);
});

test('a successful startup followed by an unavailable probe does not cause a duplicate startup', async t => {
  const g = await fixture(t);
  g.config = { ...g.config, unhealthyMs: 0 };
  const invoke = g.cli.bind(g);
  const probe = g.probe.bind(g);
  let started = false;
  g.cli = async (args, timeout, beforeExecute) => {
    const result = await invoke(args, timeout, beforeExecute);
    if (args[1] === 'up') started = true;
    return result;
  };
  g.probe = async () => {
    if (started) throw new Error('Synthetic post-start status timeout');
    return probe();
  };
  let state = await g.tick(base());
  assert.equal(state.pendingRecovery.phase, 'starting');
  state = await reopenGuard(g).tick(await g.loadState());
  assert.equal(state.pendingRecovery, null);
  assert.equal(state.lastRecovery.outcome, 'observed_healthy');
  assert.equal(state.restarts.length, 1);
  assert.equal((await calls(g)).filter(a => a[1] === 'up').length, 1);
});

test('malformed recovery journals and retry records are retained', async t => {
  const g = await fixture(t);
  for (const bad of [
    { pendingRecovery: { phase: 'awaiting_start' } },
    { lastEscalationAt: 'yesterday' },
    { lastNotice: { key: 'recovery_conflict', at: null } },
    { retry: { attempts: -1, lastAttemptAt: 0, candidate: 'process_down:absent' } },
    { retry: { attempts: 1, lastAttemptAt: 'broken', candidate: 'process_down:absent' } },
    { retry: { attempts: 1, lastAttemptAt: 0 } },
  ]) {
    const text = JSON.stringify({ ...base(), ...bad });
    await fs.writeFile(g.stateFile, text);
    await assert.rejects(g.loadState(), /Invalid recovery journal/);
    assert.equal(await fs.readFile(g.stateFile, 'utf8'), text);
  }
});

test('instance conflict notices survive restarts without notifying on every poll', async t => {
  const g = await fixture(t);
  let clock = Date.now();
  g.now = () => clock;
  g.config = { ...g.config, unhealthyMs: 0 };
  const sample = { kind: 'another_runtime', pid: null, runtimeId: null,
    online: true, remoteRuntimeId: 'genuine-competitor', remoteWorkspaceOnline: true };
  g.probe = async () => sample;
  const notices = [];
  g.notify = n => notices.push(n);
  let state = await g.tick({ ...base(), restarts: [clock - 2_000_000, clock - 1_500_000, clock - 1_000_000] });
  assert.equal(state.reason, 'another_runtime');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].nextEligibleAt, null);
  assert.equal(notices[0].remoteRuntimeId, 'genuine-competitor');
  clock += CONFIG.intervalMs;
  const restarted = reopenGuard(g);
  restarted.probe = g.probe;
  restarted.notify = g.notify;
  state = await restarted.tick(await restarted.loadState());
  assert.equal(notices.length, 1);
  clock += 60_000;
  state = await restarted.tick(await restarted.loadState());
  assert.equal(notices.length, 2);
  assert.ok((await calls(g)).every(a => !['up', 'down'].includes(a[1])));
});

test('10-20 timeline replay: active work is retained and confirmed idle recovery still works', () => {
  const at = time => Date.parse(`2026-10-20T${time}+08:00`);
  let state = base();
  const sample = { ...failed, executionActivity: { state: 'active' },
    transportFailure: { code: 1006, activeExecutions: 1, closedAt: at('16:55:41') } };
  state = advance(state, sample, at('16:55:53'), at('16:56:13'), false, CONFIG);
  assert.equal(state.action, 'observe');
  assert.equal(state.reason, 'execution_active');
  state = { ...state, restarts: [at('16:56:25')], pendingRecovery: null };
  state = decide(state, { kind: 'healthy' }, at('16:56:42'), false, CONFIG);
  const bridgeLost = { ...failed, pid: 301, runtimeId: 'runtime-b' };
  state = advance(state, bridgeLost, at('17:07:47'), at('17:09:57'), false, CONFIG);
  assert.equal(state.action, 'recover');
  // The integration test above exercises the real stop/old-lease/resume sequence.
  state.restarts.push(at('17:10:03'));
  state = decide(state, { kind: 'healthy' }, at('17:10:30'), false, CONFIG);
  assert.equal(state.restarts.length, 2);
  const latest = { ...sample, pid: 302, runtimeId: 'runtime-c',
    transportFailure: { code: 1006, activeExecutions: 1, closedAt: at('17:35:05') } };
  state = advance(state, latest, at('17:35:13'), at('17:35:33'), false, CONFIG);
  assert.equal(state.action, 'observe');
  assert.equal(state.reason, 'execution_active');
});

test('18:20 regression: a defunct ps command after forced stop does not abort replacement startup', async t => {
  const g = await fixture(t);
  await g.cli(['runtime', 'up']);
  await setFixture(g, { stuck: true, refuseStop: true });
  const sample = await g.probe();
  const command = g.command.bind(g);
  const log = g.log.bind(g);
  let killed = false, zombieObserved = false;
  g.log = async (event, data) => {
    await log(event, data);
    if (event === 'forced_stop') killed = true;
  };
  g.command = async (file, args, timeout) => {
    if (killed && !zombieObserved && file === '/bin/ps' && args[1] === String(sample.pid)) {
      if (args.at(-1) === 'stat=') {
        zombieObserved = true;
        return { ok: true, stdout: 'Z\n', stderr: '', code: 0 };
      }
      return { ok: true, stdout: `${process.getuid()} Tue Oct 20 18:00:00 2026 <defunct>\n`, stderr: '', code: 0 };
    }
    return command(file, args, timeout);
  };
  const result = await g.recover(sample);
  assert.equal(zombieObserved, true);
  assert.equal(result.outcome, 'recovered');
  assert.notEqual(result.pid, sample.pid);
  assert.equal((await calls(g)).filter(a => a[1] === 'up').length, 2);
});

test('18:20 regression: a verified replacement appearing after kill is adopted, not killed or duplicated', async t => {
  const g = await fixture(t);
  await g.cli(['runtime', 'up']);
  await setFixture(g, { stuck: true, refuseStop: true });
  const sample = await g.probe();
  const log = g.log.bind(g);
  let replacementPid;
  g.log = async (event, data) => {
    await log(event, data);
    if (event === 'forced_stop') {
      for (let n = 0; n < 100 && await g.processIdentity(sample.pid); n++)
        await new Promise(r => setTimeout(r, 10));
      await g.cli(['runtime', 'up']);
      replacementPid = (await g.owner()).pid;
    }
  };
  const result = await g.recover(sample);
  assert.equal(result.outcome, 'recovered');
  assert.equal(result.reason, 'replacement_adopted');
  assert.equal(result.pid, replacementPid);
  assert.ok(await g.processIdentity(replacementPid));
  assert.equal((await calls(g)).filter(a => a[1] === 'up').length, 2);
});

test('post-kill identity rechecks distinguish reused PIDs from inspection failures', async t => {
  const g = await fixture(t);
  g.command = async (_file, args) => ({ ok: true, code: 0, stderr: '',
    stdout: args.at(-1) === 'stat=' ? 'S\n' : `${process.getuid()} Tue Oct 20 18:00:00 2026 /unrelated/program\n` });
  await assert.rejects(g.processIdentity(123), /approved Runtime worker/);
  assert.equal(await g.originalProcessAlive(123, 'original-worker'), false);
  g.command = async () => ({ ok: false, code: 2, stdout: '', stderr: 'Permission denied' });
  await assert.rejects(g.originalProcessAlive(123, 'original-worker'), /Cannot inspect/);
});
