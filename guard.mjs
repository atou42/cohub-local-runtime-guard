#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { lookup } from 'node:dns/promises';
import os from 'node:os';
import { createConnection } from 'node:net';
import { parseArgs } from 'node:util';
import { resolveNetworkPolicy, probeProxy, assessNetwork, NetworkConfigurationError } from './network-env.mjs';

export const CONFIG = Object.freeze({
  home: os.homedir(),
  harnesses: ['codex', 'pi'],
  codexShared: false,
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
  intervalMs: 10_000,
  probeTimeoutMs: 30_000,
  shareScreen: false,
  unhealthyMs: 120_000,
  executionDisconnectMs: 20_000,
  retryBaseMs: 5_000,
  retryMaxMs: 60_000,
  graceMs: 30_000,
  // Optional: dispatch existing workspace-ready JSON hooks once per Runtime instance.
  readyHooks: false,
  stateLayout: 'standard',
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
  // Read old deployed configurations without retaining their removed recovery limits.
  const retired = ['cooldownMs', 'maxRestartsPerHour', 'resumeRetryMs', 'maxResumeAttempts',
    'escalationIntervalMs', 'staleHeartbeatMs'];
  const fields = ['home', 'root', 'spaceId', 'identity', 'node', 'cli', 'recoveryCli', 'compatibilityFile',
    'directory', 'harnesses', 'codex', 'pi', 'codexShared', 'shareScreen', 'readyHooks', 'intervalMs', 'probeTimeoutMs',
    'unhealthyMs', 'executionDisconnectMs', 'graceMs', 'stateLayout', 'retryBaseMs', 'retryMaxMs', ...retired];
  for (const key of Object.keys(input)) if (!fields.includes(key)) throw new Error(`Unknown configuration field: ${key}`);
  for (const key of ['root', 'spaceId', 'identity', 'cli', 'recoveryCli', 'compatibilityFile', 'directory', 'harnesses'])
    if (!Object.hasOwn(input, key)) throw new Error(`Missing configuration field: ${key}`);
  const config = { ...CONFIG, ...input };
  for (const key of retired) {
    if (Object.hasOwn(input, key) && (!Number.isSafeInteger(input[key]) || input[key] <= 0))
      throw new Error(`Retired configuration field ${key} must be a positive integer when present`);
    delete config[key];
  }
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
  for (const key of ['codexShared', 'shareScreen', 'readyHooks'])
    if (typeof config[key] !== 'boolean') throw new Error(`Configuration field ${key} must be boolean`);
  if (config.codexShared && !config.harnesses.includes('codex'))
    throw new Error('Shared Codex control requires the codex harness');
  if (config.shareScreen && process.platform !== 'darwin') throw new Error('Screen sharing is supported only on macOS');
  stateNames(config.stateLayout);
  for (const key of ['intervalMs', 'probeTimeoutMs', 'unhealthyMs', 'executionDisconnectMs', 'graceMs', 'retryBaseMs', 'retryMaxMs'])
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`Configuration field ${key} must be a positive integer`);
  if (config.retryBaseMs > config.retryMaxMs || config.retryMaxMs > 60_000)
    throw new Error('Retry backoff must satisfy retryBaseMs <= retryMaxMs <= 60000');
  config.worker = path.resolve(path.dirname(config.cli), '../dist/runtime/worker.js');
  return Object.freeze(config);
}

export function stateNames(layout = 'standard') {
  if (layout === 'standard') return { state: 'state.json', control: 'control.json', events: 'events.jsonl',
    incidents: 'incidents', startup: 'startup-errors.log', lock: 'lock.json' };
  if (layout === 'legacy-zh') return { state: '状态.json', control: '控制.json', events: '事件.jsonl',
    incidents: '故障', startup: '启动错误.log', lock: '守护锁.json' };
  throw new Error('Unknown stateLayout; use standard or legacy-zh');
}

export const CLI_CONTRACT = 'cohub-runtime-guard/v2';

const has = (o, k) => Object.hasOwn(o, k);
export const rootOf = config => config.root ?? config.home;
const sameHarnesses = (a, config) => Array.isArray(a) && [...a].sort().join(',') === [...config.harnesses].sort().join(',');
const initialState = () => ({ version: 1, restarts: [], candidate: null, failureSince: null, checkedAt: null });

