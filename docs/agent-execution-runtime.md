# Agent execution runtime

## Status and purpose

This document defines the accepted target design for DevBridge's agent-facing repository execution runtime. It extends the VM-only security boundary in DB-020; it does not weaken or replace it.

The goal is to make repository execution natural and token-efficient for coding agents while keeping the transported and executed representation structured, deterministic, inspectable, recoverable, and provider-independent.

The central design rule is:

> **Optimize the agent-facing surface for strong coding-model priors, but normalize execution into explicit process/data topology before it crosses an execution boundary.**

The runtime should feel familiar to an agent trained heavily on POSIX/Bash-style development workflows without making Bash, another interactive shell, or a raw command string the underlying authority model.

## Placement and trust boundary

The rich execution runtime belongs **inside the untrusted repository execution-profile VM**, not in the trusted host control plane.

The trusted host keeps its existing narrow deterministic process behavior for control-plane/provider work. Host-side Git authority, GitHub credentials, leases/fencing, VM management, verification authority, publication state, daemon/runtime state, and other machine authority remain outside the guest.

Conceptually:

```text
remote coding agent
        |
        | agent-friendly execution/query surface
        v
trusted DevBridge host control plane
        |
        | policy, routing, admission, normalized guest action
        v
repository-execution boundary
        |
        v
Hyper-V / libvirt bridge adapter
        |
        | transport only
        v
persistent untrusted profile VM
        |
        v
repository workspace
        |
        v
agent execution runtime
  - process graph engine
  - direct process execution
  - POSIX-like process plumbing
  - Nushell adapter
  - named buffers
  - named caches
  - execution history
  - read-only SQL query surface
  - SQLite metadata/index store
  - content-addressed payload store
  - structured causal errors
        |
        v
guest OS processes
```

The bridge and VM-provider adapters do not own shell semantics, process parsing, SQL, cache validity, buffer indexing, or tool ergonomics. They carry bounded versioned packets to the selected guest/workspace and return bounded results/references.

A compromised guest can forge its local history, cache metadata, SQL rows, buffer descriptions, and tool results. None of those become host verification/publication authority merely because the runtime records them precisely.

## Shell-like runtime, not an interactive shell

The execution runtime should provide most of the useful machine-facing semantics traditionally associated with a shell while omitting human-terminal machinery that an unattended agent does not need.

The core owns:

- executable + argv process creation;
- explicit cwd and environment;
- process lifecycle, signals, cancellation, timeout, and resource observations where available;
- stdin/stdout/stderr routing;
- pipelines and file-descriptor topology;
- redirects, append/truncate semantics, null sources/sinks, tee/fan-out where supported;
- per-stage exit/signal results;
- named durable buffers;
- named cache references and validity/provenance;
- durable execution history;
- structured errors and causal relationships;
- content-addressed artifacts/payloads;
- bounded result views and later retrieval.

The runtime does **not** need readline, prompts, aliases for human convenience, job-control UI, terminal completion, interactive startup files, or an always-present PTY.

PTY execution remains an explicit exceptional adapter for tools that genuinely require terminal behavior.

## Agent-facing execution surface

### First-guess compatibility

Coding agents have extremely strong priors for POSIX/Bash-shaped development commands. DevBridge should exploit that training rather than require a bespoke command DSL for ordinary work.

The common path should allow natural expressions such as:

```text
git status
npm test
cmake --build build
git diff | grep TODO
git log --oneline | grep fix > fixes.txt
```

The agent surface is intentionally compact and familiar. Internally, DevBridge lowers supported expressions into a canonical execution graph rather than passing the text to Bash for interpretation.

This is both an ergonomics rule and a token-efficiency rule: a successful first guess avoids discovery commands, quoting corrections, tool retries, explanatory schema tokens, and repeated model turns.

### Direct execution remains the primitive

A simple command should lower directly to a process node with explicit argv rather than through a shell:

