#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { inspectCli } from '../guard.mjs';

const { values } = parseArgs({ options: { cli: { type: 'string' }, reference: { type: 'string' }, 'test-deps': { type: 'string' },
  output: { type: 'string' }, suite: { type: 'string', default: 'regression' } } });
if (!values.cli || !path.isAbsolute(values.cli) || !values.output || !path.isAbsolute(values.output))
  throw new Error('Usage: node scripts/test-reconnect-cli.mjs --cli /candidate/package --output /evidence --suite regression|upstream [--reference /checkout]');
if (!['regression', 'upstream'].includes(values.suite)) throw new Error('Invalid suite');
if (values.suite === 'upstream' && (!values.reference || !path.isAbsolute(values.reference))) throw new Error('An absolute reference checkout is required');
const repo = fileURLToPath(new URL('../', import.meta.url));
const before = await inspectCli(path.join(values.cli, 'bin/cohub.js'));
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'cohub-reconnect-tests-'));
await fs.mkdir(values.output, { recursive: true });
const log = path.join(values.output, `${values.suite}.log`);
const resultPath = path.join(values.output, `${values.suite}.json`);
const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: sandbox,
  USER: 'reconnect-fixture', LOGNAME: 'reconnect-fixture', LANG: 'en_US.UTF-8', TMPDIR: await fs.realpath(os.tmpdir()),
  COHUB_RECONNECT_TEST_HOME: sandbox, COHUB_RECONNECT_CLI: values.cli, COHUB_RECONNECT_REFERENCE: values.reference ?? '', PI_OFFLINE: '1', COHUB_CLI_AUTO_UPDATE: '0',
  COHUB_RECONNECT_IMPORT_AUDIT: path.join(values.output, 'upstream-imports.txt'), COHUB_RECONNECT_TEST_DEPS: values['test-deps'] ?? '' };
const files = values.suite === 'regression' ? [path.join(repo, 'test/cli-reconnect.integration.mjs')] : [
  'runtime-ws.integration.ts', 'runtime-recovery.integration.ts', 'runtime-supervisor.integration.ts',
  'runtime-relay.integration.ts', 'runtime-auth.integration.ts', 'runtime-ordering.integration.ts',
  'runtime-batch.test.ts', 'runtime-lifecycle.test.ts', 'runtime.test.ts',
  'runtime-native-archive.test.ts', 'runtime-archive.test.ts', 'native-translate.test.ts',
].map(name => path.join(values.reference, 'packages/cli/tests', name));
const args = values.suite === 'regression' ? [] : [
  '--import', path.join(values.reference, 'node_modules/tsx/dist/loader.mjs'),
  '--import', path.join(repo, 'scripts/reconnect-cli-register.mjs'),
];
args.push('--test', '--test-reporter=tap', '--test-concurrency=1', ...files);
const report = { suite: values.suite, startedAt: new Date().toISOString(), candidate: values.cli,
  fingerprint: before.fingerprint, isolatedHome: sandbox, command: [process.execPath, ...args], log, status: 'running' };
const output = await fs.open(log, 'w');
const child = spawn(process.execPath, args, { cwd: values.reference ?? repo, env, stdio: ['ignore', output.fd, output.fd], detached: true });
report.pid = child.pid;
await fs.writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`);
const timeout = setTimeout(() => { report.timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, 180000);
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0))); });
clearTimeout(timeout); await output.close();
const after = await inspectCli(path.join(values.cli, 'bin/cohub.js'));
const content = await fs.readFile(log, 'utf8');
report.exitCode = code;
report.finishedAt = new Date().toISOString();
report.unchanged = JSON.stringify(before) === JSON.stringify(after);
report.counts = Object.fromEntries([...content.matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)$/gm)].map(match => [match[1], Number(match[2])]));
report.status = code === 0 && report.unchanged && report.counts.tests > 0 && report.counts.fail === 0 ? 'passed' : 'failed';
await fs.writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, counts: report.counts, report: resultPath }));
if (report.status === 'passed') await fs.rm(sandbox, { recursive: true, force: true });
else process.exitCode = 1;
