import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import { bypassesProxy } from './network-env.mjs';

function failure(error) {
  const cause = error.cause;
  const code = cause?.code ?? error.code ?? error.name;
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return { fault: 'tls_certificate_failure', cause: code, action: 'repair_certificate_trust_without_disabling_verification' };
  if (/SSL|TLS/.test(code)) return { fault: 'tls_handshake_failure', cause: code, action: 'check_proxy_tls_and_upstream' };
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return { fault: 'dns_failure', cause: code, action: 'check_dns_or_proxy_resolution' };
  if (['TimeoutError', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return { fault: 'transport_timeout', cause: code, action: 'retry_configured_route' };
  return { fault: 'transport_failure', cause: code, action: 'retry_configured_route' };
}

function tunnelStatus(status) {
  if (status === 407) return { fault: 'proxy_auth_required', action: 'refresh_proxy_credentials' };
  return status === 200 ? {} : { fault: 'proxy_connect_rejected', proxyStatus: status, action: 'check_proxy_upstream' };
}

async function probeTunnel(target, address) {
  const proxy = new URL(address);
  const destination = new URL(target);
  const transport = proxy.protocol === 'https:' ? https : http;
  const agent = new transport.Agent({ keepAlive: false });
  const authority = `${destination.hostname}:${destination.port || (destination.protocol === 'https:' ? 443 : 80)}`;
  const headers = { Host: authority };
  if (proxy.username || proxy.password)
    headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
  return new Promise(resolve => {
    const finish = value => { agent.destroy(); resolve(value); };
    const request = transport.request({ hostname: proxy.hostname.replace(/^\[|\]$/g, ''), port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT', path: authority, headers, agent });
    request.setTimeout(3000, () => request.destroy(Object.assign(new Error('Proxy tunnel timed out'), { code: 'ETIMEDOUT' })));
    request.once('connect', (response, socket) => { socket.destroy(); finish(tunnelStatus(response.statusCode)); });
    request.once('response', response => { response.resume(); finish(tunnelStatus(response.statusCode)); });
    request.once('error', error => finish(failure(error)));
    request.end();
  });
}

export async function probeHttp(url) {
  try {
    const proxy = new URL(url).protocol === 'https:'
      ? process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY
      : process.env.http_proxy || process.env.HTTP_PROXY;
    if (proxy && !bypassesProxy(url, process.env.no_proxy ?? process.env.NO_PROXY ?? '')) {
      const tunnel = await probeTunnel(url, proxy);
      if (tunnel.fault) return tunnel;
    }
    const response = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    const status = response.status;
    return { httpStatus: status,
      ...(status === 407 ? { fault: 'proxy_auth_required', action: 'refresh_proxy_credentials' }
        : status === 429 ? { fault: 'upstream_rate_limited', action: 'wait_for_upstream' }
        : status >= 500 ? { fault: 'upstream_unavailable', action: 'wait_for_upstream' } : {}) };
  } catch (error) {
    return failure(error);
  }
}

if (process.argv[1] && await fs.realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await probeHttp(process.argv[2]))); }
  catch { console.error('HTTP diagnostic failed'); process.exitCode = 1; }
}