```text
requested: git status --short

normalized:
  process:
    tool: git
    argv: [status, --short]
```

The model-facing syntax can remain terse even though the runtime representation is structural.

### Native POSIX-style process plumbing

The execution engine should natively represent the process/data topology behind high-frequency POSIX-style operators rather than requiring a shell process solely to connect file descriptors.

The target native surface includes, where semantics are explicitly implemented and tested:

- `|` pipelines;
- `<` input redirection;
- `>` truncate output redirection;
- `>>` append output redirection;
- stderr redirection such as `2>`;
- descriptor duplication such as `2>&1`;
- sequential/conditional process dependencies such as `;`, `&&`, and `||` when implemented with explicit exit-status semantics;
- common path/glob conveniences only where DevBridge can define their semantics predictably without pretending to implement the entire Bash language.

For example:

```text
producer | transform 2> errors >> results
```

should become a process/I/O graph, not `bash -c`.

The graph retains every stage, edge, sink, stream identity, and result. Shell-like syntax is a compact frontend, not the storage or transport representation.

### Nushell is the preferred full shell

DevBridge still needs a normal full shell facility. That role is specific and deliberate rather than being the universal process-launch mechanism.

**Nushell is the preferred DevBridge shell for agent-authored shell composition.** It is used when the task genuinely needs shell-language behavior such as richer pipelines, structured data transformation, variables, loops, conditionals, or reusable shell scripting.

Bash/sh, PowerShell, cmd, Python, Node, and other runtimes remain compatibility execution targets when an existing artifact declares or requires them. For example, an existing `.sh` file may still execute under its declared Bash/sh runtime. This does not make Bash the DevBridge orchestration shell.

The runtime core must not depend on Nushell AST internals. Nushell is an adapter above the same process/result/storage primitives so it can be replaced or upgraded without rewriting the execution kernel.

## Canonical execution representation

The runtime should have a provider-neutral execution IR/domain model with no dependency on Hyper-V, libvirt, GitHub, SQLite, Nushell, Node child-process APIs, or the DevBridge controller.

Core concepts should include equivalents of:

- `ExecutionGraph`;
- `ProcessNode`;
- `PipeEdge`;
- `InputSource`;
- `OutputSink`;
- `BufferRef`;
- `ArtifactRef`;
- `CacheRef`;
- `ProcessResult`;
- `ExecutionResult`;
- `ExecutionError` / causal relation.

Frontends compile into this model. The guest executor consumes it. The transport serializer carries a bounded/versioned representation of it.

Do not make the bridge transport parse Bash/Nu text in order to understand basic process topology.

## Instruction/action packages

Remote transport should carry **execution intent**, not an interactive terminal session.

A package should be:

- versioned;
- immutable once admitted;
- bounded;
- capability-scoped by existing DevBridge policy;
- explicit about workspace identity, limits, inputs, process topology, and expected outputs;
- content-addressed for large/reusable payload references where practical;
- idempotent/reconcilable where an interrupted transport could otherwise create duplicate effects.

Large source blobs, stdin payloads, previous outputs, caches, and artifacts should be referenced by stable identity/digest rather than repeatedly embedded when the endpoint already has them.

The action package may request work and name guest-local runtime facilities that policy permits. It does not receive arbitrary host paths, host executable authority, credentials, provider-management objects, or writable access to authoritative DevBridge state.

## Stdio semantics

Treat stdin, stdout, and stderr as distinct contracts.

### stdin

Unattended execution defaults to closed stdin/EOF. A program expecting interactive input should fail rather than silently block forever. Explicit bounded stdin and explicit PTY interaction are separate capabilities.

Hard/suite-appropriate timeout and cancellation remain required even with closed stdin.

### stdout

Stdout is normally the primary process payload. The runtime captures it durably when configured while returning only a bounded model-facing view by default.

### stderr

Stderr is a secondary stream, **not an automatic failure signal**. Many valid tools emit progress, warnings, diagnostics, or ordinary status text to stderr.

