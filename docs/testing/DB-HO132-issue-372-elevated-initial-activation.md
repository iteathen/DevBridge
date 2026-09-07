# DB-HO132 — issue #372 bounded elevated initial activation

Date: 2026-09-02

Status: local implementation in qualification; operational proof pending hosted acceptance and physical activation

Coordinates with: #177, #360, #372, #430, DB-003, DB-008, DB-009, DB-017, DB-019, and DB-020.

## Operational evidence and exact blocker

Exact accepted Stage 8 head `4ea998e5083ed800f29fc35f26a93141020f6e92` is installed through the content-addressed runner entry. The canonical home is `C:\Users\josho\.devbridge`; no OneDrive or D-drive installation is in scope. Its accepted Ubuntu image `img-ade74ff1fdd1c7f3e79edf99da74ea25` / `ubuntu-2604-production-v6` verifies locally, while the selected `linux-development` environment remains absent and recommends `create`.

One supported setup re-entry requested its identified elevation at setup elapsed zero and returned exact protected-child completion. This is process evidence only; the user did not confirm seeing the Windows consent screen, so this record makes no visual-UAC claim. The protected apply frontier reached `applied`, the LocalSystem lifecycle service is running, all five named endpoints exist, and repeated ordinary read-only lifecycle inventories completed successfully. The following initial activation still failed with `environment lifecycle authority is unavailable`.

The failure is an authority-composition contradiction, not an availability or timeout condition. The protected host deliberately grants the ordinary operator read, acceptance, activity, and configuration capabilities, but grants persistent lifecycle mutation only to an elevated Administrators token. The current user's non-elevated Administrators SID is deny-only. Direct `list` and `plan(create)` therefore succeed, while the mutation connection used by setup cannot open. Existing security tests and `docs/environment-lifecycle-authority.md` require that denial and prohibit widening the persistent mutation endpoint.

## Smallest secure LEGO

Keep the lifecycle mutation endpoint administrator-only. Extend the existing short-lived, content-addressed, purpose-identified setup elevation child with one application orchestration LEGO that:

1. accepts only the canonical setup state directory and Windows platform from its parent;
2. reconciles the already accepted environment-profile record through the existing fixed protected configuration capability;
3. reads that accepted record itself and derives the bounded profile sequence from its declarations;
4. creates one existing protected lifecycle client under the elevated child token;
5. invokes the existing initial-activation policy for each profile; and
6. returns only bounded ready/changed/count evidence.

The existing activation policy permits exactly a healthy no-op, an absent environment's `create`, or a resumable interrupted `create`. It rejects repair, rebuild, replace, deletion, foreign transitions, ambiguous inventory, identity substitution, and incomplete final health. The child continues to accept no caller-selected profile, operation, environment identity, provider, path, configuration, construction flag, or generic privileged command.

The composition order is strict: protected service readiness first, accepted configuration reconciliation second, accepted-profile activation third, and ordinary post-child verification afterward. A readiness or configuration failure never reaches activation. Any absent configuration, malformed protected response, non-ready activation, or exception fails the one child closed and leaves the durable setup frontier retryable.

## Exclusions and follow-up boundary

This correction changes no pipe DACL, local group, service identity, provider implementation, network, image, VM, construction authority, PATH, timeout, retry schedule, or UAC presentation machinery. It does not make ordinary `devbridge environment create` privileged. The operational-proof path is first: accept this exact source change, install it, use one identified setup elevation to create the already accepted environment, and prove a GitHub-delivered Hello World compile/test result. General bounded elevation UX for later explicit lifecycle mutations is subsequent hardening informed by that proof.

## Verification