// Serialized into an isolated child using the reviewed CLI's client and normal proxy environment.
async function readRemoteRecord(cli, spaceId) {
  try {
    const path = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    if (!cli || !path.isAbsolute(cli) || !spaceId) throw new Error('Invalid probe arguments');
    const { createClient } = await import(pathToFileURL(path.resolve(path.dirname(cli), '../dist/client.js')).href);
    const result = await createClient().space(spaceId).sandbox.get();
    if (!result || !Object.hasOwn(result, 'sandbox')) throw new Error('Missing sandbox record');
    const record = result.sandbox;
    if (record !== null && (typeof record !== 'object' || Array.isArray(record))) throw new Error('Invalid sandbox record');
    const fields = ['provider', 'status', 'runtimeStatus', 'lastHeartbeatAt', 'stopReason'];
    const projected = record === null ? null : Object.fromEntries(fields.map(key => {
      const value = record[key];
      if (value != null && typeof value !== 'string') throw new Error('Invalid sandbox field');
      return [key, value ?? null];
    }));
    console.log(JSON.stringify(projected));
  } catch {
    console.error('Remote lifecycle record unavailable or malformed');
    process.exitCode = 1;
  }
}

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
  if (raw.remote && ((raw.remote.runtimeId != null && (typeof raw.remote.runtimeId !== 'string' || !raw.remote.runtimeId)) ||
      (raw.remote.observedAt != null && (typeof raw.remote.observedAt !== 'string' || !Number.isFinite(Date.parse(raw.remote.observedAt))))))
    throw new Error('Invalid remote Runtime identity or observation time');
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
    remoteRuntimeId: raw.remote?.runtimeId ?? null,
    remoteWorkspaceOnline: raw.remote?.workspace?.online ?? null,
    remoteObservedAt: raw.remote?.observedAt ?? null,
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

export function retryDelay(attempts, config = CONFIG) {
  return Math.min(config.retryMaxMs, config.retryBaseMs *
    2 ** Math.min(Math.max(0, attempts - 1), Math.ceil(Math.log2(config.retryMaxMs / config.retryBaseMs))));
}

export function decide(previous, sample, now, paused, config = CONFIG) {
  const next = { ...previous, checkedAt: now, sample, paused, nextEligibleAt: null, recoveryMode: null };
  const recoverable = ['process_down', 'connection_stuck', 'shared_server_down'].includes(sample.kind);
  const fast = sample.kind === 'connection_stuck' && sample.transportFailure?.code === 1006 &&
    Number.isSafeInteger(sample.transportFailure.activeExecutions) && sample.transportFailure.activeExecutions > 0 &&
    Number.isFinite(sample.transportFailure.closedAt);
  const key = recoverable ? `${sample.kind}:${sample.runtimeId ?? 'absent'}${fast ? `:1006:${sample.transportFailure.closedAt}` : ''}` : null;
  const gap = previous.checkedAt !== null && (now - previous.checkedAt > config.intervalMs * 3 || now < previous.checkedAt);
  if (!key || paused) { next.candidate = null; next.failureSince = null; }
  else if (key !== previous.candidate || gap) { next.candidate = key; next.failureSince = now; }
  next.action = 'observe';
  next.reason = paused ? 'paused' : sample.kind;
  const pending = previous.pendingRecovery;
  if (sample.kind === 'healthy') next.retry = null;
  // Old journals may contain a 15-minute nextAttemptAt. Recompute only the short delay.
  const retry = next.retry ?? pending;
  const retryAt = retry ? retry.lastAttemptAt + retryDelay(retry.attempts, config) : null;
  if (pending && !paused) {
    const ownLease = sample.kind === 'another_runtime' && !sample.pid && pending.sourcePid &&
      sample.remoteRuntimeId === pending.sourceRuntimeId;
    if ((!ownLease && sample.kind === 'another_runtime') || (sample.remoteRuntimeId && sample.remoteRuntimeId !== pending.sourceRuntimeId &&
        sample.remoteRuntimeId !== sample.runtimeId)) {
      next.reason = 'recovery_conflict';
      return next;
    }
    if (ownLease || (recoverable && (!sample.pid || (sample.pid === pending.sourcePid && sample.runtimeId === pending.sourceRuntimeId)))) {
      if (ownLease) next.candidate = `process_down:${pending.sourceRuntimeId}`;
      next.nextEligibleAt = retryAt;
      next.reason = 'retry_backoff';
      if (now >= retryAt) {
        next.action = 'recover';
        next.reason = 'resume_recovery';
        next.recoveryMode = 'resume';
      }
      return next;
    }
    return next;
  }
  const confirmationMs = fast ? Math.min(config.unhealthyMs, config.executionDisconnectMs) : config.unhealthyMs;
  if (!key || paused || (retry?.candidate !== key && now - next.failureSince < confirmationMs)) return next;
  if (retryAt !== null && now < retryAt) {
    next.reason = 'retry_backoff';
    next.nextEligibleAt = retryAt;
  } else {
    next.action = 'recover'; next.reason = sample.kind; next.recoveryMode = 'normal';
  }
  return next;
}

export function executionDisconnect(events, sample, now = Date.now()) {
  if (!Array.isArray(events)) throw new Error('Invalid Runtime diagnostics');
  if (sample.kind !== 'connection_stuck') return null;
  // Only the current instance's latest lifecycle event can accelerate recovery.
  const relevant = events.filter(e => e?.runtimeId === sample.runtimeId &&
    /^(runtime\.ready|runtime\.websocket\.(closed|rejected)|runtime\.auth_(required|token_failed))$/.test(e.event));
  for (const e of relevant)
    if (!Number.isFinite(Date.parse(e.timestamp))) throw new Error('Invalid Runtime diagnostic timestamp');
  relevant.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const last = relevant.at(-1);
  const at = Date.parse(last?.timestamp);
  if (!last || last.event !== 'runtime.websocket.closed' || last.data?.code !== 1006 ||
      last.data.fatal !== false || last.data.conflict !== false ||
      !Number.isSafeInteger(last.data.activeExecutions) || last.data.activeExecutions < 1 ||
      at > now || now - at > 15 * 60_000) return null;
  return { code: 1006, activeExecutions: last.data.activeExecutions, closedAt: at };
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

async function networkEvidence(httpProbe) {
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
      Object.assign(entry, await httpProbe(`https://${host}/`));
    } catch (e) { entry.error = redact(e.message); entry.cause = redact(e.cause?.code ?? e.cause?.message); }
    entry.elapsedMs = Date.now() - started;
    result.push(entry);
  }
  return result;
}

