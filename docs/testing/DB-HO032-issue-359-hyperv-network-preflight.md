# DB-HO032 — issue #359 Hyper-V network preflight before mutation

Status: assessed, researched, and planned from exact `cuda-target` baseline `32d88bb9cffa9d3f387fe06dcb43b2522ae03cda` on isolated branch `fix/359-hyperv-network-preflight`. Implementation and qualification evidence will be appended without rewriting this pre-change record.

## Assessment

The Hyper-V environment adapter persists a deterministic owned network plan before it performs provider effects. That recovery behavior is correct. Its current provider script, however, does not observe the complete WinNAT set until after it may have created an internal switch and assigned a gateway address.

The defect is visible on the current qualification host:

- the accepted plan names owned switch `db-network-deb645a5966747ce`, prefix `192.168.160.0/24`, and gateway `192.168.160.1`;
- the owned switch exists with the exact current ownership marker but has no planned gateway or translation;
- an older fast-track NAT named `db-network-2c6fe2fc8696520d` owns `192.168.175.0/24`;
- provider inspection therefore reports that translation state does not match.

No provider state was changed during this assessment. The older topology has not been deleted or adopted. Its absence from the current durable plan means the low-level adapter does not have authority to classify it as removable.

The current ordering creates two failure modes:

1. when the planned switch is absent, the script may create and mark it before `New-NetNat` rejects the occupied WinNAT slot;
2. when the planned switch already exists, the script may assign the gateway before the same rejection.

This is a provider-adapter invariant. Moving WinNAT identities into generic setup, lifecycle, or routing components would leak topology and would not repair the mutation order.

## Primary research

Microsoft's current [Hyper-V NAT setup guidance](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/setup-nat-network) applies to Windows 11 and states both that a host is limited to one NAT network and that attempting multiple internal NAT prefixes can put the system into an unknown state. The documented construction order is an internal switch, gateway address, and `New-NetNat`, but that walkthrough assumes no other NAT exists. DevBridge must therefore add a complete provider observation before following the documented mutation sequence.

The same guidance distinguishes the NAT prefix from guest address assignment: WinNAT does not provide guest DHCP by itself. This issue does not broaden into guest addressing or bridge configuration; those remain separate profile/bootstrap owners.

## Reassessment and selected design

Keep the deterministic plan and all provider vocabulary inside the existing adapter. At the start of the network mutation script:

1. materialize the complete current translation set exactly once before any mutation;
2. reject ambiguous duplicate planned identities;
3. reject an exact planned identity with a different prefix;
4. reject every additional translation, even when its prefix does not overlap;
5. retain the exact planned translation as an idempotent recovery input;
6. only after those checks inspect or create the switch, gateway, and missing exact translation.

The result is deliberately fail-closed. The adapter will not remove, rename, merge, or adopt another translation. Explicit retirement of a prior installation-owned topology belongs to the higher-level restartable setup transaction in #360, after exact ownership and use are re-observed.

The adapter cannot prevent an unrelated administrator from racing a host mutation after preflight. It can ensure that every state it observes before its own first mutation is safe, keep its own plan restartable, and fail on the provider's subsequent exact operation. Broader host-wide coordination would require a separately specified local authority and is not invented here.

## LEGO boundary

- The generic environment contract continues to expose only neutral readiness and release operations.
- The Hyper-V adapter alone owns WinNAT enumeration, prefix/name comparison, PowerShell, and mutation ordering.
- The persisted plan carries only adapter-local identities derived from the installation identity.
- No remote, repository, controller, profile, or downstream identity enters the script.
- Diagnostics describe the local invariant without forwarding arbitrary provider objects or raw topology listings.

## Plan

1. Add Windows-executed boundary tests that extract the exact encoded provider script and inject fixed PowerShell observation/mutation fakes.
2. Prove a different existing translation stops before switch, gateway, or NAT mutation.
3. Prove an exact existing translation remains recoverable and does not call `New-NetNat` again.
4. Prove ambiguous exact-plus-additional translation state fails before mutation.
5. Reorder the provider script around one normalized preflight snapshot and reuse its exact planned translation later.
6. Run the focused provider tests, Stage 2/LEGO boundary tests, full suite, and repository preflight.
7. Append exact implementation and qualification evidence, inspect the diff, then publish the isolated branch for review without changing `main`.

## Out of scope

- deleting or migrating the older fast-track NAT/switch;
- registering protected environment declarations or images;
- publishing execution routes;
- constructing Windows or Linux guests;
- guest addressing, bridge transport, or repository execution;
- GPU/CUDA work.

## Implementation

The Hyper-V adapter now normalizes `Get-NetNat` into one complete snapshot before it inspects or mutates a switch. It rejects more than one translation as ambiguous, rejects a differently named single translation as an occupied host slot, and rejects an exact name with a different prefix. An exact planned name and prefix remain reusable recovery evidence.

The later construction sequence reuses that snapshot. It no longer re-enumerates translation state after switch/gateway effects or rejects the exact planned NAT as a generic prefix collision. The read-only network inspection path independently requires exactly one translation with the exact planned name and prefix before it reports readiness.

No generic contract, setup component, lifecycle component, or route component changed. No live provider mutation or cleanup was performed by this implementation.

## Qualification

The three new mutation-order tests were run against the pre-change adapter first and failed at the expected old boundaries:

- the foreign non-overlapping NAT reached switch creation;
- the exact planned NAT was rejected as a prefix collision instead of being recovered;
- exact-plus-additional NAT state was not classified as ambiguous.

After the adapter correction:

- `node --test test/hyperv-environment.test.js` — 9 passed, 0 failed;
- `node --test test/stage2-lego-boundary.test.js test/environment-foundation.test.js test/environment-foundation-stage3.test.js test/environment-foundation-composition.test.js` — 9 passed, 0 failed;
- `npm test` — 1,417 tests, 1,404 passed, 13 platform skips, 0 failed;
- `npm run preflight` — passed; 78 syntax files, 2 JSON files, and 75 targeted tests;
- `git diff --check` — passed.

The Windows-executed tests prove that a foreign NAT and ambiguous multi-NAT state stop before `New-VMSwitch`, `Set-VMSwitch`, `New-NetIPAddress`, or `New-NetNat`; exact partial state completes without recreating the NAT; and read-only inspection does not claim readiness with an additional translation.

The remaining live mismatch is intentionally unchanged. Issue #360 owns the higher-level exact migration/re-entry transaction; this adapter now makes reaching that work safe and repeatable.