Focused tests prove accepted-input derivation, accepted-configuration-before-activation ordering, one-client reuse, ordered multi-profile activation, first-failure closure, empty-configuration closure, Windows-only composition, no activation before protected readiness, and continued rejection of construction capability arguments. The final focused set passes 60 total / 59 passed / one expected Windows symlink skip. Exact Node.js 22.16.0 preflight passes 3 standalone artifacts / 276 syntax files / 2 JSON files / 218 selected test files; architecture/product/standalone passes 7/7; and the complete serialized suite passes 2,234 total / 2,212 passed / 22 expected platform skips / zero failed or cancelled in 355.944 seconds. Exact doctor is green while truthfully reporting the accepted declaration/image, absent materialization, and unavailable repository-execution route. Generated artifacts and diff hygiene pass.

Qualification confined all complete-suite residue to one named root. Cleanup measured 11,398 entries / 7,287 files / 23,673,300 bytes, unlinked four test-created junctions without following them, removed the root, removed the independently measured 85,119,640-byte exact-Node runtime, and verified both roots absent. No setup, UAC, service, ACL, group, provider, network, image, VM, PATH, OneDrive, D-drive, or physical construction effect occurred during implementation qualification.

Remaining gates are all four hosted PR jobs, exact integration, fresh all-four Stage 8 CI, and the physical GitHub Hello World proof.

The first hosted candidate run `33662411455` failed both Ubuntu jobs while the new elevated-child test compared the derived state directory to a literal Windows-rendered path. That mocked child also runs on Ubuntu, where the production composition deliberately uses the active host path library. Replace only the assertion's expected value with the same resolved/joined contract; product code, authority, timeout, and physical state remain unchanged. Require a fresh complete matrix.

PR #456 candidate `f3a41e91dc8b9d76caa135e85bd332618ebb242e` then passed all four jobs on run `33662876797`. It rebase-merged as exact Stage 8 head `005f68812f2b643c1c1b2f82da94ce523e336cd5`; both trees equal `2f3e458175c1a4c77a5e029db62084638b7d83a7`. Fresh Stage 8 run `33663335885` passed all four jobs.

Physical reassessment: the exact accepted head installed, prepared its durable frontier without elevation, and requested the identified elevation at setup elapsed zero on explicit re-entry. Process evidence proves that `DevBridge-Protected-Setup-Lifecycle-Environment` launched and its child passed the launcher's administrator-token check; this still makes no claim about what was visibly shown. The service refreshed successfully, but at 359 seconds the child failed closed with `environment lifecycle authority is unavailable`. A concurrent read-only lifecycle observation remained healthy and showed the accepted declaration still absent, no active transition, and no provider materialization. No VM creation began.

The failed implementation correctly kept the ordinary token away from mutation, but incorrectly assumed the elevated child should traverse the persistent service mutation pipe. The specification's smaller bounded elevated-client path is direct: after independently re-proving its elevated Windows token, derive the exact protected authority directory from the existing lifecycle plan and compose the existing local environment operator inside the short-lived elevated child. Continue to obtain declarations only from the accepted configuration record and continue to delegate decisions only to the existing initial-activation policy. The service mutation pipe and all DACLs remain unchanged; ordinary processes gain no connection or mutation capability. Provider implementations, commands, paths, identities, and operations remain unselectable by the caller.

Corrected local qualification passes 65/65 focused activation/readiness tests. Exact Node.js 22.16.0 preflight passes 3 standalone artifacts / 276 syntax files / 2 JSON files / 218 selected test files; the hosted-equivalent architecture/product/standalone gate passes 37 total / 36 passed / one expected Windows symlink-capability skip; and the complete exact serialized suite passes 2,235 total / 2,213 passed / 22 expected skips / zero failed or cancelled in 383.704 seconds. Exact doctor and standalone-artifact/diff hygiene are green. Doctor continues to report the exact verified local image and accepted declaration as absent/recommended-create, with repository execution unavailable until the physical route exists. Cleanup measured the isolated suite at 5,729 entries / 3,678 files / 11,966,267 bytes, unlinked its two test-created junctions without following them, removed that root and the separately measured 85,119,640-byte exact-Node runtime, and verified both absent. Require all four candidate jobs, exact merge/tree equivalence, and all four fresh Stage 8 jobs before the next physical setup attempt.
