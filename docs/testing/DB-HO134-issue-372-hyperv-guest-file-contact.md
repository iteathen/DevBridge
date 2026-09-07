# DB-HO134 — issue #372 Hyper-V guest-file contact cycle

Date: 2026-09-02

Status: local qualification complete; hosted acceptance and physical resume remain pending

Coordinates with: #372, DB-HO133, and the accepted Stage 8 protected lifecycle authority.

## Physical evidence

DB-HO133 merged as exact Stage 8 head `123007801029caadc20879784f8b36ea3a41c37a`, with candidate and integrated tree `d96a88730c13917866a87122c0ed14ef3c94a702`. Candidate run `33672273849` and fresh Stage 8 run `33672704091` each passed all four Ubuntu/Windows smoke and full jobs. The canonical non-OneDrive installation acquired that head.

One attended supported setup resume created `db-env-7880b0a4fe93af07` at the new compact configuration path. The VM has exact provider identity `ae164962-1da5-4147-a9cb-974b86b5bea1`; the prior `0x800700CE` configuration-path failure did not recur. Two bounded seed-delivery attempts then failed through `Copy-VMFile` with `0x800710DF` (device not ready). Read-only Hyper-V evidence after both attempts shows the VM running and operating normally, Heartbeat and Key-Value Pair Exchange at `Ok`, but the enabled Guest Service Interface at `NoContact`. The same create operation remains `fenced-attempt`, active, and resumable. No manual VM, disk, network, guest, service, or authority change followed.

Microsoft documents that Guest Service Interface must be enabled on both host and guest for `Copy-VMFile`, and identifies the Linux participant as `hv_fcopy_daemon`. The Ubuntu Resolute `linux-cloud-tools-common` package supplies `hv-fcopy-daemon.service`, its udev rules, and the current `hv_fcopy_uio_daemon`. The accepted image already includes the selected cloud-tools package, but the runtime host/guest channel has not reached contact.

## Smallest LEGO correction

The generic bootstrap composition already owns a bounded provider-requested lifecycle cycle: it stops a running environment, reruns provider preparation while stopped, and starts the same environment before activation. Keep that policy unchanged. The Hyper-V attachment adapter will return `cycleRequired: true` only when the exact owned VM is running and the enabled Guest Service Interface reports a primary operational status other than `Ok`. While the VM is stopped, preparation returns false so the existing parent can complete exactly one cycle. The existing 90-second bounded copy readiness check remains unchanged after restart.

This is provider-local observation translated through an existing neutral stud. It adds no restart loop, timeout, retry schedule, service/ACL/UAC authority, alternate delivery transport, guest command, image mutation, VM identity, disk, network, PATH, OneDrive, or D-drive change. If contact remains absent after the owned cycle, `Copy-VMFile` still fails closed and the lifecycle remains resumable.

## Verification plan

Require direct false/true lifecycle-cycle projection tests, the generic parent cycle contract, focused Hyper-V bootstrap/environment lifecycle coverage, bounded preflight, hosted-equivalent architecture/product/standalone gates, the complete exact Node.js 22.16.0 serialized suite, doctor, artifact/diff hygiene, exact scratch cleanup, all four candidate jobs, exact integration/tree equivalence, and all four fresh Stage 8 jobs. Only then install the exact accepted head and perform one attended supported resume of the existing lifecycle. The required product outcome remains a real GitHub-delivered Hello World compile/test result; diagnostic labeling and CLIXML ordering remain downstream hardening.

## Local qualification

Focused bootstrap, lifecycle, construction, and LEGO-boundary coverage passes 25/25. Exact Node.js 22.16.0 bounded preflight passes 3 standalone artifacts / 276 syntax files / 2 JSON files / 218 selected test files; the hosted-equivalent architecture/product/standalone gate passes 37 total / 36 passed / one expected Windows symlink-capability skip. The complete serialized suite passes 2,238 total / 2,216 passed / 22 expected skips / zero failed or cancelled in 442.310 seconds. Exact doctor is green while truthfully reporting that repository execution remains unavailable before construction; standalone-artifact and diff hygiene pass. Cleanup unlinked three test-created reparse points, removed the 22,539,329-byte suite root and 85,119,640-byte private Node runtime, and verified both exact roots absent. No timeout, retry, setup authority, VM identity, image, disk, network, PATH, OneDrive, or D-drive behavior changed.
