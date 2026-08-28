# DB-HO018 — issue #293 Linux numeric identity binding

Status: implemented, qualified, and integrated into `cuda-target` by PR #331 at `6b6aafa0db3662e6074dd8f8445501027e8302bc`. The slice was originally planned from exact baseline `7148efb88bbc15c1237dfb42b7f1578fdcb3e87b`, then rebased and fully requalified against `c021abc00ffb7118990776831083a5fb66a1381c` after the separately isolated test-reliability prerequisites were integrated.

## Assessment

The existing local-identity reconciler owns fixed shadow-utils observation/mutation and returns the exact non-root service UID plus three distinct capability GIDs. The lifecycle ownership record already has the only authoritative `localIdentity` field and prevents rebinding after it is set. DB-HO017 correctly refuses generation staging until that field is present.

No lifecycle-local composition currently connects those two owners. Calling the identity reconciler without saving its exact numeric result leaves later stages blocked. Saving names or inferring IDs elsewhere would duplicate identity authority and make a same-name account/group replacement invisible.

## Research and reassessment

This brick introduces no new shadow-utils or operating-system effect. It reuses the primary-source findings recorded in DB-HO011: service supplementary membership is replaced exactly, ordinary operator read/coordination membership is append-only, and management membership is denied. Those mechanics remain entirely in `linux-local-identity-reconciliation.js`.

Primary sources remain:

- [shadow-utils `usermod`](https://github.com/shadow-maint/shadow/blob/master/man/usermod.8.xml)
- [shadow-utils `useradd`](https://github.com/shadow-maint/shadow/blob/master/man/useradd.8.xml)
- [shadow-utils `groupadd`](https://github.com/shadow-maint/shadow/blob/master/man/groupadd.8.xml)

The missing owner is therefore a pure lifecycle composition, not another account adapter. It will project the local plan into a neutral `reconcile` action, pass an existing numeric binding back as the expected immutable identity, and save a newly observed binding only after the account action returns exact evidence.

## Plan

1. Add one lifecycle-local identity-binding module with a closed input and three neutral ports: state load, state save, and reconcile.
2. Require an established lifecycle ownership claim before invoking account effects.
3. Project only local account/group/home/shell values plus `claimEstablished: true` and the current expected numeric identity. Do not pass a plan object, record store, service manager, provider, repository, VM, or setup context through the action stud.
4. Strictly validate the returned applicability/change/identity evidence and require exact equality when a binding already exists.
5. Save a first numeric binding last, re-read the returned canonical ownership record through its owning normalizer, and reject any inexact persistence result.
6. Reconcile interruption after account creation but before record persistence by rerunning the same bounded action and completing only the missing binding write.
7. Prove fresh binding, bound no-op, interrupted save recovery, missing claim, widened/aliased/root identity, expected-binding mismatch, inexact save, unknown fields, and provider/topology isolation.
8. Add the focused suite to repository preflight; run focused tests, preflight, VM/LEGO architecture gates, and the full suite before isolated publication.

This slice invokes no real shadow-utils command in hosted tests and performs no systemd, elevation, libvirt, provider, VM, production-image, or #197 physical action. Unit/service effects remain the next dependency.

## Implementation

`linux-lifecycle-authority-identity-binding.js` now owns only the connection between local identity reconciliation evidence and the lifecycle ownership record. It:

- accepts one local plan and three neutral actions (`load`, `save`, and `reconcile`);
- requires the exact lifecycle ownership claim before invoking the action;
- projects only local account/group/home/shell values, an established-claim fact, and the current expected numeric identity;
- accepts only applicable bounded evidence containing one non-root service UID and three distinct non-root capability GIDs;
- passes an existing binding back as immutable expected evidence and rejects any numeric change;
- records a first binding only after the reconcile action returns exact evidence;
- treats record persistence as a separate final effect, so a crash after account creation re-runs bounded observation/reconciliation and completes only the missing record write;
- rejects unknown topology-shaped inputs/ports and contains no account command, service manager, provider, repository, VM, shell, or elevation implementation.

Repository preflight now includes the identity-binding boundary suite.

## Current local evidence

- focused identity/generation/records/shadow-utils suites: 27 passed, 0 failed;
- repository preflight: passed (`syntaxFiles: 43`, `jsonFiles: 2`, `targetedTests: 41`);
- VM/repository-execution LEGO architecture selection: 21 passed, 0 failed;
- full suite: 1,238 total, 1,227 passed, 11 platform skips, 0 failed, with a normal TAP exit in 52.1 seconds.

The earlier qualification attempt exposed the independent test-reliability issues #323, #326, and #328. Those fixes and their evidence are integrated through `c021abc00ffb7118990776831083a5fb66a1381c`; all three issues are closed. This branch contains none of those test-harness changes, and the final evidence above was produced only after rebasing onto their integrated baseline.

## Remote evidence

GitHub Actions run `33129012235` passed all four required jobs for PR #331: Ubuntu smoke in 16 seconds, Ubuntu full test in 31 seconds, Windows smoke in 50 seconds, and Windows full test in 2 minutes 23 seconds. The isolated implementation branch was removed after the squash merge. Issue #293 remains open because Linux unit/service, bounded elevation, and physical libvirt qualification dependencies are still outstanding.
