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
- a pre-provisioned external switch can avoid both custom NAT and per-invocation elevation after an administrator creates it, but it remains host state, exposes the guest to the physical network, and depends on recipient LAN/VLAN/DHCP policy;
- a scheduled task, service, JEA endpoint, bounded UAC helper, or sudo-style broker can replace repeated elevation with a one-time elevated installation, but it still delegates privileged host mutation and therefore requires authenticated local IPC, exact registered operations, ACL/audit policy, durable effect reconciliation, and trusted update ownership;
- Internet Connection Sharing remains privileged and changes host topology;
- a fully offline package build would avoid runtime network dependence, but the admitted Ubuntu server ISO does not contain the complete required Node/CMake/compiler package closure, so doing this correctly requires a new signed archive-index verifier, dependency-closure resolver, package-byte cache/admission contract, and local repository/media builder;
- Hyper-V sockets would require a registered host service and a preinstalled guest client, widening both host installation and image-bootstrap scope.

The pre-provisioned external-switch and privileged-broker approaches remain legitimate issue #116 design candidates. They do not change the #197 conclusion: networking installed on the construction host cannot be packaged into the guest disk for another host. Microsoft requires administrative rights to create/configure a virtual switch; Windows service creation likewise requires Administrator access to the Service Control Manager, while JEA can subsequently expose a constrained delegated endpoint. Hyper-V sockets avoid the IP stack entirely but expose only a data stream and require both a registered host service and compatible guest support.

