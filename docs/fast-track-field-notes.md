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

Main-branch requirement exposed:

- Stage 8 needs an owned, checksumable seed-media builder with schema validation, explicit installer-versus-first-boot phases, and a no-prompt boot contract. Setup must detect or supply this prerequisite instead of assuming external ISO authoring tools exist or asking the operator to babysit a VM console.
- The derived ISO content has been structurally verified, but a clean second-VM boot is still required as end-to-end proof that no firmware/menu/installer prompt remains.

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

Fast-track workaround:

- Use one disposable base/environment, retain its installer-generated host identity, observe its DHCP address through the exact owned Hyper-V adapter, and use a wildcard hostname with that pinned key so a DHCP renewal does not break the fast route. This is expedient evidence only; it must not become a multi-environment production pattern.

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

## Current VM bring-up frontier

Completed:

- Hyper-V feature/service/account readiness and live `Get-VMHost` proof.
- Foreign VM/switch/NAT inventory without adopting or mutating foreign objects.
- Official media download and checksum, bounded NoCloud seed generation, and structurally verified no-prompt derived ISO.
- Ubuntu builder installation, tool/helper/service verification, generalization, and immutable image publication.
- Owned differencing-disk environment for immutable repository ID `1337742670`.
- Headless Default Switch attachment, DHCP observation, pinned SSH route, bridge health, and real Stage 6 repository execution.
- Linux/x64 Node execution and 12 targeted tests through the exact VM route.
- Content-addressed incremental source synchronization with guest inventory validation.
- Headless running/saved/paused lifecycle support and an explicit console diagnostic utility.

Next:

1. Boot a clean probe VM from the derived ISO to prove the entire install path is unattended without using the desktop.
2. Save and resume the exact owned repository environment, then re-run bridge health and repository execution.
3. Re-audit tool selection so Codex remains explicit opt-in despite being locally usable.
4. Run the full Node suite, repository preflight, fast doctor, queue cycle, and daemon lifecycle smoke.
5. Reconcile or leave clearly planned the incomplete owned NAT network; do not hide its degraded production readiness behind the Default Switch workaround.
6. Remove unreachable positional guest cache blobs only through exact disposable-cache cleanup; retain no compatibility code.

## Evidence already obtained

- `npm run fast:doctor`: VM repository execution ready; the owned NAT foundation remains honestly degraded while the explicit Default Switch fast topology is usable.
- Real opt-in Codex smoke: passed using the explicitly selected adapter.
- `npm run fast:run`: safe queue cycle completed.
- Fast daemon start/status/stop smoke: passed.
- Earlier full Node test suite: passed after the bridge durability corrections; it must be rerun after the newest VM transport/cache work.
- Repository preflight: passed with 41 syntax files, 3 JSON files, and 34 targeted tests.
- Live Hyper-V management: `Get-VMHost` succeeds after group membership/reboot.
- Real Stage 6 smoke: Linux/x64, Node `v24.19.0`, 12/12 targeted tests passed, VM-bound evidence recorded.
- Source-cache tests cover changed-only transfer and forged unknown-part rejection; targeted file-tree/workspace/repository tests pass under protocol `1.1.0`.
- Fast topology tests prove windowless saved/paused resume commands and bounded endpoint reuse.
- Persistent line-channel tests prove ordered multi-frame exchange and one shared first connection; real VM timing improved to `22.355` seconds changed and `21.077` seconds unchanged for two repository operations.
