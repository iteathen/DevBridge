# DevBridge handoff — issue #177 authority refresh — 2026-08-25

## Stop point

Stop after the Windows protected-authority service has been converted to consume the shared durable reconciliation transaction and that exact code head has passed the complete four-job CI gate.

Do **not** begin physical-host work from this handoff. No physical Windows command, VHDX acceptance mutation, or #197 image/VM construction was run in this slice.

The next implementation boundary is the one-command Windows elevation/resume composition, including safe migration from the already-deployed legacy fixed protected-runtime layout before the first real host invocation.

## Active branch / PR

- Repository: `iteathen/DevBridge`
- Branch: `security/177-authority-refresh`
- Draft PR: #296 — `[ARCHITECTURE][#177] Add self-refreshing protected authority reconciliation`
- PR base: `security/177-windows-authority`
- Parent architecture issue: #177
- Critical-path implementation issue: #292
- Windows authority predecessor / physical acceptance: #288 / PR #289
- Linux authority work remains preserved and paused in #293 / PR #295.

## Exact qualified code checkpoint

Exact code SHA:

`1254562343cef57ce275b5609de73e89f214b881`

Commit:

`feat: integrate Windows authority refresh transaction`

CI run:

`32913533112`

All four jobs succeeded on that exact SHA:

- `test (ubuntu-latest)` — success, including repository-execution architecture gates, full tests, and doctor.
- `test (windows-latest)` — success, including repository-execution architecture gates, full tests, and doctor.
- `smoke (ubuntu-latest)` — success.
- `smoke (windows-latest)` — success.

This is the authoritative resume checkpoint for source code. The handoff file itself is a docs-only commit on top of this qualified code SHA.

Previous useful green checkpoint:

- `b8bf9c2cb61ef8c5bf840d9ce4965b24e6468906`
- CI `32911560987`
- all four jobs green.

A Windows Hyper-V all-prefix arithmetic subprocess timeout observed on the earlier run was already owned by #290 and passed on rerun; it was not folded into #292 or used to change production timeouts.

## Architecture contract that remains authoritative

Physical hosts are final integration/acceptance fixtures, not interactive development environments.

The operator contract must converge to one ordinary command:

```text
devbridge setup
```

That same invocation must eventually:

1. observe current protected authority state;
2. do no privileged mutation when the exact generation is current and healthy;
3. when stale/missing, launch one tightly bounded elevated child transaction;
4. keep the ordinary parent alive and wait for the child;
5. resume automatically as the original ordinary identity;
6. prove ordinary protected-state and mutation-endpoint denial;
7. perform the exact protected-authority positive canary;
8. continue to the read-only readiness/construction gate;
9. after failure/interruption, resume by rerunning the same `devbridge setup` command.

The privileged service itself must **not** self-update. Setup/reconciliation refreshes the root/Administrator-owned immutable protected runtime transactionally.

Portable ordering stays:

`observe -> stage -> verify -> quiesce -> promote -> start -> health -> checkpoint / rollback`

Every mutating effect uses DB-009 durable intent/attempt evidence and observe-before-repeat recovery.

## Shared reconciliation core already complete

The shared Node LEGO is:

`src/setup/protected-authority-reconciliation.js`

It owns only neutral transaction semantics and knows no Windows/Linux/SCM/systemd/Hyper-V/libvirt/path/provider identities.

Important behavior already qualified:

- closed exact-generation candidate/observation/journal schemas;
- deterministic transaction identity;
- durable `planned` then `attempted` checkpoints before external effects;
- observe-before-repeat after interruption;
- exact-current healthy privileged no-op;
- candidate verification before quiesce;
- previous-generation retention through promotion/start/health checkpoint;
- candidate-health rollback to the exact previous generation;
- candidate drift rejection;
- ambiguous post-effect state blocks rather than replaying blindly;
- lost terminal checkpoint cannot silently discard rollback evidence.

The Windows neutral adapter is:

`src/setup/windows-lifecycle-authority-refresh-adapter.js`

It projects Windows-local mechanics into exact neutral ports only:

- journal
- read installation
- materialize exact generation
- verify exact generation
- stop exact service generation
- configure exact service generation
- start exact service generation
- probe exact service generation
- restore exact service generation