Solution: PR [#273](https://github.com/iteathen/DevBridge/pull/273):

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
- [Microsoft: Create and configure a Hyper-V virtual switch](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/create-a-virtual-switch-for-hyper-v-virtual-machines)
- [Microsoft: Service security and access rights](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights)
- [Microsoft: JEA security considerations](https://learn.microsoft.com/en-us/powershell/scripting/security/remoting/jea/security-considerations)
- [Microsoft: Make your own Hyper-V integration services](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/make-integration-service)
- [Microsoft: Hyper-V integration services](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/integration-services)
- [Microsoft: Hyper-V data exchange](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/integration-services-data-exchange)
- [Canonical autoinstall reference](https://canonical-subiquity.readthedocs-hosted.com/en/latest/reference/autoinstall-reference.html)

Research and the construction/persistent-network ownership split were also recorded directly on GitHub in [issue #197](https://github.com/iteathen/DevBridge/issues/197#issuecomment-5392003796) and [issue #116](https://github.com/iteathen/DevBridge/issues/116#issuecomment-5392005457). The additional external-switch, broker, offline-media, and Hyper-V-socket comparison is recorded in [issue #116](https://github.com/iteathen/DevBridge/issues/116#issuecomment-5392505984).

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

PR [#274](https://github.com/iteathen/DevBridge/pull/274) merged the fix as `56f3a9032e1ebcaae6764fb5f0e8a2f7dc890e30` after CI run `32704498685` passed Ubuntu and Windows smoke/test jobs. The installed entry then persisted and executed that exact `cuda-target` subject, and a separate plain public setup invocation returned the exact construction gate before the canary resumed.

### 9. `New-VM -NoVHD` committed a default adapter before ownership marking

The gated public retry from exact runtime `56f3a9032e1ebcaae6764fb5f0e8a2f7dc890e30` advanced through seed and installer-media preparation, created the disposable Hyper-V VM, and then stopped with:

```text
construction machine name is occupied without matching ownership evidence
```

Read-only host reconciliation found exact machine `db-image-build-7e82aa1f2870fcf3`, provider ID `5f0b3918-991c-42bd-986c-dd2647a03b9e`, `Off`, with an empty ownership note. Its configuration was below the pre-recorded owned output root, and it had no disk or DVD attachment. It did have one default generation-2 `Network Adapter`: dynamic MAC enabled, disconnected, and not bound to a switch. The durable construction record remained `planned` with a null provider identity.

The recovery guard assumed the partial effect immediately after `New-VM -NoVHD` had zero network adapters. On this physical host, Hyper-V created the default disconnected adapter as part of that effect. The guard therefore rejected the exact object created by its own preceding command before it could write the ownership marker. This was a provider-effect/recovery mismatch, not foreign object occupation.

Solution: PR [#275](https://github.com/iteathen/DevBridge/pull/275):

- future `New-VM` creation binds its default adapter to the already selected exact switch in the same provider command;
- an unmarked partial is adoptable only when it is stopped, generation 2, has the exact requested startup memory, has the exact deterministic configuration location under the owned root, has no disk or DVD, and has exactly the nonlegacy dynamic default adapter;
- that adapter must be either still completely unbound, as in the preserved physical partial, or bound to the exact selected switch provider identity;
- foreign configuration locations, foreign notes, changed VM shape, storage/media attachments, additional adapters, legacy/static adapters, and unrelated switch bindings remain fail-closed;
- the adapter is not connected or otherwise configured until the ownership marker has been written.

A Windows regression executes the exact embedded preparation script against mocked Hyper-V cmdlets with the physical one-default-adapter partial shape. It proves successful reconciliation and proves that a foreign configuration location or unrelated connected adapter remains non-adoptable.

Primary behavior reference:

- [Microsoft: `New-VM`](https://learn.microsoft.com/en-us/powershell/module/hyper-v/new-vm)

The stopped physical frontier was recorded immediately on [issue #197](https://github.com/iteathen/DevBridge/issues/197#issuecomment-5392426950). No cleanup or second construction attempt occurred while this recovery boundary was under diagnosis.

PR #275 merged as `e4f1930947912cc8c4b4184120e66893e7beaae1` after exact head `facdfcf50f2c6ae6e71e8fc00f632fd43180c46d` passed CI run `32706151013` on Ubuntu and Windows smoke/test jobs. The installed entry then persisted and executed that exact `cuda-target` subject, and a separate plain public setup invocation returned the exact construction gate before one recovery attempt.

### 10. Planned-phase observation blocked the provider recovery owner

The public retry after PR #275 stopped immediately with:

```text
construction provider object is not owned by this operation
```

Read-only reconciliation proved that no provider recovery effect had run: the VM still had empty Notes, no disk or DVD, and the same unbound default adapter; its configuration timestamps had not changed; the construction record remained `planned` with a null provider identity; the canary journal remained `planned`; and the release-cache ISO was unchanged.

The generic canary deliberately observes inner construction before replaying preparation. That lets it reconcile a completed inner effect whose outer phase save was lost. The Hyper-V `status()` implementation, however, rejected any existing unmarked object before returning its durable `planned` phase. The exact `prepare()` recovery predicate added by PR #275 was therefore unreachable.

Solution: PR [#276](https://github.com/iteathen/DevBridge/pull/276):

- when and only when the provider-local durable record is still `planned` and has no provider identity, status reports the observed object as `exists: true, owned: false` while retaining phase `planned`;
- this observation grants no ownership and performs no mutation; it allows the generic canary to call the provider-local `prepare()` owner, which applies the exact shape and path predicate before writing a marker;
- after preparation, or whenever a provider identity is already recorded, any observed loss of ownership continues to throw immediately;
- regression coverage proves the planned unowned observation, successful delegation to preparation, and fail-closed ownership loss after preparation.

The second stopped frontier and its unchanged physical evidence were recorded on [issue #197](https://github.com/iteathen/DevBridge/issues/197#issuecomment-5392627890). No retry occurred while this admission-order defect was under diagnosis.

### 11. ISO9660-only seed media silently changed the required NoCloud filenames

After PR #276 merged, the installed tracked entry reported exact runtime `9d25f986b9eca4a350e3c1fc27c7b2f76cbaca42`, and a separate plain public setup invocation reached the exact construction gate. One public construction invocation then recovered the owned partial, prepared the VM, and returned the durable waiting reason `unattended installer is still running`.

Read-only physical observation later proved that this was not an active unattended installation. The exact owned VM remained running but became CPU-idle, never wrote beyond the initial `4,194,304`-byte dynamic VHDX allocation, never established Hyper-V KVP contact, and reported no guest address. Microsoft Hyper-V's read-only thumbnail API showed Subiquity stopped at its interactive `Welcome` language picker. Bounded inspection of the prepared installer proved both expected GRUB entries contained the `autoinstall` kernel token, so the prior boot-trigger defect had not returned.

The attached seed image had the correct `CIDATA` ISO9660 volume identifier but no Joliet supplementary descriptor. Its physical root directory records were:

```text
METADA~1.;1
USERDA~1.;1
```

IMAPI had correctly applied ISO9660's restricted naming rules to the staged `meta-data` and `user-data` files. Cloud-init's NoCloud contract, however, requires those two exact names at the seed root. The old Windows regression checked only that the result was nonempty and contained the text `CIDATA`; it therefore proved the COM stream bridge but not the guest-visible seed contract.

Solution: keep the provider-neutral seed-writer interface unchanged and fix only the Windows IMAPI adapter. It now asks IMAPI for the bridge combination ISO9660 + Joliet (`FsiFileSystemISO9660 | FsiFileSystemJoliet`, value `3`). ISO9660 compatibility and the `CIDATA` identity remain present, while Joliet preserves the long, lowercase, hyphenated NoCloud names. The Windows real-media regression now parses the actual Joliet supplementary volume descriptor and root directory and requires exact guest-visible `meta-data` and `user-data` names. The fake-invocation test also pins the IMAPI file-system mask so the adapter cannot silently return to ISO9660-only output.

Primary behavior references:

- [cloud-init NoCloud data source](https://docs.cloud-init.io/en/latest/reference/datasources/nocloud.html)
- [Canonical autoinstall quick start](https://canonical-subiquity.readthedocs-hosted.com/en/latest/howto/autoinstall-quickstart.html)
- [Microsoft IMAPI disc formats](https://learn.microsoft.com/en-us/windows/win32/imapi/disc-formats)
- [Microsoft IMAPI `FsiFileSystems`](https://learn.microsoft.com/en-us/windows/win32/api/imapi2fs/ne-imapi2fs-fsifilesystems)

The stopped physical frontier and its unchanged ownership/cache evidence were recorded immediately on [issue #197](https://github.com/iteathen/DevBridge/issues/197#issuecomment-5392859014). No language selection, guest input, VM power action, construction re-entry, media rewrite, cache deletion, or disk cleanup occurred while this seed-format boundary was under diagnosis.

PR [#277](https://github.com/iteathen/DevBridge/pull/277) merged the Joliet writer fix as `24c116ec52962d8c9883e4ef7cc48d0c8c8f7148` after exact head `d43baf1be875f8f9f031d68749e8f34e78c47b8b` passed CI run `32709028287` on Ubuntu and Windows smoke/test jobs.

### 12. The corrected writer did not invalidate already-prepared media

The post-merge recovery audit stopped before rebinding the physical installation. Although PR #277 changed the seed filesystem bytes, setup still advertised recipe generation `ubuntu-2604-autoinstall-v3`. Construction authority is content-addressed, so an unchanged source, patch recipe, package snapshot, payload, qualification, and output declaration derived the same subject as the running physical canary.

That subject already had an exact preparation receipt containing the old ISO9660-only seed SHA, a `running` outer journal, and an `installing` Hyper-V construction record. Receipt loading correctly reverifies those old bytes, and an installer-owned running phase deliberately does not re-enter preparation. A direct tracked-runtime rebind would therefore run corrected code while continuing to observe the stale interactive VM and media indefinitely. Runtime identity alone cannot invalidate durable artifact evidence owned by a separate construction authority.

Solution: advance the provider-neutral autoinstall media-preparation generation to `ubuntu-2604-autoinstall-v4`. The v3 83-byte title/kernel-prefix patch, its two exact occurrences, source authority, package pins, payload, and output declaration remain unchanged. Because recipe generation participates in the immutable construction authority, the v4 setup derives a new exact subject and cannot adopt or reuse the v3 preparation receipt, construction journal, VM, disk, or CIDATA bytes. The signed release-cache ISO remains reusable because its independent Canonical source digest is unchanged.

Regression coverage now requires setup to advertise v4 and separately proves that changing only the media-preparation generation changes the immutable construction subject while the patch bytes remain identical. This keeps the migration in the construction authority owner and avoids leaking Windows/IMAPI/provider identity into the Ubuntu recipe contract.

The recovery audit and unchanged host evidence are recorded on [issue #197](https://github.com/iteathen/DevBridge/issues/197#issuecomment-5392979179). No runtime rebind, setup gate, VM action, or construction invocation occurred before the stale-media identity was classified.

### 13. Console evidence treated RGB565 pixels as an undocumented frame header

After PR #306 synchronized the recovery line with current `main`, ordinary setup selected exact commit `4483474fc85e5f50a21accd7fef7c4a7a6067dfb`, reached the construction gate, and exited `0`. One supported `setup --construct` re-entry then preserved the existing VM and failed closed because the overdue installer diagnostic reported:

```text
Hyper-V thumbnail dimensions are invalid: 512x1112
```

The candidate branch added support for a 153,604-byte response by interpreting its first four bytes as little-endian width and height. Read-only physical observation disproved that model:

- `GetVirtualSystemThumbnailImage` returned success, `System.Byte[]`, and 153,604 bytes for requested `320x240` RGB565;
- independent `GetSummaryInformation` returned explicit `ThumbnailImageWidth=320`, `ThumbnailImageHeight=240`, and the identical byte array;
- `16x16`, `80x60`, `100x75`, `160x120`, `319x239`, and `320x240` calls each returned exactly `width * height * 2 + 4` bytes;
- the first four bytes varied across scaled images and did not encode the requested dimensions;
- the final four observed bytes were zero, and retaining the first expected bytes produced the better row-boundary coherence.

Microsoft's provider contract defines the method output as raw RGB565 `uint8[]` for the requested width and height. `Msvm_SummaryInformation` defines width and height as separate properties corresponding to the raw thumbnail array. There is no documented leading dimension frame.

Sources:

- [Microsoft: `GetVirtualSystemThumbnailImage`](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/getvirtualsystemthumbnailimage-msvm-virtualsystemmanagementservice)
- [Microsoft: `GetSummaryInformation`](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/getsummaryinformation-msvm-virtualsystemmanagementservice)
- [Microsoft: `Msvm_SummaryInformation`](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/msvm-summaryinformation)

Solution: keep all compatibility handling inside the Hyper-V image-construction adapter and preserve the neutral console-evidence stud. The protected script now returns the provider's documented byte array without guessing at framing. The adapter accepts either the exact RGB565 byte count or the physically observed exact four-byte zero-terminal variant, retains the first expected pixel bytes, and rejects nonzero terminal bytes, all other lengths, invalid dimensions, and invalid encodings before evidence publication. The speculative word-array and leading-dimension paths were removed rather than retained as legacy behavior.

Executable focused coverage proves exact-size success, physical-variant success without a two-pixel image shift, nonzero-terminal rejection, malformed-size rejection, contract rejection, no artifact publication on failure, and unchanged VM/media state. The Hyper-V construction, physical canary, and setup-construction suites pass 30 tests with no failures.

The pre-fix stopped frontier and exact provider observations are recorded on [issue #197](https://github.com/iteathen/DevBridge/issues/197#issuecomment-5443879067). No guest input, power operation, media rewrite, disk mutation, provider cleanup, or manual workaround occurred during diagnosis or implementation.

### 14. Bounded console evidence exposed a terminal pinned-package transaction failure

PR #307 merged the console normalization fix as exact commit `4d5dc5633d978773a3adf02414acbc4234076ca6` after all Windows and Ubuntu smoke/full CI jobs passed. Exact plain setup then reached the construction gate and exited `0`. One supported construction re-entry preserved the overdue VM and produced the bounded `320x240` artifact with SHA-256 `0404afa06f60cf153b5e55dcff53ce9418af4b12fa257fd15b0361b68570ec92`.

A read-only `640x480` call to the same provider method made the terminal legible without changing the guest. Subiquity had completed final system configuration. The first user-supplied late command, snapshot update, completed. The next command attempted the six exact top-level pins for build-essential, CMake, Git, Linux cloud tools, Node.js, and npm against snapshot `20260821T230000Z`; curtin reported apt exit `100` and Subiquity entered its fatal error screen.

Host-side re-observation confirmed that every top-level record and package file still exists in the exact snapshot and that each direct dependency name is present in `main` or `universe`. Those checks prove provenance and availability of named artifacts, not transaction solvability or successful target configuration. The existing `resolveUbuntuPackagePins()` owner reads top-level `Package` and `Version` fields only, so it cannot prevent this class of physical failure.

Ubuntu's snapshot contract requires snapshot update immediately before the package command, which this seed already did. The apt exit code identifies only an error. The captured screen omits the decisive apt stderr. Therefore no snapshot, package pin, source pocket, or delivery mechanism is changed at this checkpoint. The next accepted evidence is an isolated Ubuntu 26.04 simulation/download/install of the exact transaction, followed by a reassessment of the smallest owning contract.

Primary references:

- [Ubuntu Snapshot Service](https://snapshot.ubuntu.com/)
- [Ubuntu `apt-get` manual](https://manpages.ubuntu.com/manpages/noble/man8/apt-get.8.html)
- [Subiquity autoinstall configuration reference](https://canonical-subiquity.readthedocs-hosted.com/en/latest/reference/autoinstall-reference.html)

The exact physical result is recorded on [issue #197](https://github.com/iteathen/DevBridge/issues/197#issuecomment-5444080116). No guest input, power operation, VM configuration change, media/disk mutation, snapshot rotation, cleanup, or manual workaround occurred.

### 15. Disposable transaction diagnostics localized installer-owned snapshot drift

A temporary pull-request workflow ran the exact transaction in Canonical's Ubuntu 26.04 container. The first run intentionally retained the container's minimal trust state and proved an important failure mode: snapshot HTTPS requests failed certificate verification, but plain `apt-get update` exited zero with warnings and left live-archive indexes usable. The accepted update form must therefore include `--error-on=any`.

The second run installed exact release `ca-certificates=20260223`, completed the exact snapshot update, and reached the solver. The exact transaction failed on a mixed package generation: `npm` required `node-gyp`, then `libnode-dev`, then `libssl-dev=3.5.5-1ubuntu3.3`, whose exact `libssl3t64` peer could not be selected against the container's existing state. This is diagnostic reproduction of the dependency-conflict class, not a claim that the container is the server ISO target.

The physical console and Canonical's Subiquity source establish the relevant ordering. Subiquity installs its configured packages, then runs its default security `unattended-upgrades`, and only afterward executes user late commands. DevBridge's exact snapshot began in those late commands, so it could not constrain the preceding installer-owned update. Canonical documents `APT::Snapshot` as applying to all APT operations, including unattended upgrades. Subiquity accepts the Curtin `apt` format, forwards `conf`, and Curtin writes it as target install-time APT configuration. Subiquity restores that temporary configuration before late commands, which is why both bindings are required.

The accepted repair is scoped to the Ubuntu seed owner: project the already accepted neutral package snapshot into install-time `APT::Snapshot`, retain the explicit snapshot on the DevBridge late transaction, and make the explicit metadata refresh fail on any source error. No downgrade flag, live source, new package manager, host execution path, or container-only CA bootstrap is admitted. The physical target already proved its HTTPS trust by completing the snapshot update.

Implementation projects `packages.snapshot` into the autoinstall `apt.conf` block and into both explicit late commands; no caller or topology field was added. The late metadata refresh now supplies `--error-on=any`. Recipe generation advanced from `ubuntu-2604-autoinstall-v4` to `ubuntu-2604-autoinstall-v5`, so the changed seed behavior derives a new immutable construction subject instead of reusing the failed media. The temporary diagnostic workflow was removed after its evidence was recorded.

Local verification on the exact candidate passed:

- 28 focused setup-authority, construction-authority, seed, and qualification tests;
- repository preflight, including 36 targeted tests;
- the full 1,145-test suite: 1,139 passed, 6 platform skips, 0 failed.

These results prove contract composition and fail-closed input behavior. They do not replace the required exact Hyper-V construction and guest qualification gate.

Primary references:

- [Ubuntu Snapshot Service](https://snapshot.ubuntu.com/)
- [Subiquity autoinstall configuration reference](https://canonical-subiquity.readthedocs-hosted.com/en/latest/reference/autoinstall-reference.html)
- [Subiquity install controller](https://github.com/canonical/subiquity/blob/main/subiquity/server/controllers/install.py)
- [Subiquity APT configuration](https://github.com/canonical/subiquity/blob/main/subiquity/server/apt.py)
- [Curtin APT configuration implementation](https://github.com/canonical/curtin/blob/main/curtin/commands/apt_config.py)

### 16. Exact Hyper-V qualification rejected source-wide snapshot configuration

PR #308 merged the v5 package-authority candidate into the recovery line as exact commit `01b8a6c8eefc35ab96626fdc76dea3dd6ce15919` after all four Ubuntu/Windows smoke and full CI jobs passed. One bounded elevated setup reconciliation installed that exact runtime and prepared protected state. A supported construction invocation then created a new immutable subject rather than adopting either older failed subject:

- subject: `subject-b75a87f28715720d2e51d6547f868753`;
- VM: `db-image-build-ad9f43367787dba1`;
- provider identity: `e800f3af-3d36-4f35-bf0c-855762157e8d`;
- disk: `f323f346ecb6e09d562ce3bf88ff1bb674172b665ba82f96dbb0e067c4ac223a.vhdx`;
- terminal construction classification: `stalled` after 23 elapsed and 21 no-progress minutes;
- durable `320x240` console SHA-256: `75d721ed5d1ff400fbeded22658baab790616d5fa3172bc5ffa8e38f0c9c52ea`.

The VHDX grew from its initial 4 MiB allocation to `4,936,695,808` bytes before becoming CPU-idle. The controller did not repair or clean it automatically. A separate read-only `640x480` call to the same documented Hyper-V thumbnail method exposed the decisive boundary without changing guest state: Curtin failed in curthooks while installing `efibootmgr`, `grub-efi-amd64`, `grub-efi-amd64-signed`, and `shim-signed`; Subiquity then entered its fatal crash path. The v5 subject never reached unattended-upgrades or DevBridge late commands.

The official signed ISO and exact snapshot both contain those package names and expected boot package versions. The failure therefore is not evidence that the snapshot predates the ISO. It is evidence that applying `APT::Snapshot` through Curtin's global install-time apt configuration changes an earlier package-management boundary that v4 had already crossed. The global configuration is rejected; the physical VM/disk/journal remain evidence and received no guest input, power, media, disk, or cleanup mutation.

Primary-source reassessment established the narrower seam:

- Subiquity's `updates` schema admits only `security` or `all`, and its controller runs unattended-upgrades before late commands when archive access exists.
- `Unattended-Upgrade::Package-Blacklist` is a regex list used only by unattended-upgrades; matching packages receive a never-install pin, and an empty eligible set returns success.
- Curtin can carry that temporary configuration without affecting its ordinary package installer; Subiquity restores the temporary apt configuration before late commands.
- Debian's package-version ordering is the required authority when selecting the final exact candidate across release, updates, and security pockets.

The v6 candidate therefore replaces global snapshotting with a temporary all-package unattended-upgrades blacklist, performs the explicit snapshot update and a no-removal snapshot-bound system upgrade after Subiquity restores its temporary configuration, then installs the exact final top-level candidates resolved across all enabled pockets. A self-contained package-version owner implements Debian's documented comparison algorithm; the Ubuntu authority only supplies candidate strings from the neutral package records. Exact package qualification remains mandatory; no downgrade or host fallback is admitted.

For snapshot `20260821T230000Z`, the revised authority selects the final candidates visible across release, updates, and security: build-essential `12.12ubuntu2.26.04.2`, CMake `4.2.3-2ubuntu2`, Git `1:2.53.0-1ubuntu1`, Linux cloud tools `7.0.0-30.30`, Node.js `22.22.1+dfsg+~cs22.19.15-1ubuntu1`, and npm `9.2.0~ds3-1`. Recipe generation advances to `ubuntu-2604-autoinstall-v6` and package generation to `ubuntu-2604-tools-v3`, so this design cannot adopt v5 state.

Pre-publication verification passed 24 focused version/authority/seed/qualification tests with one Windows platform skip, repository preflight with 36 targeted tests, and the full Windows suite: 1,148 tests, 1,141 passed, 7 platform skips, 0 failed. Linux CI must still cross-check the fixed comparator corpus against `dpkg`; exact Hyper-V construction remains the capability gate.

Additional primary references:

- [Subiquity install controller](https://github.com/canonical/subiquity/blob/main/subiquity/server/controllers/install.py)
- [Subiquity autoinstall schema](https://github.com/canonical/subiquity/blob/main/autoinstall-schema.json)
- [unattended-upgrades](https://github.com/mvo5/unattended-upgrades)
- [Debian package-version ordering](https://manpages.debian.org/trixie/dpkg-dev/deb-version.7.en.html)

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
- after the IMAPI fix merged, the next gated attempt created exact stopped VM `db-image-build-7e82aa1f2870fcf3` with provider ID `5f0b3918-991c-42bd-986c-dd2647a03b9e` below the owned canary output root;
- that partial VM has empty Notes, no disk or DVD, and one disconnected default dynamic network adapter; its exact shape is preserved for provider-owned recovery rather than manually deleted;
- preparation and construction state remain durable at subject `subject-99742e1c94397011d72b6c08523c09c5`, phase `planned`, with exact installer and CIDATA identities recorded;
- the release-cache ISO remains unchanged at `2,918,598,656` bytes, and no host switch, gateway, NAT, or unrelated VM was changed by this stopped attempt.
- the first post-#275 retry did not reach recovery mutation: VM Notes, topology, configuration timestamps, construction state, journal state, and release-cache media all remained unchanged at the same planned partial frontier.
- after PR #276, the exact owned VM advanced to the durable installer-running frontier; it remains at Subiquity's interactive language picker with both media attached, exact ownership/provider identity intact, and no installed-system writes; the release-cache ISO remains unchanged.

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
