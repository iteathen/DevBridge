# Working DevBridge implementation plan

Updated 2026-09-06. This is the current delivery plan. AGENTS.md and specifications DB-001 through DB-020 govern implementation; dated handoffs and qualification reports preserve evidence rather than add approval gates.

## Delivery order

1. **Hello World:** accept a GitHub task, compile a small C/CMake program, run CTest in both Linux and Windows execution-profile VMs, and automatically return the results to that task.
2. **NVIDIA GPU support for CUDA-JS:** expose a real supported GPU and driver through the VM execution path, then compile and run a CUDA test. Preserve the accepted host-retained GPU direction and host-only control authority.
3. **MCP:** expose existing DevBridge operations through an MCP adapter without creating a second control plane or granting authority through tool descriptions.

## Current Hello World work

The integrated Stage 8 source is `c57bacd1198d5c71734aebd7222c47a3699d53f6` (PR #506). Its tree equals the candidate that passed all four Ubuntu/Windows [CI jobs](https://github.com/iteathen/DevBridge/actions/runs/34024678975).

- **Ubuntu construction (#197):** the installer previously fetched newer packages from moving mirrors before late commands used the accepted snapshot. Recipe v17/output v13 pin the installer primary/security sources to that same snapshot, disable geographic mirror substitution, and abort if no mirror is usable. Native APT testing proves default candidate selection remains frozen even with a newer live version available, while installer-media paths remain usable. Fresh physical construction is the next proof.
- **Automatic errors (#493):** the registry prerequisite is removed. The actual host-to-guest socket exchange passed with an ordinary Windows token and no service registration. Installer hooks explicitly invoke their shell on the live image's noexec mount. The host reader uses the .NET SHA-256 implementation when Get-FileHash is unavailable. Fresh automatic provisioning and originating-task correlation still need operational proof.
- **Windows construction:** provision and qualify the real Windows development profile, including its compiler, CMake and CTest. An accepted configuration or mocked provider does not establish readiness.
- **Task execution:** use the existing GitHub provenance, local operation registration, VM bridge, host verification and status-delivery path. Keep each compiler invocation and test run inside its selected profile VM.

The current Ubuntu production installer uses online Canonical snapshot APT. The offline capsule consumer is not attached to that path. Its unfinished admission and application work (#417/#488) is a separate reliability track, not an extra prerequisite for testing the existing installer or delivering Hello World. Preserve its signed artifacts, captured package basis and completed solver evidence for reuse.

## Acceptance evidence

For each Linux and Windows Hello World run, retain the originating task/run/attempt, selected environment, verified source identity, compiler/build/test result and originating GitHub result link. Completion requires successful real VM execution and automatic delivery.

A deliberate compile or test failure must return useful bounded, redacted error text automatically. Provisioning failures must also report useful evidence before Node or SSH is available. Missing or truncated evidence must be explicit; publication recovery must not rerun failed work or create duplicate comments.

## Engineering practice

Work through the relevant owner and its existing interfaces. Use LEGO at boundaries, SOLID within components, CUPID for predictable behavior, and KISS for the smallest complete implementation. Keep GitHub credentials, signing keys, authoritative Git and provider-management authority on the host. Preserve exact VM/seed ownership, bounded responses, deadlines and durable retry state. Do not write or introduce Python tooling.

The owner has approved ongoing engineering, native qualification and reviewed merges. Checkpoints do not pause work. Use focused tests for affected behavior and required CI, reuse still-valid evidence, and avoid repeating complete qualification merely because a task resumed or a squash merge preserved the tree. Retain failed-attempt evidence before replacement; use supported lifecycle operations and preserve unrelated or accepted state.

Primary references for the current APT fix: [Curtin source templates](https://curtin.readthedocs.io/en/latest/topics/apt_source.html#using-templates) and [Ubuntu per-source snapshots](https://ubuntu.com/server/docs/how-to/software/snapshot-service/). Actual APT update refreshes live indexes too; the relevant property is frozen package selection, not absence of live URLs in update output.

Historical phase plans remain in Git history. Detailed evidence remains in [installer diagnostics](testing/DB-HO176-installer-failure-evidence.md), [installation-source binding](testing/DB-HO164-capsule-install-source-binding.md), and the dated reports under docs/testing. Completed work should be reused rather than restarted from those reports.
