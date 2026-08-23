# Fresh-host image provisioning and Windows licensing

Issue #192 owns the missing installation layer between provider capability and the immutable image/recovery machinery in #178.

This document is normative for a **regular-user fresh install**. Do not design installation around facts from a developer workstation, an existing VM fleet, a prepared ISO, an existing product key, a particular GitHub owner, or a pre-existing image cache.

## Blank-slate rule

Setup begins with no assumptions about:

- Hyper-V, KVM, QEMU, libvirt, image-construction utilities, or management privileges;
- existing DevBridge VMs, disks, images, source media, or artifact repositories;
- whether the user needs Windows, Linux, both, or neither immediately;
- Windows edition, media, activation method, virtualization entitlement, or prepared-image distribution rights;
- GitHub repository/Release creation permission;
- network availability, free storage, reboot/elevation state, or durable local cache;
- any prior DevBridge config file, image authority, package snapshot, signing keyring, payload generation, provider object name, or helper script.

Safe discovery may establish facts. Discovery never grants authority.

## One-command regular-user contract

A regular user should be able to start from a blank supported machine, run one trusted DevBridge bootstrap/setup invocation with reasonable-default options, and reach an operational DevBridge installation without manually reading or authoring internal configuration.

The one command may carry bounded local consent for routine setup work. Non-interactive/default mode means **choose every safely defaultable value automatically**, not bypass verification or authority boundaries.

The user must not be required to manually construct:

- DevBridge JSON configuration;
- Ubuntu source/checksum/signature/keyring records;
- archive snapshot timestamps or exact package pins;
- guest-payload generations;
- physical-canary configuration;
- VM/provider object names;
- image-library subjects or helper scripts.

Those are internal implementation details owned by the accepted runtime and its local setup authorities.

Setup may stop only for a genuine non-defaultable boundary such as missing authentication, required elevation/UAC, a reboot/session restart, an unresolved legal/licensing choice, a resource conflict, or a policy decision for which DevBridge cannot safely choose on the user's behalf. Durable setup state must resume after that boundary rather than restarting from zero.

Successful setup must also install a stable `devbridge` command on the user's persistent PATH and verify command resolution before declaring success. Normal post-install instructions use `devbridge ...`, not internal Node paths.

## Four independent authorities

Do not collapse these into one configuration object.

1. **Image construction authority** selects an approved OS/source-media identity and reproducible construction recipe.
2. **Image distribution authority** selects whether and where the resulting prepared bytes may be stored and reacquired.
3. **Activation authority** selects how a materialized Windows VM is licensed/activated.
4. **Environment declaration authority** selects the exact image/profile/bootstrap/resource policy that the user approved.

A product key, MAK, KMS endpoint, directory activation state, subscription identity, or other activation material is not part of the canonical base-image identity. The generalized base image contains no user activation secret.

## User flow

### 1. Discover before prompting

The accepted runtime discovers the host OS/architecture, virtualization capability, provider state, free storage, GitHub authentication/identity, existing DevBridge-owned state, required image tools, repository candidates, and reboot/elevation prerequisites read-only.

Setup then applies reasonable defaults and asks only for unresolved choices or explicit consent that was not already supplied by the local setup invocation.

Repository selection is separate from VM provisioning. Execution profiles own VMs; repository count does not determine VM count.

For eligible repositories discoverable through the authenticated GitHub identity:

- when there are **30 or fewer**, select all by default and proceed without a repository-selection prompt;
- when there are **31 or more**, stop at repository selection and ask which to include; `all` remains an explicit choice;
- never silently truncate the repository set to the first 30.

Repository eligibility/capability must still be verified; archived, read-only, inaccessible, or otherwise unsuitable repositories are reported truthfully.

### 2. Select required execution profiles

The ordinary reasonable-default installation path selects the supported Linux/Ubuntu execution profile. The user may explicitly request Windows, both, none/defer, or later specialized profiles when their owning roadmap gates are open.

A Linux-only install is not blocked by Windows media/licensing questions. Windows remains an explicit profile because media/licensing/activation/distribution choices may require genuine user decisions. Specialized profiles such as CUDA remain gated by their own roadmap issues.

### 3. Establish provider prerequisites

Setup proposes or performs only the provider changes required for selected profiles and covered by the local setup invocation's authority. Hyper-V feature/authorization/reboot changes and KVM/QEMU/libvirt package/service/group/provider changes remain explicit local operations with restartable setup state.

Remote tasks, repository content, or model output cannot authorize these changes.

If elevation or a reboot is unavoidable, setup checkpoints exact progress, instructs the user on the minimum required action, and resumes from that checkpoint afterward.

### 4. Establish source-media authority

