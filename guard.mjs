#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { lookup } from 'node:dns/promises';
import os from 'node:os';
import { parseArgs } from 'node:util';

export const CONFIG = Object.freeze({
  home: os.homedir(),
  harnesses: ['codex', 'pi'],
  spaceId: 'example-space',
  identity: 'prod:example-user',
  node: process.execPath,
  cli: '/example/cohub-cli/bin/cohub.js',
  recoveryCli: null,
  compatibilityFile: '/example/guard/baseline.json',
  worker: '/example/cohub-cli/dist/runtime/worker.js',
  codex: '/example/bin/codex',
  pi: '/example/bin/pi',
  directory: path.join(os.homedir(), '.local/state/cohub-runtime-guard/example-space'),
  intervalMs: 30_000,
  probeTimeoutMs: 30_000,
  shareScreen: false,
  unhealthyMs: 120_000,
  cooldownMs: 600_000,
  maxRestartsPerHour: 3,
  graceMs: 30_000,
  // Optional: dispatch existing workspace-ready JSON hooks once per Runtime instance.
  readyHooks: false,
});

// Synthetic target presets are also used by the regression tests. The executable
// always loads an explicit configuration file; these placeholders cannot start it.
export const TARGETS = Object.freeze({
  home: CONFIG,
  'pi-only': Object.freeze({
    ...CONFIG,
    root: path.join(os.homedir(), 'pi-workspace'),
    harnesses: ['pi'],
    spaceId: 'example-pi-space',
    directory: path.join(os.homedir(), '.local/state/cohub-runtime-guard/example-pi-space'),
    readyHooks: true,
    shareScreen: false,
  }),
});

export function configFor(name = 'home') {
  if (!Object.hasOwn(TARGETS, name)) throw new Error(`Unknown target preset: ${name}`);
  return TARGETS[name];
}

export async function loadConfig(file) {
  if (!file) throw new Error('An explicit --config file is required');
  if (process.platform === 'win32') throw new Error('Windows process supervision is not supported');
  const input = await readJson(path.resolve(file));
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('Invalid guard configuration');
  const fields = ['home', 'root', 'spaceId', 'identity', 'node', 'cli', 'recoveryCli', 'compatibilityFile',
    'directory', 'harnesses', 'codex', 'pi', 'shareScreen', 'readyHooks', 'intervalMs', 'probeTimeoutMs',
    'unhealthyMs', 'cooldownMs', 'maxRestartsPerHour', 'graceMs'];
  for (const key of Object.keys(input)) if (!fields.includes(key)) throw new Error(`Unknown configuration field: ${key}`);
  for (const key of ['root', 'spaceId', 'identity', 'cli', 'recoveryCli', 'compatibilityFile', 'directory', 'harnesses'])
    if (!Object.hasOwn(input, key)) throw new Error(`Missing configuration field: ${key}`);
  const config = { ...CONFIG, ...input };
  if (typeof config.spaceId !== 'string' || !config.spaceId.trim() || config.spaceId === CONFIG.spaceId ||
      typeof config.identity !== 'string' || !/^prod:[^\s]+$/.test(config.identity) || config.identity === CONFIG.identity)
    throw new Error('Provide the actual production Space ID and prod:<logtoUserId> identity');
  if (!Array.isArray(config.harnesses) || !config.harnesses.length ||
      config.harnesses.some(h => !['codex', 'pi'].includes(h)) || new Set(config.harnesses).size !== config.harnesses.length)
    throw new Error('Harnesses must be a non-empty unique list containing codex and/or pi');
  const paths = ['home', 'root', 'node', 'cli', 'recoveryCli', 'compatibilityFile', 'directory', ...config.harnesses];
  for (const key of paths)
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key]) || config[key].startsWith('/example/'))
      throw new Error(`Configuration field ${key} must be an explicit absolute path`);
  if (config.recoveryCli === config.cli) throw new Error('The recovery CLI must be a separate reviewed copy');
  const recoveryPath = await fs.realpath(config.recoveryCli);
  let installedPath;
  try { installedPath = await fs.realpath(config.cli); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (installedPath === recoveryPath) throw new Error('The recovery CLI must not link to the global installation');
  for (const key of ['shareScreen', 'readyHooks'])
    if (typeof config[key] !== 'boolean') throw new Error(`Configuration field ${key} must be boolean`);
  if (config.shareScreen && process.platform !== 'darwin') throw new Error('Screen sharing is supported only on macOS');
  for (const key of ['intervalMs', 'probeTimeoutMs', 'unhealthyMs', 'cooldownMs', 'maxRestartsPerHour', 'graceMs'])
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`Configuration field ${key} must be a positive integer`);
  config.worker = path.resolve(path.dirname(config.cli), '../dist/runtime/worker.js');
  return Object.freeze(config);
}

