# DB-HO035 — issue #360 protected profile configuration

Status: assessment, primary-source research, reassessment, plan, and implementation checkpoint from exact predecessor `36d0c05995296cd8c49ffd7bcf9045f87c7e5b49` on `stage8/362-protected-activity-channel`. Physical activation remains gated on an explicitly announced UAC window.

## Assessment

The protected activity and image-adoption bricks do not by themselves create a usable execution profile. The live protected authority still has zero declarations. The ordinary setup record contains stable selected repository identities, and the ordinary image library contains one accepted parent-free `linux-development` / `ubuntu-2604-production-v5` image, but no bounded accepted artifact joins those facts into a desired declaration.

Registering a declaration through the lifecycle mutation wire would be the wrong ownership boundary. That wire owns bounded operations against already accepted declarations. Expanding it into a generic setup/admin API would let an ordinary lifecycle caller propose desired VM state and would mix configuration authority with runtime operation authority.

Running a second provider owner in the ordinary process is also rejected. It would recreate the authority split fixed by #362 and make service failure a path to ordinary-process Hyper-V mutation.

The smallest missing primitive is therefore:

1. an ordinary setup-owned, revisioned accepted profile configuration containing only neutral declarations and stable workspace authority identities;
2. an elevated one-shot reconciler that reads that exact bounded artifact, verifies the already-adopted protected image, and registers declarations through their existing compare-and-swap registry;
3. ordinary postcondition inspection through the protected read client using exact declaration digests;
4. one existing UAC transaction when either the protected service generation or accepted configuration requires reconciliation.

This primitive creates no VM, network, writable disk, bridge route, workspace root, or guest process. Those effects remain behind later lifecycle stages and the #359/#360 topology gate.

## Primary-source research

Microsoft's [Service Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights) states that service configuration rights are security-sensitive, that `SERVICE_CHANGE_CONFIG` should be granted only to administrators, and that the SCM checks requested access against service security descriptors. The accepted setup transaction therefore remains in the bounded elevated child and does not broaden the ordinary lifecycle endpoint.

Node's official [`fs` documentation](https://nodejs.org/api/fs.html) states that `lstat()` observes a symbolic link itself rather than following it and that `realpath()` resolves a canonical path including symbolic links. A privileged reader of ordinary setup state must combine bounded file size, real-file checks, and canonical containment; normal JSON parsing alone is not a privilege boundary.

Microsoft's [`Get-VHD`](https://learn.microsoft.com/en-us/powershell/module/hyper-v/get-vhd?view=windowsserver2025-ps) returns the virtual-disk object for an exact path, while [`Test-VHD`](https://learn.microsoft.com/en-us/powershell/module/hyper-v/test-vhd?view=windowsserver2025-ps) tests a virtual disk or chain for problems that make it unusable. The configuration reconciler therefore consumes the protected image library's existing provider-verified result. It does not treat an ordinary configuration declaration as proof that a VHDX is usable.

Microsoft's [Hyper-V NAT guidance](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/setup-nat-network) states that Windows is limited to one NAT network per host. [`Remove-NetNat`](https://learn.microsoft.com/en-us/powershell/module/netnat/remove-netnat?view=windowsserver2025-ps) removes an exact NAT object and drops its existing translations. DevBridge therefore keeps current profile resource reconciliation inside the elevated setup transaction, while an obsolete disposable NAT must be retired only as an exact, separately authorized local cleanup subject; provider absence or a foreign/conflicting NAT remains fail-closed.

No new external platform behavior is needed for declaration CAS. The repository's existing `EnvironmentDeclarationRegistry` is the normative local owner: it reads the current revision, permits an exact no-op, and rejects replacement unless the caller presents the revision it just observed.

## Reassessment

The accepted configuration may originate in ordinary setup state because it contains no command, provider object, VM name, path, credential, transport detail, or capability grant. It is a bounded local proposal accepted only during explicit setup. It cannot prove its own protected postcondition.

The elevated child must not trust the ordinary file as a filesystem capability. It derives one fixed location from the broker-bound installation state, requires every selected path node to be a real non-link object, bounds the state file before reading, canonicalizes the root/directory/file, and requires exact containment. The parsed document then passes through the closed configuration/declaration schemas.

Protected reconciliation proceeds in this order:

1. read and normalize one accepted configuration record;
2. bound declaration and image inventories;
3. reject any protected declaration outside the accepted set rather than deleting or adopting it;
4. verify every exact protected image before the first declaration write;
5. read each current declaration revision;
6. register only absent/changed declarations with that exact expected revision;
7. reread and compare exact identity, revision, and declaration digest;
8. return only neutral readiness/change evidence.

If a process stops after some declarations are registered, re-entry observes exact declarations as no-ops and continues. No caller-supplied cleanup or rollback target exists. An unexpected protected declaration is a manual setup conflict, not automatic deletion authority.

## LEGO boundaries

