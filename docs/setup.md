# DevBridge setup

DevBridge is installed from a Node-only zero-state bootstrap into one permanent entry and then keeps its managed runtime current through the secure supervisor.

## Current implementation versus VM target

DB-020 and `docs/execution-profile-environments.md` define the active repository-execution architecture: a trusted DevBridge controller on the host plus persistent, networked execution-profile VMs. **Execution profiles own persistent VMs; repositories own isolated workspaces inside compatible execution-profile VMs.**

Repository discovery/selection and VM provisioning are separate concerns. Selecting many repositories must not imply creating or starting one VM per repository. Repositories that use the same compatible profile share that physical profile VM through separate workspace identities.

The required initial host providers are:

- **Windows:** Hyper-V;
- **Linux:** KVM/QEMU managed through libvirt.

Stages 0–6 of that VM path are implemented on the migration stack. Stage 1 removed the old host-sandbox path; Stages 2–5 provide foundation, persistent environments, bridge, and guest preparation; Stage 6 restores routed repository execution. Stage 3's original repository-owned persistent-VM topology is historical implementation evidence and is superseded by the execution-profile ownership correction in issue #138.

The migration stack behaves as follows:

- repository-controlled and candidate-controlled execution uses only locally admitted ready persistent VM routes and otherwise remains fail-closed on both Windows and Linux;
- Windows `doctor` can observe the Stage-2 Hyper-V management/image/network/storage foundation;
- Linux `doctor` can observe the Stage-2 KVM/QEMU/libvirt management/image/network/storage foundation;
- provider/image readiness is reported separately from repository-execution readiness;
- Draft PR #106's Windows ProcessContainer/AppContainer work is superseded migration evidence and is not the supported target.

The completed Stages 3–5 interval kept execution unavailable. Stage 6 restores it through persistent VMs only. Do not introduce direct/uncontained host execution as compatibility behavior.

