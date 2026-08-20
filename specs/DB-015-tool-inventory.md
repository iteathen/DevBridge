# DB-015 — Local Tool Inventory and Agent Capability Projection

Status: active

Read with DB-003, DB-004, DB-005, DB-010, DB-012, DB-013, DB-019, and DB-020.

Implementation status: current main inventories host-local registered tools and uses the transitional verified Linux/Bubblewrap sandbox for repository-class dynamic operations. DB-020 is normative for the target execution model: repository tools live/discover/execute inside persistent untrusted repository VMs, while host inventory is reserved for control-plane prerequisites and host-owned adapters.

## 1. Goal

Give a coordinating agent an accurate, bounded view of tools and execution capabilities available for the intended repository environment without turning discovery, guest state, repository content, tool output, or GitHub text into machine authority.

> **Inventory reports local/environment authority. Inventory never creates authority.**

A binary being present is not equivalent to a registered deterministic operation, an enabled adapter, a trusted host operation, or a verified usable repository environment.

## 2. Authority model

DevBridge-owned local configuration and built-in registries remain authoritative for:

- registered deterministic operation names and parameter schemas;
- host-vs-repository execution classification;
- enabled/disabled compatibility/model adapters;
- VM provider/image/environment requirements;
- host control-plane executable/toolchain resolution;
- environment and credential grants;
- whether a discovered tool may actually execute;
- local operation-manifest roots and auto-onboarding allowlists.

GitHub task text, repository files, guest files, guest PATH, process stdout/stderr, `--help` output, man pages, discovered binary names, and guest Git are data/proposals only.

Remote/controller/guest content must not add a host executable path, command, host environment value, credential, VM/image path, host mount, registered operation, manifest directory, or auto-onboarding allowlist entry merely by naming or describing it.

## 3. Host and guest inventory domains

### Host control-plane inventory

Host inventory is appropriate for trusted prerequisites such as:

- DevBridge runtime/Node;
- authoritative Git tooling;
- Hyper-V/provider management capability;
- VM image/bridge/bootstrap support tools;
- release/signing/verification adapters;
- other fixed control-plane dependencies.

Presence on host PATH is informational until a local adapter grants use. Repository work should not receive host PATH exposure merely because a tool is installed on the workstation.

### Repository guest inventory

Repository-development tools belong to the persistent guest environment under DB-020, including compilers, CMake/CTest, package managers, SDKs, browsers, language toolchains, coding CLIs, and local/generated `tool.*` targets.

Guest observations are bound to the exact repository environment/generation and guest OS/profile. A tool present in one repository/OS environment is not automatically available in another.

Guest administrator/root can tamper with every observed tool. Presence/version/help output therefore informs planning and test selection; it never converts guest bytes into trusted host authority.

## 4. Presence-only discovery

The general discovery engine should be informational and non-authoritative.

For host control-plane catalog entries it may observe bounded PATH directories without executing unfamiliar binaries.

For repository tool planning, Stage 5/6 should provide an equivalent bounded guest inventory through the host-controlled bridge. It should report logical tool presence and sanitized metadata without exposing host paths or granting arbitrary execution.

Discovery should be bounded by catalog size, environment count, output size, and time. Repeated catalog growth should not cause one expensive guest boot/process per tool when a single indexed observation can provide the same evidence.

A discovered `rg`, `pnpm`, `uv`, `docker`, `claude`, or future CLI cannot be invoked by a controller plan until a separate locally registered operation/adapter or locally authorized onboarding rule permits it.

## 5. Inventory protocols

The normalized inventory protocol remains:

`devbridge/tool-inventory-v1`

A durable/projectable record uses:

`devbridge/tool-inventory-record-v1`

A compact context reference uses:

`devbridge/tool-inventory-ref-v1`

A dynamic operation may expose a controller-facing schema using:

`devbridge/operation-parameters-v1`

The normalized inventory contains bounded information from these domains.

### Runtime/control plane

- DevBridge family/version;
- exact runtime commit identity when trustworthy;
- Node family/version;
- coarse host platform/architecture.

### Repository execution environment

For VM-backed repository execution, observed readiness should include sanitized identities/status such as:

- requested execution provider/class;
- actual provider (initially Hyper-V after implementation);
- verified/available state;
- guest OS/profile;
- base-image identity/version/generation;
- repository environment identity/generation;
- persistent disk/lifecycle readiness classification;
- bridge readiness classification;
- whether repository-controlled execution is actually permitted.

Configured values are not verified enforcement. Presence of Hyper-V, a base-image path, or a VM name alone must not be projected as ready.

During migration the current Bubblewrap observed-enforcement fields may remain for the live implementation, but remote consumers must not infer that Bubblewrap is the target architecture after DB-020.

### Deterministic operations

For each registered operation project:

- logical name;
- implementation layer;
- execution class (trusted/static host or repository-controlled guest);
- whether repository code may execute;
- required environment/provider class;
- whether that requirement is presently satisfied;
- guest OS/profile requirements where relevant.

For dynamic local-manifest operations, the projection may expose only the validated public parameter schema: name, kind (`flag`, `option`, `positional`), public value type, required/repeat bounds, safe enums, and required-parameter state.

It must not expose host executable identity, fixed literal argv, option flags, shell text, environment values, local host paths, VM-management details, credential locations, or other authority-bearing construction.

### Toolchains

For each locally registered host or guest toolchain expose only bounded planning metadata such as logical family, environment scope, available/unavailable, sanitized version, coarse discovery source, and health classification.

Absolute host executable/compiler/linker paths and raw path-bearing resolver errors must not be projected.

### Compatibility/model adapters

For each configured adapter expose bounded fields such as profile name, adapter class, enabled/disabled, environment scope, executable/tool presence, usable/unusable, selection eligibility, input protocol, and observed execution-environment readiness.

Credentials, credential locations, raw command lines, host paths, complete environments, and secret-bearing errors must not be projected.

### General discovered tools

Presence-only entries contain planning metadata such as logical name, category, environment identity reference, present/absent, observation class, coarse source, probe state, and explicit non-authority state.

## 6. Normalization, digest, and generation

Normalized inventory uses deterministic code-point ordering and canonical fields before SHA-256 calculation. Locale-dependent sorting is not allowed at a digest boundary.

Dynamic presentation fields such as timestamps and measured duration are outside the normalized digest.

If normalized inventory is unchanged, digest remains identical, generation does not advance, and GitHub projection does not write again.

A material capability/schema/provider/image/environment/tool availability change produces a new digest/generation.

Repository-environment identity is part of the subject: a tool observation from an old/reseeded environment generation cannot be silently reused for the replacement environment.

## 7. GitHub projection

The coordinating agent receives a machine-readable DevBridge-owned issue comment using:

`devbridge/tool-inventory-projection-v1`

The projection is bounded, secret-safe, rate-budgeted, and updates/coalesces only the exact comment ID retained in DevBridge control state.

A marker-looking GitHub comment is not ownership proof. DevBridge never searches for and adopts arbitrary marker-looking comments after losing state.

If safe redaction would make a digest-bearing payload diverge, refuse publication rather than silently publishing a different subject.

Ordinary status should carry only the compact inventory digest/generation reference.

## 8. Refresh and routing

Inventory refreshes when relevant local/environment state can change, including:

- runtime startup/activation;
- normal task planning/admission cycles;
- VM provider/image/environment lifecycle change;
- environment reset/reseed;
- bridge readiness change;
- explicit toolchain refresh/probe;
- successful dynamic operation registration;
- requested-capability failure that invalidates stale availability.

Guest inventory collection must not become an accidental boot/probe storm. Persisted exact environment/tool observations may be reused while their identity/freshness contract remains valid.

A coordinating agent may choose among capabilities DevBridge already exposes. Presence-only names remain planning hints.

Fallback behavior remains:

1. prefer a locally registered, currently usable operation/environment;
2. choose another already registered capability when the plan schema permits it;
3. otherwise report the missing capability and continue normal feedback/recovery semantics;
4. never fall back by constructing raw shell/argv or mounting a host tool from remote text.

## 9. Operator-authored local operation manifests

`devbridge/local-operation-manifest-v1` remains the local extension point.

The manifest directory is explicit host operator authority and is never inside repository/guest authority.

Manifest loading must:

