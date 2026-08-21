# DevBridge LEGO module contract

This document makes DevBridge's LEGO rule concrete for humans and coding agents.

LEGO is not a metaphor for "small files" or "many classes." It is an ownership rule:

> **A module knows its own contract. Composition knows the current topology.**

The purpose is to prevent today's wiring from becoming tomorrow's dependency.

Read this with [`design-principles.md`](design-principles.md), `AGENTS.md`, and the owning DB specification.

## Non-negotiable rules

### 1. Complete module isolation

A LEGO module must remain internally self-contained.

Inside a generic module, do not reference:

- another module's concrete name;
- another module's private object/type identity;
- a current upstream/downstream adapter name;
- provider-specific concepts that belong behind a provider adapter;
- repository/provider/model names that are merely artifacts of current wiring;
- a foreign filesystem/topology detail that is not part of the module's own contract.

A module may depend on a **local port/contract** that describes what it needs. The composition root or adapter wiring supplies the current implementation.

If replacing one connected component requires editing the internals of another component, the boundary is leaking.

### 2. Agnostic interface naming

Inputs, outputs, events, properties, and port methods must describe the **local data/action**, not the identity of the current neighbor.

Bad names often create dependencies before imports do.

Prefer names such as:

- `subject`;
- `request`;
- `input`;
- `result`;
- `observation`;
- `environment`;
- `workspace`;
- `capability`;
- `generation`;
- `candidate`;
- `accepted`;
- `source` / `target` only when they are intrinsic directional roles in the local contract.

Avoid names such as these inside a generic module when the identity belongs to another LEGO:

- `githubIssue`;
- `codexResult`;
- `hyperVVm`;
- `libvirtDomain`;
- `repositoryResultFile`;
- `stage0Supervisor`;
- `downstreamPublisher`;
- `upstreamQueue`.

Those names can be valid **inside the adapter that owns that concrete domain**. They are not valid leakage into a neutral core module.

### 3. Transient topology

Assume every external connection may change.

A module must continue to make sense if its current neighbor is:

- replaced;
- removed;
- duplicated;
- wrapped;
- connected through another adapter;
- used in a different composition.

Current topology belongs in composition/wiring, not internal business logic.

Do not encode assumptions such as:

- "this output always goes to GitHub";
- "this environment is always Hyper-V";
- "this result always came from a model";
- "this workspace always belongs to one repository VM";
- "this port will always be backed by a file at this physical path."

## Where concrete names belong

Concrete identities are allowed where they are the module's **own domain**.

Examples:

- a Hyper-V adapter may name Hyper-V concepts internally;
- a libvirt adapter may name libvirt/QEMU concepts internally;
- a GitHub adapter may name GitHub API concepts internally;
- a Codex adapter may name Codex protocol concepts internally;
- a composition root may name the concrete modules it wires together.

The rule is not "never use concrete words." The rule is:

> Concrete words stop at the boundary of the module that owns them.

## Examples

### Example: result handling

Leaky core logic:

```js
class WorkRunner {
  async run(request) {
    const codexResult = await this.repositoryVm.execute(request);
    return this.readGuestResultFile(codexResult);
  }
}
```

Problems:

- the runner knows a model identity;
- it knows the current environment topology;
- it knows a physical result transport.

Neutral shape:

```js
class WorkRunner {
  async run(request) {
    const observation = await this.execution.execute(request);
    return this.resultPort.accept(observation);
  }
}
```

The current model adapter, VM execution adapter, and result-emission adapter are wired outside the runner.

### Example: execution environment

Leaky generic interface:

```js
startHyperVRepositoryVm(repositoryName)
```

Neutral contracts can instead separate concerns:

```js
resolveEnvironment(subject)
startEnvironment(environment)
resolveWorkspace(subject)
```

A Hyper-V adapter may translate the neutral environment subject into its own VM identity internally. A repository-routing module may derive a workspace subject internally. Neither needs to know the other's concrete objects.

### Example: events

Leaky event:

```text
codex-result-file-ready
```

Neutral event:

```text
result-available
```

If the event is emitted **inside the Codex adapter** and never leaks into generic orchestration, the concrete name may be appropriate there. Once it crosses into a generic pipeline, use the local generic contract.

## Foreign types are boundary leaks too

Avoid accepting another module's internal class/type merely because it is convenient.

