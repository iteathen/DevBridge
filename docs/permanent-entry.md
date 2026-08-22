# Permanent entry architecture

Status: architecture plus experimental selection/handoff slices are implemented on #159; the installed entry path is not cut over yet.

The target entry path is:

```text
Permanent Entry -> Selected Bootstrap/Control Runner -> Accepted Runtime
```

This is intentionally different from continuously expanding the host-installed `devbridge.mjs` Stage-0 launcher. The permanent component should stop changing for ordinary bootstrap/runtime evolution. Its local responsibility is only:

```text
local selector -> exact verified runner subject -> verified prepared runner -> argv handoff
```

Current `devbridge.mjs` remains the installed authority until stable release authority, accepted-runner state, installed composition/cutover, and Windows/Linux qualification are complete.

## Ownership boundaries

### Permanent-entry core

`src/entry/permanent-entry.mjs` owns only:

- parsing local runner selectors;
- defaulting ordinary entry selection to `stable`;
- distinguishing exact immutable commits from named ref selectors;
- requiring one exact runner subject with head, SHA-256, release identity, channel identity, and minimum entry protocol;
- rejecting subjects that need a newer entry protocol;
- requiring the prepared runner to retain the exact resolved subject;
- forwarding runner argv only after those invariants hold.

It does not know Git commands, GitHub URLs, cache paths, signing keys, VMs, repository tasks, model adapters, guest bridge paths, publication, runtime activation journals, or supervisor internals.

### Experimental subject authority

`src/entry/experimental-subject-authority.mjs` owns development/testing subject policy only. It accepts local `ref` or `exact` selectors.

A named ref is resolved exactly once. Only the resulting exact 40-hex commit is used afterward. Exact selectors bypass mutable ref resolution entirely.

The returned `devbridge/entry-runner-subject-v1` binds:

- exact commit;
- SHA-256 of the exact `devbridge.mjs` runner artifact;
- entry protocol requirement;
- `experimental` channel identity;
- immutable development release identity derived from the exact commit.

The moving branch/ref name is deliberately absent from the subject.

This adapter cannot create stable production authority. Stable subjects require separate signed immutable release evidence.

### Fixed experimental source

`src/entry/github-runner-source.mjs` owns the current fixed DevBridge GitHub source used for experimental qualification.

It:

- hard-binds source authority to `iteathen/DevBridge`;
- accepts only bounded safe ref syntax;
- rejects traversal/ref-control/option-shaped selectors;
- resolves a named selector to one exact commit;
- reads `devbridge.mjs` only by that exact commit;
- rejects redirects;
- accepts only a bounded base64 file record for the fixed runner path.

Source URLs and transport mechanics stop at this adapter. They do not enter the permanent-entry core contract.

### Content-addressed standalone runner objects

`src/entry/content-addressed-runner-provider.mjs` owns exact standalone runner-object materialization behind `runnerProvider.prepare(subject)`.

It:

- derives object identity only from subject SHA-256;
- reuses an object only after re-hashing exact bytes;
- refuses corrupt, oversized, symlinked, or non-file objects;
- re-fetches an absent/corrupt object by exact subject head;
- rejects fetched bytes whose SHA-256 differs from the subject;
- publishes complete verified bytes before exposing launch authority;
- accepts only closed string argv.

This object layer does not define accepted stable/ref pointers or LKG policy.

### Experimental exact-checkout runner

`src/entry/experimental-checkout-runner-provider.mjs` provides the full selected DevBridge control-plane handoff needed for development/testing branches.

It accepts only `experimental` subjects and therefore cannot become stable runner authority accidentally.

For an exact subject it:

1. creates a private temporary Git checkout under a local cache root;
2. binds `origin` to the fixed DevBridge repository;
3. fetches only the already-resolved exact commit;
4. checks out that exact commit detached;
5. verifies exact `HEAD`;
6. requires a clean tree;
7. verifies the checkout's `devbridge.mjs` SHA-256 against the independently resolved subject;
8. requires the selected control-plane entry `src/cli.js` to be a contained real regular file;
9. atomically publishes the complete checkout under exact subject identity;
10. repeats HEAD, cleanliness, and artifact-digest verification before every launch;
11. launches the selected tree's normal `src/cli.js` only after those checks pass.

Git acquisition uses a synthetic Git home and credential-free, prompt-free environment. The selected DevBridge control plane is different: it receives the normal host application environment so existing GitHub/configuration credentials continue to work. Git transport authority is therefore not confused with control-plane application authority.

The checkout provider uses the exact Git commit plus the independently verified `devbridge.mjs` SHA-256 as experimental identity evidence. It is deliberately not the stable production trust policy.

### Explicit experimental composition

`src/entry/experimental-entry.mjs` composes the experimental path without changing the installed entry.

It:

- requires one explicit `--ref` or `--branch` selector;
- refuses implicit/default stable selection;
- consumes only that entry-local selector;
- uses the fixed experimental subject authority;
- uses the exact-checkout provider;
- forwards remaining argv unchanged to the selected tree's `src/cli.js`;
- keeps the cache root local and platform-specific.

