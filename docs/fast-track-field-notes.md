# Fast-track field notes

Status: living operational record for the disposable `codex/temp-fast-functional` branch.

This document records what the fast track does, why it does it, what it reveals about the production VM-only architecture, and what must be solved before equivalent behavior belongs on `main`.

The fast track is diagnostic scaffolding, not a design precedent. Its direct-host implementation is disabled and must never be merged into the VM-only production path.

## How to use this record

Treat each entry as evidence of a **problem the product must solve**, not as a recommendation to copy the fast-track solution. A production implementation may and often should use a different mechanism.

Every continuing entry should preserve:

1. the obstacle observed on a real workstation;
2. the user-visible or operational impact;
3. the component or authority boundary that owns the problem;
4. exact reproduction/observation evidence;
5. the temporary fast-track workaround, if any;
6. the acceptance behavior `main` must eventually prove, independent of implementation choice.

## Working rules

- Keep the disposable direct-host implementation disabled now that VM execution is usable. It is not a fallback and leaves with this branch.
- Keep the VM path first-class; a working direct-host path is not VM readiness evidence.
- Record every shortcut together with the production requirement it exposes.
- Keep Codex opt-in only. A remote task must request the configured adapter explicitly, or an operator must deliberately configure a default. There is no automatic coding-model fallback.
- Leave foreign VMs, switches, disks, and developer worktrees untouched unless separately and exactly authorized.
- Keep authoritative Git, GitHub credentials, coordination state, and publication authority on the host.

## Field log

### Disposable branch and repository hygiene

What happened:

- Merged stage branches were removed locally and remotely after their work was present on `main`.
- `codex/temp-fast-functional` was created from `main` as the disposable fast-track branch.
- An obsolete OneDrive-backed worktree directory remained locked by Windows even after Git stopped treating it as an active worktree.

Why:

- The fast implementation must be easy to delete without contaminating production history.
- Removing merged branches reduces ambiguity about which branch owns current work.

Main-branch requirement exposed:

- Setup and cleanup need Windows/OneDrive-aware diagnostics and bounded retry/re-entry behavior. Git metadata cleanup must not imply that an OS-locked directory was physically removed.

### Direct host execution mode

What happened:

- The fast branch gained an explicit `execution.fastHost` mode and a separate `config/devbridge.fast.json` configuration.
- Controller-submitted file changes and locally registered deterministic operations can run directly in the managed host worktree.
- The ordinary VM composition remains available when `fastHost` is disabled.
- Real VM execution is now selected with `execution.fastVmDefaultSwitch: true`; `execution.fastHost` is `false`, and configuration rejects enabling both topologies.

Why:

- Stages 2–6 supplied the VM contracts, but this workstation had no prepared base image, owned network, persistent repository environment, guest helpers, or execution route. The temporary path made the queue usable without claiming VM readiness.

Main-branch requirement exposed:

- Direct host repository execution must not move to `main` or become a fallback. Stage 8 must make the existing VM-only path installable and re-enterable, and Stage 7 must prove real provider behavior before production readiness is claimed.
- No-provider, misconfigured-provider, and failed-VM cases must remain unavailable rather than selecting the retained disposable host implementation.

### Coding-model adapter policy

What happened:

- A `codex-fast` profile is present for explicit use.
- `execution.defaultTool` remains `null`.
- An unknown explicit preferred tool fails instead of silently selecting another adapter.
- Tool inventory now reports a usable adapter as eligible for automatic selection only when its exact name is the operator-configured `execution.defaultTool`. With the fast configuration's `null` default, `codex-fast` is available and usable but reports `eligibleForAutomaticSelection: false`.
- The installed Codex CLI required `--ignore-user-config --model gpt-5.5` because the user's newer default model configuration was incompatible with that CLI build.

Why:

- The remote controller is expected to author the work. DevBridge owns materialization, deterministic compilation/testing, evidence, and publication. A local coding model is an opt-in proposal surface, not a default recovery mechanism.

Main-branch requirement exposed:

- Adapter setup needs compatibility discovery and actionable diagnostics without changing the no-default policy. Local CLI configuration drift must not silently change remote task behavior.

### Windows bridge-agent durability race

What happened:

- Repeated full-suite testing exposed concurrent first-write and atomic-replacement races in the guest bridge journal on Windows.
- The fast branch now uses exclusive initial record creation, bounded retry for transient Windows file replacement errors, improved monitor failure persistence, and more reliable process liveness handling.

Why:

- The bridge must not duplicate side effects or report false completion when Windows temporarily denies a rename or process query.

Main-branch requirement exposed:

- These are generic durability corrections, not a fast-host shortcut. They require review and a separately published isolated change before inclusion on `main`.

### Hyper-V management permission

Observed state:

- Hyper-V services were running, but `Get-VMHost` initially failed because the interactive account lacked an enabled management authorization token.
- The operator added `WDRFJK6T\josho` to `Hyper-V Administrators` and rebooted.
- After reboot, `Get-VMHost` succeeded and reported 16 logical processors and approximately 32 GiB of host memory.

Why the manual step was needed:

- Hyper-V feature presence and running services do not prove that the DevBridge account can manage the provider.

Main-branch requirement exposed:

- Stage 8 setup must discover feature, service, and account authorization separately; propose the least-privilege group change; request elevation explicitly; checkpoint before sign-out/reboot; and verify management access after re-entry. It must not silently alter groups or reboot.

### Existing provider objects

Observed state:

- The host has the Hyper-V `Default Switch`.
- No `NetNat` object is currently present.
- Three existing VMs are present and stopped: `arena-windows-11`, `cuda-js-linux`, and `Windows 11 dev environment`.

Why this matters:

- Existing VMs and the default switch are foreign objects. Their existence is not DevBridge ownership evidence and they must not be adopted, modified, or deleted.

Main-branch requirement exposed:

- Setup discovery must display foreign-object conflicts separately from DevBridge-owned state and create only identity-marked objects through the existing provider adapters.

