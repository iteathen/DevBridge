# DB-HO089 — Windows Hyper-V read-only physical preflight

Date: 2026-08-30

Status: exact current physical-host preflight passed twice without elevation or mutation; provider construction prerequisites are not the active operational blocker

## Scope and authority

This checkpoint advances only read-only Windows-host evidence below the current protected-service refresh gate. It observes the provider, system-managed construction connectivity, exact accepted Ubuntu keyring, and default image-construction resource policy through the existing provider-owned preflight LEGO.

It authorizes no setup entry, UAC request, protected service change, provider/network/VM/disk mutation, guest access, repository-controlled execution, Windows media acceptance, GPU/CUDA work, or model invocation.

## Assessment

The active Stage 8 branch was clean at exact head `a01bdbbc308bfa51ad223c7c49c0c79f9d5edd6b`, equal to its remote ref, with all four jobs green in [GitHub Actions run 33300126422](https://github.com/iteathen/DevBridge/actions/runs/33300126422). The installed candidate remains exact accepted plan commit `8cf98654170a7265052481436ecd8e5607cf1c4b`.

An exact diff from the installed candidate to the current branch proved no change in:

- `src/runtime/providers/windows-production-image-canary-preflight.js`;
- `src/runtime/providers/windows-managed-construction-network.js`; or
- `src/runtime/profile-resource-preflight.js`.

The live preflight therefore exercises the same implementation staged in the user installation.

The preflight owner accepts only neutral resource quantities plus locally resolved state/keyring capabilities. Its fixed provider script imports Hyper-V, proves the required management cmdlets exist, calls `Get-VMHost`, and instantiates the IMAPI filesystem-image object. The separate network owner calls only `Get-VMSwitch` for the exact fixed Windows-managed construction-network identity and requires an internal switch. Neither script invokes a provider/network mutation command.

## Primary-source research

Microsoft documents `Get-VMHost` as the read operation that returns the local Hyper-V host when invoked without a remote target:

- <https://learn.microsoft.com/en-us/powershell/module/hyper-v/get-vmhost>

Microsoft's Hyper-V module documents `Get-VMSwitch` as the switch-observation command. Microsoft separately documents that NAT connectivity uses an internal Hyper-V virtual switch; creating or changing that topology is a different, elevated operation that this preflight does not call:

- <https://learn.microsoft.com/en-us/powershell/module/hyper-v/get-vmswitch>
- <https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/create-a-virtual-switch-for-hyper-v-virtual-machines>

Microsoft documents the IMAPI `IFileSystemImage` family as the filesystem-image construction surface. Instantiating the COM object proves the required API is available without writing media:

- <https://learn.microsoft.com/en-us/windows/win32/api/imapi2fs/>

## Reassessment and plan

The safe question is narrower than “is DevBridge operational”: can the present ordinary token observe the exact host prerequisites that later supported construction/qualification requires?

The dependency-ordered proof is:

1. prove the installed/current adapter identity is unchanged;
2. run direct owner tests for resource admission, exact network identity, absence/failure behavior, and mutation-command exclusion;
3. invoke the real preflight with the current setup defaults: 2 GiB memory, 32 GiB disk, the accepted Ubuntu source size `2,918,598,656` bytes, the canonical manifest-owned state root, and the exact accepted keyring;
4. repeat the same observation to distinguish stable readiness from a transient first result; and
5. record only bounded capability/resource evidence, not local authority-bearing paths or foreign provider inventory.

A pass removes provider command availability, managed construction connectivity, keyring presence, and current host capacity from the immediate blocker. It does not prove a protected configuration endpoint, a declaration, persistent environment, bridge, guest toolchain, repository route, C canary, or restart behavior.

## Physical evidence

Focused tests passed 14/14 across:

- profile memory/storage admission;
- exact Windows-managed network observation and fail-closed behavior; and
- production-image preflight command shape, non-elevated observation, exact verifier use, platform/keyring failure, and mutation-command exclusion.

Two consecutive live invocations returned `devbridge/production-image-canary-preflight-v1` with:

- `ready: true` and no reason;
- provider, connectivity, keyring, memory, and storage all true;
- system-controlled automatic addressing;
- requested memory `2,147,483,648` bytes plus reserve `536,870,912` bytes, with more than 15.6 GiB observed available on both calls; and
- peak storage request `71,638,075,392` bytes plus reserve `17,909,518,848` bytes, with more than 103.2 GB observed available on both calls.

No setup, UAC, service/provider/network/VM/disk/guest mutation, repository execution, or model invocation occurred.

## Result and nonclaims

The current Windows host passes the exact read-only Hyper-V construction preflight. The active operational blocker remains the running protected service generation's missing configuration capability, followed by real route/guest/C-canary proof. This checkpoint does not close #115, #116, #198, #293, #360, #362, or #372–#374 and does not substitute construction readiness for Stage 7 security qualification.
