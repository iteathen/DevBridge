# DB-HO056 — hosted cross-platform setup and doctor contracts

Status: assessment, primary-source research, reassessment, and dependency-ordered plan for issues #369 and #370 from exact predecessor `d56bf576d719294aa9037f1bd6529a4800ec8d2f` on `stage8/362-protected-activity-channel`.

## Assessment

Draft PR #368 caused the exact branch to run on hosted Ubuntu and Windows. The intended serialized Windows test policy ran, but deterministic platform defects prevented it from qualifying:

- six operational-configuration tests rejected a real temporary directory because the runner supplied the existing directory through its `RUNNER~1` short-name alias while Node canonicalized it to the long `runneradmin` name;
- two Windows install-media tests expected the lexical input path even though the source owner deliberately returns the canonical path from `realpath()`;
- the complete Ubuntu suite passed, but the subsequent CLI doctor smoke aborted because no protected lifecycle-authority service exists on the hosted runner.

The path failures are not the load-sensitive child-process failures owned by #290. The doctor failure is not repository-execution readiness and does not authorize a fallback. It is a read-only diagnostic representation defect.

No fix in this slice requires or permits UAC, protected-service installation, provider mutation, VM lifecycle activity, guest execution, or host repository execution.

## Research

- Microsoft documents that Windows can store a long filename and an 8.3 short-name alias for the same filesystem entry, and exposes `GetLongPathName` specifically to convert the short form to the long form: <https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getlongpathnamea> and <https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file>.
- Node documents `fs.realpath()` as canonical path resolution and explicitly notes that canonical pathnames are not necessarily unique. It exposes filesystem-specific `stats.dev` and `stats.ino` identities and `lstat().isSymbolicLink()` for link detection: <https://nodejs.org/api/fs.html>.
- Node's documented identity fields are filesystem-specific. Exact hosted Windows Server 2025 evidence then showed the important path/handle split: the path observation can report an unavailable device identifier while the open-handle observation reports the volume identifier, although both report the same file identifier. Microsoft's native contract likewise defines identity as the volume plus file identifier and notes that support is filesystem-specific: <https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information>.
- DB-003 requires path/link substitution to fail closed and forbids an unavailable execution provider from becoming host execution.
- DB-020 requires doctor to remain read-only and to report provider/environment readiness separately; it never permits a local-provider fallback.
- DB-009 requires observed state rather than a declaration. An unreachable authority is observed as unavailable, not silently ready.
- Issue #176 requires doctor to diagnose lifecycle state without mutation, while issue #360 requires ordinary composition to use only the protected client.

## Reassessment

### Filesystem identity

Lexical equality after `path.resolve()` is insufficient on Windows because a valid short alias and long path can name the same object. Simply accepting all Windows canonicalization differences would be too broad because links and substituted ancestors must still fail closed.

The setup owner should keep the input spelling as its managed target, reject a symbolic-link final entry, and compare the input and canonical observations by filesystem identity only for the Windows alias case. The existing held-file identity and before/after checks remain authoritative during reads. Non-Windows lexical canonical-path equality remains unchanged. The media source already returns its canonical path correctly; only its tests should assert that explicit contract.

The first hosted correction proved the alias comparison itself, then exposed a second independent Windows representation mismatch in the held-file check: `lstat(path).dev` can be unavailable while `FileHandle.stat().dev` is populated. Comparing those device fields unconditionally rejects an unchanged file. The revised neutral observation contract requires one exact, nonzero file identifier; requires equal device identifiers whenever both observations provide them; permits a missing device identifier only on Windows; rejects different Windows roots before alias comparison; uses bigint observations to avoid 64-bit identifier precision loss; and binds both the before and after path observations to the held handle. This preserves substitution detection without pretending an unavailable field is evidence of a change.

### Doctor observation

The lifecycle client already owns transport failure classification, but its public request method currently replaces the typed transport failure with an untyped error. Preserve the neutral `LIFECYCLE_AUTHORITY_UNAVAILABLE` code across that boundary. Doctor may then convert only that exact read-side absence into a bounded unavailable diagnostic object. Other operator errors and malformed results remain errors.

This does not add a provider fallback, local operator construction, mutation, readiness claim, or new topology. It makes absence visible through the existing read-only capability field.