export class Guard {
  constructor(config = CONFIG) {
    this.config = config;
    this.now = () => Date.now();
    this.notify = notice => console.error(JSON.stringify(redact({ event: 'recovery_blocked', ...notice })));
    this.names = stateNames(config.stateLayout);
    this.stateFile = path.join(config.directory, this.names.state);
    this.controlFile = path.join(config.directory, this.names.control);
    this.logFile = path.join(config.directory, this.names.events);
    this.nativeFile = path.join(config.home, '.local/state/cohub/runtime', config.spaceId, 'native/config.json');
    const key = createHash('sha256').update(`${config.identity}\0${config.spaceId}`).digest('hex').slice(0, 24);
    this.ownerFile = path.join(config.home, '.local/state/cohub/instances', key, 'owner.json');
    const username = process.env.USER || os.userInfo().username;
    this.env = { HOME: config.home, USER: username, LOGNAME: username, LANG: 'en_US.UTF-8',
      PATH: `${path.dirname(config.node)}:${config.home}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      COHUB_CLI_AUTO_UPDATE: '0', PI_OFFLINE: '1' };
    this.baseEnv = { ...this.env };
    this.networkSourceEnv = process.env;
    this.proxyProbe = probeProxy;
    this.systemProxyReader = async () => {
      const result = await this.command('/usr/sbin/scutil', ['--proxy'], 3000);
      if (!result.ok) throw new Error('Cannot read current system proxy settings');
      return result.stdout;
    };
  }
  async init() {
    await fs.mkdir(this.config.directory, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.config.directory, this.names.incidents), { recursive: true, mode: 0o700 });
    await rotate(path.join(this.config.directory, this.names.startup), 1024 * 1024, 2);
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
  async refreshNetworkEnvironment() {
    this.networkRoute = 'unknown';
    this.networkPolicy = null;
    this.networkConfigError = null;
    try {
      const policy = await resolveNetworkPolicy({ env: this.networkSourceEnv, platform: process.platform, readSystemProxy: this.systemProxyReader });
      this.env = { ...this.baseEnv, ...policy.env };
      this.networkPolicy = policy.summary;
      this.networkRoute = policy.summary.route;
      if (this.networkRoute === 'configured_proxy') {
        const node = await fs.realpath(this.config.node);
        const stat = await fs.stat(node);
        const key = `${node}:${stat.mtimeMs}:${stat.size}`;
        if (this.proxyNodeVersionKey !== key) {
          const result = await this.command(this.config.node, ['--version'], 3000);
          const match = result.ok && result.stdout.trim().match(/^v(\d+)\.(\d+)\.\d+$/);
          if (!match || !(Number(match[1]) >= 24 || (Number(match[1]) === 22 && Number(match[2]) >= 21)))
            throw new NetworkConfigurationError('proxy_runtime_unsupported', 'Proxy routing requires Node 22.21+ or 24+', 'upgrade_guard_node');
          this.proxyNodeVersionKey = key;
        }
      }
    } catch (error) {
      this.env = { ...this.baseEnv };
      this.networkConfigError = { code: error.code ?? 'proxy_settings_unreadable', message: redact(error.message), action: error.action ?? 'correct_proxy_configuration' };
      throw error;
    }
  }
  async cli(args, timeout, beforeExecute) {
    await this.refreshNetworkEnvironment();
    if (beforeExecute) await beforeExecute();
    return this.command(this.config.node, [...(this.networkRoute === 'configured_proxy' ? ['--use-env-proxy'] : []),
      this.config.recoveryCli || this.config.cli, ...args], timeout);
  }
  async probe() {
    const result = await this.cli(['runtime', 'status', '--space', this.config.spaceId, '--json'], this.config.probeTimeoutMs);
    if (!result.ok && result.killed) throw new Error(`Runtime probe timed out after ${this.config.probeTimeoutMs} ms`);
    if (!result.ok) throw new Error(`Runtime probe failed: ${redact(result.stderr || result.stdout || String(result.code))}`);
    const sample = summarizeStatus(JSON.parse(result.stdout), this.config);
    if (sample.kind === 'connection_stuck') {
      try {
        const diagnostics = await this.cli(['runtime', 'logs', '--space', this.config.spaceId, '--limit', '200', '--level', 'debug', '--json'], 10_000);
        if (!diagnostics.ok) throw new Error(`Runtime diagnostics failed: ${redact(diagnostics.stderr || String(diagnostics.code))}`);
        sample.transportFailure = executionDisconnect(JSON.parse(diagnostics.stdout), sample, this.now());
      } catch (error) {
        // Missing evidence never authorizes the short restart path.
        sample.transportEvidenceError = redact(error.message);
      }
    }
    if (['connection_stuck', 'process_down'].includes(sample.kind) && sample.online === false &&
        sample.remoteWorkspaceOnline === false) {
      try { sample.remoteRecord = await this.remoteRecord(); }
      catch (error) { sample.remoteEvidenceError = redact(error.message); }
    }
    if (this.config.codexShared && ['healthy', 'connection_stuck', 'process_down'].includes(sample.kind)) {
      sample.sharedServer = await this.sharedServer();
      if (sample.kind === 'healthy' && sample.sharedServer.state === 'absent') sample.kind = 'shared_server_down';
    }
    return sample;
  }
  async remoteRecord() {
    await this.refreshNetworkEnvironment();
    const result = await this.command(this.config.node, [...(this.networkRoute === 'configured_proxy' ? ['--use-env-proxy'] : []),
      '--input-type=module', '--eval', `await (${readRemoteRecord.toString()})(...process.argv.slice(1));`,
      this.config.recoveryCli || this.config.cli, this.config.spaceId], this.config.probeTimeoutMs);
    if (!result.ok) throw new Error('Remote lifecycle probe failed');
    const record = JSON.parse(result.stdout);
    if (record !== null && (typeof record !== 'object' || Array.isArray(record) ||
        Object.values(record).some(v => v !== null && typeof v !== 'string')))
      throw new Error('Invalid remote lifecycle record');
    return record;
  }
  async sharedServer() {
    const socketPath = path.join(this.config.home, '.codex/app-server-control/app-server-control.sock');
    let info;
    let resolvedSocket;
    // Codex publishes a symlink to its short socket path under /private/tmp.
    try { resolvedSocket = await fs.realpath(socketPath); info = await fs.stat(resolvedSocket); }
    catch (error) { if (error.code === 'ENOENT') return { state: 'absent' }; throw error; }
    if (!info.isSocket()) throw new Error('Codex shared control path is not a socket; retained');
    if (info.uid !== process.getuid()) throw new Error('Codex shared socket owner changed; retained');
    const connected = await new Promise((resolve, reject) => {
      const socket = createConnection(resolvedSocket);
      socket.setTimeout(3000);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => socket.destroy(new Error('Codex shared socket probe timed out')));
      socket.once('error', error => {
        socket.destroy();
        if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve(false);
        else reject(error);
      });
    });
    if (!connected) return { state: 'absent' };
    const result = await this.command(this.config.codex, ['app-server', 'daemon', 'version'], 10_000);
    if (!result.ok) throw new Error(`Codex shared probe failed: ${redact(result.stderr || String(result.code))}`);
    const status = JSON.parse(result.stdout);
    if (status.status !== 'running' || status.socketPath !== socketPath || typeof status.appServerVersion !== 'string')
      throw new Error('Invalid Codex shared daemon status');
    return { state: 'running', version: status.appServerVersion };
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
        !(state.readyRuntimeId === undefined || state.readyRuntimeId === null || typeof state.readyRuntimeId === 'string') ||
        (state.network !== undefined && (!state.network || typeof state.network.code !== 'string' || typeof state.network.status !== 'string' ||
          !['healthy', 'blocked', 'degraded', 'not_checked'].includes(state.network.status) ||
          (state.network.fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(state.network.fingerprint)) ||
          !Number.isFinite(state.network.since) || !Number.isFinite(state.network.checkedAt) || !Number.isFinite(state.network.nextCheckAt) ||
          typeof state.network.blockRecovery !== 'boolean')))
      throw new Error('Invalid guard state; original file retained');
    const pending = state.pendingRecovery;
    const time = value => Number.isFinite(value) && value >= 0;
    if ((state.retry != null && (!Number.isSafeInteger(state.retry.attempts) || state.retry.attempts < 1 ||
          !time(state.retry.lastAttemptAt) || typeof state.retry.candidate !== 'string' || !state.retry.candidate)) ||
        (state.lastEscalationAt != null && !time(state.lastEscalationAt)) ||
        (state.lastNotice != null && (typeof state.lastNotice.key !== 'string' || !time(state.lastNotice.at))) ||
        (pending != null && (!pending || typeof pending.id !== 'string' || !pending.id ||
          !/^[a-f0-9]{64}$/.test(pending.scope) ||
          !['stopping', 'awaiting_start', 'starting'].includes(pending.phase) ||
          !['normal', 'escalated'].includes(pending.mode) ||
          !time(pending.budgetAt) || !time(pending.lastAttemptAt) || !time(pending.nextAttemptAt) ||
          pending.lastAttemptAt < pending.budgetAt || pending.nextAttemptAt < pending.lastAttemptAt ||
          !Number.isSafeInteger(pending.attempts) || pending.attempts < 1 ||
          !((pending.sourcePid === null && pending.sourceRuntimeId === null && pending.sourceNonce === null && pending.sourceIdentity === null) ||
            (Number.isSafeInteger(pending.sourcePid) && pending.sourcePid > 1 &&
              typeof pending.sourceRuntimeId === 'string' && pending.sourceRuntimeId &&
              typeof pending.sourceNonce === 'string' && pending.sourceNonce &&
              typeof pending.sourceIdentity === 'string' && pending.sourceIdentity)))))
      throw new Error('Invalid recovery journal; original file retained');
    return state;
  }
  recoveryScope() {
    return createHash('sha256').update(JSON.stringify([this.config.identity, this.config.spaceId, rootOf(this.config),
      [...this.config.harnesses].sort(), this.config.codexShared])).digest('hex');
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
    if (!text.startsWith(`${process.getuid()} `) || !workers.some(worker =>
      text.endsWith(`${node} ${worker}`) || text.endsWith(`${node} --use-env-proxy ${worker}`))) {
      // After SIGKILL, ps can briefly expose a defunct command rather than the worker path.
      const status = await this.command('/bin/ps', ['-p', String(pid), '-o', 'stat='], 3000);
      if ((status.ok && /^Z\S*$/.test(status.stdout.trim())) ||
          (!status.ok && status.code === 1 && !status.stdout.trim() && !status.stderr.trim())) return null;
      if (!status.ok) throw new Error('Cannot inspect Runtime process exit state');
      throw Object.assign(new Error('PID is not the approved Runtime worker'), { code: 'RUNTIME_IDENTITY_CHANGED' });
    }
    return text;
  }
  async originalProcessAlive(pid, identity) {
    try { return await this.processIdentity(pid) === identity; }
    catch (error) {
      // Only used after a verified stop/kill: a reused PID must never be signalled again.
      if (error.code === 'RUNTIME_IDENTITY_CHANGED') return false;
      throw error;
    }
  }
  async preflight() {
    await this.checkCompatibility();
    const native = await readJson(this.nativeFile);
    if (native.version !== 2 || native.identity !== this.config.identity || native.spaceId !== this.config.spaceId ||
        native.root !== rootOf(this.config) || !sameHarnesses(native.harnesses, this.config) ||
        typeof this.config.codexShared !== 'boolean' || native.codexShared !== this.config.codexShared ||
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
    if (![1, 2].includes(baseline.schemaVersion) || !/^\d+\.\d+\.\d+$/.test(baseline.reviewedVersion) ||
        !/^[a-f0-9]{64}$/.test(baseline.fingerprint)) throw new Error('Invalid CLI compatibility baseline');
    if (baseline.schemaVersion === 2 && (baseline.contract?.id !== CLI_CONTRACT ||
        baseline.contract.passed !== true || !Number.isFinite(Date.parse(baseline.contract.checkedAt)) ||
        !['reconnects', 'waits_for_execution'].includes(baseline.contract.activeExecution1006)))
      throw new Error('Invalid CLI behavioral compatibility record');
    const current = await inspectCli(this.config.recoveryCli || this.config.cli);
    if ((baseline.schemaVersion === 2 && current.version !== baseline.reviewedVersion) || current.fingerprint !== baseline.fingerprint)
      throw new Error(`CLI compatibility: ${current.version} Runtime/startup code or dependencies changed; review required`);
    const result = { status: 'compatible', ...current, reviewedVersion: baseline.reviewedVersion,
      verification: baseline.schemaVersion === 2 ? baseline.contract : { id: 'legacy-fingerprint', passed: true } };
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
    let result;
    try { result = await this.cli(['runtime', 'logs', '--space', this.config.spaceId, '--limit', '1000', '--level', 'debug', '--json']); }
    catch (error) { result = { ok: false, stderr: redact(error.message) }; }
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
    const directory = path.join(this.config.directory, this.names.incidents);
    let network;
    try { network = await this.network(); }
    catch (error) { network = [{ fault: this.networkConfigError?.code ?? 'network_diagnostics_failed', error: redact(error.message) }]; }
    await atomicJson(path.join(directory, name), redact({ reason, sample, events, diagnosticsError,
      network, nodeVersion: process.version,
      cliVersion: (await readJson(path.join(path.dirname(this.config.recoveryCli || this.config.cli), '../package.json'))).version }));
    const names = (await fs.readdir(directory)).filter(n => /^\d{4}-.*\.json$/.test(n)).sort();
    for (const old of names.slice(0, -10)) await fs.unlink(path.join(directory, old));
    await this.log('incident_saved', { reason, file: name, diagnosticsError });
  }
  async httpProbe(url) {
    const result = await this.command(this.config.node, [...(this.networkRoute === 'configured_proxy' ? ['--use-env-proxy'] : []),
      fileURLToPath(new URL('./probe-http.mjs', import.meta.url)), url], 7000);
    if (!result.ok) return { fault: result.killed ? 'transport_timeout' : 'diagnostic_failed', action: 'check_network_diagnostics' };
    const parsed = JSON.parse(result.stdout);
    if (!parsed || (parsed.httpStatus === undefined && typeof parsed.fault !== 'string')) throw new Error('Invalid HTTP probe result');
    return parsed;
  }
  async network() {
    await this.refreshNetworkEnvironment();
    return networkEvidence(async url => ({ ...await this.httpProbe(url), route: this.networkRoute }));
  }
  async monitorNetwork(sample, previous) {
    const now = Date.now();
    if (!this.networkPolicy && !this.networkConfigError)
      return { status: 'not_checked', code: 'not_checked', action: 'check_cli_compatibility', since: now,
        checkedAt: now, nextCheckAt: now + this.config.intervalMs, blockRecovery: true };
    const proxyChecks = this.networkConfigError ? [] : await Promise.all(this.networkPolicy.endpoints.map(endpoint => this.proxyProbe(endpoint)));
    const diagnostics = !this.networkConfigError && proxyChecks.every(check => check.ok) &&
      ['remote_unavailable', 'probe_error'].includes(sample.kind) ? await this.network() : [];
    return assessNetwork({ summary: this.networkPolicy, configError: this.networkConfigError, sample,
      proxyChecks, diagnostics, now, intervalMs: this.config.intervalMs, previous });
  }
  async recover(sample, beforeMutation, pending = null, progress = async () => {}) {
    if (pending && pending.scope !== this.recoveryScope()) throw new Error('Pending recovery scope changed; refusing mutation');
    await this.preflight();
    if (await this.paused()) return { outcome: 'skipped', reason: 'paused' };
    const fresh = await this.probe();
    if (fresh.kind !== sample.kind || fresh.pid !== sample.pid || fresh.runtimeId !== sample.runtimeId)
      return { outcome: 'skipped', reason: 'Runtime changed since probe' };
    if (sample.transportFailure && JSON.stringify(fresh.transportFailure) !== JSON.stringify(sample.transportFailure))
      return { outcome: 'skipped', reason: 'Execution disconnect evidence changed since probe' };
    if (this.config.codexShared && fresh.sharedServer?.state === 'absent') {
      // Start is idempotent. Never stop or restart a daemon shared with other clients.
      await this.refreshNetworkEnvironment();
      await this.preflight();
      if (await this.paused()) return { outcome: 'skipped', reason: 'paused' };
      if ((await this.sharedServer()).state === 'absent') {
        if (beforeMutation) await beforeMutation();
        const started = await this.command(this.config.codex, ['app-server', 'daemon', 'start'], 35_000);
        await this.log('shared_server_start', { ok: started.ok, code: started.code,
          error: started.ok ? null : redact(started.stderr || started.stdout) });
        if (!started.ok) throw new Error('Codex shared daemon start failed; retained existing state');
      }
      if ((await this.sharedServer()).state !== 'running') throw new Error('Codex shared daemon startup not verified');
    }
    if (sample.kind === 'shared_server_down') {
      const after = await this.probe();
      if (after.kind !== 'healthy') throw new Error(`Shared daemon recovery not verified: ${after.kind}`);
      return { outcome: 'recovered', pid: after.pid, runtimeId: after.runtimeId, component: 'shared_app_server' };
    }
    const owner = await this.owner();
    if (sample.pid) {
      if (!owner || owner.pid !== sample.pid) throw new Error('Runtime ownership changed before stop');
      const identity = await this.processIdentity(sample.pid);
      if (!identity) return { outcome: 'skipped', reason: 'Process exited before stop' };
      if (pending && (pending.sourcePid !== sample.pid || pending.sourceRuntimeId !== sample.runtimeId ||
          pending.sourceNonce !== owner.nonce || pending.sourceIdentity !== identity))
        throw new Error('Pending recovery process identity changed; refusing stop');
      await this.log('stop_requested', { pid: sample.pid, runtimeId: sample.runtimeId });
      const deadline = Date.now() + this.config.graceMs;
      const stopped = await this.cli(['runtime', 'down', '--space', this.config.spaceId, '--yes', '--json'], this.config.graceMs,
        beforeMutation && (() => beforeMutation('stopping', { sourcePid: sample.pid, sourceRuntimeId: sample.runtimeId,
          sourceNonce: owner.nonce, sourceIdentity: identity })));
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
        for (let n = 0; n < 20 && await this.originalProcessAlive(sample.pid, identity); n++) await sleep(250);
        if (await this.originalProcessAlive(sample.pid, identity)) throw new Error('Runtime did not exit');
      }
      await progress('awaiting_start');
    } else if (owner && await this.processIdentity(owner.pid)) {
      throw new Error('Owner process still exists but status is unavailable; refusing duplicate startup');
    }
    if (pending?.sourcePid && !sample.pid && await this.processIdentity(pending.sourcePid))
      throw new Error('Original Runtime process still exists; refusing duplicate startup');
    await this.preflight();
    const beforeStart = await this.probe();
    await this.log('startup_probe', { sample: beforeStart, stoppedRuntimeId: pending?.sourceRuntimeId ?? sample.runtimeId });
    if (beforeStart.kind === 'healthy' && beforeStart.runtimeId !== (pending?.sourceRuntimeId ?? sample.runtimeId)) {
      const replacement = await this.owner();
      if (!replacement || replacement.pid !== beforeStart.pid || !await this.processIdentity(beforeStart.pid))
        throw new Error('Replacement Runtime ownership not verified');
      await this.log('replacement_adopted', { pid: beforeStart.pid, runtimeId: beforeStart.runtimeId });
      return { outcome: 'recovered', reason: 'replacement_adopted', pid: beforeStart.pid, runtimeId: beforeStart.runtimeId };
    }
    const sourceId = pending?.sourceRuntimeId ?? sample.runtimeId;
    const ownLease = (pending?.sourcePid || sample.pid) && beforeStart.kind === 'another_runtime' &&
      !beforeStart.pid && beforeStart.remoteRuntimeId === sourceId;
    if ((!ownLease && beforeStart.kind === 'another_runtime') ||
        (sourceId && beforeStart.remoteRuntimeId && beforeStart.remoteRuntimeId !== sourceId))
      return { outcome: 'pending', reason: 'recovery_conflict' };
    if (beforeStart.kind !== 'process_down' && !ownLease)
      return { outcome: 'skipped', reason: `Startup no longer safe: ${beforeStart.kind}` };
    const startOwner = await this.owner();
    if (startOwner && await this.processIdentity(startOwner.pid))
      throw new Error('Owner process appeared before startup; refusing duplicate startup');
    const stoppedOwner = pending?.sourcePid ? { pid: pending.sourcePid, nonce: pending.sourceNonce } : sample.pid ? owner : null;
    if (stoppedOwner && startOwner && (startOwner.pid !== stoppedOwner.pid || startOwner.nonce !== stoppedOwner.nonce))
      throw new Error('Runtime owner changed after stop; refusing startup');
    if (await this.paused()) return { outcome: 'pending', reason: 'paused' };
    // The reviewed startup code reuses matching native consent without importing history.
    // Screen sharing must be explicitly enabled in the guard configuration.
    const start = await this.cli(['runtime', 'up', rootOf(this.config), '--space', this.config.spaceId,
      ...startHarnessArgs(this.config), ...(this.config.shareScreen ? ['--display', 'macos'] : ['--no-display']),
      '-d', '--yes', '--json'], 90_000, beforeMutation && (() => beforeMutation('starting')));
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
    if (state.pendingRecovery && state.pendingRecovery.scope !== this.recoveryScope())
      throw new Error('Pending recovery scope changed; original journal retained');
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
      catch (e) { sample = { kind: this.networkConfigError ? 'network_config_error' : 'probe_error', error: redact(e.message) }; }
    }
    let network;
    try { network = await this.monitorNetwork(sample, state.network); }
    catch (error) {
      const now = Date.now();
      network = { status: 'blocked', code: 'network_diagnostics_failed', action: 'check_network_diagnostics',
        error: redact(error.message), since: now, checkedAt: now, nextCheckAt: now + this.config.intervalMs, blockRecovery: true };
    }
    if (state.pendingRecovery && (sample.kind === 'healthy' ||
        (sample.kind === 'connection_stuck' && sample.pid &&
          (sample.pid !== state.pendingRecovery.sourcePid || sample.runtimeId !== state.pendingRecovery.sourceRuntimeId)))) {
      // A start may have succeeded before its caller timed out or the guard exited.
      // Never reuse the pending stop authorization against a replacement process.
      await this.log('recovery_reconciled', { operationId: state.pendingRecovery.id, sample });
      state = { ...state, pendingRecovery: null, candidate: null, failureSince: null,
        lastRecovery: { ...state.lastRecovery, outcome: sample.kind === 'healthy' ? 'observed_healthy' : 'replacement_observed' } };
    }
    const next = decide(state, sample, this.now(), paused, this.config);
    next.guardPid = process.pid;
    next.networkRoute = this.networkRoute ?? 'unknown';
    next.network = network;
    if (network.blockRecovery && network.status !== 'not_checked') {
      next.action = 'observe'; next.reason = network.code; next.candidate = null; next.failureSince = null;
    }
    if (network.code !== state.network?.code || network.fingerprint !== state.network?.fingerprint)
      await this.log('network_status', network);
    next.compatibility = compatibility;
    await this.save(next);
    await this.log('health', { paused, sample, decision: next.reason, networkRoute: next.networkRoute,
      nextEligibleAt: next.nextEligibleAt, operationId: next.pendingRecovery?.id ?? null });
    if (['recovery_conflict', 'another_runtime'].includes(next.reason)) {
      const key = `${next.reason}:${sample.runtimeId ?? 'absent'}:${sample.remoteRuntimeId ?? 'absent'}`;
      if (next.lastNotice?.key !== key || this.now() - next.lastNotice.at >= 60_000) {
        const notice = { reason: next.reason, runtimeId: sample.runtimeId, remoteRuntimeId: sample.remoteRuntimeId,
          nextEligibleAt: next.nextEligibleAt, operationId: next.pendingRecovery?.id ?? null,
          remoteEvidenceError: sample.remoteEvidenceError ?? null,
          message: 'Recovery blocked; inspect the recorded reason and next eligible time. No task was replayed.' };
        await this.log('recovery_blocked', notice);
        this.notify(notice);
        next.lastNotice = { key, at: this.now() };
        await this.save(next);
      }
    } else if (sample.kind === 'healthy' && next.lastNotice != null) {
      next.lastNotice = null;
      await this.save(next);
    }
    if (sample.kind !== 'healthy' && sample.kind !== 'compatibility_error' && sample.kind !== state.sample?.kind)
      await this.snapshot(sample.kind, sample);
    if (this.config.readyHooks && sample.kind === 'healthy' && sample.runtimeId !== state.readyRuntimeId) {
      next.readyRuntimeId = sample.runtimeId;
      next.lastReadyHooks = { at: new Date().toISOString(), runtimeId: sample.runtimeId, results: await this.runReadyHooks() };
      await this.save(next);
      await this.log('ready_hooks', next.lastReadyHooks);
    }
    if (next.action === 'recover') {
      // An unavailable proxy or account cannot authorize a recovery invocation.
      try { await this.preflight(); }
      catch (error) {
        next.action = 'observe'; next.reason = 'preflight_blocked'; next.candidate = null; next.failureSince = null;
        next.lastRecovery = { at: new Date().toISOString(), outcome: 'deferred', error: redact(error.message) };
        await this.log('preflight_blocked', next.lastRecovery);
        await this.save(next);
        return next;
      }
      // Evidence and the retry record must be durable before any destructive action.
      await this.snapshot('before_recovery', sample);
      next.lastRecovery = { at: new Date().toISOString(), outcome: 'preparing' };
      next.retry = { attempts: Math.min(Number.MAX_SAFE_INTEGER,
        (next.retry?.attempts ?? next.pendingRecovery?.attempts ?? 0) + 1),
        lastAttemptAt: this.now(), candidate: next.candidate };
      await this.save(next);
      let reserved = false;
      const reserveAttempt = async (phase, source) => {
        if (await this.paused()) throw new Error('Recovery paused before mutation');
        const now = this.now();
        if (!reserved && !next.pendingRecovery)
          next.restarts = [...next.restarts.filter(t => now - t < 3_600_000), now];
        if (phase && !next.pendingRecovery) next.pendingRecovery = { id: randomUUID(), scope: this.recoveryScope(),
          budgetAt: next.restarts.at(-1), mode: 'normal',
          attempts: reserved ? 1 : 0, lastAttemptAt: now, nextAttemptAt: now + retryDelay(next.retry.attempts, this.config),
          sourcePid: null, sourceRuntimeId: null, sourceNonce: null, sourceIdentity: null, ...source };
        if (!reserved && next.pendingRecovery) next.pendingRecovery = {
          ...next.pendingRecovery, attempts: Math.min(Number.MAX_SAFE_INTEGER, next.pendingRecovery.attempts + 1),
          lastAttemptAt: now, nextAttemptAt: now + retryDelay(next.retry.attempts, this.config),
        };
        if (phase && next.pendingRecovery) next.pendingRecovery = { ...next.pendingRecovery, phase };
        next.lastRecovery = { ...next.lastRecovery, outcome: 'started',
          operationId: next.pendingRecovery?.id ?? null, mode: next.recoveryMode };
        await this.save(next);
        reserved = true;
      };
      const progress = async phase => {
        if (next.pendingRecovery) {
          next.pendingRecovery = { ...next.pendingRecovery, phase };
          await this.save(next);
        }
      };
      try {
        const result = await this.recover(sample, reserveAttempt, next.pendingRecovery, progress);
        next.lastRecovery = { ...next.lastRecovery, ...result };
        if (next.lastRecovery.outcome === 'recovered') {
          next.pendingRecovery = null;
          next.retry = null;
        }
      }
      catch (e) { next.lastRecovery = { ...next.lastRecovery, outcome: reserved ? 'failed' : 'deferred', error: redact(e.message) }; }
      // Space retries from completion too: a slow failing command must not cause an immediate loop.
      if (next.retry) {
        next.retry.lastAttemptAt = this.now();
        next.nextEligibleAt = next.retry.lastAttemptAt + retryDelay(next.retry.attempts, this.config);
        if (next.pendingRecovery) {
          next.pendingRecovery.lastAttemptAt = next.retry.lastAttemptAt;
          next.pendingRecovery.nextAttemptAt = next.nextEligibleAt;
        }
      } else next.nextEligibleAt = null;
      await this.log('recovery_finished', next.lastRecovery);
      await this.save(next);
    }
    return next;
  }
}

export async function acquireLock(directory, layout = 'standard') {
  const file = path.join(directory, stateNames(layout).lock);
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

export async function main(command, file) {
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
    const sample = await guard.probe();
    console.log(JSON.stringify({ ...sample, compatibility: await guard.checkCompatibility(),
      network: await guard.monitorNetwork(sample, (await guard.loadState()).network) }, null, 2));
    return;
  }
  const unlock = await acquireLock(guard.config.directory, guard.config.stateLayout);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await guard.loadState();
    await guard.log('guard_started', { pid: process.pid, spaceId: guard.config.spaceId });
    while (!controller.signal.aborted) {
      let waitMs = guard.config.intervalMs;
      try {
        const state = await guard.tick(await guard.loadState());
        if (state.nextEligibleAt > guard.now()) waitMs = Math.min(waitMs, state.nextEligibleAt - guard.now());
      }
      catch (e) { await guard.log('monitor_error', { error: redact(e.message) }); }
      await sleep(Math.max(1, waitMs), undefined, { signal: controller.signal }).catch(e => { if (e.name !== 'AbortError') throw e; });
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
