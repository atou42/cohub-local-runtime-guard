import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

// Executed only in the verifier's disposable HOME, after explicit code review.
const root = path.resolve(path.dirname(process.argv[2]), '..');
const moduleAt = relative => import(pathToFileURL(path.join(root, relative)).href);
const { ensureNativeSync } = await moduleAt('dist/runtime/native/attach.js');
const { writeNativeConfig, runtimeStateRoot } = await moduleAt('dist/runtime/native/config.js');
const { parseRuntimeHarnesses, parseRuntimeDisplay } = await moduleAt('dist/runtime/launch.js');
const { serveRuntime } = await moduleAt('dist/runtime/connection.js');
const requireCli = createRequire(path.join(root, 'package.json'));
const { WebSocketServer } = requireCli('ws');
const sdkRoot = path.join(root, 'node_modules/@neta-art/cohub');
const sdkPackage = JSON.parse(await fs.readFile(path.join(sdkRoot, 'package.json'), 'utf8'));
const sdkEntry = sdkPackage.exports?.['.']?.import;
assert.equal(typeof sdkEntry, 'string', 'SDK must expose its ESM entrypoint');
const sdk = await import(pathToFileURL(path.join(sdkRoot, sdkEntry)).href);
assert.equal(typeof serveRuntime, 'function');
assert.deepEqual(parseRuntimeHarnesses(['codex', 'pi']), ['codex', 'pi']);
assert.throws(() => parseRuntimeHarnesses(['invalid-harness']));
assert.equal(parseRuntimeDisplay('macos', 'darwin'), 'macos');
assert.equal(parseRuntimeDisplay(false, 'darwin'), undefined);
assert.equal(sdk.RUNTIME_PROTOCOL_VERSION, 1);

for (const shared of [true, false]) {
  const spaceId = randomUUID();
  const config = { version: 2, identity: 'prod:contract-fixture', spaceId, root: process.env.HOME,
    harnesses: shared ? ['codex', 'pi'] : ['pi'], codexShared: shared, enabledAt: '2026-01-01T00:00:00Z' };
  await writeNativeConfig(runtimeStateRoot(spaceId), config);
  const file = path.join(runtimeStateRoot(spaceId), 'native/config.json');
  const before = await fs.readFile(file, 'utf8');
  const result = await ensureNativeSync({ ...config, yes: true, executables: { pi: '/usr/bin/false', codex: '/usr/bin/false' } },
    () => {}, () => { throw new Error('Unexpected consent request'); });
  assert.equal(result.importHistory, false);
  assert.equal(result.codexShared, shared);
  assert.deepEqual(result.harnesses, config.harnesses);
  assert.equal(await fs.readFile(file, 'utf8'), before);
}

async function until(predicate, message, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(10);
  }
}

// Use the released CLI's actual connection loop and a real abrupt TCP close.
// Admission is deliberately held; no harness, model or user task is started.
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const controller = new AbortController();
const spaceId = randomUUID();
const turnId = randomUUID();
const userMessageId = randomUUID();
const frame = sdk.runtimeCommandSchema.parse({
  type: 'turn.start', requestId: randomUUID(),
  input: { spaceId, sessionId: randomUUID(), turnId, userMessageId, harness: 'pi', accessMode: 'full_access',
    messages: [{ turnId, userMessageId, userId: null, content: [{ type: 'text', text: 'isolated fixture, never executed' }] }],
    context: { complete: true, revision: 'fixture', throughTurnId: null, messages: [] } },
});
let firstSocket;
let connections = 0;
let ready = 0;
let executionStarted = false;
let release;
let serveError;
const held = new Promise(resolve => { release = resolve; });
const events = [];
server.on('connection', socket => {
  connections++;
  firstSocket ??= socket;
  socket.on('message', bytes => {
    const message = JSON.parse(String(bytes));
    if (message.type === 'runtime.hello') {
      socket.send(JSON.stringify({ type: 'runtime.ready', connectionId: randomUUID() }));
      if (connections === 1) socket.send(JSON.stringify(frame));
    } else if (message.type === 'runtime.heartbeat') socket.send(JSON.stringify({ type: 'runtime.heartbeat' }));
  });
});
const serving = serveRuntime({
  url: `ws://127.0.0.1:${server.address().port}`, signal: controller.signal, spaceId, cwd: process.env.HOME,
  capabilities: { harnesses: ['pi'] }, token: async () => 'isolated-fake-token',
  onReady: () => { ready++; }, onDisconnected: () => {},
  diagnostics: { log: (level, event, data) => { events.push({ event, data }); } },
  executor: {
    archives: { flush: async () => {} },
    results: {
      pendingBatches: async function* () {},
      recover: async () => null,
      admit: async () => {
        executionStarted = true;
        await held;
        throw new Error('Fixture admission released; no model was run');
      },
    },
  },
}).catch(error => { serveError = error; });
let transport;
try {
  await until(() => executionStarted || serveError, 'CLI did not start fixture execution');
  if (serveError) throw serveError;
  firstSocket.terminate();
  await until(() => events.some(e => e.event === 'runtime.websocket.closed' && e.data?.code === 1006),
    'CLI did not report abnormal close 1006');
  const closed = events.find(e => e.event === 'runtime.websocket.closed' && e.data?.code === 1006);
  assert.equal(closed.data.activeExecutions, 1);
  await sleep(2500);
  const activeExecution1006 = ready > 1 ? 'reconnects' : 'waits_for_execution';
  const readyWhileActive = ready;
  release();
  await until(() => ready > 1 || serveError, 'CLI did not reconnect after fixture execution settled');
  if (serveError) throw serveError;
  transport = { activeExecution1006, observedCloseCode: closed.data.code, activeExecutions: 1,
    readyWhileActive, readyAfterRelease: ready };
} finally {
  release();
  controller.abort();
  for (const socket of server.clients) socket.terminate();
  await Promise.race([serving, sleep(3000).then(() => { throw new Error('CLI failed to stop isolated transport'); })]);
  await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify({ passed: true, nativeConsent: 'preserved', importHistory: false, protocolVersion: 1, ...transport }));
