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

The normal fresh-host command may assume only a supported Node.js runtime. The first DevBridge bytes are acquired by the command itself using Node facilities.

Therefore the supported zero-state path does not require any of these files or tools to exist before bootstrap starts:

- `install-devbridge.mjs`;
- a DevBridge checkout;
- Git;
- npm packages;
- GPG/GPGV;
- Hyper-V/libvirt/image-construction utilities;
- DevBridge configuration/state/keyrings/package snapshots.

Node is unavoidable because the command itself begins with `node`. Everything after Node is a discovered prerequisite, not an assumption.

`bootstrap-devbridge.mjs` is the standalone first DevBridge stage. It can execute directly from bounded bytes loaded through a Node `data:` import, so the blank-host shell does not need to create an installer file or checkout first.

For a stable install, the Node first-byte loader fetches `bootstrap-devbridge.mjs` from the fixed DevBridge source and invokes it with no selector. For development qualification, the same loader may fetch the bootstrap from `cuda-target` and pass `--ref cuda-target`. A moving development branch is only a locator for the bootstrap bytes; durable installation progress is bound inside Stage 0 before any permanent-entry publication.

The direct command `node .\install-devbridge.mjs ...` remains useful installer qualification, but it is not the zero-state entry because possessing that file is already a prerequisite.

## First-byte and exact-source acquisition

The first-byte loader and Stage 0 use Node's built-in networking facilities. Git is not part of the supported zero-state exact-subject installation path.

Stage 0:

1. resolves a moving selector, when supplied, to one exact commit;
2. persists that exact subject before permanent-entry installation mutation;
3. fetches the installer stage from that exact commit;
4. fetches the exact-source acquisition child from the same exact commit;
5. gives that child only the installer's fixed permanent-entry component membership;
6. materializes those files directly from the persisted exact commit with bounded Node fetches;
7. hands the prepared exact source to the existing installer transaction.

The acquisition child is a nested bootstrap LEGO. It owns only exact-source retrieval, path containment, byte bounds, and cleanup of partial materialization. It does not own manifest admission, wrapper activation, PATH, setup, provider state, or construction authority.

The permanent-entry installer continues to own its existing manifest generation, per-file SHA-256 verification, quarantine, installation lock, atomic component publication, previous-wrapper preservation, and JavaScript-wrapper commit point. A direct moving-ref/local-fixture installer invocation may still use its managed Git compatibility path; that compatibility path is not used by zero-state exact-subject bootstrap.

Do not turn the first-byte loader or exact-source child into a package manager, setup implementation, provider manager, or runtime supervisor.

## Durable exact selection

For an explicit development selector such as `cuda-target`:

1. resolve the selector to one exact commit;
2. persist that exact subject in a small bootstrap record before installation performs authority-changing publication;
3. if bootstrap is interrupted, an argument-equivalent rerun resumes that exact subject rather than resolving the moving branch again;
4. changing to another exact subject requires an explicit update/restart decision rather than being an accidental property of retrying the same command.

The recovery record is an authority checkpoint, not an event log. Partial source materialization and temporary stages are disposable and are rebuilt from the persisted exact subject.

Once permanent entry is committed and verified, installation is complete. Later setup blockers are resumed through `devbridge setup`; they do not require repeating the first-byte/bootstrap installation path.

## Prerequisite model

Prerequisites are classified by owner instead of routed through one generic installer.

### Dependency closure rule

Every prerequisite discovered after the Node bootstrap boundary remains owned by setup until its owning adapter reaches one of two outcomes:

1. the prerequisite is established under bounded local authority and its actual usability is verified; or
2. the adapter proves that an external authority boundary prevents safe automatic reconciliation.

A missing ordinary dependency by itself is **not** an operator action. Setup must not print instructions to install a package manually merely because the current implementation lacks an acquisition path. It must either own a pinned, bounded, platform-appropriate reconciliation path or stop at a real external boundary such as elevation, reboot, licensing, ownership ambiguity, host policy, unsupported platform, network failure, or integrity failure.

Acquisition authority remains local to the owning prerequisite adapter. The generic setup orchestrator receives readiness/blocker evidence and any narrow local binding it must pass to the immediate consumer; it does not learn package-manager or vendor-specific mechanics.

### Node

Node.js is the bootstrap prerequisite. The launcher verifies the supported version and fails with a precise prerequisite message when it is too old.

### JavaScript packages

DevBridge currently has no npm package dependencies. `npm install` is therefore not part of bootstrap recovery today.

If runtime JavaScript dependencies are introduced later, they must be version-locked and installed through a deterministic package-lock-based path such as `npm ci`, followed by verification. Unconstrained `npm install` is not a general host repair mechanism.

### Host/system prerequisites

Git, GPG/GPGV, provider-management utilities, image tools, virtualization features, services, privileges, and similar requirements belong to setup-owned platform prerequisite adapters or the downstream provider status gate that owns their readiness.

