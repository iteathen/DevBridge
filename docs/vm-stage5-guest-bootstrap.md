# VM Stage 5 — guest bootstrap, network-on development state, and capability observation

Status: Stage 5 implementation contract and focused verification record.

Stage 5 builds on the Stage 4 environment-bridge head `deb819d9214f77e810d721b26fbab6001daec915` and implements issue #113 without restoring normal repository-controlled execution. Production `src/app/runtime.js` remains on the Stage-1 explicit no-provider/fail-closed repository-execution path. Stage 6 alone reconnects normal repository execution.

## LEGO boundary

Stage 5 deliberately separates four responsibilities.

- `src/runtime/environment-bootstrap.js` owns only a provider-neutral bootstrap contract. Its external studs are neutral: `basis`, `plan`, `prepare`, `exchange`, and optional `cycle`. It knows no host provider, transport, lifecycle implementation, guest path, repository controller, package manager, or concrete development tool.
- `src/guest/environment-bootstrap-agent.mjs` owns guest-local readiness observation and one durable bootstrap-generation record. It maps neutral capability identities to guest-local executable observations, distinguishes presence from usability, performs bounded DNS/HTTPS checks, and reports protected environment-variable **names only**.
- `src/runtime/providers/hyperv-environment-bootstrap.js` and `src/runtime/providers/libvirt-environment-bootstrap.js` own only their respective host-platform preparation details. Neither derives Stage-3 VM/domain names or ownership markers internally; composition injects an exact neutral locator.
- `src/app/environment-bootstrap.js` is composition. It is the only Stage-5 module that knows the current Stage-3 lifecycle, Stage-4 bridge, concrete provider selection, guest family, current object naming/topology, and fixed guest helper locations.

This follows the transient-topology rule: the reusable bootstrap component describes only what it needs locally. Current lifecycle/bridge/provider wiring can be replaced without changing the component's internal logic.

## Reproducible bootstrap generation

The bootstrap generation is a SHA-256 identity over:

- exact current environment subject;
- environment generation;
- profile and guest variant;
- immutable base-image identity, revision, and digest;
- local bootstrap recipe revision;
- required neutral capability identities;
- protected environment-name policy;
- network-readiness requirement;
- bootstrap protocol/version.

The guest records the generation only after all required observations are ready. A stale record, a new environment generation, a reseed to another base image, a changed recipe, or changed local policy therefore cannot silently masquerade as current bootstrap state.

Reset/reseed already replaces the Stage-3 writable layer and changes the exact environment identity/generation. Stage 5 binds its record to that exact basis; a replacement environment starts with no valid Stage-5 generation until it is prepared and observed again.

Host DNS observations are filtered before projection: loopback, link-local, unspecified, multicast, and non-IPv4 values are not meaningful guest resolvers. If no usable IPv4 resolver remains, the bounded seed uses the fixed public fallback already defined by this adapter.

## Baseline development capability contract

The default Stage-5 plan requests neutral capability identities rather than concrete upstream/downstream names:

- `source-control`
- `runtime-js`
- `build-config`
- `test-runner`
- `compiler-c`
- `compiler-cxx`
- `package-project`

The guest-local adapter currently maps these to the practical baseline requested by #113: Git, Node.js, CMake, CTest, a usable C compiler, a usable C++ compiler, and npm. `package-system` is also observable when requested, using a bounded OS-local candidate set, but it is not a universal default because system package managers differ by guest profile.

Presence and usability are separate fields. Finding a command name does not make it usable: the guest runs a fixed bounded version/health probe and reports `present` and `usable` independently. Unknown capability identities are absent/unusable rather than converted into arbitrary guest execution.

Concrete command names exist only in the guest-local capability adapter. The provider-neutral bootstrap core never names Git, Node, CMake, CTest, compilers, npm, package managers, or guest executable paths.

## Base image versus repository-persistent state

Stage 5 keeps the DB-020 split explicit.

Common baseline components belong to the immutable/versioned image/bootstrap contract, including:

- supported Node runtime;
- Git;
- CMake/CTest;
- baseline compilers/SDK support;
- guest integration service needed by the selected host family;
- Stage-4 bridge helper;
- Stage-5 bootstrap helper;
- on Hyper-V profiles, the fixed network-seed receiver service.

Repository-specific package installs, dependency trees, build outputs, compiler caches, generated tools, and other ordinary development additions belong in the Stage-3 writable layer. They are not projected from host PATH or arbitrary host directories. They survive normal command completion and VM stop/start because they are ordinary persistent guest state, and reset/reseed discards them with the writable layer.

Stage 5 does not create a second package-install orchestration language. Stage 6 will route locally admitted repository operations through the existing Stage-1/Stage-4 studs; ordinary package/tool installation then happens inside the guest through normal guest mechanisms.

