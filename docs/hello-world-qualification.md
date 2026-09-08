# Hello World qualification

Status: active first operational milestone; not yet proved. This procedure
applies DB-002/003/007/009/013/017/019/020 without granting new capability or
replacing their acceptance requirements. GPU testing and MCP follow this gate.

## Observable result

An authorized user submits a small C program through the normal GitHub task
contract. DevBridge materializes its exact source in an admitted repository
workspace, configures and compiles it with CMake, executes tests through CTest,
and automatically returns the result to the originating GitHub task. Demonstrate
this on both a Linux guest and a Windows guest.

Use the existing controller-plan, deterministic operation, source/result transfer,
run, verification and GitHub status owners. The locally admitted routing policy
selects each profile. Separate task subjects may exercise the profiles in sequence;
this milestone does not require a new fan-out scheduler or allow a task to select
provider handles. Preserve the originating task link for every result.

## Small test project

Use `cmake.configure`, `cmake.build` and `ctest.run`, with ephemeral source and
environment-local build scratch. Reuse `src/run/deterministic-c-acceptance.js`
for the existing bounded challenge and operation pattern; keep the normal task
envelope and operation admission. The program must print `Hello, world!` and a
fresh run-bound challenge. CTest must assert output and fail on an incorrect
result. Require zero configure/build/test exit status, an actually executed test,
and captured verbose test output containing the expected challenge.

The challenge helps reject stale results; it is not proof against a compromised
guest. The host still verifies exact source/operation/environment/result identity.
Do not require a particular compiler vendor's banner: supported Linux and Windows
toolchains may differ. Record the observed toolchain instead. A hosted test, host
compile, mocked bridge, manually pasted result or interpreter-only run does not
prove the requested VM path.

## Evidence for each guest

Record an immutable qualification manifest and bounded linked logs containing:

- originating GitHub repository/task/revision and accepted author provenance;
- DevBridge source/tree, installed entry/runner/runtime and local policy identity;
- task run/attempt, plan/source digests, baseline and exact operation results;
- profile/workspace, provider instance, accepted image and environment generation;
- bridge/toolchain observations, compile/test exits, test count and expected output;
- durable terminal state and confirmed originating GitHub result/comment identity.

Public output provides useful results and redacted errors, not host paths or
authority-bearing configuration. Keep detailed local evidence behind its owner.
Record missing evidence explicitly. Final acceptance requires both guest rows
below to pass; partial success remains useful evidence rather than completion.

| Guest | Required operational evidence | Current status |
| --- | --- | --- |
| Linux | GitHub admission -> VM CMake compile -> CTest output -> automatic GitHub result | Passed September 8 on the unchanged accepted v14 image: #523 success, #524 compiler failure, #525 test failure. All registered operations were observed once, host source identity/cleanup validated, and normal GitHub results confirmed. Terminal-delivery restart recovery preserved #523's completed operations exactly. |
| Windows | GitHub admission -> VM CMake compile -> CTest output -> automatic GitHub result | Unproved; the accepted v6 image remains unchanged. Fresh bootstrap qualification passed. The same production create operation resumed September 8 after sufficient host storage became available; operational cases remain outstanding. |

September 8 native bootstrap qualification created disposable guests from both
accepted finalized images and verified the actual first-access seed path, contents,
bridge access and owned cleanup. The Linux qualification identity is
`883c3d67-a7d4-4e60-87a2-be59da68ca68`; the Windows identity is
`597b4a1b-12e6-4f50-b042-96f31f3adb29`. These qualify bootstrap on this Hyper-V
host. They do not establish compilation, task result delivery or KVM support.

The operational milestone requires six workflow cases: success, compiler failure
and test failure on each guest route. A terminal-delivery interruption followed by
a fresh installed process must demonstrate that completed repository work is not
repeated. The Linux terminal-delivery interruption/restart preserved all completed
operation records and reconciled the same GitHub comment. Source transfer batching
has consumer/provider tests and was exercised by the installed runner for #524 and
#525; Windows workflow qualification remains outstanding.

Guest OS and host provider are separate axes. Proving both guests on the current
Windows/Hyper-V host satisfies these operational rows only. Linux-host
KVM/QEMU/libvirt remains first-class under DB-020 and #115, and neither that
provider's native qualification nor final Stage-7/8/9 completion follows from
Hyper-V evidence. Common code and changed contracts must retain both adapters.

## Failure behavior on the exercised path

### September 8 latency repair cycle

