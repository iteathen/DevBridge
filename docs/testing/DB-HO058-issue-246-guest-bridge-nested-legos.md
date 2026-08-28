# DB-HO058: nested guest bridge LEGO internals

Date: 2026-08-28

Issue: #246

Status: implementation planned; no setup, elevation, service, provider, image, VM, guest transport, or repository execution is authorized by this document.

## Assessment

The guest bridge is one correct external protocol endpoint, but `bridge-agent.mjs` still owns frame validation, location containment, durable operation state, exact-attempt coordination, process spawning/output/timeout/tree termination, cancellation polling, and chunked transfer state. Issue #367 extracted attempt/activity evidence into `activity-store.mjs`; the remaining process and transfer mechanics still form one large reasoning surface in the parent adapter.

The external bridge endpoint and feature contract should not split. The internal ownership problem is narrower:

- process lifecycle changes should not require reasoning through transfer staging;
- transfer changes should have no child-process, activity, or cancellation knowledge;
- exact-attempt fencing should remain independent from both;
- the parent should retain protocol dispatch, logical-location authority, and orchestration until another complete local owner is justified.

## Primary-source research

- Node.js documents that `fs/promises` operations are asynchronous and are not synchronized with one another, so each nested owner must keep its own exact mutation sequencing rather than assuming cross-call serialization: <https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#promises-api>.
- Node.js documents that `wx` maps to exclusive creation and fails when the path exists; this remains the attempt-fence primitive already isolated under #367: <https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#file-system-flags>.
- Node.js documents explicit `FileHandle.close()` as required rather than relying on automatic closure; transfer staging must continue closing every handle in `finally`: <https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#class-filehandle>.
- Node.js documents detached process-group/session behavior and `unref()` separately. The parent bridge may detach the activity process, while the nested local-process owner controls only the admitted child and its tree: <https://nodejs.org/download/release/v22.17.0/docs/api/child_process.html#optionsdetached>.
- Node.js ESM requires explicit extensions for relative imports, so every guest payload generation must include the exact new `.mjs` members beside the parent adapter: <https://nodejs.org/download/release/v22.16.0/docs/api/packages.html#modules-loaders>.

## Reassessment

Splitting every helper into a file would add topology without clarifying ownership. The smallest complete decomposition is two additional nested owners beside the existing activity store:

1. `local-process.mjs` owns one normalized local process, minimal inherited environment, bounded input/output, activity pulse, stop observation, timeout publication, in-memory child ownership, and tree termination. Its ports are only `pulse`, `readStop`, and `writeStop`; it knows no request, target, provider, repository, controller, transport, ledger, or transfer identity.
2. `transfer-channel.mjs` owns exact transfer records, staging bytes, replay, digest verification, chunk bounds, and final file movement. Its ports are only neutral read/write location resolvers; it knows no execution, activity, process, cancellation, provider, repository, controller, or transport identity.

The parent remains the sole bridge protocol/dispatch adapter and retains logical-location containment plus the operation journal. It composes opaque operation identity into the nested ports. This keeps external behavior stable while making the three most independently changeable effect domains—attempt/activity evidence, local process lifecycle, and byte transfer—separately testable and replaceable.

No compatibility wrapper or duplicate active implementation will remain in `bridge-agent.mjs`; code moves to its owner and is deleted from the parent.

## Scoped plan

1. Add the closed `local-process` contract and move process environment, output, timeout, cancellation polling, and tree termination into it.
2. Reduce parent operation execution to attempt/journal/location orchestration around that contract.
3. Add the closed `transfer-channel` contract and move PUT/GET validation, staging, replay, digest, and finalization into it.
4. Reduce parent PUT/GET handlers to injected logical-location composition.
5. Add both modules to Linux and Windows guest image payload membership and repository preflight.
6. Add direct normal/failure/boundary tests for each nested owner and retain all parent endpoint, concurrency, recovery, timeout, cancellation, containment, and payload tests.
7. Extend LEGO source-isolation gates so sibling identities cannot leak across the new modules.
8. Run focused tests, stress, preflight, the complete suite, exact diff checks, and hosted Windows/Ubuntu CI before closing #246.

