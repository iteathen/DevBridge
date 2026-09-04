# DB-HO140 — issue #372 fcopy unit authority

Date: 2026-09-03

Status: locally qualified candidate; hosted acceptance and physical v9 proof pending

Coordinates with: #372, #197, DB-HO139, and the accepted Stage 8 protected lifecycle authority.

## Physical evidence

DB-HO139 candidate `e68bdb81bf89fd35a1befcf7a005a6245c034071` passed all four jobs in run `33697780530`; PR #464 rebase-merged as exact Stage 8 head `d138052b68ec3b8bd557e62401adadaa264a492f`, candidate and integrated trees equal `755c549454e536d5f73d391e05e9b31c634ef197`, and fresh run `33698130931` passed all four jobs.

Public exact-ref setup constructed v8 subject `subject-703bd658a613b57e2d1216f713759dda`. The installer progressed from 4 MiB through 10.5 GB, shut down, detached installation media, and booted the installed guest. The DB-HO139 post-transition logic correctly discarded stale uptime after the one-time Guest Service Interface cycle and opened a fresh readiness window. Qualification then reached the guest and exited nonzero.

Read-only host and guest evidence isolates the failure. The exact fcopy class is bound to `uio_hv_generic`, `/sys/bus/vmbus/devices/eb765408-105f-49b6-b4aa-c123b64d17d4/uio/uio0` exists, the capability file has its exact expected digest, and `hv_fcopy_uio_daemon` is installed. However, `systemctl show hv-fcopy-daemon.service` still reports the vendor `BindsTo=sys-devices-virtual-misc-vmbus\\x21hv_fcopy.device` even though the drop-in attempted `BindsTo=`. During the host integration-service cycle, systemd started and then explicitly stopped the daemon as that legacy device disappeared. The unit remained enabled but inactive, which is the exact failed qualification assertion.

No manual unit/service, module, driver, VM, image, provider, network, ACL, PATH, or timeout change was made. The failed v8 canary was preserved as the current `qualifying` subject and was running at the final direct physical observation; no later running-state claim is inferred without a fresh observation.

## LEGO correction

The `hyperv-fcopy-uio-v1` capability remains the sole owner of the correction. Replace its attempted subtractive drop-in with one complete `/etc/systemd/system/hv-fcopy-daemon.service` unit. The local unit masks the incompatible vendor unit as one atomic capability file, retains `ConditionVirtualization=microsoft`, orders after module loading, binds only the fixed fcopy class to `uio_hv_generic`, requires the UIO child, launches the package-owned `/usr/sbin/hv_fcopy_uio_daemon -n`, and remains enabled through the existing seed service list.

Qualification continues to require the exact capability-file digest, exact UIO driver/device, daemon command, and enabled/active service. Advance only the immutable Ubuntu recipe/output generations to v13/v9. Do not change source media, snapshot/package pins, host-service cycle, bridge, authority, identity, retry policy, deadline, or timeout.

Prove the capability, seed, authority, qualification, and current-generation projections with focused tests; then run exact preflight, architecture/product gates, complete serialized tests, doctor, generated-artifact checks, and diff hygiene. Require candidate and fresh integrated four-job matrices before one newly authorized public v9 construction attempt. Formal acceptance still requires physical qualification and a GitHub-delivered Hello World compile/test result. Once that route is operational, leave DevBridge running and stop before unrelated intermediate hardening.

## Local qualification

The focused capability, authority, seed, qualification, and current-generation tests pass 29/29. Under the exact supported Node.js 22.16.0 runtime, repository preflight passes 3 standalone artifacts / 277 syntax files / 2 JSON files / 219 selected tests; the repository-execution architecture gate passes 34 total / 33 passed / one expected Windows symlink-capability skip; the product-identity and standalone-launcher smoke passes 3/3; and the complete serialized suite passes 2,250 total / 2,228 passed / 22 expected skips / zero failed or cancelled in 366.030 seconds. Exact doctor reports healthy repository structure while truthfully retaining execution disabled for the example configuration. Diff hygiene passes.

The correction is confined to the capability-owned systemd unit plus immutable Ubuntu recipe/output identity projections. It adds no provider operation, fallback, timeout, retry, manual repair path, or host-specific detail outside the existing adapter. The umbrella operational goal continues after Linux v9 qualification through the existing #198/#199 Windows construction and activation boundaries; it is not folded into this Linux capability correction.

Cleanup removed the independently copied 85,119,640-byte Node.js qualification runtime at `C:\Users\josho\AppData\Local\Temp\db-ho140-node` after its final focused gate and verified the directory absent. The repository dependencies, retained v8 recovery evidence, installation, provider state, and user-owned files were not altered.
