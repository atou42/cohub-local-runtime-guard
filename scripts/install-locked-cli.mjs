#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inspectCli, readJson } from '../guard.mjs';

const exec = promisify(execFile);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

// npm's generated bin links and hidden lock record are not package payload.
export async function packageDigest(root) {
  const hash = createHash('sha256');
  async function walk(relative) {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = path.posix.join(relative, entry.name);
      if (['node_modules/.bin', 'node_modules/.package-lock.json'].includes(name)) continue;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(path.join(root, name));
        hash.update(`${name}\0${bytes.length}\0`).update(bytes);
      } else throw new Error(`Unexpected package file type: ${name}`);
    }
  }
  await walk('');
  return hash.digest('hex');
}

export async function publishDirectory(destination, staged, backup, rename = fs.rename) {
  await rename(destination, backup);
  try { await rename(staged, destination); }
  catch (error) {
    try { await fs.lstat(destination); }
    catch (check) {
      if (check.code !== 'ENOENT') throw check;
      await rename(backup, destination);
      throw new Error(`Publish failed; previous installation restored: ${error.message}`, { cause: error });
    }
    throw new Error(`Publish failed and destination is occupied; backup retained at ${backup}`, { cause: error });
  }
}

async function copyHoistedPackages(work, staged) {
  const source = path.join(work, 'node_modules');
  const target = path.join(staged, 'node_modules');
  await fs.mkdir(target, { recursive: true });
  const copy = async relative => {
    // Do not overwrite a nested dependency with a different hoisted package.
    await fs.cp(path.join(source, relative), path.join(target, relative),
      { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
  };
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory()) throw new Error(`Unexpected node_modules entry: ${entry.name}`);
    if (entry.name.startsWith('@')) {
      for (const sub of await fs.readdir(path.join(source, entry.name), { withFileTypes: true })) {
        const relative = `${entry.name}/${sub.name}`;
        if (!sub.isDirectory()) throw new Error(`Unexpected scoped package: ${relative}`);
        if (relative !== '@neta-art/cohub-cli') await copy(relative);
      }
    } else await copy(entry.name);
  }
  const bins = path.join(source, '.bin');
  let names;
  try { names = await fs.readdir(bins); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await fs.mkdir(path.join(target, '.bin'), { recursive: true });
  for (const name of names) {
    if (name === 'cohub') continue;
    const link = await fs.readlink(path.join(bins, name));
    if (path.isAbsolute(link) || !within(source, path.resolve(bins, link)))
      throw new Error(`Unexpected dependency bin link: ${name}`);
    await fs.symlink(link, path.join(target, '.bin', name));
  }
}

export async function installLockedCli({ project, reviewedCli, destination, reviewed, npm = 'npm' }) {
  if (reviewed !== true) throw new Error('Review the project, lockfile and complete candidate; pass --ack-reviewed');
  if (process.platform === 'win32') throw new Error('Windows installation is not supported');
  for (const [key, value] of Object.entries({ project, reviewedCli, destination }))
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${key} must be an absolute path`);
  if (!(await fs.lstat(destination)).isDirectory()) throw new Error('Destination must be an existing real package directory');
  project = await fs.realpath(project);
  const candidate = await fs.realpath(path.resolve(path.dirname(reviewedCli), '..'));
  destination = await fs.realpath(destination);
  for (const other of [project, candidate])
    if (within(other, destination) || within(destination, other)) throw new Error('Installation paths must not overlap');
  const manifestBytes = await fs.readFile(path.join(project, 'package.json'));
  const lockBytes = await fs.readFile(path.join(project, 'package-lock.json'));
  const manifest = JSON.parse(manifestBytes);
  const lock = JSON.parse(lockBytes);
  const cliKey = 'node_modules/@neta-art/cohub-cli';
  const spec = manifest.dependencies?.['@neta-art/cohub-cli'];
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages?.[cliKey] ||
      Object.keys(manifest.dependencies ?? {}).length !== 1 || manifest.devDependencies ||
      manifest.optionalDependencies || manifest.workspaces ||
      typeof spec !== 'string' || lock.packages['']?.dependencies?.['@neta-art/cohub-cli'] !== spec)
    throw new Error('Use a dedicated reviewed project with a matching npm lockfile and only the CLI dependency');
  for (const [name, pkg] of Object.entries(lock.packages)) {
    if (!name) continue;
    if (pkg.link || typeof pkg.version !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(pkg.integrity ?? ''))
      throw new Error(`Missing locked package integrity: ${name}`);
    if (typeof pkg.resolved !== 'string' || (!pkg.resolved.startsWith('https://registry.npmjs.org/') &&
        !(name === cliKey && /^file:\.\.\/.+\.tgz$/.test(pkg.resolved))))
      throw new Error(`Unsupported locked package source: ${name}`);
  }
  const expected = await inspectCli(path.join(candidate, 'bin/cohub.js'));
  const expectedDigest = await packageDigest(candidate);
  if (lock.packages[cliKey].version !== expected.version) throw new Error('Lockfile CLI version differs from reviewed candidate');
  const original = await inspectCli(path.join(destination, 'bin/cohub.js'));
  const originalDigest = await packageDigest(destination);
  const originalStat = await fs.stat(destination);
  const installLock = `${destination}.locked-install`;
  const nonce = randomUUID();
  const handle = await fs.open(installLock, 'wx', 0o600);
  await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }));
  await handle.close();
  let work;
  let staging;
  try {
    // A sibling keeps the lockfile's reviewed file:../...tgz reference unchanged.
    work = await fs.mkdtemp(path.join(path.dirname(project), '.cohub-locked-ci-'));
    await fs.writeFile(path.join(work, 'package.json'), manifestBytes, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(work, 'package-lock.json'), lockBytes, { flag: 'wx', mode: 0o600 });
    await exec(npm, ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
      '--update-notifier=false', '--install-strategy=hoisted'], { cwd: work, timeout: 240_000,
      maxBuffer: 4 * 1024 * 1024, env: { ...process.env, COHUB_CLI_AUTO_UPDATE: '0' } });
    staging = await fs.mkdtemp(path.join(path.dirname(destination), '.cohub-locked-package-'));
    const staged = path.join(staging, 'package');
    await fs.cp(path.join(work, cliKey), staged,
      { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    await copyHoistedPackages(work, staged);
    const prepared = await inspectCli(path.join(staged, 'bin/cohub.js'));
    if (JSON.stringify(prepared) !== JSON.stringify(expected) || await packageDigest(staged) !== expectedDigest)
      throw new Error('Locked installation differs from reviewed candidate; refusing replacement');
    for (const [file, before] of [['package.json', manifestBytes], ['package-lock.json', lockBytes]]) {
      if (!(await fs.readFile(path.join(project, file))).equals(before) ||
          !(await fs.readFile(path.join(work, file))).equals(before)) throw new Error('Reviewed install inputs changed');
    }
    if (await packageDigest(candidate) !== expectedDigest) throw new Error('Reviewed candidate changed during installation');
    const currentStat = await fs.stat(destination);
    if (currentStat.ino !== originalStat.ino || currentStat.dev !== originalStat.dev ||
        JSON.stringify(await inspectCli(path.join(destination, 'bin/cohub.js'))) !== JSON.stringify(original) ||
        await packageDigest(destination) !== originalDigest) throw new Error('Global installation changed; refusing replacement');
    const backup = path.join(path.dirname(destination), `.${path.basename(destination)}.before-locked-${nonce}`);
    await publishDirectory(destination, staged, backup);
    const installed = await inspectCli(path.join(destination, 'bin/cohub.js'));
    if (JSON.stringify(installed) !== JSON.stringify(expected) || await packageDigest(destination) !== expectedDigest)
      throw new Error(`Post-install verification failed; previous installation retained at ${backup}`);
    await fs.rm(work, { recursive: true });
    await fs.rmdir(staging);
    return { ...installed, destination, backup, lockfileSha256: sha256(lockBytes),
      packageDigest: expectedDigest, matchesReviewedCandidate: true };
  } catch (error) {
    throw new Error(`${error.message}; isolated evidence retained at ${work ?? 'not created'} and ${staging ?? 'not created'}`, { cause: error });
  } finally {
    if ((await readJson(installLock)).nonce === nonce) await fs.unlink(installLock);
  }
}

if (process.argv[1] && await fs.realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { project: { type: 'string' }, 'reviewed-cli': { type: 'string' },
      destination: { type: 'string' }, npm: { type: 'string' }, 'ack-reviewed': { type: 'boolean' } } });
    console.log(JSON.stringify(await installLockedCli({ project: values.project, reviewedCli: values['reviewed-cli'],
      destination: values.destination, npm: values.npm, reviewed: values['ack-reviewed'] === true }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