### Base-image acquisition

Observed state:

- DevBridge has no published base image on this workstation.
- Canonical's current Ubuntu Azure VHD artifact is explicitly documented as Azure-specific and unsuitable for on-premises Hyper-V.
- The ordinary Ubuntu cloud `.img` is QCOW and therefore not directly usable by the Hyper-V VHD/VHDX adapter.
- A clean Hyper-V base must consequently be built from supported installation media or through a deliberately qualified conversion pipeline.

Why:

- Stage 2 intentionally implements import and verification, not vendor-specific acquisition/licensing/setup.

Main-branch requirement exposed:

- Stage 8 needs source-specific image acquisition/build adapters with checksum/signature verification, license/consent handling, immutable generation identity, guest-helper installation, and restartable progress. It must not guess that a file extension implies a compatible image.

### Unattended installer seed media

Observed state:

- The workstation has no `oscdimg`, `genisoimage`, `mkisofs`, or Packer installation.
- Ubuntu's supported NoCloud autoinstall input requires a volume labeled `CIDATA` containing exact `user-data` and `meta-data` files.
- Supplying a valid cloud-config seed without the `autoinstall` kernel argument still stops at an interactive confirmation prompt.
- The first draft also exposed an ordering boundary: installer `late-commands` run before first-boot cloud-init creates the configured operator account, so account-owned state cannot be assigned safely until first boot.

Fast-track workaround:

- Generate the bounded seed files from a repository script, create the small ISO with Windows IMAPI, and perform user-dependent ownership during first-boot cloud-init.
- Derive a checksum-addressed Ubuntu installer by making fixed-length updates to the two GRUB boot entries and the media's corresponding MD5 manifest entry. Both entries now carry the documented `autoinstall` argument and boot without a menu delay. The unmodified Canonical ISO remains separately preserved and verified.

Exact artifacts:

- Canonical ISO: `ubuntu-24.04.4-live-server-amd64.iso`, SHA-256 `e907d92eeec9df64163a7e454cbc8d7755e8ddc7ed42f99dbc80c40f1a138433`.
- NoCloud seed: `cidata.iso`, volume label `CIDATA`, SHA-256 `8a3e96c80db4d757dbbf0de8c06288922bc83419273ec8c0fe1ad6971e07536c`.
- Derived unattended ISO: `ubuntu-24.04.4-live-server-amd64-autoinstall.iso`, SHA-256 `4e763f3a946c6cc55a91d5a557627d24d3c8d68eeb0459c12b53876ce3ad5594`.
- `new-ubuntu-builder.ps1` starts the VM without VMConnect. A console is not part of normal installation; the only interactive prompt encountered came from booting the original ISO before the derived media existed.
- A fresh owned probe VM, `devbridge-fast-unattended-probe-ubuntu-2404`, booted from the derived installer plus seed, installed without VMConnect or desktop control, and powered itself off after approximately five minutes. Its first disk boot then passed headless checks for Node.js `v24.19.0`, npm `11.17.0`, Git `2.43.0`, CMake `3.28.3`, GCC `13.3.0`, all three guest helpers, the enabled network-seed service, and active Hyper-V file-copy integration.

Main-branch requirement exposed:

- Stage 8 needs an owned, checksumable seed-media builder with schema validation, explicit installer-versus-first-boot phases, and a no-prompt boot contract. Setup must detect or supply this prerequisite instead of assuming external ISO authoring tools exist or asking the operator to babysit a VM console.
- The disposable probe supplies end-to-end evidence that the current derived media boots and installs without a firmware, menu, or installer prompt. Production still needs repeatable artifact construction and qualification rather than treating one local probe as release evidence.

### Hyper-V networking

Observed state:

- Microsoft documents that WinNAT uses an internal switch and does not provide DHCP to ordinary VMs.
- Microsoft also documents a practical one-NAT limitation on Windows client hosts.
- Stage 5 therefore prepares a deterministic static network seed and requires the Linux `hv_fcopy_daemon`/Guest Service Interface for host-to-guest delivery.
- The first real `ensureNetwork` call exposed a PowerShell numeric-boundary bug before any provider object was created: the hexadecimal `0xffffffff` literal became signed `-1`, then failed conversion to `UInt64` while comparing route prefixes.
- After that correction, Hyper-V emitted first-use/progress CLIXML large enough to displace the actionable provider failure from the adapter's bounded error report while reconciling the newly created owned switch.
- Membership in `Hyper-V Administrators` is sufficient for VM/switch management but not for `New-NetIPAddress` or `New-NetNat`; Windows returned access denied because host TCP/IP and NAT mutation require an elevated administrator token.

Fast-track workaround:

- Keep the incomplete owned-NAT plan for later reconciliation, attach the exact owned disposable VM to Hyper-V's existing `Default Switch`, and use its DHCP/NAT service. `execution.fastVmDefaultSwitch` selects this path explicitly and is mutually exclusive with direct-host fast execution; neither is an automatic fallback.

Why:

- A booted VM without a correct address, route, DNS, and HTTPS observation is not a usable development environment.

Main-branch requirement exposed:

- Setup must detect NAT conflicts before mutation, create only the owned network through the provider adapter, install/verify the guest file-copy service, and validate actual DNS/HTTPS connectivity after applying the exact seed.
- Provider prefix arithmetic must use explicit unsigned-safe constants and must be exercised against a real PowerShell/Windows route table, not inferred from adapter mocks alone.
- Provider command wrappers must suppress progress streams and preserve the useful end of bounded errors; setup cannot ask an operator to diagnose serialized progress noise.
- Stage 8 must split ordinary Hyper-V management from elevated host-network setup, request UAC only for the bounded prerequisite mutation, preserve restart/re-entry state, and verify the resulting owned switch, gateway, and NAT after elevation.

### First SSH host-key enrollment

Observed state:

- A Linux execution route requires a pinned `knownHostsFile` before the bootstrap bridge will connect.
- A newly cloned environment normally generates a unique SSH host key only after its first boot.
- Stage 5 can allocate and copy the static network seed before SSH is healthy, but it has no trusted return channel that enrolls the newly generated public host key into host-owned route policy.
- The clean unattended probe generated a unique ED25519 host key, fingerprint `SHA256:1uaThAa90R79VYzdJ2TWER/WNT1w18fnreW4JSDFExA`, proving that the installer is not forced to reuse the retained disposable base identity.

Fast-track workaround:

- Use one disposable base/environment, retain its installer-generated host identity, observe its DHCP address through the exact owned Hyper-V adapter, and use a wildcard hostname with that pinned key so a DHCP renewal does not break the fast route. This is expedient evidence only; it must not become a multi-environment production pattern.
- For the clearly owned disposable probe only, observe its exact Hyper-V-reported DHCP address, perform non-interactive SSH trust-on-first-use into a probe-only known-hosts file, and immediately require strict checking against that pinned record. This proves unattended operation, not authenticated enrollment.

Main-branch requirement exposed:

- Stage 8 needs a deliberate first-trust ceremony or authenticated guest-enrollment channel that binds a unique guest host key to the exact owned environment identity. Blind `ssh-keyscan` trust-on-first-use and shared cloned host private keys are not sufficient production solutions.

### Published image and persistent repository environment

What happened:

- The Ubuntu builder was verified with Node.js `v24.19.0`, npm `11.17.0`, Git `2.43.0`, CMake/CTest `3.28.3`, GCC/G++ `13.3.0`, OpenSSH, `hv-fcopy-daemon`, the network-seed service, and all three fixed guest helpers.
- Generalization cleared the machine ID but deliberately retained the builder's SSH host keys as a disposable single-environment shortcut.
- Builder VHDX SHA-256: `8556390b568cf68017b3eec8a4c6f81129a84e0aeb981a41020560165fffa556`.
- The Stage 2 image library published `img-5b9a64425927520270f743c8090f0171`, profile `linux-development`, generation `ubuntu-24.04.4-node-24.19.0-fast-v1`, with a 50 GiB VHDX and no parent identity.
- The Stage 3 provider created environment `env-30a71598122748772076a2bc564e18b9` for immutable repository subject `1337742670`; Hyper-V identity is `db-env-427d5b2272aef2d0`, backed by an owned differencing disk.
- First-boot cloud-init reports itself disabled after installation. The required services and tools are present, but that state prevents treating future cloud-init runs as a repair/reconfiguration mechanism.

Main-branch requirement exposed:

- Stage 8 must make image acquisition, guest bootstrap, generalization, publication, environment creation, and repair restartable steps with durable state and exact artifact identities.
- Production images must generate unique per-environment host identity and provide an authenticated enrollment return path.
- Setup must define whether cloud-init is one-shot image construction or a supported environment repair mechanism, then test that lifecycle explicitly.

### Headless VM lifecycle

What happened:

- Normal build and repository execution use Hyper-V PowerShell plus the guest bridge; they do not launch VMConnect or capture the desktop.
- The active repository VM is intentionally left `Running` during a work session because that is faster than any resume path.
- The fast topology now resumes `Saved` VMs with `Start-VM` and `Paused` VMs with `Resume-VM` without opening a console.
- `scripts/fast-vm/manage-environment.ps1` validates the exact provider record, VM UUID, and ownership marker before `Status`, `Save`, `Resume`, or explicit `Show`. Only `Show` launches VMConnect.
- The exact repository environment successfully transitioned `Running -> Saved -> Running` through `Save` and `Resume`. A subsequent headless Stage 6 smoke completed in `23.145` seconds and passed 12/12 VM-hosted tests, proving bridge and repository execution recover after saved-state resume.

Why:

- Hyper-V documents `Save-VM` as analogous to hibernation and `Suspend-VM` as pause/resume. Saved state is useful for longer idle periods; pause retains host memory pressure and is not durable across host interruption.
- Hyper-V checkpoints are disk/configuration history, not a sleep mechanism, and would complicate the owned differencing-disk lineage.

Main-branch requirement exposed:

- Add an explicit idle policy owned by the runtime supervisor: keep running for a bounded hot interval, save after longer inactivity, resume on admission, and power off only for maintenance/recovery policy.
- Lifecycle state changes must be fenced against active sessions, observed after mutation, and never apply to foreign VMs.
- Console display must remain an operator-requested diagnostic action, never an automatic runtime side effect.

### Repository source synchronization and cache identity

Observed performance:

- The first 320-part source synchronization took approximately 16–17 minutes because each small part required an individual bridge round trip.
- A later positional-cache resync took `611.253` seconds after newly added files shifted most `part-<entry>-<chunk>` names, even though most bytes were unchanged.
- An unchanged warm two-operation smoke took `60.539` seconds; the tests themselves took about 61 ms.
- After reindexing 322 already-verified guest blobs and switching to content-addressed part names, a changed-source smoke took `91.079` seconds and passed. Only newly changed content hashes needed transfer.
- After persistent bridge transport was enabled, a changed-source two-operation smoke took `22.355` seconds and the immediate unchanged run took `21.077` seconds. Both passed the same 12 VM-hosted tests.

Cause:

- Source part names encoded sorted manifest position rather than content identity. Adding a file changed downstream positions, so the guest could not prove that its existing cache contained equivalent bytes.
- The host also sent every part whenever the whole-tree digest changed; the guest had no neutral missing-part inventory response.

Fast-track solution:

- File-tree protocol `1.1.0` names each part `part-<sha256>` and requires the name to match the declared digest.
- The host sends the bounded manifest first. The guest resets its local baseline, validates cached part shape and hash, and reports a de-duplicated list of missing content names.
- The host rejects unknown/duplicate guest requests, sends only admitted missing parts once, and still requires the guest apply step to verify every part and whole-file digest.
- Existing index-named cache blobs were reindexed once inside the disposable guest after validating the old manifest, size, and SHA-256. This did not change authoritative host source or acceptance behavior.