Do not move platform semantics into the portable core.

## Latest Windows service integration

The latest qualified source batch changed only:

- `src/setup/windows-lifecycle-authority-service.js`
- `test/windows-lifecycle-authority-service.test.js`
- `test/windows-lifecycle-authority-runtime-evidence.test.js`

The service owner now consumes `reconcileWindowsLifecycleAuthorityRefresh(...)` rather than using the old monolithic provision/stop/post-health sequence.

### Generation-addressed protected runtime

The plan already binds candidate runtime to:

`<protectedRoot>/generations/<generation>/...`

The service integration now treats each generation as immutable exact evidence rather than overwriting one live runtime directory.

Per-generation evidence uses:

`devbridge/windows-lifecycle-authority-generation-v1`

with exact digests for:

- package snapshot
- Node executable
- C# host source
- compiled host executable

The generation directory identity is re-derived from exact package + Node evidence and must match before it is accepted.

### Protected reconciliation journal

The Windows mechanics persist the shared reconciliation journal under the protected root. Journal validation remains closed and bounded before the shared core consumes it.

This journal identifies the single transaction-scoped previous generation needed for interruption recovery. Stale arbitrary generation directories do not become authority just because they exist.

### Ordering and rollback now owned by the shared transaction

On an elevated refresh:

- initialization creates only the protected root / generation-container substrate and closed ownership evidence;
- candidate generation materialization occurs only when the shared core invokes the durable `stage` effect;
- candidate bytes are verified before the old service is quiesced;
- promotion configures SCM to the exact candidate generation while retaining the exact previous generation;
- start + health are proven through exact generation evidence;
- failed candidate health restores and revalidates the exact previous generation through the shared rollback path.

The legacy behavior of simply stopping the failed candidate and leaving a partial authority state is no longer the recovery owner.

### Exact-current fast path

An ordinary exact-current setup path now requires service evidence to match the exact candidate generation before treating the service as current, then runs the protected probe. It must not accept a merely reachable stale authority as current.

### Ownership and ACL boundaries

The existing closed ownership protocol remains `devbridge/windows-lifecycle-authority-ownership-v1`; this slice did not widen it into a topology registry.

Existing sealed roots are not generically ACL-reset during refresh. The service identity remains unable to rewrite protected generation directories; it owns only the mutable authority state surfaces it requires.

### Initialization interruption handling

Fresh protected-root initialization accepts only a narrowly defined safe residue: an otherwise empty protected root containing an empty generation container. Any other root without ownership evidence fails closed.

## Known legacy-layout requirement before physical host use

This is important.

The physical Windows host previously established the older protected service/runtime layout, which used fixed protected runtime paths rather than `generations/<generation>`.

The new service integration intentionally fails closed when it sees owned protected state without the generation-addressed runtime container, reporting that the legacy runtime layout requires explicit migration.

Therefore **do not run the new branch on the real Windows host yet**.

Before physical use, GitHub-side code/tests must define a closed migration transaction from the exact old protected layout into one exact generation-addressed layout. The migration must:

- require exact DevBridge ownership evidence;
- verify the old package/Node/host evidence before treating it as a migratable generation;
- never copy arbitrary caller-selected paths;
- preserve the old working authority until the new generation is staged, verified, activated, healthy, and checkpointed;
- be interruption-safe and rerunnable through the same `devbridge setup` command;
- fail closed when old evidence is incomplete or inconsistent;
- require no ad-hoc host repair command.

The existing `windows-lifecycle-authority-migration-safety.js` must not be assumed to solve this protected-runtime generation migration merely because it handles migration safety elsewhere. Inspect its ownership before extending or introducing the proper adapter.

## Current one-command gap

`src/setup/windows-lifecycle-authority-readiness.js` still embodies the old manual two-shell behavior:

- ordinary stale/missing authority returns a blocker telling the operator to rerun setup elevated;
- elevated success returns a blocker telling the operator to rerun setup non-elevated for ordinary negative-capability proof.

`src/app/setup.js` calls this readiness reconciler once and surfaces that blocker.

This is now the next primary code seam.

Do **not** put UAC launching into `windows-lifecycle-authority-service.js`. That module should remain the elevated Windows service/filesystem/SCM mechanics owner behind the exact refresh adapter.

