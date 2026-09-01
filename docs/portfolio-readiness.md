# Portfolio readiness and work-selection gate

This policy supplements `AGENTS.md` and the normative `specs/DB-*` contracts. Repository-specific accepted authority wins when it requires a stricter or differently ordered gate.

For meaningful work selection, planning, review, and closure, start with one question:

> What is the highest-risk unproven boundary currently preventing the next trustworthy composed capability?

## Default priority order

1. Security, correctness, authority-isolation, provenance, recovery, lease/fence, or containment defect.
2. Missing foundational control-plane, execution, provider, bridge, Git-authority, or lifecycle capability required by dependency-ready work.
3. Missing real-provider qualification, evidence, or qualification infrastructure for an implemented required capability.
4. Missing thin end-to-end proof through the real DevBridge control-plane/provider/public contracts.
5. Measured throughput, concurrency, latency, or resource bottleneck required by a real workload.
6. Convenience or API-surface expansion.
7. Community, adoption, or presentation polish.

The actual dependency graph and accepted DevBridge authority may reorder these classes. Issue age/count, specification count, commit volume, stars, forks, or watchers do not.

## Required distinctions

Architectural disposition, implementation status, qualification/support status, and priority are separate facts. Do not infer one from another.

A missing Hyper-V/KVM host, virtualization-capable runner, physical environment, external control-plane mutation, or other qualification substrate is an evidence/infrastructure gap unless the implementation is independently falsified. Do not manufacture a code fix for absent evidence. When a support or security claim depends on that infrastructure, the qualification path is product infrastructure with an owner, acceptance criteria, maintenance, and explicit dependency status.

Serialized admission, limited concurrency, or another theoretical scaling ceiling does not outrank unresolved trust, containment, dispatch-addressing, credential, publication, recovery, or authority defects merely because higher throughput is desirable. Promote concurrency or performance work when a real dependency-ready workload or measurement requires it.

## Specification and vertical-evidence rule

DevBridge requires unusually strong specifications because mistakes can grant execution, credential, Git, provider, or publication authority. Keep specifying when a real security/lifecycle boundary is undefined or the next executable step is not safely authorized.

Once a boundary is sufficiently specified, prefer the thinnest meaningful executable falsifier through the same production contracts over additional speculative layering. If existing abstractions remain materially unexercised, freeze architecture expansion and pressure-test them before adding more machinery.

A thin slice does not weaken security or LEGO ownership. It must preserve the host/guest trust boundary, provider abstraction, authoritative Git, bounded bridge, capability policy, failure/recovery semantics, and exact evidence required by the owning contracts.

## Public evidence rule

Public security and readiness prose must be at least as conservative as the evidence.

The README and other public entry points lead with:

1. what is executable now;
2. how to validate it now;
3. what is implemented but not fully qualified;
4. what security/readiness property is known missing;
5. architecture and roadmap links only after those facts.

Do not bury a material limitation after a broad security claim. Classify material properties as **enforced and qualified**, **implemented but not fully qualified**, **designed/proposed**, or **known missing**. Hosted regression CI cannot be worded as real Hyper-V/KVM security qualification.

Prefer a short current limit over prose defending why that limit is not an architectural ceiling. Architecture rationale belongs in the owning design/specification documents.

## Process and compatibility proportionality

New coordination, compatibility, migration, recovery, abstraction, or policy machinery must name a present beneficiary: an actual deployment, persisted state, security/recovery requirement, external contract, active consumer, or demonstrated high cost of changing later. Future possibility by itself does not justify production machinery.

Before 1.0, compatibility shims and migration layers require evidence of an external/deployed/persisted dependency or another concrete safety/recovery reason. If no such beneficiary exists, prefer a clean break and retain only concise provenance when it remains useful.

The same rule applies to distributed coordination and concurrency: implement the semantics required by the current trustworthy topology or measured workload, not a speculative future fleet.

## AI-assisted development accountability

DevBridge may use substantial AI-agent assistance, but AI output never becomes security or readiness evidence by generation or agreement alone.

- Treat model-generated code, prose, analysis, and model-to-model review as untrusted working material, not authority, an independent oracle, review evidence, or proof of correctness.
- The contributor or maintainer remains accountable for understanding the change and for every authority, security, recovery, provenance, compatibility, test, and qualification claim attached to it.
- Apply the same exact-head tests, adversarial evidence, provider qualification, provenance, cleanup, and independent-review gates regardless of how much of a change was agent-produced.
- Keep public AI disclosure brief and factual in `CONTRIBUTING.md`. Do not create defensive AI-process documents or treat model agreement as a substitute for required independent review.

## Cross-project and external dependency rule

Treat dependencies as explicit public capability edges. State the required contract and consumer acceptance criteria; leave implementation and qualification with the owning producer. Never couple to sibling internals or grant authority through a workaround.

If a downstream project exposes a DevBridge orchestration or qualification need, solve only the consumer-neutral DevBridge capability here. Product-specific CUDA, MCGS, tensor, chess, or other domain policy stays with its owner.

## Security review gate

Security assurance scales with authority. Before broad credential-bearing, multi-workstation, multi-user, publication-capable, elevated, or remote-execution deployment, require an explicit independent security review appropriate to the resulting authority surface in addition to internal adversarial evidence and exact provider qualification.

This does not block bounded private development; it limits deployment/readiness claims.

## PR and closure evidence

Every material PR or closure record states:

- the blocker class before the change;
- the authoritative owner and affected public/security boundary;
- the exact evidence supporting the transition;
- what remains unproven or environment-blocked;
- which downstream composed capability is newly unblocked;
- the present beneficiary for any new process/compatibility/coordination machinery;
- whether an independent security/review gate is triggered before broader deployment.
