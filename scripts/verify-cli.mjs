#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CLI_CONTRACT, inspectCli } from '../guard.mjs';
const exec = promisify(execFile);

export async function verifyCli(cli) {
  if (!path.isAbsolute(cli)) throw new Error('CLI path must be absolute');
  const before = await inspectCli(cli);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cohub-cli-contract-'));
  // Deliberately exclude authentication, endpoint overrides, proxy credentials and NODE_OPTIONS.
  const env = { HOME: home, USER: 'contract-fixture', LOGNAME: 'contract-fixture',
    LANG: 'en_US.UTF-8', PATH: '/usr/bin:/bin', COHUB_CLI_AUTO_UPDATE: '0', PI_OFFLINE: '1' };
  const run = async args => (await exec(process.execPath, args,
    { env, cwd: home, timeout: 25_000, maxBuffer: 1024 * 1024 })).stdout;
  try {
    const version = (await run([cli, '--version'])).trim();
    if (!version.endsWith(before.version)) throw new Error('CLI version output does not match its package');
    for (const [command, flags] of [
      [['runtime', 'up'], ['--space', '--harness', '--pi', '--codex', '--display', '--no-display', '--detach', '--yes', '--json']],
      [['runtime', 'down'], ['--space', '--yes', '--json']],
      [['runtime', 'status'], ['--space', '--json']],
      [['runtime', 'logs'], ['--space', '--limit', '--level', '--json']],
      [['auth', 'whoami'], ['--json']],
    ]) {
      const help = await run([cli, ...command, '--help']);
      for (const flag of flags) if (!help.includes(flag)) throw new Error(`Missing CLI contract: ${command.join(' ')} ${flag}`);
    }
    const worker = fileURLToPath(new URL('./cli-contract-worker.mjs', import.meta.url));
    const behavior = JSON.parse((await run([worker, cli])).trim());
    if (behavior.passed !== true || behavior.nativeConsent !== 'preserved' || behavior.importHistory !== false ||
        !['reconnects', 'waits_for_execution'].includes(behavior.activeExecution1006))
      throw new Error('CLI behavioral verification failed');
    const after = await inspectCli(cli);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('CLI changed during verification');
    await fs.rm(home, { recursive: true });
    return { id: CLI_CONTRACT, passed: true, checkedAt: new Date().toISOString(), ...behavior };
  } catch (error) {
    throw new Error(`CLI verification failed; isolated evidence retained at ${home}: ${error.message}`, { cause: error });
  }
}

if (process.argv[1] && await fs.realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { cli: { type: 'string' }, 'ack-reviewed': { type: 'boolean' } } });
    if (!values.cli || values['ack-reviewed'] !== true) throw new Error('Usage: node scripts/verify-cli.mjs --cli /reviewed/bin/cohub.js --ack-reviewed');
    console.log(JSON.stringify(await verifyCli(values.cli), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