Ubuntu/Linux construction uses an approved official source plus pinned checksum/signature policy. The accepted runtime owns the default official Ubuntu source identity, signature/keyring handling, deterministic recipe generation, package snapshot selection, exact package resolution, and local payload binding. These are not first-run questions for a normal user.

Windows construction uses one approved source class, for example:

- official Microsoft media already owned by the user;
- a DevBridge-assisted official Microsoft acquisition path where stable automation and terms permit it;
- organization-provided approved media;
- a locally configured enterprise/offline source.

Unofficial repacks, torrents, and mirrors are not acceptable automation fallbacks.

Windows Evaluation media is an explicitly temporary evaluation path only. It cannot silently become the durable production default.

### 5. Establish Windows activation authority separately

Supported activation-method families may include, where applicable:

- retail/product key;
- MAK;
- KMS client activation;
- Active Directory-based activation;
- subscription/organization activation;
- configure later.

The host's OEM/digital activation is not assumed reusable for a VM. DevBridge does not silently multiply a one-device entitlement across additional Windows execution profiles.

Secret-bearing activation material is stored only through a narrow host-local protected-secret capability and referenced by opaque identity such as `activationAuthorityRef`. It is never serialized into normal configuration, Git, GitHub, issues, logs, evidence, exported setup templates, or generalized base images.

An implementation may use a platform-specific protected secret store such as Windows DPAPI, but generic contracts remain method/platform neutral.

### 6. Build and qualify the canonical image

Construction uses owned disposable build subjects and ends in one canonical immutable provider-compatible image.

Every production base must provide the common profile-level capabilities required by the current guest bootstrap contract, including:

- Git;
- supported Node.js and npm;
- CMake and CTest;
- usable C and C++ compiler capability;
- system package management;
- networking;
- current DevBridge guest/bootstrap helpers.

Before capture, a real network + CMake -> compile -> CTest canary must pass.

The supported setup path owns the internal read-only preflight/status gate and may proceed to mutation only after that gate is ready. Users do not manually invoke internal physical-canary entrypoints or prepare their configuration.

Windows construction additionally requires:

- approved official source media;
- provider-compatible VHDX construction through the owning Windows/provider adapters or bounded native tooling;
- reproducible tooling provisioning;
- removal of build credentials/secrets/source residue;
- successful supported Sysprep generalization and shutdown;
- no activation secret in the captured base.

Ubuntu/Linux construction additionally requires removal/regeneration of machine-specific identity and build-only credentials before final capture.

Generic image/lifecycle modules do not learn Windows installer paths, Ubuntu autoinstall fields, product keys, provider commands, or artifact-repository names.

### 7. Package through the existing #178 contract

Do not invent another artifact format.

The required order is:

`canonical image -> encode the complete image -> measure the complete encoded object -> chunk only for transport`

The current initial codec is Zstandard with the exact parameters recorded in the manifest. The current codec implementation uses:

- level `9`;
- checksum enabled;
- one thread.

The current GitHub transport chunk bound is exactly 1 GiB (`1,073,741,824` bytes).

Never chunk the raw VHDX/qcow2 first. Never produce independently compressed multipart streams.

The existing `devbridge/image-artifact-manifest-v1` remains authoritative and binds canonical-image, complete encoded-object, and ordered transport-object integrity.

### 8. Select distribution policy

A normal install must not hard-code a developer repository.

For the initial GitHub Releases adapter, setup may propose a private repository derived from the authenticated owner:

`<authenticated-owner>/devbridge-base-images`

The user may choose another authorized personal/organization repository. Setup first checks whether its credential can create/use the repository and Releases; insufficient permission becomes a focused recoverable setup step.

The artifact repository is distribution policy, not image identity. Generic image code consumes only the source-neutral acquisition contract.

#### Windows distribution-rights gate

Activation rights and prepared-image distribution/storage rights are separate.

Private GitHub hosting does not by itself prove that the selected Microsoft source/license permits storing or redistributing a prepared Windows VHDX. Setup must obtain explicit local confirmation/policy before publishing prepared Windows bytes.

Windows therefore supports two durable recovery-source modes:

- **remote artifact** — the exact generalized image may be published to the approved private source and later reacquired through #178;
- **local reconstruction/regeneration** — prepared bytes are not remotely published; durable authority retains the approved source-media identity and versioned construction recipe so a replacement canonical image can be constructed locally.

Ubuntu/Linux may use remote immutable artifacts when the applicable upstream/source terms permit it.

### 9. Reconstruction identity rule

A construction recipe is not automatically a canonical image identity.

Rebuilding a Windows VHDX from the same source media and recipe can legitimately introduce fresh container/guest metadata, timestamps, servicing results, or other bytes. DevBridge must not claim byte determinism unless the exact construction path has proved it.

A local reconstruction/regeneration therefore has two possible results:

