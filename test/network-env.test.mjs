import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSystemProxy, resolveNetworkPolicy, resolveNetworkEnvironment, bypassesProxy, assessNetwork } from '../network-env.mjs';

const system = port => `<dictionary> {\n HTTPEnable : 1\n HTTPPort : ${port}\n HTTPProxy : 127.0.0.1\n HTTPSEnable : 1\n HTTPSPort : ${port}\n HTTPSProxy : 127.0.0.1\n}`;
const policy = (env = {}) => resolveNetworkPolicy({ env, platform: 'linux', readSystemProxy: async () => { throw Error('unexpected system lookup'); } });

test('system proxy is refreshed, preserves exclusions and never leaks credentials to metadata', async () => {
  let port = 7893;
  const options = { env: {}, platform: 'darwin', readSystemProxy: async () => system(port) };
  const first = await resolveNetworkPolicy(options);
  assert.equal(first.env.HTTPS_PROXY, 'http://127.0.0.1:7893/');
  assert.equal(first.summary.source, 'system');
  assert.match(first.env.NO_PROXY, /\[::1\]/);
  port = 7894;
  const changed = await resolveNetworkPolicy(options);
  assert.notEqual(first.summary.fingerprint, changed.summary.fingerprint);
  const disabled = await resolveNetworkPolicy({ ...options, readSystemProxy: async () => '<dictionary> {}' });
  assert.equal(disabled.summary.route, 'direct');
  assert.equal(disabled.env.HTTPS_PROXY, undefined);
  const exclusions = parseSystemProxy(system(port).replace('\n}', '\n ExceptionsList : <array> {\n 0 : *.local\n 1 : 192.168.0.0/16\n }\n}'));
  assert.equal(exclusions.NO_PROXY, '*.local,192.168.0.0/16');
  const secret = await policy({ HTTPS_PROXY: 'http://private-user:private-password@proxy.invalid:3128' });
  assert.ok(!JSON.stringify(secret.summary).includes('private-user'));
  assert.ok(!JSON.stringify(secret.summary).includes('private-password'));
  assert.equal(secret.summary.endpoints[0].authenticated, true);
});

test('explicit routing wins; lowercase and HTTP ALL_PROXY are normalized for both transports', async () => {
  const selected = await resolveNetworkEnvironment({ env: { https_proxy: 'http://proxy.invalid:3128', SECRET: 'must-not-copy' },
    platform: 'darwin', readSystemProxy: async () => { throw Error('must not read'); } });
  assert.equal(selected.HTTPS_PROXY, 'http://proxy.invalid:3128/');
  assert.equal(selected.https_proxy, undefined);
  assert.equal(selected.SECRET, undefined);
  const all = await policy({ ALL_PROXY: 'http://proxy.invalid:3128' });
  assert.equal(all.env.HTTP_PROXY, all.env.HTTPS_PROXY);
  assert.equal(all.env.ALL_PROXY, undefined);
  const http = await policy({ HTTP_PROXY: 'http://proxy.invalid:3128' });
  assert.equal(http.env.HTTPS_PROXY, http.env.HTTP_PROXY);
  const equivalent = await policy({ HTTPS_PROXY: 'http://PROXY.invalid:80', https_proxy: 'http://proxy.invalid/',
    NO_PROXY: 'localhost,127.0.0.1', no_proxy: '127.0.0.1, localhost' });
  assert.equal(equivalent.env.HTTPS_PROXY, 'http://proxy.invalid/');
});

test('bad URLs, conflicting environment, control characters and unsupported protocols fail without echoing secrets', async () => {
  for (const env of [{ HTTPS_PROXY: 'socks5://private-user:private-password@host:1080' }, { HTTPS_PROXY: 'invalid-private-password' },
    { HTTPS_PROXY: 'http://private-user:private-password@host/path' }, { HTTPS_PROXY: 'http://host:0' },
    { HTTPS_PROXY: 'http://host:8080\n' }, { HTTP_PROXY: 'http://a:80', http_proxy: 'http://b:80' },
    { NO_PROXY: 'host\nSECRET' }]) {
    await assert.rejects(policy(env), error => { assert.ok(!error.message.includes('private-password')); return Boolean(error.code); });
  }
});

test('PAC, SOCKS-only, malformed settings and failed system reads have explicit reasons', async () => {
  for (const text of ['bad output', system(0), system('invalid'), system(7893).replace('HTTPSPort : 7893', 'HTTPSPort : 7893\n HTTPSPort : 7894'),
    '<dictionary> {\n ProxyAutoConfigEnable : 1\n}', '<dictionary> {\n SOCKSEnable : 1\n}',
    '<dictionary> {\n HTTPEnable : 1\n HTTPProxy : 127.0.0.1\n HTTPPort : 7893\n}'])
    assert.throws(() => parseSystemProxy(text), error => Boolean(error.code));
  await assert.rejects(resolveNetworkPolicy({ env: {}, platform: 'darwin', readSystemProxy: async () => { throw Error('private failure'); } }),
    error => error.code === 'proxy_settings_unreadable' && !error.message.includes('private failure'));
});

test('NO_PROXY matches Node host, wildcard, suffix, port and IPv6 behavior without inventing CIDR support', async () => {
  for (const entry of ['*', 'api.cohub.live', '.cohub.live', '*.cohub.live', 'api.cohub.live:443'])
    assert.equal(bypassesProxy('https://api.cohub.live/', entry), true);
  assert.equal(bypassesProxy('https://api.cohub.live/', 'cohub.live'), false);
  assert.equal(bypassesProxy('https://api.cohub.live/', 'api.cohub.live:80'), false);
  assert.equal(bypassesProxy('https://[::1]/', '[::1]'), true);
  const bypass = await policy({ HTTPS_PROXY: 'http://proxy.invalid:3128', NO_PROXY: '*' });
  assert.deepEqual(bypass.summary.endpoints, []);
  assert.ok(bypass.summary.routes.every(route => route.route === 'direct'));
});

test('network fault classification preserves time, distinguishes recovery actions and never kills healthy tasks', async () => {
  const { summary } = await policy({ HTTPS_PROXY: 'http://proxy.invalid:3128' });
  const options = { summary, sample: { kind: 'connection_stuck' }, now: 1000, intervalMs: 30 };
  const blocked = assessNetwork({ ...options, proxyChecks: [{ ok: false, code: 'proxy_refused' }] });
  assert.equal(blocked.blockRecovery, true);
  assert.equal(blocked.action, 'restore_configured_proxy');
  assert.equal(assessNetwork({ ...options, proxyChecks: blocked.proxyChecks, previous: blocked, now: 2000 }).since, 1000);
  const healthy = assessNetwork({ ...options, sample: { kind: 'healthy' }, proxyChecks: blocked.proxyChecks });
  assert.equal(healthy.blockRecovery, false);
  assert.equal(healthy.status, 'healthy');
  for (const fault of ['proxy_auth_required', 'tls_certificate_failure', 'upstream_unavailable', 'transport_timeout']) {
    const status = assessNetwork({ ...options, diagnostics: [{ fault }] });
    assert.equal(status.code, fault);
    assert.equal(status.blockRecovery, true);
  }
  const bypass = await policy({ HTTPS_PROXY: 'http://proxy.invalid:3128', NO_PROXY: '*' });
  const failedBypass = assessNetwork({ ...options, summary: bypass.summary, diagnostics: [{ fault: 'dns_failure' }] });
  assert.equal(failedBypass.code, 'no_proxy_bypass_failure');
  assert.equal(failedBypass.action, 'review_no_proxy_without_automatic_bypass');
});
