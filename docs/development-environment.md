# Persistent development environment approach

Status: active design direction for DevBridge development environments.

This document defines how DevBridge should approach the software environment inside persistent execution-profile VMs. It complements [`execution-profile-environments.md`](execution-profile-environments.md), which owns VM/workspace state boundaries, and DB-020, which owns the VM-only repository-execution security boundary.

The central goal is broad practical development coverage without turning DevBridge into a bespoke installer, automation adapter, or diagnostic implementation for every current and future development tool.

## Governing model

A DevBridge execution-profile VM is a **persistent, adaptable, untrusted development workstation**.

DevBridge should provide a strong foundation and preserve the hard host/guest authority boundary. Agents and projects should use ordinary guest operating-system and ecosystem tooling to prepare the persistent environment for the work they actually need.

The intended model is:

```text
trusted DevBridge host control plane
        |
        | admitted guest execution
        v
persistent untrusted profile VM
        |
        +-- capable bootstrap/tool foundation
        +-- shared profile-level tools and caches
        +-- indirect guest console (planned primary extensibility surface)
        +-- repository-isolated workspaces
        |       +-- project dependencies
        |       +-- local tool environments
        |       +-- build/test state
        |       +-- project-defined observation procedures
        |
        +-- optional GUI software
```

The profile VM may survive many repository and task lifetimes. Repository workspaces may survive many tasks. Preparation cost is therefore amortized instead of being paid for every execution.

## Core principles

### 1. Persistent workstation, not disposable CI image

The default environment is not expected to reset to a pristine image after every task.

An agent may discover that a project needs another compiler, SDK, test runner, database, debugger, profiler, package manager, browser, or diagnostic utility and prepare the guest accordingly. If the resulting state is intentionally profile-level, it can remain useful to later work in the same compatible profile.

Persistence is an efficiency feature. It does not eliminate the separate need for reconstruction and recovery after disk loss.

### 2. Console-first extensibility, not one DevBridge installer per tool

DevBridge must not become a universal package manager or accumulate application-specific installation functions such as `installRust`, `installPostgres`, `installZig`, or equivalent vendor-specific setup paths.

The preferred long-tail mechanism is ordinary guest execution through a carefully bounded **indirect console interface**. Existing ecosystem tooling already knows how to install and configure development software:

- OS package managers;
- language package managers and version managers;
- vendor CLIs and unattended installers;
- SDK archives and installers;
- project bootstrap scripts;
- configuration files and environment-local tool directories.

The indirect console is therefore intended to be DevBridge's primary general-purpose extensibility mechanism for ordinary work **inside the guest**.

This is a design target, not permission to expose a host shell. Console implementation must preserve the VM boundary described below.

### 3. Capable foundation, not an attempt to contain everything

The base image should be capable enough for an agent to bootstrap and verify further development tooling reliably, but DevBridge should not attempt to predict every language, SDK, database, cloud platform, embedded toolchain, or future development technology.

The foundation should strongly favor broadly reusable command-line capabilities, especially:

- shell, text, filesystem, archive, hashing, and structured-data utilities;
- Git/source-control support;
- TLS/HTTP/SSH/network diagnostics;
- package-management prerequisites;
- common compiler/build bootstrap capability;
- basic scripting/runtime capability needed by DevBridge and common tooling;
- strong CLI-based testing, debugging, profiling, static-analysis, and diagnostic foundations.

Testing and verification deserve unusually high priority because autonomous development is incomplete if the environment can produce artifacts but cannot independently investigate and verify them.

### 4. Default toward practical abundance when it removes real friction

A smaller persistent image is acceptable because agents can prepare it once, but minimalism is not itself a product goal.

DevBridge should pre-provision common capabilities when doing so materially improves reliability or usability, especially when a tool is:

- difficult to install unattended;
- dependent on awkward GUI-driven setup even though later operation is scriptable;
- very large or expensive to acquire repeatedly;
- fragile or highly platform-specific to configure;
- tightly coupled to drivers, kernels, hardware, or other profile-level state;
- difficult to qualify correctly after ad-hoc installation;
- repeatedly needed across unrelated projects.

The aim is **evidence-driven abundance**: close common and painful gaps in prepared images while leaving the long tail to ordinary guest tooling.

### 5. Prefer workspace-local mutable tooling where practical

Execution profiles own persistent VMs; repositories own isolated workspaces inside compatible profiles.

Therefore project-specific mutable state should normally remain repository-local when the ecosystem permits it, for example:

- `node_modules`;
- Python virtual environments;
- project-local SDK/tool directories;
- build trees;
- generated files;
- repository configuration;
- test fixtures and project-local services/state.

Profile-wide installations are still legitimate when the capability is genuinely shared or requires system-level integration. They should not accidentally convert one repository's mutable assumptions into hidden dependencies for every other repository using the profile.

See [`execution-profile-environments.md`](execution-profile-environments.md) for the authoritative ownership boundary.

## Indirect guest console

The indirect console should eventually provide two generic forms:

```text
console.exec      bounded non-interactive execution
console.session   interactive/PTY execution when genuinely required
```

`console.exec` should be the normal automation primitive because it is easier to bound, capture, terminate, and bind to evidence. `console.session` is the escape hatch for REPLs, debuggers, terminal UIs, interactive installers, and other software that genuinely requires a terminal session.

The console is a **guest execution capability**, not a general machine-authority capability.

### Console security boundary

The governing invariant is:

> Console authority means execution inside one exact untrusted guest. It must never be representable as arbitrary execution on the physical host.

The host must not construct a host shell command by interpolating model-, repository-, or guest-controlled strings. Requests should cross a structured guest protocol and be launched by guest-owned code.

A console session must be bound to an exact admitted environment and, where applicable, an exact workspace/task context. Console authority must not imply:

- host shell/executable authority;
- Hyper-V/libvirt/provider management;
- host filesystem access or arbitrary mounts;
- host GitHub credentials;
- host SSH/GPG/signing agents;
- publication/ref authority;
- DevBridge runtime-control state;
- cloud credentials or unrelated host secrets;
- another execution profile or workspace identity.

Guest administrator/root authority may be a legitimate locally admitted capability for environment preparation because the entire guest is already untrusted, but guest elevation must never cross into host authority.

Console implementation must also treat stdout/stderr and terminal traffic as hostile input: bound output, preserve byte-safe capture, prevent terminal-control output from becoming trusted control-plane messages, support cancellation/hard termination, and qualify adversarial cases such as background children, malformed/binary output, session disconnects, guest restarts, resource exhaustion, and attempts to reach host authority.

Remote task text can request work that needs guest execution, but local DevBridge policy remains the authority that admits the console capability.

## GUI software

GUI applications are **allowed** in DevBridge guests.

Agents may install, launch, configure, or attempt to use GUI software when it is useful. DevBridge does not prohibit GUI tools and should not add policy gates merely because a program has a graphical interface.

However, DevBridge does not currently promise a reliable general-purpose automation path for arbitrary GUI interaction. CLI, API, headless, configuration-file, accessibility-neutral programmatic interfaces, or other scriptable paths are preferable when available because they are easier for agents to operate and verify.

If a workflow is strongly GUI-dependent, it may be difficult to automate. This is primarily a documented product limitation, **not** a reason to block installation or launch of the application, and DevBridge is not currently planning a generic computer-use/GUI-driver subsystem around that limitation.

## Tooling support policy

Development requirements generally fall into three practical classes.

### Console-native

The normal expectation is that an agent can obtain/configure the capability through ordinary guest tools with acceptable reliability.

DevBridge should not add bespoke integration merely to avoid normal package-manager or project-bootstrap work.

### Prepared capability

The capability is common or painful enough that it should be present or substantially prepared in the base/profile image.

This is especially appropriate for difficult setup, large downloads, fragile platform integration, common testing foundations, or repeatedly observed setup friction.

### External/special capability

The requirement cannot honestly be created by software installation inside the guest. Examples include physical GPUs or debuggers, Apple-specific execution environments, external accounts, licenses, signing authority, or other hardware/platform/credential prerequisites.

These remain execution-profile/provider/operator concerns. Installing software in the guest must not be presented as equivalent to possessing the real external capability.

## Testing and verification emphasis

CLI-based testing and diagnostics are first-class development-environment concerns.

The environment should make it easy to run and investigate:

- unit/integration/system tests;
- native sanitizers and memory/race diagnostics where supported;
- headless browser/E2E testing where practical;
- HTTP/API/network tests;
- database migration/query/integration tests;
- static analysis, type checking, formatting, and schema validation;
- fuzzing/property testing where appropriate;
- profiling and repeatable command/performance benchmarks;
- packaging/artifact verification;
- failure/recovery tests and controlled fault injection where safely bounded.

