# DB-HO042 — issue #360 deterministic C route acceptance

Status: implemented and hosted-qualified from exact predecessor `561a836d23b6238d22413eb1696d068b8e57de48` on `stage8/362-protected-activity-channel`; physical guest-route qualification remains pending.

## Assessment

Minimal functionality requires one fixed C program to traverse the supported deterministic controller-plan path, compile and execute inside each exact admitted guest, return the expected result, and repeat after restart. The physical Linux profile is temporarily blocked at its saved host-elevation frontier, but the acceptance payload and evidence contract are not yet a first-class reusable plan.

The existing `chat-c-project-probe` is not suitable acceptance evidence. It is a self-materializing diagnostic helper with its own process flow. Using it would not prove controller-plan materialization, locally registered operations, repository execution routing, guest scratch cleanup, or the absence of a special acceptance bypass.

The existing generic primitives are sufficient with one bounded evidence option:

- controller plans can create ephemeral source/project files, invoke registered operations, assert bounded results, require an empty changed-path set, and clean both worktree and environment scratch;
- `cmake.configure`, `cmake.build`, and `ctest.run` are repository-code operations and therefore require the repository execution stud; missing execution fails before a host compiler/process is selected;
- CMake target expressions can identify the exact built executable without exposing an OS path to the controller; and
- current `ctest.run` hides successful test output, so challenge and digest output are not returned as evidence even when CTest validates them internally.

## Primary-source research

- CMake's [`add_test`](https://cmake.org/cmake/help/latest/command/add_test.html) contract resolves an executable target to its built location, including the active configuration, so the plan does not need to predict Windows versus Linux artifact paths.
- [`PASS_REGULAR_EXPRESSION`](https://cmake.org/cmake/help/latest/prop_test/PASS_REGULAR_EXPRESSION.html) makes the exact challenge a CTest success condition rather than merely diagnostic text.
- The [`ctest`](https://cmake.org/cmake/help/latest/manual/ctest.1.html) verbose option includes successful test command/output in the bounded result stream.
- The [`cmake -E`](https://cmake.org/cmake/help/latest/manual/cmake.1.html#run-a-command-line-tool) command surface includes `sha256sum`, allowing a second CTest to report the exact built executable digest through the same target expression and test-result channel.

These are tool-owned interfaces used inside the guest. They add no host execution authority and do not change provider behavior.

## Reassessment

The smallest complete fixture is a normalized controller plan containing only ephemeral `CMakeLists.txt` and `main.c` files. It defines one target and two tests:

1. execute the target and require the exact bounded run challenge in stdout;
2. invoke CMake's fixed SHA-256 helper on the exact target and return the digest.

The plan runs configure, build, and verbose CTest through existing locally registered operations. Every operation must exit zero; the final CTest stream must contain the exact challenge, both test identities, the digest test result, and the complete-pass marker. `expectedChangedPaths` is empty, so cleanup and final workspace validation prove that the acceptance makes no repository change.

`ctest.run` needs one optional boolean `verbose` property. This is local result-detail policy, not raw argv or executable authority. False preserves existing behavior; true adds only the fixed `--verbose` argument. Unknown or non-boolean values remain rejected.

The challenge is a bounded safe token supplied by the host acceptance owner and included in the normalized plan digest. The plan factory contains no repository, provider, OS/profile, VM, credential, path, model, or remote identity. Topology supplies the exact route transiently when the ordinary run executes.

## Dependency-ordered plan

1. Add the closed optional verbose result flag to the existing CTest operation and its public schema/tests.
2. Add a self-contained deterministic C acceptance plan factory with strict challenge validation.
3. Materialize only ephemeral source/project files and require empty changed paths.
4. Bind exact C execution and executable hashing through CMake target-aware tests.
5. Assert configure/build/test exit codes and bounded challenge/digest-test/pass markers.
6. Prove stable normalized plan/digest, invalid challenge refusal, no external topology vocabulary, fixed operation identities, and fail-closed repository-code classification.
7. Run focused tests, repository preflight, and the complete suite; append exact evidence before commit.
8. After protected profile activation, execute the same normalized plan through the real Linux route, then the Windows route, and repeat both after restart.

No host UAC, provider, VM, guest, route, repository, or operational configuration effect is part of this software checkpoint.

## Implementation checkpoint

The acceptance factory now emits one normalized `devbridge/controller-plan-v1` value. For challenge `DEVBRIDGE_ROUTE_42A6E90C`, its exact plan digest is `e5869626ecdaa0419c7f90bb79c5ef3b71358ea291c22e11c4bc38eb015022bb`. The two ephemeral inputs are bound as:

- `CMakeLists.txt`: `867ac713fe24ec66fa68a1ef1af8e602b0c089bff6a5ccf2ff4d5f4456265e6a`;
- `main.c`: `92cc46bea18340103bf5913065df42bf26919701b1859fe51300cb196cd31e3e`.

The existing CTest adapter accepts only an optional boolean `verbose` property and translates `true` to the fixed local `--verbose` argument. It still rejects unknown parameters and non-boolean values. The plan carries no executable, host path, credential, provider, environment, profile, repository, model, or remote identity. All three registered operations retain repository-code classification and therefore cannot select a host-direct fallback.

Hosted evidence on 2026-08-28:

- syntax checks passed for the changed operation and plan modules;
- focused acceptance, operation-registry, and scratch-contract tests: 9 passed, 0 failed;
- repository preflight: 100 syntax files, 2 JSON files, and 96 targeted test files passed;
- the first complete 1,544-test run reported 1,528 passed, 15 skipped, and one transient Windows `EPERM` while reading a daemon-pause fixture in the temporary directory; the isolated owning suite immediately passed all 6 tests;
- a fresh complete-suite run then passed: 1,529 passed, 15 platform skips, 0 failed.

This checkpoint proves plan determinism, closed input/operation contracts, repository-code classification, and the generic cleanup/evidence composition. It deliberately does **not** claim that either physical guest executed the plan. Linux execution requires the active protected profile to finish construction/configuration; Windows still requires locally approved installation media and its separate accepted profile.
