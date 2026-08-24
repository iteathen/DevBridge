# DB-HO005 issue #197 physical-host handoff

**Checkpoint:** 2026-08-24 02:13 PDT  
**Repository:** `iteathen/DevBridge`  
**Tracked branch:** `cuda-target`  
**Exact accepted head:** `e8a2f84fa39d20d6bfd5c1793862f7cf268d16aa`  
**Issue:** [#197 — Construct and publish qualified Ubuntu production base-image generations](https://github.com/iteathen/DevBridge/issues/197) (open)

## Safe stopping frontier

The physical installation is rebound through the supported installed command to exact `cuda-target` head `e8a2f84fa39d20d6bfd5c1793862f7cf268d16aa` and retains the moving selector `cuda-target` with no pinned head. The independent plain installed command then exited zero and reported exactly:

```text
DevBridge setup reached the construction gate.
```

That invocation also reported that physical construction was authorized by status but not started, Windows-managed DHCP connectivity was verified without claiming DevBridge-owned network state, and the setup path performed no image or VM construction.

No `devbridge setup --construct` invocation was made after the v4 authority fix. This is the deliberate stopping point requested by the operator.

## Exact installation evidence

Supported launcher:

```text
C:\Users\josho\.devbridge\bin\devbridge.cmd
```

Installed entry:

```text
C:\Users\josho\.devbridge\bin\devbridge-entry.mjs
SHA-256: 2fb3dc2fc1f8433eb6d4b16a133e88c0bc0883bbb83a071d27427c0e84aa7d85
bytes: 1600
```

`entry-install-status` at the checkpoint:

```json
{
  "protocol": "devbridge/entry-install-status-v1",
  "home": "C:\\Users\\josho\\.devbridge",
  "componentHead": "e8a2f84fa39d20d6bfd5c1793862f7cf268d16aa",
  "selectedRunnerRef": "cuda-target",
  "pinnedRunnerHead": null
}
```

The current PowerShell process had not inherited the managed PATH update, so the exact managed launcher path was used. This is still the installed public command surface; no `src/entry/...` command was substituted.

## Completed corrections and evidence

The post-#267 physical sequence uncovered and fixed distinct ownership-boundary defects one at a time. The durable narrative, failure evidence, solutions, tests, and primary research references are in [the DB-HO005 qualification log](DB-HO005-issue-197-physical-qualification.md).

The merged corrections relevant to this checkpoint are:

- PR [#268](https://github.com/iteathen/DevBridge/pull/268): exact tracked-ref runtime selection instead of unrelated untracked activation.
- PR [#269](https://github.com/iteathen/DevBridge/pull/269): unsigned IPv4 mask handling.
- PR [#270](https://github.com/iteathen/DevBridge/pull/270): planned canary regain gate.
- PR [#271](https://github.com/iteathen/DevBridge/pull/271): `vEthernet` convergence.
- PR [#272](https://github.com/iteathen/DevBridge/pull/272): bounded temporary elevation preflight.
- PR [#273](https://github.com/iteathen/DevBridge/pull/273): non-elevated construction through the exact Windows-managed Default Switch/DHCP boundary.
- PR [#274](https://github.com/iteathen/DevBridge/pull/274): Windows IMAPI `IStream` bridge.
- PR [#275](https://github.com/iteathen/DevBridge/pull/275): exact Hyper-V partial recovery.
- PR [#276](https://github.com/iteathen/DevBridge/pull/276): planned observation defers admission.
- PR [#277](https://github.com/iteathen/DevBridge/pull/277): ISO9660 plus Joliet NoCloud seed with exact `user-data` and `meta-data` guest-visible names. Merge: `24c116ec52962d8c9883e4ef7cc48d0c8c8f7148`; CI run `32709028287` was green on Ubuntu and Windows smoke/test.
- PR [#278](https://github.com/iteathen/DevBridge/pull/278): advance the provider-neutral media-preparation generation to `ubuntu-2604-autoinstall-v4` so corrected seed bytes derive a new exact construction subject instead of adopting the running v3 receipt and VM. Head: `9b8e91990d9741aaa019894ad20601171baf1db2`; merge: `e8a2f84fa39d20d6bfd5c1793862f7cf268d16aa`; CI run `32709897559` was green on Ubuntu and Windows smoke/test.

PR #278 local qualification was 38/38 focused tests, preflight success, doctor `ok: true`, and a complete Windows suite rerun of 985 total / 979 passed / 0 failed / 6 platform skips. The first full-suite attempt had one tight deterministic-liveness subprocess timeout under concurrent load; it passed immediately in isolation, and the unchanged complete rerun was green. Git background maintenance also reported permission-denied warnings while attempting to prune unrelated pre-existing linked-worktree metadata. Commit, fetch, push, and merge succeeded; no linked-worktree metadata was deleted.

## Preserved v3 physical canary

The old v3 canary remains exact evidence of the ISO9660-only seed failure. Do not adopt it as v4, provide guest input, or delete its state merely to make progress.

Checkpoint observation:

```text
VM name: db-image-build-7e82aa1f2870fcf3
VM ID: 5f0b3918-991c-42bd-986c-dd2647a03b9e
state: Running / Operating normally
CPU usage: 0
guest IP addresses: none reported
switch: Default Switch
switch ID: c08cb7b8-9b3c-408e-8e30-5e16a3aeb444
old construction subject: subject-99742e1c94397011d72b6c08523c09c5
```

Provider-native thumbnail evidence previously showed the Subiquity Welcome/language picker. The exact prepared installer contained both required `Automated Install`/`autoinstall` boot patches, but the attached v3 CIDATA image exposed only ISO9660 8.3 aliases (`METADA~1.;1` and `USERDA~1.;1`). That is why cloud-init did not enter unattended install.

Preserved old output:

```text
C:\Users\josho\.devbridge\state\production-image-canary\output\aeed345fb0e920860cb5a4b1fdd6c1536d2e7ca467daa3a90fd8c3262f52540f.vhdx
bytes: 4194304
```

The v3 `authority.json`, `preparation.json`, `journal.json`, and `construction/state.json` remain present. Their checkpoint SHA-256 values are respectively:

```text
4487d625c413434d54c1743bd1d9cbd8b134e0d73dd466b7c182e40880799531
4b5cf71fa269a5693a72f4dc7172796a93669fb02f9242d5d187cab8f38f9f77
756e57b75b99a67d0a2ac502826828ffe3fa1db6c5bfcc356a7aac1a509326cb
1656022b977e4b936889da0d0a80bffbc90ebf3bf20b8d42d5b4f68df707bca9
```

Transient access material also remains under the canary-owned state root. Preserve it, but never copy its private key into issues, logs, handoffs, guests other than the exact owned canary, or repository content.

## Preserved source cache

The independently content-addressed Canonical release-cache ISO remains reusable by v4:

```text
release: Ubuntu 26.04 resolute amd64 live server
file: ubuntu-26.04-live-server-amd64.iso
bytes: 2918598656
SHA-256: dec49008a71f6098d0bcfc822021f4d042d5f2db279e4d75bdd981304f1ca5d9
signer fingerprint: 843938DF228D22F7B3742BC0D94AA3F0EFE21092
```

The checkpoint recomputed that exact SHA-256 from the release-cache file. Do not force a download solely because the recipe generation changed.

## NAT/elevation and distribution conclusions

Construction no longer needs DevBridge to create custom WinNAT state. The current narrow solution read-only identifies Hyper-V's exact Windows-managed Default Switch and relies on its host-managed DHCP. It does not claim that switch as DevBridge-owned network foundation, and it does not satisfy the separate persistent repository-environment networking boundary.

Other researched designs remain future architecture rather than permission to widen this canary: a pre-provisioned external switch under explicit host/LAN policy, a narrow privileged broker or JEA endpoint, Hyper-V sockets with a new guest-side bootstrap/proxy, or a fully offline dependency closure. The research record is on [issue #116](https://github.com/iteathen/DevBridge/issues/116#issuecomment-5392505984).

Local/internal creation and qualification may continue, but public redistribution of the modified Ubuntu image is not authorized by this checkpoint. Do not upload the VHDX, compressed object, chunks, or reconstructed artifact until the project records an applicable Canonical redistribution basis or approves a compliant unbranded alternative. See [Ubuntu physical image construction](../ubuntu-physical-image-construction.md) and the cited Canonical policy/FAQ.

## Worktree state

The original developer checkout was intentionally left untouched at:

```text
C:\Users\josho\OneDrive\Documents\ChatGPT\DevBridge
branch: codex/temp-fast-functional (remote tracking branch gone)
modified: config/devbridge.fast.json
untracked: config/devbridge.fast.json.before-setup
```

Those files predate this handoff and belong to the operator. Do not reset, clean, overwrite, or commit them as part of #197.

The isolated qualification worktree is:

```text
C:\Users\josho\OneDrive\Documents\ChatGPT\DevBridge-dbho005
```

## Exact next action

`nextActionId: reobserve-v4-public-gate`

On resume, first fetch and verify the current exact `cuda-target` head, read `AGENTS.md` and the governing VM/construction documents if their digests or content changed, then use the installed public launcher to re-observe `entry-install-status`, the preserved v3 VM/cache ownership, and plain read-only setup:

```powershell
& 'C:\Users\josho\.devbridge\bin\devbridge.cmd' entry-install-status
& 'C:\Users\josho\.devbridge\bin\devbridge.cmd' setup
```

Proceed to one installed public `devbridge setup --construct` only if that fresh plain invocation again exits successfully and explicitly reports `DevBridge setup reached the construction gate.` The v4 generation should derive a new exact construction subject and may reuse the verified release-cache ISO. Do not manually stop/delete the v3 VM, author hidden canary configuration, supply guest input, invoke an internal canary as final proof, or weaken exact-subject/provider authority.

If the fresh gate or v4 construction reports a blocker, stop at that boundary, preserve both generations and cache, fix only the owning module, document the problem/solution on GitHub, merge fresh Ubuntu/Windows qualification, rebind, and repeat the plain gate. Issue #197 remains open after a first successful VHDX because qualification, inspection, bundle/manifest, publication authority, remote reacquisition, and exact reconstruction remain separate acceptance boundaries.
