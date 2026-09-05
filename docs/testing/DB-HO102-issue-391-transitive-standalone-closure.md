# DB-HO102 — Transitive standalone module closure before receipt composition

Date: 2026-08-30

Parent work: Stage 8 #116 and application removal #391.

Coordinates with: #159, #391, DB-003, DB-009, DB-011, DB-020, DB-HO099, DB-HO100, and DB-HO101.

## Scope and safety boundary

This checkpoint owns one packaging prerequisite for composing the accepted neutral receipt and exact-artifact bricks into the standalone Permanent Entry installer. It may replace the standalone compiler's one-level child-module input with a closed transitive module-graph contract, update the filesystem build adapter, add graph-boundary tests, regenerate the two standalone artifacts, and update documentation.

It does not change the installer public contract, make installation asynchronous, create or adopt a production receipt, inspect or mutate the canonical installation, alter setup or selector policy, expose application removal, delete anything, request elevation, refresh protected services, mutate a provider/image/environment/VM/guest, execute repository code, invoke a model, or implement GPU/CUDA work.

## Assessment

`install-devbridge.mjs` and `bootstrap-devbridge.mjs` are generated standalone entry stages. Their modular sources import narrowly owned child modules, while `src/bootstrap/standalone-artifact.mjs` currently permits only one local import level. The builder reads each direct child and replaces that import with a `data:text/javascript;base64,...` URL. It rejects a child containing another relative import.

That restriction happened to fit the original installer children because they import only Node built-ins. It no longer fits correct receipt composition. The accepted exact-artifact set imports the neutral local-filesystem identity brick, and future production composition should be free to depend on that intact module graph. Copying identity logic into an installer child, flattening unrelated owners into the installer, or creating an installer-specific artifact descriptor would duplicate safety-critical behavior and violate the LEGO dependency boundary merely to satisfy a packaging limitation.

The present compiler input is also not a truthful graph contract. It receives the entry source plus a flat list keyed only by each direct specifier. It cannot prove transitive closure, reject an unreferenced supplied source, distinguish a cycle from an unsupported import, or bind one shared dependency to one exact source identity.

The source filesystem belongs to the build adapter, not the compiler. A recursive compiler does not need arbitrary filesystem authority: it needs one logical entry identity, exact source bytes, and a narrow resolver that returns the exact logical identity and bytes for a requested relative edge. The adapter remains responsible for resolving those identities beneath the repository source root.

## Primary-source research

- Node.js 22.16.0 documents that ES modules resolve and cache as URLs. It supports `file:`, `node:`, and `data:` URLs, but `data:` modules cannot resolve relative specifiers because `data:` is not a special URL scheme. Therefore every relative edge in every embedded module must be rewritten before the standalone artifact can execute; handling only the entry's direct edges is not a complete packaging contract: https://nodejs.org/download/release/v22.16.0/docs/api/esm.html#data-imports
- The same Node ESM contract requires explicit extensions on relative imports and applies standard relative URL semantics to relative and absolute specifiers. DevBridge can preserve source-authored explicit relative edges while giving the compiler only logical source identities; it does not need package resolution or host runtime search paths: https://nodejs.org/download/release/v22.16.0/docs/api/esm.html#import-specifiers
- Node documents that top-level `await` is supported in ES modules. Transitive `data:` encoding therefore does not require flattening asynchronous module behavior or changing an imported module's interface: https://nodejs.org/download/release/v22.16.0/docs/api/esm.html#top-level-await

## Reassessment and ownership boundary

Replace the flat one-level compiler contract rather than add an exception for receipt modules.

The compiler owns only a deterministic closed logical module graph:

- one bounded logical entry identity and exact entry bytes;
- literal Node built-in or already absolute `data:` imports, which remain unchanged;
- literal relative imports, resolved only through a supplied loader port;
- exact logical identity and exact bytes returned for every local edge;
- cycle, missing-edge, identity-conflict, unsupported-scheme/bare-import, and duplicate-edge rejection; and
- bottom-up replacement of every local edge with its exact compiled `data:` URL.

It does not receive a repository root, host path, filesystem API, install topology, artifact identity, receipt type, or runtime owner. The filesystem build adapter owns containment beneath the repository root, conversion between host paths and slash-separated logical identities, exact reads, and the two configured entry/target plans.

The graph must be acyclic. A cyclic source graph cannot be encoded by recursively nesting complete `data:` URLs without a different linking mechanism, and silently leaving a relative edge would produce a broken artifact. Rejecting the unsupported graph is the smallest truthful behavior.

No compatibility overload for the old flat input remains. The builder and focused tests move together to the new contract so the repository does not accumulate a second packaging path.

## Primitive-to-high-level plan