const has = (o, k) => Object.hasOwn(o, k);
export const rootOf = config => config.root ?? config.home;
const sameHarnesses = (a, config) => Array.isArray(a) && [...a].sort().join(',') === [...config.harnesses].sort().join(',');
const initialState = () => ({ version: 1, restarts: [], candidate: null, failureSince: null, checkedAt: null });

export function redact(value) {
  if (typeof value === 'string') return value
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\b(?:sk-|sk_|xai-)[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/([?&](?:token|key|secret|signature|auth)[^=\s]*=)[^&\s"']*/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .slice(0, 1600);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, /token|secret|password|authorization|cookie|nonce/i.test(k) ? '[REDACTED]' : redact(v)]));
  return value;
}

export async function readJson(file, optional = false) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}

// Version labels alone do not prove that unattended startup still preserves consent.
export async function inspectCli(cli) {
  const root = path.resolve(path.dirname(cli), '..');
  const pkg = await readJson(path.join(root, 'package.json'));
  if (pkg.name !== '@neta-art/cohub-cli' || !/^\d+\.\d+\.\d+$/.test(pkg.version) || pkg.type !== 'module')
    throw new Error('CLI compatibility: invalid package identity or release version');
  const files = [];
  const collect = async (relative, recursive) => {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory() && recursive) await collect(name, true);
      else if (/\.(?:[cm]?js|json|node|wasm)$/.test(entry.name)) {
        if (!entry.isFile()) throw new Error(`CLI compatibility: unexpected file type: ${name}`);
        files.push(name);
      }
    }
  };
  await collect('bin', true);
  await collect('dist', false);
  await collect('dist/runtime', true);
  files.push('dist/commands/runtime.js', 'dist/commands/auth.js', 'dist/commands/run.js');
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    const content = await fs.readFile(path.join(root, file));
    hash.update(`${file}\0${content.length}\0`).update(content);
  }
  // Include resolved dependency versions, not just semver ranges in the CLI manifest.
  for (const kind of ['dependencies', 'optionalDependencies']) {
    const deps = pkg[kind] ?? {};
    if (!deps || Array.isArray(deps) || typeof deps !== 'object') throw new Error('CLI compatibility: invalid dependencies');
    for (const name of Object.keys(deps).sort()) {
      if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(name) || typeof deps[name] !== 'string')
        throw new Error('CLI compatibility: invalid dependency');
      const installed = await readJson(path.join(root, 'node_modules', name, 'package.json'), kind === 'optionalDependencies');
      if (installed && (installed.name !== name || typeof installed.version !== 'string'))
        throw new Error('CLI compatibility: invalid installed dependency');
      hash.update(JSON.stringify([kind, name, deps[name], installed?.version ?? null]));
    }
  }
  hash.update(JSON.stringify({ engines: pkg.engines, bin: pkg.bin }));
  return { version: pkg.version, fingerprint: hash.digest('hex') };
}

async function atomicJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(tmp, file);
}

