# DB-HO091 — No-elevation current candidate staging

Date: 2026-08-30

Status: assessed and planned; physical install-only transaction is gated on exact plan-head hosted acceptance

Coordinates with: #116, #360, #362, #372–#374, DB-003, DB-008, DB-009, DB-011, and DB-020.

GPU/CUDA work is outside this checkpoint.

## Scope and authority

This checkpoint may update only the manifest-owned user installation and its exact Permanent Entry runner selection. It must not invoke setup, request UAC, refresh the protected service, accept media, mutate a provider/image/environment/VM/guest, execute repository code, or invoke a coding-model adapter.

The continuing no-UAC constraint makes `--install-only` the maximum admissible installation effect. The purpose is to stage the exact already-qualified development head so a later single administrator-authorized protected refresh does not start from stale controller code.

## Assessment

The active worktree is clean on `stage8/362-protected-activity-channel` at exact remote-equal head `490f6d217161df3b1be371c1be2a57f2c04da64e`. Draft PR #368 still targets `cuda-target`. The exact head passed Ubuntu smoke/full and Windows bounded-smoke/serialized-full plus doctor in [GitHub Actions run 33306583185](https://github.com/iteathen/DevBridge/actions/runs/33306583185).

Wrapper-owned local observation reports:

- `devbridge-entry` resolves to the manifest-owned launcher below the canonical user installation;
- `devbridge` resolves to the manifest-owned stable launcher;
- component, selected runner, and pinned runner are all exact commit `8cf98654170a7265052481436ecd8e5607cf1c4b`; and
- installed doctor exits zero with `ok: true`, GitHub CLI authentication available, controller plans enabled, coding-model adapters disabled, repository execution unavailable, lifecycle `setup-reentry-required`, zero declarations, zero environments, and no host fallback.

The user-owned installation is healthy but stale. The current branch adds accepted protected setup/activity corrections and the exact construction-retirement/capacity result. Leaving Permanent Entry pinned to the old head would make the later protected refresh enter from code that predates those accepted changes.

## Contract research and reassessment

No new external platform mechanism is introduced, so the primary sources for this checkpoint are the repository's normative contracts and the installer implementation:

- DB-003 keeps executable and capability authority local and prevents installation from granting repository-code host execution;
- DB-008 requires immutable Git identity for accepted supply-chain subjects;
- DB-009 requires an intent-bound, observable, restart-reconcilable transition;
- DB-011 makes Permanent Entry the owner of runtime selection, activation, rollback, and recovery;
- DB-020 keeps installation distinct from provider and repository-execution readiness; and
- `docs/self-install.md` plus the zero-state bootstrap specify exact-ref resolution, fixed component admission, manifest/digest verification, staged replacement, wrapper-last publication, and `--install-only` termination before setup.

Reassessment: use only the checked-in zero-state bootstrap from an exact hosted-accepted commit. Do not copy checkout files, edit installation state, switch through a moving ref, or invoke setup. After the transaction, independently use the wrapper-owned status surface and installed read-only doctor. Any setup continuation, UAC prompt, identity mismatch, ambiguous result, or provider/protected effect is a stop condition.

## Primitive-to-high-level plan

1. Commit and push this assessment/research/reassessment plan.
2. Require all four hosted jobs plus doctor on the exact plan head.
3. Invoke `src/bootstrap/zero-state-bootstrap.mjs` with that exact 40-hex head, the canonical user home, and `--install-only`.
4. Require a zero exit and one bounded `devbridge/entry-install-v1` result binding component, selected runner, and pinned runner to the exact head.
5. Re-run wrapper-owned `entry-install-status` and require all three exact identities to match.
6. Re-resolve the manifest-owned commands and run only installed read-only doctor with the verified example configuration.
7. Document the exact effect and nonclaims, push it, and require the hosted matrix on the implementation record.

No setup, UAC, service/provider/storage action, VM/guest operation, repository execution, physical canary, model invocation, or GPU/CUDA work is authorized by this plan.

