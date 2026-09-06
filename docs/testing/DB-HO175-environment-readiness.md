# HO175 — environment readiness requires implementation identity

## Assessment and ownership

The Hello World issue audit found that `environmentObservationCondition` could
return `healthy` for a present environment with all ready health fields but a
null implementation generation. The construction observation adapter deliberately
returns an incomplete base observation without querying preparation/workspaces
when that identity is absent. Its readiness consumer then trusted the classifier
and returned `ready: true` with no generation.

DB-020 requires exact environment identity and observed readiness; #170 owns the
neutral observation contract. This is an internal classification defect, not
evidence of a native provider or installer defect. Review covered the existing
declaration/journal, construction/readiness, create, diagnosis and recreate
consumers. The construction pipeline also checks generation equality separately;
that defense does not repair the classifier's incorrect public result.

## Correction and qualification

Keep partial observations representable. The existing classifier now returns
`incomplete-observation` when an otherwise healthy observation lacks its
implementation generation. Preserve more specific known failure diagnoses,
including missing storage and an unavailable provider. No schema, persistence,
adapter, provider operation or second readiness owner is introduced.

Two permanent regressions failed first on integrated baseline `ca433fc4383d8ee31bc3243965ae9b687c8f090d`:
the pure classifier returned healthy, and the real construction readiness
consumer failed to reject the unidentified implementation. Baseline run: 7 pass,
2 fail. After correction, 43 focused tests pass under Node 22.16.0, including
declaration/observation, construction/create, diagnosis/recreate, lifecycle journal
and persistence, and the neutral lifecycle LEGO boundary. Existing valid ready
observations still pass; null and omitted identity remain unready.

Preflight and exact-head Windows/Ubuntu CI are recorded on the review PR. This
change does not complete #170's entire lifecycle program, establish a native
environment or solve #493's early installer transport. The retained VM and its
original failed installation/basis evidence remain unchanged.
