# Permanent entry architecture

Status: architecture slice in progress for #159.

The target entry path is:

```text
Permanent Entry -> Bootstrap Runner -> Accepted Runtime
```

This is intentionally different from continuously expanding the host-installed `devbridge.mjs` Stage-0 launcher. The permanent component should stop changing for ordinary bootstrap/runtime evolution. Its local responsibility is only:

```text
local selector -> exact verified runner subject -> verified prepared runner -> argv handoff
```

The first implementation slice introduces that neutral contract without changing the installed entry path yet. Current `devbridge.mjs` remains authoritative until the source/cache/release adapters and installation transition are complete and qualified on Windows and Linux.

## Ownership boundaries

### Permanent-entry core

`src/entry/permanent-entry.mjs` owns only:

- parsing local runner selectors;
- defaulting runner selection to `stable`;
- distinguishing an exact immutable commit from a named ref selector;
- requiring one exact runner subject with head, SHA-256, release identity, channel identity, and minimum permanent-entry protocol;
- rejecting a subject that requires a newer permanent-entry protocol;
- requiring the prepared runner to retain the exact resolved subject;
- forwarding runner argv only after those invariants hold.

It does not know Git commands, filesystem cache paths, signing keys, VM providers, repository tasks, model adapters, guest bridge paths, publication, GitHub queues, runtime activation journals, or supervisor internals.

### Subject authority adapter

The future subject-authority adapter owns the fixed trusted DevBridge source and verification policy. Its `resolve(selector)` contract must return one already-authorized exact runner subject.

For `stable`, that means resolving a trusted immutable runner release/manifest that binds at least:

- exact runner Git head or equivalent immutable artifact identity;
- exact runner artifact SHA-256;
- runner release identity;
- stable channel identity;
- minimum permanent-entry protocol;
- production signature/evidence required by release policy.

A mutable branch must never be returned as runner identity. For a local experimental ref/branch selector, the adapter resolves the name once through the fixed trusted source to an exact immutable commit, applies the explicitly local development verification policy, and returns the resulting exact subject.

Remote task text, repository content, issue comments, model output, and guest code do not participate in this selector/authority API.

### Runner provider adapter

The future runner-provider adapter owns materialization, content-addressed cache state, exact byte verification, last-known-good channel acceptance, and process launch. Its `prepare(subject)` result must identify the same exact subject and expose a bounded launch capability; the core rejects a prepared subject substitution before launch.

The provider must eventually enforce:

- cache content keyed by exact immutable identity/digest;
- SHA-256 verification of materialized runner bytes before launch;
- atomic accepted-runner updates only after complete verification;
- stable last-known-good retention across refresh/network failure when policy permits;
- separate experimental-ref cache/acceptance state that cannot overwrite stable last-known-good state;
- reconciliation of ambiguous/interrupted cache acceptance rather than blind overwrite;
- no mutable branch bytes executed directly from transport.

Physical paths are owned by this adapter. They do not enter the permanent-entry core contract.

## Selector semantics

The initial parser deliberately preserves current runner CLI behavior during migration:

- no entry selector -> stable runner selection;
- `--ref <name>` and `--branch <name>` are entry-local selectors and are consumed before runner handoff;
- `--ref <40-hex-commit>` becomes an exact immutable selector;
- `--channel stable` explicitly selects the stable runner and is also forwarded because `stable` is already meaningful to the existing bootstrap/runtime channel;
- other channel values, such as the existing `--channel testing`, remain runner arguments and do not alter the default stable runner selection.

Only one permanent-entry selector is accepted. Conflicting local selectors fail closed instead of guessing precedence.

This split avoids making the permanent-entry layer steal the existing runtime `--channel testing` control while still supporting the #159 stable selector surface.

## Exact runner subject

The architecture slice defines `devbridge/entry-runner-subject-v1` with these core-owned fields:

- `head`: exact 40-hex immutable commit;
- `sha256`: exact 64-hex runner artifact digest;
- `minimumEntryProtocol`: minimum host permanent-entry protocol;
- `channel`: bounded channel identity;
- `releaseId`: bounded release/development subject identity.

Signature material, Git transport data, cache paths, and other adapter-private evidence do not leak into this core subject.

The exact subject is runner identity. It is distinct from:

- installation identity (`DB-<12 hex>`), which remains stable for one installation;
- accepted runtime identity, which belongs to the bootstrap/supervisor layer;
- a mutable branch/ref name, which is only a local selector before exact resolution.

## Failure behavior

The permanent entry must fail closed when:

- selectors conflict or are malformed;
- the subject authority cannot produce one exact authorized runner subject;
- the subject needs a newer permanent-entry protocol;
- the runner provider cannot materialize/verify the subject;
- prepared bytes identify a different subject;
- stable refresh is ambiguous and no policy-authorized last-known-good subject is available.

A failed refresh must not erase an already verified last-known-good runner.

## Adoption sequence

The remaining #159 work should proceed by ownership boundary rather than growing the core:

1. implement the fixed-source subject-authority adapter, including stable signed subject verification and exact experimental-ref resolution;
2. implement the content-addressed runner provider with atomic stable/ref acceptance state and offline last-known-good behavior;
3. add bounded status projection showing installation tag plus exact selected runner subject;
4. add a deliberately small host entry executable that composes only these entry-owned modules and hands off to the selected runner;
5. move evolving bootstrap behavior behind the runner boundary so current Stage-0 logic is no longer the permanently installed component;
6. qualify stable, exact-ref, moving-branch, corruption, signature/digest failure, cache fallback, interruption recovery, and protocol incompatibility on Windows and Linux;
7. only then change installation/update docs and the installed entry path.

No step may reintroduce repository-code/model-controlled host execution or allow remote content to choose runner source, selector, signing policy, cache authority, or verification mode.

## Related contracts

- #159 — permanent entry shim and stable/experimental runner selection.
- #153 — evidence for why an evolving permanent launcher can deadlock itself across compatibility generations.
- DB-011 — accepted runtime supervision and release integrity after runner handoff.
- DB-019 — verification/evidence/timing policy.
- DB-020 — repository/candidate execution isolation; unrelated to runner selection authority and never a fallback for the host entry boundary.
- `docs/bootstrap.md` — current Stage-0 behavior during the transition.
- `docs/bootstrap-compatibility.md` — current compatibility bridge for already-installed Stage-0 systems.
- `docs/lego-module-contract.md` — module ownership and topology rules used by this split.