DevBridge does not need to understand every test framework. The generic execution/evidence surfaces should make existing project and ecosystem test tooling usable.

For DevBridge-launched processes, authoritative execution facts such as start/end, exit status, task/environment identity, and bounded captured output remain distinguishable from claims emitted by guest software.

## Observation and environment-state reporting

DevBridge should not build a custom collector for every future technology.

Instead it should provide a simple **observation framework** in which a project, agent, or locally approved definition supplies its own procedure for gathering useful state.

Conceptually:

```text
observation definition
        |
        v
bounded guest execution
        |
        v
collector-produced files/output
        +
DevBridge-owned execution facts
        |
        v
bounded observation package
        |
        v
transport / external analysis
```

An observation definition should need only generic execution concerns such as:

- identity;
- entrypoint/arguments;
- working context;
- timeout and output/artifact limits;
- required guest privilege class;
- trigger, if any;
- output/artifact contract.

The collector itself owns domain knowledge. It may use ordinary guest commands to inspect process state, resources, Git state, logs, tests, databases, CUDA, containers, browsers, screenshots, packet traces, or technologies that do not exist yet. DevBridge packages the result without needing to understand those domains.

A bounded collector output area may contain structured or binary artifacts such as JSON, text logs, XML test reports, screenshots, browser traces, packet captures, coverage data, dumps, or other diagnostic evidence subject to policy and size limits.

DevBridge-owned facts and guest-produced claims must remain distinct. A collector writing `testExitCode: 0` is guest evidence; the actual collector/process exit status observed by DevBridge is control-plane evidence.

### External interpretation

Environment-state interpretation may be performed by external AI or humans rather than consuming development-VM CPU/GPU resources for local inference.

The guest should package evidence and return it through the existing trusted host boundary. The host may redact, bound, authenticate, and transport the observation through an approved channel such as GitHub. The guest does not receive host GitHub credentials merely to report state.

External analysis is advisory. Statements such as "the build appears stuck" or "CUDA is probably missing" do not replace authoritative execution evidence or grant machine authority. Any recommended action still passes through normal DevBridge admission and execution boundaries.

GitHub or another asynchronous transport is appropriate for snapshots, checkpoints, evidence, and higher-level analysis. It is not intended as a low-latency interactive terminal or GUI-control loop.

## Persistence versus reconstruction

A persistent profile can accumulate useful preparation over time. That state should not be treated as magically immortal.

DevBridge does not need to semantically model every package installed by an agent, but recovery should preserve enough bounded evidence and project-owned setup information to make lost state diagnosable and reconstructable where practical.

Useful principles include:

- favor project-owned setup/bootstrap manifests or scripts when an ecosystem naturally provides them;
- preserve exact base/profile generation identity;
- distinguish profile-wide mutation from repository-local state;
- retain bounded execution/setup evidence rather than pretending DevBridge understands every mutation;
- promote repeatedly needed tooling into later prepared image generations when evidence shows that doing so materially reduces friction.

**Persistence is convenience; reconstructability is durability.**

## What DevBridge should not become

This approach intentionally avoids several architectural traps.

DevBridge should not become:

- a universal replacement for language/OS/vendor package managers;
- a collection of one-off installation adapters for every tool;
- a product-specific diagnostic collector library for every database/build system/runtime;
- a GUI automation/computer-use platform merely to cover GUI-only software;
- a direct-host shell fallback when a guest route is unavailable;
- a system that confuses AI interpretation or guest claims with locally authoritative evidence.

## Decision heuristic

When a new development-environment gap appears, use this order:

1. **Can ordinary guest console/programmatic tooling solve it reliably?** Let the agent/project do so.
2. **Is the setup common, painful, fragile, huge, or difficult to qualify?** Consider promoting it into the prepared base/profile image.
3. **Is it project-specific mutable state?** Prefer repository-local ownership.
4. **Does it require real hardware/platform/credential authority?** Route or report the external prerequisite; do not fake parity.
5. **Is it primarily GUI-dependent?** Allow it, document the automation limitation, and prefer a programmatic alternative when available.
6. **Does diagnosis require domain-specific knowledge?** Let an observation definition/collector supply that knowledge rather than adding it to DevBridge core.

The resulting product principle is:

> **DevBridge provides a persistent, well-founded, adaptable guest workstation. Ordinary development work belongs inside that guest; DevBridge concentrates on isolation, authority, lifecycle, routing, evidence, recovery, and generic execution/observation transport.**
