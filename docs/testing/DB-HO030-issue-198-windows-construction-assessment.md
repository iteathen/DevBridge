# DB-HO030 — issue #198 Windows construction assessment and plan

Status: active implementation checkpoint. This record is based on accepted `cuda-target` commit `881d2a391f3cf651effa94dc44719458d93a26c5`. It does not claim that a Windows production image or the dual-guest execution slice is complete.

## Assessment

Ubuntu v10 has completed the canonical-image canary and is admitted in the local immutable image library. The equivalent Windows path is not implemented. Existing Windows work proves reusable contracts and transport mechanics, not a constructed guest:

- `CanonicalImageCanary` already owns restartable prepare, install, activate, probe, finalize, retain, publish, and verify stages without guest/provider vocabulary.
- `HyperVImageConstruction` already owns an exact Generation-2 VM, dynamic construction VHDX, two attached media objects, bounded liveness/console evidence, retention, and exact-owned cleanup. It remains source- and repository-agnostic.
- the environment bridge already has a fixed PowerShell Direct attachment whose credential comes from a host-local resolver and whose guest operation is restricted to the fixed helper;
- the environment construction preparation seam accepts a Windows access resolver but has no production Windows enrollment/preparation owner;
- the Windows host preflight currently proves Hyper-V, IMAPI, SSH and source-verification prerequisites for the Ubuntu canary. It is not a Windows-source or Windows-guest readiness claim.

Four missing primitives prevent honest Windows usability:

1. There is no locally approved Microsoft-media authority that binds ISO integrity, exact image index, edition, architecture, version/build, installation type, and provenance.
2. There is no Windows-specific unattended recipe, pinned tool provisioner, qualification owner, sanitization owner, or Sysprep finalizer.
3. Both Hyper-V construction and persistent-environment materialization currently force Secure Boot off and do not configure a vTPM. That cannot satisfy supported Windows 11 VM requirements.
4. There is no per-environment Windows enrollment mechanism that creates a fresh guest-domain management identity and a distinct unprivileged routine execution identity without embedding a reusable credential in the base image.

Consequently, Stage 6 is structurally implemented but the product-level Windows route is unavailable. DevBridge has not met the minimal dual-guest acceptance until a fixed C source is transferred, compiled, executed, and returned through both real guests.

## Primary-source research

Microsoft documents the following relevant platform behavior:

- [Automate Windows Setup](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/automate-windows-setup?view=windows-11) defines `Autounattend.xml`, exact image selection through `ImageInstall/OSImage/InstallFrom/MetaData`, unattended disk selection, and EULA handling. Missing or invalid required settings may return Setup to UI, so GUI absence must be observed rather than assumed.
- [Answer files](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/update-windows-settings-and-scripts-create-your-own-answer-file-sxs?view=windows-11) defines the Windows PE, specialize, audit, and OOBE configuration passes. `Reseal Mode=Audit` in `oobeSystem` is the supported route that bypasses OOBE for image customization.
- [Audit mode](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/audit-mode-overview?view=windows-11) is the supported image-customization environment. Windows uses the built-in Administrator for Audit Mode; the image must not invent an ordinary user/autologon dependency merely to run construction scripts.
- [RunSynchronous](https://learn.microsoft.com/en-us/windows-hardware/customize/desktop/unattend/microsoft-windows-deployment-runsynchronous) runs ordered commands and waits for each one. Microsoft documents user context in `auditUser` and SYSTEM context in `specialize`; this provides a noninteractive construction surface instead of UAC/desktop automation.
- [Sysprep command-line options](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/sysprep-command-line-options?view=windows-11) require `/generalize` before an image is moved/copied and support `/oobe`, `/shutdown`, `/quiet`, and `/mode:vm`. [Sysprep generalization](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/sysprep--generalize--a-windows-installation?view=windows-11) confirms that `/mode:vm` is applicable when the generalized VHD is redeployed on the same hypervisor family.
- [Windows Setup automation overview](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/windows-setup-automation-overview?view=windows-11) warns that cached answer files persist across passes and may retain sensitive values. Cached/embedded answer files and temporary credentials therefore must be removed before capture.
- [DISM image management options](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/dism-image-management-command-line-options-s14?view=windows-11) and [Get-WindowsImage](https://learn.microsoft.com/en-us/powershell/module/dism/get-windowsimage?view=windowsserver2025-ps) expose exact WIM/ESD image index, name, edition, architecture, version/build, and other source metadata. Those observations belong in the source-media adapter, not generic image code.
- [Microsoft's Windows 11 download page](https://www.microsoft.com/en-us/software-download/windows11) identifies the x64 ISO as supported virtual-machine media, describes it as multi-edition media whose installed edition is unlocked by the operator's product key, and publishes SHA-256 verification guidance. It exposes an interactive edition/language selection rather than a documented stable automation API. A measured local ISO is not approved merely because its filename resembles Microsoft media; setup must bind a locally approved official hash/provenance subject.
- [Microsoft's Windows 11 Enterprise Evaluation Center](https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise) requires registration and describes its ISO as a 90-day evaluation. Evaluation is therefore a distinct, explicitly temporary local choice; discovery must never silently select it, treat it as durable production media, or bypass the operator's registration/license decision.
- [Windows 11 VM requirements](https://learn.microsoft.com/en-us/windows/whats-new/windows-11-requirements) require a Generation-2 Hyper-V VM with Secure Boot and TPM enabled, at least 4 GiB RAM, two processors, and 64 GiB storage. [Generation-2 security features](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/generation-2-virtual-machine-security-features) documents the provider-native Secure Boot templates and vTPM behavior.
- [PowerShell Direct](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/powershell-direct) requires a running local Windows guest and valid guest credentials but does not depend on guest networking. It is a transport, not authorization to make every repository job administrative.
- [Visual Studio workload installation](https://learn.microsoft.com/en-us/visualstudio/install/use-command-line-parameters-to-install-visual-studio?view=visualstudio) provides unattended `--quiet --wait --norestart --add` installation. The construction process must already be in its controlled privileged pass; it must never depend on a consent prompt appearing inside the guest.
- [Visual Studio 2022 release history](https://learn.microsoft.com/en-us/visualstudio/releases/2022/release-history) distinguishes evergreen channel bootstrappers from fixed-version bootstrappers and states that the latter install the specific listed release. The current admitted release is Build Tools `17.14.39`, installation build `17.14.37614.0`, from the exact Microsoft fixed-version link published for that row.
- [Visual Studio installer parameters](https://learn.microsoft.com/en-us/visualstudio/install/use-command-line-parameters-to-install-visual-studio?view=visualstudio) defines `--noUpdateInstaller` as preventing installer self-update during a quiet operation and failing rather than silently updating when the installed bootstrap mechanism is insufficient. It also allows `--channelUri` to point to a nonexistent local manifest when updates are not wanted.
- [Visual Studio Build Tools component IDs](https://learn.microsoft.com/en-us/visualstudio/install/workload-component-id-vs-build-tools?view=visualstudio) classifies the x64/x86 MSVC compiler, CMake tools, and Windows 11 SDK as recommended rather than required members of the native-build workload. Relying on `--includeRecommended` would make the selected surface wider and less explicit than the local contract; the exact component IDs must be requested directly.
- [Offline/local layouts](https://learn.microsoft.com/en-us/visualstudio/install/create-an-offline-installation-of-visual-studio?view=visualstudio) plus [layout deployment](https://learn.microsoft.com/en-us/visualstudio/install/deploy-a-layout-onto-a-client-machine?view=visualstudio) are the supported no-web distribution mechanism. `--noWeb` fails if a requested component is absent. A content-addressed layout remains a replaceable acquisition adapter for offline installations, but is not required for the initial network-capable construction guest.

## Reassessment

The supported first Windows path is ISO boot plus a bounded answer/recipe medium, not GUI automation and not an assumed prepared VHDX. It reuses the existing canonical-image and Hyper-V construction studs while adding Windows-owned source, recipe, qualification, and finalization adapters.

Official acquisition does not remove local approval. With no documented stable Microsoft acquisition API or machine-verifiable license entitlement in the current boundary, the supported setup contract is: discover already-owned official media first; otherwise offer an official Microsoft acquisition handoff and resume after the exact bytes are present; offer Evaluation only as an explicitly temporary alternative. DevBridge may verify the resulting media, but it cannot infer a license, accept terms, register, select an edition, or convert Evaluation into production authority for the operator.

The existing Hyper-V settings are a correctness blocker, not optional hardening. Windows 11 construction and every materialized Windows 11 profile require a neutral boot-protection requirement that the Hyper-V adapter maps to Secure Boot and vTPM. The generic declaration must not name a Hyper-V template or Windows API. Ubuntu remains on its independently declared boot requirement; there is no conditional guest-name branch inside the provider.

Construction privilege and routine execution privilege are separate:

- unattended Setup/Audit/Sysprep operations may run in their documented privileged passes;
- the temporary build credential is a construction-only secret, is never published, and must cease to authenticate before capture;
- a generalized base contains no reusable operator/product/activation secret;
- materialization establishes fresh per-environment guest credentials through a bounded host-owned enrollment capability;
- normal source/build/test operations use a non-administrative guest identity and closed stdin with no interactive desktop or UAC channel;
- privileged profile maintenance, if later exposed, is a separate locally registered operation. Repository input cannot request elevation.

Any unexpected Windows Setup page, installer dialog, UAC consent UI, reboot loop, or credential prompt is a bounded failure with retained liveness/console/log evidence. It is never a wait-for-human state and never authorizes host execution.

The Build Tools authority is a two-part contract, not a claim that hashing the small bootstrapper hashes every package it can fetch. Before execution it binds the Microsoft-published fixed-version bootstrapper, exact bytes/SHA-256, release/build identity, and explicit minimum component set. During construction it disables installer self-update, disables the resulting instance's update channel, and rejects any preexisting or resulting installation whose `vswhere installationVersion` differs from `17.14.37614.0`. Qualification repeats that exact version check and performs a real CMake/CTest compile. The immutable output-image hash then binds the realized package bytes. A different realization cannot silently reuse the admitted image identity.

This is sufficient for the first network-capable image without pretending that Microsoft package acquisition is a host authority. The construction guest contains no host secret, its fetched packages and installer output remain untrusted until qualification, and failure never redirects execution to the host. A future offline-layout owner can replace this acquisition mechanism through the same tool contract without changing image construction or qualification internals.

## Primitive-to-product implementation plan

### Brick 1 — exact source-media authority

1. Add a Windows-owned immutable construction-authority value object and state store.
2. Add a Windows platform media inspector that accepts only a locally admitted regular ISO, measures size/SHA-256, mounts it read-only, inventories `install.wim` or `install.esd` through fixed DISM APIs, and always reconciles the exact mount it created.
3. Bind one exact index/edition/architecture/version/build/installation-type/language selection plus an explicit source class and official provenance reference.
4. Keep host paths out of public authority/status projections. Discovery reports candidates; only local setup approval creates authority.

### Brick 2 — generic seed transport and Windows recipe

1. Replace the narrowly named NoCloud IMAPI writer with one bounded entry-map ISO writer; adapt Ubuntu through the same neutral file-map stud and remove the old component rather than keeping compatibility garbage.
2. Add a Windows-owned answer-file/recipe factory that selects only the exact admitted image, partitions the Generation-2 target, enters Audit Mode, carries no product key/activation secret, and invokes one fixed construction bootstrap.
3. Generate a fresh construction-only credential/material subject outside the authority identity. Never serialize it into Git, issue evidence, image provenance, or normal config.

### Brick 3 — supported VM security settings

1. Extend the neutral boot requirement resolver with a protected EFI requirement; do not add provider/guest names to the declaration.
2. Extend Hyper-V image-construction and persistent-environment adapters to reconcile exact Secure Boot/vTPM settings, key-protector ownership, and observed compatibility for that local setting.
3. Cover unowned/mismatched firmware, template, protector, and TPM state with fail-closed tests. Construction and environment settings must be immutable after durable intent.

### Brick 4 — noninteractive tooling and image qualification

1. Pin official installer identity, version, URL, digest/signature policy, fixed arguments, and expected installed capability for Git, Node/npm, CMake/CTest, and the selected C/C++ toolchain.
2. Run provisioning through Audit Mode/specialize without shell interpolation, inherited host credentials, desktop automation, or UAC prompts.
3. Install current bridge/bootstrap/network/enrollment helpers as profile-owned services/files.
4. Probe exact OS/source/tool versions, DNS/HTTPS, then run a real CMake configure/build/CTest canary and record bounded evidence.
5. Remove temporary installers, source residue, cached answer files, logs containing sensitive construction values, and the temporary build credential.
6. Run supported `Sysprep /generalize /oobe /shutdown /quiet /mode:vm`; reconcile the exact shutdown and never boot the canonical disk again before retention/hash/admission.

### Brick 5 — restartable setup and physical canary

1. Add a Windows status gate beside the Ubuntu gate without teaching either guest adapter about the other.
2. Discover approved local media before prompting. If none is approved, stop only at the genuine choice between operator-supplied official media and an explicitly temporary Evaluation route; never silently choose Evaluation.
3. Exercise interruption/re-entry at every durable canary frontier and retain exact failed subjects for supported cleanup.
4. Publish the generalized VHDX through the existing immutable image-library contract and verify provider-native identity, virtual size, exact byte size, and SHA-256.

### Brick 6 — per-environment enrollment and routine identity

1. Add a Windows enrollment owner analogous to the Linux access-preparation boundary, using a host-generated per-environment secret and fixed guest receiver.
2. Establish a management transport identity and a distinct non-administrative routine execution identity without embedding either reusable credential in the base image.
3. Prove PowerShell Direct/bridge health, normal stop/start continuity, stale-generation rejection, and no UAC/interactive dependency.

### Brick 7 — minimal product proof

1. Materialize exact Windows and Ubuntu profile environments from their admitted images.
2. Transfer one fixed C source and run-specific stdout challenge through the Stage-6 source/input studs.
3. Compile and execute inside each guest through locally registered operations.
4. Return exact exit/stdout/compiler/executable-digest evidence through the result studs.
5. Repeat after daemon and VM reuse/restart. Provider, media, credential, bridge, or compiler absence remains fail-closed with no host/model fallback.

Only after Brick 7 passes is the minimal non-CUDA DevBridge product slice true. Broader language toolchain qualification follows on those same admitted profiles; CUDA/GPU remains deferred.

## Implementation checkpoint — 2026-08-28

The primitive implementation has now reached the physical-media frontier. This checkpoint records code and tests, not a claim that a Windows image exists.

### Exact authority and discovery

- `windows-install-media-authority` binds the exact ISO byte count/SHA-256, approval class/reference, selected WIM/ESD index, edition, architecture, version/build, installation type, languages, and default language. Evaluation media remains explicitly temporary and can never be selected implicitly.
- `windows-install-media-inspector` measures only a real ISO beneath its admitted local root, mounts only through fixed Windows APIs, inventories all contained images before approval, inspects an exact selected index, and dismounts only media it mounted itself. Candidate inventory reports no authority.
- `windows-production-image-authority` content-addresses media, pinned tools, guest payload generation, unattended-recipe generation, and output profile/image identity as one subject. It carries no host path, password, provider, repository, executable, product key, or activation authority.
- Repeated bounded discovery over `C:\Hyper-V`, Downloads, Desktop, Documents, OneDrive, and mounted optical volumes still finds only the two Ubuntu ISO files under `C:\Hyper-V\Install Media\CUDA-JS`. No Windows ISO is present or mounted, so the canary correctly remains unavailable before mutation.

### Protected boot and unattended construction

- A neutral `integrity=required`, `identity=required`, `trust=platform-owner` boot value is now accepted by the construction and persistent-environment studs.
- The Hyper-V adapters map that declaration locally to the `MicrosoftWindows` Secure Boot template, a local key protector, and vTPM. They observe the exact resulting state before claiming ownership/readiness and reject drift. The libvirt adapter fails before effects because equivalent protected-boot support is not yet implemented there.
- The generalized IMAPI data-media writer accepts only a bounded portable file tree. Ubuntu NoCloud now uses that generic writer rather than retaining a second narrow implementation.
- The Windows seed selects only the admitted image index, creates the Generation-2 GPT layout, supplies no product key, enters Audit Mode, invokes one fixed noninteractive preparation script, and uses a restart-safe ready marker. Setup UI is configured never to appear; any actual UI remains a qualification failure rather than a human continuation.

### Privilege and credential boundary

The temporary Audit/Administrator credential is generated locally and stored only as a Windows current-user-protected blob plus a SHA-256 integrity digest. The plaintext is carried through bounded stdin only when producing the answer medium or creating a PowerShell Direct credential. It is never placed in argv, Git, the image authority, status, or evidence. The answer medium containing the construction-only credential is deleted as soon as installation media are detached and the installed guest operation channel is ready.

Microsoft documents that `CryptProtectData`/`CryptUnprotectData` normally bind protected data to the same user and machine and provide tamper detection ([CryptUnprotectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptunprotectdata), [CryptProtectData example and scope](https://learn.microsoft.com/en-us/windows/win32/seccrypto/example-c-program-using-cryptprotectdata)). This implementation deliberately uses current-user scope rather than machine scope. A daemon identity change or host migration therefore cannot silently recover the material; it must explicitly re-enroll/reconstruct or fail closed.

Microsoft also documents that PowerShell Direct requires a local running compatible guest, a Hyper-V-authorized host login, and explicit valid guest credentials, while remaining independent of guest networking ([PowerShell Direct](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/powershell-direct)). DevBridge supplies the credential programmatically and always invokes `-NonInteractive`; no credential dialog or UAC consent path exists.

The generalized image contains no reusable construction credential. Per-environment enrollment is handled by `windows-access-seed-agent`: a SYSTEM service consumes a host-delivered one-time seed, creates the fixed `devbridge` local identity, grants only local Users and Remote Management Users membership, explicitly removes Administrators membership, persists digest-only state, and deletes the seed. Routine source/build/test execution therefore runs as a non-administrator.

### Toolchain and qualification

The construction-owned tool authority currently pins:

- Node.js `22.23.2` x64 MSI from `nodejs.org`, 31,727,616 bytes, SHA-256 `ce9572ae220c345fbae2340bbb4d084e8ca5e0fe093ee7067d43094ae23be989`, verified against the official `SHASUMS256.txt`;
- Git for Windows release `2.55.0.windows.5`, 65,343,712 bytes, SHA-256 `d065a4e23c3d9a6b5073d609b5be0830227ec3ca053c083ba385061ddfaf94c6`, verified against the official GitHub release API asset digest; and
- Microsoft Visual Studio Build Tools fixed release `17.14.39` / installation build `17.14.37614.0`, using the exact 4,473,936-byte Microsoft bootstrap artifact with SHA-256 `236367b68ba9a51708263ab10a1c85546cc4a8eca78b365168811d19c4fb2f29`. The operation explicitly selects the native-build workload, x64/x86 compiler, CMake tools, and Windows 11 SDK; it does not use a mutable alias or `--includeRecommended` expansion.

The guest operation adapter exposes only locally registered `prepare`, `status`, `restart`, `qualify`, and `finalize` operations. Remote input can select none of their script text, executable paths, argv, environment, host paths, VM names, or credentials. Preparation verifies exact download length, SHA-256, and Authenticode before unattended installation, disables installer self-update, and rejects native-build version drift both before and after installation. Qualification proves payload hashes, SYSTEM services, exact source build/edition/architecture/language, the exact native-build installation version, a changed boot identity after restart, Node/npm/Git/CMake/CTest/compiler availability, DNS, HTTPS, and a real C CMake configure/build/CTest run. Finalization removes construction media/state, cached answer files and transient seeds, disables the built-in construction account, then schedules supported Sysprep generalize/OOBE/shutdown VM mode.

The qualification journal follows intent -> attempted -> observed/reconciled checkpoints. A restart whose receipt checkpoint is lost is reconciled from the changed boot identity and is never replayed. A privileged finalization whose completion receipt is lost remains ambiguous and is never replayed or admitted automatically.

### Physical composition and current host evidence

`windows-production-image-physical-canary` attaches the new Windows owners through the same generic production-image canary composition used by Ubuntu. It imports the approved ISO into an exact owned source root, creates bounded answer media, requests protected boot, waits for a noninteractive operation channel, runs the restart-safe qualifier, requires generalized shutdown, retains the exact VHDX, publishes through the immutable image library, and removes transient credential-bearing media/material after the terminal receipt. A dedicated CLI entry keeps `status` read-only and `run` explicit.

The storage preflight distinguishes the required 64 GiB virtual Windows disk from a locally declared dynamic-disk allocation budget. On this host, a 40 GiB per-copy allocation budget plus an 8 GiB source produced a 94,489,280,512-byte peak request and 23,622,320,128-byte reserve; 123,318,820,864 bytes were free at observation time, so the exact read-only host gate passed. Hyper-V/vTPM/Secure Boot operations, IMAPI, the system-managed construction switch, and the 4 GiB guest-memory request also passed without UAC.

Repository preflight and the focused Windows suites currently pass. They prove composition, parsing, ownership rejection, recovery decisions, real IMAPI media creation, real Windows XML/PowerShell parsing, a real host current-user protection round trip, and rejection of native-build version drift. They do not prove Windows Setup, installer behavior, Sysprep, or the resulting VHDX until approved media is supplied and the physical canary completes.

## Exact next frontier

1. Through setup, select an already-owned official Windows 11 x64 ISO or follow the official Microsoft acquisition handoff, then resume discovery and record the Microsoft-published SHA-256 reference. Evaluation remains a separate explicitly temporary choice.
2. Run inventory before approval, select the exact intended edition/index, construct the content-addressed authority/config, then run the physical canary.
3. Resolve any physical-only installer/tool/Sysprep defect inside its owning adapter; never substitute GUI automation, guest UAC, host compilation, Evaluation media, or a model fallback.
4. Admit the generalized image, materialize the Windows profile, enroll its fresh non-admin routine identity, and execute the dual Windows/Ubuntu C acceptance path.
