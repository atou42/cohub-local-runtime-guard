# Reconnect1 rollout and validation

A workspace relay failure can make the CLI report `reconnecting` even while its task/control connection remains online. The previous guard could count that aggregate state toward a whole-worker restart, interrupting native execution during a file bridge 409 retry. The revised policy uses the actual control connection.

| Observation | Guard behavior |
| --- | --- |
| Control connected, workspace disconnected locally or remotely | Report `workspace_unavailable`, retain the worker, reset its outage timer, and emit a log/stderr notice at most once per minute. |
| Control disconnected, workspace either connected or disconnected | Observe continuously for `disconnectedMs` (default four minutes), including confirmed idle workers. Only then permit recovery after the usual identity, account, consent and network checks. |
| Control recovered before SIGTERM or SIGKILL | Revoke stop authorization even if the workspace is still unavailable. |
| Another environment owns the remote Runtime | Retain the conflict protection; never replace that environment. |
| Confirmed process death or shared-daemon absence | Keep the existing confirmation and repair behavior. Shared-daemon repair does not stop the worker. |

Active and unknown executions stay protected within the control outage window. A new connection, changed worker, monitoring gap, or workspace-only interval invalidates the old outage timer. A pending recovery journal cannot shorten a new control outage. Recovery attempts continue without a total cap, with the existing five-second to one-minute backoff.

The separately reviewed [10.6.0-reconnect1 CLI patch](../patches/cohub-cli/10.6.0-reconnect1/README.md) reconnects the control transport while execution continues, preserves native execution and result/ACK state across sockets, and pins generation to **0.1.39**. CLI version output remains `10.6.0`; the selected path and fingerprint identify the patched build.

| Artifact | SHA-256 / fingerprint |
| --- | --- |
| Original CLI compatibility fingerprint | `30206d37d3d52e3e32546c9aaa9c1c8d32780c9a8477f909772608948129c0d0` |
| Reconnect1 compatibility fingerprint | `74bdfe921f1d044aaf6139e0cf66c8774d07ca4262c862e3edeef2dfeca6ee91` |
| Reconnect1 complete package | `63a5810d98a7062ffed09719469de436c436ab2e6e72051456774814aa09a169` |
| Patch | `18022664cdee6c0373e3c5c9d2835f4ef4d59440b031a59dab96679136ba540a` |

## Validation on 2026-10-21

- Guard full suite: **129/129 passed**, zero failures, cancellations or skips. This includes workspace-only 409 retention, notice throttling across guard restarts, the four-minute control outage threshold, both signal boundaries, subsequent outages, persistent retries, pending recovery and competing-instance protection.
- Reconnect1 TCP/WebSocket regression: **20/20 passed**, zero failures, cancellations or skips. The runner verified the candidate fingerprint before and after testing.
- Earlier isolated candidate validation: **68/68 upstream CLI tests passed**, including real Gateway/Agent/SDK recovery flows. The source checkout and the globally installed CLI were left unchanged.
- Independent reconstruction matched the complete package digest. The real compatibility contract observed a 1006 and a second ready connection while native execution remained active (`activeExecution1006: reconnects`).

Run the guard suite and the separate candidate regression before deployment:

```sh
npm test
node scripts/test-reconnect-cli.mjs \
  --cli /absolute/reviewed-cli/10.6.0-reconnect1 \
  --output /absolute/validation-evidence \
  --suite regression
```

The first full guard run identified older tests that assumed a two-minute idle-control outage or intercepted the previous CLI stop path. Those tests now simulate the complete four-minute observation period and the actual signal/journal boundaries. The final counts above describe the passing run.

## Deployment scope and procedure

The authorized rollout selects reconnect1 and its new compatibility baseline for **Home**. **Bot** retains its original reviewed 10.6.0 CLI and baseline. Both guards load the revised control-only restart policy. Keep `disconnectedMs` at 240000.

1. Commit and push the guard policy, CLI patch, regression fixtures and documentation together. Verify that remote `main`, the working tree and the installed guard release match that commit.
2. Record the passing test counts, selected artifacts, current process identities and recovery steps in the local investigation document **before reloading either guard**.
3. Validate account, native consent, workspace binding, ownership and proxy route. Preserve the old CLI, baseline, launcher and Home configuration for rollback.
4. Pause new recovery actions, wait for the guards to acknowledge the pause, and unload the old guard services. Use the reviewed CLI's normal stop command to stop Home for this explicitly authorized maintenance operation. Retain all runtime data and native consent; do not signal a process group or stop the shared Codex daemon.
5. After Home's old worker has exited and its lease is released, select the reconnect1 recovery CLI and baseline, start Home, and verify both its control and workspace connections. Reload the guards from the committed release, restore their prior pause state, and check fresh healthy observations.
6. Verify Home's actual worker path, candidate fingerprint, generation version, remote Space status and new guard/worker PIDs. Verify Bot's worker identity and original CLI selection. Record the deployed commit and results locally.

The local operator record is `断线调查-1021.md`. Runtime configuration, credentials, webhook addresses, logs, native sessions and installed CLI snapshots are not published in this repository. Proxy settings and the global npm installation are outside this rollout.

For rollback, pause Home's guard and verify its current worker identity, stop Home normally, restore the prior reviewed recovery CLI and baseline together, and restart Home before resuming its guard. Preserve candidate artifacts and diagnostics for investigation. A control-only guard can continue supervising the original CLI; changing the CLI does not require reverting this safer workspace policy.

## Remaining limits

The sandboxd binary and its five-minute retry delay after a workspace configuration 409 are unchanged. The guard now preserves active work during that workspace-only failure; file access can remain unavailable until the relay recovers. A connected control channel alone does not establish full Runtime health. The original cause of every historical 1006, oversized native sync frames and transcript parsing limits remain separate investigation items. No production outage is deliberately induced by this rollout.