## Acceptance boundary

This structural slice preserves the existing bridge protocol and security semantics. It does not claim a provider, transport, VM, guest image, setup, or physical C-canary result.

## Implementation checkpoint

The guest endpoint remains `devbridge/environment-bridge-v1` with its unchanged feature list. Its parent adapter now owns only frame dispatch, logical-location containment, durable operation orchestration, and composition of three closed local effect owners:

- `activity-store.mjs` owns permanent attempt fencing, exact activity evidence, and cancellation messages;
- `local-process.mjs` owns the admitted child, bounded environment/input/output, pulse and stop observation, timeout, and live in-memory tree termination;
- `transfer-channel.mjs` owns transfer records, chunk staging, exact replay, digest verification, and final movement.

The process contract contains no request, target, location, transfer, journal, provider, repository, controller, or transport identity. The transfer contract contains no process, activity, cancellation, execution, operation, provider, repository, controller, or transport identity. The parent supplies neutral functions and opaque values; changing external wiring therefore does not require either child to change.

The moved implementations were deleted from the parent. Both Linux and Windows image payloads now own the exact helper bytes, and repository preflight syntax-checks and directly tests both helpers. The transfer owner uses a neutral internal `devbridge/transfer-record-v1` schema. Pre-existing differently shaped internal records fail closed; there is deliberately no compatibility parser or duplicate legacy implementation. The public bridge protocol and response shapes did not change.

## Local evidence

- focused activity/process/transfer/parent/payload/LEGO suite: 43 passed, 0 failed;
- ten additional fast-child observation repetitions: 10 passed, 0 failed;
- repository preflight: 128 syntax files, 2 JSON files, and 126 targeted test files passed;
- complete repository suite: 1,678 total, 1,663 passed, 15 expected platform skips, 0 failed;
- `git diff --check`: passed.

Hosted Windows and Ubuntu qualification remains required on the exact published commit before #246 can close. A documentation-only predecessor run exposed the independently tracked daemon control-file race on Windows; exact evidence was added to #261 rather than weakening or mixing that ownership boundary into this change. No setup, UAC, protected service, provider, image, environment, VM, guest transport, or repository execution occurred.

## Hosted reassessment

Hosted run `33207765083` on initial implementation commit `4deffd328ab43b4c4e9d65d639247f3824870223` passed both Ubuntu jobs but failed the same new transfer test in Windows preflight and the serialized Windows suite. The transfer owner compared the canonicalized destination parent with the resolver's noncanonical boundary spelling. GitHub's Windows temporary directory exposed the known `RUNNER~1`/long-name alias; this was deterministic contract evidence, not a reason to weaken the test or rerun unchanged code.

The neutral resolved-location contract now canonicalizes its supplied boundary and the actual file or destination parent before their containment comparison. It first retains the lexical boundary check, so canonicalization cannot turn an already escaped path into an admitted path. This follows the Windows filesystem-identity research recorded in `docs/testing/DB-HO056-issues-369-370-hosted-cross-platform-contracts.md` without importing the runtime helper, platform identity, or caller topology into the self-contained guest module.

## Accepted evidence

Hosted CI run `33208194846` passed on exact correction commit `9e0f26b01f7bfe75a17a3cac0904c151fd34947a`:

- Windows serialized full suite and doctor: passed in 2 minutes 48 seconds;
- Windows preflight, identity audit, and standalone installer regression: passed in 1 minute 33 seconds;
- Ubuntu full suite and doctor: passed in 49 seconds;
- Ubuntu preflight, identity audit, and standalone installer regression: passed in 18 seconds.

This accepts #246. It does not accept a VM provider, environment, guest transport, or physical repository-execution result. No UAC or protected operation occurred.
