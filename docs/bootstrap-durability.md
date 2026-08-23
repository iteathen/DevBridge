# Bootstrap durability and prerequisite establishment

This document defines the pre-live-host durability contract for the normal DevBridge bootstrap path. It coordinates with `docs/setup.md`, `docs/self-install.md`, issue #103, and the application-management recovery contract in #180.

## Governing principle

Prefer the smallest mechanism that makes state deterministic and trustworthy.

Do not build a general transaction engine merely to make installation restartable. Partial work is acceptable when it is either disposable or exactly owned and reconcilable. Indeterminate authority is not acceptable.

At every interruption point, DevBridge must be in one of two states:

1. the previous trusted state remains authoritative; or
2. a small durable record identifies the exact intended subject and enough accepted progress to continue deterministically.

Recovery must not require an operator or coding agent to infer which runner, repository selection, dependency set, provider object, or setup action was intended.

## Zero-state bootstrap boundary

The normal fresh-host command may assume only a supported Node.js runtime. The first DevBridge bytes must be acquired by the command itself using Node facilities.

Therefore the supported zero-state command must not require any of these files or tools to exist before the bootstrap starts:

- `install-devbridge.mjs`;
- a DevBridge checkout;
- Git;
- npm packages;
- GPG/GPGV;
- Hyper-V/libvirt/image-construction utilities;
- DevBridge configuration/state/keyrings/package snapshots.

Node is unavoidable because the command itself begins with `node`. Everything after Node is a discovered prerequisite, not an assumption.

The exact copy/paste command remains implementation-owned until the fetch/bootstrap path is implemented and qualified. Documentation must not present `node .\\install-devbridge.mjs ...` as the true blank-host entrypoint.

## First-byte acquisition

Use Node's built-in networking facilities for the tiny bootstrap acquisition boundary so Git is not required to obtain the installer itself.

The acquired bootstrap must remain bounded and source-fixed. A mutable branch name may locate development/qualification bytes, but durable progress must bind to an exact resolved subject before later installation mutation proceeds.

Do not turn the first-byte loader into a second package manager, setup implementation, provider manager, or runtime supervisor.

## Durable exact selection

For an explicit development selector such as `cuda-target`:

1. resolve the selector to one exact commit;
2. persist that exact subject in a small bootstrap record before installation performs authority-changing publication;
3. if bootstrap is interrupted, an argument-equivalent rerun resumes that exact subject rather than resolving the moving branch again;
4. changing to another exact subject requires an explicit update/restart decision rather than being an accidental property of retrying the same command.

Once permanent entry is committed and verified, installation is complete. Later setup blockers are resumed through `devbridge setup`; they do not require repeating the first-byte/bootstrap installation path.

## Prerequisite model

Prerequisites are classified by owner instead of routed through one generic installer.

### Node

Node.js is the bootstrap prerequisite. The launcher must verify the supported version and fail with a precise prerequisite message when it is too old.

### JavaScript packages

DevBridge currently has no npm package dependencies. `npm install` is therefore not part of bootstrap recovery today.

If runtime JavaScript dependencies are introduced later, they must be version-locked and installed through a deterministic package-lock-based path such as `npm ci`, followed by verification. Unconstrained `npm install` is not a general host repair mechanism.

### Host/system prerequisites

Git, GPG/GPGV, provider-management utilities, image tools, virtualization features, services, privileges, and similar requirements belong to setup-owned platform prerequisite adapters.

Setup must inspect before use. Where installation is safe, bounded, and covered by local setup authority, the owning adapter may establish the prerequisite and then verify actual readiness. Where elevation, reboot, licensing, ownership ambiguity, or operator policy prevents automatic repair, setup reports a focused blocker and resumes afterward.

Presence is not readiness. Finding an executable or platform feature does not by itself prove the capability is usable.

## Recovery semantics

Prefer roll-forward reconciliation over destructive rollback.

- Temporary/uncommitted files may be replaced.
- Exact DevBridge-owned corrupt components may be quarantined and reconstructed.
- Valid committed components are verified and reused.
- Foreign or ambiguously owned state fails closed rather than being adopted or deleted.
- PATH should point to one stable DevBridge launcher surface; normal repair happens behind that surface.
- A setup rerun validates accepted choices and current reality. It must not silently choose different repositories or construction authority because discovery changed.

The recovery path should be boring: rerun the supported surface, verify, repair owned incomplete state, and continue.

## Qualification

Do not attempt to enumerate every machine instruction as a transaction phase. Test the trust transitions that matter:

- interruption before exact subject persistence;
- interruption after exact subject persistence but before permanent entry commit;
- interruption during component/wrapper publication;
- interruption after permanent entry commit but before setup completion;
- interruption after setup authority/selection persistence;
- missing prerequisite followed by prerequisite establishment and re-entry;
- moving branch between the interrupted invocation and rerun;
- corruption of DevBridge-owned committed state;
- foreign/unowned collision.

For each recoverable case, rerun must converge on the same intended exact subject and accepted configuration without manual filesystem surgery. Setup must never invoke the physical construction `run` surface while qualifying this bootstrap/recovery gate.

## Live-host gate

The physical host must not use the development bootstrap as a fresh-host qualification step until all of the following are true:

- the documented entry command fetches its own first DevBridge bytes using Node;
- later prerequisites are discovered before they are depended on;
- explicit moving selectors are durably pinned for interrupted recovery;
- permanent-entry commit is distinguishable from incomplete installation;
- setup re-entry preserves accepted authority/selection instead of silently recalculating it;
- focused interruption/recovery tests are green on supported hosted CI;
- the setup path still stops at the read-only physical status gate and never crosses into construction automatically.

This gate is about dependable installation state. It does not authorize physical Ubuntu image construction; that remains separately gated by #197 and the real-host status result.
