# DB-HO137 — issue #372 construction file-copy host service

Date: 2026-09-02

Status: implementation complete; local qualification passed; hosted acceptance pending

Coordinates with: #372, #461, DB-HO136, and the accepted Stage 8 protected lifecycle authority.

## Physical evidence

DB-HO136 merged as exact Stage 8 head `d84ce0b7943493d47f2fdec9296ea5f628474429`, with candidate tree and integrated tree `64fea06ab1c02c1bbe46008ca509afe52ccc97a5`. Candidate run `33686460003` and fresh Stage 8 run `33686836877` each passed all four Ubuntu/Windows smoke and full jobs. Supported setup installed and prepared that exact head.

One supported public `devbridge setup --construct` attempt created immutable v7 subject `subject-0e87a6f97256777648ab4ce230f94589` and provider `a6208220-ca71-47e7-9f7b-5081e53d899f`. The same subject progressed through installation to its installed-disk qualification phase, with VHDX allocation reaching 10,573,840,384 bytes. Qualification failed closed because its operation exited unsuccessfully without stderr. The subject remains active in phase `qualifying`; it was not deleted, repaired, or replaced.

Read-only Hyper-V evidence identifies the missing host-side contract. Exact VM `db-image-build-eefdbf45a26f3197` is owned and running, while its built-in `Guest Service Interface` is disabled. The v7 image correctly requires `hv-fcopy-daemon.service` to be enabled and active. Canonical's unit is conditional on the Hyper-V file-copy device, so the guest cannot prove the daemon while the construction provider withholds that device.

No separate protected child or UAC broker process was observed during construction. This is process evidence only; it does not claim what the operator could see.

## Smallest LEGO correction

Keep host integration-service mechanics inside the Hyper-V image-construction management channel. For a newly prepared construction VM, enable exactly the built-in `Guest Service Interface` only after the exact VM has passed shape/protection checks and carries the construction ownership marker, then re-read and require enabled state before installation begins.

At the qualification boundary, re-prove the exact VM name, ownership marker, provider identity, and running state; reconcile and re-prove the same single integration service. This makes the already preserved `qualifying` subject resumable without deleting or rebuilding it, while future subjects expose the file-copy device before installed first boot. The Ubuntu seed and qualifier remain the sole owners of guest service activation and proof.

Extend both construction capability preflights to prove `Get-VMIntegrationService` and `Enable-VMIntegrationService` are available. Add no generic service selector, provider identity, manual VM action, guest repair, alternate transport, retry, timeout, DACL, group, network, or image-authority change.

## Qualification and physical gate

Prove exact ownership ordering, one-service selection, post-enable verification, qualifying-subject reconciliation, and capability discovery. Require focused tests, exact preflight, hosted-equivalent gates, complete local suite, exact doctor, generated artifacts, and diff hygiene. Then require candidate and fresh integrated four-job matrices.

Only after those gates pass, install the exact accepted Stage 8 head and re-enter the same `subject-0e87a6f97256777648ab4ce230f94589` through supported public setup. Its v7 qualification must prove the guest daemon before admission. Resume the existing fenced environment and obtain the real GitHub-delivered Hello World compile/test proof before hardening the recorded tracked-runner latency, diagnostic ordering/labeling, false consent result, and receipt-aware cache retention seams.

## Local qualification

Exact Node.js 22.16.0 focused construction/preflight coverage passes 25/25. Repository preflight passes 3 standalone artifacts, 276 syntax files, 2 JSON files, and 218 selected test files. The hosted-equivalent architecture/product/standalone gate passes 37 total / 36 passed / one expected Windows symlink-capability skip. The complete serialized suite passes 2,242 total / 2,220 passed / 22 expected skips / zero failures or errors in 353.510 seconds. Exact doctor, generated standalone artifacts, and diff hygiene pass.

The first full-suite command was rejected by Node before test loading because PowerShell split the reporter-destination expression. Quoting that single CLI argument correctly started the unchanged suite and produced the clean result above; no product or physical state changed between invocations. Cleanup then unlinked three test-created junctions, removed the exact 22,856,456-byte external suite root and the 85,119,640-byte private exact-Node runtime, and verified both absent.
