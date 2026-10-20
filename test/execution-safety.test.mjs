import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, decide, Guard, executionActivity } from '../guard.mjs';

const base = () => ({ version: 1, restarts: [], checkedAt: null, candidate: null, failureSince: null });
const sample = { kind: 'connection_stuck', pid: 300, runtimeId: 'runtime-a', harnessConnected: false,
  transportFailure: { code: 1006, activeExecutions: 1, closedAt: 0 } };

test('active executions survive both fast and generic restart deadlines, including pending recovery', () => {
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
