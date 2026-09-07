# DB-HO116 — issue #372 Windows protected-pipe re-arm

Date: 2026-09-01

Status: physical defect reproduced in a disposable compiled-host integration test; owner-local correction and complete local qualification passed; hosted qualification pending

Coordinates with: #360, #362, #372, #430, DB-003, DB-008, DB-009, DB-011, DB-019, DB-020, DB-HO110, DB-HO113, and DB-HO115.

## Physical checkpoint

PR #437 merged as exact Stage 8 head `7c4edd4a044cefccb455fe5141083f6e387077bc`. Pull-request run `33558729096` and fresh post-integration run `33559135053` each passed all four Ubuntu/Windows smoke/full jobs. Install-only then bound the canonical component, selected runner, and pinned runner to that exact head.

One ordinary `devbridge setup` invocation requested UAC at elapsed setup time zero. The operator accepted the single child. The bounded protected transaction remained live through 190 seconds, promoted the exact new runtime candidate, then rejected candidate health with `environment configuration authority is unavailable` and restored exact previous generation `83e931ffb86024ef868caff3fac67cd28d0cf144d5b9b78e2a82d434ece9c4cf`. No retry followed.

The provider-logon transition itself persisted safely: SCM reports the restored service Running/Automatic under `LocalSystem`, with the exact five endpoints in its command. All five pipe names are present. Read-only inspection showed adjacent successful and unavailable lifecycle/configuration calls, and 30 sequential configuration inspections produced 29 successes and one false transport-unavailable result. No service, group, ACL, WMI, provider, network, image, VM, guest, PATH, or installation state was manually changed.

## Reproduction and diagnosis

The preexisting compiled-host proof made one configuration request and retried it up to twenty times. Strengthening the disposable ordinary-process harness to require 30 immediate public-client requests, with no test-level retry, reproduced the failure. Native diagnostic observation classified the failing next write as Windows `EPIPE`.

The protected host intentionally keeps one `NamedPipeServerStream` instance per capability so the .NET Framework constructor requests first-instance ownership. After a response, the old client can close before the server completes `Disconnect` and re-enters `WaitForConnection`. A following `CreateFile` may therefore observe either no/busy listener or a stale instance that is disconnected before its first request byte is accepted.

Microsoft's named-pipe client contract requires waiting when the only instance is busy. Microsoft also states that `WaitNamedPipe` success does not guarantee the following open because the server may close the instance or another client may acquire it. `CreateFile` reports `ERROR_FILE_NOT_FOUND` before a server instance exists and `ERROR_PIPE_BUSY` when no listener instance is available.

Official references:

- https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-client
- https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-waitnamedpipea
- https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea

## Rejected partial correction

A first local adapter retried only transient Windows pipe-open `ENOENT`/`EBUSY`. Focused tests passed, but the live historical service still produced a post-connect failure. That partial approach was fully removed before reassessment. The disposable compiled-host test then proved the remaining zero-response `EPIPE` re-arm race, so setup delay, a larger health timeout, and an open-only retry are insufficient.

## Nested correction

1. **LEGO:** one neutral local-authority transaction adapter owns Windows connection/re-arm mechanics. Lifecycle, activity, and configuration transports retain their distinct endpoints, protocols, framing, bounds, cancellation, and error vocabulary.
2. **SOLID:** the adapter retries only transport observations it can classify without knowing provider or setup topology. Each transport alone classifies `operation: inspect`; no mutation semantics move into the adapter.
3. **CUPID:** the behavior is fixed and predictable: retry local Windows `ENOENT`/`EBUSY` opens and zero-response `EPIPE` inspections only within the original connect deadline. Linux remains a single open attempt.
4. **KISS:** preserve one first-instance server per capability. Add no server instance, helper service, delayed UAC, setup sleep, caller-selected timeout, response replay store, or general retry loop.

The client waits for server termination before completing a received response. On Windows, server `Disconnect` may surface as `EPIPE`; one complete bounded frame remains acceptable, while missing, partial, oversized, malformed, or multi-frame results fail closed. A zero-response `EPIPE` may be retried only for exact `inspect`. Reconcile, run, prepare, exchange, every other operation, and every partial response are never replayed.

## Qualification evidence and remaining gates

Final focused bytes pass 34/34 across the shared adapter, lifecycle/activity/configuration transports, protected-host composition, and compiled Windows host. The disposable compiled host now serves 30 immediate public configuration inspections without a caller-level retry, installs no service, and deletes every temporary compiler/runtime artifact. Boundary tests prove denial and Linux absence are not retried, the original deadline remains authoritative, zero-response inspection alone is replayable, and mutations/partial responses remain single-attempt.

The first complete exact-Node run exposed a separate liveness defect in the new shared adapter: zero assertions failed, but an unreferenced retry-delay timer allowed four test files to terminate with twelve cancelled cases when the bounded delay was the process's only live handle. The adapter now keeps that awaited bounded timer referenced. This changes neither the original deadline nor retry eligibility. The six directly affected files then passed 34/34 with zero cancellations.

Final supported-minimum Node 22.16.0 qualification passed:

- bounded repository preflight: two standalone artifacts, 256 syntax files, two JSON files, and 206 dependency-selected test files;
- complete serialized suite: 2,116 total, 2,095 passed, 21 expected platform skips, zero failed, zero cancelled, exit 0, in 350.4 seconds;
- read-only doctor: `ok: true`, GitHub CLI authentication and native C/CMake/CTest toolchains available, with repository execution truthfully unavailable and lifecycle `setup-reentry-required`; and
- standalone regeneration, exact framing/transport boundaries, generated-artifact checks through preflight, and diff hygiene: passed.

The official Node archive and checksum list were used only below the exact LocalAppData Temp directory `devbridge-node-22.16.0-dbho116`. After qualification, that runtime and the eight exact test directories stranded by the intentionally interrupted/cancelled diagnostic runs were deleted and absence was verified. No unrelated Temp content was touched.

Before another physical setup authorization, require syntax/preflight, transport/authority/architecture gates, exact supported-minimum Node 22.16 qualification, the complete serialized suite, doctor, artifact/diff/disposable hygiene, a narrow PR with all four hosted jobs, merge into Stage 8, and a fresh four-job post-integration run. Only then install the exact accepted head and request one new ordinary setup/UAC attempt. GitHub task receipt and Hello World compile/test remain downstream of route health.
