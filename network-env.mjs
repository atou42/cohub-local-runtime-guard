import { createHash, X509Certificate } from 'node:crypto';
import { connect } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';

export const NETWORK_TARGETS = ['https://api.cohub.live/', 'https://gateway.cohub.live/'];

export class NetworkConfigurationError extends Error {
  constructor(code, message, action = 'correct_proxy_configuration') {
    super(message);
    this.code = code;
    this.action = action;
  }
}
const invalid = (code, message, action) => { throw new NetworkConfigurationError(code, message, action); };

function proxyUrl(value, key) {
  if (/[\s\x00-\x1f\x7f]/.test(value)) invalid('invalid_proxy_url', `Invalid ${key} URL; encode credentials and remove whitespace`);
  let url;
  try { url = new URL(value); } catch { invalid('invalid_proxy_url', `Invalid ${key} URL`); }
  if (!['http:', 'https:'].includes(url.protocol))
    invalid('unsupported_proxy_protocol', `${key} requires an HTTP/HTTPS proxy; SOCKS is not supported by the CLI's native proxy transport`);
  if (!url.hostname || (url.port && Number(url.port) < 1) || url.pathname !== '/' || url.search || url.hash)
    invalid('invalid_proxy_url', `${key} must contain only scheme, credentials, host and port`);
  try { decodeURIComponent(url.username); decodeURIComponent(url.password); }
  catch { invalid('invalid_proxy_url', `Invalid ${key} credential encoding`); }
  return url.href;
}

