import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, decide, Guard, executionActivity, connectionEvidence } from '../guard.mjs';

const base = () => ({ version: 1, restarts: [], checkedAt: null, candidate: null, failureSince: null });
const sample = { kind: 'connection_stuck', pid: 300, runtimeId: 'runtime-a', harnessConnected: false,
  transportFailure: { code: 1006, activeExecutions: 1, closedAt: 0 } };

test('without confirmed transport loss, active executions remain protected, including pending recovery', () => {
  for (const pendingRecovery of [null, { sourcePid: 300, sourceRuntimeId: 'runtime-a', attempts: 1, lastAttemptAt: 0 }]) {
    let state = { ...base(), pendingRecovery };
    for (let now = 0; now <= 20 * 60_000; now += CONFIG.intervalMs) {
      state = decide(state, sample, now, false, CONFIG);
      assert.equal(state.action, 'observe', `must preserve execution at ${now}`);
    }
    assert.equal(state.reason, 'execution_active');
    assert.equal(state.failureSince, null);
  }
});

const disconnected = { ...sample, localState: 'reconnecting', executionActivity: { state: 'active' } };
const advance = (state, observation, from, until, config = CONFIG) => {
  for (let now = from; now <= until; now += config.intervalMs)
    state = decide(state, observation, now, false, config);
  return state;
};

test('continuous reconnecting reaches the configured deadline even with active or unknown execution', () => {
  const config = { ...CONFIG, disconnectedMs: 240_000 };
  for (const executionActivity of [{ state: 'idle' }, { state: 'active' }, { state: 'unknown' }]) {
    const observation = { ...disconnected, transportFailure: null, executionActivity };
    let state = advance(base(), observation, 0, config.disconnectedMs - config.intervalMs, config);
    assert.equal(state.action, 'observe');
    assert.equal(state.failureSince, 0);
    state = decide(state, observation, config.disconnectedMs, false, config);
    assert.equal(state.action, 'recover');
    assert.equal(state.reason, 'disconnect_timeout');
  }
});

test('short disconnect with active work stays protected even with an old pending recovery', () => {
  const config = { ...CONFIG, disconnectedMs: 180_000 };
  let state = { ...base(), pendingRecovery: {
    sourcePid: sample.pid, sourceRuntimeId: sample.runtimeId, attempts: 99, lastAttemptAt: 0,
  } };
  state = advance(state, disconnected, 0, 170_000, config);
  assert.equal(state.action, 'observe');
  assert.equal(state.reason, 'execution_active');
  assert.equal(state.failureSince, 0);
  assert.equal(decide(state, disconnected, 180_000, false, config).action, 'recover');
});

test('heartbeat recovery clears elapsed time and retry authorization before another outage', () => {
  const config = { ...CONFIG, disconnectedMs: 240_000 };
  let state = advance(base(), disconnected, 0, 230_000, config);
  state.retry = { candidate: state.candidate, attempts: 5, lastAttemptAt: 0 };
  state = decide(state, { kind: 'healthy' }, 240_000, false, config);
  assert.equal(state.failureSince, null);
  assert.equal(state.retry, null);
  state = advance(state, disconnected, 250_000, 480_000, config);
  assert.equal(state.action, 'observe');
  assert.equal(state.failureSince, 250_000);
  assert.equal(decide(state, disconnected, 490_000, false, config).action, 'recover');
});

test('a ready event between probes, a replacement PID, pause or monitoring gap resets the deadline', () => {
  const config = { ...CONFIG, disconnectedMs: 240_000 };
  const state = advance(base(), disconnected, 0, 230_000, config);
  for (const observation of [
    { ...disconnected, connectionRecoveredAt: 235_000 },
    { ...disconnected, pid: 301 },
    { ...disconnected, runtimeId: 'runtime-b' },
  ]) {
    const next = decide(state, observation, 240_000, false, config);
    assert.equal(next.action, 'observe');
    assert.equal(next.failureSince, 240_000);
  }
  assert.equal(decide(state, disconnected, 240_000, true, config).failureSince, null);
  assert.equal(decide(state, disconnected, 400_000, false, config).failureSince, 400_000);
});

test('repeated heartbeat timeouts can confirm an outage without a reconnecting status', () => {
  const config = { ...CONFIG, disconnectedMs: 240_000 };
  let state = base();
  for (let now = 0; now <= config.disconnectedMs; now += config.intervalMs) {
    state = decide(state, { ...disconnected, localState: 'ready', heartbeatTimeoutAt: now }, now, false, config);
  }
  assert.equal(state.action, 'recover');
  assert.equal(state.reason, 'disconnect_timeout');
});

