# DB-HO104 — historical permanent-entry component verification

Status: correction prepared and focused-qualified from exact Stage 8 baseline `ecb6edf73e48e6a620824b5f95be6d25b4ae012a`; full hosted PR qualification and a new physical canonical-home retry remain required.

## Physical symptom

A supported exact-subject bootstrap into the preserved canonical Windows home `C:\Users\josho\.devbridge` exited before setup with:

`Recognized primary file does not reference an accepted subject.`

The prior #362 experimental-entry ownership-composition defect did not recur. The failure occurred while the permanent-entry installer inspected the already-installed generated primary wrapper and its retained component.

## Root cause

The recognized primary referenced exact installed subject `b535a5d2ce04a420ac3e0f559be712009747c8e2`. That generation's permanent-entry manifest was produced under the then-current 14-file component closure. Later runner-cache ownership/runtime bricks expanded the installed permanent-entry closure to 26 files.

Current reference acceptance reused the current component store to validate both newly installed components and historical primary/previous references. Consequently, an intact historical component that exactly satisfies its accepted 14-file generation contract fails the later 26-file membership check and cannot be adopted during an in-place upgrade.

## Correction boundary

New/current installation verification remains unchanged and bound to `INSTALLED_COMPONENT_FILES`.

Only primary/previous wrapper reference acceptance gains a closed compatibility verifier for the exact historical 14-file membership. The historical set is fixed in trusted installer source; no manifest-supplied or arbitrary subset becomes authority. Unknown intermediate membership remains rejected.

This preserves the receipt-backed publication owner's invariant: a recognized generated wrapper may be adopted only when its exact referenced retained component verifies under either the current closure or one explicitly admitted historical closure.

## Regression evidence

The focused installer regression constructs disposable installation fixtures and proves both sides of the boundary:

- exact historical 14-file membership can advance to a current component while the historical component remains retained and becomes the generated previous authority;
- an unknown 15-file membership (historical set plus one later runner-cache file) is rejected with the original fail-closed diagnostic, and the existing primary remains active.

Hosted preparation evidence before PR creation:

- standalone artifacts regenerated from modular source;
- `node --test test/self-install-entry.test.js`: 15/15 passed;
- bounded repository preflight: 253 syntax files, 2 JSON files, 203 targeted tests, passed;
- `git diff --check`: passed.

## Remaining gates

1. Review the PR net diff against exact Stage 8 baseline.
2. Require full hosted Windows and Ubuntu full/smoke CI on the exact PR head.
3. Integrate as one squash commit so temporary hosted-construction workflow history is not carried into Stage 8.
4. Require fresh full Windows/Ubuntu CI on the exact integrated Stage 8 head.
5. Retry the supported exact-subject bootstrap from ordinary non-elevated PowerShell against `C:\Users\josho\.devbridge`.
6. Stop at the next independently classified setup/protected-authority result.

No manual canonical-home mutation, PATH/service/ACL change, image/VM construction, repository execution, or GPU/CUDA work is authorized by this correction.