Leaky:

```js
function admit(environment: HyperVEnvironment) {}
```

inside a generic admission module.

Prefer a local contract:

```js
function admit(environment: EnvironmentObservation) {}
```

where `EnvironmentObservation` is owned by the admission/environment port, not imported from the provider implementation.

The adapter translates its private type into the neutral contract.

## Physical paths are topology

A generic module should not know the provider/guest/host physical path used by a current bridge.

Prefer logical transfers/capabilities such as:

```text
input:context
output:result
workspace:source
```

and let the bridge/environment adapter map those to current physical locations.

This is why repository/model logic must not be taught paths such as a specific host or guest `bridge/output/...` location to repair a transport problem.

## Ownership test for every new field

Before adding a field/property/event/parameter, ask:

1. Is this concept intrinsic to this module's own responsibility?
2. Would this name still make sense if the current neighbor were replaced?
3. Is the field describing data/action, or is it naming who currently provides/consumes it?
4. Am I importing a foreign type when a local contract would suffice?
5. Am I exposing a physical path/object identity that an adapter should own?

If the answer reveals current topology, move that knowledge outward to composition or inward to the adapter that owns it.

## Composition-root exception

Some code must know topology. That is the job of a composition root/wiring layer.

Composition may legitimately say:

```text
GitHub task source -> provenance gate -> run coordinator -> profile router -> execution port
```

The connected modules themselves should not encode that sentence internally.

Composition code should remain thin. It wires capabilities; it does not become a second implementation of their business rules.

## Adapter exception

An adapter owns the translation between a neutral port and a concrete external domain.

A good adapter:

- contains concrete external names;
- translates external/private data into neutral local contracts;
- translates neutral requests into external operations;
- enforces/observes the boundary it owns;
- does not leak its private objects upstream;
- does not grant new authority merely because the external system supports it.

## Do not hide leaks in "shared" helpers

Moving provider/repository/model-specific knowledge into a generic `utils` module does not fix coupling.

Examples of suspicious helpers:

- `getRepositoryVmPath()` used by unrelated modules;
- `parseCodexOutput()` imported by generic execution;
- `githubIssueToRunState()` inside a general state package;
- `hyperVOrLibvirtName()` inside core routing.

Put the translation at the owning adapter/boundary instead.

## Schema evolution

When a local contract evolves:

- add fields for local semantics, not for one adapter's convenience;
- prefer capability/observation fields over concrete provider objects;
- keep unknown/new adapters possible without editing the core;
- reject unsupported authority rather than adding a generic escape hatch;
- version externally durable protocols when compatibility requires it.

## Tests that prove LEGO boundaries

Useful boundary tests include:

- inject a fake adapter through the same neutral port without core changes;
- source scans that forbid concrete provider/model/topology identities in a generic module;
- replace current transport while retaining the same local contract;
- prove absent provider fails at the port rather than branching to another concrete implementation inside core logic;
- prove physical path changes do not affect higher-level result/work semantics;
- prove multiple repositories can map to one profile without provider adapter changes;
- prove a different profile/provider can be wired without repository-routing changes.

## Review checklist

For every meaningful code change, reviewers/agents should ask:

- [ ] Does each changed module own every concrete concept it names?
- [ ] Are interface names local and topology-agnostic?
- [ ] Could the current connected module be replaced without editing this module?
- [ ] Are provider/model/GitHub/repository specifics terminated at their adapter boundary?
- [ ] Did any foreign type/object/path cross into generic logic?
- [ ] Did a helper merely move the leak instead of removing it?
- [ ] Is topology expressed in composition rather than business logic?
- [ ] Does the test prove the contract with a replaceable fake/alternate implementation where useful?

If these answers are not clear, stop expanding the feature and repair the connection stud first.

## Relationship to SOLID, CUPID, and KISS

This LEGO contract complements the other design rules:

- **SOLID** defines responsibility and dependency direction;
- **CUPID** encourages composable, predictable, domain-based behavior;
- **KISS** keeps the connection mechanism as small as possible;
- **LEGO** prevents the connected components from learning each other's identities.

A design can have small classes and dependency injection and still violate LEGO if its names/types encode current topology.

That naming-level discipline is intentional: boundary leaks usually begin as convenient vocabulary long before they become obvious hard dependencies.
