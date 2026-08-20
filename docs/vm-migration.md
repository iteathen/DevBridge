# VM migration and legacy-sandbox removal inventory

Status: active migration map for DB-020 / issue #107.

This document records what the VM program replaces, what remains valuable, and exactly when removal becomes safe. It is not permission to delete runtime code during Stage 0.

## Governing rule

DB-020 is the target repository-execution architecture. The current Linux/Bubblewrap path and the experimental Windows ProcessContainer/AppContainer work in draft PR #106 are temporary migration scaffolding and historical implementation evidence.

Do not extend the host sandbox stack as the long-term answer to repository execution. Security fixes that keep an interim path from becoming less safe are still allowed until the replacement path is accepted.

Removal happens only after the named replacement stage has produced exact evidence. A mechanism being architecturally superseded is not enough reason to delete the only currently working boundary.

## Planning conclusions from Stage 0

The VM pivot does not require an unresolved authority decision before implementation begins.

The architecture now fixes these invariants:

- host control plane and authoritative Git/publication remain trusted and host-only;
- repository guests are untrusted even at administrator/root;
- repository guests are persistent per stable repository identity + guest OS/profile;
- immutable/versioned base images feed persistent per-repository child/differencing disks where supported;
- guest networking is normally enabled;
- no host secrets or arbitrary writable host mounts are exposed to guests;
- host↔guest command/file interaction is narrow and host-controlled;
- no AppContainer/Bubblewrap layer is required inside the VM;
- Hyper-V on Windows is the first provider target; future provider abstraction must preserve the same semantics.

The following choices are deliberately deferred to their owning stages rather than treated as Stage-0 blockers:

- exact VM state/config schema and stable environment identifier — Stage 1;
- Hyper-V management API/PowerShell/CIM implementation details and image construction flow — Stage 2;
- exact VM/disk naming, startup/shutdown and reseed mechanics — Stage 3;
- exact host↔guest transport(s), framing, authentication/identity and binary-transfer protocol — Stage 4;
- exact guest bootstrap/package/tooling baseline — Stage 5;
- source synchronization, candidate import, coding/model adapter topology, and private/authenticated service access without host-secret injection — Stage 6;
- exact qualification matrix, doctor evidence, recovery probes and VM resource policy — Stage 7;
- installation/reconfiguration prompts and migration UX — Stage 8.

## Category 1 — remove after VM replacement

These components exist to enforce repository-code isolation inside host processes or to compensate for limitations of that model. They should disappear after VM cutover and acceptance unless a later stage finds a small provider-independent primitive worth extracting.

### Linux Bubblewrap provider

Current main:

- `src/runtime/bubblewrap-sandbox.js`
- `src/runtime/bubblewrap-probe.js`
- Bubblewrap-specific status constructors/fields in `src/runtime/sandbox-status.js`
- Bubblewrap selection/normalization in `src/runtime/deterministic-sandbox.js`
- Bubblewrap-specific package/AppArmor setup in `.github/workflows/ci.yml`
- Bubblewrap-specific setup text in `README.md`, `docs/setup.md`, `docs/bootstrap.md`, `docs/tool-profiles.md`, `docs/architecture.md`, `docs/roadmap.md`, DB-003/DB-011/DB-013/DB-015, and related tests

Removal blocker: Stage 7 must prove the VM boundary and Stage 8 must make the replacement deployable. Stage 9 performs deletion.

### Windows ProcessContainer/AppContainer experiment

Draft PR #106 (`agent/windows-sandbox-mxc`) contains the experimental Windows host-sandbox family. It is useful evidence but no longer the target architecture.

Files/families currently present on that PR include:

- `src/runtime/windows-processcontainer-sandbox.js`
- `src/runtime/windows-processcontainer-compat-provider.js`
- `src/runtime/windows-job-launcher.cs`
- `src/runtime/windows-job-wrapper.ps1`
- `src/bootstrap/windows-sandbox-runtime.mjs`
- Windows sandbox provisioning hooks in `src/bootstrap/candidate-validator.mjs`
- MXC/AppContainer host-preparation and qualification workflow steps in `.github/workflows/ci.yml`
- `test/windows-job-launcher.test.js`
- `test/windows-processcontainer-paths.test.js`
- `test/windows-workload-acceptance.test.js`
- Windows-specific branches of `test/worker-sandbox.test.js`, `test/deterministic-sandbox.test.js`, `test/doctor-capabilities.test.js`, `test/doctor-enforcement-reporting.test.js`, `test/bootstrap-candidate-sandbox.test.js`, and related fixtures

