# DB-HO036 — issue #360 protected environment activation

Status: assessment, research, reassessment, and implementation plan from exact predecessor `a6aded5bfb01815eb1e5ed252df83ac004f113cf` on `stage8/362-protected-activity-channel`.

## Assessment

The accepted profile configuration, protected image intake, declaration compare-and-swap, and protected activity channel are implemented. The public setup composition still stops at the production-image result. It does not invoke the protected lifecycle `create` operation, resume an interrupted create, or prove that the resulting environment and workspace routes are healthy.

The lower lifecycle stack already owns the complete restartable sequence:

`image -> resources -> materialization -> preparation -> workspaces -> readiness`

The workspace stage verifies every declared workspace through its scoped bridge before it publishes the credential-free activity policy. The lifecycle authority client exposes only bounded `list`, `status`, `run`, and `resume` operations and cannot carry provider objects, paths, commands, credentials, or transport details. A second environment-construction implementation in setup would therefore duplicate authority and violate the LEGO boundary.

The current setup ordering also publishes accepted profile configuration and reconciles the protected authority before it knows whether a production image exists. On a blank host that produces an empty configuration, may spend the one bounded elevation transaction before image construction, and cannot continue into environment creation after the image becomes complete without a second reconciliation pass.

## Research

No new external provider behavior is introduced by this slice. The relevant platform facts remain those already established for DB-HO035:

- Microsoft service security keeps service configuration and privileged state reconciliation behind the administrator-owned service boundary: <https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights>.
- Microsoft documents the one-WinNAT-per-host constraint that must be satisfied before the protected resource reconciliation can become ready: <https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/setup-nat-network>.

The authoritative behavior for this composition is repository-owned:

- DB-020 requires VM-only repository execution and forbids a host fallback;
- `docs/environment-construction.md` defines the restartable neutral construction stages and workspace-publication-last rule;
- `docs/environment-lifecycle-authority.md` requires ordinary composition to use the neutral protected client;
- `docs/setup.md` requires setup to create the profile environment, verify guest/bridge/workspace readiness, and enable execution only after separate local consent plus readiness.

## Reassessment

Setup should not invent a setup-specific provider operation. It should select the one exact accepted profile through the protected read client and apply only this bounded state machine:

1. an exact ready profile is a no-op;
2. an interrupted `create` is resumed through the existing lifecycle journal;
3. an absent profile whose recommended action is exactly `create` is created through the protected mutation client;
4. every other diagnosis fails closed and remains owned by the normal lifecycle/setup repair path;
5. the final status must prove the exact profile and logical environment identity, terminal lifecycle state, healthy diagnosis, present storage/attachment, ready enrollment/bootstrap, healthy guest, and clear transition.

The accepted image must be complete before setup publishes the desired profile configuration and invokes its one protected reconciliation pass. This preserves the single elevation boundary on a fresh installation and makes declaration registration a real prerequisite of environment activation.

This slice does not enable polling or repository execution. Operational configuration and explicit execution opt-in remain a later setup composition step after the environment/route proof.

## Dependency-ordered implementation plan

1. Add one provider-free setup activation adapter around the existing lifecycle client.
2. Bound list cardinality and require one exact profile match before mutation.
3. Support only ready no-op, interrupted-create resume, and exact absent-create transitions.
4. Independently re-read and validate the terminal healthy status after every transition.
5. Reorder public setup so prerequisites and image construction/status precede accepted profile publication and the single protected lifecycle reconciliation.
6. Invoke activation only after the production image is complete and protected configuration is ready.
7. Project only neutral activation readiness/change evidence in setup results and handoffs.
8. Test ready no-op, create, resume, ambiguous profile, foreign active operation, degraded/forged final status, image-incomplete non-activation, and complete-image setup composition.
9. Run focused tests, repository preflight, the full suite, diff review, and remote issue evidence before physical UAC activation.

## Explicit exclusions

This slice does not remove a NAT, invoke UAC, construct a Windows image, enable task polling, write the final operational configuration, run repository code, add a provider fallback, enable a coding model, or implement GPU/CUDA behavior.

## Implementation checkpoint

The implementation now attaches setup to the existing protected lifecycle stud without adding a provider or setup-specific construction path:

- `setup-environment-activation.js` accepts only a neutral lifecycle client and an exact profile selector;
- inventory is bounded to 64 entries and requires one exact profile match;
- an already healthy terminal environment is a mutation-free no-op;
- only `materialization-not-created -> create` and an already journaled resumable `create` are admitted automatically;
- repair, rebuild, reset, recreate, ambiguous inventory, foreign active transitions, malformed responses, and degraded state fail closed;
- every create/resume result is discarded as authority and followed by an independent exact status read;
- terminal acceptance requires a healthy diagnosis, no active lifecycle transition, one stable implementation generation, present materialization/storage, ready attachment/enrollment/bootstrap, a healthy guest, and a clear transition;
- public setup results remove the protected logical identity and expose only neutral ready/change/state/count evidence.

Public setup now orders the dependent effects as:

`discovery -> prerequisites -> image authority/status/construction -> accepted profile publication -> one protected reconciliation -> protected create/resume -> exact readiness`

An incomplete or blocked image returns before profile publication, protected authority reconciliation, or environment mutation. A complete image continues through the same invocation. This makes the image a real prerequisite and avoids spending the protected reconciliation transaction on an empty fresh-host configuration.

Verification from the exact working tree on 2026-08-28:

- activation owner tests: 9 passed, zero failed;
- focused setup/lifecycle/activity/profile/construction/routing tests: 146 passed, zero failed, one Windows symlink-fixture skip;
- candidate preflight: 94 syntax files, two JSON files, and 91 targeted test files passed;
- complete repository suite: 1,467 passed, zero failed, 14 platform-specific skips;
- `git diff --check`: no whitespace errors; Git emitted only the repository's expected LF-to-CRLF checkout notices.

No UAC prompt, protected service mutation, image construction, VM creation, route publication, or guest execution was performed by this software checkpoint. Physical activation remains the next separately announced host step.