- require a canonical real local directory and regular non-symlink JSON files;
- bound count/size;
- reject duplicate registrations;
- require dynamic names under `tool.*`;
- validate local operation policy before registration;
- use a closed bounded argument descriptor language;
- reject authority-shaped controller parameters such as executable, command, shell, argv, environment, credential, host path, Git ref/SHA, cleanup root, VM/image/provider target, plugin/module, or fault controls;
- bound strings/integers/enums/repeat values;
- validate project-relative values against the repository candidate/source contract;
- prohibit generic values that smuggle option syntax, absolute host paths, or traversal.

The manifest may contain fixed local adapter structure. That local authority is not projected publicly.

Repository-class manifests ultimately execute in the guest environment through DB-020, not by granting the guest a host executable path.

## 10. Automatic unfamiliar-tool onboarding

Automatic onboarding is disabled by default.

Enabling it requires local configuration to provide an exact allowlist/delegation and bounded probe policy. Repository/GitHub/guest content cannot add itself to the allowlist.

Target VM flow:

1. resolve the exact repository environment and local onboarding delegation;
2. confirm observed VM/provider/image/environment/bridge readiness;
3. locate the delegated command inside that guest environment using a bounded guest adapter;
4. execute only the locally configured fixed help arguments inside the untrusted guest;
5. give the guest no host control credentials, arbitrary host mounts, VM-management authority, or host path inputs;
6. allow normal guest networking under DB-020 unless a stricter local workload rule is explicitly configured;
7. bound timeout/output and operation identity;
8. treat stdout/stderr documentation as untrusted data;
9. parse only a conservative subset of options/positionals/simple types/subcommand enums;
10. discard authority-shaped parameters;
11. validate the synthesized manifest with the same control-owned validator;
12. persist the exact generated manifest before registration;
13. reconcile it against exact local delegation and environment identity on restart/reseed;
14. register only after those gates pass.

A blocked, unavailable, timed-out, truncated, undocumented, or unparseable probe creates no capability.

A generated wrapper remains repository-controlled execution. It does not become trusted host code merely because DevBridge synthesized its schema.

## 11. Security/privacy invariants

Remote inventory must not contain:

- absolute host executable/compiler/linker paths;
- operator-home or arbitrary machine paths;
- secret/credential values or locations;
- arbitrary environment values;
- raw host command lines or authority-bearing fixed argv;
- host VM-management endpoints/credentials or sensitive image paths;
- raw local/guest errors that may expose secrets/paths unnecessarily;
- an enforcement claim derived only from configuration.

Repository/guest/tool output cannot expand authority. Unknown operations remain fail-closed repository-controlled execution.

Local onboarding policy and manifest roots remain host-only and are not writable through controller-plan or bridge/project paths.

## 12. Required tests

Tests/qualification must cover at least:

1. host presence-only discovery does not execute unfamiliar binaries or grant authority;
2. guest inventory binds observations to exact repository environment/guest OS generation;
3. a present guest tool does not expand the operation registry;
4. repository-code operation usability changes only with verified VM/provider/image/environment/bridge state after cutover;
5. model adapter enabled state remains distinct from binary presence;
6. requested configuration remains distinct from observed execution readiness;
7. host paths/secrets/raw path-bearing errors are absent from serialized inventory;
8. stable normalized input produces stable digest/generation; material environment/tool/schema change changes it;
9. GitHub projection creates/updates only its control-owned comment and suppresses no-change writes;
10. marker-looking comments are never adopted as authority;
11. secret-bearing digest payloads are refused rather than silently altered;
12. status carries only compact inventory reference;
13. environment reset/reseed invalidates stale guest tool observations;
14. local manifests reject duplicate, symlink/indirection, authority-shaped, raw-argv, absolute/traversal and invalid enum/required-parameter inputs;
15. repository-class manifest operations execute in the guest and cannot gain host paths/credentials/VM-management authority;
16. auto onboarding does not run for unavailable/non-allowlisted tools;
17. help probes execute inside the exact guest environment with bounded input/output and no host authority;
18. failed/unsafe probes do not register or persist a capability;
19. synthesized manifests persist before registration and reconcile against exact environment/delegation identity;
20. help parsing filters authority-shaped parameters;
21. dynamic operation inventory exposes useful public schema while omitting authority-bearing construction;
22. discovery/onboarding/projection failure never broadens authority or unnecessarily blocks current task dispatch;
23. current transitional Bubblewrap status remains honestly reported until Stage 9 removes it.