## Network-on behavior

Networking remains enabled by default as required by DB-020. The bootstrap generation is not considered ready until the guest can perform both:

- real DNS name resolution; and
- a bounded HTTPS request.

The current guest health target is deliberately ordinary public Internet infrastructure, not a DevBridge credentialed service. Stage 7 owns provider/guest qualification under real deployment networking and may refine the qualification endpoints without changing the generic bootstrap contract.

No DevBridge-specific egress proxy is introduced. Confidentiality continues to come from keeping host authority out of the guest.

## Hyper-V preparation

Stage 2 owns the DevBridge internal switch/NAT but Windows NAT does not itself provide guest DHCP. Stage 5 therefore supplies a deterministic, host-owned static-address seed for each active environment.

The Hyper-V Stage-5 adapter:

1. receives the exact current VM reference/ownership proof and exact owned network reference/proof through the injected `locate(target)` stud;
2. verifies both objects;
3. ensures exactly one VM network adapter exists and connects it to the owned internal switch;
4. enables the Hyper-V **Guest Service Interface**;
5. allocates a collision-free address from the owned `/24` using a small provider-local durable allocation registry;
6. after the VM is running, copies one bounded `devbridge/network-seed-v1` JSON object into the guest through `Copy-VMFile`;
7. retries only that exact overwrite while the integration service becomes ready;
8. after an initial copy failure, performs at most one ownership-checked disable/enable reset of that VM's Guest Service Interface before continuing the bounded retries;
9. if that bounded recovery is exhausted, requests one lifecycle cycle through the owning composition boundary and retries the exact seed after restart;
10. exposes the allocated address only through the local connection stud used by current composition;
11. prunes stale allocations from the current active-environment set during reconciliation.

For Linux guests, Hyper-V's file-copy daemon combines the destination directory with the host source basename. The adapter therefore creates an installation-owned temporary directory containing the fixed basename `network-seed.json` and supplies `/var/lib/devbridge/bootstrap` as the destination directory. Random source basenames or a filename-shaped Linux destination are rejected by real `hv_fcopy_daemon` behavior and must not be reintroduced.

Exhausted guest-file-service readiness after the one allowed lifecycle cycle is a typed provider failure. Candidate admission retries that exact infrastructure failure on the normal update interval; it does not misclassify the candidate source as permanently bad. The reset and cycle remain bounded to the exact owned running environment and never introduce a host-filesystem or network fallback. The Hyper-V attachment requests the cycle; the environment-foundation composition that owns lifecycle authority performs it.

This replaced the earlier KVP-write approach. Hyper-V management methods may return asynchronous `4096` jobs, which would require a separate job reconciliation contract. The Guest Service Interface/`Copy-VMFile` path is documented for both Windows (`vmicguestinterface`) and Linux (`hv_fcopy_daemon`) guests and avoids using KVP mutation as an additional Stage-5 effect surface.

References:

- https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/integration-services
- https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/manage/manage-hyper-v-integration-services
- https://learn.microsoft.com/en-us/powershell/module/hyper-v/copy-vmfile
- https://learn.microsoft.com/en-us/powershell/module/hyper-v/connect-vmnetworkadapter

### Hyper-V guest seed receiver

`src/guest/network-seed-agent.mjs` is guest-local operational machinery intended to be installed/enabled in compatible base images.

It consumes only the fixed bounded network seed. On Linux it applies the address/route with `ip` and DNS with `resolvectl`; on Windows it uses a fixed local PowerShell network configuration routine. A watch mode permits the host copy to arrive after guest boot. The seed contains no host credential, host path, executable authority, Git state, publication state, or provider-management capability.

The guest is untrusted and may ignore/tamper with the seed. Readiness is therefore established later by actual guest DNS/HTTPS observation, not by trusting a claimed seed-apply result.

## KVM/QEMU/libvirt preparation

The libvirt Stage-5 adapter receives the exact current domain identity/ownership proof and exact owned network reference/proof through the neutral locator.

It verifies `qemu:///system` state and then ensures the persistent domain configuration contains:

- one interface sourced from the DevBridge-owned NAT network; and
- one virtio channel named `org.qemu.guest_agent.0`.

If either persistent device is missing while the domain is running, the adapter requests a lifecycle cycle instead of inventing hotplug assumptions. Composition stops the owned environment through the Stage-3 lifecycle stud, applies the missing persistent devices, and starts it again.

After start, the adapter uses a bounded `guest-ping` through QEMU Guest Agent only as readiness observation. QGA remains untrusted guest-controlled transport. Stage 4 continues to re-bind and validate every actual bridge request/response.

References:

- https://libvirt.org/formatdomain.html
- https://libvirt.org/formatnetwork.html
- https://wiki.libvirt.org/Qemu_guest_agent.html
- https://qemu.readthedocs.io/en/master/interop/qemu-ga-ref.html

