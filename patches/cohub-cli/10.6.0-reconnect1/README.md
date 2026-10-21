# Cohub CLI 10.6.0-reconnect1

An isolated local patch of CLI 10.6.0. The CLI's version output remains `10.6.0`; identify this build by the fingerprint in `manifest.json`. The installed generation package and the CLI dependency declaration are both pinned to `0.1.39`.

`reconnect.patch` changes `dist/runtime/connection.js`, adds `dist/runtime/reconnect-executions.js`, and pins the generation dependency in `package.json`. `manifest.json` records the original and resulting compatibility fingerprints, complete package digests, and patch hash. `dependencies.lock.json` records all installed package versions and a digest of the complete dependency tree. Preparation copies that exact tree without asking npm to resolve dependency ranges.

## Behavior

The runtime owns active execution, request identity, durable result delivery, and acknowledgement state across control socket generations. Ordinary transport loss stops the old heartbeat and releases the connection loop to its existing jittered backoff (500 ms initial window, 30 s maximum window). Running model/tool work continues.

A new connection announces both running tasks and persisted receipts. A start/resume/recovery request attaches a delivery subscription by session, turn, and harness identity. A recovery request with a new request ID observes the existing execution. Cancelling a recovery subscription does not cancel the native task. A completed task with no live subscriber advertises its receipt again.

Commits are retained in memory while work is running; the existing `ExecutionResults` implementation persists commits and the terminal result before terminal delivery. A peer resume can replay results even if the shared runtime control socket stayed open. Concurrent acknowledgements share one receipt deletion. Server resolution fences old acknowledgements and waits for acknowledgement IO before the next turn can replace a session receipt. Acknowledged request/turn identities are remembered in bounded caches (4,096 entries each).

Model/tool execution is deduplicated. Durable transport delivery remains **at least once**: after a lost acknowledgement, the same stable message ordinals may travel again. The gateway/agent's existing durable keys must deduplicate those frames. This patch does not claim exactly-once network delivery. Tests check one native execution, stable replay, one receipt acknowledgement, and no duplicate durable projection writes.

Permission/protocol rejection (4403/4400), lease conflict (4409), explicit user stop, and supervisor shutdown retain cancellation semantics. Native socket requests fail on the old connection and are available through a fresh native channel after reconnect. Existing cold recovery and uncertain-outcome rules remain in place.

## Prepare another isolated copy

Run from the guard repository. Both destination and baseline must be new paths; the source must match the reviewed 10.6.0 digest in the manifest.

```bash
node scripts/prepare-reconnect-cli.mjs \
  --source /absolute/path/to/10.6.0 \
  --destination /absolute/path/to/10.6.0-reconnect1 \
  --baseline /absolute/path/to/CLI-10.6.0-reconnect1.json
```

The script copies the original, checks and applies the patch, verifies full package/dependency integrity, runs the guard's isolated CLI contract, and publishes the new copy. It refuses existing or overlapping paths. It does not change a running runtime, global npm package, guard configuration, or proxy configuration.

## Verification

The added integration suite uses real local WebSocket/TCP termination, the installed CLI's actual native runtime and receipt store, and a separate fake Pi executable that writes an observable side effect. It does not use a real model or the user's native sessions. Its cases cover idle/running/offline completion/result-write disconnects, repeated disconnects, changed recovery IDs, peer-only resume, lost and duplicate ACKs, delayed ACKs across reconnect and session admission, context requests, native channels, invalid ACK identities, permission/lease rejection, and explicit cancellation.

```bash
node scripts/test-reconnect-cli.mjs \
  --cli /absolute/path/to/10.6.0-reconnect1 \
  --output /absolute/path/to/evidence \
  --suite regression
```

To run the existing CLI tests against the installed patch:

```bash
node scripts/test-reconnect-cli.mjs \
  --cli /absolute/path/to/10.6.0-reconnect1 \
  --output /absolute/path/to/evidence \
  --suite upstream \
  --reference /absolute/path/to/cohub-checkout \
  --test-deps /absolute/path/to/test-dependencies

npm test
```

`test-reconnect-cli.mjs` gives each suite a clean temporary home and a canonical temporary directory (macOS `/tmp` symlinks otherwise break the Pi fixture's socket identity). It records the imported installed CLI paths and refuses to report success if the CLI fingerprint changes during a run. The loader redirects CLI source imports to the candidate's compiled files. It also corrects the upstream test fixture's use of URL pathname as an executable path, which fails in a checkout containing non-ASCII characters. Production files are not changed by either test adaptation.

The reference checkout used here lacks an installed `@cohub/infra/logging` workspace link and `@opentelemetry/api`. The loader resolves logging to the reference source. The optional `--test-deps` directory supplies the unmodified `@opentelemetry/api@1.9.1` package for those tests; it is separate from the candidate and its locked dependency tree. Prepare that directory with `npm install --prefix /absolute/path/to/test-dependencies --ignore-scripts --no-audit --no-fund --save-exact @opentelemetry/api@1.9.1` when needed.

## Remaining boundary

The workspace relay is not patched. The reference sandboxd client treats a 409 configuration rejection as a five-minute retry delay. The current inherited control pipe only updates authentication; it cannot wake that wait. Restarting sandboxd can interrupt its subprocesses and data channels. A safe fix needs a separately verified sandboxd retry/control change, including lease-conflict behavior. Main-channel recovery alone does not prove that the workspace relay recovered. The guard now reports a workspace-only failure and retains the worker; whole-worker recovery requires a sustained task/control outage.

Preparation does not activate this build. The investigation and local rollout record are maintained separately; [rollout and validation notes](../../../docs/reconnect1-rollout.md) describe the deployment procedure.

## Attribution

The CLI patch modifies Cohub 10.6.0, Copyright 2026 Viscept Limited, under Apache-2.0. The modifications are the three files listed above and described in this document. The accompanying `LICENSE` and `NOTICE` preserve the upstream license and attribution; the local CLI modifications use the same license.
