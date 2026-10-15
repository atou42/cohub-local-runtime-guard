import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { probeProxy, resolveNetworkPolicy } from '../network-env.mjs';

const run = promisify(execFile);
const probeScript = fileURLToPath(new URL('../probe-http.mjs', import.meta.url));
async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return server.address().port;
}
async function probe(url, env = {}) {
  const result = await run(process.execPath, ['--use-env-proxy', probeScript, url], {
    env: { PATH: process.env.PATH, ...env }, timeout: 7000,
  });
  return JSON.parse(result.stdout);
}

test('real local proxy rejection is classified as authentication failure, then succeeds after credentials are supplied', async t => {
  const origin = http.createServer((request, response) => { response.writeHead(204); response.end(); });
  const originPort = await listen(t, origin);
  const sockets = new Set();
  let upstreamStatus = 0;
  const proxy = http.createServer();
  proxy.on('connect', (request, client, head) => {
    sockets.add(client); client.on('close', () => sockets.delete(client)); client.on('error', () => {});
    if (request.headers['proxy-authorization'] !== 'Basic ' + Buffer.from('test-user:test-pass').toString('base64')) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fixture"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (upstreamStatus) {
      client.end(`HTTP/1.1 ${upstreamStatus} Upstream Rejected\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const upstream = net.connect(originPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy()); client.on('close', () => upstream.destroy());
  });
  const proxyPort = await listen(t, proxy);
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  assert.equal((await probe('http://service.invalid/', { HTTP_PROXY: `http://127.0.0.1:${proxyPort}` })).fault, 'proxy_auth_required');
  const success = await probe('http://service.invalid/', { HTTP_PROXY: `http://test-user:test-pass@127.0.0.1:${proxyPort}` });
  assert.equal(success.httpStatus, 204);
  assert.equal(success.fault, undefined);
  upstreamStatus = 502;
  const rejected = await probe('http://service.invalid/', { HTTP_PROXY: `http://test-user:test-pass@127.0.0.1:${proxyPort}` });
  assert.equal(rejected.fault, 'proxy_connect_rejected');
  assert.equal(rejected.proxyStatus, 502);
});

test('a proxy that accepts TCP but never answers CONNECT produces a bounded transport timeout', async t => {
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const port = await listen(t, server);
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  const start = Date.now();
  const result = await probe('http://service.invalid/', { HTTP_PROXY: `http://127.0.0.1:${port}` });
  assert.equal(result.fault, 'transport_timeout');
  assert.ok(Date.now() - start < 6500);
});

test('real proxy port death is detected and the same configured endpoint can become reachable again', async t => {
  const server = net.createServer(socket => socket.end());
  const port = await listen(t, server);
  const endpoint = { scheme: 'http', host: '127.0.0.1', port };
  assert.equal((await probeProxy(endpoint)).ok, true);
  await new Promise(resolve => server.close(resolve));
  assert.equal((await probeProxy(endpoint)).code, 'proxy_refused');
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  assert.equal((await probeProxy(endpoint)).ok, true);
});

test('NO_PROXY loopback traffic bypasses a real refusing proxy; HTTP 429 and 503 are not considered healthy', async t => {
  let status = 204;
  const server = http.createServer((request, response) => { response.writeHead(status); response.end(); });
  const port = await listen(t, server);
  const env = { HTTP_PROXY: 'http://127.0.0.1:1', NO_PROXY: 'localhost,127.0.0.1,[::1]' };
  assert.equal((await probe(`http://127.0.0.1:${port}/`, env)).httpStatus, 204);
  status = 429;
  assert.equal((await probe(`http://127.0.0.1:${port}/`, env)).fault, 'upstream_rate_limited');
  status = 503;
  assert.equal((await probe(`http://127.0.0.1:${port}/`, env)).fault, 'upstream_unavailable');
});

test('real self-signed TLS failure is reported rather than disabling certificate validation', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-tls-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost'], { timeout: 10000 });
  const server = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, (request, response) => response.end());
  const port = await listen(t, server);
  const result = await probe(`https://127.0.0.1:${port}/`, { NO_PROXY: '*' });
  assert.equal(result.fault, 'tls_certificate_failure');
  assert.equal(result.action, 'repair_certificate_trust_without_disabling_verification');
  const policy = await resolveNetworkPolicy({ env: { NO_PROXY: '*', NODE_EXTRA_CA_CERTS: cert, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, platform: 'linux' });
  assert.equal(policy.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.equal(policy.summary.extraCaConfigured, true);
  const trusted = await probe(`https://localhost:${port}/`, policy.env);
  assert.equal(trusted.httpStatus, 200);
  await fs.unlink(cert);
  await assert.rejects(resolveNetworkPolicy({ env: { NODE_EXTRA_CA_CERTS: cert }, platform: 'linux' }), error => error.code === 'extra_ca_unavailable');
});