## Guest bootstrap protocol

Protocol: `devbridge/environment-bootstrap-v1`

The common contract supports only two actions:

- `inspect`
- `apply`

Each request binds exact protocol, request identity, target identity, expected generation, exact basis digest, recipe revision, required neutral capability identities, protected environment names, and the network requirement.

The guest response echoes protocol/request/target/action and returns bounded observations:

- applied generation/basis/revision, or `null` when the exact generation is not applied;
- DNS and HTTPS readiness;
- capability `present`/`usable`/bounded version/reason;
- protected environment names found;
- bounded reason text.

The host validates response identity and shape. A compromised guest can still forge a syntactically valid ready response; that is untrusted capability observation, not authority or verification evidence. Stage 7 performs the real compromised-guest/security qualification.

## Host-secret boundary

The default protected-name policy includes control-plane token/signing/coordination names such as `GITHUB_TOKEN`, `GH_TOKEN`, `SSH_AUTH_SOCK`, and DevBridge control-key variables.

The guest helper returns only intersecting **names**, never values. Focused tests inject a sentinel secret value and prove that the serialized response never contains it.

This is defense/evidence, not the primary confidentiality mechanism. The primary rule remains: host GitHub credentials, publication SSH/signing authority, coordination private keys, daemon/control state, and provider-management authority are never intentionally supplied to the guest. Stage 4 also constructs a small guest operation environment rather than inheriting host/provider service variables.

Dedicated guest-management credentials are guest-domain credentials. They do not grant host authority and are resolved only from local configuration.

## Lifecycle continuity

The generic bootstrap exposes an optional neutral `cycle` stud and can verify continuity across a stop/start cycle.

A successful continuity check requires:

- the exact basis digest to remain unchanged;
- the same bootstrap generation to remain ready after the cycle;
- required capabilities still usable;
- network health restored;
- no protected names observed.

A target substitution, generation change, reseed, or other basis change fails the continuity check rather than being accepted as the same environment.

## Bounded startup settling

Guest services and networking may legitimately become ready after the VM itself reaches a running state. Production Stage-5 composition therefore allows a bounded settling window after provider activation. It repeats only the same declarative `apply` for the exact expected bootstrap generation; the guest writes the generation record only after prerequisites are actually ready.

There is no direct-host fallback if the guest never becomes ready.

## No repository-execution restoration

Stage 5 does not import or register a production repository-execution provider and does not change `src/app/runtime.js`.

The new Stage-5 composition is an explicit setup/qualification surface only. Normal deterministic repository operations, proposal workers, package/build/test routing, browser execution, and candidate-controlled validation remain fail-closed until Stage 6 connects the persistent environment through the established Stage-1 execution studs.

Provider/bootstrap unavailability never redirects work to a host shell, host process runner, Bubblewrap, AppContainer, ProcessContainer, or `allowUncontainedTools` compatibility path.

## Verification completed in the focused harness

The Stage-5 focused suite covers:

- deterministic generation identity and invalidation;
- exact response binding and forged-target rejection;
- presence-versus-usability semantics;
- required capability failure;
- protected-name failure without value disclosure;
- network-readiness gating;
- continuity/basis substitution rejection;
- durable guest generation across helper process restart;
- unknown capability fail-closed behavior;
- real local probes of Git, Node, CMake, CTest, C/C++ compilers, and npm using the same guest observer;
- Hyper-V owned-network/NIC preparation;
- Hyper-V bounded seed transfer and durable collision-free address allocation/reconciliation;
- libvirt owned-network and fixed QGA-channel persistent attachment;
- libvirt cycle request instead of unsafe hot mutation;
- static LEGO gates proving the generic core contains no provider, bridge, lifecycle, repository-execution, or concrete-tool identities;
- provider adapters do not name/import one another or derive the Stage-3 persistent object topology;
- Stage-5 composition does not reconnect production repository execution.

Real Hyper-V/KVM provider execution, real Windows/Linux guest matrix behavior, reboot behavior under actual integration services, DNS/HTTPS/package installation, filesystem/reparse details, and compromised-guest security claims remain Stage-7 qualification subjects on virtualization-capable runners. Hosted mock/unit coverage is not represented as hypervisor security evidence.

## Stage-6 handoff

Stage 6 may rely on these Stage-5 studs only as local observations/configuration:

- exact environment bootstrap readiness;
- exact bootstrap generation/basis;
- neutral guest capability observations;
- current locally resolved connection metadata needed by the Stage-4 attachment.

Stage 6 must still preserve the Stage-1 execution/input/result contracts and DB-017 host-authoritative source/candidate identity. It must not pass Stage-5 provider objects, guest paths, package-manager identities, network seeds, VM/domain names, or transport settings upward into controller/business logic.
