# DB-HO136 — issue #372 Ubuntu Hyper-V file-copy contract

Date: 2026-09-02

Status: implementation complete; local qualification passed; hosted acceptance pending

Coordinates with: #372, DB-HO134, DB-HO135, issue #197 image construction, and the accepted Stage 8 protected lifecycle authority.

## Physical evidence

DB-HO135 merged as exact Stage 8 head `b81f6a7a34e4a3e866e693418b570ff927084bdc`, with candidate and integrated tree `00a11b9cc0b45143f7ed42fb0173be9652f7eecf`. Candidate run `33681075146` and fresh Stage 8 run `33681615385` each passed all four Ubuntu/Windows smoke and full jobs. Supported preparation bound that exact runner. Explicit re-entry requested consent at setup elapsed zero and named the protected action and reason before launch. Process evidence proves the identified launcher and administrator-checked child ran; visible UAC evidence remains operator-owned and is not inferred.

The corrected default `Stop-VM -Name` path gracefully stopped the exact owned VM and the parent lifecycle restarted the same VM, proving the full DB-HO134 cycle. The enabled host Guest Service Interface nevertheless remained `NoContact` through the unchanged bounded readiness window, and `Copy-VMFile` again failed with `0x800710DF`. The create effect remains fenced and resumable. No manual VM, disk, image, service, ACL, group, network, or timeout change followed.

## Exact image-contract defect

The accepted `ubuntu-2604-production-v6` authority pins `linux-cloud-tools-virtual` `7.0.0-30.30`, but its qualification requires only `hv_kvp_daemon` and `make`. The seed relies on package installation side effects and never explicitly activates or proves the Hyper-V file-copy participant.

Canonical's exact `linux-cloud-tools-common` package supplies `/usr/sbin/hv_fcopy_uio_daemon`, `hv-fcopy-daemon.service`, and a udev activation rule. Its systemd unit is conditional on Microsoft virtualization and `/dev/vmbus/hv_fcopy`, binds to that device, and starts the UIO daemon. Its package scripts attempt to enable and start the service. Package presence alone therefore does not prove that the device condition held, the unit remained enabled, or the daemon was active when the image was admitted.

## Smallest LEGO correction

Extend the existing Ubuntu construction authority's qualification brick with a bounded, validated service-unit list. The Ubuntu seed consumes only that list and explicitly runs `systemctl enable --now` for each required unit during installed first boot. The Ubuntu qualifier consumes the same list and requires every unit to be both enabled and active before finalization. The current production authority adds `hv-fcopy-daemon.service` and the current `hv_fcopy_uio_daemon` executable while retaining `hv_kvp_daemon` and `make`.

Keep service mechanics inside the Ubuntu image seed/qualification adapters. The canonical image canary continues to carry opaque expected evidence, and Hyper-V environment/provider adapters remain unchanged. Preserve historical authorities by treating an absent service list as empty, while every new authority content-addresses the explicit list.

Advance the autoinstall recipe to `ubuntu-2604-autoinstall-v11` and the immutable output to `ubuntu-2604-production-v7`. Retain package generation `ubuntu-2604-tools-v4` because the exact package selection is unchanged. Never overwrite, relabel, or mutate the admitted v6 image.

## Qualification and physical gate

Prove authority ordering, subject binding, service-name rejection, seed activation projection, prepared-seed binding, enabled/active qualification, and retained command/package/file checks. Then require focused tests, exact preflight, the complete local suite, and both four-job hosted matrices before installing the exact accepted head.

Only then use the supported public setup construction path to build and admit one fresh v7 subject. Its internal qualification must prove file-copy service readiness before publication. Re-enter the existing fenced profile creation through supported setup and obtain the real GitHub-delivered Hello World compile/test result. Do not use manual guest repair, alternate seed transport, image mounting/editing, provider/network changes, extra retries, or timeout changes.

## Local qualification

The final focused contract suite passes 48/48 tests. Exact Node.js 22.16.0 preflight passes 3 standalone artifacts, 276 syntax files, 2 JSON files, and 218 selected test files. The hosted-equivalent architecture/product/standalone gate passes 37 total / 36 passed / one expected Windows symlink-capability skip. The clean complete serialized suite passes 2,242 total / 2,220 passed / 22 expected skips / zero failures or errors in 358.806 seconds. Exact doctor, generated standalone artifacts, and diff hygiene pass.

The first complete-suite invocation placed its bounded scratch root inside the repository, where live fixtures correctly violated product-identity scanning. That was a qualification-harness placement error, not a product failure. The exact root was removed, verified absent, and the unchanged product was rerun with an external bounded scratch root to the clean result above. Cleanup then unlinked two test-created junctions, removed the exact 12,274,445-byte external suite root and the 85,119,640-byte private exact-Node runtime, and verified both absent. Historical compatibility was also checked directly: all four stored authorities still resolve to their exact original subjects because an absent historical service list is not synthesized into content-addressed material.