The PR's AppContainer SID reaping, Job Object experiments, ACL work, MXC 0.7 provisioning, native AppContainer helper, and compatibility provider naming are not required by DB-020.

Removal/retirement blocker: Stage 7 VM qualification + Stage 8 setup integration. Stage 9 closes/retire PR #106 and deletes any merged/transplanted remnants that are no longer referenced.

### Host-filesystem sandbox policy

Target-obsolete concepts for repository execution include:

- exposing host `workspace.externalReadRoots` to repository processes;
- host project write + subtractive `.git` protection as the isolation model;
- host `/usr`, `/bin`, `/lib*`, SDK/toolchain read-root construction for guest workloads;
- synthetic host HOME/TMP mounts used to hide operator state from repository processes;
- host namespace network `deny`/`unrestricted` as the primary confidentiality boundary;
- sandbox-specific capability probes that prove outside-project read/write denial on the host.

Config/document compatibility may remain temporarily so existing installations can start during migration, but Stage 8 must define migration behavior and Stage 9 removes or deprecates obsolete fields cleanly.

### Gitless host project projection

Draft PR #106 introduced `src/runtime/project-projection.js` and tests to give Windows host-sandbox workers a disposable Gitless project view that structurally omits `.git`/`.devbridge` and later imports edits.

DB-020 replaces this with a persistent guest filesystem plus a host↔guest source/candidate synchronization protocol. The strong idea worth retaining is **authoritative Git is never worker authority**; the specific host Gitless projection is removable.

Removal blocker: Stage 6 must prove source sync, drift detection, candidate import, and authoritative host sealing without a writable host project mount. Stage 7 must qualify it before Stage 9 deletion.

### Sandbox-specific worker IPC mount plumbing

Bubblewrap currently maps control-owned host files to fixed paths such as `/run/devbridge-exchange/context.json` and `/run/devbridge-exchange/result.json`. PR #106 adds Windows staging/import variants because writable ACL semantics differ.

The host-filesystem bind/ACL mechanism is target-obsolete. The logical run/turn/result protocol is not.

Removal blocker: Stage 4 bridge must carry bounded context/results/files and Stage 6 must route real workers through it. Stage 9 removes host bind/ACL variants.

## Category 2 — refactor / retain

These components encode valuable provider-independent ownership, recovery, or execution semantics. They should be adapted to VM-backed execution rather than discarded.

### Generic process/result capture

Retain the provider-independent behavior in:

- `src/runtime/process-runner.js`
- `src/runtime/deterministic-process-runner.js`
- `src/runtime/process-tree.js` where it still owns host-side helper processes
- bounded stdout/stderr capture, timeout/cancellation, result parsing, and failure classification

Refactor point: the runner should invoke a VM environment/bridge adapter rather than preparing a host sandbox launch. Guest-process lifecycle may be observed/controlled through the bridge, while the host still owns its own bridge/helper child processes.

### Deterministic operation registry and security classification

Retain:

- `src/runtime/deterministic-operation-registry.js`
- operation schemas and local executable/parameter authority concepts
- fail-closed classification of unknown/dynamic operations as repository-controlled

Refactor point: repository-controlled classes target the VM provider. Truly static/control-plane operations may remain host-side only when their classifier proves they do not execute repository-controlled code.

### Worker/result protocols

Retain the semantic contract from:

- `src/runtime/worker-exchange.js`
- `devbridge/worker-exchange-v1`
- `devbridge/result-v1`
- run/turn/context digest binding
- bounded result size/parsing
- control-owned consumption and recovery

Refactor point: the current hard-link/inode and fixed host-mount path implementation is host-filesystem specific. Stage 4/6 should keep the identities/protocol semantics while moving transport to bridge objects and host-owned durable transfer state.

### Controller plans and proposal semantics

Retain DB-013's core rules:

- plans are data, not shell authority;
- executable/argv/environment/path authority stays local;
- project proposals are not accepted Git state until host verification/sealing;
- cleanup, assertions, context receipts, and deterministic operation schemas remain controller-owned.

Refactor point: repository-code operations execute inside the persistent guest; plan parsing/materialization authority remains host-side.

### Authoritative Git/publication

Retain intact in principle:

- host-managed canonical repository identity and baseline resolution;
- DB-017 publication baseline/candidate identity;
- host-side staging/sealing/commit creation;
- explicit expected remote-head CAS/reconciliation;
- GitHub credential stripping from untrusted execution;
- publication/merge/release authority.

Stage 6 changes how source/candidate bytes cross the VM boundary, not who owns Git authority.

### Recovery, leases, checkpoints, verification, supervision

Retain:

- DB-009 durable effects/reconciliation;
- DB-007 checkpoint-and-proceed/hard-gate semantics;
- DB-016 host-only identity/lease/fencing;
- DB-018 cooperative daemon pause and local resource authority;
- DB-019 risk-driven verification and exact durable evidence;
- DB-011 release identity, candidate artifact identity, last-known-good, activation and rollback;
- runtime/daemon lifecycle control.

Refactor points:

- VM/image/environment/bridge identities become recovery/evidence inputs;
- candidate-controlled self-update tests move behind VM isolation;
- VM resources replace host child priority as the primary workload resource surface where applicable.

### Tool inventory/onboarding

Retain DB-015 distinctions between observation and authority, manifest/schema validation, bounded help parsing, secret-safe projection, and operation registration.

Refactor point: repository-class discovery/probing/execution occurs in the guest. Host inventory remains for DevBridge control-plane prerequisites such as Git, Node runtime, Hyper-V management, and bridge/bootstrap tooling.

## Category 3 — historical evidence

Preserve, do not rewrite:

- `docs/handoffs/DB-HO002-0819-1226.md` and checksum on PR #106;
- `docs/handoffs/DB-HO004-0819-1702.md` and checksum on PR #106;
- `docs/handoffs/DB-HO004-0819-1902.md` and checksum on PR #106;
- older sandbox/security testing reports under `docs/testing/`;
- Git history, PR #106 discussion, CI runs, and failed/superseded experiments.

These records answer “what was observed at that checkpoint?” They must not be edited to pretend the VM architecture existed earlier, and they must not override DB-020.

Particularly valuable historical lessons include:

- configuration/provider presence is not enforcement evidence;
- process-tree ownership must survive detached-child behavior;
- writable mailboxes need identity/replace protections;
- subtractive `.git` protection is fragile compared with keeping authoritative Git outside the untrusted execution domain;
- a failed integration attempt disproves that implementation, not necessarily the underlying OS primitive;
- cross-platform path/identity semantics must be explicit.

Those lessons should inform VM bridge/identity tests even though the host sandbox code itself is removed later.

## Category 4 — blocked removal matrix

| Legacy family | Replacement evidence required | Earliest removal owner |
| --- | --- | --- |
| Bubblewrap provider/probe/status | Hyper-V provider + persistent environment + bridge + Stage-7 real boundary/workload acceptance | Stage 9 |
| Windows ProcessContainer/AppContainer/MXC/native helper | Same VM acceptance on intended Windows host; Windows and Linux guest workloads | Stage 9 |
| host `externalReadRoots` repository-execution semantics | guest tooling/source flow works without host path exposure; Stage-8 config migration defined | Stage 9 |
| host sandbox network deny/share policy | network-on guest contract qualified with no host secrets | Stage 9 |
| Gitless host projection | Stage-6 source sync/candidate import + drift/reseal acceptance | Stage 9 |
| sandbox bind/ACL worker mailbox plumbing | Stage-4 bridge + Stage-6 worker result recovery acceptance | Stage 9 |
| sandbox-specific candidate validation | candidate-controlled tests execute in VM while DB-011 artifact/rollback invariants pass | Stage 9 |
| Bubblewrap/AppContainer CI qualification | Stage-7 Hyper-V VM boundary/end-to-end qualification exists and is stable | Stage 9 |
| sandbox-specific config/schema/help text | Stage-8 installer/reconfiguration migration handles existing installs | Stage 9 |
| sandbox-specific tests | corresponding VM/provider/bridge/security/recovery tests exist and cover the retained invariant | Stage 9 |

## Concrete current-main ownership map

### Host sandbox implementation to replace

- `src/runtime/bubblewrap-sandbox.js`
- `src/runtime/bubblewrap-probe.js`
- `src/runtime/deterministic-sandbox.js` — replace provider selection/factory; likely retain a generic execution-environment admission seam under a new name
- `src/runtime/sandbox-status.js` — replace sandbox-specific status vocabulary with VM/provider/image/environment readiness evidence
- sandbox-specific branches in `src/runtime/process-runner.js`
- sandbox-specific branches in `src/runtime/deterministic-process-runner.js`
- candidate sandbox use in `src/bootstrap/candidate-validator.mjs`

