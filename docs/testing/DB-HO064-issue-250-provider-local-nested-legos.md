# DB-HO064: provider-local nested LEGO internals

Date: 2026-08-28

Issue: #250

Status: implementation complete locally; hosted qualification pending. This document authorizes no setup, elevation, service, provider, image, environment, VM, guest, repository-execution, or publication effect.

## Assessment

The provider edge is allowed to be concrete, but three provider-owned parents currently combine enough independent mechanics that a bounded change requires loading unrelated state and failure paths:

- `HyperVPersistentEnvironment` owns its stable public lifecycle contract but its core also combines request validation, deterministic provider identity, durable records, admitted base-image paths, VHDX lineage checks, PowerShell transport, VM observation, provisioning recovery, bounded stop, and owned retirement.
- `LibvirtPersistentEnvironment` owns the same neutral lifecycle shape through a separate concrete adapter, while its core combines a distinct qcow2 overlay chain, domain XML/metadata identity, virsh observation, graceful/forced lifecycle, and exact domain/storage cleanup.
- `HyperVImageConstruction` owns the image-build state machine but combines request/media admission, durable intent, Hyper-V construction operations, observation validation, install liveness, console evidence encoding, installation/boot transitions, qualification, retention, and discard recovery.

The caller-facing parents and their exact method/return shapes must remain stable. Hyper-V and libvirt are separate provider domains: their native terms are valid inside their own trees, but neither provider may import, name, branch on, or normalize itself against the other. The provider adapters continue to receive execution-profile identity rather than repository identity. No nested child may obtain broader path, provider, execution, or deletion authority than its local contract.

Durable protocols and recovery behavior are frozen for this structural work:

- Hyper-V persistent environment: `devbridge/hyperv-persistent-environment-v1`;
- libvirt persistent environment: `devbridge/libvirt-persistent-environment-v1`;
- Hyper-V image construction: `devbridge/hyperv-image-construction-v2`;
- exact provider UUID/marker/name and source/writable filesystem identities;
- exact VHDX parent and qcow2 two-layer backing-chain checks;
- intent-before-effect writes and observe/reconcile-before-repeat behavior;
- graceful stop followed only by an explicit bounded forced path;
- retirement only after exact ownership, stopped state, lineage, and contained local-path revalidation.

## Primary-source research

- Microsoft documents `New-VHD -ParentPath ... -Differencing` as the provider-native creation of a VHDX differencing child. Microsoft troubleshooting guidance uses `Get-VHD` `Path`, `ParentPath`, and `VhdType` to inspect differencing chains. The Hyper-V environment child must therefore retain exact parent-path/type observation rather than infer lineage from filenames: <https://learn.microsoft.com/en-us/powershell/module/hyper-v/new-vhd>, <https://learn.microsoft.com/en-us/troubleshoot/windows-server/virtualization/hyper-v-snapshots-checkpoints-differencing-disks>.
- Microsoft documents distinct start and shutdown operations through the Hyper-V PowerShell module, and `Stop-VM` separately supports shutdown, turn-off, or save behavior. The lifecycle owner must preserve the current cooperative-first transition and make the forced turn-off an explicit caller-authorized fallback: <https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/powershell>, <https://learn.microsoft.com/en-us/powershell/module/hyper-v/stop-vm>.
- QEMU documents that `qemu-img create -b` records only differences from the backing image and does not modify that backing image, while `qemu-img info --output=json --backing-chain` returns the chain as structured data. The libvirt storage child must keep the explicit `-f qcow2 -F qcow2 -b` creation and exact two-layer structured inspection: <https://www.qemu.org/docs/master/tools/qemu-img.html>.
- libvirt documents a file-backed qcow2 disk and its explicit `backingStore` chain in domain XML. The domain definition must retain both top-level source and backing-store identity rather than relying only on qcow2 metadata: <https://libvirt.org/formatdomain.html>.
- libvirt documents that a guest may ignore graceful shutdown and that forceful destroy can risk unflushed guest disk state. This supports the existing bounded shutdown observation followed by `destroy` only when `force` is explicitly true: <https://www.libvirt.org/html/libvirt-libvirt-domain>.
- libvirt's virsh contract keeps domain definition, start/shutdown/destroy, observation, and undefinition as distinct operations. Domain removal therefore cannot be treated as permission to delete storage; the adapter must separately revalidate exact owned storage lineage before local deletion: <https://www.libvirt.org/manpages/virsh.html>.

## Reassessment

A shared `hyperv-or-libvirt` utility would erase important semantic differences and create the cross-provider coupling prohibited by DB-020. Splitting every provider command into a tiny file would be size theater and would make recovery sequencing harder to audit. The smallest complete structure keeps three independent parents and gives each provider its own locally coherent children.

### Hyper-V persistent environment

1. A provider-local **contract owner** validates settings/source values, derives deterministic name/marker/binding identity, admits exact base media beneath the configured source root, and validates durable record topology.
2. A provider-local **ledger** owns the exact v1 JSON record file, real-directory/file checks, and atomic replacement.
3. A provider-local **management channel** owns PowerShell encoding, bounded invocation/result parsing, provider scripts, machine observation, provisioning, and lifecycle commands. It cannot persist records or delete local storage.
4. A provider-local **storage lineage owner** revalidates parent/child filesystem identities and interprets exact VHDX inspection evidence. It cannot create/remove a VM or choose paths.

### libvirt persistent environment