For example, the intended shape is:

```text
experimental-entry --ref <development-ref> run-once --config <local-config> ...
```

The ref is local selection input only. The selected runner receives no mutable ref name; it runs from the exact verified commit.

## Selector semantics

The core parser preserves current downstream CLI behavior:

- no selector -> stable selection;
- `--ref <name>` / `--branch <name>` -> entry-local selector consumed before runner handoff;
- a 40-hex ref -> exact immutable selector;
- `--channel stable` -> stable entry selection and is also forwarded because `stable` remains meaningful downstream;
- other channel values such as `--channel testing` remain downstream runner arguments and do not become permanent-entry selectors.

Only one entry selector is accepted. Conflicting selectors fail closed.

The explicit experimental composition is stricter than the core: it refuses the default/stable path and requires `--ref`/`--branch` because stable trust is not implemented there.

## Exact runner subject

`devbridge/entry-runner-subject-v1` contains:

- `head`: exact 40-hex immutable commit;
- `sha256`: exact 64-hex runner artifact digest;
- `minimumEntryProtocol`: minimum host entry protocol;
- `channel`: bounded channel identity;
- `releaseId`: bounded release/development identity.

Signature material, source transport data, cache paths, and adapter-private evidence do not leak into this core subject.

Runner identity is distinct from installation identity, accepted runtime identity, and mutable branch/ref names.

## Stable and experimental state separation

Experimental selection must never overwrite stable last-known-good authority.

Current code already separates experimental subject/checkout policy from stable authority and the exact-checkout provider rejects non-experimental subjects. The future accepted-state layer must retain separate namespaces for:

- stable accepted/LKG subject state, updated only after signed stable verification;
- experimental accepted/ref state, updated only after exact development verification.

Immutable content may be shared only when exact identity matches. Mutable accepted pointers/state must not be shared across authority classes.

## Failure behavior

The entry path fails closed when:

- selectors conflict or are malformed;
- experimental composition lacks an explicit ref/exact selector;
- subject authority cannot produce one exact authorized subject;
- the subject needs a newer entry protocol;
- ref resolution or artifact retrieval fails;
- fetched/cached bytes do not match the subject;
- the exact checkout resolves a different HEAD;
- the checkout is dirty or its entry/artifact shape is unsafe;
- checkout publication cannot be completed/reverified;
- prepared subject identity changes after exact resolution;
- stable refresh is ambiguous and no policy-authorized stable LKG exists.

A failed future stable refresh must not erase a previously verified stable LKG.

## Relationship to #157

The #153 migration canary intentionally keeps compatibility-only fixture machinery on:

```text
fix/157-controller-owned-fixture
```

Former PR #164 is closed without merge. That machinery must not be moved onto stable `main` merely to run the canary.

#159 now contains the generic development mechanism needed to select that temporary DevBridge control-plane branch: explicit ref -> exact subject -> exact checkout -> verified full-tree `src/cli.js` handoff.

What remains is deployment authority, not a legacy architecture gap. The currently installed stable entry does not yet contain/call this permanent-entry composition, so the physical poller cannot automatically switch itself to the temp branch. After the installed-entry boundary is qualified, #157 can select the temp branch explicitly and resume its controller-owned offline fixture canary without adding legacy support to stable composition.

## Adoption sequence

Work should continue by ownership boundary:

1. **Implemented:** permanent-entry selector/subject core.
2. **Implemented:** fixed-source experimental ref -> exact commit resolution and artifact SHA-256 subject creation.
3. **Implemented:** verified content-addressed standalone runner objects.
4. **Implemented:** development-only exact Git checkout and full selected control-plane handoff.
5. **Implemented but not installed:** explicit experimental entry composition.
6. Implement signed stable subject authority and immutable release evidence.
7. Implement atomic stable/ref accepted-subject state with stable LKG fallback and experimental-state isolation.
8. Add bounded status projection showing installation tag plus exact selected runner subject.
9. Build/qualify the deliberately small installed host entry and migrate installation to it.
10. Qualify stable, exact-ref, moving-ref, corruption, signature/digest failure, offline/cache fallback, interruption recovery, protocol incompatibility, and #157 temp-runner selection on Windows and Linux.
11. Only then retire the evolving current Stage-0 installation role and update installation/update documentation.

No step may reintroduce repository-code/model-controlled host execution or allow remote task content to choose runner source, selector, signing policy, cache authority, or verification mode.

## Related contracts

- #159 — permanent entry shim and stable/experimental runner selection.
- #157 — temporary #153 compatibility canary consuming explicit experimental runner selection after entry deployment.
- #153 — evidence for why an evolving permanent launcher can deadlock itself across compatibility generations.
- DB-011 — accepted runtime supervision/release integrity after runner handoff.
- DB-019 — verification/evidence/timing policy.
- DB-020 — repository/candidate execution isolation; never a fallback for host entry authority.
- `docs/bootstrap.md` — current Stage-0 behavior during transition.
- `docs/bootstrap-compatibility.md` — current compatibility bridge for already-installed Stage-0 systems.
- `docs/lego-module-contract.md` — ownership/topology rules used by this split.
