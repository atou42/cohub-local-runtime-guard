#!/usr/bin/env node
// Local Pi RPC/extension fixture. No model, network service, or real Pi process.
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

if (process.argv.includes('--version')) { console.log('0.86.1'); process.exit(0); }
const option = name => process.argv[process.argv.indexOf(name) + 1];
const transcript = option('--session');
const rows = readFileSync(transcript, 'utf8').trim().split('\n').map(JSON.parse);
const sessionId = rows[0].id;
let leaf = rows.at(-1)?.id ?? null;
const append = row => {
  const id = randomUUID();
  appendFileSync(transcript, `${JSON.stringify({ ...row, id, parentId: leaf, timestamp: new Date().toISOString() })}\n`);
  leaf = id;
};
const handlers = new Map();
let running = null;
const context = { cwd: process.cwd(), sessionManager: { getSessionFile: () => transcript, getSessionId: () => sessionId },
  isIdle: () => running === null, abort: () => running?.finish('aborted') };
const emit = async (type, event = {}) => {
  for (const handler of handlers.get(type) ?? []) await handler({ ...event, type }, context);
};
async function prompt(content) {
  appendFileSync(join(process.cwd(), 'side-effects.jsonl'), `${JSON.stringify({ sessionId, pid: process.pid })}\n`);
  let timer, done = false;
  const finish = async stopReason => {
    if (done) return;
    done = true; clearInterval(timer);
    for (const [index, text] of ['first durable message', 'final durable message'].entries()) {
      const message = { role: 'assistant', content: [{ type: 'text', text }], provider: 'fixture', model: 'test',
        stopReason: index === 0 && stopReason === 'stop' ? 'toolUse' : stopReason };
      if (index > 0) await emit('message_start', { message: { role: 'assistant' } });
      append({ type: 'message', message });
      await emit('message_end', { message });
      await emit('turn_end', { message, toolResults: [] });
    }
    running = null;
    await emit('agent_end', { messages: [] });
    await emit('agent_settled');
  };
  running = { finish };
  await emit('agent_start');
  append({ type: 'message', message: { role: 'user', content } });
  await emit('message_start', { message: { role: 'user' } });
  await emit('message_end', { message: { role: 'user', content } });
  await emit('message_start', { message: { role: 'assistant' } });
  await emit('message_update', { assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'task is running' } });
  timer = setInterval(() => { if (existsSync(join(process.cwd(), 'release'))) void finish('stop'); }, 10);
}
const extension = (await import(pathToFileURL(option('-e')).href)).default;
extension({ on: (type, handler) => handlers.set(type, [...(handlers.get(type) ?? []), handler]),
  sendUserMessage: content => { void prompt(content); }, appendEntry: (customType, data) => append({ type: 'custom', customType, data }) });
await emit('session_start', { reason: 'startup' });
const model = { provider: 'fixture', id: 'test', name: 'Fixture', reasoning: true };
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  const data = frame.type === 'get_available_models' ? { models: [model] } :
    frame.type === 'get_state' ? { sessionId, model, isStreaming: running !== null } : {};
  console.log(JSON.stringify({ id: frame.id, type: 'response', success: true, data }));
}