function readSystemPolicy(text) {
  if (typeof text !== 'string' || !/^<dictionary>\s*\{[\s\S]*\}\s*$/.test(text.trim()))
    invalid('proxy_settings_unreadable', 'Invalid macOS proxy configuration');
  const field = name => {
    const matches = [...text.matchAll(new RegExp(`^\\s*${name}\\s*:\\s*(.*?)\\s*$`, 'gm'))];
    if (matches.length > 1) invalid('invalid_system_proxy', `Duplicate proxy setting: ${name}`);
    return matches[0]?.[1];
  };
  const enabled = name => {
    const value = field(name);
    if (value === undefined || value === '0') return false;
    if (value === '1') return true;
    invalid('invalid_system_proxy', `Invalid proxy switch: ${name}`);
  };
  if (enabled('ProxyAutoConfigEnable') || enabled('ProxyAutoDiscoveryEnable'))
    invalid('unsupported_pac', 'PAC/WPAD cannot be evaluated safely by this guard; configure explicit HTTP_PROXY/HTTPS_PROXY');
  const env = {};
  for (const [prefix, key] of [['HTTP', 'HTTP_PROXY'], ['HTTPS', 'HTTPS_PROXY']]) {
    if (!enabled(`${prefix}Enable`)) continue;
    const host = field(`${prefix}Proxy`);
    const port = field(`${prefix}Port`);
    if (!host || /[\s/@?#]/.test(host) || !/^\d+$/.test(port ?? '') || Number(port) < 1 || Number(port) > 65535)
      invalid('invalid_system_proxy', `Invalid ${prefix} proxy endpoint`);
    const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    env[key] = proxyUrl(`http://${address}:${Number(port)}`, key);
  }
  if (!env.HTTP_PROXY && !env.HTTPS_PROXY && enabled('SOCKSEnable'))
    invalid('unsupported_proxy_protocol', 'Only a SOCKS system proxy is enabled; configure an explicit HTTP/HTTPS proxy');
  if (env.HTTP_PROXY && !env.HTTPS_PROXY)
    invalid('partial_system_proxy', 'Only the system HTTP proxy is enabled; explicitly configure HTTPS routing instead of relying on transport-specific fallback');
  const warnings = [];
  const exceptions = text.match(/^\s*ExceptionsList\s*:\s*<array>\s*\{([^}]+)\}/m);
  if (exceptions) {
    const entries = exceptions[1].split('\n').filter(line => line.trim()).map(line => {
      const match = line.match(/^\s*\d+\s*:\s*(\S+)\s*$/);
      if (!match) invalid('invalid_system_proxy', 'Invalid system proxy exception list');
      return match[1];
    });
    env.NO_PROXY = entries.join(',');
    if (entries.some(entry => entry.includes('/'))) warnings.push('Node NO_PROXY does not implement CIDR exceptions');
  }
  if (enabled('ExcludeSimpleHostnames')) warnings.push('Simple-hostname system exclusions cannot be fully represented by NO_PROXY');
  return { env, warnings };
}

export const parseSystemProxy = text => readSystemPolicy(text).env;

export function bypassesProxy(target, noProxy = '') {
  const url = new URL(target);
  const host = url.hostname.toLowerCase();
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return noProxy.split(/[,\s]+/).filter(Boolean).some(rule => {
    if (rule === '*') return true;
    const match = rule.match(/^(.+):(\d+)$/);
    if (match && Number(match[2]) !== port) return false;
    const domain = (match ? match[1] : rule).toLowerCase();
    return /^[.*]/.test(domain) ? host.endsWith(domain.replace(/^\*/, '')) : host === domain;
  });
}

export async function resolveNetworkPolicy({ env, platform, readSystemProxy }) {
  const selected = {};
  const warnings = [];
  let caVersion = null;
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') warnings.push('TLS verification bypass was ignored');
  if (env.NODE_EXTRA_CA_CERTS !== undefined) {
    const file = env.NODE_EXTRA_CA_CERTS;
    if (typeof file !== 'string' || !path.isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file))
      invalid('extra_ca_unavailable', 'NODE_EXTRA_CA_CERTS must be an explicit absolute certificate file', 'repair_configured_ca_file');
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid certificate file');
      const content = await fs.readFile(file, 'utf8');
      const certificates = content.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
      if (!certificates?.length) throw new Error('No PEM certificate found');
      for (const certificate of certificates) new X509Certificate(certificate);
      caVersion = `${file}:${stat.mtimeMs}:${stat.size}`;
      selected.NODE_EXTRA_CA_CERTS = file;
    } catch { invalid('extra_ca_unavailable', 'The configured extra CA file is missing, unreadable or invalid', 'repair_configured_ca_file'); }
  }
  for (const upper of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    const lower = upper.toLowerCase();
    for (const key of [upper, lower])
      if (env[key] !== undefined && (typeof env[key] !== 'string' || /[\x00-\x1f\x7f]/.test(env[key])))
        invalid('invalid_proxy_environment', `Invalid ${key} value`);
    const normalize = value => !value?.trim() ? undefined : upper === 'NO_PROXY'
      ? [...new Set(value.trim().toLowerCase().split(/[,\s]+/).filter(Boolean))].sort().join(',') : proxyUrl(value.trim(), upper);
    const a = normalize(env[upper]);
    const b = normalize(env[lower]);
    if (a && b && a !== b) invalid('conflicting_proxy_environment', `${upper} and ${lower} disagree; remove the ambiguity`);
    const value = b || a;
    if (value) selected[upper] = value;
  }
  if (selected.NO_PROXY && /[\x00-\x1f\x7f]/.test(selected.NO_PROXY)) invalid('invalid_no_proxy', 'NO_PROXY contains control characters');
  let source = 'environment';
  if (!selected.HTTP_PROXY && !selected.HTTPS_PROXY && !selected.ALL_PROXY) {
    source = platform === 'darwin' ? 'system' : 'direct';
    if (platform === 'darwin') {
      let system;
      try { system = readSystemPolicy(await readSystemProxy()); }
      catch (error) {
        if (error instanceof NetworkConfigurationError) throw error;
        invalid('proxy_settings_unreadable', 'Cannot read the current system proxy configuration', 'check_system_proxy_service');
      }
      if (selected.NO_PROXY && system.env.NO_PROXY) system.env.NO_PROXY = `${system.env.NO_PROXY},${selected.NO_PROXY}`;
      Object.assign(selected, system.env);
      warnings.push(...system.warnings);
    }
  }
  // Normalize native Node and Go transport differences, including ALL_PROXY.
  if (selected.ALL_PROXY) {
    selected.HTTP_PROXY ??= selected.ALL_PROXY;
    selected.HTTPS_PROXY ??= selected.ALL_PROXY;
    delete selected.ALL_PROXY;
  }
  if (source === 'environment' && selected.HTTP_PROXY) selected.HTTPS_PROXY ??= selected.HTTP_PROXY;
  const proxied = Boolean(selected.HTTP_PROXY || selected.HTTPS_PROXY);
  if (proxied) {
    selected.NO_PROXY = [...new Set(['localhost', '127.0.0.1', '[::1]', '::1', ...(selected.NO_PROXY ?? '').split(/[,\s]+/).filter(Boolean)])].join(',');
  }
  const routes = NETWORK_TARGETS.map(target => {
    const key = new URL(target).protocol === 'https:' ? 'HTTPS_PROXY' : 'HTTP_PROXY';
    const address = !bypassesProxy(target, selected.NO_PROXY) && selected[key];
    if (!address) return { host: new URL(target).hostname, route: 'direct' };
    const url = new URL(address);
    return { host: new URL(target).hostname, route: 'proxy', proxy: {
      scheme: url.protocol.slice(0, -1), host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), authenticated: Boolean(url.username || url.password),
    } };
  });
  const endpoints = [...new Map(routes.filter(r => r.proxy).map(r => [`${r.proxy.scheme}:${r.proxy.host}:${r.proxy.port}`, r.proxy])).values()];
  const fingerprint = createHash('sha256').update(JSON.stringify({ source, routes, bypass: selected.NO_PROXY ?? '', caVersion })).digest('hex');
  return { env: selected, summary: { source, route: proxied ? 'configured_proxy' : 'direct', fingerprint, routes, endpoints,
    extraCaConfigured: Boolean(selected.NODE_EXTRA_CA_CERTS), warnings } };
}

