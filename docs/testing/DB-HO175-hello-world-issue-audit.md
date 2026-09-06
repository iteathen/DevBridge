# HO175 — open issue audit for Hello World

Reviewed 71 open issues from the retained GitHub snapshot against their goals/acceptance, current contracts and relevant implementation/evidence. Decisive comments were read before proposed closures or rejecting old completion claims. This is a scope/disposition audit, not new qualification of every feature. Historical comments/handoffs remain unchanged.

The first milestone is defined in [Hello World qualification](../hello-world-qualification.md). GPU/NVIDIA CUDA-JS follows it; MCP follows GPU. No incomplete hardware/recovery claim is closed merely because hosted CI is green.

| Issue | Disposition | Reason / remaining owner |
| --- | --- | --- |
| [#49](https://github.com/iteathen/DevBridge/issues/49) | keep; align index | VM-only #107/DB-020 supersedes its sandbox direction. Preserve remaining controls/resource scope; current milestone belongs to the roadmap. |
| [#103](https://github.com/iteathen/DevBridge/issues/103) | keep; Hello World | Supported discovery/setup remains necessary; broad blank-host acceptance is still open. |
| [#105](https://github.com/iteathen/DevBridge/issues/105) | keep; follow-through | DB-019 cost/evidence contracts remain valid. Reuse current qualification; no claim that every long-suite/recovery criterion is complete. |
| [#107](https://github.com/iteathen/DevBridge/issues/107) | keep; umbrella | Stages 7/8 native provider and operational evidence remain open; do not reopen removed host execution. |
| [#115](https://github.com/iteathen/DevBridge/issues/115) | keep; qualification | Real Hyper-V and KVM/libvirt security, recovery and resource matrix remains incomplete. |
| [#116](https://github.com/iteathen/DevBridge/issues/116) | keep; Hello World | Protected setup and both guest routes must reach the real C canary; broader Linux-host qualification remains distinct. |
| [#117](https://github.com/iteathen/DevBridge/issues/117) | keep; deferred | Final migration cleanup depends on #115/#116; first Hello World does not close this gate. |
| [#132](https://github.com/iteathen/DevBridge/issues/132) | keep; deferred | Optional model/proposal exchange is valid but unnecessary for deterministic C compilation. |
| [#133](https://github.com/iteathen/DevBridge/issues/133) | close not-planned | Historical failed CTest attempt; terminal comment 5363400304 retained. Superseded by #135 and fresh production qualification. |
| [#134](https://github.com/iteathen/DevBridge/issues/134) | close not-planned | Historical failed CTest retry; terminal comment 5363517071 retained. Do not re-dispatch the stale task. |
| [#135](https://github.com/iteathen/DevBridge/issues/135) | close completed | Historical Temp Fast canary completed in comment 5363530375. This proves that old subject only, not current production or both guests. |
| [#136](https://github.com/iteathen/DevBridge/issues/136) | keep; conditional | Private-target Git admission/classification remains valid. PR496 improves delivery but does not prove all Git repair classes. |
| [#137](https://github.com/iteathen/DevBridge/issues/137) | keep; deferred | Specialized/generalized roles remain valid; existing controller-plan operations suffice for first C proof. |
| [#141](https://github.com/iteathen/DevBridge/issues/141) | keep; historical index | Preserve Temp Fast lessons and branch-retirement gate; children still have open acceptance. Not an implementation owner. |
| [#142](https://github.com/iteathen/DevBridge/issues/142) | keep; deferred | Content-addressed source/persistent transport needs its own performance and hostile-cache proof; not required to add a new transport for a tiny C task. |
| [#143](https://github.com/iteathen/DevBridge/issues/143) | keep; Hello World proof | Environment-local scratch is implemented; current production/native and cross-workspace acceptance remains open. Reuse managed-scratch and existing operations. |
| [#148](https://github.com/iteathen/DevBridge/issues/148) | keep; deferred canary | Stdout result source fix is implemented; optional VM model-adapter live acceptance remains unproved and is not a deterministic C prerequisite. |
| [#150](https://github.com/iteathen/DevBridge/issues/150) | keep; installed acceptance | Source-complete per comment 5376345659; live installed owner restart proof remains. Do not add a second restart mechanism. |
| [#153](https://github.com/iteathen/DevBridge/issues/153) | keep; recovery acceptance | Current entry/recovery work exists, but historical compatibility and VM-validated runtime adoption are distinct remaining proof. |
| [#157](https://github.com/iteathen/DevBridge/issues/157) | keep; deferred canary | Exact historical migration acceptance belongs to #153; preserve its bounded fixture constraints and do not run it for Hello World. |
| [#159](https://github.com/iteathen/DevBridge/issues/159) | keep; entry qualification | HO171 proves canonical Node24 publication/cache recovery; global stable/experimental/recovery and compatibility claims remain scoped. #491 stays separate. |
| [#162](https://github.com/iteathen/DevBridge/issues/162) | keep; align sequencing | Generalized compute routing follows qualified backend evidence. Its #186/emulation-first priority is stale; #395 is the active GPU owner after Hello World. |
| [#168](https://github.com/iteathen/DevBridge/issues/168) | close not-planned | No result comment; obsolete capability probe bound to the temporary compatibility control plane. No success claimed. |
| [#169](https://github.com/iteathen/DevBridge/issues/169) | keep; umbrella | Shared lifecycle exists but real missing-disk/recovery acceptance remains incomplete. |
| [#170](https://github.com/iteathen/DevBridge/issues/170) | keep; contract review | Declaration/observation/journal owners and tests exist. Check incomplete implementation identity in readiness classification before claiming full acceptance. |
| [#171](https://github.com/iteathen/DevBridge/issues/171) | keep; native acceptance | Shared restartable create pipeline is code-qualified; real create on both provider families remains open. |
| [#172](https://github.com/iteathen/DevBridge/issues/172) | keep; native acceptance | Diagnosis/repair code is qualified; native differentiated fault injection remains. |
| [#173](https://github.com/iteathen/DevBridge/issues/173) | keep; recovery acceptance | Rebuild preserves exact declared image identity; missing-disk/cache recovery proof remains with #201. |
| [#174](https://github.com/iteathen/DevBridge/issues/174) | keep; deferred qualification | Reset code is qualified; destructive native canaries require exact impact authority and are not the first Hello World run. |
| [#175](https://github.com/iteathen/DevBridge/issues/175) | keep; deferred qualification | Recreate code exists; real replacement/retirement canaries remain separate. |
| [#176](https://github.com/iteathen/DevBridge/issues/176) | keep; Hello World | Construction/error visibility and final supported recovery UX remain open; consume #493 evidence, not disk growth as completion. |
| [#177](https://github.com/iteathen/DevBridge/issues/177) | keep; security umbrella | Windows/Linux protected provider/storage proof is platform-scoped. Linux remains independently unqualified. |
| [#178](https://github.com/iteathen/DevBridge/issues/178) | keep; recovery acceptance | Exact image acquisition/bundle owners exist; real image-loss/reacquisition/rebuild matrix remains incomplete. |
| [#180](https://github.com/iteathen/DevBridge/issues/180) | keep; recovery umbrella | Whole entry-to-runtime-to-environment recovery is not proved by a successful entry publication. |
| [#182](https://github.com/iteathen/DevBridge/issues/182) | keep; recovery acceptance | VM-only candidate validation and missing-validation-environment recovery remain required; no host validation bypass. |
| [#190](https://github.com/iteathen/DevBridge/issues/190) | close not-planned | No result comment; stale scratch qualification task bound to old runtime 1dc02268. Fresh exact production task will replace it. |
| [#192](https://github.com/iteathen/DevBridge/issues/192) | keep; image umbrella | Source, distribution, activation and declaration authorities remain distinct; first usable profiles are needed, broader fresh-host acceptance remains. |
| [#197](https://github.com/iteathen/DevBridge/issues/197) | keep; immediate blocker | Current retained Ubuntu installer failed. Actual basis, compatible package transaction and accepted image are not yet qualified. |
| [#198](https://github.com/iteathen/DevBridge/issues/198) | keep; Hello World | Production Windows source/build/generalization/tooling qualification remains required. |
| [#199](https://github.com/iteathen/DevBridge/issues/199) | keep; Hello World policy | Windows activation/licensing authority must be observed separately under local policy; no inferred entitlement. |
| [#200](https://github.com/iteathen/DevBridge/issues/200) | keep; recovery follow-through | Private user-derived distribution/rights policy remains valid; use existing accepted local policy for first profiles. |
| [#201](https://github.com/iteathen/DevBridge/issues/201) | keep; align sequencing | Broad blank-slate/image-loss/activation/re-entry matrix remains open; stale #186 ordering must not expand the first Hello World milestone. |
| [#212](https://github.com/iteathen/DevBridge/issues/212) | close not-planned | No result comment; old one-off local inventory probe is obsolete. Inventory must be observed against the selected current runner. |
| [#214](https://github.com/iteathen/DevBridge/issues/214) | keep; deferred breadth | Secure generic guest console remains valid; use existing admitted build/test operations for first program. Early installation collection belongs to #493. |
| [#215](https://github.com/iteathen/DevBridge/issues/215) | keep; deferred breadth | Generic user-defined observations remain valid; do not gate default error delivery on a new collector framework. |
| [#283](https://github.com/iteathen/DevBridge/issues/283) | keep; align sequencing | ROCm/emulation/native AMD is additional backend work after the confirmed milestones, not ahead of NVIDIA CUDA-JS. |
| [#290](https://github.com/iteathen/DevBridge/issues/290) | keep; reliability | Later documented load-sensitive recurrence remains despite successful reruns. Current green CI is not a root-cause resolution. |
| [#293](https://github.com/iteathen/DevBridge/issues/293) | keep; Linux native gate | Latest comment 5467299352 retains physical Linux service/provider/storage/guest gates; earlier draft-PR scheduling is historical. |
| [#328](https://github.com/iteathen/DevBridge/issues/328) | keep; reliability | Reopened after a 60-second prefix-child timeout; comment 5506843056 explicitly retains the recurrence. No further timeout widening. |
| [#360](https://github.com/iteathen/DevBridge/issues/360) | keep; Hello World | Protected profile/image/lifecycle/route composition must pass a native fixed C task through public setup. |
| [#362](https://github.com/iteathen/DevBridge/issues/362) | keep; Hello World | Protected activity contract exists; real Linux and Windows C payloads, restart and failure behavior remain unproved. |
| [#364](https://github.com/iteathen/DevBridge/issues/364) | keep; conditional setup | Exact conflicting WinNAT retirement is valid where needed; no conflict or destructive action is inferred now. |
| [#372](https://github.com/iteathen/DevBridge/issues/372) | keep; Hello World | Non-elevated protected profile reconciliation still needs complete accepted-profile/route/C-canary proof. |
| [#373](https://github.com/iteathen/DevBridge/issues/373) | keep; Linux native gate | Portable Linux configuration is implemented; comment 5459484776 preserves real tmpfiles/systemd/permissions proof. |
| [#374](https://github.com/iteathen/DevBridge/issues/374) | keep; Linux native gate | Portable activity and real Unix socket recovery are qualified; comment 5459714954 retains dedicated-principal/libvirt/guest proof. |
| [#391](https://github.com/iteathen/DevBridge/issues/391) | keep; deferred qualification | Versioned application removal exists; complete exact removal/purge and native retention acceptance is not implied. No broad cleanup. |
| [#392](https://github.com/iteathen/DevBridge/issues/392) | keep; reliability | Reopened after a 60-second New-VM contract-child timeout; comment 5506842995 retains recurrence despite green rerun. |
| [#395](https://github.com/iteathen/DevBridge/issues/395) | keep; milestone two | Real NVIDIA driver/GPU support for actual CUDA-JS tests follows Hello World; host-retained authority rules remain. |
| [#417](https://github.com/iteathen/DevBridge/issues/417) | keep; Hello World dependency | Origin-resilient acquisition/capsule work exists; consumer-aligned installer transaction remains open via #488/#197. |
| [#419](https://github.com/iteathen/DevBridge/issues/419) | keep; milestone two | PR421 attachment policy is not native listeners or GPU execution; retain as GPU transport owner after Hello World. |
| [#429](https://github.com/iteathen/DevBridge/issues/429) | keep; setup evidence | Setup duration/reuse improvements exist; complete ordinary native timing/UX acceptance remains distinct from construction #176. |
| [#430](https://github.com/iteathen/DevBridge/issues/430) | keep; explicit elevation | Immediate entry and no delayed prompt contract remains valid; no new UAC proof or authority is inferred. |
| [#432](https://github.com/iteathen/DevBridge/issues/432) | keep; installed timing | Batch observation is implemented; verify the full installed timing/retention criterion before closure, using existing owner evidence. |
| [#449](https://github.com/iteathen/DevBridge/issues/449) | keep; test hygiene | Whole-suite zero new roots/children acceptance is not established by partial fixture cleanup. No denied cleanup retries. |
| [#475](https://github.com/iteathen/DevBridge/issues/475) | keep; remaining cleanup | PR492 fixes bounded live progress/deadline coordination; descendant-tree cancellation/cleanup remains explicitly open. |
| [#487](https://github.com/iteathen/DevBridge/issues/487) | close completed | PR490 integrated the exact-file UDF writer. Current writer and three media test files are byte-identical in Git to native-qualified 7c6c7516; HO162 verified all 2564 original files. APT/guest consumption remains #488/#197. |
| [#488](https://github.com/iteathen/DevBridge/issues/488) | keep; immediate blocker | Source binding is integrated; actual pre-late-command basis and consumer-aligned offline APT still unqualified. Do not sign extracted-base assumptions. |
| [#489](https://github.com/iteathen/DevBridge/issues/489) | keep; immediate blocker | Native capture exists with exact hash/metadata; full export/normalization/admission remains unproved. Preserve retained VM. |
| [#491](https://github.com/iteathen/DevBridge/issues/491) | keep; separate compatibility | Cross-Node durable filesystem identity compatibility remains unqualified; Node24 success does not resolve Node22 receipts. |
| [#493](https://github.com/iteathen/DevBridge/issues/493) | keep; immediate blocker | PR496 delivery owner is integrated and live GitHub failure recovery proved; native pre-runtime collection/correlation and expanded evidence remain. |
| [#498](https://github.com/iteathen/DevBridge/issues/498) | keep; milestone three | MCP adapter remains deferred until GPU; reuse existing task/lease/result/publication owners. |

## Evidence and scope

Baseline Stage8 `ca433fc4383d8ee31bc3243965ae9b687c8f090d`, tree `45e2b146ba7c7d9b8816b642c5eaa280fa80ddd1`; integrated CI [34004369949](https://github.com/iteathen/DevBridge/actions/runs/34004369949) passed all four jobs. PR #496 delivery proof is on task #497. PR #490 integrated the #487 media owner; its current exact bytes retain HO162 native media readback evidence. No new physical action follows from this audit.

Reviewed implementation boundaries include environment declaration/observation/journal and shared construction, managed scratch/deterministic C acceptance, protected setup/activity composition, existing Windows IMAPI media, and durable status delivery. Native create/repair/rebuild/reset/recreate and Linux protected-host claims remain with their existing acceptance issues. Operator evidence includes the before snapshot, decisive issue-detail snapshots and the machine-readable disposition ledger.