test('another environment owning the Space blocks even an overdue outage and pending retry', () => {
  const config = { ...CONFIG, disconnectedMs: 240_000 };
  const state = advance(base(), disconnected, 0, 230_000, config);
  for (const pendingRecovery of [null, {
    sourcePid: sample.pid, sourceRuntimeId: sample.runtimeId, attempts: 99, lastAttemptAt: 0,
  }]) {
    const next = decide({ ...state, pendingRecovery }, { ...disconnected,
      kind: 'another_runtime', remoteRuntimeId: 'other-environment', online: true,
    }, 240_000, false, config);
    assert.equal(next.action, 'observe');
    assert.ok(['another_runtime', 'recovery_conflict'].includes(next.reason));
    assert.equal(next.failureSince, null);
  }
});

test('heartbeat evidence rejects stale, foreign, future and malformed events and observes recovery', () => {
  const now = 1_000_000;
  const timeout = { runtimeId: sample.runtimeId, timestamp: new Date(now).toISOString(),
    event: 'runtime.heartbeat_timeout', data: { ageMs: 40_000 } };
  assert.deepEqual(connectionEvidence([timeout], sample, now),
    { heartbeatTimeoutAt: now, connectionRecoveredAt: now - 40_000 });
  for (const change of [
    { timestamp: new Date(now - 30_001).toISOString() },
    { timestamp: new Date(now + 1).toISOString() }, { runtimeId: 'foreign' },
  ]) assert.equal(connectionEvidence([{ ...timeout, ...change }], sample, now).heartbeatTimeoutAt, null);
  const ready = { ...timeout, event: 'runtime.ready', timestamp: new Date(now + 1).toISOString() };
  assert.deepEqual(connectionEvidence([ready, timeout], sample, now + 2),
    { heartbeatTimeoutAt: null, connectionRecoveredAt: now + 1 });
  for (const ageMs of [-1, '40000', null, 1.5])
    assert.throws(() => connectionEvidence([{ ...timeout, data: { ageMs } }], sample, now), /heartbeat age/);
  assert.throws(() => connectionEvidence([{ ...timeout, timestamp: 'broken' }], sample, now), /timestamp/);
  assert.throws(() => connectionEvidence({}, sample, now), /diagnostics/);
});

test('missing or malformed diagnostic evidence cannot override execution safety', () => {
  const observation = { ...disconnected, transportEvidenceError: 'Invalid Runtime diagnostics' };
  const state = advance(base(), observation, 0, 20 * 60_000);
  assert.equal(state.action, 'observe');
  assert.equal(state.failureSince, null);
});

test('unknown execution activity cannot authorize a generic restart', () => {
  for (const executionActivity of [undefined, { state: 'unknown' }]) {
    let state = base();
    for (let now = 0; now <= 300_000; now += CONFIG.intervalMs) {
      state = decide(state, { ...sample, transportFailure: null, executionActivity }, now, false, CONFIG);
    }
    assert.equal(state.action, 'observe');
    assert.equal(state.reason, 'execution_activity_unknown');
  }
});

test('recover rechecks activity before touching a live process even when invoked directly', async () => {
  const g = new Guard(CONFIG);
  g.preflight = async () => {};
  g.paused = async () => false;
  g.probe = async () => sample;
  g.owner = async () => { throw new Error('must not reach mutation path'); };
  const result = await g.recover(sample);
  assert.equal(result.outcome, 'skipped');
  assert.equal(result.reason, 'execution_active');
});

test('only fresh explicit idle evidence is accepted, never silence or malformed counts', () => {
  const now = 1_000_000;
  const event = { timestamp: new Date(now).toISOString(), runtimeId: sample.runtimeId,
    event: 'runtime.heartbeat_timeout', data: { activeExecutions: 0 } };
  assert.equal(executionActivity([event], sample, now).state, 'idle');
  for (const events of [[], [{ ...event, runtimeId: 'foreign' }],
    [{ ...event, timestamp: new Date(now - 30_001).toISOString() }],
    [{ ...event, timestamp: new Date(now + 3).toISOString() }],
    [{ ...event, data: {} }],
    ...['runtime.ready', 'runtime.websocket.connecting', 'runtime.turn_received'].map(name =>
      [event, { ...event, timestamp: new Date(now + 1).toISOString(), event: name, data: {} }]),
  ]) assert.equal(executionActivity(events, sample, now + 2).state, 'unknown');
  for (const activeExecutions of [-1, '0', null, 0.5]) {
    assert.throws(() => executionActivity([{ ...event, data: { activeExecutions } }], sample, now), /count/);
  }
  assert.throws(() => executionActivity([{ ...event, timestamp: 'invalid' }], sample, now), /timestamp/);
  assert.throws(() => executionActivity({}, sample, now), /diagnostics/);
  // Active evidence must never expire into an implicit idle state.
  assert.equal(executionActivity([{ ...event, data: { activeExecutions: 1 } }], sample, now + 3600_000).state, 'active');
});
