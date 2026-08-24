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

Solution in the same change set as this record:

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

The exact PR head, CI run, merge SHA, and physical retry result for this final change must be recorded on [issue #197](https://github.com/iteathen/DevBridge/issues/197) before construction resumes.

## Preserved physical evidence

After the latest stopped attempt:

- the production-image canary journal remained unchanged at its previously recorded `planned` subjects;
- the official Ubuntu ISO cache remained `2,918,598,656` bytes with SHA-256 `dec49008a71f6098d0bcfc822021f4d042d5f2db279e4d75bdd981304f1ca5d9` and its original cache timestamp;
- the partially reconciled switch remained owned and recoverable through the provider's durable network plan;
- no manual switch, NAT, gateway, journal, cache, or canary cleanup was performed.

The owned partial switch must be reconciled through the same Hyper-V provider adapter. It must not be manually adopted, renamed, or deleted merely to make the next attempt appear clean.

## Qualification discipline

Each accepted fix used a fresh exact head and required:

- focused regression coverage that failed for the physical reason;
- repository preflight;
- the full local serial suite on Windows;
- identity/standalone smoke and repository-execution architecture gates;
- fresh Ubuntu and Windows smoke/test CI;
- exact-head merge;
- an issue #197 evidence comment before the next physical mutation.

Issue #197 remains open after the first successful VHDX construction. Source provenance, guest toolchain and CMake/CTest qualification, sanitization, provider-native inspection, canonical artifact packaging, remote publication/reacquisition, exact reconstruction, and any claimed qcow2/KVM parity remain separate acceptance boundaries.