Exit/signal/timeout/cancellation state is authoritative for process completion semantics. Stderr remains independently inspectable and can be used as evidence when diagnosing a failure.

## Named durable buffers

Long output should not be forced into model context and should not simply disappear when a byte cap is reached.

A named buffer is a first-class runtime object with identity and metadata such as:

- name/id;
- producing execution/process/stream;
- byte count;
- line count where meaningful;
- content type/encoding where detected;
- live/finalized state;
- content digest after finalization;
- storage reference;
- retention/pinning policy;
- indexes/search metadata.

Live buffers may be append-only and spill from memory to durable files. Finalized buffers become immutable/content-addressed where practical.

The model-facing result should normally return a bounded head/tail or relevance view plus the durable handle, for example conceptually:

```text
buffer: build-output
lines: 183221
bytes: 31850103
digest: sha256:...
view: first 40 + last 80 lines
```

The agent can then request ranges, tails, searches, or structured extraction without retransmitting the entire buffer.

Large binary output is never inlined by default. It is referenced as an artifact/blob.

Text buffers should maintain enough indexing to make line-range reads and common searches fast without rescanning arbitrarily large logs for every request.

## Named caches

Caches are reusable results/state with identity and provenance, not merely directories with informal names.

A cache record should be able to bind information such as:

- stable logical name/namespace;
- content/result digest;
- producer execution;
- relevant input/environment/tool identities;
- validity state/reason;
- creation/last-use timestamps;
- size;
- hit/miss statistics;
- retention/GC policy.

An agent may request use of a named cache when valid. It may not declare the authoritative cache record valid by writing persistence metadata directly.

Cache keys should use canonical tool/input/environment identity where available so harmless differences in model-facing spelling do not create accidental misses.

## Execution history and provenance

Traditional shell history is insufficient. DevBridge should preserve **invocation/execution history**.

A history record should retain enough information to answer what was requested, what was normalized, what actually ran, what it consumed, and what it produced.

Useful fields include:

- source expression when one exists;
- canonical execution graph;
- per-process executable/tool identity and argv;
- cwd/workspace;
- relevant non-secret environment identity;
- start/end/duration;
- stdin identity/digest/reference rather than automatically storing sensitive raw input;
- stdout/stderr buffer references;
- per-stage exit/signal/timeout/cancellation;
- generated artifacts;
- cache hits/misses/publications;
- structured failure/causal links;
- parent run/agent/action identity.

Store secret references/redacted identities instead of credentials, tokens, passwords, private keys, or sensitive raw input.

History should support replay/comparison/provenance reasoning. It must not be mistaken for host-authoritative verification evidence.

## SQLite metadata/index plane and content store

Use a lightweight relational database, preferably SQLite, as the guest execution runtime's **metadata/query/index plane**, not as the bulk stream transport.

SQLite should index objects such as:

- executions;
- processes;
- stream/buffer metadata;
- caches;
- artifacts;
- dependencies/provenance links;
- structured errors/causes;
- tags;
- query telemetry where enabled.

Large stdout/stderr, binary artifacts, cache payloads, large stdin, and snapshots should live in append-only/finalized files and/or a content-addressed store. SQLite stores identities, offsets, indexes, metadata, and references.

Do not append every stream chunk as a new SQL BLOB row merely because SQLite is available.

SQLite WAL mode, migrations, indexes, FTS where useful, and bounded retention/GC should be evaluated as implementation details under this ownership model.

## Read-only SQL agent surface

Read-only SQL is the universal agent introspection interface for execution state.

This intentionally gives coding agents maximum flexibility before DevBridge guesses which specialized query endpoints deserve to exist. Models are already strongly trained on SQL, so a relational query surface is both expressive and familiar.

Agent-visible SQL access must be read-only against authoritative runtime persistence. Permit read/query constructs appropriate to the chosen SQLite sandbox; reject persistent mutation such as `INSERT`, `UPDATE`, `DELETE`, DDL, writable PRAGMAs, extension loading, attachment of arbitrary databases, or filesystem-changing functions.

