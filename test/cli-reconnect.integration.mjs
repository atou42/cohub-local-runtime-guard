import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const cli = process.env.COHUB_RECONNECT_CLI;
assert(cli && path.isAbsolute(cli), 'Specify the isolated installed CLI with COHUB_RECONNECT_CLI');
assert.equal(process.env.COHUB_RECONNECT_TEST_HOME, os.homedir(), 'Run through scripts/test-reconnect-cli.mjs for isolated state');
const moduleAt = relative => import(pathToFileURL(path.join(cli, relative)).href);
const { serveRuntime } = await moduleAt('dist/runtime/connection.js');
const { NativeRuntime } = await moduleAt('dist/runtime/native/daemon.js');
const { RuntimeArchiveStore } = await moduleAt('dist/runtime/archive-store.js');
const { RuntimeDiagnostics } = await moduleAt('dist/runtime/diagnostics.js');
const { WebSocketServer } = createRequire(path.join(cli, 'package.json'))('ws');
const executable = fileURLToPath(new URL('./fixtures/reconnect-pi.mjs', import.meta.url));
const waitFor = async (fn, label, timeout = 7000) => {
  const deadline = Date.now() + timeout;
  while (!await fn()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
};
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve }; };

async function fixture(t, settings = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cohub-reconnect-case-'));
  process.env.XDG_STATE_HOME = path.join(root, 'xdg');
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(root, 'pi-sessions');
  const spaceId = randomUUID(), sessionId = randomUUID(), turnId = randomUUID(), requestId = randomUUID();
  const input = { spaceId, sessionId, turnId, userMessageId: turnId, harness: 'pi', accessMode: 'full_access',
    messages: [{ turnId, userMessageId: turnId, userId: null, content: [{ type: 'text', text: 'isolated held execution' }] }],
    context: { complete: true, revision: 'fixture', throughTurnId: null, messages: [] } };
  const diagnostics = new RuntimeDiagnostics({ root: path.join(root, 'state'), spaceId });
  const native = new NativeRuntime({ spaceId, root, stateRoot: path.join(root, 'state'), harnesses: ['pi'],
    executables: { pi: executable }, identity: 'fixture', config: null, diagnostics,
    archives: new RuntimeArchiveStore(path.join(root, 'archives'), null),
    projectionSource: { session: () => ({ turns: { listPaginated: async () => ({ turns: [], hasMore: false }) } }) } });
  const nativeController = new AbortController(), controller = new AbortController();
  await native.start(nativeController.signal);
  const c = { root, native, input, requestId, controller, ready: [], sockets: [], frames: [], logs: [], channels: [],
    hooks: {}, cleanup: [], identities: new Map(), starts: 0, records: 0, acknowledgements: 0, projection: new Map(), result: null, error: null, autoReady: true };
  for (const [method, counter, hook] of [['start', 'starts', 'start'], ['record', 'records', 'record'], ['acknowledge', 'acknowledgements', 'acknowledge']]) {
    const original = native.executor.results[method].bind(native.executor.results);
    native.executor.results[method] = async (...args) => {
      c[counter]++;
      await c.hooks[hook]?.(...args);
      const value = await original(...args);
      if (method === 'record') c.result = await native.executor.results.read(sessionId);
      return value;
    };
  }
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  server.on('connection', socket => {
    const connection = c.sockets.push(socket);
    socket.on('message', bytes => {
      const frame = JSON.parse(String(bytes));
      c.frames.push({ connection, frame, at: Date.now() });
      if (frame.type === 'runtime.hello' && c.autoReady) c.handshake(connection);
      if (frame.type === 'runtime.heartbeat') c.send({ type: 'runtime.heartbeat' }, connection);
      if (frame.type === 'runtime.event' && ['message.commit', 'turn.end'].includes(frame.event.type)) {
        const key = `${c.identities.get(frame.requestId)?.turnId}:${frame.event.message.ordinal}`;
        const value = JSON.stringify(frame.event);
        // Model the server's durable ordinal key. A lost ACK permits wire replay,
        // but no duplicate durable write or changed result under the same key.
        if (c.projection.has(key)) {
          if (c.projection.get(key) !== value) c.error ??= new Error('Replay changed a durable result');
        } else c.projection.set(key, value);
      }
    });
  });
  c.send = (frame, connection = c.sockets.length) => {
    if (frame.type === 'turn.start') c.identities.set(frame.requestId, frame.input);
    if (frame.type === 'turn.recover') c.identities.set(frame.requestId, frame.execution);
    c.sockets[connection - 1].send(JSON.stringify(frame));
  };
  c.handshake = connection => c.send({ type: 'runtime.ready', connectionId: randomUUID() }, connection);
  c.start = (id = requestId, overrides = {}) => {
    const next = { ...input, ...overrides };
    if (overrides.turnId) {
      next.userMessageId = next.turnId;
      next.messages = input.messages.map(message => ({ ...message, turnId: next.turnId, userMessageId: next.turnId }));
    }
    c.send({ type: 'turn.start', requestId: id, input: next }); return id;
  };
  c.recover = (id = randomUUID()) => {
    c.send({ type: 'turn.recover', requestId: id, execution: { spaceId, sessionId, turnId, harness: 'pi' } }); return id;
  };
  c.event = (type, id, connection = c.sockets.length) => c.frames.find(row => row.connection === connection &&
    row.frame.type === 'runtime.event' && row.frame.requestId === id && row.frame.event.type === type)?.frame.event;
  c.release = () => fs.writeFile(path.join(root, 'release'), 'release\n');
  c.effects = async () => (await fs.readFile(path.join(root, 'side-effects.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  c.started = async () => waitFor(async () => (await c.effects()).length > 0 || c.error || c.event('turn.error', requestId), 'execution start');
  c.assertRunningOnce = async () => {
    if (c.error) throw c.error;
    const effects = await c.effects(); assert.equal(effects.length, 1, JSON.stringify(c.frames.at(-1)));
    process.kill(effects[0].pid, 0);
    assert.equal(c.starts, 1); assert.equal(c.records, 0);
  };
  c.drop = async (reconnect = true) => {
    const previous = c.ready.length, begin = Date.now(), count = c.logs.filter(row => row.event === 'runtime.websocket.closed' && row.data.code === 1006).length;
    c.sockets.at(-1).terminate();
    await waitFor(() => c.logs.filter(row => row.event === 'runtime.websocket.closed' && row.data.code === 1006).length > count, '1006 observed');
    if (reconnect) await waitFor(() => c.ready.length > previous || c.error, 'ready after 1006');
    if (c.error) throw c.error;
    return Date.now() - begin;
  };
  c.ack = async (id, connection = c.sockets.length) => {
    await waitFor(() => c.event('turn.end', id, connection) || c.error, 'terminal result');
    if (c.error) throw c.error;
    c.send({ type: 'turn.ack', requestId: id, turnId, revision: 'committed' }, connection);
    await waitFor(() => c.event('turn.acknowledged', id, connection) || c.error, 'acknowledgement');
    if (c.error) throw c.error;
  };
  const running = serveRuntime({ url: `ws://127.0.0.1:${server.address().port}`, spaceId, cwd: root,
    capabilities: { harnesses: ['pi'] }, token: async () => 'fixture-token', signal: controller.signal,
    executor: native.executor, onReady: () => c.ready.push(Date.now()), onNativeChannel: send => c.channels.push(send),
    diagnostics: { log: (level, event, data, context) => c.logs.push({ level, event, data, context }) }, ...settings,
  }).catch(error => { c.error = error; });
  c.running = running;
  t.after(async () => {
    for (const release of c.cleanup) release();
    c.hooks = {};
    await c.release(); controller.abort();
    for (const socket of server.clients) socket.terminate();
    await running;
    nativeController.abort(); await native.close(AbortSignal.timeout(2000)); await diagnostics.close();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  await waitFor(() => c.ready.length === 1 || c.error, 'initial ready');
  if (c.error) throw c.error;
  return c;
}
async function assertCompleted(c) {
  assert.equal((await c.effects()).length, 1, 'model/tool work runs once');
  assert.equal(c.starts, 1); assert.equal(c.records, 1); assert.equal(c.acknowledgements, 1);
  assert.equal(c.result.events.at(-1).message.stopReason, 'stop');
  assert.equal(c.projection.size, 2, 'two distinct durable messages, without duplicate writes');
  assert.deepEqual(c.result.events.map(event => event.message.ordinal), [0, 1]);
  assert.equal(await c.native.executor.results.read(c.input.sessionId), null, 'receipt removed only after ACK');
}

test('idle 1006 reconnects promptly and removes the old heartbeat timer', { timeout: 12000 }, async t => {
  const intervals = new Set();
  const set = globalThis.setInterval, clear = globalThis.clearInterval;
  t.mock.method(globalThis, 'setInterval', (fn, ms, ...args) => { const timer = set(fn, ms, ...args); if (ms === 10000) intervals.add(timer); return timer; });
  t.mock.method(globalThis, 'clearInterval', timer => { intervals.delete(timer); return clear(timer); });
  const c = await fixture(t), before = intervals.size;
  const elapsed = await c.drop();
  assert(elapsed < 2000, `Reconnect took ${elapsed}ms`);
  assert.equal(intervals.size, before, 'closed transport must not retain its heartbeat interval');
  assert.equal(c.starts, 0);
  t.diagnostic(`idle reconnect: ${elapsed}ms`);
});

test('running task reconnects before release; changed request ID observes without rerunning or aborting', { timeout: 15000 }, async t => {
  const c = await fixture(t); c.start(); await c.started();
  const elapsed = await c.drop(); await c.assertRunningOnce();
  const id = c.recover(); c.recover(id);
  await delay(50); await c.assertRunningOnce();
  await c.release(); await c.ack(id); await assertCompleted(c);
  assert(elapsed < 2000); t.diagnostic(`active reconnect: ${elapsed}ms; execution count: ${c.starts}`);
});

test('result produced while disconnected is persisted and replayed after ready', { timeout: 15000 }, async t => {
  const c = await fixture(t); c.start(); await c.started(); c.autoReady = false;
  await c.drop(false); await c.release();
  await waitFor(() => c.result, 'offline receipt');
  assert.equal(c.ready.length, 1); assert.equal(c.result.events.at(-1).message.stopReason, 'stop');
  await waitFor(() => c.sockets.length === 2, 'new socket'); c.handshake(2);
  await waitFor(() => c.ready.length === 2, 'new ready');
  const id = c.recover(); await c.ack(id); await assertCompleted(c);
});

test('disconnect during durable result write retains the receipt and terminal result', { timeout: 15000 }, async t => {
  const c = await fixture(t), gate = deferred(); c.cleanup.push(gate.resolve);
  c.hooks.record = () => gate.promise;
  c.start(); await c.started(); await c.release();
  await waitFor(() => c.records === 1, 'record started');
  await c.drop(); const id = c.recover(); gate.resolve();
  await c.ack(id); await assertCompleted(c);
});

test('three successive 1006 disconnects preserve one execution and bounded backoff', { timeout: 20000 }, async t => {
  const c = await fixture(t); c.start(); await c.started();
  const delays = [];
  for (let index = 0; index < 3; index++) {
    delays.push(await c.drop()); c.start(c.requestId); c.recover(); await c.assertRunningOnce();
  }
  const id = c.recover(); await c.release(); await c.ack(id); await assertCompleted(c);
  assert.deepEqual(c.logs.filter(row => row.event === 'runtime.reconnect_scheduled').map(row => row.data.delayMs), [500, 1000, 2000]);
  t.diagnostic(`reconnects: ${delays.join(', ')}ms; execution count: ${c.starts}`);
});

test('lost terminal ACK replays stable ordinals without repeating model/tool work', { timeout: 15000 }, async t => {
  const c = await fixture(t); c.start(); await c.started(); await c.release();
  await waitFor(() => c.event('turn.end', c.requestId), 'first terminal result');
  const before = [...c.projection]; await c.drop(); const id = c.recover();
  await c.ack(id); assert.deepEqual([...c.projection], before); await assertCompleted(c);
});

test('peer-only resume replays the result while the shared control socket stays connected', { timeout: 12000 }, async t => {
  const c = await fixture(t); c.start(); await c.started(); await c.release();
  await waitFor(() => c.event('turn.end', c.requestId), 'first result');
  const ends = () => c.frames.filter(row => row.frame.event?.type === 'turn.end').length;
  assert.equal(ends(), 1);
  c.send({ type: 'turn.start', requestId: c.requestId, resumeOnly: true, input: c.input });
  await waitFor(() => ends() === 2, 'result replay for resumed peer');
  await c.ack(c.requestId); await assertCompleted(c); assert.equal(c.ready.length, 1);
});

test('ACK in flight across reconnect deletes one receipt and confirms both subscriptions safely', { timeout: 15000 }, async t => {
  const c = await fixture(t), gate = deferred(); c.cleanup.push(gate.resolve);
  c.hooks.acknowledge = () => gate.promise;
  c.start(); await c.started(); await c.release();
  await waitFor(() => c.event('turn.end', c.requestId), 'terminal result');
  c.send({ type: 'turn.ack', requestId: c.requestId, turnId: c.input.turnId, revision: 'old' });
  await waitFor(() => c.acknowledgements === 1, 'old ACK in flight');
  await c.drop(); const id = c.recover();
  const acknowledged = c.ack(id); await delay(50); gate.resolve(); await acknowledged;
  await assertCompleted(c);
});

test('duplicate ACK after an acknowledgement reply is lost is idempotent', { timeout: 15000 }, async t => {
  const c = await fixture(t); c.start(); await c.started(); await c.release(); await c.ack(c.requestId);
  await c.drop();
  c.send({ type: 'turn.ack', requestId: c.requestId, turnId: c.input.turnId, revision: 'same' });
  await waitFor(() => c.event('turn.acknowledged', c.requestId), 'duplicate ACK confirmation');
  c.start(); await delay(50); await assertCompleted(c);
});

test('recovery observer timeout detaches without cancelling the task and completion wakes recovery again', { timeout: 15000 }, async t => {
  const c = await fixture(t); c.start(); await c.started(); await c.drop();
  const observer = c.recover(); c.send({ type: 'turn.abort', requestId: observer });
  await delay(50); await c.assertRunningOnce();
  const before = c.frames.filter(row => row.frame.type === 'runtime.recovery').length;
  await c.release();
  await waitFor(() => c.frames.filter(row => row.frame.type === 'runtime.recovery').length > before, 'completion recovery notification');
  const id = c.recover(); await c.ack(id); await assertCompleted(c);
});

test('context request survives 1006 and resumes admission only once', { timeout: 15000 }, async t => {
  const c = await fixture(t), previousTurn = randomUUID();
  await c.native.executor.results.start({ harness: 'pi', nativeSessionId: randomUUID(), path: path.join(c.root, 'prior.jsonl'), cwd: c.root },
    { sessionId: c.input.sessionId, turnId: previousTurn }, randomUUID());
  c.starts = 0;
  c.start(c.requestId, { context: { ...c.input.context, complete: false } });
  await waitFor(() => c.event('context.required', c.requestId), 'initial context request');
  await c.drop(); c.start(c.requestId, { context: { ...c.input.context, complete: false } });
  await waitFor(() => c.event('context.required', c.requestId), 'context request on new socket');
  c.send({ type: 'session.context', requestId: c.requestId,
    context: { ...c.input.context, resolvedTurnIds: [previousTurn] } });
  await c.started(); await c.assertRunningOnce(); await c.release(); await c.ack(c.requestId); await assertCompleted(c);
});

test('native requests reject on old socket and use the new native channel after 1006', { timeout: 12000 }, async t => {
  const c = await fixture(t);
  const old = c.channels[0]({ type: 'fixture-read' });
  const rejected = assert.rejects(old, /disconnected/);
  await c.drop(); await rejected;
  const reply = c.channels[1]({ type: 'fixture-read' });
  await waitFor(() => c.frames.some(row => row.connection === 2 && row.frame.type === 'runtime.native'), 'new native request');
  const request = c.frames.find(row => row.connection === 2 && row.frame.type === 'runtime.native').frame;
  c.send({ type: 'runtime.native.result', requestId: request.requestId, result: { ok: true } });
  assert.deepEqual(await reply, { ok: true });
});

test('next turn waits for an in-flight ACK before replacing the session receipt', { timeout: 15000 }, async t => {
  const c = await fixture(t), gate = deferred(); c.cleanup.push(gate.resolve);
  c.hooks.acknowledge = () => gate.promise;
  c.start(); await c.started(); await c.release();
  await waitFor(() => c.event('turn.end', c.requestId), 'old terminal result');
  await fs.rm(path.join(c.root, 'release'));
  c.send({ type: 'turn.ack', requestId: c.requestId, turnId: c.input.turnId, revision: 'old' });
  await waitFor(() => c.acknowledgements === 1, 'old ACK in flight');
  const nextTurn = randomUUID(), nextRequest = randomUUID();
  c.start(nextRequest, { turnId: nextTurn, context: { ...c.input.context, resolvedTurnIds: [c.input.turnId] } });
  await delay(100);
  assert.equal(c.starts, 1, 'receipt replacement must wait for old acknowledgement IO');
  assert.equal((await c.native.executor.results.read(c.input.sessionId)).turnId, c.input.turnId);
  gate.resolve(); await waitFor(() => c.starts === 2, 'next execution');
  await waitFor(async () => (await c.effects()).length === 2, 'next side effect');
  c.send({ type: 'turn.ack', requestId: c.requestId, turnId: c.input.turnId, revision: 'late' });
  await delay(50);
  assert.equal((await c.native.executor.results.read(c.input.sessionId)).turnId, nextTurn);
  assert.equal(c.acknowledgements, 1);
  await c.release(); await waitFor(() => c.event('turn.end', nextRequest), 'next terminal result');
  c.send({ type: 'turn.ack', requestId: nextRequest, turnId: nextTurn, revision: 'next' });
  await waitFor(() => c.event('turn.acknowledged', nextRequest), 'next ACK');
  assert.equal(c.acknowledgements, 2); assert.equal(c.starts, 2); assert.equal(c.records, 2);
  assert.equal(c.error, null);
});

test('late ACK for a server-retired turn cannot touch the next turn receipt', { timeout: 15000 }, async t => {
  const c = await fixture(t); c.start(); await c.started(); await c.release();
  await waitFor(() => c.event('turn.end', c.requestId), 'old result'); await fs.rm(path.join(c.root, 'release'));
  const nextTurn = randomUUID(), nextRequest = randomUUID();
  c.start(nextRequest, { turnId: nextTurn, context: { ...c.input.context, resolvedTurnIds: [c.input.turnId] } });
  await waitFor(async () => (await c.effects()).length === 2, 'next execution');
  c.send({ type: 'turn.ack', requestId: c.requestId, turnId: c.input.turnId, revision: 'late' });
  await delay(50);
  assert.equal(c.acknowledgements, 0);
  assert.equal((await c.native.executor.results.read(c.input.sessionId)).turnId, nextTurn);
  await c.release(); await waitFor(() => c.event('turn.end', nextRequest), 'next result');
  c.send({ type: 'turn.ack', requestId: nextRequest, turnId: nextTurn, revision: 'next' });
  await waitFor(() => c.event('turn.acknowledged', nextRequest), 'next ACK');
  assert.equal(c.error, null); assert.equal(c.starts, 2); assert.equal(c.acknowledgements, 1);
});

test('wrong turn ACK is rejected without deleting the result or restarting execution', { timeout: 15000 }, async t => {
  const c = await fixture(t); c.start(); await c.started(); await c.release();
  await waitFor(() => c.event('turn.end', c.requestId), 'result');
  c.send({ type: 'turn.ack', requestId: c.requestId, turnId: randomUUID(), revision: 'invalid' });
  await waitFor(() => c.ready.length === 2, 'protocol rejection reconnect');
  assert.equal(c.acknowledgements, 0); assert(await c.native.executor.results.read(c.input.sessionId));
  const id = c.recover(); await c.ack(id); await assertCompleted(c);
});

for (const code of [4400, 4403, 4409]) test(`rejection ${code} still invalidates execution ownership`, { timeout: 15000 }, async t => {
  const c = await fixture(t, { leaseConflictTimeoutMs: 0 }); c.start(); await c.started();
  c.sockets.at(-1).close(code, 'fixture rejection');
  await c.running; assert(c.error); assert.equal(c.ready.length, 1);
  assert.equal(c.result.events.at(-1).message.stopReason, 'aborted'); assert.equal((await c.effects()).length, 1);
});

test('explicit user stop after reconnect still aborts the running task', { timeout: 15000 }, async t => {
  const c = await fixture(t); c.start(); await c.started(); await c.drop(); c.start();
  c.send({ type: 'turn.abort', requestId: c.requestId });
  await c.ack(c.requestId);
  assert.equal(c.result.events.at(-1).message.stopReason, 'aborted'); assert.equal(c.starts, 1);
});

test('supervisor stop during reconnect backoff cancels execution and waits for cleanup', { timeout: 15000 }, async t => {
  const c = await fixture(t); c.start(); await c.started(); await c.drop(false);
  c.controller.abort(); await c.running;
  assert.equal(c.result.events.at(-1).message.stopReason, 'aborted'); assert.equal(c.starts, 1);
});