export const resolveNetworkEnvironment = async options => (await resolveNetworkPolicy(options)).env;

export function probeProxy(endpoint, timeoutMs = 2000) {
  return new Promise(resolve => {
    const socket = connect({ host: endpoint.host, port: endpoint.port });
    let finished = false;
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); socket.destroy(); resolve({ ...endpoint, ...result });
    };
    const timer = setTimeout(() => finish({ ok: false, code: 'proxy_timeout' }), timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('error', error => finish({ ok: false, code: ['ENOTFOUND', 'EAI_AGAIN'].includes(error.code) ? 'proxy_dns_failure'
      : error.code === 'ECONNREFUSED' ? 'proxy_refused' : 'proxy_unreachable' }));
  });
}

export function assessNetwork({ summary, configError, sample, proxyChecks = [], diagnostics = [], now, intervalMs, previous }) {
  let status = 'healthy';
  let code = 'reachable';
  let action = 'none';
  if (configError) {
    status = 'blocked'; code = configError.code; action = configError.action;
  } else if (sample.kind !== 'healthy') {
    const proxyFailure = proxyChecks.find(check => !check.ok);
    const transportFailure = diagnostics.find(check => check.fault);
    if (proxyFailure) { status = 'blocked'; code = proxyFailure.code; action = 'restore_configured_proxy'; }
    else if (transportFailure) {
      status = 'blocked'; code = transportFailure.fault; action = transportFailure.action ?? 'retry_configured_route';
      if (summary?.route === 'configured_proxy' && summary.routes.every(route => route.route === 'direct') &&
          ['dns_failure', 'transport_timeout', 'transport_failure'].includes(code)) {
        code = 'no_proxy_bypass_failure'; action = 'review_no_proxy_without_automatic_bypass';
      }
    }
    else if (['remote_unavailable', 'probe_error', 'network_config_error'].includes(sample.kind)) {
      status = 'degraded'; code = 'cli_request_failed'; action = 'retry_cli_without_restarting_tasks';
    } else if (sample.kind === 'connection_stuck') action = 'recover_runtime_after_confirmed_outage';
  }
  const same = previous?.code === code && previous?.fingerprint === summary?.fingerprint;
  return { ...summary, status, code, action, proxyChecks, diagnostics,
    since: same ? previous.since : now, checkedAt: now, nextCheckAt: now + intervalMs,
    blockRecovery: status === 'blocked',
    ...(configError ? { error: configError.message } : {}),
    ...(sample.kind === 'healthy' && proxyChecks.some(check => !check.ok) ? { warning: 'Runtime API is reachable despite a proxy TCP probe failure' } : {}),
  };
}