- `environment-profile-configuration.js` owns only normalized configuration records, digests, inventory validation, image-verification consumption, declaration CAS, and neutral inspection. It knows no operating system, provider, repository name, path, service, or transport.
- `environment-profile-configuration-state-store.js` owns one fixed persistence key and exposes only load/save.
- `setup-environment-profile-configuration.js` is the ordinary setup topology edge. It maps stable numeric subjects into deterministic workspace identities and the currently selected profile/image output. Mutable repository names and privacy metadata do not enter the declaration.
- `windows-environment-profile-configuration.js` is the Windows setup topology edge. It derives the fixed accepted/protected roots, hardens privileged input, invokes provider-aware image adoption, and attaches protected image/declaration ports transiently.
- `windows-lifecycle-authority-readiness.js` retains one bounded elevation decision. It consumes only neutral `inspect`/`reconcile` configuration studs; it does not learn declaration schemas or provider operations.
- The lifecycle read result adds one neutral declaration digest so the ordinary process can prove exact accepted state without receiving protected storage or provider authority.

## Dependency-ordered plan

1. Add deterministic declaration/configuration digests and a bounded revisioned configuration registry.
2. Add a neutral reconcile/inspect transaction with pre-write image verification, unexpected-profile refusal, CAS registration, and exact reread.
3. Add ordinary setup composition for the accepted Linux profile and stable repository subjects.
4. Add hardened Windows privileged intake and transient protected foundation/declaration attachment.
5. Join configuration readiness to the existing one-shot UAC path without adding a new CLI capability or lifecycle mutation operation.
6. Test normal, no-op, image failure, resource failure/identity drift, extra declaration, digest mismatch, stable-subject projection, no repository-name leakage, exact protected composition, ordinary pending configuration, and elevated reconciliation.
7. Run syntax, focused, LEGO/preflight, and full tests; review the diff and push before live activation.
8. During an explicitly announced UAC window, retire only the exact authorized disposable NAT, then run normal setup through the installed exact branch selector. Require protected image adoption, service refresh, owned storage/network reconciliation and re-observation, declaration revision evidence, and the ordinary negative-capability proof.
9. Only then continue #360 with environment creation, verified workspace routes, and the physical Linux C canary.

## Implementation checkpoint

The code now implements steps 1–7:

- accepted configurations are canonical, bounded to 64 profiles, 4,096 aggregate workspaces, and 2 MiB of normalized JSON, revisioned, content-digested, and idempotent;
- profile reconciliation bounds protected inventories, rejects unaccepted declarations, verifies every exact active image before mutation, uses the current declaration revision as CAS authority, and rereads exact identity/revision/digest;
- setup projects only stable numeric repository subjects and deterministic workspace identities; mutable repository names do not cross;
- an accepted image remains usable as declaration authority after deliberate retirement of the redundant ordinary copy, preventing a permanent source-store compatibility dependency;
- that retention is exact to the current output and bootstrap generations; obsolete accepted output fails closed instead of silently erasing or perpetuating desired state;
- the elevated Windows reader rejects missing structure, indirection, unbounded files, canonical escape, malformed records, and an inexact authority plan;
- every elevated reconciliation re-runs idempotent provider-aware image adoption before declaration intake, including when the protected service generation itself is already current;
- the same elevated transaction reconciles and re-observes protected storage and networking before it can claim the accepted profile ready; ordinary inspection consumes only the protected activity channel's neutral aggregate-readiness projection;
- ordinary readiness compares protected read results to exact accepted declaration digests and requests at most the existing single elevation when configuration alone is pending;
- the elevated child reconciles configuration only after the protected service and its negative-capability boundary are structurally verified.

Verification from the exact working tree on 2026-08-28:

- focused owner/composition run: 32 passed, zero failed, one Windows-host symlink-fixture skip;
- repository suite: 1,456 passed, zero failed, 14 platform-specific skips;
- candidate preflight: 94 syntax files, two JSON files, and 91 targeted test files passed;
- `git diff --check`: no whitespace errors (Git reported only the repository's expected LF-to-CRLF checkout notices).

Two initial full-suite attempts exposed pre-existing host-resource coupling in unrelated provider unit fixtures: each requested a 4 GiB profile while the concurrent suite left only narrowly more than the required 5 GiB including reserve. Their protected-boot assertions now use the adapters' valid 256 MiB minimum, preserving real production admission while keeping the tests focused on their claimed provider behavior. The deterministic-liveness test involved in the first attempt passed five consecutive isolated reruns; the final unchanged full suite passed.

The physical UAC transaction remains pending and will be appended without rewriting this checkpoint. Read-only host re-observation found the exact protected switch ready with its current ownership marker, while the disposable fast-track NAT still occupies the single WinNAT slot. The disposable switch has no attached guest adapter, static mapping, or active NAT session; its exact retirement remains a separate local cleanup action and is not encoded as permanent compatibility logic.

## Explicit exclusions

This checkpoint does not create or start an environment, migrate the disposable fast-track NAT, publish a route, execute guest code, install Windows, add a host fallback, enable a coding model, or implement GPU/CUDA behavior.
