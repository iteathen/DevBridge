# DB-HO097 — Guest capability-probe admission

Date: 2026-08-30

Status: assessment, research, reassessment, and implementation plan recorded

Coordinates with: #290, #393, DB-015, DB-018, DB-019, DB-020, DB-HO055, and DB-HO096.

GPU/CUDA work is outside this checkpoint.

## Scope and ownership

This checkpoint owns process admission for capability observations inside the standalone guest bootstrap helper. The helper already owns the fixed capability registry, local executable search, bounded health probes, output projection, and eight-second per-probe hard timeout. It therefore also owns the maximum number of those probes it admits at once.

The change may add one import-free neutral ordered-observation function in the same helper and tests for that local contract. It must not add CI/host/provider identity to the guest; change tool names, arguments, per-probe timeout, response schema, discovery placement, or VM security; restore host repository-tool probing; or invoke setup/elevation, a provider/VM/guest mutation, repository execution, or a model.

## Assessment

Exact commit `342784b573e830baa088adbf0fec7336ee926286` changed only a Windows Hyper-V test timeout. [GitHub Actions run 33311577191](https://github.com/iteathen/DevBridge/actions/runs/33311577191) passed Ubuntu smoke/full and Windows serialized full/doctor. Windows bounded smoke completed its complete 180-file / 968-test preflight in 78 seconds but failed the real baseline capability observation: present CMake (`build-config`) did not complete its fixed eight-second health probe. The same test passed in the serialized full suite on the exact same commit.

DB-HO055 already moved the Windows preflight to a closed two-file concurrency policy after machine-derived concurrency caused this same CMake signature and full serialization proved wall-clock fragile. The new supported-host recurrence shows that test-file admission alone does not bound child-process fan-out inside each product module.

The guest helper accepts at most 64 unique requested identities and evaluates all known requirements with `Promise.all(body.requirements.map(inspectCapability))`. Its normal seven-capability fixture therefore launches Git, Node, CMake, CTest, compiler, and npm health probes concurrently, in addition to children owned by the second admitted test file. This is a local resource burst. The caller cannot correct it without learning or controlling the helper's internals.

## Primary-source research

Node 22.16 documents [`child_process.spawn`](https://nodejs.org/download/release/v22.16.0/docs/api/child_process.html#child_processspawncommand-args-options) as asynchronous child-process creation. Each call creates a separate operating-system process; a local `Promise.all` does not impose admission ordering.

Node 22.16 documents [`--test-concurrency`](https://nodejs.org/download/release/v22.16.0/docs/api/cli.html#--test-concurrency) as the maximum number of test files, while the [test-runner execution model](https://nodejs.org/download/release/v22.16.0/docs/api/test.html#test-runner-execution-model) runs each matching file in its own process. That setting does not bound grandchildren launched by a test or by the product under test.

GitHub's [hosted-runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) defines the supported public Windows runner as a managed four-vCPU environment. DB-018 forbids inventing unaccounted worker pools, and DB-019 requires resource-aware verification parallelism rather than raw fan-out. DB-015/DB-020 place repository-class observation inside the exact guest; they do not require simultaneous probes.

## Reassessment

The eight-second probe timeout is a valid per-operation hang bound and passed when the same file ran without a concurrent neighbor. Widening it would retain the resource burst and misclassify admission pressure as tool latency. Returning the preflight to one file would repeat DB-HO055's supported-runner wall-clock failure. Removing the real probe or test would weaken capability evidence.

The smallest complete repair is local and topology-free: preserve state and network observation independence, but evaluate capability identities in their already normalized order with at most one active capability observation. The normal path still completes quickly; worst-case work remains a sequence of independently bounded operations rather than an unbounded burst. Output order and the public schema remain unchanged.

## Plan

1. Add one import-free `observeSequence(values, observe)` local stud. It validates only its own array/function contract, invokes one observation at a time, preserves input order, and stops at the first rejection.
2. Replace only the capability `Promise.all` with that stud. State loading and network observation may remain independent because they do not launch the registered tool set.
3. Export the local stud for direct contract tests without exporting the fixed registry, executable identities, paths, arguments, or process authority.
4. Prove maximum active observations equals one, order is stable, rejection stops later work, and the real baseline retains the same results.
5. Run repeated exact-Node Windows bounded preflights, default preflight, architecture/product/standalone gates, complete serialized suite, doctor, generated-artifact, and diff hygiene.
6. Require repeated complete hosted matrices before closing #393 and re-closing #290. The same accepted exact head may satisfy #392 if all four jobs pass.

No compatibility alias, raw concurrency input, retry, timeout widening, or production fallback is permitted.
