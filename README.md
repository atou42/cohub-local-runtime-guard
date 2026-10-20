# Cohub Local Runtime Guard

A small, dependency-free watchdog for an existing [Cohub](https://cohub.live) Local Runtime. It detects sustained disconnection or process death, saves diagnostic evidence, and keeps attempting recovery with short exponential backoff without deleting conversation history or replaying prompts.

This is an independent recovery tool, not an official Cohub component and not a fix for the client's internal reconnect behavior. **Restarting a Runtime can interrupt its tasks.** It does not use reset operations or reset credits.

## Recovery Policy

- Check every 10 seconds; require two minutes of continuously confirmed failure before the first recovery. Wake earlier when a short retry becomes due.
- Preserve active or unknown executions during short disconnects. Continuous `reconnecting` status or fresh `runtime.heartbeat_timeout` evidence from the same worker authorizes recovery after `disconnectedMs` (default 240000, four minutes), even with active executions. Healthy status, evidence of a new ready connection or received heartbeat, a replacement worker, pause, or a monitoring gap resets the timer. Malformed diagnostics remain a visible blocker. Other connection faults still require a recent explicit zero execution count and a disconnected harness before normal recovery. Recheck immediately before stopping and before forced termination; pending journals cannot shorten a new outage. The legacy `executionDisconnectMs` setting remains accepted but does not accelerate restarts.
- For an overdue transport outage, send SIGTERM only to the identity-verified worker, wait up to `graceMs`, then use SIGKILL if it is still stuck. Recheck ownership, connection state and competing environments before each signal. Never signal a process group, shared app-server or child process; children do not indefinitely prevent termination of an overdue worker. Interrupted Runtime tasks may be aborted, but are never replayed by the guard.
- There is no hourly recovery cap, retry-count ceiling, long cooldown or `rate_limited` stop state. After a failed attempt, wait 5, 10, 20, 40, then at most 60 seconds between attempts, indefinitely while the outage remains recoverable. Retry state survives guard restarts and resets on verified health.
- Do not restart on an ambiguous API timeout, changed account or consent, malformed state, or another Runtime owning the Space.
- Stop gracefully first. After a 30-second grace period, force-stop only a verified Runtime parent with unchanged ownership and no remaining child processes. Never signal an entire process group.
- Keep state, conversation history, native logs and task outputs. Never clear corrupted state to make a check pass.
- Run recovery commands through a separate, reviewed CLI copy. A global CLI upgrade, including a temporarily incomplete install, does not disable the guard or expose recovery to unknown startup code.

## Requirements

Node.js 22.21+ or 24+, a separately installed Cohub CLI, and an existing authorized Local Runtime. No npm dependencies or installation hooks are required for this project.

The production watchdog has been exercised on macOS. The synthetic process tests also run in Linux CI; that is not a claim of Linux production validation. Windows is not supported. Native consent configuration version 2 and the CLI status/control interfaces must match the implementation. CLI 10.6.0 passes the isolated behavioral checks described below; 10.1.0 legacy baselines remain supported. There is no hardcoded approved-version list. A fingerprint is change detection, not a security audit or a guarantee of future server protocol compatibility.

## Setup

Start and authorize your Runtime using Cohub's normal interactive workflow first. This guard must not be used to grant new synchronization, execution, shared Codex control or screen-sharing consent. Set `codexShared` to match the existing native configuration exactly. It defaults to `false` for existing private-control setups; set it to `true` only after shared control has already been authorized in Cohub. Enabling it also requires the `codex` harness.

1. Clone this repository and run `npm test`.
2. Review the installed Cohub CLI that you intend to use for recovery. Do not acknowledge unknown code only to clear a warning.
3. Make an independent copy of its complete package, including installed dependencies. After explicit review, the snapshot helper executes the copied CLI in a disposable HOME to verify command flags, existing consent preservation, no history import, and the actual connection loop under an active-execution `1006` disconnect. It starts only a loopback WebSocket fixture, not a real Runtime, harness or model. This is isolation from production configuration, not an OS security sandbox: review remains mandatory. It requires existing parent directories and refuses to overwrite a copy or baseline.

```sh
mkdir -p ./data
node scripts/snapshot-cli.mjs \
  --source /absolute/path/to/installed/cohub-cli \
  --destination "$PWD/data/reviewed-cli-10.6.0" \
  --baseline "$PWD/data/baseline-10.6.0.json" \
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

If the socket is missing or refuses connections for two continuously observed minutes, the guard calls the idempotent `codex app-server daemon start` and verifies the result. This shares the normal pause and short retry backoff, with no hourly limit. Recovering only the shared daemon does not stop an otherwise healthy Runtime. When the Runtime itself needs recovery, its already-running shared app-server is preserved.

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

For installations migrating from the original local Chinese-named guard, `stateLayout: "legacy-zh"` preserves its existing state, pause control, recovery budget, diagnostics and singleton lock filenames. It does not reset or copy state. Keep the same state directory and stop the previous guard before starting this one. Other installations should retain the default `"standard"` layout.

## CLI Upgrades

The guard always executes the reviewed copy. `compatibility.version` is that recovery version; `installedVersion` is the global CLI version when readable. A global code/dependency change sets `upgradeStatus: review_required`; a partial or missing install sets `upgradeStatus: unavailable`. Both are informational and monitoring/recovery continues through the reviewed copy.

### Preserve The Reviewed Dependency Lock

Do not repeat `npm install -g @neta-art/cohub-cli@VERSION` or install its tarball globally after reviewing a candidate. Those commands can resolve dependency ranges again. For example, CLI 10.6.0 declares `@neta-art/generation: ^0.1.39`: a candidate can contain 0.1.39 while a later global install contains 0.1.40, even though both CLI tarballs have the same integrity. This is a genuine change to the reviewed dependency set.

Keep the dedicated review project's `package.json`, `package-lock.json`, any referenced local CLI tarball, and the complete reviewed candidate. The project must have only the CLI as its direct dependency. Lockfile versions 2 and 3 are supported; package entries must have SHA-512 integrity and an npm registry URL, except the CLI may reference an adjacent `file:../...tgz`.

To update an **existing** global package from that exact reviewed lock:

```sh
node scripts/install-locked-cli.mjs \
  --project /absolute/path/to/review-project \
  --reviewed-cli /absolute/path/to/reviewed-candidate/bin/cohub.js \
  --destination /absolute/path/to/global/node_modules/@neta-art/cohub-cli \
  --ack-reviewed
```

The helper runs `npm ci --ignore-scripts` in an isolated sibling of the review project, preserving relative tarball references and leaving the original project untouched. It prepares a self-contained package, checks the version fingerprint **and all package-file bytes** against the reviewed candidate, then replaces the global package directory while retaining the previous installation as a backup. Only npm-generated top-level dependency bin links and the hidden lock record are excluded from the byte comparison. Dependency layouts that would overwrite nested packages are rejected, not silently rearranged. An unavailable locked dependency, integrity error, changed candidate or changed destination aborts installation and retains evidence.

The existing global executable link remains in place; this helper does not create a new global installation. It never executes Cohub, changes a compatibility baseline or configuration, or stops/restarts a guard, Runtime or shared daemon. Installing the global package is separate from activating it for recovery. Do not use a new lockfile or change the reviewed candidate just to bypass a mismatch.

Only a damaged reviewed copy or baseline blocks recovery. This protection is not bypassed. To adopt a newer CLI, review and test it, create a new snapshot and baseline at new paths, pause/stop the guard, update its configuration, run `check`, then restart and resume the guard. Do not modify a reviewed copy in place or regenerate a fingerprint merely to silence an error. The guard does not auto-upgrade Cohub, automatically review releases, or promise indefinite compatibility with server changes.

New snapshots use baseline schema 2: an exact reviewed version and source/dependency-version fingerprint, plus a passing `cohub-runtime-guard/v2` behavioral record. Future versions can be adopted through the same verifier instead of editing a version allowlist. An interface change or failed check blocks publication of the new baseline and retains isolated evidence; it does not disable the old reviewed copy. Existing schema 1 baselines retain their original fingerprint-only semantics.

To verify a reviewed candidate without publishing a snapshot:

```sh
node scripts/verify-cli.mjs --cli /absolute/path/to/cohub-cli/bin/cohub.js --ack-reviewed
```

### CLI 10.6.0 Findings

The published 10.6.0 `dist/runtime/connection.js` is byte-identical to 10.1.0. Its connection loop waits for active execution promises to settle after a nonfatal abnormal close before returning to reconnect. The isolated real-WebSocket check on 2026-10-20 observed close code `1006`, one active execution, no second ready during a 2.5-second hold, and a second ready after releasing that execution (`activeExecution1006: "waits_for_execution"`). A short outage alone is not evidence that the model is stuck. Restarting that Runtime aborts its active turns, so the guard preserves work within the configurable `disconnectedMs` window. Sustained transport loss beyond that window overrides execution protection rather than leaving an offline worker alive indefinitely. It does not repair the CLI's delayed reconnect, replay prompts, or promise uninterrupted streaming. Future versions reporting `"reconnects"` are also accepted if all checks pass.

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

## Recovery Transactions and Retries

The 2026-10-20 failure involved a successful stop followed by `another_runtime`: the old remote lease could still appear online after the local process exited. The former implementation abandoned startup, spent another operation on the later start, and exhausted the hourly budget. The guard now journals the operation before its first side effect, including scope, original PID, process identity, owner nonce, phase, attempts and retry time.

A lease matching the journaled original Runtime does not permanently block recovery once its original process is verified gone. The guard retries ordinary startup under the same operation, with backoff if the server still rejects the old lease; it does not force lease takeover. A different remote instance blocks continuation, including a different offline identity during pending recovery. Ownership, original process identity and owner nonce are checked again before mutation. A guard interruption or an uncertain startup response cannot authorize killing a replacement process or blindly starting a duplicate. Corrupt journals fail closed and are preserved.

Default policy (optional configuration fields):

| Field | Default | Meaning |
|---|---:|---|
| `retryBaseMs` | 5000 | Initial retry delay |
| `retryMaxMs` | 60000 | Maximum retry delay; cannot exceed 60000 |

The delay doubles after each unsuccessful recovery invocation and is capped at `retryMaxMs`. The deadline is persisted before recovery and updated from completion, so a slow failing command cannot cause a tight retry loop. The initial outage-confirmation window is not added again to every retry of the same confirmed outage. Probe and command execution time is additional to the delay. Successful recovery or a later healthy observation clears backoff; audit history is retained.

Old configuration fields `cooldownMs`, `maxRestartsPerHour`, `resumeRetryMs`, `maxResumeAttempts`, `escalationIntervalMs` and `staleHeartbeatMs` are accepted when well-formed but discarded, so an existing installation does not need a configuration rewrite. Old restart histories and escalation timestamps impose no delay or quota. Pending operations from older releases use the new capped delay, not their old retry deadlines.

Stopped/disconnected records and missing heartbeat evidence do not impose an additional retry gate. Remote lifecycle fields remain read-only diagnostics, fetched through the reviewed CLI's client in a bounded child process using the same proxy settings. The normal status probe must still establish a recoverable outage; ambiguous API failures are not inferred to mean offline. Pause, CLI compatibility, native consent, account, process identity, network and genuine duplicate-instance checks are never bypassed.

`health` events retain remote runtime ID, workspace state, observation time, projected lifecycle evidence and `nextEligibleAt`. `retry_backoff` means a scheduled retry, not a stopped recovery policy. `startup_probe` captures the stop/start boundary. `recovery_blocked` reports conflicting instances to the event log and stderr, repeating at most once per minute for the same reason/instance. The notice marker survives guard restarts; no external notification service is installed.

The 18:20 forced-stop failure is also covered: a defunct/zombie `ps` entry after SIGKILL is no longer misclassified as a live unapproved worker. Post-kill checks track the original identity rather than signalling a reused PID. An independently verified, healthy replacement is adopted without another start; process-inspection errors, live unrelated owners and unverified replacements still block mutation.

These changes modify the guard, not CLI 10.6.0's connection loop. No task is replayed, and interrupted work is not guaranteed seamless continuation. Updating this repository does not install it into an existing immutable guard release or restart production services.

## Tests

```sh
npm test
```

Tests use temporary directories, synthetic CLI replies and isolated Node workers. Locked-install tests use `tar` and real offline `npm ci` with a private synthetic package cache; they check exact dependency restoration, disabled install hooks, byte-level mismatch rejection, failed installs and publication rollback. Local transport tests additionally start real loopback HTTP/CONNECT proxies, TLS servers and Unix sockets; `openssl` is used only to generate an ephemeral test certificate. They do not contact a real Space, start a model, intentionally disconnect a production Runtime, or call reset. Coverage includes retaining workers during short active-execution disconnects, restarting overdue reconnecting and heartbeat-timeout workers, actual SIGTERM/SIGKILL escalation, reset on heartbeat recovery, competing environments at both signal boundaries, pending-journal protection, unknown activity blocking generic recovery, rejection of stale/foreign/malformed idle evidence, schema 2 verification failures, legacy state preservation, shared-mode consent matching, shared-daemon recovery without stopping the Runtime, socket symlinks, malformed daemon replies, failed starts, pause, malformed data, ownership changes, child-process protection outside overdue transport outages, short backoff, global CLI replacement between stop and start, damaged reviewed copies, route changes, proxy authentication/recovery, CONNECT timeouts, `NO_PROXY`, certificate rejection and explicitly trusted CA recovery. Run the separate candidate verifier above against each reviewed CLI release; `npm test` does not require an installed Cohub CLI.

Additional regressions replay the October 20 split-accounting timeline and the later forced-stop failure, including own-lease retries, interrupted transactions, competing instances, persistent notices, successful-but-unobserved startup, zombie exit observations and adoption of a verified replacement. Retry tests cover over an hour of consecutive failed CLI starts with simulated time and guard restarts, a policy replay exceeding three hours, exponential growth and its one-minute ceiling, legacy-limit removal, eventual recovery and reset, and continued protection against `another_runtime`.

## License

MIT for this project's original code. Cohub and harness software are separate dependencies, are not redistributed here, and retain their own licenses. This project is not affiliated with or endorsed by Cohub.
