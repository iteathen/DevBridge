# DB-HO043 — issue #197 canonical guest-payload text

Status: implemented and locally software-qualified from exact predecessor `5eacee7d31891bfbfb4abc37b953124b1f988c34` on `stage8/362-protected-activity-channel`; protected-runtime refresh and physical re-entry are deferred until host elevation is again available.

## Assessment

The approved protected setup transaction completed the saved Hyper-V conflict retirement and constructed, qualified, finalized, and retained exact Linux subject `subject-f7fc5e9be52e957f1b08dff05431a0b3`. Publication then failed closed with `image generation is immutable and already contains different bytes`.

The refusal is correct. The accepted library already owns `linux-development` / `ubuntu-2604-production-v5` as image `img-dd12f7d5088dc62281a89a887be9dc1b`. The new retained VHDX is different and must not replace that artifact.

The new construction should not have existed. Its authority differs from accepted subject `subject-8a7a9afe109534b2c128f272ab586bcf` only in the derived six-file guest payload:

- accepted bootstrap checkout: `guest-image-688e4295403761cf5ae78fd1`;
- current Windows developer checkout: `guest-image-ef7da1cd4dcf5ac96846999c`.

All six tracked Git blobs are LF text and their program content is unchanged between the two exact heads. The accepted bootstrap cache materializes LF. The current Windows worktree materializes CRLF because system Git has `core.autocrlf=true` and the repository has no path-specific attribute. Every observed byte-count delta exactly equals the number of line endings in that file. Replacing CRLF with LF reproduces the accepted payload generation exactly.

The payload owner currently hashes and transfers worktree text bytes directly. It therefore leaks source-delivery topology into an immutable guest artifact identity.

## Primary-source research

Git's official [`gitattributes` documentation](https://git-scm.com/docs/gitattributes) states that text is normalized to LF in the index while checkout may materialize LF or CRLF depending on attributes, configuration, and platform. In particular, unspecified `eol` uses `core.autocrlf`/`core.eol`, and `core.autocrlf=true` permits CRLF worktree text from LF index content.

This matches the physical evidence: `git ls-files --eol` reports `i/lf w/crlf` for all six current payload members and `i/lf w/lf` for the accepted bootstrap checkout.

## Reassessment

An output-generation bump would preserve an accidental host representation as a new guest release and repeat the problem on the next differently configured source delivery. Replacing or retiring the accepted image would violate immutable-generation authority. Depending only on a Git attribute would not protect non-Git source acquisition or already materialized content.

The owning payload boundary must define one canonical text representation. It should:

1. read and race-check the exact regular file as it does now;
2. admit UTF-8 text with either LF or CRLF line endings;
3. canonicalize every CRLF to LF before content hashing, byte counting, generation derivation, and transfer;
4. reject any remaining bare carriage return rather than silently changing an ambiguous text representation; and
5. leave membership, paths, size ceilings, and generation formula otherwise unchanged.

This is a self-contained source-artifact contract. It contains no Git, platform, provider, image-library, repository, VM, or setup identity. Git and bootstrap checkouts remain transient source topology.

## Dependency-ordered plan

1. Add one local canonical-text helper in the payload owner.
2. Apply it only after the existing exact-file read/race check and before payload measurement.
3. Prove LF and CRLF copies produce identical content, hashes, byte counts, and generation.
4. Prove bare carriage returns fail closed.
5. Prove the current Windows checkout derives the already accepted `guest-image-688e4295403761cf5ae78fd1` identity.
6. Run focused payload/authority/seed/canary tests, repository preflight, and the complete suite.
7. Refresh the protected runtime only if the fixed exact candidate is not already active; then re-enter ordinary setup. The existing accepted image must be reused and the retained failed subject must remain untouched unless a later exact-owned cleanup surface retires it.
8. Continue profile configuration and the fixed C route acceptance only after exact image reuse is observed.

No manual catalog edit, output-generation bump, image overwrite, retained-disk deletion, or additional UAC transaction is part of this plan.

## Implementation checkpoint

The guest-payload owner now verifies the exact source-file read against the observed regular-file size, canonicalizes CRLF to LF, rejects any remaining carriage return, and derives content bytes, SHA-256 values, generation, and transferred content only from that canonical representation. Its public membership and result contract did not change. No Git, checkout, operating-system, provider, image, setup, or repository identity entered the module.

The new boundary tests create independent LF and CRLF source directories and require their complete normalized payload values to be equal. They also require canonical content to contain no carriage returns and prove a bare-carriage-return member fails closed. The existing member-change and incomplete-membership refusal tests remain intact.

Exact hosted evidence on 2026-08-28:

- the current Windows `i/lf w/crlf` checkout now derives `guest-image-688e4295403761cf5ae78fd1`, exactly matching the already accepted bootstrap payload;
- focused payload, setup-authority, construction-authority, seed, qualification, physical-canary, and setup-composition tests: 52 passed, 0 failed;
- repository preflight: 101 syntax files, 2 JSON files, and 97 targeted test files passed;
- complete suite: 1,531 passed, 15 platform skips, 0 failed out of 1,546 tests;
- `git diff --check`: no whitespace errors, only the existing Windows conversion notices.

The protected transaction before this fix produced valuable failure evidence: installation, exact guest qualification, and destructive finalization all completed; the VM was removed after retention; immutable publication alone refused the colliding bytes. The accepted image and catalog are unchanged. The 10,372,513,792-byte retained failed VHDX remains bound to its exact subject and journal and is not manually removed.

The corrected ordinary candidate is newer than the currently protected runtime, so normal one-command re-entry must first refresh exact protected authority. The operator has explicitly stated that no UAC is available for the next three days. No elevation will be attempted during that interval. This pauses physical re-entry only; it does not weaken the boundary or authorize an older-runtime/bypass path.
