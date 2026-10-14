import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSnapshot } from '../scripts/snapshot-cli.mjs';
import { inspectCli } from '../guard.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-snapshot-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  for (const dir of ['bin', 'dist/runtime', 'dist/commands']) await fs.mkdir(path.join(source, dir), { recursive: true });
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: '@neta-art/cohub-cli', version: '10.1.0', type: 'module' }));
  await fs.writeFile(path.join(source, 'bin/cohub.js'), 'throw Error("Snapshot must never execute this file");\n');
  await fs.writeFile(path.join(source, 'dist/runtime/worker.js'), '// synthetic worker\n');
  for (const cmd of ['runtime', 'auth', 'run']) await fs.writeFile(path.join(source, 'dist/commands', cmd + '.js'), '// fixture\n');
  return { source, destination: path.join(root, 'reviewed-cli'), baseline: path.join(root, 'baseline.json'), reviewed: true };
}

test('snapshot copies trusted files without executing them and records a matching baseline', async t => {
  const config = await fixture(t);
  const result = await createSnapshot(config);
  assert.equal(result.version, '10.1.0');
  assert.deepEqual(await inspectCli(result.recoveryCli), { version: result.version, fingerprint: result.fingerprint });
  assert.equal(JSON.parse(await fs.readFile(config.baseline)).fingerprint, result.fingerprint);
  await fs.writeFile(path.join(config.source, 'bin/cohub.js'), '// global upgrade\n');
  assert.equal((await inspectCli(result.recoveryCli)).fingerprint, result.fingerprint);
});

test('snapshot requires explicit review and never overwrites existing evidence', async t => {
  const config = await fixture(t);
  await assert.rejects(createSnapshot({ ...config, reviewed: false }), /ack-reviewed/);
  await fs.writeFile(config.baseline, '{broken');
  await assert.rejects(createSnapshot(config), /refusing overwrite/);
  assert.equal(await fs.readFile(config.baseline, 'utf8'), '{broken');
});

test('snapshot rejects overlapping, relative and invalid source paths', async t => {
  const config = await fixture(t);
  await assert.rejects(createSnapshot({ ...config, source: './relative' }), /absolute path/);
  await assert.rejects(createSnapshot({ ...config, destination: path.join(config.source, 'snapshot') }), /overlap/);
  await fs.writeFile(path.join(config.source, 'package.json'), '{bad');
  await assert.rejects(createSnapshot(config), SyntaxError);
  await assert.rejects(fs.access(config.destination), { code: 'ENOENT' });
});
