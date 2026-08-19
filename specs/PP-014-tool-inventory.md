# PP-014 — Local Tool Inventory and Agent Capability Projection

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

Remote/controller content MUST NOT add an executable path, command, environment variable, network grant, sandbox grant, registered operation, or adapter merely by naming or describing it.

## 3. Presence-only PATH discovery

The default general discovery engine is informational and non-executing.

It:

- observes a bounded PATCH-POLLER-owned catalog of logical command names;
- reads each bounded PATH directory once per discovery generation;
- records whether a matching executable entry is present;
- does not invoke a discovered binary for `--version`, `--help`, man output, self-description, or any other probe;
- records absolute executable paths only in local transient discovery state and removes them from every remote projection;
- marks discovered entries as having no executable authority.

PATH observation is not a capability grant. A discovered `rg`, `pnpm`, `uv`, `docker`, `claude`, or unfamiliar future CLI cannot be executed by a controller plan unless a separate locally registered operation/adapter already authorizes that action.

Discovery MUST be bounded by catalog size and PATH-directory count. The implementation should index PATH directories concurrently so catalog growth does not produce one filesystem traversal per tool. Discovery latency is measured separately from GitHub reporting and expensive health probes; the target for ordinary local PATH observation is under 50 ms.

## 4. Tool inventory protocol

The normalized inventory protocol is:

`patch-poller/tool-inventory-v1`

A durable/projectable record uses:

`patch-poller/tool-inventory-record-v1`

A compact context reference uses:

`patch-poller/tool-inventory-ref-v1`

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
- execution class;
- whether repository code may execute;
- required enforcement class;
- whether that requirement is presently satisfied.

Security classification comes from PATCH-POLLER's control-owned operation-security registry, not controller text or repository output.

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

If a material capability/enforcement/availability fact changes, a new digest and generation are emitted.

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

## 8. Refresh behavior

Inventory is refreshed:

- when a runtime is created/startup occurs;
- once per normal runner cycle before task dispatch;
- by capability/doctor probing;
- naturally after runtime activation because the new runtime starts a new inventory generation;
- after a locally registered toolchain is explicitly refreshed/probed;
- after a requested capability failure when the owning registry invalidates stale availability.

Presence-only general PATH discovery is rerun each cycle so newly installed or removed catalog tools can be observed without executing them.

Inventory/projection failure is informational infrastructure failure and MUST NOT broaden authority or silently mark unavailable capabilities usable. GitHub projection is started independently of task execution so reporting latency does not become execution authority or unnecessarily serialize task dispatch.

## 9. Adaptive routing

A coordinating agent may use the inventory to choose among capabilities that PATCH-POLLER already exposes. For example, it may avoid proposing an operation whose registered toolchain is unavailable, or prefer an already registered capability that is both enabled and verified usable.

A helper that chooses among presence-only discovered names is a planning hint only. It MUST NOT execute that name or transform it into a registered operation.

Fallback behavior therefore means:

1. prefer a locally registered, currently usable capability;
2. if unavailable, choose another already registered capability when the plan schema supports it;
3. otherwise report the missing capability and continue through normal feedback/recovery semantics;
4. never fall back by constructing a raw shell/argv command from remote text.

## 10. Novel-tool documentation and wrapper synthesis

Issue #30 additionally requests automatic integration of unfamiliar CLIs from `--help`, man pages, or tool specifications.

That feature is constrained by the same authority rule:

- unfamiliar binary documentation is untrusted tool output/data;
- merely discovering the binary MUST NOT cause PATCH-POLLER to execute `--help` under supervisor authority;
- any future documentation probe that executes an unfamiliar binary must use a verified sandbox with no control credentials/state and bounded filesystem/network authority;
- any model-generated or mechanically synthesized wrapper is a proposal artifact, not a capability grant;
- a synthesized wrapper MUST NOT enter the executable ToolRegistry until a PATCH-POLLER-owned local registration/validation policy accepts a closed parameter schema, executable identity/resolution policy, environment policy, timeout/output bounds, and sandbox requirements;
- GitHub text cannot perform that registration.

The v1 inventory therefore reports unfamiliar tools as `informational-only`. A later version may define a safe wrapper-proposal/review pipeline, but it may not weaken this invariant.

## 11. Security and privacy invariants

Remote inventory MUST NOT contain:

- absolute executable/compiler/linker paths;
- operator-home or arbitrary machine paths;
- secret or credential values;
- credential locations;
- arbitrary environment values;
- raw command lines;
- raw discovery errors that may contain paths;
- an enforcement claim derived only from profile configuration.

Repository/tool output cannot expand inventory authority. Unknown operation names remain subject to the existing fail-closed repository-code classification rather than becoming safe because they appear in discovered tools.

## 12. Required tests

At minimum tests cover:

1. PATH discovery finds present and absent catalog entries while reading each PATH directory once.
2. General discovery performs no version/help subprocess execution and marks entries as non-authoritative.
3. Unfamiliar present tools do not expand the locally registered operation set.
4. Repository-code operation usability changes only with verified enforcement state.
5. Model adapter disabled state remains distinct from executable presence.
6. Declared profile policy remains distinct from observed enforcement.
7. Absolute executable/linker paths and raw path-bearing errors are absent from serialized inventory.
8. Stable input produces a stable digest/generation.
9. Material enforcement/availability change changes digest/generation.
10. GitHub projection creates one control-owned comment, updates that exact ID, and suppresses no-change writes.
11. Marker-looking comments are never adopted as authority.
12. Secret-bearing digest payloads are refused rather than silently redacted and published.
13. Ordinary status context carries only the compact inventory digest/generation reference.
14. Toolchain refresh invalidates stale cached availability before re-probing.
15. Discovery/projection failure never broadens execution authority.
