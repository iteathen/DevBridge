# DB-HO117 — issue #372 Windows read-capability pipe re-arm

Date: 2026-09-01

Status: physical lifecycle-read defect reproduced; owner-local correction passes focused and live read-only proof; complete local and hosted qualification pending

Coordinates with: #360, #362, #368, #372, DB-003, DB-008, DB-009, DB-011, DB-019, DB-020, DB-HO113, DB-HO115, and DB-HO116.

## Physical checkpoint

PR #438 merged as exact Stage 8 head `e5f5ffbfb1e96ce24447824cf88dd27b837babd9`. Pull-request run `33564367977` passed all four Ubuntu/Windows smoke/full jobs after one unchanged Windows-smoke rerun; the first smoke attempt had an unrelated transient real `build-config` probe failure while Windows full passed the same test. Fresh post-integration run `33565085111` passed all four jobs. Install-only then bound the canonical component, selected runner, and pinned runner to that exact head.

One ordinary `devbridge setup` requested UAC at elapsed setup time zero. The operator accepted the single child. The same setup process completed its protected transaction and elevation consent at 139 seconds, completed protected-apply verification at 323 seconds, checkpointed the exact prepared subject, and entered environment activation at 324 seconds. It terminated at 346 seconds with `Protected environment activation failed: environment lifecycle authority is unavailable`. No retry followed.

Read-only inspection after the failure showed the protected service Running/Automatic under `LocalSystem`, exact new generation `19fa5bc9cadb87774c94388d536beea9ef91d156a887803b9aaa3b9a36c11cf2`, and all five named-pipe endpoints present. No service, group, ACL, WMI, provider, network, image, VM, guest, PATH, or installation state was manually changed.

## Reproduction and diagnosis

Environment activation begins with the lifecycle client `list` operation. The DB-HO116 transport correction treated only the literal `inspect` operation as replay-safe, although the lifecycle protocol already separates read capability (`inspect`, `list`, `status`, `plan`, and `setup-reentry`) from mutations (`run` and `resume`). A live `list` completed in approximately 22 seconds, matching the failed setup activation interval and locating the failure at the response/disconnect re-arm seam after expensive provider observation.

The disposable compiled Windows host regression was extended from configuration inspection to 30 immediate lifecycle `list` requests with no caller-level retry. The accepted DB-HO116 bytes failed reproducibly on lifecycle request 12 with `environment lifecycle authority is unavailable`. Activity `list` exhibited the same native zero-response `EPIPE` seam. Activity cleanup may take up to one second, so its regression retains the production/default three-second connection deadline; no product timeout was widened.

## Nested correction

1. **LEGO:** the neutral bounded local-authority transaction owns only Windows connection and zero-response re-arm mechanics. Configuration, lifecycle, and activity retain separate endpoints, protocols, framing, bounds, cancellation, and error vocabularies.
2. **SOLID:** each protocol owner classifies only its own replay-safe read operations. Lifecycle owns its existing read-operation set; activity owns `inspect`, `list`, and `observe`; configuration keeps only `inspect`. The shared adapter knows neither domain operations nor setup topology.
3. **CUPID:** fixed protocol-owned sets and the original caller deadline make the behavior predictable. Only Windows named-pipe zero-response `EPIPE` may replay, and only for an operation its owner classifies as read-only.
4. **KISS:** add no server, service, setup sleep, timeout widening, mutation replay, provider fallback, or manual repair. Rename the adapter input from the domain-specific `inspection` to the exact neutral property `replaySafe`.

Lifecycle `run`/`resume`, activity `prepare`/`exchange`, configuration `reconcile`, partial responses, denials, Linux absence, and every other error remain single-attempt and fail-closed.

## Evidence and remaining gates

Focused source tests pass 49/49, and the broader setup/authority/architecture set passes 307/307. Both current-runtime and exact Node.js 22.16.0 bounded preflights pass two standalone artifacts, 256 syntax files, two JSON files, and 206 dependency-selected test files. The exact serialized suite passes 2,118 total / 2,097 passed / 21 expected platform skips / zero failed / zero cancelled in 340.9 seconds. Exact doctor reports `ok: true`, GitHub access and native C/CMake/CTest toolchains available, and repository execution truthfully unavailable until setup completes. Diff and generated-artifact hygiene pass.

The focused and complete suites include explicit owner classification boundaries and 30 consecutive configuration inspections, 30 lifecycle lists, and 30 activity lists against the disposable compiled protected host. The installed protected service then completed three consecutive live lifecycle lists through the corrected source transport in 21,859 ms, 21,876 ms, and 22,031 ms, with no caller retry and no host mutation.

Cleanup removed and verified absence of the exact checked Node archive/runtime plus every `db-*` and `devbridge-*` test root created during qualification: 117 temporary roots and approximately 155.6 MB total. No OneDrive, D:, canonical installation, service, provider, image, VM, guest, or unrelated source path was included.

Before acceptance, require all four pull-request jobs, merge only the exact accepted head, and require a fresh four-job Stage 8 post-integration run. Install-only may bind that exact head afterward. One new ordinary setup attempt requires fresh operator authorization and may request only its immediate single UAC child.

Environment route health, GitHub task receipt, and Hello World compile/test remain downstream physical gates. Do not infer them from the read-only proof.
