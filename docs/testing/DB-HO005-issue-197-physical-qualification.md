# DB-HO005 issue #197 physical-host qualification record

Status: point-in-time Windows/Hyper-V qualification evidence for issue #197. This record does not close #197 or supersede DB-020, the VM-stage contracts, current code, or exact-head CI evidence.

## Scope and safety boundary

DB-HO005 resumed Ubuntu production-image qualification through the installed public command on a physical Windows/Hyper-V host. The authorized sequence remained:

1. prove the tracked development selector executes the exact resolved runtime;
2. require plain `devbridge setup` to report `DevBridge setup reached the construction gate.`;
3. only then invoke `devbridge setup --construct`;
4. stop at each new blocker, preserve durable state and cached source media, fix only the owning boundary, and repeat the read-only gate.

No hidden canary configuration was manually authored. No internal canary entrypoint was substituted for the public command. No unrelated VM or Windows-image construction was started.

## Problems and bounded solutions

### 1. Tracked selector resolved one subject but executed an unrelated Stage 0 runtime

Observed public output:

```text
[devbridge-stage0 DB-B060D56B9B65] activation=untracked runtime=0745dd2dc57b2af4f3bbad4d5a57c1965c173783
[devbridge-stage0] Unknown bootstrap argument: setup
```

The stable development authority correctly resolved `cuda-target` to exact subject `868e2c6de223164feaf7b7e8dc5da457cc1235ce` and verified its standalone launcher bytes. The permanent entry then used the content-addressed Stage 0 provider for an ordinary development invocation. That Stage 0 followed unrelated accepted runtime history at `0745dd2dc57b2af4f3bbad4d5a57c1965c173783` instead of executing the exact resolved subject's runtime CLI.