Main-branch requirement exposed:

- Content identity belongs in the generic transfer protocol, not in provider code. Stage 7 must test unchanged, modified, inserted, deleted, duplicate-content, corrupt-cache, forged-inventory, cancellation, and restart cases.
- Add bounded cache garbage collection for unreachable blobs. Do not retain an open-ended compatibility parser for positional names.
- Transfer batching or a streaming archive may outperform one request per small blob and should be evaluated without weakening path/digest checks.

### Bridge round-trip overhead

Observed state:

- Keeping the VM running removes boot time, but an unchanged two-operation smoke still takes about 60 seconds.
- The production Hyper-V Linux attachment verifies VM ownership/state with a fresh PowerShell process, creates a fresh SSH connection, and starts a fresh guest Node process for every bridge frame.
- Repository preparation, put/get, execute, observe, and collect generate many small frames, so handshake/process startup dominates actual test time.

Validated fast-track solution:

- The guest agent now has a bounded newline-delimited exchange mode that dispatches the same validated frames sequentially.
- A fast-only, provider-neutral channel opens one pinned, non-interactive SSH process per exact target and carries ordered frames over it. The topology performs the exact owned-VM check before the session is created; guest target binding, host-key pinning, frame validation, durable request IDs, and response validation remain active.
- The channel never opens a console, uses no agent/X11/port forwarding, and does not retry ambiguous frames automatically.
- Because the immutable image contains the earlier one-shot helper, each fast runtime first stages the current trusted helper through that existing bridge into the bounded guest `input/control` area. The persistent session then executes that exact staged file; it does not overwrite the image or retain a compatibility parser.
- Local ordered-stream/concurrent-first-connect tests pass, and two real headless VM smokes passed in `22.355` and `21.077` seconds respectively, compared with the earlier unchanged `60.539`-second path.

Main-branch requirement exposed:

- Stage 7 should qualify a persistent authenticated bridge transport as a first-class provider connection stud, including reconnect/reconcile, liveness, bounded buffering, cancellation, hostile response, target mismatch, lease loss, VM save/resume, and daemon restart behavior.
- Ownership/provider observation should be cached only against exact identity and a short validity window, with forced re-observation at security-sensitive boundaries. Avoid a PowerShell/import/SSH handshake tax per 16 KiB frame.

### Multiple repository polling and isolated UCI Arena environment

Observed problem:

- The original application composition owned one queue repository, one set of issue-number-keyed results, and one repository route. Pointing the same daemon at another project would either require a second process or risk state/identity collisions.
- The authenticated GitHub token can observe more repositories than this workstation should automatically execute. Treating token visibility as task-author, VM, or publication authority would collapse several control-plane boundaries.
- A single-route fast provisioning script would reject a second repository because replacing the route policy would discard the first repository's local authority.
- The initial VM smoke assumed a root `package.json`, which was DevBridge-specific and failed against UCI Arena's mixed CMake/Python/Node layout even though VM execution itself was working.

Fast-track solution and evidence:

- Public configuration is plural-only: `github.queueRepositories` plus bounded `github.repositoryDiscovery`. No singular compatibility key was retained.
- One shared GitHub session owns authentication, conditional validators, request serialization, and the account-wide rate budget. A bounded catalog selects configured repositories and, only when enabled, repositories returned by GitHub's authenticated-user endpoint that also pass local owner and active-issues filters.
- A repository-set coordinator creates one otherwise ordinary isolated runtime per selected queue and cycles them serially. Result, rejection, projection, and error records carry the queue repository. A queue-local failure does not suppress later queues; a shared rate-limit failure stops globally.
- The live token discovery check found 15 allowed-owner repositories with no pagination truncation. Discovery remains disabled in `config/devbridge.fast.json`; the fast configuration explicitly selects only `iteathen/DevBridge` and `iteathen/UCI_Arena`. This avoids polling or implying readiness for 13 repositories without local VM routes.
- The provisioning helper now validates and atomically extends the existing route policy under an exclusive setup lock. It preserves the DevBridge route and its sole validation role, rejects a conflicting subject/profile, and appends UCI Arena without adopting any existing foreign VM.
- UCI Arena immutable repository ID `1297121161` is routed to persistent environment `env-ae635988b113ca9e8d64eada003d7f18`, Hyper-V VM `db-env-f78d539a495cb04b`, provider UUID `bc83e95f-caec-4698-9ef3-fda4945adc0e`, and the same published base generation used by the first environment. The VM has its own owned differencing disk and provider record.
- A managed host clone resolved exact `origin/main` commit `b8cc97a7b81b3a2ffe3d9f6b8135cd684d155934`. The generalized smoke used a neutral explicit source marker instead of assuming a package manager, synchronized the exact repository source through the UCI route, observed Linux/x64 and Node.js `v24.19.0`, and passed 4/4 `@uci-arena/time-profile-contract` tests. The warm rerun took `29.119` seconds and returned evidence bound to `iteathen/UCI_Arena`, repository ID `1297121161`, and run `fast-vm-smoke`.
- `npm run fast:doctor` reported both configured queues and ready repository execution. A live `poll-once` and `npm run fast:run` each selected both queues, returned no queue-local errors/rejections, and kept `codex-fast` ineligible for automatic selection.
- The repository-wide suite after multi-queue work passed: 513 total, 507 passed, 6 Windows capability skips, 0 failed.

Main-branch requirements exposed:

- Repository discovery needs a supported operator UX that previews additions and separately provisions/admits exact repository environments; discovery must never create authority by itself.
- Per-repository runtime construction should stay replaceable and isolated, but repeated global inventory/foundation work should be shared only where the owning contract proves it is repository-neutral.
- Stage 8 provisioning must support idempotent append/remove/reconfigure operations with durable intent, exact route-policy CAS/reconciliation, per-repository progress, and safe recovery after environment creation succeeds but route admission or health verification fails.
- The disposable base currently clones one SSH host private identity into both repository VMs and both routes use the same wildcard known-host record. Exact provider UUID, ownership marker, repository subject, and observed address still gate the fast attachment, but shared guest host identity is not acceptable production multi-environment authentication. Stage 8 must generate and authentically enroll one key per exact environment.
- Queue scheduling must eventually account for VM memory/CPU/idle policy without weakening the current one-effective-task rule or pretending all provider families expose identical resource semantics.
- The initial UCI source transfer confirms that source shape is repository-specific. Qualification should cover large/mixed repositories, neutral source markers, content-cache bounds/garbage collection, and tool-profile readiness without importing project names into generic execution components.

### Bootstrap/update/setup deadlock and full operator CLI

Observed problems:

- The originally installed managed checkout predated the current runtime-update/bootstrap contract. The downloaded loader verified that clean old checkout and handed control back to old code, so `doctor` could diagnose the obsolete runtime but could neither reach nor offer the update that fixed it.
- The initial launcher assumed one configured repository and required hand editing. It did not discover choices first, distinguish repository visibility from task-author trust, offer persistent environments, remember a channel, or provide a bounded first-run completion state.
- Normal launch and setup were the same path. An incomplete or corrupt local marker could repeatedly reopen authority-bearing prompts.
- A custom DevBridge home initially copied literal default-home state/workspace paths from the example, which could make an isolated test installation share mutable roots with the default installation.
- Foreground supervision exposed a console by default even though ordinary work is unattended.
- Removal had no durable ownership inventory, so a convenient purge would have risked deleting operator/foreign VMs, images, state roots, or shared provider infrastructure.
- The first published purge smoke removed every manifest target but left empty launcher/home directories, showing that complete uninstall needs safe parent pruning without treating a parent as recursive deletion authority.

Disposable solution and rationale:

- `package.json` declares a stage-0 protocol. The current downloaded loader can perform one narrow compatibility transition from an older pre-protocol checkout: fixed repository and testing branch, clean worktree, exact remote head observed around fetch, required candidate protocol/shape, fast-forward ancestry only, cooperative daemon stop, durable planned/activated journal, exclusive dead-process-aware lock, and `refs/devbridge/stage0-previous` rollback evidence. It is not an ordinary self-update bypass.
- After the transition, DB-011-style candidate validation and activation remain supervisor-owned. `doctor` reports current/available/unknown update state even when first-run setup is incomplete, `update` enters candidate validation/activation, and an accepted runtime refreshes only the canonical installed CLI loader.
- Managed setup discovers authenticated repositories before presenting selections. It then discovers the authenticated user and bounded collaborator candidates for selected repositories. GitHub's authenticated-repository endpoint supports the bounded account-visible inventory; the collaborators response can reflect organization/team access, so collaborator visibility is displayed only as a candidate and never becomes trust until the operator selects an immutable numeric actor ID. See GitHub's [authenticated repositories](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user) and [repository collaborators](https://docs.github.com/en/rest/collaborators/collaborators#list-repository-collaborators) documentation.
- Interactive and scripted setup support named channels, multiple explicit repositories, repository discovery policy, repeated trusted actor IDs, existing/provisionable/poll-only environment choices, and explicit execution enable/disable. The disposable auto-provision action is limited to the proved Windows/Hyper-V path with an existing published base and validation route; Linux remains honestly blocked rather than redirected to the host.
- A successful setup writes `devbridge/setup-state-v1`. Normal commands cannot re-enter setup; only `setup`/`--setup` may replace it. Invalid setup state fails closed during normal launch, while explicit setup can repair it.
- Fresh config materialization replaces only the canonical example's default state/workspace values with roots under the selected DevBridge home; existing operator config is not retargeted.
- No-command launch defaults to headless `start`; `daemon` is the explicit foreground mode, `logs` returns a bounded file tail, and VM console display remains a separate exact operator action.
- `devbridge/install-manifest-v1` records exact managed paths, environment identity + repository subject + state root, and referenced image identities. App-only uninstall preserves policy/state/VMs. Purge requires exact `REMOVE`, re-observes environment subject/ownership/compatibility, protects images referenced by retained environments, never treats an adopted base as installer-created, and reports external state/workspace roots for separate cleanup.
- The deferred removal helper attempts non-recursive pruning of the canonical launcher/home parents only after exact targets are removed. Any unknown remaining entry preserves the parent.
- The former singular repository config is migrated once to the plural key with an exact backup. This compatibility transition is bounded bootstrap behavior, not a retained alternate runtime/config surface.

Main-branch requirements exposed:

- Stage 8 needs a versioned bootstrap/setup protocol that can transition old installations without letting stage 0 become a second update authority. Recovery tests must cover crash points before/after fetch, intent, daemon drain, checkout/activation, loader refresh, and reboot/PID reuse.
- Setup needs a durable transaction/re-entry model for discovery, local selection, elevated provider preparation, reboot/session-group changes, image build/publication, environment creation, route enrollment, and execution enablement. A single completion file is sufficient for this disposable path but not the final multi-phase installer journal.
- Supported setup must implement equivalent first-class Windows/Hyper-V and Linux/KVM-QEMU-libvirt flows, including prerequisite installation/authorization choices without opaque elevation or surprise machine-wide changes.
- Production uninstall needs manifest evolution, per-artifact creation/adoption provenance, exact provider-resource ownership, interruption reconciliation, and an operator-readable preserved/removed report. It must never infer deletion authority from names or configured directories alone.
- CLI/headless service installation, autostart, log retention, repair, launcher replacement, and uninstall helper completion need platform qualification. GUI/console display remains optional diagnostic behavior, not the default execution topology.

## Production-work coverage audit

The fast track has now exposed and recorded the following production work. The temporary solution column describes what made this disposable branch usable; it is not permission to move the shortcut to `main`.

| Problem exposed | Disposable solution/evidence | Production owner and acceptance direction |
| --- | --- | --- |
| Hyper-V installed but unavailable to the runner account | Operator group membership plus reboot, followed by `Get-VMHost` proof | [Stage 8 #116](https://github.com/iteathen/DevBridge/issues/116): discover feature, service, account authorization, elevation, reboot, and re-entry separately |
| No compatible prepared Hyper-V base image | Build from checksum-verified Ubuntu media, install a checksum-pinned Node runtime and guest helpers, then publish through the Stage 2 image library | [Stage 8 #116](https://github.com/iteathen/DevBridge/issues/116): source-specific, restartable acquisition/build/generalization with provenance and free-space checks |
| Ubuntu seed alone still required interactive confirmation | Derive fixed-layout media with `autoinstall` on both GRUB entries and zero menu delay; prove it with a clean headless install | [Stage 8 #116](https://github.com/iteathen/DevBridge/issues/116): supported no-prompt media construction and qualification, not an opaque local patch |
| Installer and first-boot phases have different account availability | Defer user-owned directories/services to first-boot cloud-init | [Stage 8 #116](https://github.com/iteathen/DevBridge/issues/116): explicit, restartable phase contracts and repair behavior |
| Ordinary Hyper-V management authority cannot configure host IP/NAT | Keep the incomplete owned plan and explicitly use the foreign Default Switch for the fast topology | [Stage 8 #116](https://github.com/iteathen/DevBridge/issues/116): bounded elevated owned-network setup, conflict checks, DHCP/static-seed behavior, and post-change connectivity proof |
| Fresh guests need a trusted SSH host-key enrollment return path | Retain one key for the disposable repository clone; use exact-IP trust-on-first-use only for the clearly owned probe | [Stage 8 #116](https://github.com/iteathen/DevBridge/issues/116): unique per-environment identity with authenticated enrollment bound to provider/environment identity |
| VM startup/console behavior could consume time or the operator desktop | Keep the active environment hot; headlessly resume Saved/Paused state; make VMConnect an explicit `Show` action | [Stage 7 #115](https://github.com/iteathen/DevBridge/issues/115) and [Stage 8 #116](https://github.com/iteathen/DevBridge/issues/116): fenced idle/save/resume policy and operator-only console display |
| Position-named file parts invalidated most of the guest cache | File-tree protocol `1.1.0` uses digest-named parts and a bounded guest missing-part inventory | [Stage 7 #115](https://github.com/iteathen/DevBridge/issues/115): adversarial cache/digest/restart qualification plus bounded garbage collection |
| One SSH/guest-process startup per bridge frame dominated work | Use one bounded ordered line exchange over a pinned SSH process and stage the exact current helper through the existing trusted bridge | [Stage 7 #115](https://github.com/iteathen/DevBridge/issues/115): provider-neutral persistent transport with reconnect, cancellation, hostile-response, save/resume, fence-loss, and daemon-restart evidence |
| Concurrent operation creation and Windows atomic replacement were racy | Exclusive initial journal creation, bounded transient rename retry, stronger liveness classification, and terminal failure persistence | [Stage 7 #115](https://github.com/iteathen/DevBridge/issues/115): generic failure/recovery qualification independent of provider or host OS |
| A usable local Codex adapter could be mistaken for automatic authority | `defaultTool: null`, strict unknown-tool rejection, and inventory eligibility only for the exact operator-configured default | [Stage 7 #115](https://github.com/iteathen/DevBridge/issues/115): prove remote direct request and local opt-in are the only selection paths |
| PowerShell progress and prefix arithmetic hid/broke the real provider failure | Suppress progress, retain the actionable tail of bounded errors, and use unsigned-safe IPv4 mask arithmetic | [Stage 7 #115](https://github.com/iteathen/DevBridge/issues/115): real provider/error-path tests rather than mock-only confidence |
| Initial fast recovery used a direct-host path before VM readiness | Keep that implementation disabled and mutually exclusive with the VM topology | [Stage 9 #117](https://github.com/iteathen/DevBridge/issues/117): delete it with the disposable branch and prove repository-wide absence of host fallback |
| Windows/OneDrive can retain locked stale worktree metadata directories | Preserve the failure as evidence and avoid broad/destructive cleanup | [Stage 8 #116](https://github.com/iteathen/DevBridge/issues/116): exact owned cleanup with Windows lock diagnostics and recoverable re-entry |
| An old managed checkout could not reach the updater that replaced it | One narrow stage-0 protocol fast-forward with durable intent, lock, exact remote subject, and rollback ref | [Stage 8 #116](https://github.com/iteathen/DevBridge/issues/116) plus DB-011: versioned bootstrap transition and crash/reboot recovery without creating a second general update authority |
| Hand-edited single-repository setup hid discoverable choices and conflated visibility with trust | Discover repositories first; present collaborators as candidates; require explicit repositories, numeric actor trust, VM selections, and execution choice | [Stage 8 #116](https://github.com/iteathen/DevBridge/issues/116): transactional provider-complete discover/select/provision/re-entry UX for both host families |
| Reopening setup on every launch could accidentally revisit authority-bearing choices | Durable completion marker; normal launches locked out; explicit `setup` repairs/reconfigures | [Stage 8 #116](https://github.com/iteathen/DevBridge/issues/116): versioned multi-phase setup journal with exact recovery semantics |
| Uninstall without ownership evidence could delete foreign/shared infrastructure | Exact install manifest, two confirmation-protected scopes, provider re-observation, referenced-image protection, external-root preservation | [Stage 8 #116](https://github.com/iteathen/DevBridge/issues/116): versioned artifact provenance and interruption-safe cleanup reports |
| Foreground windows/VM consoles interfered with ordinary unattended work | Keep the background supervisor and its daemon child hidden, retain bounded logs, and reserve foreground daemon/VM `Show` for explicit actions. The installed canary exposed one missed `windowsHide` flag on the supervised daemon child; the candidate fixes and regression-tests it. | [Stage 7 #115](https://github.com/iteathen/DevBridge/issues/115) and [Stage 8 #116](https://github.com/iteathen/DevBridge/issues/116): qualified service/autostart/log/console lifecycle |

### Evidence boundaries and unresolved work

The current evidence must not be overstated:

- Real-provider evidence exists only for Windows/Hyper-V with one Ubuntu profile. Linux KVM/QEMU/libvirt remains unqualified and is a first-class [Stage 7 #115](https://github.com/iteathen/DevBridge/issues/115) requirement.
- A real trusted remote task now passed through GitHub provenance, controller intent, the exact VM, host verification, status projection, and no-diff completion. An intentional bounded persistent proposal is still needed to qualify candidate return and isolated-branch publication end to end.
- Save/resume recovery was proven by starting a new runtime after resume. An already-open persistent transport interrupted by save, provider restart, network change, or daemon restart still needs explicit reconcile tests; automatic replay of an ambiguous frame must remain forbidden.
- The owned NAT setup remains incomplete because host TCP/IP/NAT mutation required elevation. The Default Switch route is usable fast-track evidence, not production network readiness.
- The published base intentionally retained one SSH host identity. The clean probe proved unique-key generation, but authenticated enrollment is still absent.
- The second repository environment proves multi-environment routing, but it also clones that disposable SSH host identity. This is fast-only evidence and increases the urgency of per-environment authenticated enrollment before any production multi-repository claim.
- The immutable image contains the earlier one-shot bridge helper. Runtime staging of the current helper avoids a compatibility parser, but production needs versioned image/helper compatibility and deliberate image migration.
- Cloud-init reports disabled after the installed image's first boot. It cannot currently be claimed as a supported repair/reconfiguration mechanism.
- The content-addressed cache still contains now-unreachable positional blobs from the earlier protocol. They require exact cache-owned garbage collection, not legacy parsing.
- The unattended probe and incomplete owned-network plan remain preserved host artifacts. Cleanup must validate their exact ownership and must not touch the three foreign VMs or shared Default Switch.
- The fast scripts assume this Windows workstation's available PowerShell, Hyper-V, OpenSSH, IMAPI, and media-extractor surface. Stage 8 must discover/supply prerequisites and keep provider-specific commands behind the owning adapter.
- Current VM scripts download installer packages/security updates and the checksum-pinned Node archive during image construction. Production qualification must record exact inputs and distinguish cryptographic identity from mutable network availability.
- Fast-track code and documentation are useful only when published together on `codex/temp-fast-functional`. Passing local tests are pre-publication evidence; each pushed checkpoint still requires an exact scoped commit and validation/evidence bound to that identity.

### Required disposal conditions

Before the disposable branch is thrown away or any result is promoted:

1. preserve the final field notes and exact test/artifact identities on the remote repository;
2. move only reviewed generic corrections through isolated production branches—never copy the direct-host topology or fast configuration wholesale;
3. qualify the generic transfer, bridge durability, provider error handling, and opt-in tool-selection changes at their owning boundaries;
4. complete Stage 7 evidence for both Hyper-V and KVM/libvirt before claiming the VM boundary production-ready;
5. complete Stage 8 install, enrollment, networking, repair, lifecycle, and cleanup flows before presenting the fast scripts as supported setup;
6. use Stage 9 to remove transitional/direct-host/cache/configuration scaffolding after the production path is proved;
7. delete saved probe/network/cache artifacts only through exact ownership-checked operations.

## 2026-08-20 bootstrap validation canary

- The stage-0 bootstrap migrated the local managed runtime from `b50c49dfa953c7078b4a177560dcbcfa04f9dcb3` to `df47cb0ec00452549f98d83e2f13f4f05c84c59a` and retained the former head at `refs/devbridge/stage0-previous`. Setup/config backups remained intact and the installed polling-only daemon passed doctor.
- Trusted GitHub task [#133](https://github.com/iteathen/DevBridge/issues/133) configured and compiled a disposable C hello-world project with GCC 13.3.0, then exposed a cross-host execution-mode bug: the CMake build tree was collected through the Windows authoritative worktree between operations, so the ELF executable returned to the guest without an executable bit and CTest received `permission denied`.
- The generic correction gives deterministic adapters opaque managed-scratch arguments, materializes them only as run-scoped bridge `scratch` locations inside the exact repository VM, and adds host-initiated, idempotent, verified-absent guest scratch cleanup. The durable scratch ledger records environment cleanup separately so a failed/interrupted cleanup is reconciled before local scratch removal. No host path or provider identity enters the deterministic operation contract.
- Retry [#134](https://github.com/iteathen/DevBridge/issues/134) proved that the executable now remains runnable across configure/build/test sessions. It also exposed a task-fixture mistake: an anchored CMake `PASS_REGULAR_EXPRESSION` rejected newline-terminated output even though CTest launched the binary and observed `Hello, world!`.
- Final retry [#135](https://github.com/iteathen/DevBridge/issues/135) passed all three VM operations: CMake configure with GNU C 13.3.0, compile/link of `hello`, and CTest `1/1` with `100% tests passed`. DevBridge verified both ephemeral input files absent, verified the one VM scratch directory absent, kept the authoritative worktree clean, and skipped publication because there was no project diff.
- Qualification after the correction: repository preflight passed (`41` syntax files, `3` JSON files, `34` targeted tests); the final full Node suite passed (`532` total, `526` passed, `6` Windows-capability skips, `0` failed). The exact legacy `scratch/` residue from failed run `pp-133-7361d897bd1634f7` was ownership-checked, removed, and verified clean.
- The installed `start` canary opened an empty Windows Terminal at the exact daemon-child start time. The top-level background supervisor was hidden, but `spawnDevBridgeDaemon` explicitly used `windowsHide: false`; on this Windows 11 default-terminal configuration that allocated a visible terminal for the child. The candidate now requires `windowsHide: true` and has a launch-options regression test. The affected daemon was stopped cooperatively, which closed the exact terminal process, and the accepted runtime was restarted with both supervisor and daemon window handles at zero.
- Publication boundary: live canary corrections remain proposals until they are reviewed, published on `codex/temp-fast-functional`, and admitted by the bootstrap updater; a workspace daemon or passing canary does not itself make a runtime accepted.
- A live setup retry exposed that interactive selections split only on commas, validation errors exited setup, authenticated self was not explicit, and custom authority entries had no positive GitHub identity check. Setup now accepts whitespace/comma multi-select and `all`, retries recoverable repository/author/environment input, exposes `self`, resolves custom repositories/logins/actor IDs through authenticated GitHub queries, rejects subject mismatches, warns with canonical repository IDs and immutable actor IDs, and requires an exact second `APPLY` confirmation before writing repository/task-author authority.

## Current VM bring-up frontier

Completed:

- Hyper-V feature/service/account readiness and live `Get-VMHost` proof.
- Foreign VM/switch/NAT inventory without adopting or mutating foreign objects.
- Official media download and checksum, bounded NoCloud seed generation, and structurally verified no-prompt derived ISO.
- Ubuntu builder installation, tool/helper/service verification, generalization, and immutable image publication.
- Separate owned differencing-disk environments for immutable repository IDs `1337742670` (DevBridge) and `1297121161` (UCI Arena).
- Headless Default Switch attachment, DHCP observation, pinned SSH route, bridge health, and real Stage 6 repository execution.
- Linux/x64 Node execution and 12 targeted tests through the exact VM route.
- Content-addressed incremental source synchronization with guest inventory validation.
- Headless running/saved/paused lifecycle support and an explicit console diagnostic utility.
- Clean unattended installer boot, automatic poweroff, disk boot, and installed-tool/service verification without desktop control.
- Exact repository-environment save/resume followed by a passing VM repository-execution smoke.
- Opt-in-only coding-adapter inventory projection, full local qualification, live queue poll, and hidden daemon lifecycle proof.
- Serialized two-repository polling with isolated queue state, a shared rate budget, and a real UCI Arena VM smoke.

Next:

1. Reconcile or leave clearly planned the incomplete owned NAT network; do not hide its degraded production readiness behind the Default Switch workaround.
2. Run one real trusted-task publication canary with an intentional bounded project diff through candidate return, host verification, and isolated-branch publication.
3. Add the required Linux/KVM-QEMU-libvirt qualification path; do not treat Windows/Hyper-V success as provider-family completion.
4. Remove unreachable positional guest cache blobs only through exact disposable-cache cleanup; retain no compatibility code.
5. Decide whether the disposable unattended probe remains as restartable evidence or is removed through an exact owned-resource cleanup action.
6. Convert the fast-track findings into scoped Stage 7/8 qualification and install/re-entry work on isolated production branches.

## Evidence already obtained

- Published bootstrap distribution smoke at executable commit `8bd9aad0c924d33e0a492932ee863a0b31b62a35`: downloaded the raw testing-channel launcher from GitHub into a fresh temporary home, cloned that exact runtime head, completed noninteractive polling-only setup, kept state/workspace roots inside the custom home, wrote a complete setup record and 12-entry install manifest, ran `doctor` without reopening setup, then completed exact-`REMOVE` manifest purge and verified the installation root was gone.
- Full Node test suite after the full bootstrap work: 529 total, 523 passed, 6 Windows-capability skips, 0 failed.
- Repository preflight after the full bootstrap work: passed with 41 syntax files, 3 JSON files, and 34 targeted tests.
- Bootstrap/setup/update/uninstall targeted tests: 30 passed, covering the protocol transition, isolated custom-home defaults, update observation, setup lockout/corruption, persisted-channel re-entry, discovery/selection, explicit environment provisioning, launcher refresh, manifest boundaries, and both uninstall scopes.
- `npm run fast:doctor`: passed; VM repository execution is ready, `codex-fast` is usable but not eligible for automatic selection, and the owned NAT foundation remains honestly degraded while the explicit Default Switch fast topology is usable.
- Real opt-in Codex smoke: passed using the explicitly selected adapter.
- `npm run fast:run`: safe live queue cycle completed with an empty eligible queue, no selected coding adapter, no rejected task, and no inventory/onboarding error.
- Hidden fast daemon start/status/pause/resume/stop smoke: passed; the final status had no active lock or pending control record.
- Full Node test suite after the multi-repository work: 513 total, 507 passed, 6 Windows-capability skips, 0 failed.
- Repository preflight after the newest work: passed with 41 syntax files, 3 JSON files, and 34 targeted tests.
- Live Hyper-V management: `Get-VMHost` succeeds after group membership/reboot.
- Real Stage 6 smoke: Linux/x64, Node `v24.19.0`, 12/12 targeted tests passed, VM-bound evidence recorded.
- Exact saved-state recovery smoke: `23.145` seconds, Linux/x64, Node `v24.19.0`, and 12/12 targeted tests passed after `Running -> Saved -> Running`.
- Fresh unattended-install probe: automatically powered off after install and passed headless disk-boot verification for the toolchain, guest helpers, network service, and Hyper-V integration service.
- Source-cache tests cover changed-only transfer and forged unknown-part rejection; targeted file-tree/workspace/repository tests pass under protocol `1.1.0`.
- Fast topology tests prove windowless saved/paused resume commands and bounded endpoint reuse.
- Persistent line-channel tests prove ordered multi-frame exchange and one shared first connection; real VM timing improved to `22.355` seconds changed and `21.077` seconds unchanged for two repository operations.
- Live authenticated discovery selected 15 locally allowed-owner repositories with no truncation; fast configuration deliberately kept discovery disabled and explicitly selected only DevBridge plus UCI Arena.
- Real UCI Arena Stage 6 smoke at `b8cc97a7b81b3a2ffe3d9f6b8135cd684d155934`: Linux/x64, Node `v24.19.0`, 4/4 repository tests passed, warm elapsed time `29.119` seconds, and evidence bound to immutable repository ID `1297121161`.