Stage 2 does not add installer mutation UX. Do not manually configure provider objects and assume DevBridge owns them merely because `doctor` can observe the host. VM Stage 8 (#116), coordinated with setup/reconfiguration issue #103 and fresh-host image/licensing issue #192, owns supported discovery/provisioning/re-entry after the lower VM stages are implemented and qualified. Stage 8 must provision/reuse physical environments by execution profile and create/repair repository workspaces separately.

## Blank-slate installation rule

DevBridge setup must behave as if the user is a normal new user on an unknown host. It must not rely on developer-workstation history.

Do not assume:

- virtualization/provider features are installed, enabled, authorized, or healthy;
- source ISOs or prepared base images exist;
- the user wants Windows;
- a Windows product key or organization activation service exists;
- host Windows activation can be reused in a VM;
- the user is legally permitted to publish prepared Windows bytes;
- any image artifact repository exists;
- the GitHub owner is `iteathen` or any other fixed account;
- GitHub credentials can create repositories/Releases;
- zstd/qemu-img/xorriso/ADK or other image-construction tools are installed;
- the local image cache is durable reconstruction authority;
- any DevBridge configuration file, signing keyring, package snapshot, image authority, payload generation, VM name, or helper script already exists.

Discover safe facts first. Choose reasonable safe defaults for everything that can be determined without ambiguity. Prompt only for a genuine unresolved choice, a required authentication/elevation/reboot boundary, a legal/licensing decision, or another decision for which DevBridge cannot safely choose a default.

The user is not expected to understand or manually author internal configuration schemas, image-construction authorities, package pins, guest-payload generations, canary files, provider object names, or internal entrypoints.

See `docs/fresh-host-image-provisioning.md` and #192 for the complete image/licensing/recovery flow.

## One-command installation contract

The normal installation experience is **one copy/paste Node bootstrap invocation from a blank supported machine into the supported setup/re-entry path**.

The exact current stable and `cuda-target` qualification commands are documented in `docs/self-install.md`. They begin with `node`, fetch bounded `bootstrap-devbridge.mjs` bytes with Node's built-in `fetch`, and do not require a pre-existing installer file, checkout, Git, npm package, GPG/GPGV installation, or provider/image tool before the bootstrap itself starts.

For a moving development selector, Stage 0 resolves the selector to one exact commit and persists that exact subject before permanent-entry publication. An argument-equivalent interrupted rerun resumes the persisted subject even if the branch moved in the meantime. The permanent-entry component set is then fetched from that exact commit with the nested Node exact-source acquisition LEGO; the zero-state exact-subject path does not use Git.

Ordinary setup remains read-only at each production-image physical `status` gate. Reaching `ready-for-construction` means that gate authorizes an explicit next action; it does **not** mean an image or VM was constructed by the observation. `devbridge setup --construct` advances only the first incomplete accepted profile through its existing restartable construction owner and then returns. A nonblocked incomplete durable canary preserves its resumable frontier for the next explicit invocation.

The broader one-command target remains responsible for eventually carrying bounded local consent for routine setup changes, such as enabling a selected provider, constructing/qualifying the required image, and enabling repository execution after validation. Those later construction/provisioning steps remain coordinated by #192/#197 and their owning roadmap gates rather than being implied by #238 bootstrap completion.

A setup invocation may pause only when the platform or policy genuinely requires human action. A missing ordinary dependency is not by itself such a boundary: its owning setup adapter must reconcile and verify it when bounded local authority permits, or prove the external authority that prevents safe reconciliation. Accepted repository selection and the exact Ubuntu package snapshot are durable across re-entry so an elevation, restart, authentication, or later readiness blocker does not restart the questionnaire.

Windows protected apply uses an explicit two-step consent boundary. Ordinary setup first completes all network, media, package, construction-status, conflict, and accepted-configuration preparation without requesting elevation. If the exact accepted configuration needs protected reconciliation, setup writes one versioned `prepared` frontier bound to the configuration digest, profile-selection revision, and accepted identity/repository/package checkpoint, returns successfully, and asks the operator to re-enter `devbridge setup` while present. That re-entry performs only accepted profile-selection observation, exact local command resolution, and exact frontier/configuration/checkpoint validation before requesting the single UAC child. It performs no GitHub discovery, media work, package authority work, construction, or generic PATH mutation before the prompt. A stale or changed frontier is never elevated. After protected readiness, setup resumes environment activation and operational publication directly from that exact checkpoint; it does not repeat the completed remote discovery or construction-authority work.

Setup writes neutral live phase evidence to stderr. Each event contains only a bounded phase/state/detail and elapsed duration; it does not expose credentials, provider identities, repository contents, or internal paths. While the bounded elevated child is active, setup reports a periodic `protected-transaction` heartbeat. Existing protected reconciliation journals remain the restart authority: cancellation, interruption, or process loss preserves the exact prepared/apply frontier and does not authorize a second prompt in the same invocation.

## PATH and permanent command

Successful setup must leave a stable `devbridge` command available on the user's `PATH`.

- The bootstrap may use a temporary/downloaded stage-0 file, but normal post-install operation must not require users to type `node ~/.devbridge/bin/devbridge.mjs ...` or an equivalent implementation path.
- Setup owns a stable launcher/shim under the DevBridge installation and adds its bin directory to the appropriate user PATH using platform-appropriate persistent configuration.
- Do not overwrite an unrelated existing `devbridge` executable. A collision is a focused blocker that identifies the conflicting command and offers a safe resolution.
- PATH mutation must be installation-owned and reversible by uninstall/reconfiguration.
- Before reporting success, setup verifies the exact stable launcher content and rereads the persistent PATH result. Persistent User PATH and the current process environment are separate observations.
- When setup added the persistent entry during the current invocation, an already-running process tree is reported as `refresh-required`; an independently refreshed operator shell should discover the command.
- When persistent PATH was already correct but the current caller omits the directory, setup reports `caller-omitted`. Children normally inherit that omission, so spawning another child shell is not presented as a repair.
- Whenever bare discovery is unavailable, setup displays the exact verified stable launcher invocation. It never recommends the Node implementation entry as a PATH workaround.
- An integration that knows the canonical installation home resolves and verifies the exact owned command through the installation contract. It does not guess PATH, require the invoking model process to inherit the operator's full environment, or move privileged behavior into the integration.

After successful installation, normal operator documentation uses commands such as `devbridge setup`, `devbridge status`, and `devbridge doctor`, not internal Node file paths.

## Repository defaults

Repository discovery is driven by the authenticated GitHub identity and verified access, not by a hard-coded owner or a manual repository questionnaire.

For eligible repositories belonging to / available to the authenticated user under the selected policy:

- **0–30 eligible repositories:** setup selects all of them by default and proceeds without a repository-selection question;
- **31 or more eligible repositories:** setup stops at the repository-selection boundary and asks which repositories to include; `all` remains an explicit choice;
- setup must never silently truncate discovery to the first 30 repositories.

Eligibility and effective capabilities must still be verified. Archived/read-only/inaccessible repositories or repositories that cannot satisfy the intended operation should be reported truthfully rather than silently treated as writable execution targets.

Repository count does not determine VM count. Repositories sharing a compatible execution profile share the physical profile VM through distinct workspace identities.

## Execution-profile selection

Setup accepts one bounded local profile choice:

```text
devbridge setup --profiles <linux|windows|both|none|defer>
```

With no accepted selection, omitting `--profiles` chooses the ordinary Linux profile. Re-entry without the option preserves the accepted selection. `none` accepts an empty selection and keeps repository execution unavailable. `defer` does not replace accepted state or an interrupted profile-selection transaction; it preserves repository setup and stops before platform-specific setup work.

Selection is configuration intent only. It does not install or enable a provider, approve source media, construct an image, create or start a VM, activate an environment, or prove readiness. Windows media/status reconciliation is attached only when Windows is selected. Ubuntu prerequisite/authority/construction work is attached only when Linux is selected. `--construct` requires at least one accepted profile and advances only the first incomplete selected construction target in fixed local policy order; with both current profiles selected, Linux precedes Windows and one invocation advances at most one profile frontier. Windows media options require a selected Windows profile. A blocked earlier target is never skipped, and a selected but unavailable profile remains fail-closed without a host-execution fallback.

The selection transaction is revisioned and restartable through the host-owned setup-authority record. Its application adapter resumes only its own interrupted operation and refuses to absorb an interrupted transaction owned by another setup component.

### Windows image-distribution selection

Windows setup also requires an explicit prepared-image distribution policy after exact image construction and before declaration publication or protected environment activation. The currently implemented source-neutral choice is:

```text
devbridge setup --windows-distribution local-reconstruction
```

`local-reconstruction` keeps prepared image bytes local and creates no repository, Release, asset, URL, or upload authority. It preserves the approved source-media/construction owner as the recovery route; the distribution policy does not copy media or recipe identity into its own state. It also does not claim byte-deterministic reconstruction. Only an exact canonical size/SHA-256 reproduction may satisfy the existing image subject. Different qualified bytes are a new immutable generation and require explicit declaration rebind before use.

Omitting the option preserves an accepted policy. Without one, Windows media discovery and image construction remain available, and independent Linux construction remains available, but a completed Windows image stops before resource-conflict mutation, environment declaration, protected activation, or operational enablement. The profile-neutral policy record is immutable and digest-addressed; setup authority retains only its opaque subject. Unknown transfer/storage modes and widened policy state fail closed.

Remote-artifact distribution is not an alias for this choice and is not yet implemented. It requires separate authenticated owner/repository discovery, explicit Windows distribution-rights confirmation, explicit repository/Release approval, durable mutation reconciliation, exact #178 publication, pinned numeric Release/asset/digest identity, reacquisition, provider validation, and boot qualification. No upload may occur merely because a private repository exists.

### Windows activation-policy selection

Windows setup requires a separate explicit local activation policy before a completed Windows image may proceed into protected environment activation. The currently implemented non-secret choice is:

```text
devbridge setup --windows-activation later
```

This records `configure-later`; it does not install a product key, infer host entitlement, invoke a guest activation command, or claim that Windows is activated. Setup continues to report **Windows activation required** as a non-blocking deferred capability after the policy is accepted.

Omitting the option preserves an accepted policy on re-entry. If none is accepted, Windows media discovery and image construction remain available, and independent Linux image work remains available, but a completed Windows image stops before declaration publication, protected lifecycle/environment activation, and operational enablement. The policy record is immutable and digest-addressed; setup authority retains only its opaque local subject. A missing, substituted, imported, unavailable, or otherwise mismatched accepted record fails closed.

Retail, MAK, KMS, Active Directory-based activation, and subscription activation are not yet implemented. Setup rejects those undeclared choices instead of treating `configure-later` as a compatibility alias. Product keys and other secret material are not accepted by this policy contract or serialized into its state/status.

After every selected profile has an exact complete accepted image, setup publishes declarations for only those profiles and requires the publication to cover the entire selection. Ubuntu and Windows declaration policy remains in separate profile-owned modules; the common publisher consumes neutral sources and stable repository subjects. Protected activation follows accepted profile order and returns after the first changed environment. Re-entry re-observes completed profiles before advancing the next one, and a blocked earlier profile is never skipped. Operational configuration is published only after every selected environment verifies ready through the protected lifecycle client.

## Current requirements

The **zero-state bootstrap boundary** requires only:

- Node.js 22.16.0 or newer;
- network access to the fixed DevBridge GitHub source for first-byte/exact-source acquisition.

Git is not required for zero-state bootstrap or permanent-entry component acquisition. The already-present direct `install-devbridge.mjs` qualification path retains a managed Git compatibility route, and downstream repository/runtime operations may have their own Git requirements, but those are not assumptions of the blank-host bootstrap.

After permanent entry commits, `devbridge setup` discovers later prerequisites before use. Every discovered prerequisite remains setup-owned until its narrow adapter either establishes and verifies it or returns a focused blocker proving a genuine external-authority boundary. Setup must not turn an implementation gap into instructions for the operator to install an ordinary dependency manually.

Current behavior includes:

- GitHub authentication is required for the current repository-discovery path and may come from `GH_TOKEN`/`GITHUB_TOKEN` or an authenticated GitHub CLI;
- `gpgv`/`gpgv.exe` must be usable before Ubuntu release-signature verification is attempted;
- on Windows, an already-usable signature verifier is reused without mutation; when absent and setup is already elevated, the owning prerequisite adapter fetches only the exact runtime-pinned official GnuPG 2.5.21 Windows installer through bounded Node networking, verifies its pinned SHA-256, runs the Nullsoft silent installation, removes the transient installer, re-discovers `gpgv.exe` from the refreshed system/user PATH or the package-owned `GnuPG\bin` location under Program Files, and executes it before claiming readiness;
- the exact verifier executable is a local-only binding carried directly into Ubuntu release verification so the same invocation can continue even when the current process cannot see a newly persisted PATH; the path is not projected through remote `setup.status`;
- a non-elevated missing Windows verifier stops before download/mutation at the elevation boundary; package digest disagreement, network/integrity failure, installer failure, or unusable post-install verification is a focused resumable blocker rather than a manual-install instruction;
- on Windows, missing OpenSSH Client may be established through the exact `OpenSSH.Client~~~~0.0.1.0` Windows capability only when the current setup process is already elevated and Windows reports the capability as `NotPresent`; setup re-verifies `ssh.exe` and `ssh-keygen.exe` afterward;
- non-elevated OpenSSH repair, restart/pending servicing, servicing policy/source failures, or inconsistent capability state are focused resumable blockers;
- Hyper-V/provider/image readiness remains independently inspected by the read-only physical canary status/preflight owner. Setup does not silently enable Hyper-V or restart the host.

Stage-2 host-foundation requirements are provider-specific when those capabilities are expected to be ready:

- Windows requires a usable Hyper-V configuration and DevBridge management authority.
- Linux requires usable KVM acceleration plus the QEMU/libvirt management path, normally a locally authorized `qemu:///system` provider.

Setup must not infer VM readiness merely from Hyper-V being installed, `/dev/kvm` existing, `virsh` being present, or a VM/domain name existing.

## Fresh install target

A normal user should need one bootstrap command, not a sequence that first creates an example JSON file and then asks the user to read/edit it.

The supported setup path observes physical production-image state by default and crosses construction only with explicit `--construct` authority. It can continue through selected-profile declaration and protected environment activation only after every selected image is exact and complete. Real provider qualification remains separately required before the broader fresh-install target can be claimed complete.

The setup invocation is responsible for:

1. establishing and verifying the trusted Stage-0 launcher and accepted managed runtime;
2. creating DevBridge-owned state/configuration internally;
3. discovering the host, authentication, repositories, provider capabilities, storage, networking, tools, elevation/reboot state, and existing DevBridge-owned resources;
4. reconciling setup-owned prerequisites through narrow adapters and prompting only at genuine external-authority blockers;
5. applying reasonable defaults and using prompts only at genuine blockers;
6. establishing exact image/source authority from trusted local/runtime-owned policy rather than user-authored plumbing;
7. performing read-only provider/image preflight before mutation;
8. constructing, qualifying, publishing/reacquiring, or reconstructing the required immutable base image through the owning image contracts;
9. creating the required execution-profile VM/environment and repository workspaces;
10. verifying guest/bootstrap/tooling/network/bridge/workspace readiness;
11. enabling only the capabilities covered by the operator's local setup consent and verified readiness;
12. installing the permanent `devbridge` command on PATH;
13. ending with a clear success/welcome handoff.

Internal helper programs, canary entrypoints, transient configuration files, authority records, package snapshots, signing keyrings, and provider object identities are implementation details. They may exist internally but are not prerequisites the operator must create or understand.

## Configuration authority

Configuration remains local machine authority under DB-003. The default user workflow, however, is setup/re-entry rather than hand-editing JSON.

The canonical checked-in example remains useful for development, testing, advanced declarative automation, and schema reference:

```text
config/devbridge.example.json
```

It is **not** a required reading assignment or hand-authored prerequisite for normal installation.

Fresh configuration keeps model adapters, coordination, dynamic tool onboarding, and automatic task-branch publication conservative/off unless the setup command's explicit local options enable them. Existing operator configuration is never silently rewritten during self-update.

After the selected persistent environment and every selected workspace route verify ready, the explicit local `devbridge setup` transaction publishes the normal multi-repository configuration and enables deterministic controller-plan execution. It keeps coding-model adapters, uncontained host execution, dynamic onboarding, coordination, and automatic publication disabled. Publication is digest-bound and restart-reconcilable: setup records the exact predecessor and target before replacement, verifies the normal configuration schema and exact bytes afterward, and refuses an unmanaged or externally changed config instead of overwriting it. Re-entered setup may update only an unchanged setup-owned generation.

`workspace.externalReadRoots`, proposal profile `sandbox.*`, and `execution.allowUncontainedTools` are host-sandbox-era surface. Stage 1 removes their ability to authorize repository-code host execution. Stage 8 defines deliberate operator-facing migration/deprecation, and Stage 9 removes remaining compatibility where appropriate.

`execution.allowUncontainedTools` or equivalent must never bypass the no-provider state.

## Execution remains opt-in and provider-bound

Execution authority must be granted locally. A first-run `setup` invocation may carry that explicit local consent as a bounded command option so the installer does not need to stop later merely to ask the same question again.

For the default CPU profile, the explicit local setup invocation itself is the execution opt-in, but activation occurs only after provider, image, environment, bridge, and workspace-route readiness all verify. This opt-in does not enable a coding model: model adapters remain separately disabled until explicitly configured.

Remote task text cannot enable execution.

Stage 6 VM-backed execution requires observed provider + image + compatible execution-profile environment + bridge + repository workspace-route readiness. If any are missing, execution remains unavailable; it never redirects to direct host execution. A legacy repository-owned VM record is not silently adopted as the physical profile environment.

## GitHub authentication

GitHub credentials are host control-plane authority under DB-003/DB-008.

DevBridge may use configured environment-variable providers or the current GitHub CLI credential for the configured hostname. Token values are not serialized into config/status/run state and are not forwarded to repository execution.

Under DB-020 repository guests normally have network access, so host GitHub/SSH/publication credentials must remain absent from the guest. Private dependency/coding-service support requires explicit later scoped mechanisms rather than copying the host token into a persistent VM.

If no usable GitHub authentication exists, setup may stop for the focused authentication action and then resume. It should never ask the user to type an account name that the authenticated credential can identify itself.

## Persistent VM setup target

Setup/reconfiguration follows discover-before-prompt and treats execution profiles as the VM provisioning unit.

### Windows host discovery

Discover where safe:

- Hyper-V feature/provider availability;
- management privilege/readiness;
- DevBridge-owned base image inventory;
- execution-profile VM/differencing-disk state;
- legacy repository-owned VM state as migration candidates;
- repository workspace-route state;
- provider networking and bridge readiness;
- approved/available Windows source-media options without treating discovery as license authority;
- configured activation-authority status without exposing secret material;
- configured image recovery/distribution policy;
- installed image-construction utilities and free-space requirements.

### Linux host discovery

Discover where safe:

- KVM acceleration availability/usability;
- QEMU/libvirt installation/service/provider readiness;
- access to the selected libvirt system provider (normally `qemu:///system` when local policy uses it);
- DevBridge-owned base image/qcow2 overlay inventory;
- execution-profile domain/storage state;
- legacy repository-owned domain/overlay state as migration candidates;
- repository workspace-route state;
- libvirt network and bridge readiness;
- approved/available OS image source and artifact-recovery state;
- installed image-construction/conversion utilities and free-space requirements.

### Common setup flow

1. discover host/provider/GitHub/account/repository facts before prompting;
2. apply the supported ordinary Linux profile by default unless the operator explicitly requests another profile or local facts make that default invalid;
3. apply the repository default rule above (all when at most 30 eligible; ask when 31+);
4. group selected repositories by compatible execution profile and report repository/workspace counts separately from physical profile-environment counts;
5. determine and reconcile setup-owned prerequisites and exact local changes through their owning adapters, using initial setup consent where sufficient and stopping only at genuine authentication/elevation/reboot/licensing/ownership/policy/integrity boundaries;
6. establish exact approved image construction authority for each required profile internally;
7. for Windows, separately establish activation method or explicit `configure later` and separately establish whether prepared Windows bytes may be stored in the selected recovery source;
8. when GitHub Releases are selected for image recovery, derive the authenticated owner and propose a private `<authenticated-owner>/devbridge-base-images` source or another authorized repository; verify repository/Release capability before mutation;
9. construct and functionally qualify the canonical image from approved source authority;
10. package remote artifacts only through #178's complete-image zstd -> 1 GiB transport-object contract;
11. redownload/reconstruct/verify remote artifacts through the real acquisition path before accepting them;
12. create the required execution-profile environment from the exact approved image subject;
13. apply/verify Windows activation after materialization through the separate protected activation authority when required;
14. verify provider/image/profile-environment/activation/bridge/workspace-route readiness separately;
15. enable authority-bearing execution only when covered by explicit local setup consent and all required readiness gates are satisfied;
16. persist the stable `devbridge` PATH command and verify it resolves;
17. emit the successful operator handoff;
18. allow `devbridge setup` re-entry later to add Windows, change source/activation/artifact policy, add/remove repositories, change profiles/resources, credentials, image/recovery policy, or repair/reset/reseed environments/workspaces.

Selecting `all` repositories means approve/register all selected repository workspaces. It does **not** mean create/start one VM per repository.

Do not blindly prompt for repository names, local paths, provider object names, provider details, GitHub usernames, snapshots, package versions, keyrings, payload generations, or ordinary dependency installation that can be safely discovered/derived/reconciled and verified. Do not auto-enable discovered capabilities merely because they exist; initial command-line consent and subsequent setup approvals remain local authority.

VM/profile readiness failure must degrade/fail closed; setup never recreates the removed host repository-execution path. Resource admission failures must be reported as profile-level resource problems rather than repository failures.

## Successful completion and welcome handoff

Setup is not complete merely because internal state was written or an image build returned success. Before printing success, DevBridge must verify the selected installation is operational to the degree promised by the setup mode.

A successful first-run setup ends with a concise human-readable welcome message containing at least:

- an unambiguous **setup completed successfully / welcome to DevBridge** statement;
- selected execution-profile readiness;
- configured repository/workspace count and physical profile-environment count;
- whether DevBridge is running / ready for work;
- any non-blocking deferred capability, such as Windows activation configured-later;
- how to start normal use;
- how to check status/health;
- how to re-enter setup to change repositories, profiles, resources, credentials, image/recovery policy, or repair/rebuild owned environments;
- any requirement to open a new shell before the newly persisted PATH is visible.

Normal post-install guidance should be short and command-oriented, for example:

```text
Welcome to DevBridge — setup completed successfully.

Linux execution profile: ready
Repositories: 12 configured
Execution environments: 1 ready
DevBridge: ready

Start / continue using DevBridge:
  devbridge

Check health:
  devbridge status
  devbridge doctor

Change this installation later:
  devbridge setup
```

The exact prose may evolve, but successful setup must end with an operator handoff, not raw JSON, an internal subject identifier, or instructions to read source documentation before proceeding.

## Windows media, distribution, and activation are separate

A Windows base image must be generalized and contain no user's activation secret. Image identity is derived from the canonical image/profile/generation, not from a product key or activation method.

Setup treats these independently:

- **source/construction authority** — the approved official Microsoft source media and versioned recipe;
- **distribution authority** — whether/where prepared Windows bytes may be stored;
- **activation authority** — retail/MAK/KMS/AD/subscription/configure-later policy applied to the materialized VM;
- **environment declaration** — exact Windows image/profile/bootstrap/resource selection.

Never infer that the host's OEM/digital activation is reusable in a VM. Never serialize a product key/MAK secret into normal config, Git/GitHub, logs, status, evidence, exported templates, or a generalized image.

Private artifact hosting is not proof of Microsoft redistribution rights. If the selected source/license permits prepared-image storage, the exact generalized image may use #178 remote-artifact recovery. If not, setup preserves an approved local reconstruction/regeneration path. A locally regenerated Windows VHDX may satisfy the current image subject only when exact canonical size/SHA-256 reproduction is proven. A different but otherwise qualified canonical digest is a new immutable image subject/generation and requires an explicit local declaration rebind/migration before `create`/`rebuild` can consume it. Never ignore or normalize away a digest mismatch.

Windows Evaluation media is an explicit temporary evaluation path only; it is not silently substituted for a durable production image.

## Provider-owned versus operator-owned infrastructure

DevBridge setup must distinguish its own VM artifacts from shared operator infrastructure.

Windows uninstall/repair must not casually disable Hyper-V or delete operator-owned virtual switches/VMs/disks.

Windows currently permits only one internal WinNAT network. Setup discovers a blocking translation before elevation and reports an opaque consent subject. It does not remove the translation automatically or accept its name from the caller. When the operator elects to retire that exact inactive subject, re-enter setup with `--retire-conflict <subject>`. The existing one-shot elevated setup child re-enumerates the subject, requires zero static mappings, active sessions, and guest attachments, removes only the unchanged translation, preserves its switch, and then continues normal protected-network reconciliation. Changed, ambiguous, active, attached, or unobservable state fails closed. The consent is deleted after successful environment activation.

Linux uninstall/repair must not casually remove KVM/QEMU/libvirt packages, stop shared libvirt infrastructure, delete operator-owned domains/storage pools/networks/images, or rewrite system virtualization policy when a DevBridge-owned object suffices.

Legacy repository-owned DevBridge VMs are retained as migration candidates until their replacement workspace is proven or the operator explicitly authorizes retirement. Multiple old writable VM disks must not be blindly merged into one shared profile disk.

Remote image repositories/releases and operator Windows licensing authority are also operator-owned state. Uninstall must not delete remote artifacts or revoke/remove licensing infrastructure by default.

## Runtime updates

Stage 0 establishes only the fixed managed checkout needed to reach the secure supervisor.

DB-011 owns update policy, signed production release subjects, exact runtime artifact identity, candidate validation, daemon drain, activation health, and rollback.

Stage 1 removed the former host candidate execution path. Stage 6 restores candidate preflight/tests through one locally admitted VM validation route while release identity/last-known-good/rollback remain intact. Route or environment absence fails closed before activation.

VM validation attaches through:

- Hyper-V on Windows;
- KVM/QEMU/libvirt on Linux.

## Operator control

Canonical commands include:

```text
devbridge
devbridge setup
devbridge doctor
devbridge poll-once
devbridge run-once
devbridge daemon
devbridge status
devbridge pause
devbridge resume
devbridge stop
devbridge restart
devbridge handoff-status
devbridge handoff-seed
devbridge handoff-project
```

`devbridge setup` is the supported re-entry point for changing installation-owned configuration and recovering/repairing the setup state. Manual JSON editing is not the normal recovery workflow.

`pause` is cooperative task-admission pause at a safe cycle boundary, not an unsafe process/VM freeze. `stop` takes precedence.

Future VM lifecycle commands/setup surfaces preserve persistent profile VM state and unrelated repository workspace state unless an exact reset/reseed/delete action is authorized for that profile or workspace.

## Troubleshooting principle

`doctor` reports observed capabilities, not aspirations.

- Pre-Stage-1 historical main: Bubblewrap verification existed for supported Linux repository execution and Windows failed closed.
- Stage 1 through Stage 5 history: repository execution was unavailable/no-provider while trusted control-plane functions could remain usable.
- VM transition: do not interpret partial Hyper-V, KVM, libvirt, image, VM/domain, profile, workspace-route, bridge, source-media, artifact-recovery, or Windows-activation state as completed DB-020 support.
- After Stage 7/8/#192: expect exact provider/image/source/profile-environment/activation/workspace/bridge readiness evidence and no host fallback.

See `docs/execution-profile-environments.md` for VM/workspace ownership, `docs/fresh-host-image-provisioning.md` for blank-slate image/licensing setup, `docs/image-artifact-recovery.md` for immutable artifact recovery, `docs/roadmap.md` for staging, `docs/vm-lego-studs.md` for replaceability, and `docs/vm-migration.md` for removal/retention details.
