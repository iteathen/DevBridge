# DB-HO084 — issue #384 fixed Linux CLI authentication broker

Status: implemented and locally software-qualified on branch `stage8/362-protected-activity-channel` from accepted #382 documentation head `ca8ee61875d5429066d48777be896468677f91ae`; exact-head hosted Ubuntu/Windows acceptance remains required.

This is a no-elevation software prerequisite under #293. Development and qualification must not invoke `sudo`, `pkexec`, UAC, the protected refresh child, a service mutation, a provider or protected-storage operation, a VM or guest, repository execution, or a coding model.

## Required preflight and assessment

The VM-program planning gate was repeated before design. DB-003, DB-009, DB-020, `docs/vm-migration.md`, `docs/vm-lego-studs.md`, and `docs/vm-stage6-repository-execution.md` were read completely with parent #293 and accepted #381/#382. The exact implementation being extended was inspected through the versioned protected-child request/result contract, Linux protected child, ordinary readiness root, one-attempt/re-observation policy, command runner, setup composition, Windows bounded elevation adapter/child, hidden CLI option parser, and current source-isolation tests.

The accepted stack now has the correct decision owners:

- ordinary readiness alone decides whether the installed authority is ready and, when repair is safe, emits one frozen opaque protected subject;
- the import-free reconciliation policy alone permits at most one attempt and accepts success only from a complete fresh observation; and
- the protected child independently revalidates root invocation, submitter identity, complete management topology, numeric NSS bindings, state identity, package/Node digests, deterministic plan, and refresh effects.

No component owns the authentication handoff between the policy's opaque `attempt(subject)` port and the protected child. The handoff must not become a command language or inherit Windows UAC topology. It needs one replaceable authentication adapter, one platform/topology-agnostic framing dispatcher, and one Linux-local composition entry. Setup/CLI selection remains a later topology edge.

## Primary-source research

Current upstream `sudo` source defines `--` as the end-of-options boundary, `-n` as non-interactive, `-S` as password-from-stdin, and `-E` as environment preservation. Its troubleshooting guide explains that normal authentication reads from the user's terminal and recommends `-S` only when stdin password handling is deliberately chosen. The sudoers manual documents that `env_reset` normally creates a minimal command environment and sets `SUDO_*` from the invoking user, while also warning that local policy can change environment behavior.

These facts make one CLI-first adapter possible without sharing a password channel with DevBridge: the bounded child request can travel on stdin while normal authentication uses `/dev/tty`. The adapter must omit `-S`, `-E`, `-n`, askpass, shell modes, environment assignments, and caller-selected options. It must also supply a minimal non-secret environment to the authentication process itself because DevBridge cannot assume every local sudoers policy retains the default environment reset.

Polkit documents materially different semantics. `pkexec` uses a registered session authentication agent or its own textual agent, creates a minimal environment, supplies `PKEXEC_UID`, and explicitly does not validate arguments passed to the selected program. That can support a separate adapter, but it is not a transparent fallback for the CLI contract. Automatically trying `pkexec` after `sudo` failure would create a second prompt/effect path and would blur which local policy authorized the attempt.

Node 22 documents that `child_process.spawn()` receives an executable plus an argument array and defaults to `shell: false`. Linux `lstat(2)` reports a symbolic link itself rather than its target and exposes file type, mode, owner, device, and inode evidence. Node's `FileHandle.stat()` permits descriptor-bound comparison and requires explicit handle closure. Those primitives support a read-only fixed-program identity canary and stable before/descriptor/after checks without executing discovery probes.

Primary sources, accessed 2026-08-29:

- [upstream sudo argument parser](https://github.com/sudo-project/sudo/blob/main/src/parse_args.c)
- [upstream sudoers environment and submitter-identity contract](https://github.com/sudo-project/sudo/blob/main/docs/sudoers.man.in)
- [upstream sudo terminal/password troubleshooting](https://github.com/sudo-project/sudo/blob/main/docs/TROUBLESHOOTING.md)
- [polkit `pkexec(1)`](https://polkit.pages.freedesktop.org/polkit/pkexec.1.html)
- [Node.js 22 child-process API](https://nodejs.org/download/release/latest-jod/docs/api/child_process.html)
- [Linux `stat(2)` / `lstat(2)`](https://man7.org/linux/man-pages/man2/stat.2.html)
- [Node.js filesystem/FileHandle API](https://nodejs.org/api/fs.html)

## Reassessment and selected boundary

Implement one concrete `sudo` adapter first because DevBridge setup is CLI-first. Do not implement a broker fallback chain. A later `pkexec` adapter may replace it through the same neutral attempt port when local configuration explicitly selects that topology.

The concrete adapter owns the fixed `/usr/bin/sudo` identity. Read-only discovery and pre-attempt observation require Linux, a real non-symlink regular file, root UID/GID, set-user-ID execution, at least one execute bit, no group/world write bit, a canonical unchanged path, stable device/inode/mode/owner/group/size evidence through an opened descriptor, and root-owned non-group/world-writable fixed parent directories. Missing, linked, widened, substituted, or malformed evidence reports unavailable without executing anything. The executable identity is re-observed after an attempted process; a changed identity invalidates the bounded attempt evidence.

The adapter request contains only one frozen opaque `subject`. Production construction fixes the authentication executable, current Node executable, installed authenticated entry module, argument vector, timeout, output bounds, and environment allowlist. It invokes exactly:

`/usr/bin/sudo -- <current-node> <fixed-entry>`

through the existing no-shell command runner. The subject is one bounded JSON value on stdin. The environment is rebuilt from fixed non-secret values plus only a syntactically bounded terminal type when present; it never forwards the caller environment. The adapter never accepts or returns an executable, argv, environment, password, credential, path, broker output, downstream result, provider/service/storage identity, or generic effect. Its path-free result is diagnostic only and can never declare readiness.

An import-free neutral dispatcher owns only one bounded input frame, JSON parsing, one injected `perform(value)` port, bounded JSON output, and failure normalization. It knows no Linux, authentication program, setup, child, service, provider, storage, VM, repository, or model identity. It invokes at most once.

A Linux-local composition entry is the sole topology edge. It attaches the neutral dispatcher to the accepted #381 child and to a tiny submitter observer that reads only exact `SUDO_USER`, `SUDO_UID`, and `SUDO_GID` evidence under effective root execution. The child still performs the independent NSS/topology/state/candidate checks; submitter environment is invocation evidence, not authority. The entry emits only the existing bounded child result and exits nonzero when it is not ready. The ordinary parent ignores that claim and #382 re-observes from scratch.

No setup or CLI module imports the new brick in this issue. This keeps authentication unavailable in production while its command construction, identity checks, framing, and LEGO boundaries are qualified without privilege.

## Scoped implementation plan

1. Add an import-free bounded one-operation JSON dispatcher with exact request/result behavior and no topology vocabulary.
2. Add the Linux-local submitter observer with exact non-root name/UID/GID parsing and no NSS or downstream policy ownership.
3. Add the fixed CLI authentication adapter with descriptor-bound executable discovery, parent-chain checks, minimal environment construction, one no-shell invocation, bounded path-free result, post-attempt identity re-observation, and no fallback.
4. Add the fixed authenticated composition entry that attaches only the dispatcher, submitter observer, and unchanged #381 child.
5. Test malformed/oversized framing, at-most-once dispatch, frozen-subject enforcement, fixed command/argument/environment construction, secret stripping, missing/unsafe/substituted executable evidence, timeout/abort/refusal/failure classification, post-attempt identity drift, exact submitter parsing, output non-authority, and module/source isolation.
6. Add the new sources/tests to repository preflight. On Ubuntu, execute the real read-only `/usr/bin/sudo` identity canary but never invoke it.
7. Run current and exact Node 22.16.0 focused tests, wider Linux authority tests, preflight, repository-execution architecture gates, the complete serialized suite, doctor, generated-artifact identity, and diff hygiene.
8. Commit/push the isolated implementation and require exact-head Ubuntu/Windows smoke/full CI. Close only #384 after durable acceptance; keep #293 open.

## Implementation checkpoint

The implementation preserves four separate owners:

- `protected-operation-dispatcher.js` is import-free and owns only bounded UTF-8 framing, one JSON object, one `perform(subject)` call, JSON-safe bounded output, and path-free failure normalization. It has no platform, authentication, setup, service, provider, repository, VM, or child identity.
- `linux-cli-authentication-origin.js` owns only exact effective-root invocation evidence and the three `SUDO_USER`, `SUDO_UID`, and `SUDO_GID` data properties. It projects one frozen non-root principal and never performs NSS lookup or grants capability.
- `linux-cli-authentication.js` owns the fixed CLI authentication topology. Observation accepts only the canonical root/root set-user-ID `/usr/bin/sudo` file beneath fixed root-owned non-writable parents. Attempt construction accepts one deeply frozen bounded JSON subject, verifies the fixed executable and launch identities before and after the attempt, rebuilds a fixed non-secret environment, and invokes only `/usr/bin/sudo -- <current-node> <fixed-entry>` through the existing no-shell runner. The result is path-free and non-authoritative; child stdout cannot establish success.
- `linux-cli-authenticated-entry.js` is the sole explicit composition edge. It attaches the dispatcher to the unchanged #381 protected child and the submitter observer, validates both contracts at the seam, emits only bounded dispatcher output, and exits successfully only for an exact ready child result whose serialized bytes match the dispatched bytes.

All new public requests and injected port bags are exact plain data objects with no hidden, accessor, symbol, or unknown properties. JSON values reject mutable graphs, cycles, accessors, custom prototypes, non-finite/non-integer values where applicable, symbolic properties, over-depth/over-count data, NUL text, and oversized frames. Fixed-file observation uses canonical `lstat`/`realpath`, a no-follow read handle, before/descriptor/after identity comparison, a single link, bounded size, and explicit close failure handling. Executable mode is required for `sudo` and Node, while the Node-loaded JavaScript entry is correctly treated as non-executable source.

No setup or CLI module imports these bricks, so this commit cannot reach authentication in production. There is no legacy request, caller-selected program/argv/environment, password channel, `sudo` option, `pkexec` fallback, shell, generic privileged helper, or second attempt path.

## Local qualification evidence

The supported exact runtime was the official Node.js `v22.16.0` Windows x64 archive with SHA-256 `21c2d9735c80b8f86dab19305aa6a9f6f59bbc808f68de3eef09d5832e3bfbbd`, verified against Node's published `SHASUMS256.txt` before use.

- Direct new-module tests: 22 total, 21 passed, one expected Windows skip, zero failures.
- Exact-Node wider Linux authority boundary: 69 total, 67 passed, two expected Windows skips, zero failures.
- Current and exact-Node repository preflight: two standalone artifacts, 215 syntax files, two JSON files, and 176 targeted test files passed.
- Exact-Node repository-execution architecture gate: 34 total, 33 passed, one expected Windows symlink skip, zero failures.
- Exact-Node complete serialized suite: 1,899 total, 1,879 passed, 20 expected platform skips, zero failures in 189 seconds.
- Exact-Node doctor passed and truthfully reported repository execution unavailable because no local persistent-environment execution route is configured. The standalone artifact regeneration check and diff hygiene passed.

The Windows host skipped the production Linux observation as designed. Hosted Ubuntu must execute—not skip—the read-only `/usr/bin/sudo` identity canary on the exact implementation head. No test invoked `sudo`, `pkexec`, UAC, an authenticated child, protected mutation, service/provider/storage effects, a VM or guest, repository execution, or a coding model.

## Remaining acceptance and downstream boundary

Commit and push the isolated implementation, require the exact-head Ubuntu/Windows smoke/full matrix, and inspect Ubuntu output for the real fixed-program canary. Only then document hosted acceptance and close #384. Parent #293 remains open: a later issue must attach configuration-selected authentication observation/attempt to #382 from setup, preserve one-attempt/fresh-reobservation policy, and eventually obtain physical Linux protected provider/storage and guest C-canary evidence. This software checkpoint does not make DevBridge operational for repository code.

## Explicit downstream gates

After #384, a separate issue may compose the accepted adapter with #382 from setup, discover configuration-selected alternatives, expose path-free readiness/choice UX, and route the fixed authenticated entry. That integration must still permit only one attempt and complete fresh re-observation. Positive protected provider access, protected qcow2 storage, physical systemd/libvirt authority evidence, the Linux guest C canary, Stage 8 setup completion, and real Hyper-V/KVM qualification remain separate gates.
