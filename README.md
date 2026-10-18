# Cohub Local Runtime Guard

A small, dependency-free watchdog for an existing [Cohub](https://cohub.live) Local Runtime. It detects sustained disconnection or process death, saves diagnostic evidence, and attempts a bounded restart without deleting conversation history or replaying prompts.

This is an independent recovery tool, not an official Cohub component and not a fix for the client's internal reconnect behavior. **Restarting a Runtime can interrupt its tasks.** It does not use reset operations or reset credits.

## Recovery Policy

- Check every 30 seconds; require two minutes of continuously confirmed failure before recovery.
- Allow at most three recovery attempts per hour, with a ten-minute cooldown. These records survive guard restarts.
- Do not restart on an ambiguous API timeout, changed account or consent, malformed state, or another Runtime owning the Space.
- Stop gracefully first. After a 30-second grace period, force-stop only a verified Runtime parent with unchanged ownership and no remaining child processes. Never signal an entire process group.
- Keep state, conversation history, native logs and task outputs. Never clear corrupted state to make a check pass.
- Run recovery commands through a separate, reviewed CLI copy. A global CLI upgrade, including a temporarily incomplete install, does not disable the guard or expose recovery to unknown startup code.

## Requirements

Node.js 22.21+ or 24+, a separately installed Cohub CLI, and an existing authorized Local Runtime. No npm dependencies or installation hooks are required for this project.

The production watchdog has been exercised on macOS. The synthetic process tests also run in Linux CI; that is not a claim of Linux production validation. Windows is not supported. Native consent configuration version 2 and the CLI status/control interfaces must match the implementation. The current recovery workflow was checked with Cohub CLI 10.1.0; a fingerprint is change detection, not a security audit or a guarantee of future server protocol compatibility.

## Setup

Start and authorize your Runtime using Cohub's normal interactive workflow first. This guard must not be used to grant new synchronization, execution, shared Codex control or screen-sharing consent. Set `codexShared` to match the existing native configuration exactly. It defaults to `false` for existing private-control setups; set it to `true` only after shared control has already been authorized in Cohub. Enabling it also requires the `codex` harness.

1. Clone this repository and run `npm test`.
2. Review the installed Cohub CLI that you intend to use for recovery. Do not acknowledge unknown code only to clear a warning.
3. Make an independent copy of its complete package, including installed dependencies. The snapshot helper copies files only; it does not install or execute the CLI. It requires existing parent directories and refuses to overwrite a copy or baseline.

```sh
mkdir -p ./data
node scripts/snapshot-cli.mjs \
  --source /absolute/path/to/installed/cohub-cli \
  --destination "$PWD/data/reviewed-cli-10.1.0" \
  --baseline "$PWD/data/baseline-10.1.0.json" \
  --ack-reviewed
```

4. Copy `config.example.json` to `config.local.json` and replace every placeholder. Paths must be absolute; `~` and environment-variable strings are not expanded. Use the snapshot helper's returned `recoveryCli` and `compatibilityFile`. The `cli` field points to the original global installation, for version observation and existing-worker identification only.
5. Set `root`, `spaceId`, `harnesses` and executables to the existing Runtime's exact values. Get the production identity from `user.profile.logtoUserId` in the following command; the guard expects `prod:<logtoUserId>`, not `user.uuid`.

```sh
COHUB_CLI_AUTO_UPDATE=0 cohub auth whoami --json
COHUB_CLI_AUTO_UPDATE=0 cohub runtime status --space YOUR_SPACE_ID --json
node guard.mjs check --config ./config.local.json
```

`check` verifies compatibility, account, existing consent, binding and connection. It does not restart the Runtime. Only start the watchdog after the result is understood:

```sh
node guard.mjs run --config ./config.local.json
```

Screen sharing and workspace-ready hooks are **off by default**. Set `shareScreen: true` only on macOS and only after explicitly authorizing desktop viewing/control in Cohub. When restarting, the guard applies this configured display choice. Align it with your existing authorization.

## Shared Codex App Server

With `codexShared: true`, each monitor cycle also checks the configured home's `.codex/app-server-control/app-server-control.sock` and validates `codex app-server daemon version`. The socket may be a symlink to Codex's short socket path; its target must be a socket owned by the current user. This interface was checked with Codex 0.163.0 on macOS. Custom `CODEX_HOME` layouts are not supported by this guard.

If the socket is missing or refuses connections for two continuously observed minutes, the guard calls the idempotent `codex app-server daemon start` and verifies the result. This shares the normal pause, cooldown and hourly recovery limits. Recovering only the shared daemon does not stop an otherwise healthy Runtime. When the Runtime itself needs recovery, its already-running shared app-server is preserved.

The guard never stops, restarts or upgrades the shared daemon, changes provider/model settings, replays prompts or imports history. Permission errors, timeouts, malformed replies, ownership changes and non-socket control paths remain visible failures; they do not authorize cleanup or forced restarts. A hung but still-present shared daemon therefore needs investigation rather than automatic termination.

## Commands

```sh
node guard.mjs status --config ./config.local.json
node guard.mjs check --config ./config.local.json
node guard.mjs pause --config ./config.local.json
node guard.mjs resume --config ./config.local.json
```

`status` reads the most recent monitor result; `stale: true` means it is not current online evidence. `pause` stops new recoveries but leaves monitoring and any in-flight recovery alone. **Pause before intentionally shutting down the Runtime**, or the watchdog will interpret the shutdown as a recoverable failure.

To manage multiple Spaces, use a separate configuration and private state directory for each. Do not run this public copy alongside another guard for the same Space, even with a different state directory: the singleton lock is per state directory, not a cross-application lock.

## CLI Upgrades

The guard always executes the reviewed copy. `compatibility.version` is that recovery version; `installedVersion` is the global CLI version when readable. A global code/dependency change sets `upgradeStatus: review_required`; a partial or missing install sets `upgradeStatus: unavailable`. Both are informational and monitoring/recovery continues through the reviewed copy.

Only a damaged reviewed copy or baseline blocks recovery. This protection is not bypassed. To adopt a newer CLI, review and test it, create a new snapshot and baseline at new paths, pause/stop the guard, update its configuration, run `check`, then restart and resume the guard. Do not modify a reviewed copy in place or regenerate a fingerprint merely to silence an error. The guard does not auto-upgrade Cohub, automatically review releases, or promise indefinite compatibility with server changes.

## Proxy And Network Supervision

Every CLI call refreshes network configuration. Explicit HTTP/HTTPS environment settings take priority; otherwise macOS HTTP/HTTPS system proxies are read again, including exception lists. Lowercase variables are normalized, contradictory uppercase/lowercase values are rejected, and HTTP `ALL_PROXY` is translated consistently for Node and the workspace transport. SOCKS URLs and PAC/WPAD are detected but are not silently treated as direct connections. System HTTP-only configuration requires an explicit HTTPS routing decision.

Loopback services stay local through `NO_PROXY`, including IPv6 loopback. Exact host, suffix/wildcard and port-qualified bypass rules are monitored; CIDR system exceptions are preserved with a warning because native Node `NO_PROXY` does not implement CIDR matching. A configured bypass is never silently removed to force traffic through a proxy, and a failed proxy never triggers an unapproved direct-route fallback.

The latest `state.json` contains `network.source`, sanitized per-target routes, a credential-free route fingerprint, proxy TCP checks, fault `code`, remediation `action`, `since` and `nextCheckAt`. Only active target proxies are checked. Endpoint or bypass changes are logged; healthy tasks are not restarted just because configuration changed. Diagnostic HTTP requests use the same route and trust settings as recovery commands, not the guard process's default direct `fetch`.

| Condition | Watchdog response |
| --- | --- |
| Proxy disabled, changed address/port or replaced installation | Re-read settings; subsequent probes and launches use the current route. |
| Proxy refused, unreachable, DNS failure or stalled CONNECT | Record the specific phase, retry current configuration each monitoring cycle, and do not spend Runtime restart budget while that route is blocked. |
| Proxy returns 407 | Report `proxy_auth_required`; retry after configured credentials change, never guess credentials or log them. |
| CONNECT rejected, upstream 429/5xx | Distinguish proxy rejection from upstream failure and wait/retry instead of repeatedly killing tasks. |
| Expired, self-signed or otherwise invalid TLS certificate | Keep verification enabled and report a trust failure. An explicitly supplied, readable PEM `NODE_EXTRA_CA_CERTS` bundle is validated, passed to child processes and rechecked for rotation/removal. Unsafe TLS-disable settings are not inherited. |
| `NO_PROXY` sends failed target traffic direct | Report bypass-related failure; do not secretly rewrite the user's routing policy. |
| Network restored but Runtime still disconnected | Require a fresh continuous failure period and valid account/consent/ownership, then perform bounded recovery using the working route. |
| HTTP works but harness/WebSocket or workspace relay remains disconnected | Keep transport fields visibly disconnected, save connection/lease diagnostics and apply the existing bounded recovery/circuit breaker; do not call the Runtime healthy merely because HTTP succeeds. |
| Invalid configuration, unsupported PAC/SOCKS or unreadable CA file | Keep fault state and actionable reason, re-read on subsequent cycles, and refuse unsafe recovery. |

Network faults do not consume the Runtime restart allowance; account preflight is also checked before reserving an attempt. The watchdog does **not** restart VPN/proxy applications, edit system proxy settings, install certificates, disable TLS checks, or repair a broken upstream service. Cases requiring those actions stay visibly blocked rather than pretending to be fixed.

## Run At Login On macOS

An example LaunchAgent is in `examples/launchd.plist`. Replace every `REPLACE_*` value with absolute paths and create the private log directory. Use a unique label for each configured Space, put the completed file in `~/Library/LaunchAgents/`, and load it:

```sh
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/dev.cohub-local-runtime-guard.plist
```

To stop that guard service without stopping the Runtime:

```sh
launchctl bootout "gui/$(id -u)/dev.cohub-local-runtime-guard"
```

The example restarts a crashed watchdog but does not alter macOS sleep settings. Sleeping or powered-off machines cannot stay connected.

## Diagnostics And Privacy

The configured state directory contains `state.json`, `control.json`, `events.jsonl`, `lock.json` and bounded `incidents/` snapshots. State must remain local and private. Event logs rotate at about 5 MiB with three archives; the newest ten incident snapshots are retained. Raw Cohub logs are neither deleted nor bundled.

Incident snapshots select connection/heartbeat/lease fields and make credential-redaction attempts; they do not include command or prompt bodies. Identifiers and other sensitive data may still appear in error messages. Inspect any diagnostic file before sharing it. **Never commit state, private configuration, credentials, logs or CLI snapshots.** The repository's `.gitignore` covers its default local artifact names, not arbitrary external paths.

Optional `readyHooks: true` dispatches existing `.cohub/hooks/*.json` workspace-ready commands once per observed Runtime ID. It may run commands as your account via the configured Space. Enable it only for hooks you trust. It is not exactly-once delivery across crashes and is not prompt replay; YAML, symlinks and turn-finalized hooks are not dispatched.

## Tests

```sh
npm test
```

Tests use temporary directories, synthetic CLI replies and isolated Node workers. Local transport tests additionally start real loopback HTTP/CONNECT proxies, TLS servers and Unix sockets; `openssl` is used only to generate an ephemeral test certificate. They do not contact a real Space, start a model, intentionally disconnect a production Runtime, or call reset. Coverage includes shared-mode consent matching, shared-daemon recovery without stopping the Runtime, socket symlinks, malformed daemon replies, failed starts, pause, malformed data, ownership changes, child-process protection, cooldowns, global CLI replacement between stop and start, damaged reviewed copies, route changes, proxy authentication/recovery, CONNECT timeouts, `NO_PROXY`, certificate rejection and explicitly trusted CA recovery.

## License

MIT for this project's original code. Cohub and harness software are separate dependencies, are not redistributed here, and retain their own licenses. This project is not affiliated with or endorsed by Cohub.
