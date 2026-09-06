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
| Linux | GitHub admission -> VM CMake compile -> CTest output -> automatic GitHub result | Unproved; Ubuntu image `img-c91420f1765ac0c9f23f0267f1fcb825` / `ubuntu-2604-production-v14` is qualified; protected environment activation/recovery remains pending |
| Windows | GitHub admission -> VM CMake compile -> CTest output -> automatic GitHub result | Unproved; production image/setup/route readiness still requires qualification |

Guest OS and host provider are separate axes. Proving both guests on the current
Windows/Hyper-V host satisfies these operational rows only. Linux-host
KVM/QEMU/libvirt remains first-class under DB-020 and #115, and neither that
provider's native qualification nor final Stage-7/8/9 completion follows from
Hyper-V evidence. Common code and changed contracts must retain both adapters.

## Failure behavior on the exercised path

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

September 6 checkpoint: the supported Ubuntu construction and qualification path
has completed. Reuse that accepted image. The next Linux step is installing the
merged interrupted-create recovery fix (#515), reconciling the old operation,
and activating the current declaration. Windows construction is testing its
unattended audit handoff (#516). Neither guest has completed the GitHub Hello
World task. The responsibilities below remain acceptance scope, not instructions
to repeat completed image or package-basis qualification.

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
