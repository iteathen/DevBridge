# Permanent entry architecture

Status: architecture and experimental-source slices in progress for #159.

The target entry path is:

```text
Permanent Entry -> Bootstrap Runner -> Accepted Runtime
```

This is intentionally different from continuously expanding the host-installed `devbridge.mjs` Stage-0 launcher. The permanent component should stop changing for ordinary bootstrap/runtime evolution. Its local responsibility is only:

```text
local selector -> exact verified runner subject -> verified prepared runner -> argv handoff
```

The installed entry path has not changed yet. Current `devbridge.mjs` remains authoritative until stable release authority, accepted-runner state, composition/cutover, and Windows/Linux qualification are complete.

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

It does not know Git commands, GitHub URLs, filesystem cache paths, signing keys, VM providers, repository tasks, model adapters, guest bridge paths, publication, GitHub queues, runtime activation journals, or supervisor internals.

### Experimental subject authority

`src/entry/experimental-subject-authority.mjs` owns only the development/testing subject policy. It accepts only local `ref` or exact selectors. A named selector is resolved exactly once through its injected fixed-source port, and only the resulting exact 40-hex commit is used to read runner bytes.

The resulting `devbridge/entry-runner-subject-v1` contains:

- the exact immutable commit;
- SHA-256 of the exact runner artifact bytes;
- permanent-entry protocol requirement `1` for the current development contract;
- the explicit `experimental` channel identity;
- an immutable development release identity derived from the exact commit.

The moving branch/ref name is deliberately absent from the returned subject. Exact selectors bypass mutable ref resolution entirely but still require exact artifact bytes from the fixed source.

This adapter does not implement stable production release authority. Stable subjects require separate signed immutable release evidence and must not inherit development trust rules.

### Fixed source adapter

`src/entry/github-runner-source.mjs` is provider-local and owns the current fixed DevBridge GitHub source for experimental qualification.

It:

- hard-binds source authority to `iteathen/DevBridge`;
- accepts only bounded safe Git ref syntax;
- rejects traversal/ref-control forms such as `..`, `@{`, option-shaped selectors, and `.lock` suffixes;
- resolves a named selector through the fixed repository to one exact commit;
- reads `devbridge.mjs` only by that exact commit;
- rejects redirects rather than following source authority elsewhere;
- accepts only a bounded base64 file record for the fixed runner path.

Source URLs, repository identity, and transport mechanics stop at this adapter. They do not enter the permanent-entry core or runner subject contract.

### Content-addressed runner provider

`src/entry/content-addressed-runner-provider.mjs` owns exact runner object materialization and launch capability creation behind the core `runnerProvider.prepare(subject)` stud.

For the current slice it:

- derives the object identity only from the subject SHA-256;
- reuses an existing object only after hashing its exact bytes;
- refuses to launch corrupt, oversized, symlinked, or non-file cache entries;
- re-fetches by exact subject head when an object is absent/corrupt;
- rejects fetched bytes whose SHA-256 differs from the exact subject;
- publishes a verified object through a temporary file plus exclusive hard-link commit;
- exposes launch only after the committed object re-verifies;
- accepts only closed string argv at the launch boundary.

Physical cache paths are constructor-local authority. They never enter the permanent-entry core contract or remote task data.

This slice does **not** yet define accepted stable/ref pointers or last-known-good fallback. Those are a separate state-ownership layer over verified content-addressed objects.

## Selector semantics

The parser deliberately preserves current runner CLI behavior during migration:

- no entry selector -> stable runner selection;
- `--ref <name>` and `--branch <name>` are entry-local selectors and are consumed before runner handoff;
- `--ref <40-hex-commit>` becomes an exact immutable selector;
- `--channel stable` explicitly selects the stable runner and is also forwarded because `stable` is already meaningful to the existing bootstrap/runtime channel;
- other channel values, such as the existing `--channel testing`, remain runner arguments and do not alter the default stable runner selection.

Only one permanent-entry selector is accepted. Conflicting local selectors fail closed instead of guessing precedence.

This split avoids making the permanent-entry layer steal the existing runtime `--channel testing` control while still supporting the #159 stable selector surface.

## Exact runner subject

