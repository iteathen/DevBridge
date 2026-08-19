# PP-015 — Local Tool Inventory and Agent Capability Projection

Status: active

Read with PP-003, PP-004, PP-005, PP-010, PP-012, and PP-013.

## 1. Goal

PATCH-POLLER must give a coordinating agent an accurate, bounded view of the tools and execution capabilities available on the runner without turning discovery, repository content, tool output, or GitHub text into machine authority.

The governing distinction is:

> **Inventory reports local authority. Inventory never creates local authority.**

A binary being present in PATH is not equivalent to a registered deterministic operation, an enabled adapter, or a verified-safe execution path.

## 2. Authority model

PATCH-POLLER-owned local configuration and built-in registries remain authoritative for:

- registered deterministic operation names and parameter schemas;
- executable/toolchain resolution used by those operations;
- enabled/disabled compatibility/model adapters;
- filesystem/network/process enforcement requirements;
- verified sandbox provider state;
- environment and credential grants;
- whether any discovered tool may actually execute.

GitHub task text, issue comments, repository files, process stdout/stderr, `--help` output, man pages, and discovered binary names are data/proposals only.

Remote/controller content MUST NOT add an executable path, command, environment variable, network grant, sandbox grant, registered operation, adapter, manifest directory, or auto-onboarding allowlist entry merely by naming or describing it.

## 3. Presence-only PATH discovery

The default general discovery engine is informational and non-executing.

It:

- observes a bounded PATCH-POLLER-owned catalog of logical command names;
- reads each bounded PATH directory once per discovery generation;
- records whether a matching executable entry is present;
- does not invoke a discovered binary for `--version`, `--help`, man output, self-description, or any other probe;
- records absolute executable paths only in local transient discovery state and removes them from every remote projection;
- marks discovered entries as having no executable authority.

PATH observation is not a capability grant. A discovered `rg`, `pnpm`, `uv`, `docker`, `claude`, or unfamiliar future CLI cannot be executed by a controller plan unless a separate locally registered operation/adapter already authorizes that action or local auto-onboarding policy explicitly delegates that exact command under section 10.

Discovery MUST be bounded by catalog size and PATH-directory count. The implementation should index PATH directories concurrently so catalog growth does not produce one filesystem traversal per tool. Discovery latency is measured separately from GitHub reporting and expensive health probes; the target for ordinary local PATH observation is under 50 ms.

## 4. Tool inventory protocol

The normalized inventory protocol is:

`patch-poller/tool-inventory-v1`

A durable/projectable record uses:

`patch-poller/tool-inventory-record-v1`

A compact context reference uses:

`patch-poller/tool-inventory-ref-v1`

A dynamic operation may additionally publish a controller-facing parameter schema using:

`patch-poller/operation-parameters-v1`

The normalized inventory contains at least:

### Runtime

- PATCH-POLLER family/version;
- exact runtime commit identity when locally known and trustworthy;
- Node family/version;
- coarse platform and architecture.

### Verified enforcement

Observed provider state is separate from requested/declared policy and includes only bounded sanitized fields such as:

- requested provider;
- actual provider;
- available/verified state;
- verification classification;
- filesystem/network/Git-administrative/process-tree enforcement summaries;
- whether repository-code execution is actually permitted.

A configuration claim MUST NOT be reported as verified enforcement.

### Deterministic operations

For each locally registered deterministic operation:

- logical operation name;
- implementation layer;
- execution class;
- whether repository code may execute;
- required enforcement class;
- whether that requirement is presently satisfied.

For dynamically registered local-manifest operations, the projection MAY also expose the validated controller parameter schema:

- parameter name;
- parameter kind (`flag`, `option`, or `positional`);
- public value type (`boolean`, `string`, `project-path`, `integer`, or bounded `enum`);
- required/repeat state and repeat bound;
- safe enum values;
- whether at least one parameter is required.

The public parameter schema MUST NOT expose executable identity, fixed literal argv, option flags, shell text, environment values, local paths, timeout implementation details, help-probe argv, or any other authority-bearing argv construction. If schema metadata cannot be projected safely without path/secret disclosure, PATCH-POLLER omits the schema rather than publishing a partially unsafe representation.

Security classification comes from PATCH-POLLER's control-owned operation-security registry, not controller text or repository/tool output. Unknown/dynamic `tool.*` operations remain repository-code execution and require verified OS sandbox enforcement.

### Toolchains

For each locally registered toolchain:

- logical name/family;
- available/unavailable;
- bounded sanitized version when safe;
- coarse discovery source class;
- health classification.

Absolute compiler/linker/executable paths and raw resolver errors MUST NOT be projected.

### Compatibility/model adapters

For each locally configured or built-in adapter:

- profile name;
- adapter class;
- enabled/disabled;
- executable available/unavailable;
- usable/unusable;
- eligibility for automatic selection;
- input protocol;
- declared profile sandbox policy;
- observed outer enforcement status.