Solution: PR [#268](https://github.com/iteathen/DevBridge/pull/268) introduced an exact-checkout runner behind a neutral local contract. Development subjects execute the verified exact checkout's `src/cli.js`; production subjects retain signed, content-addressed Stage 0 authority. Same-ref fallback remains exact and ref-scoped. The fix merged as `8d4a5dc7c9b088305addd893d9c4c0f6206ff97f` after CI run `32696072841` passed Ubuntu and Windows smoke/test jobs.

Physical proof: the installed entry later accepted and executed exact moving-selector subjects `0738529dcd6bb143fb69e60ddef58a8abb08550a` and `83b2e83d0883a020733aab595f5e3db6024941dd`; the unrelated Stage 0 runtime was no longer eligible.

### 2. Windows PowerShell interpreted the IPv4 mask literal as signed `-1`

The first gated retry stopped before provider networking with:

```text
Cannot convert value "-1" to type "System.UInt64".
```

The Hyper-V collision check cast bare `0xFFFFFFFF` to `UInt64`. Windows PowerShell 5.1 interprets that hexadecimal literal as signed `-1`, so the conversion failed before route/NAT admission.

Solution: PR [#269](https://github.com/iteathen/DevBridge/pull/269) derives the mask from `[uint32]::MaxValue` using unsigned integer arithmetic. Its Windows regression executes the exact embedded prefix functions across `/0` through `/32`, nested prefixes, and disjoint prefixes. The fix merged as `0738529dcd6bb143fb69e60ddef58a8abb08550a` after CI run `32697209378` passed all four jobs.

Primary behavior references:

- [PowerShell numeric literals](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_numeric_literals)
- [.NET `UInt32.MaxValue`](https://learn.microsoft.com/en-us/dotnet/api/system.uint32.maxvalue)

### 3. A durable `planned` canary could not regain the mandatory public gate

After the mask fix, exact runtime selection worked, but plain setup returned only:

```text
DevBridge setup state: planned
```

The mutation path already allowed any explicitly nonblocked, incomplete canary to resume. The read-only result classified only `absent` as construction-gated, so a preserved `planned` journal could not satisfy the required status-before-mutation procedure.

Solution: PR [#270](https://github.com/iteathen/DevBridge/pull/270) makes every explicitly nonblocked, incomplete physical status return to the public construction gate while identifying its durable resume frontier. Plain setup still calls only `status()` and reports that the invocation performed no image or VM construction. The fix merged as `83b2e83d0883a020733aab595f5e3db6024941dd` after CI run `32697875085` passed all four jobs.

Physical proof after merge:

```text
DevBridge setup reached the construction gate.

Physical image construction: authorized to resume from durable planned frontier

The setup path performed no image or VM construction.
```

### 4. The owned Hyper-V switch committed before its host IPv4 interface converged

The next gated retry passed route/NAT collision checking and created the owned internal switch, then stopped. PowerShell progress CLIXML occupied the bounded diagnostic prefix, obscuring the terminal error.

Read-only reconciliation evidence showed:

- the durable environment-network record remained `planned`;
- the exact owned switch existed, was `Internal`, and had the expected ownership marker;
- no gateway address or NAT existed;
- the host `vEthernet` IPv4 interface appeared later and was connected;
- the physical canary journal itself did not advance.

The evidence supports a convergence-window diagnosis: `New-VMSwitch` completed its owned switch effect before the corresponding host IP interface was available to `New-NetIPAddress`. This is a physical-host inference, not a claimed Microsoft timing guarantee.

Solution: PR [#271](https://github.com/iteathen/DevBridge/pull/271):

- suppress progress records in the network-management script so a terminal error remains inside bounded diagnostics;
- require `Get-NetIPInterface` as an observed capability;
- boundedly wait up to ten seconds for the exact IPv4 interface alias;
- create the gateway through the observed exact interface index;
- fail at a focused incomplete-plan frontier before gateway or NAT mutation if the interface does not converge;
- cover delayed success, timeout, mutation ordering, and progress suppression under Windows PowerShell.

Primary behavior references:

- [`Get-NetIPInterface`](https://learn.microsoft.com/en-us/powershell/module/nettcpip/get-netipinterface)
- [`New-NetIPAddress`](https://learn.microsoft.com/en-us/powershell/module/nettcpip/new-netipaddress)
- [PowerShell progress preference](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables#progresspreference)

The fix merged as `b13a7d699a9e37cc9237f6f5878f2ffd8bcd9d47` after CI run `32698912300` passed all four jobs. Exact evidence and the stopped physical frontier were recorded on [issue #197](https://github.com/iteathen/DevBridge/issues/197#issuecomment-5391730847) before construction resumed.

### 5. The read-only physical preflight advertised readiness without proving elevation

After PR #271 merged, plain setup again reported the exact construction-gate message. The gated public construction invocation successfully reconciled the existing owned switch and observed its IPv4 interface, then stopped at the first privileged address mutation:

```text
New-NetIPAddress : Access is denied.
FullyQualifiedErrorId : Windows System Error 5,New-NetIPAddress
```

A separate read-only identity check proved that the invoking Windows token was not in the built-in Administrator role. The physical preflight had checked command presence, Hyper-V module usability, and `Get-VMHost`, but it had not reported or required token elevation. It therefore advertised a construction gate that this invocation could not safely cross. Because the owned switch had already been durably admitted, discovering that missing authority inside network mutation also widened the partial-effect frontier unnecessarily.

Temporary fail-closed solution in PR [#272](https://github.com/iteathen/DevBridge/pull/272):

- inspect the current Windows identity and built-in Administrator role inside the existing read-only capability script;
- return elevation as typed structured capability evidence;
- fail the physical-provider preflight with a focused elevated-PowerShell instruction when that evidence is false or missing;
- keep the check inside the Windows physical adapter rather than leaking provider authority into generic setup logic;
- prove that the non-elevated path invokes only the read-only preflight and cannot reach switch, address, or NAT mutation.

Microsoft's supported Hyper-V NAT workflow requires an Administrator PowerShell before creating the internal switch, assigning its gateway with `New-NetIPAddress`, and creating the NAT. See [Set up a NAT network](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/setup-nat-network) and [Getting started with PowerShell](https://learn.microsoft.com/en-us/powershell/scripting/learn/ps101/01-getting-started#launching-powershell).

PR #272 merged as `34d53ccf8ee38ddb1c43e688328d329fa59577ab` after CI run `32699786108` passed Ubuntu and Windows smoke/test jobs. This made the unsupported authority gap visible before mutation, but requiring elevation for the entire public construction command was deliberately treated as a temporary safety stop rather than the least-privilege target.

### 6. Custom NAT was the wrong authority boundary for construction-only connectivity

Installing custom NAT while elevated and then packaging the guest disk does not transfer NAT into the VHDX. The virtual switch, host gateway address, WinNAT object, and address-allocation policy are host state. A recipient would still need compatible host networking, so this approach neither removes the elevation dependency nor makes the disk self-contained.

Primary-source research also found:

- Microsoft's supported custom Hyper-V NAT procedure starts in an Administrator PowerShell and creates an internal switch, a host gateway address, and a WinNAT object.
- WinNAT itself does not assign addresses to VMs; static guest address/gateway/DNS configuration or another allocation authority is still required.
- Windows supports only one internal NAT prefix per host. Creating another application-owned NAT can conflict with Docker, Windows containers, or other host software and can place the host in an unknown state.
- Hyper-V's Windows-managed Default Switch already provides construction-suitable automatic NAT/DHCP, while Hyper-V KVP can report guest metadata to the host over VMbus without making DevBridge own the switch.

Alternatives were assessed and not adopted for this blocker:

- an elevated one-time custom NAT installer still owns durable host networking, requires reconciliation/removal authority, and conflicts with the one-prefix constraint;
- a scheduled task, service, JEA endpoint, bounded UAC helper, or sudo-style broker moves elevation behind another interface but still delegates privileged host mutation and therefore requires a separate installation/security design;
- an external switch or Internet Connection Sharing remains privileged and changes host topology;
- a fully offline package build would avoid runtime network dependence, but the admitted Ubuntu server ISO does not contain the complete required Node/CMake/compiler package closure, so doing this correctly requires a new signed archive-index verifier, dependency-closure resolver, package-byte cache/admission contract, and local repository/media builder;
- Hyper-V sockets would require a registered host service and a preinstalled guest client, widening both host installation and image-bootstrap scope.

Bounded solution under qualification:

- add a Windows provider-local construction-network adapter that read-only selects the fixed Default Switch by exact provider ID and verifies its internal-switch type;
- expose only neutral `control: system` and `addressing: automatic` contracts to the composition boundary;
- attach only the exact DevBridge-owned disposable construction VM and never mutate, remove, rename, or claim ownership of the system switch;
- generate DHCP Ubuntu autoinstall network data;
- snapshot-pin `linux-cloud-tools-virtual`, qualify `hv_kvp_daemon`, and resolve exactly one private IPv4 reported for the exact VM/switch binding before the pinned SSH host-key proof;
- treat absent addressing as resumable waiting and ambiguous addressing or identity drift as fail-closed;
- report the system-managed construction-only dependency in the public setup handoff without representing it as persistent DevBridge-owned network readiness.

The implementation keeps the Stage-2 persistent networking contract separate. The existing durable owned-switch plan remains evidence and is neither adopted nor deleted by the construction-only adapter. The broader choice between an owned persistent NAT, an operator-provided network, or a separately installed privileged networking service belongs to issue [#116](https://github.com/iteathen/DevBridge/issues/116), not this construction blocker.

Primary behavior references:

- [Microsoft: Set up a NAT network](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/setup-nat-network)
- [Microsoft: Hyper-V integration services](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/integration-services)
- [Microsoft: Hyper-V data exchange](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/integration-services-data-exchange)
- [Canonical autoinstall reference](https://canonical-subiquity.readthedocs-hosted.com/en/latest/reference/autoinstall-reference.html)

Research and the construction/persistent-network ownership split were also recorded directly on GitHub in [issue #197](https://github.com/iteathen/DevBridge/issues/197#issuecomment-5392003796) and [issue #116](https://github.com/iteathen/DevBridge/issues/116#issuecomment-5392005457).

PR [#273](https://github.com/iteathen/DevBridge/pull/273) implemented this boundary at head `c8f1ecc31f3913459e2180b485a25f203475ba0e`. CI run `32703439211` passed Ubuntu and Windows smoke/test jobs, and the change merged as `f962680422dd9f09ee3968327cab6655928e789b`. The supported installation then persisted and accepted that exact `cuda-target` subject. A separate plain public setup invocation returned the exact construction-gate message and the system-managed-connectivity disclosure before construction resumed.

### 7. A locally constructed image is not automatically authorized for public redistribution

The production recipe installs snapshot-pinned build and guest-helper packages and preconfigures the resulting system. Canonical's published FAQ lists adding packages and preinstallation as modifications. Canonical's intellectual-property policy permits personal/internal modification, but says redistribution of modified Ubuntu associated with Ubuntu trademarks requires Canonical approval, certification, or provision; an alternative requires removing/replacing the trademarks and rebuilding subject to the component licenses.

Solution: fail closed at publication. Physical construction and local qualification may continue, but no constructed VHDX, compressed object, or chunk may be uploaded or advertised until the repository records a reviewed redistribution basis. Contacting Canonical for an applicable agreement is the smallest route that preserves issue #197's existing canonical Ubuntu image identity. An unmodified-installer-plus-local-reconstruction design remains possible, but it is a different acceptance contract and must not be substituted silently.

Primary references:

- [Canonical intellectual property rights policy](https://canonical.com/legal/intellectual-property-policy)
- [Canonical embedding and redistribution FAQ](https://canonical.com/embedding/faqs)

This is an engineering publication stop based on the cited policy, not legal advice. The licensing finding was first recorded on [issue #197](https://github.com/iteathen/DevBridge/issues/197#issuecomment-5391915954).

### 8. PowerShell could not late-bind IMAPI's returned `IStream`

The first gated public construction invocation from exact runtime `f962680422dd9f09ee3968327cab6655928e789b` passed source admission and the non-elevated network boundary, then stopped while materializing the NoCloud seed ISO:

```text
Method invocation failed because [System.__ComObject] does not contain a method named 'Read'.
At line:19 char:5
+     $stream.Read($buffer, $buffer.Length, $readPointer)
```

Microsoft documents `IFileSystemImageResult.ImageStream` as an `IStream` interface. The .NET `System.Runtime.InteropServices.ComTypes.IStream` definition is an `IUnknown` interface: it requires early-bound interface dispatch. PowerShell received the object as a late-bound `System.__ComObject`, whose exposed automation surface did not contain `Read`. Direct PowerShell invocation, an explicit PowerShell cast, and `Marshal.GetTypedObjectForIUnknown` all reproduced the same missing-member boundary on the physical host.

Solution: keep IMAPI and interop details inside the Windows seed-media adapter, but cross the returned interface through a fixed C# bridge loaded into the isolated PowerShell process with `Add-Type`. The bridge casts the COM object to .NET's managed `ComTypes.IStream`, copies bounded chunks into a create-new `FileStream`, flushes through the operating-system buffers, and deletes only a partial file that the same call successfully created if copying fails. No raw COM pointer, PowerShell source, destination choice, or executable authority crosses the adapter's public contract.

A Windows-only regression now executes the exact PowerShell/IMAPI path against the real COM object, requires a nonempty `CIDATA` image, and verifies that transient seed staging is removed. The previous fake-invocation test also asserts that the script uses the early-bound bridge and cannot regress to `$stream.Read` on the late-bound wrapper.

Primary behavior references:

- [Microsoft: `IFileSystemImageResult::get_ImageStream`](https://learn.microsoft.com/en-us/windows/win32/api/imapi2fs/nf-imapi2fs-ifilesystemimageresult-get_imagestream)
- [Microsoft: .NET `ComTypes.IStream`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.comtypes.istream)
- [Microsoft: .NET `IStream.Read`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.comtypes.istream.read)
- [Microsoft: PowerShell `Add-Type`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/add-type)
- [Microsoft: .NET `FileStream.Flush`](https://learn.microsoft.com/en-us/dotnet/api/system.io.filestream.flush)

The stopped physical evidence was recorded immediately on [issue #197](https://github.com/iteathen/DevBridge/issues/197#issuecomment-5392294938). Construction did not resume while this adapter defect was under diagnosis.

## Preserved physical evidence

After the latest stopped attempt:

- the production-image canary journal preserved every previously recorded `planned` subject and added exact current subject `subject-99742e1c94397011d72b6c08523c09c5` at `planned`, revision 1;
- the official Ubuntu ISO cache remained `2,918,598,656` bytes with SHA-256 `dec49008a71f6098d0bcfc822021f4d042d5f2db279e4d75bdd981304f1ca5d9` and its original cache timestamp;
- the partially reconciled switch remained owned and recoverable through the provider's durable network plan;
- no gateway address or NAT was admitted by the non-elevated retry;
- no manual switch, NAT, gateway, journal, cache, or canary cleanup was performed.
- read-only observation verified the Windows-managed Default Switch at exact provider ID `c08cb7b8-9b3c-408e-8e30-5e16a3aeb444` with compatible `Internal` type;
- read-only physical preflight passed under the existing non-elevated Hyper-V operator token using system-managed automatic connectivity;
- neither read-only check changed the journal, ISO cache, planned owned-switch evidence, VM inventory, or host networking.
- the stopped IMAPI attempt created no VM and left no preparation, construction, source, or output file after its owned cleanup;
- the stopped IMAPI attempt did not change the ISO cache or any host switch, gateway, NAT, or adapter state.

The owned partial switch remains persistent provider-foundation evidence and may be reconciled only through the same Hyper-V environment adapter. It must not be manually adopted, renamed, or deleted merely to make the construction attempt appear clean. The construction-only adapter neither consumes nor changes it.

## Qualification discipline

Each accepted fix used a fresh exact head and required:

- focused regression coverage that failed for the physical reason;
- repository preflight;
- the full local serial suite on Windows;
- identity/standalone smoke and repository-execution architecture gates;
- fresh Ubuntu and Windows smoke/test CI;
- exact-head merge;
- an issue #197 evidence comment before the next physical mutation.

Issue #197 remains open after the first successful VHDX construction. Source provenance, guest toolchain and CMake/CTest qualification, sanitization, and provider-native inspection remain separate local acceptance boundaries. Canonical artifact packaging may be tested locally, but remote publication/reacquisition is blocked pending documented redistribution authority. Exact reconstruction and any claimed qcow2/KVM parity also remain separate acceptance boundaries.