The core defines `devbridge/entry-runner-subject-v1` with these fields:

- `head`: exact 40-hex immutable commit;
- `sha256`: exact 64-hex runner artifact digest;
- `minimumEntryProtocol`: minimum host permanent-entry protocol;
- `channel`: bounded channel identity;
- `releaseId`: bounded release/development subject identity.

Signature material, source transport data, cache paths, and other adapter-private evidence do not leak into this core subject.

The exact subject is runner identity. It is distinct from:

- installation identity (`DB-<12 hex>`), which remains stable for one installation;
- accepted runtime identity, which belongs to the bootstrap/supervisor layer;
- a mutable branch/ref name, which is only a local selector before exact resolution.

## Stable and experimental state separation

Experimental selection must never overwrite stable last-known-good authority.

The current implementation already separates experimental subject policy from stable authority and stores verified objects by content digest rather than channel name. The next accepted-state layer must therefore keep at least two distinct namespaces:

- stable accepted/LKG subject state, updated only after signed stable verification;
- experimental accepted/ref state, updated only after exact development subject verification.

Shared immutable content objects are allowed when their exact digest is identical. Mutable accepted pointers/state are not shared across those authority classes.

## Failure behavior

The permanent entry fails closed when:

- selectors conflict or are malformed;
- the subject authority cannot produce one exact authorized runner subject;
- the subject needs a newer permanent-entry protocol;
- exact source resolution or artifact retrieval fails;
- fetched or cached bytes do not match the exact subject;
- the runner provider cannot commit/reverify a content-addressed object;
- prepared bytes identify a different subject;
- stable refresh is ambiguous and no policy-authorized last-known-good subject is available.

A failed refresh must not erase an already verified last-known-good runner.

## Relationship to #157

The #153 migration canary intentionally keeps its legacy fixture machinery on `fix/157-controller-owned-fixture`; former PR #164 is closed without merge.

That means the physical canary must eventually run an explicitly selected temporary DevBridge control-plane runner rather than adding compatibility-only input authority to stable `main`. #159's local experimental `--ref`/exact selection is the intended permanent boundary for that qualification.

The current #159 slices prove exact selection, exact artifact identity, and verified content-addressed materialization. They do not yet change the installed entry path or execute the full selected control-plane package, so #157 remains paused until that composition/cutover slice is qualified.

## Adoption sequence

Remaining work should continue by ownership boundary rather than growing the core:

1. **Implemented for experimental use:** fixed-source named-ref -> exact commit resolution and exact runner artifact SHA-256 subject creation.
2. **Implemented object layer:** content-addressed runner object materialization with exact digest verification and corruption recovery.
3. Implement signed stable subject authority and immutable release evidence.
4. Implement atomic stable/ref accepted-subject state, with stable LKG fallback and experimental state isolation.
5. Add bounded status projection showing installation tag plus exact selected runner subject.
6. Add the deliberately small host entry composition/executable and full selected-runner handoff.
7. Move evolving bootstrap behavior behind the runner boundary so current Stage-0 logic is no longer the permanently installed component.
8. Qualify stable, exact-ref, moving-branch, corruption, signature/digest failure, cache fallback, interruption recovery, protocol incompatibility, and #157 temp-runner selection on Windows and Linux.
9. Only then change installation/update docs and the installed entry path.

No step may reintroduce repository-code/model-controlled host execution or allow remote content to choose runner source, selector, signing policy, cache authority, or verification mode.

## Related contracts

- #159 — permanent entry shim and stable/experimental runner selection.
- #157 — temporary #153 compatibility canary that will consume the explicit experimental runner path.
- #153 — evidence for why an evolving permanent launcher can deadlock itself across compatibility generations.
- DB-011 — accepted runtime supervision and release integrity after runner handoff.
- DB-019 — verification/evidence/timing policy.
- DB-020 — repository/candidate execution isolation; unrelated to runner selection authority and never a fallback for the host entry boundary.
- `docs/bootstrap.md` — current Stage-0 behavior during the transition.
- `docs/bootstrap-compatibility.md` — current compatibility bridge for already-installed Stage-0 systems.
- `docs/lego-module-contract.md` — module ownership and topology rules used by this split.
