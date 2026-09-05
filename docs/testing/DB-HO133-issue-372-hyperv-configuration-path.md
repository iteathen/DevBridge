# DB-HO133 — issue #372 compact Hyper-V configuration path

Date: 2026-09-02

Status: local implementation qualified; hosted acceptance and operational proof remain pending

Coordinates with: #177, #372, DB-HO132, and the accepted Stage 8 protected lifecycle authority.

## Physical evidence

Exact accepted Stage 8 head `af62d3fb98c1518423ccede7105e09dea233cee2` passed all four candidate jobs in run `33666745966` and all four fresh post-integration jobs in run `33667271014`. The canonical non-OneDrive installation acquired that exact head. After one attended UAC authorization, process evidence proved the identified launcher and its administrator-checked child ran. The protected LocalSystem service refreshed successfully.

The elevated child then created and validated the environment differencing disk before `New-VM` failed. Windows Hyper-V VMMS event 16352 identifies the exact boundary: changing the Smart Paging store for `db-env-7880b0a4fe93af07` to the provider's nested configuration location failed with `0x800700CE`, “The filename or extension is too long.” Events 19600, 15010, and 16000 record the corresponding realization and creation failure. Hyper-V inventory remained empty. The durable lifecycle operation is `create`, `fenced-attempt`, active and resumable; the accepted image remains verified locally. No manual cleanup or replay occurred.

The setup result also exposed two downstream diagnostic defects: PowerShell progress CLIXML consumed the bounded error prefix, and a post-consent child failure was labeled `elevation-consent: declined`. Those are intermediate-machinery hardening after operational proof; neither is widened into this provider correction.

## Smallest LEGO correction

Keep the durable ledger, writable differencing disk, image lineage, provider identity, and VM name in their existing owners. The Windows platform composition supplies the Hyper-V persistent provider one compact machine-configuration root derived beneath the already protected authority state: `<authority-state>\hv`. The provider derives the exact per-machine child from its existing deterministic VM name. Remote input cannot select either path.

New records use the compact path. An existing record may retain only the exact historical nested path or the exact compact path. During a resumable uncommitted create, the management channel separately receives the compact creation path. If no VM exists, `New-VM` uses it and returns explicit creation evidence before the ledger advances. If a VM already exists from an interrupted effect, the provider keeps the record's historical path and reconciles the exact existing object instead of relocating or recreating it. Removal continues to verify and clean the exact configuration directory owned by the record.

This changes no UAC behavior, service or ACL, lifecycle decision, VM identity, image, disk path or bytes, network, boot protection, resource values, timeout, retry schedule, repair/delete authority, PATH, OneDrive, or D-drive state.

## Verification plan

Require compact-root derivation, exact historical-record compatibility, absent-VM resume, explicit creation evidence, cleanup ownership, focused provider/foundation/migration coverage, preflight, architecture/product/standalone gates, exact Node.js 22.16.0 complete serialized suite, doctor, artifact/diff hygiene, exact cleanup, all four candidate jobs, exact merge/tree equivalence, and all four fresh Stage 8 jobs. Only then install the exact head and use the existing resumable setup frontier for one attended UAC retry. The next required outcome remains a real GitHub-delivered Hello World compile/test result.

## Local qualification

The focused provider/foundation selection passes 11/11. Exact Node.js 22.16.0 bounded preflight passes 3 standalone artifacts / 276 syntax files / 2 JSON files / 218 selected test files. The hosted-equivalent architecture/product/standalone selection passes 37 total / 36 passed / one expected Windows symlink-capability skip. The complete exact serialized suite passes 2,237 total / 2,215 passed / 22 expected platform skips / zero failed or cancelled in 449.413 seconds. Exact doctor is green while truthfully reporting the verified local image, the resumable `fenced-attempt`, and repository execution unavailable until setup resumes. Standalone-artifact and diff hygiene pass.

The first preflight invocation used the exact npm-cache Node binary directly and correctly failed two Ubuntu APT transaction-solver fixtures because that cache file is hard-linked. The production solver's single-link executable rule remains unchanged. A private byte-for-byte copy with the same SHA-256 (`C5FF4C736112DD483C750FD4149D30C8A116DB1A49B8B3EC88BE4B65E6C86C19`) removed only the harness topology mismatch; preflight then passed twice. No timeout or product/test rule changed.

Cleanup unlinked six test-created reparse points and removed the exact 38,167,084-byte suite root plus the 85,119,640-byte private Node runtime. Both exact roots are verified absent. No canonical installation, OneDrive, D-drive, protected authority, image, differencing disk, or lifecycle recovery evidence was removed.
