# DB-HO139 — issue #372 Ubuntu fcopy UIO and post-transition readiness

Date: 2026-09-02

Status: locally qualified candidate; hosted acceptance and physical proof pending

Coordinates with: #372, DB-HO136, DB-HO137, DB-HO138, and the accepted Stage 8 protected lifecycle authority.

## Physical evidence

DB-HO138 merged as exact Stage 8 head `f29015f514d8cea6d7cf0420f38d1693458dbac7`. Candidate run `33693010107` and fresh integrated run `33693372969` each passed all four Ubuntu/Windows smoke and full jobs. Supported construction resumed v7 subject `subject-0e87a6f97256777648ab4ce230f94589`, persisted and completed its one recovery-safe graceful host cycle, and restarted exact owned VM `db-image-build-eefdbf45a26f3197` with Guest Service Interface enabled.

The cycle exposed two separate defects. First, the progress coordinator measured the endpoint failure against its pre-resolution lifecycle observation (3,815 seconds uptime) even though endpoint resolution had just completed an explicit restart and the same VM's new uptime was about 36 seconds. The resulting readiness-expired classification was stale evidence; no timeout was actually reset or extended.

Second, read-only guest evidence after the restart proves that the image itself still cannot satisfy its fcopy contract. Ubuntu 26.04 is running kernel `7.0.0-30-generic`. The fcopy VMBus class device `{34d14be3-dee4-41c8-9ae7-6b174977c192}` is present and unbound; `hv_utils` no longer advertises that class; `uio_hv_generic` is installed but unloaded; the expected UIO child is absent; and Ubuntu's `hv-fcopy-daemon.service` still requires removed legacy path `/dev/vmbus/hv_fcopy`. The service is enabled but inactive with `ConditionResult=no`, while the host truthfully reports Guest Service Interface `NoContact`.

Linux upstream removed the legacy fcopy kernel driver after adding the UIO daemon. Microsoft's Azure Linux packaging supplies the missing distribution adapter: load `uio_hv_generic`, bind the fixed fcopy class GUID through that driver's `new_id`, then start `hv_fcopy_uio_daemon`. This is image recipe behavior, not host/provider lifecycle repair.

No manual module load, driver bind, service edit/start, VM repair, retry, or timeout change was performed on the retained v7 subject.

## Reassessment and LEGO plan

1. Add one Ubuntu guest-capability registry whose public input is a closed versioned capability identifier. It owns fixed guest files and qualification probes; callers cannot provide paths, commands, GUIDs, unit content, or shell text.
2. Implement `hyperv-fcopy-uio-v1` as one systemd drop-in. It clears only the obsolete legacy path/device dependencies, loads the in-kernel generic UIO driver, binds the fixed fcopy class, requires the UIO device to exist, and then lets the package-owned daemon run unchanged.
3. Bind the capability identifier into construction authority, seed evidence, canonical request identity, and qualification evidence. Preserve exact historical subjects by omitting the new field when historical authority omitted it.
4. Qualify the exact drop-in digest, exact UIO driver binding/device, and enabled/active package service. Advance Ubuntu recipe/output generations to v12/v8 without changing source media, snapshot, or package pins.
5. In the neutral progress coordinator, re-observe lifecycle only after endpoint resolution fails. Measure readiness from that fresh evidence, and if the lifecycle is no longer running/medialess, return the existing output-not-ready frontier. A failed re-observation remains waiting without applying stale expiry.
6. Prove normal, failure, recovery, historical-subject, and ownership boundaries through focused tests, exact preflight, hosted-equivalent gates, the complete suite, doctor, generated-artifact, and diff hygiene. Remove only attributable temporary roots.
7. Require all four candidate jobs, exact merge/tree equivalence, and a fresh four-job Stage 8 run. Then install the exact accepted head, construct one new immutable v8 image through supported public setup, resume the fenced environment, and obtain the GitHub-delivered Hello World compile/test proof.

This slice adds no host authority, provider operation, alternate bridge, guest secret, network policy, retry loop, timeout value, manual repair, or direct-host execution path. The capability adapter is a replaceable image LEGO; its registry and seed/qualification studs remain provider-neutral. Intermediate setup/liveness/diagnostic/cache hardening remains after operational proof.

## Qualification

Focused capability, authority, seed, qualification, canary, and progress-coordinator coverage passes 58/58. Exact Node.js 22.16.0 repository preflight passes 3 standalone artifacts / 277 syntax files / 2 JSON files / 219 selected test files. The hosted-equivalent repository-execution architecture gate passes 34 total / 33 passed / one expected Windows symlink-capability skip. The final complete serialized suite passes 2,250 total / 2,228 passed / 22 expected skips / zero failed or cancelled in 397.520 seconds. Exact doctor and diff hygiene pass; doctor truthfully reports the retained v7 environment recovery frontier and unavailable repository execution rather than claiming v8 operational readiness.

The first preflight exposed one stale test fixture that still published the formerly current v7 generation; changing only that current-generation fixture to v8 made its 3/3 focused tests pass. Review then added the new capability module and its direct contract test to the preflight's closed inventories, advancing the final counts from 276/218 to 277/219. Two independently verified 85,119,640-byte private Node runtime roots were removed after their gates, and both exact paths are absent. No setup, UAC, protected-host, service/ACL/PATH, provider, VM/image, manual guest repair, timeout, or retry action occurred.

Publish this exact candidate and require all four hosted jobs. After exact Stage 8 integration and a fresh four-job integrated run, install only that exact head and authorize one public v8 construction attempt. Formal v8 acceptance remains conditional on physical image qualification and the GitHub-delivered Hello World compile/test proof.