Credentials, environment values, credential locations, command-line details, user-home paths, and executable paths MUST NOT be projected.

### General discovered tools

Presence-only discovery entries contain only bounded planning metadata such as:

- logical name;
- category;
- present/absent;
- observation/health class;
- coarse source (`PATH`);
- probe state (`not-executed`);
- explicit `executableAuthority: false` / informational-only state.

## 5. Normalization, digest, and generation

The normalized inventory uses deterministic code-point ordering and canonical field ordering before SHA-256 calculation. Locale-dependent sorting is not permitted in a digest boundary.

Dynamic presentation fields such as generation timestamp and measured discovery duration are outside the normalized digest.

If the normalized inventory is unchanged:

- its digest remains identical;
- generation does not advance;
- GitHub projection does not write again.

If a material capability, parameter-schema, enforcement, or availability fact changes, a new digest and generation are emitted.

## 6. GitHub projection

The coordinating agent receives a machine-readable projection through a PATCH-POLLER-owned issue comment using:

`patch-poller/tool-inventory-projection-v1`

The projection:

- contains the normalized inventory plus digest/generation;
- is bounded by the existing GitHub comment budget;
- passes through secret detection/redaction safeguards;
- refuses publication if redaction would make the digest-bearing payload diverge;
- updates/coalesces the exact comment ID retained in PATCH-POLLER control state;
- suppresses writes when the normalized digest is unchanged;
- uses the shared GitHub rate/mutation budget.

### Projection ownership

A marker-looking GitHub comment is not proof that PATCH-POLLER owns it.

On first publication PATCH-POLLER creates a new comment and durably records the returned comment ID. Later updates target only that control-state-owned ID. If it is deleted, PATCH-POLLER may create a replacement and update control state.

PATCH-POLLER MUST NOT search for and adopt arbitrary marker-looking comments after losing state. A malicious/repository-authored comment therefore cannot forge the runner's authoritative capability projection by copying its heading, marker, or JSON shape.

## 7. Status/context reference

Ordinary PATCH-POLLER status context SHOULD include only the compact inventory reference (protocol, digest, generation), not duplicate the full inventory in every status update.

This lets the coordinating agent bind a task/status context to the current capabilities comment while controlling GitHub and context-window cost.

## 8. Refresh and routing behavior

Inventory is refreshed:

- when a runtime is created/startup occurs;
- once per normal runner cycle before task dispatch;
- by capability/doctor probing;
- naturally after runtime activation because the new runtime starts a new inventory generation;
- after a locally registered toolchain is explicitly refreshed/probed;
- after successful dynamic operation registration;
- after a requested capability failure when the owning registry invalidates stale availability.

Presence-only general PATH discovery is rerun each cycle so newly installed or removed catalog tools can be observed without executing them.

Inventory/projection failure is informational infrastructure failure and MUST NOT broaden authority or silently mark unavailable capabilities usable. GitHub projection is started independently of task execution so reporting latency does not become execution authority or unnecessarily serialize task dispatch.

Automatic unfamiliar-tool help probing is not allowed to become task-dispatch latency. The normal cycle dispatches work using the exact inventory already projected/referenced for that work, then reconciles locally pre-authorized dynamic onboarding. A newly registered capability is reflected by a new inventory digest and is eligible for subsequent planning/work, not retroactively inserted into the task that triggered its discovery.

A coordinating agent may use the inventory to choose among capabilities PATCH-POLLER already exposes. It may avoid an unavailable toolchain or prefer an operation whose enforcement requirements are currently satisfied. Presence-only discovered names are planning hints only.

Fallback behavior is:

1. prefer a locally registered, currently usable capability;
2. if unavailable, choose another already registered capability when the plan schema supports it;
3. otherwise report the missing capability and continue through normal feedback/recovery semantics;
4. never fall back by constructing raw shell/argv commands from remote text.

## 9. Operator-authored local operation manifests

PATCH-POLLER supports a local extension point using:

`patch-poller/local-operation-manifest-v1`

The manifest directory is an explicit local operator configuration value. It is not under repository/controller authority.

Manifest loading MUST:

- require a canonical real directory and regular non-symlink JSON files;
- bound manifest file count and byte size;
- reject duplicate operation registration;
- require dynamic operation names under `tool.*`;
- validate executable identity/resolution policy locally;
- use a closed bounded argument descriptor language rather than raw remote argv;
- reject controller parameter names that resemble control-plane authority fields such as executable, command, shell, argv, environment, credentials, local path, Git ref/SHA, cleanup root, plugin/module, or fault-injection controls;
- bound string/integer/enum/repeat values and validate project-relative paths through the ordinary controller-plan path policy;
- prohibit generic parameter values from beginning with `-`, using absolute path forms, or containing traversal segments;
- execute through `shell:false`, a minimal environment, mandatory timeout/output bounds, denied network, no configured external read roots, and the verified repository-code sandbox requirement.

The manifest may contain local fixed argv/literal structure. That structure is local authority and is not projected in the public parameter schema.