Temporary/private analytical state may be supported only if it cannot mutate or escape into the authoritative execution store.

A strong invariant is:

> **SQL observes runtime state. Runtime-owned process/storage methods author runtime state.**

## Runtime-owned writes; no persistence writes in action packets

Action packets may request process execution, I/O topology, named buffer/cache use, artifact capture, and read-only queries. They do not carry direct persistence mutations.

The local runtime records state through internal object/service methods such as process started/output/exited, buffer append/finalize, artifact finalize, cache hit/miss/publish, and execution complete/fail.

This ensures the persistent record describes what the runtime observed rather than what the caller claims happened.

For the same reason, an agent cannot set `success=true`, mark a cache valid, fabricate an artifact digest, or rewrite history through an action packet. The runtime derives those states from observed local events and content.

Append-oriented lifecycle evidence may coexist with materialized current-state tables/views for fast SQL access.

## Structured causal error model

Do not collapse a pipeline into one integer when the runtime has more information.

For:

```text
A | B | C
```

the result should preserve each stage. If B exits 2 and C subsequently receives a broken pipe, DevBridge should be able to identify B's exit as the primary observed failure and C's EPIPE as consequential rather than presenting an undifferentiated `exit 2`.

Useful error categories include:

- process exit;
- spawn/executable-resolution failure;
- timeout;
- cancellation;
- signal termination;
- broken pipe;
- input/source failure;
- output/sink failure;
- parse/normalization failure;
- resource limit;
- permission failure;
- bridge/transport failure.

Human/model-readable messages should remain recognizable and concise while structured fields preserve machine-readable category, stage, cause, stream/buffer references, and relevant bounded evidence.

## Agent least surprise and model-prior optimization

The agent surface is itself a performance concern.

When multiple equivalent interfaces are possible, prefer the command names, syntax, cwd conventions, filesystem conventions, error vocabulary, and data formats most strongly represented in coding-model training unless doing so would compromise correctness, security, portability, or explicit semantics.

Examples:

- enter repository work with the repository root as cwd when that is the natural task scope;
- make common admitted developer tools available by their conventional bare command names on `PATH`;
- preserve familiar POSIX-style plumbing syntax for the common process-topology subset;
- use unified diff for normal patch representation unless evidence shows a better form;
- use SQL for flexible history/cache/buffer queries;
- use JSON or other familiar structured forms for interchange where appropriate;
- avoid requiring an agent to discover internal DevBridge paths merely to invoke ordinary tools.

The objective is to increase first-command/first-plan success and reduce tool-discovery/retry tokens.

## Tool identity, PATH, and filesystem truth

DevBridge may maintain one canonical registered installation/identity for a tool while projecting a conventional guest command surface.

Bare command resolution such as `cmake` may resolve through the guest's normal `PATH`/tool registry. The runtime should record both the requested spelling and canonical tool identity for provenance/cache purposes.

However, DevBridge must **not create a false filesystem reality** by silently translating arbitrary absolute paths only at the harness boundary.

If the agent successfully observes or executes `/usr/bin/cmake`, code and descendant processes in the same environment must also be able to use `/usr/bin/cmake` normally. Otherwise the agent may correctly infer a path that later fails when written into build configuration or invoked by a child process.

This invariant is **execution referential consistency**:

> **Any executable identity or filesystem location DevBridge exposes as valid in an execution environment must remain valid when referenced by code or descendant processes in that same environment.**

Therefore:

- prefer normal bare command names and conventional `PATH` behavior;
- use a real guest-owned stable tool projection/bin directory where useful;
- place broadly expected tools at conventional real locations when doing so is safe and maintainable;
- use real symlinks/shims/path projections for absolute-path compatibility only when the path truly exists for ordinary guest processes;
- never make an arbitrary nonexistent absolute path appear to work solely because the top-level harness rewrote it;
- fail closed on path-projection conflicts rather than silently replacing an unrelated executable;
- keep one canonical tool identity behind compatible projections so history/cache/provenance do not fragment by alias spelling.