## Dependency-ordered plan

1. Preserve the lifecycle client's typed unavailable classification without exposing endpoints or paths.
2. Add a doctor-local unavailable projection and catch only the exact transport-unavailable class around `inspect()`.
3. Test successful read-only inspection, bounded absence, and propagation of other failures.
4. Correct setup's Windows same-object check while retaining link/substitution and held-file checks; leave non-Windows behavior unchanged.
5. Canonicalize only the expected media paths in Windows tests because the source owner already canonicalizes its output.
6. Add a deterministic Windows-alias regression that does not depend on the local machine exposing an 8.3 alias, plus retain real hosted-Windows qualification as the final platform proof.
7. Run focused tests, preflight, the default and serialized complete suites, and `doctor` with the example config.
8. Push the exact candidate, let PR #368 rerun on both hosts, reconcile #290/#369/#370 from hosted evidence, and close only fully accepted issues.

## Safety and LEGO boundary

- The operational-configuration component consumes only local paths and filesystem observations; it gains no provider/media/repository topology.
- The lifecycle client continues to expose only its neutral protocol/error contract.
- Doctor consumes one read-only `inspect` stud and projects an unavailable capability without knowing socket, service, platform, or provider identities.
- The install-media source remains the sole owner of canonical media location; tests no longer substitute a lexical assumption for that contract.
- No direct-host execution, coding-model fallback, credential flow, or protected mutation is introduced.

## Implementation checkpoint

The implementation now contains two isolated corrections:

- `local-filesystem-identity` owns one neutral comparison contract. Non-Windows spelling rules remain exact. A Windows spelling difference is accepted only when every observed component is non-symbolic and both final observations have the same nonzero filesystem identity. The operational-configuration owner consumes this stud without acquiring Windows media, provider, guest, or setup-topology knowledge.
- The same owner now compares path and held-handle observations through the neutral identity contract. Both before/open and after/open pairs must retain one exact nonzero file identifier. Device identity remains strict when observable; Windows alone may omit it on one side. All identity fields are read as bigint, and alias equivalence cannot cross a volume root.
- The lifecycle client preserves only the fixed `LIFECYCLE_AUTHORITY_UNAVAILABLE` classification when its exchange cannot produce a response; it still removes raw transport detail. Doctor maps only that class to a fixed unavailable diagnostic. Other authority failures and malformed observations still propagate, and the CLI continues to compose only the protected client.
- Windows media tests now compare the canonical path already owned and returned by the source boundary rather than the caller's lexical spelling.

Local verification on the exact working tree:

- focused owner/boundary suite in ordinary and serialized modes: 34 total, 33 passed, zero failed, one expected Windows symlink-permission skip;
- candidate preflight: 125 syntax files, two JSON files, and 123 targeted test files passed;
- complete default suite: 1,657 total, 1,642 passed, zero failed, 15 expected platform skips;
- prior complete serialized suite after the functional fix: the same 1,657/1,642/15/0 result in 214.6 seconds; the final symmetric link hardening was then requalified through the exact serialized focused set and preflight under DB-019 selective invalidation;
- installed CLI `doctor` against the example configuration exits successfully and reports repository execution unavailable/fail-closed; the local protected read endpoint was present, so PR #368 hosted Ubuntu remains the required absent-authority CLI proof;
- `git diff --check` passes.

Selective requalification after the hosted Windows device-observation finding:

- focused filesystem/setup suite, serialized: 12 total, 11 passed, zero failed, one expected Windows symlink-permission skip;
- candidate preflight: 125 syntax files, two JSON files, and 123 targeted test files passed;
- complete default suite: 1,659 total, 1,644 passed, zero failed, 15 expected platform skips.

No UAC prompt, protected-service write, provider/image/environment/VM operation, guest command, or repository-code host execution occurred. Hosted run `33203516517` on exact commit `7216ee4a04d201002c97be9c88d38f9d70df4edb` passed Ubuntu smoke, the complete Ubuntu suite, and the no-authority doctor smoke. Its Windows preflight deterministically exposed the path/handle device-field mismatch above; hosted Windows acceptance remains pending after the revised exact commit is pushed.
