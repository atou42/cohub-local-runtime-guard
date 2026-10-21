#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inspectCli } from '../guard.mjs';
import { packageDigest } from './install-locked-cli.mjs';
import { verifyCli } from './verify-cli.mjs';

const exec = promisify(execFile);
const artifact = fileURLToPath(new URL('../patches/cohub-cli/10.6.0-reconnect1/', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
async function absent(target) {
  try { await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`Refusing to overwrite existing path: ${target}`);
}

// Copy, patch and verify one new package. Never install globally or select it
// in a guard configuration; the caller schedules rollout as a separate stage.
export async function prepareReconnectCli({ source, destination, baseline }) {
  for (const [name, value] of Object.entries({ source, destination, ...(baseline ? { baseline } : {}) }))
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
  source = await fs.realpath(source);
  const parent = await fs.realpath(path.dirname(destination));
  destination = path.join(parent, path.basename(destination));
  if (within(source, destination) || within(destination, source)) throw new Error('Source and destination must not overlap');
  await absent(destination);
  if (baseline) {
    if (within(source, baseline) || within(destination, baseline)) throw new Error('Keep the baseline outside both packages');
    await absent(baseline);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(artifact, 'manifest.json'), 'utf8'));
  const patch = path.join(artifact, 'reconnect.patch');
  if (sha256(await fs.readFile(patch)) !== manifest.patchSha256) throw new Error('Patch integrity mismatch');
  const dependencyLock = await fs.readFile(path.join(artifact, 'dependencies.lock.json'));
  if (sha256(dependencyLock) !== manifest.dependencyLockSha256) throw new Error('Dependency lock integrity mismatch');
  const before = await inspectCli(path.join(source, 'bin/cohub.js'));
  if (before.version !== '10.6.0' || before.fingerprint !== manifest.base.fingerprint || await packageDigest(source) !== manifest.base.packageSha256)
    throw new Error('Source is not the exact reviewed 10.6.0 package and dependency tree');
  const staged = await fs.mkdtemp(path.join(parent, '.cohub-reconnect1-'));
  let published = false;
  try {
    await fs.cp(source, staged, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    if (await packageDigest(staged) !== manifest.base.packageSha256) throw new Error('Copy integrity mismatch');
    const git = { cwd: staged, timeout: 10000, env: { PATH: process.env.PATH, LANG: 'C', GIT_CEILING_DIRECTORIES: parent } };
    await exec('git', ['apply', '--check', '--whitespace=error-all', patch], git);
    await exec('git', ['apply', '--whitespace=error-all', patch], git);
    const pkg = JSON.parse(await fs.readFile(path.join(staged, 'package.json'), 'utf8'));
    const generation = JSON.parse(await fs.readFile(path.join(staged, 'node_modules/@neta-art/generation/package.json'), 'utf8'));
    if (pkg.dependencies['@neta-art/generation'] !== '0.1.39' || generation.version !== '0.1.39')
      throw new Error('Generation must be pinned and installed at 0.1.39');
    const current = await inspectCli(path.join(staged, 'bin/cohub.js'));
    if (current.fingerprint !== manifest.result.fingerprint || await packageDigest(staged) !== manifest.result.packageSha256)
      throw new Error('Patched package integrity mismatch');
    const contract = await verifyCli(path.join(staged, 'bin/cohub.js'));
    if (contract.activeExecution1006 !== 'reconnects' || contract.readyWhileActive < 2)
      throw new Error('Reconnect compatibility contract failed');
    if (await packageDigest(source) !== manifest.base.packageSha256) throw new Error('Source changed during preparation');
    await absent(destination);
    await fs.rename(staged, destination); published = true;
    if (baseline) await fs.writeFile(baseline, `${JSON.stringify({ schemaVersion: 2, reviewedVersion: current.version,
      fingerprint: current.fingerprint, contract }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { cli: path.join(destination, 'bin/cohub.js'), patch: manifest.id, generation: generation.version,
      fingerprint: current.fingerprint, baseline: baseline ?? null, contract };
  } finally {
    if (!published) await fs.rm(staged, { recursive: true, force: true });
  }
}

if (process.argv[1] && await fs.realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { source: { type: 'string' }, destination: { type: 'string' }, baseline: { type: 'string' } } });
    console.log(JSON.stringify(await prepareReconnectCli(values), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