Tool/path projection should be generated from explicit tool metadata and qualified during base-image/bootstrap construction rather than accumulated as undocumented filesystem mutations.

## Child-process compatibility

The runtime directly controls only processes it launches. Descendants launched by build scripts, package managers, shells, compilers, or repository programs execute against the ordinary guest environment.

This is why conventional `PATH` behavior and truthful real compatibility paths matter. The environment seen by the harness and by descendants should agree on observable executable locations and names.

A compatibility runtime required by an existing artifact (`bash`, `sh`, `pwsh`, `cmd`, `python`, `node`, etc.) remains an ordinary guest executable/runtime. Compatibility does not grant host authority.

## Query and execution telemetry

Do not prematurely encode every useful question as a special DevBridge method.

Start with the general read-only SQL surface and collect bounded privacy-conscious telemetry such as:

- normalized query fingerprint;
- views/tables used;
- execution frequency;
- latency;
- rows/bytes returned;
- whether a referenced buffer/artifact was subsequently fetched;
- first-command success/failure;
- executable-not-found and path-assumption failures;
- cwd/PATH/tool-discovery commands;
- parser/syntax retries;
- shell-adapter fallbacks;
- common compatibility-projection hits/misses.

Normalize literals out of query fingerprints so equivalent queries are grouped without retaining sensitive values unnecessarily.

When real usage demonstrates a stable high-frequency operation, promote it to a dedicated optimized runtime method or index while leaving SQL available as the universal fallback.

Examples might eventually include buffer tail/range reads, recent failure summaries, cache-validity lookup, or execution comparison, but they should be promoted from evidence rather than guessed in advance.

## Result formatting and content-aware views

The runtime may detect high-confidence content types at the result/view layer:

- structured JSON/YAML/CSV can expose compact parsed/structured views while preserving raw bytes by reference;
- binary output remains reference-only by default;
- diffs normally preserve familiar unified-diff representation;
- ordinary text uses bounded head/tail/relevance views plus a durable buffer handle.

Do not destroy the canonical raw result simply because a compact agent view exists.

## Proposed implementation ownership

The guest implementation should be built behind an extraction-quality boundary rather than continuing to grow `src/guest/bridge-agent.mjs` into a monolith.

A target shape is conceptually:

```text
src/guest/
  bridge-agent.mjs                 # bridge/protocol adapter
  activity-store.mjs               # exact-attempt fence and bounded activity evidence
  local-process.mjs                # bounded process lifecycle behind neutral control ports
  transfer-channel.mjs             # exact byte transfer behind neutral location ports
  execution/
    execution-runtime.js
    execution-ir.js
    process-graph.js
    process.js
    streams.js
    buffers.js
    cache.js
    history.js
    errors.js
    storage/
      execution-store.js
      sqlite-store.js
      content-store.js
    query/
      read-only-sql.js
    frontends/
      posix-plumbing.js
      nushell.js
```

Exact filenames are not normative. The dependency direction is.

The execution core must not depend on DevBridge controllers, GitHub, VM providers, host Git authority, or provider-specific transports. `bridge-agent.mjs` is the adapter into the guest runtime rather than the owner of process, attempt/activity, or transfer mechanics. The flat nested owners above are the current smallest complete split; the deeper `execution/` tree is a future shape whose individual files should exist only when a separately changeable owner is demonstrated.

The existing host `DeterministicProcessRunner` remains narrow and should not grow into this shell-like agent runtime.

The existing repository-environment session seam (`prepare`, input, run, output, collect) remains the host/guest orchestration boundary unless implementation evidence demonstrates that its studs are insufficient. SQL/storage/process details remain below that seam.

## Language/repository placement