1. Replace the flat `source` plus direct `modules` input with one entry record and a narrow local-edge loader.
2. Validate bounded slash-separated logical identities, exact non-empty source bytes, literal supported import classes, and deterministic edge resolution without host paths entering compiler logic.
3. Traverse and compile dependencies bottom-up, cache exact logical source identities, reject cycles and identity/byte conflicts, and rewrite every relative edge to a complete data URL.
4. Change the filesystem builder to resolve each requested edge beneath the repository source root, reject escape or non-file targets, and return only logical identity plus bytes.
5. Prove deterministic nested and shared dependency output plus missing, cyclic, escaping, bare/package, unsupported URL, conflicting identity, and duplicate-edge failures.
6. Regenerate both standalone artifacts and prove they contain no local imports, execute their help paths from copied/download-like locations, and remain reproducible under `--check`.
7. Run focused current and exact Node 22.16 tests, bounded preflight, architecture/product/standalone gates, the complete exact serialized suite, doctor, diff hygiene, and hosted Ubuntu/Windows qualification.
8. Document acceptance and keep #391 open. Only then make the installer asynchronous and compose the production ownership producer through the accepted journal and exact-artifact contracts.

## Acceptance

- [x] Every transitive local import is encoded; no generated standalone artifact retains a relative import.
- [x] The compiler receives no host path, repository, installer, receipt, artifact-owner, provider, VM, or guest identity.
- [x] The filesystem adapter rejects dependency escape and unsupported filesystem shape before reading bytes.
- [x] Missing, cyclic, conflicting, duplicate, bare/package, and unsupported-scheme graphs fail closed.
- [x] Nested/shared graph compilation is deterministic on current and exact Node 22.16.
- [x] Both generated entry stages remain directly executable and reproducible.
- [x] No installer API, production receipt/adoption, removal, setup/elevation, protected/provider/VM/guest, repository-code, model, or GPU/CUDA effect occurs.

## Implementation candidate and local qualification

The compiler now consumes only one logical entry record, one topology-free local-edge loader, and one bounded provenance line. It recursively compiles every relative edge bottom-up, reuses one exact logical identity for shared dependencies, and rejects cycles, byte conflicts, duplicate local specifiers, missing sources, extensionless relative edges, bare/package imports, and unsupported URL schemes. Module count, source bytes, compiled-module bytes, final artifact bytes, identities, and provenance are bounded. The old flat `source` plus direct `modules` contract was removed rather than retained as a compatibility path.

Filesystem ownership is isolated in `standalone-source-loader.mjs`. That adapter alone maps slash-separated logical identities beneath one canonical absolute root, walks every component without following links, requires intermediate directories and a final regular file, rejects escape and filesystem indirection, and returns only logical identity plus exact bytes. The graph compiler contains no imports and no repository, installer, receipt, provider, VM, guest, or host-path identity.

The real standalone builder now uses that adapter. Both generated entry stages are byte-identical to their accepted versions because their current graphs have only one level; regeneration and `--check` agree exactly. Tests execute a deterministic nested graph with a shared dependency and pin missing, cyclic, conflicting, duplicate, package/bare, unsupported-scheme, extensionless, root-escape, missing-file, directory-target, and link-indirection failures.

Final local evidence on the exact supported Node 22.16.0 runtime passes the focused graph tests 4/4, bounded preflight at 2 standalone artifacts / 232 syntax files / 2 JSON files / 190 targeted tests, the architecture/product/standalone gates at 37 total / 36 passed / one expected Windows symlink skip, and the complete serialized suite at 2,015 total / 1,994 passed / 21 expected skips / zero failures in 197.2 seconds. The same focused test and preflight pass on the current runtime. Exact doctor reports `ok: true`, execution disabled, repository execution unavailable with no configured persistent-environment route, repository-code operations unusable, and coding-model adapters disabled. Diff and standalone reproducibility hygiene pass.

Commit and push this isolated implementation candidate, then require all four hosted Ubuntu/Windows jobs plus doctor on its exact head before checking acceptance. No installer API, receipt, adoption, removal, setup/UAC, protected/provider/VM/guest mutation, repository execution, model invocation, or GPU/CUDA action occurred.

## Hosted acceptance

Exact implementation `f26982c0477276c1ee555bda9abea6647a8d7f79` passed Ubuntu smoke/full and Windows bounded-smoke/serialized-full, repository-execution architecture gates, standalone regression, and doctor in [run 33321350511](https://github.com/iteathen/DevBridge/actions/runs/33321350511). Accept this packaging prerequisite and proceed to asynchronous Permanent Entry installation plus production receipt composition through the intact accepted module boundaries. Keep #391 open; this acceptance creates no uninstall route or live removal authority.