1. **Exact deterministic reproduction** — the rebuilt canonical file has the expected size and SHA-256, so it is the same image subject and may satisfy the current declaration.
2. **New qualified canonical result** — the build used the exact approved source/recipe and passes all construction/tooling/provider qualification but has a different canonical digest. It is admitted as a **new immutable image subject/generation**. It cannot silently satisfy the old declaration. A separate explicit local image-regeneration/declaration-rebind migration must authorize the new image subject before `create`/`rebuild` consumes it.

If deterministic reproduction has not been demonstrated for the exact construction path, assume the second outcome. Never weaken canonical digest verification or reuse an old image identity for different bytes.

### 10. Prove remote artifacts before accepting them

For a remote artifact, publication is not complete at upload.

1. create/upload the exact release manifest and transport objects;
2. persist the exact numeric release subject, manifest asset identity, and pinned manifest SHA-256;
3. reacquire through the real #178 source adapter into an empty cache;
4. verify every transport object, the complete encoded stream, reconstructed canonical size/digest, and provider-native media compatibility;
5. boot-test the reconstructed image;
6. only then mark the release accepted by local policy.

A release/tag name is discovery metadata, not image authority.

### 11. Materialize, activate, and finish setup

#171 `create` consumes the exact approved image subject and creates a new implementation generation.

Windows activation happens after materialization through the separate activation authority. It is preparation/readiness state, not image identity or image acquisition state.

Status/doctor should distinguish at least:

- provider ready;
- image ready;
- guest/bootstrap/tooling ready;
- activation configured;
- activation valid;
- repository execution ready.

`configure later` may leave a Windows profile explicitly `activation-required`; DevBridge must not replace that choice with Evaluation media or direct-host fallback.

Before first-run setup reports success it must also:

1. create/verify repository workspace routes for the selected repositories;
2. verify the promised VM-only execution path;
3. install/persist the stable `devbridge` PATH command without replacing an unrelated executable;
4. verify command resolution, or explicitly state that a new shell is required for a newly persisted PATH value;
5. emit a concise welcome/success handoff showing what is ready and how to proceed.

The completion handoff should tell a normal user at minimum how to:

- start/continue using DevBridge (`devbridge`);
- inspect status/health (`devbridge status`, `devbridge doctor`);
- re-enter setup and make changes (`devbridge setup`).

It should summarize selected profile readiness, repository/workspace count, physical execution-environment count, and any non-blocking deferred capability. Raw internal JSON/subjects are not a substitute for the successful operator handoff.

## Recovery

#173 rebuild must not depend on the old system disk for either image supply or licensing configuration, but rebuild itself still consumes the **exact image subject in the current declaration**.

Image recovery:

- verified local cache -> use exact image;
- approved remote artifact -> #178 reacquires exact image;
- local construction reproduces the exact canonical digest -> admit/use the existing image subject;
- local construction produces a different qualified digest -> admit a new immutable image subject, stop rebuild, require explicit declaration rebind/migration, then rebuild from the newly approved subject;
- no exact cache/artifact/source -> report a typed reconstruction-source blocker; never substitute another generation.

After Windows rebuild materializes a new implementation generation, the same locally owned activation authority is reapplied/reconciled when required.

## Re-entry and uninstall

Setup is a durable configuration-management workflow, not a one-shot installer. The supported re-entry command is `devbridge setup`.

Re-entry can:

- add Windows later;
- change source-media policy;
- replace/rotate activation authority;
- change private artifact source;
- add/remove repositories or change execution profiles/resources;
- switch from local reconstruction to approved remote artifact storage when policy changes;
- perform the explicit image-regeneration/declaration-rebind migration when a locally regenerated canonical image has a new digest;
- repair provider/image/recovery authority without reinstalling unrelated components.

Sanitized export contains no activation secret and no blindly transferable host/license authority.

Uninstall distinguishes application removal, PATH launcher removal, VM removal, local image/cache removal, activation-secret removal, and remote artifact deletion. Remote user artifacts and operator-owned license/provider infrastructure are preserved by default.

## Completion gate

The image supply chain is not production-ready because #178's core code passes synthetic artifact tests. Production readiness requires real blank-slate Windows and Linux canaries that begin without a DevBridge image cache and reach VM-only repository execution through supported setup/recovery surfaces.

For ordinary Linux blank-slate qualification, success must begin from the one-command setup surface, require no pre-authored config/keyring/snapshot/package/payload/canary files, apply the <=30 repository default rule, install the PATH command, and end with the successful welcome/operator handoff.

Issue #192 is the integration owner for this missing fresh-host layer. #115, #116, #169, #178, and #180 must treat it as part of whole-path acceptance. CUDA issue #186 remains post-recovery.