1. A provider-local **contract owner** validates settings/source values, derives deterministic name/UUID/marker/binding identity, admits exact qcow2 media, validates durable record topology, and renders the provider-owned domain definition.
2. A provider-local **ledger** owns only the exact v1 durable record file and atomic replacement.
3. A provider-local **domain channel** owns bounded virsh invocation plus exact name/UUID/marker/disk-attachment observation and lifecycle/definition operations. It cannot delete local storage or alter record authority.
4. A provider-local **overlay lineage owner** owns qemu-img creation and structured two-layer backing-chain observation. It cannot define/remove a domain or select another source.

The two provider trees may have similar English descriptions, but they do not share code or imports. Their contracts remain provider-local because the backing models, identities, tools, and recovery conditions differ.

### Hyper-V image construction

1. A **request owner** validates the bounded construction contract and derives provider-local deterministic names/markers/disk identity.
2. A **ledger** owns only the exact v2 construction record file and atomic replacement.
3. A **media owner** admits and revalidates exact byte-count/digest media beneath the source root.
4. A **management channel** owns the PowerShell scripts and bounded concrete construction commands/observations; it cannot advance the durable phase.
5. An **observation owner** validates provider output and projects the exact public status contract.
6. An **install-liveness owner** computes and validates the durable timing/progress checkpoint without operating a machine.
7. A **console-evidence owner** validates fixed provider image bytes and atomically publishes bounded BMP evidence without changing machine state.

The parent alone sequences durable phase transitions (`planned` -> `prepared` -> `installing` -> `qualifying` -> `qualified` -> `retained`), supplies current topology to children, and reconciles ambiguous provider effects.

## Scoped plan

1. Freeze public exports, method names, argument/return shapes, durable protocols, provider command payloads, exact diagnostics, and recovery order.
2. Extract the Hyper-V persistent-environment children and delete moved code from its core; add direct child and parent-isolation tests.
3. Independently extract the libvirt persistent-environment children; retain explicit qcow2/domain XML and graceful/forced lifecycle behavior.
4. Extract the Hyper-V image-construction request, ledger, media, management, status, liveness, and console responsibilities; leave all phase authority in the parent.
5. Add a provider-local topology gate proving children import no sibling/local implementation, Hyper-V/libvirt trees do not name one another, generic/higher layers still import only the parent surfaces, and no repository/model/remote-service topology enters provider-local children.
6. Run focused normal/failure/recovery/boundary tests, repeated recovery stress, repository preflight, the complete suite, `git diff --check`, and exact hosted Windows/Ubuntu CI.
7. Close #250 only after the exact hosted commit passes. Update #244 with the qualification evidence.

## No-elevation boundary

Through at least 2026-08-31 this work is software-only. It must not invoke Hyper-V, install or activate a service/provider/image/environment, start/stop/create/remove a physical VM, run a guest operation, request UAC, retry elevation, or attempt an elevation bypass. Protected activation and real-provider qualification remain deferred.

## Implementation checkpoint

The three concrete provider parents retain their existing caller-facing exports and methods while composing independent provider-local trees:

- Hyper-V persistent environment: request/identity contract, exact v1 ledger, PowerShell management channel, and VHDX/filesystem lineage owner;
- libvirt persistent environment: request/identity/domain-definition contract, exact v1 ledger, virsh domain channel, and qemu-img qcow2 overlay-lineage owner; and
- Hyper-V image construction: request/identity contract, exact v2 ledger, media admission, PowerShell construction channel, status/address observation, install liveness, and console-evidence publication.

Only each parent knows its current child topology. Nested children import no sibling or local implementation. The Hyper-V trees contain no libvirt/QEMU/qcow2/virsh identity, the libvirt tree contains no Hyper-V/PowerShell/VHDX identity, and no child names repository, GitHub, Codex, or remote-agent topology. Higher layers continue to import only the provider parents. Moved code was deleted; no wrapper, legacy route, generic cross-provider helper, or alternate lifecycle authority remains.

The exact embedded Hyper-V environment and image-construction PowerShell programs compare byte-for-byte with their pre-extraction versions. Existing provider identities, markers, durable protocols, record shapes, command payloads, VHDX/qcow2 lineage checks, intent-before-effect order, lifecycle/phase transitions, ambiguous-effect reconciliation, and cleanup checks remain unchanged.

Local qualification on 2026-08-28:

- direct nested-owner plus provider parent and Stage-3 boundary proofs: 30/30 passed;
- dependent Windows/Ubuntu physical-canary composition and environment-foundation proofs: 36/36 passed;
- five repeated provider-local normal/failure/recovery/boundary runs: 26/26 passed per iteration;
- repository preflight: 168 syntax files, 2 JSON files, and 137 targeted test files passed;
- complete suite: 1,713 total, 1,698 passed, 15 expected platform skips, zero failures;
- exact provider-command program comparison and `git diff --check`: passed.

No UAC request, elevation attempt/bypass, protected operation, physical provider/VM/image/environment/guest action, repository execution, or real publication occurred. Commit and push the exact checkpoint, then require hosted Windows/Ubuntu qualification before closing #250.

## Accepted hosted qualification

GitHub Actions run `33217939931` passed on exact implementation commit `03aa340d3ae5e130bdaa0ff1e40c269ad6cb2193`: Windows serialized complete suite plus doctor, Windows bounded preflight/identity/standalone-installer regression, Ubuntu complete suite plus doctor, and Ubuntu bounded preflight/identity/standalone-installer regression all completed successfully. Issue #250 may close. No UAC, protected local activity, or physical provider/VM/guest action occurred.