### Control-plane infrastructure to retain/refactor

- `src/runtime/process-runner.js`
- `src/runtime/deterministic-process-runner.js`
- `src/runtime/deterministic-operation-registry.js`
- `src/runtime/worker-exchange.js`
- `src/runtime/process-tree.js` for host-owned helper lifecycle
- runtime state/recovery/coordinator/Git/publication modules
- DB-007/009/016/017/018/019 enforcement/evidence paths
- bootstrap release-integrity and supervisor activation/rollback logic

### Configuration requiring migration design, not Stage-0 edits

Current `config/devbridge.example.json` includes:

- `workspace.externalReadRoots`
- `execution.allowUncontainedTools`
- local tool profiles whose `sandbox` fields describe host filesystem/network semantics
- implicit absence of a VM/image/environment configuration section

Stage 1 defines the new VM state/config contracts; Stage 8 defines operator migration/reconfiguration and decides which legacy keys are deprecated, translated, or rejected. Stage 0 does not mutate the live config schema.

### CI/tests requiring later replacement

Current `.github/workflows/ci.yml` explicitly installs/configures Bubblewrap/AppArmor on Linux and gates Linux tests with `DEVBRIDGE_REQUIRE_SANDBOX_TEST`.

Do not remove that coverage while Linux host-sandbox execution remains live. Stage 7 adds real Hyper-V VM qualification and end-to-end Windows/Linux guest workloads. Stage 9 removes obsolete host-sandbox qualification only after the VM jobs provide replacement evidence.

Test families expected to be deleted or rewritten later include Bubblewrap probe/provider, host outside-read/write/network/Git-administration assertions, host sandbox doctor reporting, sandbox candidate validation, host-sandbox worker execution, and PR #106 Windows host-sandbox tests.

Test semantics expected to survive include fail-closed provider readiness, exact environment/evidence identity, secret non-exposure, authoritative Git isolation, bounded IPC/results, timeout/cancellation, process/lifecycle cleanup, recovery, candidate sealing, and end-to-end workload acceptance.

## Documentation migration map

Stage 0 updates active docs so the architecture is no longer ambiguous:

- `specs/DB-020-vm-execution-boundary.md` — normative target and precedence;
- `specs/DB-003-security.md` — security/threat/network/secret model;
- `specs/DB-008-git-supply-chain.md` — host Git authority + guest network/dependency model;
- `docs/architecture.md` — controller/VM/bridge/dataflow overview;
- `docs/roadmap.md` — issue #107 stages become the active repository-execution roadmap;
- `docs/setup.md` and `docs/bootstrap.md` — distinguish current transitional readiness from Stage-8 Hyper-V target;
- `docs/tool-profiles.md` — host filesystem sandbox fields are transitional; guest tooling is target;
- `AGENTS.md` — agents must not extend the old sandbox architecture as the target;
- `README.md` — user-facing current-vs-target statement;
- related execution specs may continue to describe existing behavior only when they defer to DB-020 for the target boundary.

Historical handoffs/testing reports are not rewritten.

## Stage-0 sanity check

The migration direction is consistent with the project's authority hierarchy and design principles:

- **correctness/containment:** compromise is contained by withholding host authority from an entire guest trust domain rather than trying to enumerate every host read/write edge;
- **recoverability:** VM/disk/environment identities become durable DB-009 state; disk persistence is independent of command lifetime;
- **Git/GitHub responsibility:** credentials and authoritative refs never enter the guest;
- **operator trust:** doctor must report observed provider/image/environment readiness, not configured aspirations;
- **LEGO/SOLID:** hypervisor and bridge are adapters behind control-owned lifecycle/execution ports;
- **KISS:** one VM boundary replaces multiple OS-specific host sandbox implementations; no mandatory nested sandbox or network proxy;
- **checkpoint-and-proceed:** later implementation can proceed stage-by-stage because the authority decisions are now fixed; checkpoint only if a stage discovers a new choice that would change these invariants;
- **DB-019 verification cost:** cheap contract/unit checks precede expensive real VM qualification, while Stage-7 security/platform changes still trigger required qualification evidence;
- **setup UX:** Stage 8 owns discovery/provisioning/re-entry; Stage 0 does not pretend Hyper-V support is already installed or operational.

No runtime code or live config schema is removed by Stage 0.
