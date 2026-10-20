import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installLockedCli, packageDigest, publishDirectory } from '../scripts/install-locked-cli.mjs';
import { inspectCli } from '../guard.mjs';

const exec = promisify(execFile);
const sri = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const json = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-locked-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'cli-source/package');
  const generation = path.join(root, 'generation-source/package');
  for (const dir of ['bin', 'dist/runtime', 'dist/commands']) await fs.mkdir(path.join(cli, dir), { recursive: true });
  await fs.mkdir(generation, { recursive: true });
  const scripts = { postinstall: 'node -e "process.exit(71)"' };
  await json(path.join(cli, 'package.json'), { name: '@neta-art/cohub-cli', version: '10.6.0', type: 'module',
    dependencies: { '@neta-art/generation': '^0.1.39' }, bin: { cohub: 'bin/cohub.js' }, scripts });
  await fs.writeFile(path.join(cli, 'bin/cohub.js'), 'throw new Error("Installing must not run the CLI");\n');
  await fs.writeFile(path.join(cli, 'dist/runtime/worker.js'), '// fixture worker\n');
  for (const name of ['runtime', 'auth', 'run']) await fs.writeFile(path.join(cli, `dist/commands/${name}.js`), '// fixture\n');
  await json(path.join(generation, 'package.json'), { name: '@neta-art/generation', version: '0.1.39',
    type: 'module', bin: { 'neta-generation': 'index.js' }, scripts });
  await fs.writeFile(path.join(generation, 'index.js'), 'export const reviewed = 39;\n');
  for (const name of ['cli', 'generation'])
    await exec('tar', ['-czf', path.join(root, `${name}.tgz`), '-C', path.join(root, `${name}-source`), 'package'],
      { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const project = path.join(root, 'review-project');
  await fs.mkdir(project);
  const manifest = { dependencies: { '@neta-art/cohub-cli': 'file:../cli.tgz' } };
  const lock = { name: 'review-project', lockfileVersion: 3, requires: true, packages: {
    '': manifest,
    'node_modules/@neta-art/cohub-cli': { version: '10.6.0', resolved: 'file:../cli.tgz',
      integrity: sri(await fs.readFile(path.join(root, 'cli.tgz'))), hasInstallScript: true,
      dependencies: { '@neta-art/generation': '^0.1.39' }, bin: { cohub: 'bin/cohub.js' } },
    'node_modules/@neta-art/generation': { version: '0.1.39',
      resolved: 'https://registry.npmjs.org/@neta-art/generation/-/generation-0.1.39.tgz',
      integrity: sri(await fs.readFile(path.join(root, 'generation.tgz'))), hasInstallScript: true,
      bin: { 'neta-generation': 'index.js' } },
  } };
  await json(path.join(project, 'package.json'), manifest);
  await json(path.join(project, 'package-lock.json'), lock);
  const candidate = path.join(root, 'reviewed-candidate');
  await fs.cp(cli, candidate, { recursive: true });
  await fs.cp(generation, path.join(candidate, 'node_modules/@neta-art/generation'), { recursive: true });
  const destination = path.join(root, 'global-cli');
  await fs.cp(candidate, destination, { recursive: true });
  const depFile = path.join(destination, 'node_modules/@neta-art/generation/package.json');
  await json(depFile, { ...JSON.parse(await fs.readFile(depFile)), version: '0.1.40' });
  const cache = path.join(root, 'cache');
  await exec('npm', ['cache', 'add', path.join(root, 'generation.tgz'), '--cache', cache,
    '--offline', '--ignore-scripts', '--update-notifier=false'], { timeout: 30_000 });
  const npm = path.join(root, 'locked-npm');
  // The real npm runs offline with a private, fixture-only cache.
  await fs.writeFile(npm, `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
fs.writeFileSync(${JSON.stringify(path.join(root, 'npm-args.json'))}, JSON.stringify(process.argv.slice(2)));
const result = spawnSync('npm', [...process.argv.slice(2), '--cache', ${JSON.stringify(cache)}, '--offline'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  return { root, candidate, lock, config: { project, reviewedCli: path.join(candidate, 'bin/cohub.js'),
    destination, reviewed: true, npm } };
}

test('real offline npm ci restores 0.1.39 without resolving 0.1.40 or running install hooks', async t => {
  const { root, candidate, config } = await fixture(t);
  const lockBefore = await fs.readFile(path.join(config.project, 'package-lock.json'));
  const before = await inspectCli(path.join(config.destination, 'bin/cohub.js'));
  const expected = await inspectCli(config.reviewedCli);
  assert.notEqual(before.fingerprint, expected.fingerprint);
  const result = await installLockedCli(config);
  assert.equal(result.matchesReviewedCandidate, true);
  assert.equal(result.fingerprint, expected.fingerprint);
  assert.equal(await packageDigest(config.destination), await packageDigest(candidate));
  assert.equal((await inspectCli(path.join(result.backup, 'bin/cohub.js'))).fingerprint, before.fingerprint);
  const dependency = JSON.parse(await fs.readFile(path.join(config.destination, 'node_modules/@neta-art/generation/package.json')));
  assert.equal(dependency.version, '0.1.39');
  assert.deepEqual(await fs.readFile(path.join(config.project, 'package-lock.json')), lockBefore);
  const args = JSON.parse(await fs.readFile(path.join(root, 'npm-args.json')));
  assert.equal(args[0], 'ci');
  assert.ok(args.includes('--ignore-scripts'));
  assert.ok(!args.includes('install') && !args.includes('--global'));
  assert.equal(await fs.readlink(path.join(config.destination, 'node_modules/.bin/neta-generation')), '../@neta-art/generation/index.js');
  assert.deepEqual((await fs.readdir(root)).filter(name => /baseline|compatibility/.test(name)), []);
});

test('a different resolved dependency cannot silently become the reviewed candidate', async t => {
  const { config } = await fixture(t);
  const file = path.resolve(path.dirname(config.reviewedCli), '../node_modules/@neta-art/generation/package.json');
  await json(file, { ...JSON.parse(await fs.readFile(file)), version: '0.1.40' });
  const before = await packageDigest(config.destination);
  await assert.rejects(installLockedCli(config), /differs from reviewed candidate/);
  assert.equal(await packageDigest(config.destination), before);
});

test('same-version dependency code changes are rejected, not hidden by the version fingerprint', async t => {
  const { candidate, config } = await fixture(t);
  await fs.appendFile(path.join(candidate, 'node_modules/@neta-art/generation/index.js'), '// unreviewed mutation\n');
  const before = await packageDigest(config.destination);
  await assert.rejects(installLockedCli(config), /differs from reviewed candidate/);
  assert.equal(await packageDigest(config.destination), before);
});

test('failed npm ci preserves global package, source lockfile and failed staging evidence', async t => {
  const { root, lock, config } = await fixture(t);
  lock.packages['node_modules/@neta-art/generation'].integrity = sri(Buffer.from('not the cached archive'));
  await json(path.join(config.project, 'package-lock.json'), lock);
  const before = await packageDigest(config.destination);
  const lockBefore = await fs.readFile(path.join(config.project, 'package-lock.json'));
  await assert.rejects(installLockedCli(config), /isolated evidence retained/);
  assert.equal(await packageDigest(config.destination), before);
  assert.deepEqual(await fs.readFile(path.join(config.project, 'package-lock.json')), lockBefore);
  assert.ok((await fs.readdir(root)).some(name => name.startsWith('.cohub-locked-ci-')));
});

test('unreviewed inputs, missing integrity, overlaps and concurrent installs fail before npm', async t => {
  const { root, lock, config } = await fixture(t);
  await assert.rejects(installLockedCli({ ...config, reviewed: false }), /ack-reviewed/);
  await assert.rejects(installLockedCli({ ...config, destination: path.dirname(path.dirname(config.reviewedCli)) }), /overlap/);
  await fs.writeFile(`${config.destination}.locked-install`, 'occupied');
  await assert.rejects(installLockedCli(config), { code: 'EEXIST' });
  assert.equal(await fs.readFile(`${config.destination}.locked-install`, 'utf8'), 'occupied');
  delete lock.packages['node_modules/@neta-art/generation'].integrity;
  await json(path.join(config.project, 'package-lock.json'), lock);
  await assert.rejects(installLockedCli(config), /integrity/);
  await assert.rejects(fs.access(path.join(root, 'npm-args.json')), { code: 'ENOENT' });
});

test('a failed publication restores the previous directory without deleting the prepared copy', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-publish-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'global');
  const staged = path.join(root, 'staged');
  const backup = path.join(root, 'backup');
  await fs.mkdir(destination);
  await fs.mkdir(staged);
  await fs.writeFile(path.join(destination, 'version'), 'old');
  await fs.writeFile(path.join(staged, 'version'), 'new');
  await assert.rejects(publishDirectory(destination, staged, backup, async (from, to) => {
    if (from === staged) throw new Error('simulated publish failure');
    await fs.rename(from, to);
  }), /previous installation restored/);
  assert.equal(await fs.readFile(path.join(destination, 'version'), 'utf8'), 'old');
  assert.equal(await fs.readFile(path.join(staged, 'version'), 'utf8'), 'new');
});