## 10. Sandboxed automatic unfamiliar-tool onboarding

Automatic onboarding is **disabled by default**.

Enabling it requires local configuration to provide:

- a canonical local manifest directory;
- an exact allowlist of command names;
- an optional exact logical `tool.*` operation name per command;
- fixed bounded help-probe option arguments (default `--help`);
- bounded probe timeout and output size.

Merely finding a binary in PATH does not execute it. Repository/GitHub/controller content cannot add the command to the allowlist.

For each locally delegated command that has no already registered/generated manifest:

1. resolve the exact locally configured command through the local executable resolver;
2. create a disposable probe workspace under the managed workspace root;
3. execute only the locally configured fixed help arguments;
4. classify the help probe as repository-code execution;
5. require the verified OS sandbox provider;
6. deny network, hide configured external read roots, expose only minimal environment/system requirements, and provide no GitHub/control-plane credentials or control state;
7. bound timeout/output and clean the disposable probe root in success/failure paths;
8. treat stdout/stderr documentation as untrusted data;
9. parse only a conservative subset of long options, bounded positionals, simple types, and bounded subcommand enums;
10. discard authority-shaped parameter names rather than mapping them into controller parameters;
11. validate the synthesized manifest with the same local-manifest validator used for operator manifests;
12. persist the exact generated manifest with exclusive-create semantics **before** registering it;
13. on restart, reconcile the persisted manifest against the exact local command/operation policy before reuse;
14. register the generated operation only after those gates pass.

A blocked, unavailable, timed-out, truncated, undocumented, or unparseable probe does not create a capability. Probe failure telemetry exposes bounded classifications, not raw local exception messages that may contain machine paths.

A generated wrapper is still repository-code execution. It does not become trusted merely because the wrapper was synthesized by PATCH-POLLER. Actual operation execution therefore continues to require the verified OS sandbox, denied network, hidden configured external roots, minimal environment, and bounded execution.

The help digest is retained as local provenance for the generated manifest. Help output is not itself authority and cannot choose executable identity, shell behavior, environment, credentials, network, external read roots, cleanup scope, Git authority, or arbitrary argv.

## 11. Security and privacy invariants

Remote inventory MUST NOT contain:

- absolute executable/compiler/linker paths;
- operator-home or arbitrary machine paths;
- secret or credential values;
- credential locations;
- arbitrary environment values;
- raw command lines or option flags for dynamic operations;
- fixed local argv literals;
- raw discovery/probe errors that may contain paths;
- an enforcement claim derived only from profile configuration.

Repository/tool output cannot expand inventory authority. Unknown operation names remain subject to the existing fail-closed repository-code classification rather than becoming safe because they appear in discovered tools.

Local onboarding policy and the local manifest directory are operator authority and MUST NOT be writable through controller-plan/repository paths.

## 12. Required tests

At minimum tests cover:

1. PATH discovery finds present and absent catalog entries while reading each PATH directory once.
2. General discovery performs no version/help subprocess execution and marks entries as non-authoritative.
3. Unfamiliar present tools do not expand the locally registered operation set.
4. Repository-code operation usability changes only with verified enforcement state.
5. Model adapter disabled state remains distinct from executable presence.
6. Declared profile policy remains distinct from observed enforcement.
7. Absolute executable/linker paths and raw path-bearing errors are absent from serialized inventory.
8. Stable input produces a stable digest/generation; material capability/schema change changes it.
9. GitHub projection creates one control-owned comment, updates that exact ID, and suppresses no-change writes.
10. Marker-looking comments are never adopted as authority.
11. Secret-bearing digest payloads are refused rather than silently redacted and published.
12. Ordinary status context carries only the compact inventory digest/generation reference.
13. Toolchain refresh invalidates stale cached availability before re-probing.
14. Operator local manifests reject duplicate registrations, symlink/indirection paths, authority-shaped parameters, raw argv smuggling, absolute/traversal parameter values, invalid enums, and missing required parameters.
15. Local-manifest operation execution emits only the validated structural argv and forces repository-code sandbox execution with network denied and configured external reads hidden.
16. Automatic onboarding does not run for an unavailable/non-allowlisted tool and never turns presence-only discovery into execution authority.
17. Automatic help probes request the verified repository-code sandbox with minimal environment/no GitHub credentials, denied network, and hidden configured external roots.
18. Blocked/timeout/truncated/no-safe-interface probes do not register or persist a capability.
19. Synthesized manifests are persisted before registration and are reused/reconciled without re-probing after restart.
20. Help parsing filters authority-shaped parameters and maps command/subcommand choices to a bounded non-authority `subcommand` enum.
21. Dynamic operation inventory exposes the controller parameter schema needed for use while omitting executable, fixed literals, option flags, help argv, and path-shaped unsafe enum metadata.
22. Dynamic operations remain unusable when verified repository-code enforcement is unavailable.
23. Discovery/onboarding/projection failure never broadens execution authority or blocks current task dispatch merely to complete an unfamiliar-tool probe.
