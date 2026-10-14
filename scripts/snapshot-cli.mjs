#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { inspectCli } from '../guard.mjs';

async function requireAbsent(file) {
  try { await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`Destination already exists; refusing overwrite: ${file}`);
}
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

export async function createSnapshot({ source, destination, baseline, reviewed }) {
  if (reviewed !== true) throw new Error('Review the installed CLI and explicitly acknowledge it with --ack-reviewed');
  for (const [key, value] of Object.entries({ source, destination, baseline }))
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${key} must be an absolute path`);
  source = await fs.realpath(source);
  const destinationParent = await fs.realpath(path.dirname(destination));
  const baselineParent = await fs.realpath(path.dirname(baseline));
  destination = path.join(destinationParent, path.basename(destination));
  baseline = path.join(baselineParent, path.basename(baseline));
  if (within(source, destination) || within(destination, source) || within(source, baseline) || within(destination, baseline))
    throw new Error('Source, snapshot and baseline paths must not overlap');
  await requireAbsent(destination);
  await requireAbsent(baseline);
  const original = await inspectCli(path.join(source, 'bin/cohub.js'));
  const staging = `${destination}.partial-${randomUUID()}`;
  await fs.mkdir(staging, { mode: 0o700 });
  // Node 22 rejects an existing destination directory with errorOnExist.
  const copiedRoot = path.join(staging, 'package');
  await fs.cp(source, copiedRoot, { recursive: true, dereference: true, errorOnExist: true, force: false });
  const copied = await inspectCli(path.join(copiedRoot, 'bin/cohub.js'));
  const after = await inspectCli(path.join(source, 'bin/cohub.js'));
  if (JSON.stringify(original) !== JSON.stringify(copied) || JSON.stringify(original) !== JSON.stringify(after))
    throw new Error(`CLI changed during snapshot; partial copy retained at ${staging}`);
  await requireAbsent(destination);
  await fs.rename(copiedRoot, destination);
  await fs.writeFile(baseline, JSON.stringify({ schemaVersion: 1, reviewedVersion: copied.version, fingerprint: copied.fingerprint }, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  await fs.rmdir(staging);
  return { recoveryCli: path.join(destination, 'bin/cohub.js'), compatibilityFile: baseline, ...copied };
}

if (process.argv[1] && await fs.realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { source: { type: 'string' }, destination: { type: 'string' },
      baseline: { type: 'string' }, 'ack-reviewed': { type: 'boolean' }, help: { type: 'boolean' } } });
    if (values.help) console.log('Usage: node scripts/snapshot-cli.mjs --source /installed/cohub-cli --destination /private/reviewed-cli --baseline /private/baseline.json --ack-reviewed');
    else console.log(JSON.stringify(await createSnapshot({ ...values, reviewed: values['ack-reviewed'] === true }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
