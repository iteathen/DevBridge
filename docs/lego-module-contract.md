# DevBridge LEGO module contract

This document makes DevBridge's LEGO rule concrete for humans and coding agents.

LEGO is not a metaphor for "small files" or "many classes." It is an ownership rule:

> **A module knows its own contract. Composition knows the current topology.**

The purpose is to prevent today's wiring from becoming tomorrow's dependency.

Read this with [`design-principles.md`](design-principles.md), `AGENTS.md`, and the owning DB specification.

## Large parent LEGOs and recursive structure

A LEGO does **not** have to be physically small.

A large domain may remain one parent LEGO while being internally composed from smaller nested LEGOs. The parent owns the domain, authority, public studs, and internal topology; nested children own bounded local mechanics or subdomains.

The rule is:

> **Force LEGO invariants, not LEGO geometry. Let ownership and reasoning boundaries determine the nested shape.**

Do not impose a universal directory template, maximum line count, one-class-per-file rule, or fixed set of `index` / `ports` / `state` / `service` files. Those shapes become accidental architecture when they do not match the domain.

A lifecycle parent may naturally contain catalog, transition, generation, and reconciliation children. A protocol endpoint may naturally contain framing, containment, execution, and transfer children. A provider adapter may have a completely different internal shape because its concrete platform has different invariants.

The outside world should normally continue to address the parent LEGO. Internal children do not become application-wide services merely because they were extracted.

### Nested topology follows the same rules

The parent/composition layer may know which children are currently connected. A child should not know another child exists merely because the parent wires them together.

For example, a parent may compose:

```text
Persistent Environments
  -> catalog
  -> lifecycle guard
  -> generation transition
  -> reconciliation
```

but the generation child should consume its own local record/operation contract rather than importing or naming the catalog implementation or reconciliation implementation.

Nested LEGO structure is recursive. If one child later grows into a substantial domain, it may itself become a parent collection of smaller LEGOs.

### Agent-attention boundary

A useful reason to introduce nesting is when one implementation surface contains enough independent state machines, effects, recovery paths, or local concepts that an agent cannot reliably complete a bounded task while retaining all relevant obligations in active attention.

File size is only a warning signal. A large cohesive piece may remain one piece. A smaller file with several unrelated authorities may need restructuring.

Ask:

> **Can an agent work inside this piece, understand its local contract and invariants, complete the task, and know what must remain true without loading the entire parent domain?**

If not, look for real nested ownership seams before expanding the parent further.

### Preserve the parent when nesting

Internal restructuring should preserve, wherever practical:

- the parent responsibility and authority;
- caller-facing studs/contracts;
- externally durable protocols and state identity;
- security and recovery semantics;
- externally visible behavior.

Do not dismantle one healthy parent LEGO into several unrelated public services merely to make files smaller. Do not hide behavior changes inside structural extraction.

See [`nested-lego-restructuring.md`](nested-lego-restructuring.md) for the current restructuring program and target-selection method.

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

For a large parent LEGO, this rule applies recursively: the parent may know which nested children it wires, while the children should remain unaware of sibling topology.

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

The same rule applies during nested restructuring. Do not create a shared helper merely because two children currently need similar code. Extract another nested LEGO only when that behavior has a real local contract and ownership boundary.

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
- exercise a nested child through a local fake/contract without constructing unrelated siblings;
- retain parent-level tests proving the nested collection still satisfies the original parent contract.

## Review checklist

For every meaningful code change, reviewers/agents should ask:

- [ ] Does each changed module own every concrete concept it names?
- [ ] Are interface names local and topology-agnostic?
- [ ] Could the current connected module be replaced without editing this module?
- [ ] Are provider/model/GitHub/repository specifics terminated at their adapter boundary?
- [ ] Did any foreign type/object/path cross into generic logic?
- [ ] Did a helper merely move the leak instead of removing it?
- [ ] Is topology expressed in composition rather than business logic?
- [ ] For a large parent, are nested responsibilities separated where agent reasoning would otherwise span independent state/effect domains?
- [ ] Did restructuring preserve the parent authority/public studs rather than exposing children broadly?
- [ ] Does the test prove the contract with a replaceable fake/alternate implementation where useful?

If these answers are not clear, stop expanding the feature and repair the connection stud first.

## Relationship to SOLID, CUPID, and KISS

This LEGO contract complements the other design rules:

- **SOLID** defines responsibility and dependency direction;
- **CUPID** encourages composable, predictable, domain-based behavior;
- **KISS** keeps the connection mechanism as small as possible;
- **LEGO** prevents the connected components from learning each other's identities.

A design can have small classes and dependency injection and still violate LEGO if its names/types encode current topology.

A design can also have a large parent directory and still satisfy LEGO when the parent is a coherent domain composed from bounded nested pieces.

That naming-level and ownership-level discipline is intentional: boundary leaks usually begin as convenient vocabulary or oversized reasoning surfaces long before they become obvious hard dependencies.
