# DevBridge LEGO module contract

This document makes DevBridge's LEGO rule concrete for humans and coding agents.

LEGO is not a metaphor for "small files" or "many classes." It is the outer architectural rule for **ownership, universality, replaceability, scope containment, damage-limiting encapsulation, studs/surfaces, and full-attention sizing**:

> **A brick knows its own contract and children. Composition knows the current topology. Other bricks know only the exposed studs/surfaces.**

The purpose is to prevent today's wiring from becoming tomorrow's dependency, keep failures and redesign contained, and keep each reasoning unit small enough for one agent to understand completely.

Read this with [`design-principles.md`](design-principles.md), `AGENTS.md`, and the owning DB specification.

## Recursive scale: the application is a LEGO too

DevBridge itself is the outermost LEGO. Its supported external task/control inputs, status/result outputs, local control surfaces, provider contracts, events, and lifecycle entry/exit points are its public **studs/surfaces**.

LEGO composition is recursive:

```text
DevBridge application LEGO
  -> major product-area LEGOs
    -> subsystem LEGOs
      -> component / large-object LEGOs
        -> smaller private child LEGOs where useful
```

A parent LEGO may own one externally visible responsibility while smaller private children own narrower invariants, state machines, resources, lifecycles, or failure domains. The parent hides child topology from consumers. A caller must not reach through a parent surface to wire or mutate a private child.

Very large objects and large application sections should preferentially be compositions of smaller child LEGOs when the split preserves cohesion and makes each internal unit independently comprehensible.

## Full-attention sizing

A LEGO must fit one agent's **full-attention envelope**. The complete authoritative working set must fit comfortably in focused attention at once:

```text
public contract / studs / surfaces
+ implementation
+ invariants
+ lifecycle / resource / failure rules
+ tests and conformance
+ immediate dependency interfaces
+ immediate consumer expectations needed to understand consequences
```

There must still be substantial headroom for the current task, alternatives, evidence, diff inspection, and review. Merely fitting inside a model's maximum context window is not sufficient.

Choose boundaries using both **cohesion** and **context fit**. Strong real seams include:

- semantic or ontological ownership;
- lifecycle cohesion;
- functional cohesion;
- stable dependency or substitution boundaries;
- independently owned failure/resource behavior;
- volatility or change boundaries;
- execution locality;
- full-attention context fit.

If a coherent brick exceeds full attention, recursively split it at the strongest real internal seam or narrow its scope. Context pressure is a first-class architectural constraint, but it does not justify arbitrary file splitting.

A split is wrong when it duplicates truth, creates multiple writers or shared mutable ownership, causes constant cross-boundary chatter, separates an indivisible state transition without a stable contract, or makes neighboring bricks understand each other's internals.

The target is the **smallest coherent independently comprehensible and replaceable unit**, not the smallest possible module.

## Non-negotiable rules

### 1. Complete module isolation

A LEGO module must remain internally self-contained.

Inside a generic module, do not reference:

- another module's concrete name;
- another module's private object/type identity;
- a private child hidden behind another LEGO;
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

### 4. Stud/surface integrity

A stud/surface is a supported connection contract: an input, output, port, command/query surface, event, capability, or lifecycle seam.

A surface must expose only the facts/actions the brick intentionally supports. It must not expose mutable internals, private child topology, foreign implementation objects, or provider-specific details merely to make current wiring convenient.

Consumers connect LEGO-to-LEGO. They do not drill through one brick to attach directly to an internal child.

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
6. Am I exposing a private child that should remain hidden behind the parent surface?
7. Does adding this field expand the brick's reasoning surface beyond one full-attention envelope?

If the answer reveals current topology, move that knowledge outward to composition or inward to the adapter that owns it. If the answer reveals an oversized brick, split at the strongest real seam rather than broadening a catch-all contract.

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
- prove a different profile/provider can be wired without repository-routing changes;
- prove private child topology can change without consumer changes;
- prove the parent can substitute a child implementation through the same internal stud/surface;
- review the complete authoritative working set and confirm it fits one agent's full attention with review headroom.

## Review checklist

For every meaningful code change, reviewers/agents should ask:

- [ ] Does each changed module own every concrete concept it names?
- [ ] Are interface names local and topology-agnostic?
- [ ] Could the current connected module be replaced without editing this module?
- [ ] Are provider/model/GitHub/repository specifics terminated at their adapter boundary?
- [ ] Did any foreign type/object/path cross into generic logic?
- [ ] Did a helper merely move the leak instead of removing it?
- [ ] Is topology expressed in composition rather than business logic?
- [ ] Are private child LEGOs hidden behind the parent studs/surfaces?
- [ ] Can one agent hold the brick's complete authoritative working set in full attention?
- [ ] Does the test prove the contract with a replaceable fake/alternate implementation where useful?

If these answers are not clear, stop expanding the feature and repair the connection stud or LEGO size first.

## Relationship to SOLID, CUPID, and KISS

Use the hierarchy in order:

- **LEGO** chooses and contains architectural boundaries, ownership, scope, damage radius, studs/surfaces, and full-attention size;
- **SOLID** structures responsibilities and dependency direction inside each valid brick;
- **CUPID** makes that implementation composable, predictable, idiomatic, and domain-based;
- **KISS** removes only the remaining unjustified complexity.

A lower-level principle cannot repair a wrong higher-level boundary. A design can have small classes and dependency injection and still violate LEGO if its names/types encode current topology or if the complete brick is too large for focused attention.

That naming- and attention-level discipline is intentional: boundary leaks and context overload usually begin long before they become obvious hard dependencies or maintenance failures.