Assess every task against the fact it establishes and the consumer needing that
fact. Existing valid evidence should remove work, not merely add another check.
The measured defects are full retransmission after small source changes, repeated
preparation, and one native inspection/connection setup per transfer frame.

Repair source synchronization first: ask the guest which staged parts still match
the exact manifest, send only missing/corrupt parts, and retain full application
digest validation. Then move connection lifetime and readiness reuse into the
activity/provider owner, with current declaration/generation/policy checks and
disconnect/cancellation recovery. Keep the existing public v1 formats readable.
Microsoft documents persistent PowerShell Direct sessions; Node's child-process
pipes provide the bounded transport mechanism. These support connection reuse,
not cross-subject authority caching. Research: [PowerShell Direct](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/powershell-direct),
[Node child processes](https://nodejs.org/docs/latest-v22.x/api/child_process.html).

Qualify each repair with focused normal/failure/recovery tests, then measure the
normal installed workflow on both running guests. Compare guest compute time,
transferred bytes, required exchanges and external API time separately from
startup. A reduced duration alone is insufficient: every remaining substantial
cost needs a necessary task or a concrete next repair. The previous nine-minute
Linux workflow is not an acceptable warm Hello World result.

CI now runs static/artifact prerequisites first, followed by one full behavioral
suite per host platform. The static-only preflight explicitly reports zero tests;
the normal/candidate preflight default still runs its behavioral checks. Separate
identity, installer and architecture invocations were duplicate subsets of the
full suite and are removed from CI. This changes engineering verification cost,
not guest admission or runtime authority.

September 8 transfer investigation: task #523's first `cmake.configure` attempt
spent over an hour preparing its workspace, before compiler execution. Read-only
guest observations at 21:02:36 and 21:03:00 UTC found 316 then 318 of 355 source
parts, no applied manifest, and no compiler process. The source snapshot contains
2,672,576 bytes and required 397 original 16 KiB transfer frames. A 53-second host
sample saw six successive activity workers and repeated global foundation/image
and selected-environment inspections. Direct verified SSH exchanges measured
244–296 ms; repeated control-plane work dominated the transfer delay.

The correction packs source parts without changing accepted images, separates
activity composition from aggregate image health, and scopes physical lookup
before native observation. Transfer/preparation phases use the existing durable
liveness contract and are identified separately from registered tool execution.
Focused contract and consumer tests pass. The installed corrected runner completed
#524 and #525 in about nine minutes each, compared with about 74 minutes for the
earlier #523 workflow. These are different cases, not a controlled benchmark.
For #525, actual configure/build/test durations were 405/370/142 ms. The surrounding
preparation, transfer and control-plane work remains disproportionately expensive.

At 21:48 UTC on September 8, Hyper-V reported the Linux guest
`9c0d8a6b-2aba-4c9d-be35-bc0b755293b0` running with about 44 hours of continuous
uptime. The three Linux jobs therefore did not pay for a guest boot. Repeated
startup preparation is a separate implementation gap, documented in Stage 5/6;
DB-020 now explicitly requires keeping ready guests running and reusing valid
owner-produced readiness between jobs. These Linux observations do not establish
Windows or KVM behavior.

Before calling the milestone complete, exercise a compile error and a failed
test on each claimed guest route. The originating GitHub task must receive useful
redacted error text, stage, known exit status and missing/truncated-evidence
indicators automatically. Prove collection and status recovery without rerunning
failed work, reusing exact still-valid evidence under DB-019 where applicable.
PR #496's real GitHub preparation-failure/outage/ambiguous-POST proof qualifies
that delivery owner, not native installer collection or VM compilation.

Installation/provisioning is part of the path whenever needed for readiness.
Failures there must satisfy DB-009's pre-runtime contract. #493 owns collection
and delivery; #176 consumes the same result for lifecycle visibility. Do not make
desktop access, SSH, a debug flag or a later log request a production prerequisite.

## Work order and ownership

The warm-transport repair preserves public v1 activity requests and existing
guest journals. The protected Windows service reuses one bounded activity worker;
Hyper-V retains an authenticated connection bound to current authority and physical
generation. Committed identity reads replace repeated native attachment scans.
Focused provider, stream, state, routing and consumer tests pass, including a
compiled Windows host serving 100 sequential requests from one worker, replacing
it after cancellation and retaining it across read-only configuration access. Preflight's three fixed inventory-count
assertions were replaced with actual invocation/inventory checks; their focused
tests pass. Both native Hyper-V connection timings now pass; installed workflow
timings remain outstanding. This does not qualify native KVM or claim the latency milestone done.

The next native qualification uses the current accepted, running Linux and Windows
guests to measure repeated exact bridge health exchanges, verify separate target
binding and connection-loss recovery, and inspect current Windows readiness through
its owner. This transport change neither modifies the accepted image nor changes
first-access enrollment; no image reconstruction is part of this qualification.
Activate the exact qualified component once, then measure the ordinary installed
source/compile/test/result path. Compare actual guest compute with necessary
source validation, transfer, authority and delivery cost, identifying remaining
disproportionate phases rather than accepting the earlier nine-minute runs.

Native continuation: Linux exchanges passed at 116–131 ms after a 4562 ms initial
connection; closing and reopening the same target passed in 4216 ms. The direct
administrator helper could not resolve Windows credentials because those records
use the service account's DPAPI `CurrentUser` scope. That is a qualification-context
error, not evidence that the installed Windows access is broken. Microsoft defines
this scope as readable only under the protecting account's context:
[DataProtectionScope](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.dataprotectionscope).
Run Windows consumer qualification through the service's ordinary activity port
inside the existing exact-generation activation/health/rollback transaction.
Keep the previous service generation available if candidate health fails.
An isolated compiled-host fixture does not prove access to production credentials.

Windows access material now reuses an already verified decrypted value within its
own bounded process cache, reading and validating the current protected record
on every lookup. Changed/deleted records and process restart invalidate reuse.
Focused tests include actual Windows DPAPI and record substitution/recovery; the
accepted guest credentials and encryption scope remain unchanged. This removes
repeated PowerShell decryption from warm frames without exporting credentials.

The operator explicitly requested retaining reusable work contexts. Healthy
activity workers and provider connections therefore remain owned by the running
service instead of expiring on an idle timer or request count. Message/response
bounds, serialized effects, bounded caches, cancellation and shutdown cleanup
remain enforced. The current qualification controller likewise retains its
elevated task context; that tooling is outside the product and does not alter
DevBridge's service authorization model.

The installed `83600db` candidate passed its normal service probes and both guest
consumer checks inside the existing activation/rollback transaction. Linux health
requests took 4368 ms initially and 112–130 ms warm; Windows took 6335 ms initially
and 88–114 ms warm. Windows resumed the same accepted lifecycle operation and
reported healthy with the same physical generation and accepted image. Native
evidence is retained in `activity-session-candidate-20260908d/result.json` under
the local review evidence directory. No new image construction was necessary.

The next ordinary execution repair selects only the requested subject/profile
observation after startup inventory. Its contract tests prove a changed selected
route still rejects admission without repeating global listing. The existing
service and its native connection evidence remain applicable: this correction
changes the ordinary consumer's calls through unchanged v1 activity operations.

September 8 checkpoint: the supported Ubuntu and Windows construction and image
qualification paths have completed. Reuse both accepted images. Linux recovery
and all three workflow cases have completed, including terminal-delivery restart
recovery. Continue the accepted Windows operation and then exercise its three
normal workflow cases. Warm-guest preparation overhead remains an identified
ownership repair; it does not justify another image build or Linux replacement.
The responsibilities below remain acceptance scope, not instructions to repeat
completed image or package-basis qualification.

1. Establish bounded, exact pre-runtime evidence collection/export through the
   existing OS builder/provider/lifecycle/result owners (#493/#176). Preserve the
   retained failed VM and captured package state; no deadline reset or blind retry.
2. Export and admit the actual installation basis (#489), qualify the existing
   package solver/consumer against that basis (#488/#417/#197), and obtain an
   accepted Ubuntu image through the supported construction/qualification path.
3. Establish Windows image/activation/setup readiness through the existing
   #198/#199/#192 owners and current local source/licensing policy. No manually
   staged image becomes accepted merely because it boots.
4. Verify the exact Linux and Windows routes through the existing #362/#372/#116
   setup and protected activity owners, then run the GitHub acceptance subjects.
5. Record both success and failure evidence, reconcile every pending delivery,
   review the exact result, and declare the milestone only after all rows pass.

These are dependency responsibilities, not new registries or replacement stacks.
The issue audit determines the next smallest complete change inside each owner.
Broader fresh-host, image-loss, recreation, generic console/observation and
cross-provider qualification remain valid follow-through; pull them into this
milestone only when the exercised route needs them. A missing implementation is
engineering work, not by itself an external blocker. Continue safe code, tests,
research and review while an exact integration or physical-operation decision is
pending. Preserve the existing retained-state and local-authority constraints.