Setup inspects a prerequisite before the first operation that consumes it. Where installation is safe, bounded, platform-owned, and covered by current local setup authority, the owning adapter establishes the prerequisite and then verifies actual readiness. Where elevation, reboot, licensing, ownership ambiguity, servicing policy, unsupported platform, network integrity, or operator policy prevents automatic repair, setup reports a focused blocker and resumes afterward.

The current bounded reconciliation slice behaves as follows:

- `gpgv`/`gpgv.exe` must execute successfully before Ubuntu release-signature verification is attempted.
- On Windows, an already-usable signature verifier is reused without package mutation. If it is absent and the setup process is already elevated, the signature-verifier prerequisite adapter fetches only the exact runtime-pinned official installer through bounded Node networking, verifies its pinned SHA-256 before execution, performs the vendor-supported unattended installation, removes the transient installer, re-discovers `gpgv.exe`, and executes it before claiming readiness.
- The exact verifier executable discovered by that adapter is a local-only binding. Setup may carry it directly into Ubuntu release verification so a PATH update that is invisible to the current process does not force a new shell. The executable path is not remote setup/status data.
- A non-elevated missing Windows signature verifier stops **before** download or mutation at the elevation boundary. Package digest disagreement, download/integrity failure, installer failure, or an unusable post-install verifier is a focused resumable blocker; none is converted into a manual-package-install instruction.
- On Windows, setup inspects `ssh.exe` and `ssh-keygen.exe` before the physical image path needs them. If they are unavailable and the current process is already elevated, DevBridge may establish only the Windows `OpenSSH.Client~~~~0.0.1.0` capability when Windows reports that exact capability as `NotPresent`, then re-inspects the commands.
- DevBridge never self-elevates. A non-elevated OpenSSH gap is an explicit elevation boundary.
- A Windows servicing state that is pending/inconsistent, an installation result requiring restart, or a servicing-policy/source failure is a resumable caller boundary rather than authority to perform broader repair.
- Hyper-V remains owned by the read-only physical canary readiness gate. Setup does not silently enable Hyper-V or restart the host. Provider/image readiness must pass the existing status preflight before construction can be separately authorized.

Presence is not readiness. Finding an executable, capability record, installer exit code, or virtualization feature does not by itself prove the capability is usable.

## Setup re-entry and status gate

Accepted repository identity/selection and the exact Ubuntu package snapshot are persisted before later prerequisite/authority work. A setup rerun therefore reuses accepted authority rather than silently recalculating it because discovery changed.

After prerequisites are ready, setup establishes/verifies Ubuntu release and package authority, creates the physical-canary configuration internally, and calls only the canary `status()` surface.

`devbridge setup` never calls physical construction `run()`. A ready status means the separate construction gate may be considered by the operator; it does not mean setup already constructed an image or VM.

## Recovery semantics

Prefer roll-forward reconciliation over destructive rollback.

- Temporary/uncommitted files may be replaced.
- Exact DevBridge-owned corrupt components may be quarantined and reconstructed.
- Valid committed components are verified and reused.
- Foreign or ambiguously owned state fails closed rather than being adopted or deleted.
- PATH points to one stable DevBridge launcher surface; normal repair happens behind that surface.
- A setup rerun validates accepted choices and current reality. It must not silently choose different repositories or construction authority because discovery changed.
- A prerequisite that was successfully established before a later interruption is inspected again on re-entry; if it is ready, the mutation is not repeated.

The recovery path should be boring: rerun the supported surface, verify, repair owned incomplete state, and continue.

## Qualification

Do not attempt to enumerate every machine instruction as a transaction phase. Test the trust transitions that matter:

- interruption before exact subject persistence;
- interruption after exact subject persistence but before permanent entry commit;
- interruption during exact component acquisition or component/wrapper publication;
- interruption after permanent entry commit but before setup completion;
- interruption after setup authority/selection persistence;
- missing prerequisite followed by bounded prerequisite establishment, verification, same-invocation continuation, and re-entry;
- prerequisite acquisition with bad package digest or unusable post-install capability;
- elevation and restart boundaries;
- moving branch between the interrupted invocation and rerun;
- corruption of DevBridge-owned committed state;
- foreign/unowned collision.

For each recoverable case, rerun must converge on the same intended exact subject and accepted configuration without manual filesystem surgery. Hosted Windows and Linux CI exercise the bootstrap/recovery contracts. Setup qualification must never invoke the physical construction `run` surface.

## Live-host gate

The first real Windows zero-state pass exposed an incomplete prerequisite contract: missing `gpgv.exe` was reported as an operator installation task even though GPG/GPGV is explicitly not a zero-state assumption. That finding reopens #238 until the setup-owned reconciliation path is fully qualified and proved on the live host.

The live host must not be used to work around this gap manually. The correction is qualified in hosted Windows/Linux CI first. The next supported live-host pass must exercise the updated zero-state setup path itself, including setup-owned reconciliation of a missing signature verifier when local authority permits it.

Even after the prerequisite contract is green, the live pass stops at the setup-owned read-only physical `status` gate. A fully ready status does not itself authorize automatic construction. Physical Ubuntu image construction remains separately gated by #197 and an explicit operator decision after the status result has been reviewed.