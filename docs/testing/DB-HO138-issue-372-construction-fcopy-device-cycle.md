# DB-HO138 — issue #372 construction file-copy device cycle

Date: 2026-09-02

Status: implementation complete; local qualification passed; hosted acceptance pending

Coordinates with: #372, #462, DB-HO136, DB-HO137, and the accepted Stage 8 protected lifecycle authority.

## Physical evidence

DB-HO137 merged as exact Stage 8 head `75c35bae3c83c5d4dca98d30bfceef62b7c7bd41`, with candidate and integrated tree `bb63b5697b1b21c3539e26006ec59e79967053c8`. Candidate run `33690322193` and fresh Stage 8 run `33690674906` each passed all four Ubuntu/Windows smoke and full jobs. Supported setup installed that exact head and resumed preserved v7 subject `subject-0e87a6f97256777648ab4ce230f94589`.

The provider correction enabled the exact construction VM's built-in Guest Service Interface, but qualification again failed closed. Read-only host and guest evidence is unambiguous: provider `a6208220-ca71-47e7-9f7b-5081e53d899f` remains the exact owned running VM; Guest Service Interface is enabled but reports `No Contact`; `/usr/sbin/hv_fcopy_uio_daemon` exists; `hv-fcopy-daemon.service` is enabled but inactive with `ConditionResult=no`; and `/dev/vmbus/hv_fcopy` is absent. Enabling the host integration service after this already-running installed guest did not enumerate its VMBus device.

No manual VM cycle, guest service start, image repair, alternate transport, retry, or timeout change followed. The v7 subject remains active at `qualifying`.

## Smallest LEGO correction

Extend the existing qualification-host preparation transition rather than adding a new lifecycle surface. Before the provider effect, persist one content-bounded intent containing the exact pre-cycle VM uptime. The Hyper-V construction channel re-proves exact VM name, ownership marker, provider identity, integration-service identity, and enabled state. If Guest Service Interface lacks contact, perform one default graceful `Stop-VM` followed by `Start-VM` on that exact owned construction VM.

The persisted pre-cycle uptime is the recovery stud. If transport is lost after the restart effect, a lower observed uptime proves the same requested cycle already occurred and prevents a second cycle. If transport is lost while the VM is off, the same planned intent authorizes only restarting that exact VM. After a successful cycle, persist completion before returning one explicit guest-restart frontier; the next supported setup invocation re-observes guest address/access and proceeds to the unchanged Ubuntu qualification.

Future construction VMs receive Guest Service Interface before installation under DB-HO137 and should normally have contact at installed boot, so this cycle is conditional rather than routine. Reuse the construction provider's existing 120-second graceful-stop management-operation bound; add no new deadline or retry policy. Add no generic service/VM authority, force stop, manual action, guest mutation, alternate transport, identity, network, or image-authority change.

## Qualification and physical gate

Prove the no-cycle healthy path, one durable restart frontier, default graceful stop, exact start, transport-loss recovery without a second cycle, and invalid durable state rejection. Require focused tests, exact preflight, hosted-equivalent gates, complete local suite, exact doctor, generated artifacts, and diff hygiene; then both four-job hosted matrices.

Only after acceptance, install the exact Stage 8 head and re-enter the same preserved v7 subject through public setup. Require v7 guest service qualification and immutable image admission, then resume the existing fenced environment and obtain real GitHub-delivered Hello World compile/test proof before the separately recorded intermediate hardening.

## Local qualification

Exact Node.js 22.16.0 focused construction/preflight coverage passes 28/28. Repository preflight passes 3 standalone artifacts, 276 syntax files, 2 JSON files, and 218 selected test files. The hosted-equivalent architecture/product/standalone gate passes 37 total / 36 passed / one expected Windows symlink-capability skip. The complete serialized suite passes 2,245 total / 2,223 passed / 22 expected skips / zero failures or errors in 397.420 seconds. Exact doctor, generated standalone artifacts, and diff hygiene pass.

Cleanup unlinked three test-created junctions, removed the exact 22,865,173-byte external suite root and the 85,119,640-byte private exact-Node runtime, and verified both absent. After aligning the new cycle with the provider's existing 120-second graceful-stop management bound, final exact focused 28/28 and full repository preflight passed again. That rerun unlinked one test-created junction, removed its exact 5,464,246-byte external root and the recreated 85,119,640-byte private runtime, and verified both absent.