## Recommended next implementation slice

Implement the Windows one-command elevation/resume composition in GitHub first.

Preferred ownership shape:

1. Add/extend a thin Windows elevation adapter that owns the single UAC boundary only.
2. Ordinary readiness observes first.
3. If exact authority is current and protected proof succeeds, no elevation occurs.
4. If reconciliation or qualified legacy-layout migration is required, launch one fixed internal elevated helper/entrypoint with a closed argv contract and no shell-string construction.
5. Elevated child runs only the bounded protected-authority reconciliation/migration transaction and exits with structured bounded status.
6. Ordinary parent waits, then resumes readiness in the same invocation.
7. Parent performs ordinary negative-capability proof and protected positive authority proof.
8. Setup continues to the existing read-only readiness gate.
9. Cancellation/failure returns one durable blocker; rerunning `devbridge setup` resumes from protected evidence.

The exact helper transport/argv contract still needs implementation review. Do not invent a generic Administrator command runner or generic privileged file API.

### Hosted tests required before host use

At minimum cover:

- exact-current healthy authority => zero elevation;
- fresh install => exactly one bounded elevation;
- stale generation => exactly one bounded elevation and automatic ordinary resume;
- qualifying fixed-layout legacy authority => migration through the same one-command loop;
- non-qualifying legacy authority => fail closed with no destructive mutation;
- UAC cancellation/child failure => bounded blocker, no second elevation in the same invocation;
- interruption at migration/refresh durable frontiers => same command resumes;
- elevated child cannot accept arbitrary executable/command/provider/path authority;
- ordinary parent always performs post-child negative proof;
- setup never crosses into `--construct` implicitly;
- Linux behavior remains explicitly unaffected/fail-closed according to its own gate.

After this slice, freeze the exact head and require the same four CI jobs before proceeding.

## After the one-command loop

The remaining Windows-first sequence is:

1. Design and implement the dedicated tiny disposable DevBridge-owned VHDX acceptance fixture for #288, separate from #197.
2. Hosted-test its exact ownership/lifecycle contract before touching the host.
3. Prove ordinary direct delete/replace denial.
4. Prove the corresponding exact-owned lifecycle mutation through protected authority.
5. Run full exact-head Windows + Ubuntu CI.
6. Only then use the real Windows host, ideally with one ordinary command:

   `devbridge setup`

7. If it reports a blocker, fix the blocker in GitHub and rerun the same command; do not perform ad-hoc host surgery.
8. Once Windows is truthful/usable, resume Linux #293/PR #295 atop the shared reconciler. Linux remains fail-closed until its physical qualification.

#197 Ubuntu production image construction remains separate and unauthorized during this authority work.

## Do not regress these constraints

- No privileged runtime execution from an ordinary writable checkout.
- No self-modifying privileged service.
- No generic elevated shell/command runner.
- No caller-selected provider object crossing the privilege boundary.
- No Windows direct-provider fallback to make setup appear usable.
- No platform names/types leaking into the shared reconciliation core.
- No physical host debugging loop before hosted fault-injection coverage.
- No claim of a passed gate without an exact SHA and exact workflow evidence.
- No #197 image/VM construction until its own gate authorizes it.

## Repository hygiene note

Issues #297, #298, and #299 were accidental connector artifacts created while preparing this handoff. Each was immediately closed as `not planned`, explicitly states that it contains no requirement/decision/work item, and must be ignored as project context.

## Resume checklist

1. Confirm PR #296 head includes this handoff and its parent code SHA is `1254562343cef57ce275b5609de73e89f214b881`.
2. Confirm code checkpoint CI `32913533112` remains four-job green.
3. Read #292 and this handoff before editing.
4. Inspect `src/setup/windows-lifecycle-authority-readiness.js`, `src/app/setup.js`, `src/cli.js`, and the legacy protected-layout migration evidence/tests.
5. Implement the one-UAC ordinary-parent/elevated-child/ordinary-resume LEGO plus closed legacy-layout migration support.
6. Add hosted interruption/cancellation/idempotence/security tests.
7. Freeze exact head and run full four-job CI.
8. Do not touch the physical host until that gate is green.
