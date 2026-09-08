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
| Linux | GitHub admission -> VM CMake compile -> CTest output -> automatic GitHub result | Unproved; the accepted v14 image remains unchanged; the existing rebuild resumed to ready on September 8. GitHub task #523 has entered the normal installed workflow; its compile/test result is still pending. |
| Windows | GitHub admission -> VM CMake compile -> CTest output -> automatic GitHub result | Unproved; the accepted v6 image remains unchanged. Fresh bootstrap qualification passed, but the production create operation last reported insufficient host storage and still requires owner continuation. |

September 8 native bootstrap qualification created disposable guests from both
accepted finalized images and verified the actual first-access seed path, contents,
bridge access and owned cleanup. The Linux qualification identity is
`883c3d67-a7d4-4e60-87a2-be59da68ca68`; the Windows identity is
`597b4a1b-12e6-4f50-b042-96f31f3adb29`. These qualify bootstrap on this Hyper-V
host. They do not establish compilation, task result delivery or KVM support.

The operational milestone requires six workflow cases: success, compiler failure
and test failure on each guest route. A terminal-delivery interruption followed by
a fresh installed process must demonstrate that completed repository work is not
repeated. Source transfer batching has consumer/provider tests; its native workflow
qualification remains outstanding until exercised by the installed runner.

Guest OS and host provider are separate axes. Proving both guests on the current
Windows/Hyper-V host satisfies these operational rows only. Linux-host
KVM/QEMU/libvirt remains first-class under DB-020 and #115, and neither that
provider's native qualification nor final Stage-7/8/9 completion follows from
Hyper-V evidence. Common code and changed contracts must retain both adapters.

## Failure behavior on the exercised path

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
Focused contract and consumer tests pass. Native before/after workflow timing and
the six-case milestone remain outstanding; this diagnosis is not compile proof.

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

September 7 checkpoint: the supported Ubuntu and Windows construction and image
qualification paths have completed. Reuse both accepted images. The interrupted
Linux create has been reconciled and the service disconnect fix is installed.
The next Linux step is resuming its existing rebuild from the image in the
current declaration (HO196), followed by accepted profile activation and ordinary
setup verification. Neither guest has completed the GitHub Hello World task.
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