export async function rotate(file, maxBytes = 5 * 1024 * 1024, copies = 3) {
  let info;
  try { info = await fs.stat(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (info.size < maxBytes) return;
  await fs.rm(`${file}.${copies}`, { force: true });
  for (let n = copies - 1; n >= 0; n--) {
    try { await fs.rename(n ? `${file}.${n}` : file, `${file}.${n + 1}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

export function summarizeStatus(raw, config = CONFIG) {
  if (!raw || raw.spaceId !== config.spaceId || !has(raw, 'local') || !has(raw, 'remoteError'))
    throw new Error('Invalid Runtime status; refusing to infer that the process is down');
  const local = raw.local;
  if (local !== null && (!local || !Number.isSafeInteger(local.pid) || local.pid <= 1 ||
      typeof local.runtimeId !== 'string' || typeof local.state !== 'string' ||
      typeof local.harnessConnected !== 'boolean' || typeof local.workspaceConnected !== 'boolean'))
    throw new Error('Invalid local Runtime status');
  let kind;
  if (raw.nativeSyncError) kind = 'config_error';
  else if (local && (local.root !== rootOf(config) || local.spaceId !== config.spaceId || !sameHarnesses(local.harnesses, config))) kind = 'scope_changed';
  else if (raw.remoteError) kind = 'remote_unavailable';
  else if (!raw.remote || typeof raw.remote.online !== 'boolean' ||
      typeof raw.remote.workspace?.online !== 'boolean' ||
      (raw.remote.online && typeof raw.remote.runtimeId !== 'string')) throw new Error('Missing remote Runtime status');
  else if (raw.remote.online && (!local || raw.remote.runtimeId !== local.runtimeId)) kind = 'another_runtime';
  else if (!local) kind = 'process_down';
  else if (local.state === 'ready' && local.harnessConnected && local.workspaceConnected && raw.remote.online && raw.remote.workspace?.online === true) kind = 'healthy';
  else if (['starting', 'reconnecting', 'stopping', 'ready'].includes(local.state)) kind = 'connection_stuck';
  else kind = 'attention';
  return {
    kind, runtimeId: local?.runtimeId ?? null, pid: local?.pid ?? null,
    localState: local?.state ?? null, online: raw.remote?.online ?? null,
    harnessConnected: local?.harnessConnected ?? false,
    workspaceConnected: local?.workspaceConnected ?? false,
    remoteError: redact(raw.remoteError), nativeSyncError: redact(raw.nativeSyncError),
    pendingArchives: raw.pendingLocalArchives, failedArchives: raw.failedLocalArchives,
  };
}

export function startHarnessArgs(config) {
  // Only enable explicitly configured harnesses and their executables.
  const args = config.harnesses.flatMap(h => ['--harness', h]);
  if (config.harnesses.includes('pi')) args.push('--pi', config.pi);
  if (config.harnesses.includes('codex')) args.push('--codex', config.codex);
  return args;
}

export function decide(previous, sample, now, paused, config = CONFIG) {
  const next = { ...previous, checkedAt: now, sample, paused };
  const recoverable = ['process_down', 'connection_stuck'].includes(sample.kind);
  const key = recoverable ? `${sample.kind}:${sample.runtimeId ?? 'absent'}` : null;
  const gap = previous.checkedAt !== null && (now - previous.checkedAt > config.intervalMs * 3 || now < previous.checkedAt);
  if (!key || paused) { next.candidate = null; next.failureSince = null; }
  else if (key !== previous.candidate || gap) { next.candidate = key; next.failureSince = now; }
  next.action = 'observe';
  next.reason = paused ? 'paused' : sample.kind;
  if (!key || paused || now - next.failureSince < config.unhealthyMs) return next;
  const last = previous.restarts.at(-1);
  if (last !== undefined && now - last < config.cooldownMs) next.reason = 'cooldown';
  else if (previous.restarts.filter(t => now - t < 3_600_000).length >= config.maxRestartsPerHour) next.reason = 'rate_limited';
  else { next.action = 'recover'; next.reason = sample.kind; }
  return next;
}

export function safeRuntimeEvents(events) {
  if (!Array.isArray(events)) throw new Error('Invalid Runtime diagnostics');
  const keys = ['code', 'reason', 'durationMs', 'ageMs', 'attempt', 'delayMs', 'outcome',
    'activeExecutions', 'fatal', 'conflict', 'message', 'status', 'connectionAge', 'bytes', 'maxBytes'];
  return events.map(e => redact({
    timestamp: e.timestamp, level: e.level, component: e.component, event: e.event,
    runtimeId: e.runtimeId, connectionId: e.connectionId, sessionId: e.sessionId,
    turnId: e.turnId, harness: e.harness,
    data: Object.fromEntries(keys.filter(k => e.data && has(e.data, k)).map(k => [k, e.data[k]])),
    error: e.error?.message,
  }));
}

async function networkEvidence() {
  const result = [];
  for (const host of ['api.cohub.live', 'gateway.cohub.live']) {
    const entry = { host };
    const started = Date.now();
    let timer;
    try {
      entry.addresses = await Promise.race([lookup(host, { all: true }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), 3000); })]);
    } catch (e) { entry.dnsError = redact(e.message); }
    finally { clearTimeout(timer); }
    try {
      const response = await fetch(`https://${host}/`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(3000) });
      entry.httpStatus = response.status;
      await response.body?.cancel();
    } catch (e) { entry.error = redact(e.message); entry.cause = redact(e.cause?.code ?? e.cause?.message); }
    entry.elapsedMs = Date.now() - started;
    result.push(entry);
  }
  return result;
}

export class Guard {
  constructor(config = CONFIG) {
    this.config = config;
    this.stateFile = path.join(config.directory, 'state.json');
    this.controlFile = path.join(config.directory, 'control.json');
    this.logFile = path.join(config.directory, 'events.jsonl');
    this.nativeFile = path.join(config.home, '.local/state/cohub/runtime', config.spaceId, 'native/config.json');
    const key = createHash('sha256').update(`${config.identity}\0${config.spaceId}`).digest('hex').slice(0, 24);
    this.ownerFile = path.join(config.home, '.local/state/cohub/instances', key, 'owner.json');
    const username = process.env.USER || os.userInfo().username;
    this.env = { HOME: config.home, USER: username, LOGNAME: username, LANG: 'en_US.UTF-8',
      PATH: `${path.dirname(config.node)}:${config.home}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      COHUB_CLI_AUTO_UPDATE: '0', PI_OFFLINE: '1' };
  }
  async init() {
    await fs.mkdir(this.config.directory, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.config.directory, 'incidents'), { recursive: true, mode: 0o700 });
    await rotate(path.join(this.config.directory, 'startup-errors.log'), 1024 * 1024, 2);
  }
  async log(event, data = {}) {
    await rotate(this.logFile);
    await fs.appendFile(this.logFile, JSON.stringify(redact({ time: new Date().toISOString(), event, ...data })) + '\n', { mode: 0o600 });
  }
  command(file, args, timeout = 15_000) {
    return new Promise(resolve => {
      execFile(file, args, { cwd: this.config.home, env: this.env, timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => resolve({ ok: !error, code: error ? error.code ?? error.signal ?? 'UNKNOWN' : 0,
          killed: error?.killed === true, stdout, stderr }));
    });
  }
  cli(args, timeout) { return this.command(this.config.node, [this.config.recoveryCli || this.config.cli, ...args], timeout); }
  async probe() {
    const result = await this.cli(['runtime', 'status', '--space', this.config.spaceId, '--json'], this.config.probeTimeoutMs);
    if (!result.ok && result.killed) throw new Error(`Runtime probe timed out after ${this.config.probeTimeoutMs} ms`);
    if (!result.ok) throw new Error(`Runtime probe failed: ${redact(result.stderr || result.stdout || String(result.code))}`);
    return summarizeStatus(JSON.parse(result.stdout), this.config);
  }
  async paused() {
    const control = await readJson(this.controlFile, true);
    if (control === null) return false;
    if (control.version !== 1 || typeof control.paused !== 'boolean') throw new Error('Invalid guard control file');
    return control.paused;
  }
  async loadState() {
    const state = await readJson(this.stateFile, true);
    if (state === null) return initialState();
    if (state.version !== 1 || !Array.isArray(state.restarts) || state.restarts.some(t => !Number.isFinite(t)) ||
        !(state.checkedAt === null || Number.isFinite(state.checkedAt)) ||
        !(state.failureSince === null || Number.isFinite(state.failureSince)) ||
        !(state.candidate === null || typeof state.candidate === 'string') ||
        !(state.readyRuntimeId === undefined || state.readyRuntimeId === null || typeof state.readyRuntimeId === 'string'))
      throw new Error('Invalid guard state; original file retained');
    return state;
  }
  async save(state) { await atomicJson(this.stateFile, state); }
  async owner() {
    const owner = await readJson(this.ownerFile, true);
    if (owner === null) return null;
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 1 || typeof owner.nonce !== 'string' || !owner.nonce ||
        owner.socket !== path.join(path.dirname(this.ownerFile), 'control.sock')) throw new Error('Invalid Runtime owner record');
    return owner;
  }
  async processIdentity(pid) {
    const result = await this.command('/bin/ps', ['-p', String(pid), '-o', 'uid=,lstart=,command='], 3000);
    if (!result.ok) {
      if (result.code === 1 && !result.stdout.trim() && !result.stderr.trim()) return null;
      throw new Error('Cannot inspect Runtime process identity');
    }
    const text = result.stdout.trim();
    const node = await fs.realpath(this.config.node);
    const workers = [this.config.worker];
    if (this.config.recoveryCli)
      workers.push(path.resolve(path.dirname(this.config.recoveryCli), '../dist/runtime/worker.js'));
    if (!text.startsWith(`${process.getuid()} `) || !workers.some(worker => text.endsWith(`${node} ${worker}`)))
      throw new Error('PID is not the approved Runtime worker');
    return text;
  }
  async preflight() {
    await this.checkCompatibility();
    const native = await readJson(this.nativeFile);
    if (native.version !== 2 || native.identity !== this.config.identity || native.spaceId !== this.config.spaceId ||
        native.root !== rootOf(this.config) || !sameHarnesses(native.harnesses, this.config) || native.codexShared !== false ||
        !Number.isFinite(Date.parse(native.enabledAt))) throw new Error('Native consent/configuration changed; refusing unattended startup');
    const bindings = await readJson(path.join(this.config.home, '.config/cohub/runtime-spaces.json'));
    if (bindings.version !== 1 || !Array.isArray(bindings.bindings) ||
        !bindings.bindings.some(b => b.root === rootOf(this.config) && b.key === this.config.identity && b.spaceId === this.config.spaceId))
      throw new Error('Workspace binding changed');
    const identity = await this.cli(['auth', 'whoami', '--json']);
    if (!identity.ok) throw new Error('Cannot verify Cohub account; no automatic restart');
    const account = JSON.parse(identity.stdout);
    if (account.source !== 'logto' || `prod:${account.user?.profile?.logtoUserId}` !== this.config.identity) throw new Error('Cohub account changed');
  }
  async checkCompatibility() {
    const baseline = await readJson(this.config.compatibilityFile);
    if (baseline.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(baseline.reviewedVersion) ||
        !/^[a-f0-9]{64}$/.test(baseline.fingerprint)) throw new Error('Invalid CLI compatibility baseline');
    const current = await inspectCli(this.config.recoveryCli || this.config.cli);
    if (current.fingerprint !== baseline.fingerprint)
      throw new Error(`CLI compatibility: ${current.version} Runtime/startup code or dependencies changed; review required`);
    const result = { status: 'compatible', ...current, reviewedVersion: baseline.reviewedVersion };
    if (this.config.recoveryCli) {
      result.executionSource = 'reviewed_copy';
      result.cli = this.config.recoveryCli;
      // Global installs can be half-written during an upgrade. Never execute that tree.
      try {
        const installed = await inspectCli(this.config.cli);
        result.installedVersion = installed.version;
        result.upgradeStatus = installed.fingerprint === baseline.fingerprint ? 'compatible' : 'review_required';
      } catch (error) {
        result.upgradeStatus = 'unavailable';
        result.installedError = redact(error.message);
      }
    }
    return result;
  }
  async snapshot(reason, sample) {
    const result = await this.cli(['runtime', 'logs', '--space', this.config.spaceId, '--limit', '1000', '--level', 'debug', '--json']);
    let events = null;
    let diagnosticsError = null;
    if (result.ok) {
      try {
        const all = safeRuntimeEvents(JSON.parse(result.stdout));
        events = all.filter(e => /websocket|heartbeat|reconnect|auth_|connection_failed|execution_transport|runtime\.(ready|available|stopped)|sandboxd\.(connected|disconnected)/.test(e.event) ||
          (e.event === 'sandboxd.log' && /relay control|relay configuration|lease/i.test(e.data?.message + ' ' + e.error))).slice(-200);
      }
      catch (e) { diagnosticsError = redact(e.message); }
    } else diagnosticsError = redact(result.stderr || result.stdout || String(result.code));
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`;
    const directory = path.join(this.config.directory, 'incidents');
    await atomicJson(path.join(directory, name), redact({ reason, sample, events, diagnosticsError,
      network: await this.network(), nodeVersion: process.version,
      cliVersion: (await readJson(path.join(path.dirname(this.config.recoveryCli || this.config.cli), '../package.json'))).version }));
    const names = (await fs.readdir(directory)).filter(n => /^\d{4}-.*\.json$/.test(n)).sort();
    for (const old of names.slice(0, -10)) await fs.unlink(path.join(directory, old));
    await this.log('incident_saved', { reason, file: name, diagnosticsError });
  }
  network() { return networkEvidence(); }
  async recover(sample) {
    await this.preflight();
    if (await this.paused()) return { outcome: 'skipped', reason: 'paused' };
    const fresh = await this.probe();
    if (fresh.kind !== sample.kind || fresh.pid !== sample.pid || fresh.runtimeId !== sample.runtimeId)
      return { outcome: 'skipped', reason: 'Runtime changed since probe' };
    const owner = await this.owner();
    if (sample.pid) {
      if (!owner || owner.pid !== sample.pid) throw new Error('Runtime ownership changed before stop');
      const identity = await this.processIdentity(sample.pid);
      if (!identity) return { outcome: 'skipped', reason: 'Process exited before stop' };
      await this.log('stop_requested', { pid: sample.pid, runtimeId: sample.runtimeId });
      const deadline = Date.now() + this.config.graceMs;
      const stopped = await this.cli(['runtime', 'down', '--space', this.config.spaceId, '--yes', '--json'], this.config.graceMs);
      await this.log('graceful_stop', { ok: stopped.ok, code: stopped.code, error: stopped.ok ? null : redact(stopped.stderr || stopped.stdout) });
      while (await this.processIdentity(sample.pid)) {
        if (Date.now() >= deadline) break;
        await sleep(500);
      }
      const remaining = await this.processIdentity(sample.pid);
      if (remaining) {
        const current = await this.owner();
        if (!current || current.pid !== owner.pid || current.nonce !== owner.nonce || remaining !== identity)
          throw new Error('Runtime process was replaced; refusing to kill');
        const children = await this.command('/bin/ps', ['-axo', 'pid=,ppid='], 3000);
        if (!children.ok) throw new Error('Cannot verify Runtime child processes');
        if (children.stdout.trim().split('\n').some(line => Number(line.trim().split(/\s+/)[1]) === sample.pid))
          throw new Error('Runtime still has child processes; refusing to orphan them');
        // Never signal a process group or a PID inferred only from a stale status file.
        if (await this.processIdentity(sample.pid) !== identity) throw new Error('Runtime identity changed before forced stop');
        process.kill(sample.pid, 'SIGKILL');
        await this.log('forced_stop', { pid: sample.pid, runtimeId: sample.runtimeId });
        for (let n = 0; n < 20 && await this.processIdentity(sample.pid); n++) await sleep(250);
        if (await this.processIdentity(sample.pid)) throw new Error('Runtime did not exit');
      }
    } else if (owner && await this.processIdentity(owner.pid)) {
      throw new Error('Owner process still exists but status is unavailable; refusing duplicate startup');
    }
    await this.preflight();
    const beforeStart = await this.probe();
    if (beforeStart.kind !== 'process_down') return { outcome: 'skipped', reason: `Startup no longer safe: ${beforeStart.kind}` };
    // The reviewed startup code reuses matching native consent without importing history.
    // Screen sharing must be explicitly enabled in the guard configuration.
    const start = await this.cli(['runtime', 'up', rootOf(this.config), '--space', this.config.spaceId,
      ...startHarnessArgs(this.config), ...(this.config.shareScreen ? ['--display', 'macos'] : ['--no-display']),
      '-d', '--yes', '--json'], 90_000);
    await this.log('start_finished', { ok: start.ok, code: start.code, error: start.ok ? null : redact(start.stderr || start.stdout) });
    const after = await this.probe();
    if (after.kind !== 'healthy') throw new Error(`Startup not verified: ${after.kind}`);
    return { outcome: 'recovered', pid: after.pid, runtimeId: after.runtimeId };
  }
  async runReadyHooks() {
    // Mirrors the platform's space.workspace.ready dispatch for a local Runtime: JSON hooks in the Space
    // root, each `run` queued as a command task in the Space with the curated COHUB_HOOK_* environment.
    const directory = path.join(rootOf(this.config), '.cohub/hooks');
    let names;
    try { names = (await fs.readdir(directory)).sort(); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const results = [];
    for (const name of names) {
      if (!name.endsWith('.json')) {
        if (/\.ya?ml$/.test(name)) results.push({ hook: name, outcome: 'skipped', reason: 'YAML hooks are not run by the guard' });
        continue;
      }
      const file = path.join(directory, name);
      const info = await fs.lstat(file);
      if (!info.isFile()) { results.push({ hook: name, outcome: 'skipped', reason: 'not a regular file' }); continue; }
      let hook;
      try { hook = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (e) { results.push({ hook: name, outcome: 'invalid', error: redact(e.message) }); continue; }
      if (hook?.on?.event !== 'space.workspace.ready') continue;
      if (hook.schema !== 'cohub.space-hook.v1' || typeof hook.run !== 'string' || !hook.run.trim()) {
        results.push({ hook: name, outcome: 'invalid', error: 'missing run command or unknown schema' }); continue;
      }
      const env = `COHUB_HOOK_SPACE_ID=${this.config.spaceId} COHUB_HOOK_EVENT_TYPE=space.workspace.ready COHUB_HOOK_SESSION_ID= COHUB_HOOK_TURN_ID=`;
      const queued = await this.cli(['-s', this.config.spaceId, 'run', '--async', '--json', '--command', `${env} ${hook.run}`], 30_000);
      let taskRunId = null;
      try { taskRunId = queued.ok ? JSON.parse(queued.stdout).taskRunId ?? null : null; } catch { taskRunId = null; }
      results.push(queued.ok && taskRunId ? { hook: name, outcome: 'queued', taskRunId }
        : { hook: name, outcome: 'failed', error: redact(queued.stderr || queued.stdout || String(queued.code)) });
    }
    return results;
  }
  async tick(state) {
    const paused = await this.paused();
    let sample;
    let compatibility;
    try { compatibility = await this.checkCompatibility(); }
    catch (e) { compatibility = { status: 'review_required', error: redact(e.message) }; }
    if (JSON.stringify(compatibility) !== JSON.stringify(state.compatibility))
      await this.log('cli_compatibility', compatibility);
    if (compatibility.status !== 'compatible') sample = { kind: 'compatibility_error', error: compatibility.error };
    else {
      try { sample = await this.probe(); }
      catch (e) { sample = { kind: 'probe_error', error: redact(e.message) }; }
    }
    const next = decide(state, sample, Date.now(), paused, this.config);
    next.guardPid = process.pid;
    next.compatibility = compatibility;
    await this.save(next);
    await this.log('health', { paused, sample, decision: next.reason });
    if (sample.kind !== 'healthy' && sample.kind !== 'compatibility_error' && sample.kind !== state.sample?.kind)
      await this.snapshot(sample.kind, sample);
    if (this.config.readyHooks && sample.kind === 'healthy' && sample.runtimeId !== state.readyRuntimeId) {
      next.readyRuntimeId = sample.runtimeId;
      next.lastReadyHooks = { at: new Date().toISOString(), runtimeId: sample.runtimeId, results: await this.runReadyHooks() };
      await this.save(next);
      await this.log('ready_hooks', next.lastReadyHooks);
    }
    if (next.action === 'recover') {
      // Evidence and the rate-limit record must be durable before any destructive action.
      await this.snapshot('before_recovery', sample);
      next.restarts = [...next.restarts.filter(t => Date.now() - t < 3_600_000), Date.now()];
      next.lastRecovery = { at: new Date().toISOString(), outcome: 'started' };
      await this.save(next);
      try { next.lastRecovery = { ...next.lastRecovery, ...await this.recover(sample) }; }
      catch (e) { next.lastRecovery = { ...next.lastRecovery, outcome: 'failed', error: redact(e.message) }; }
      next.candidate = null;
      next.failureSince = null;
      await this.log('recovery_finished', next.lastRecovery);
      await this.save(next);
    }
    return next;
  }
}

export async function acquireLock(directory) {
  const file = path.join(directory, 'lock.json');
  const value = { pid: process.pid, nonce: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = await fs.open(file, 'wx', 0o600);
      try { await fd.writeFile(JSON.stringify(value)); } finally { await fd.close(); }
      return async () => {
        const current = await readJson(file, true);
        if (current?.nonce === value.nonce) await fs.unlink(file);
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const old = await readJson(file);
      if (!Number.isSafeInteger(old.pid) || old.pid <= 1 || typeof old.nonce !== 'string') throw new Error('Invalid guard lock; retained');
      try { process.kill(old.pid, 0); throw new Error('Guard already running (or lock PID is occupied)'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      if (JSON.stringify(await readJson(file)) !== JSON.stringify(old)) throw new Error('Guard lock changed');
      await fs.unlink(file);
    }
  }
  throw new Error('Cannot acquire guard lock');
}

async function main(command, file) {
  if (!['status', 'check', 'pause', 'resume', 'run'].includes(command)) throw new Error('Unknown guard command');
  const guard = new Guard(await loadConfig(file));
  await guard.init();
  if (command === 'pause' || command === 'resume') {
    await atomicJson(guard.controlFile, { version: 1, paused: command === 'pause', updatedAt: new Date().toISOString() });
    console.log(command === 'pause' ? 'New recoveries paused; monitoring continues and in-flight recovery finishes.' : 'Recovery enabled for the next check.');
    return;
  }
  if (command === 'status') {
    const state = await guard.loadState();
    console.log(JSON.stringify({ ...state, paused: await guard.paused(), stale: state.checkedAt === null || Date.now() - state.checkedAt > 120_000 }, null, 2));
    return;
  }
  if (command === 'check') {
    await guard.preflight();
    console.log(JSON.stringify({ ...await guard.probe(), compatibility: await guard.checkCompatibility() }, null, 2));
    return;
  }
  const unlock = await acquireLock(guard.config.directory);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await guard.loadState();
    await guard.log('guard_started', { pid: process.pid, spaceId: guard.config.spaceId });
    while (!controller.signal.aborted) {
      try { await guard.tick(await guard.loadState()); }
      catch (e) { await guard.log('monitor_error', { error: redact(e.message) }); }
      await sleep(guard.config.intervalMs, undefined, { signal: controller.signal }).catch(e => { if (e.name !== 'AbortError') throw e; });
    }
    await guard.log('guard_stopped');
  } finally { await unlock(); }
}

if (process.argv[1] && await fs.realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ options: { config: { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: true });
    if (values.help) console.log('Usage: node guard.mjs <status|check|pause|resume|run> --config ./config.local.json');
    else {
      if (positionals.length !== 1) throw new Error('Supply exactly one guard command; use --help for usage');
      await main(positionals[0], values.config);
    }
  } catch (e) { console.error(redact(e.message)); process.exitCode = 1; }
}