Implement the first version inside DevBridge rather than immediately creating another repository. The ownership boundary should nevertheless be clean enough that the guest execution runtime can later be extracted into a reusable package/repository if real reuse justifies independent versioning/release lifecycle.

The current DevBridge runtime is Node-based; v1 should use the existing runtime where it can satisfy correctness and performance. Introduce native code only when measurement demonstrates a requirement that the library/runtime layer cannot meet cleanly.

## Implementation sequence

Build in coherent ownership slices:

1. **Execution IR and result/error model** — direct processes, process graph, streams, redirects, per-stage outcomes.
2. **Guest execution engine** — move repository process execution behind the new core while preserving DB-020 routing/fail-closed behavior.
3. **Named durable buffers + content store** — replace destructive truncation with bounded view + durable handle semantics.
4. **SQLite history/index + read-only SQL** — runtime-owned writes only; agent query surface cannot mutate authoritative runtime persistence.
5. **Named caches** — build validity/provenance/retention on the same execution/storage model.
6. **POSIX-style plumbing frontend** — compile the high-frequency familiar surface into the already-stable execution IR.
7. **Nushell adapter** — add the preferred full-shell composition lane without making Nu the execution kernel.
8. **Telemetry-driven hot paths** — promote stable frequent SQL/buffer/cache/history operations only after measurement.

Do not start by implementing a large shell grammar, custom command DSL, or dozens of specialized history/cache endpoints before the execution/storage contracts are stable.

## Qualification requirements

At minimum, qualification should prove:

- ordinary direct commands do not invoke a shell;
- supported pipes/redirects lower to explicit process/I/O topology;
- stdin defaults to EOF and unattended prompts do not hang indefinitely;
- stdout and stderr remain distinct and stderr output alone does not mean failure;
- per-stage exit/signal/error state survives pipelines;
- causal/consequential failures are represented without losing raw stream evidence;
- large output is retained behind bounded durable references rather than silently discarded;
- buffer range/tail/search operations remain bounded and efficient at large sizes;
- SQL access is read-only against authoritative runtime persistence;
- action packets cannot issue direct persistence writes or declare cache/history/process truth;
- cache/artifact digests are runtime-computed;
- absolute-path execution/discovery is referentially consistent for descendant processes;
- conventional bare tool names resolve naturally in admitted guest environments;
- compatibility runtimes stay guest-local and do not create host-shell fallback;
- bridge disconnect/retry/recovery does not accidentally duplicate a completed non-idempotent execution without reconciliation;
- guest runtime state never becomes host verification/publication authority;
- Hyper-V/libvirt transport choice does not change execution-runtime semantics.

## Non-goals

- Replacing the VM boundary with the execution harness.
- Turning the trusted host process runner into an agent shell.
- Giving action packets SQL write authority.
- Treating guest history/cache state as host verification truth.
- Implementing an interactive terminal as the default execution model.
- Removing Bash/sh/PowerShell/cmd compatibility for artifacts that actually require them.
- Requiring agents to learn a novel DevBridge command DSL for ordinary coding work.
- Faking arbitrary absolute executable paths through harness-only translation.
- Shipping every possible optimized query endpoint before observing real agent behavior.

## Governing relationship

Read this document with:

- `specs/DB-003-security.md` for local capability authority;
- `specs/DB-013-controller-plans.md` for structured controller intent;
- `specs/DB-015-tool-inventory.md` for tool discovery/onboarding authority;
- `specs/DB-019-verification-cost-evidence.md` for durable verification evidence;
- `specs/DB-020-vm-execution-boundary.md` for the host-security boundary;
- `docs/architecture.md` for trust/ownership topology;
- `docs/tool-profiles.md` for repository tool/profile behavior;
- `docs/design-principles.md` for LEGO/CUPID/KISS constraints.

Where this document concerns agent ergonomics or guest-local execution behavior, it remains subordinate to the security/capability/host-authority invariants in the normative specifications.
