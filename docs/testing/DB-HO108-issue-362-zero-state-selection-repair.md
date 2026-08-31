# DB-HO108 — issue #362 zero-state selection repair

Status: assessed and planned from exact Stage 8 head `8147edea716c8f4f9b15d253a25939ed02e5c4cb` after the physical canonical-home retry stopped at the durable bootstrap-selection gate. Implementation and hosted qualification evidence will be appended without rewriting this record.

## Physical evidence

One ordinary non-elevated Windows invocation requested exact subject `8147edea716c8f4f9b15d253a25939ed02e5c4cb` and exact canonical home `C:\Users\josho\.devbridge`. It failed before setup or UAC with:

```text
Recovery is already bound to ecb6edf73e48e6a620824b5f95be6d25b4ae012a at ecb6edf73e48e6a620824b5f95be6d25b4ae012a; resume that selection before starting another subject.
```

Read-only reconciliation proved:

- `bootstrap/selection.json` is a valid `devbridge/zero-state-bootstrap-v1` exact selection for `ecb6edf73e48e6a620824b5f95be6d25b4ae012a`;
- the exact selected component directory and installer ownership receipts exist;
- the recognized primary remains historical component `b535a5d2ce04a420ac3e0f559be712009747c8e2`;
- the protected lifecycle service remains running under the same virtual service identity and `c0183b...` generation;
- no setup continuation, UAC, PATH/service/ACL/provider/image/VM/guest/GPU effect, manual journal edit, or deletion occurred.

## Assessment

The selection guard is correct: a moving or different selector must not replace an interrupted exact subject. Its commit-before-clear ordering is also correct. The deadlock is that argument-equivalent replay loads installer mechanics from the selected subject itself. Here that exact `ecb6edf...` installer rejects the intact historical primary under the later component closure, while #406's independently qualified correction exists only at `8147ede...`. The correction therefore cannot reach the installation it must repair.

Deleting or rewriting the selection would lose the exact recovery subject and weaken the first-writer contract. Allowing a different subject to replace it would confuse installer code identity with component identity and could abandon partially committed effects.

No unstable external platform behavior is involved. The failure is entirely inside DevBridge's local exact-subject selection and permanent-entry commit protocol, so no Hyper-V, Windows service, filesystem, Git, or network behavior needs a new external compatibility assumption.

## Selected design

Add one explicit local option:

```text
--repair-selection-with <EXACT_INSTALLER_HEAD>
```

The repair contract is closed:

1. `--install-only` is mandatory; repair cannot continue into setup or elevation.
2. The repair head must be exact 40-hex input; a moving ref is rejected.
3. A valid durable selection must already exist.
4. The ordinary `--ref`/`--branch` selector must still match that existing selection exactly.
5. The existing selection remains the component subject and supplies every installed component byte.
6. Only the installer stage and exact-source helper are fetched from the repair head.
7. The installer result must report the exact selected component as committed before the selection can clear.
8. Any fetch, preparation, installation, subject, or commit mismatch retains the old selection.
9. Selecting a newer component remains a separate ordinary bootstrap after repair succeeds.

## LEGO boundary

- Input contract owns exact option syntax and the install-only gate.
- Selection state retains first-writer subject identity and commit-before-clear behavior unchanged.
- Source channel continues fixed-repository exact fetches; it receives either component or installer head from its caller without learning repair policy.
- Exact-source preparation deliberately separates installer-helper identity from component revision.
- Permanent-entry installer remains responsible for exact component verification, ownership receipts, and primary publication.
- Setup, service, provider, image, VM, guest, repository execution, and GPU owners are not involved.

## Dependency-ordered plan

1. Extend the zero-state input contract with exact repair-head parsing and the mandatory install-only gate.
2. Require existing durable selection before any repair fetch or new selection creation.
3. Fetch/load installer stage and exact-source helper from the repair head while materializing component bytes from the existing selected subject.
4. Require exact selected-component commit evidence before clearing selection.
5. Test parser boundaries, absent/mismatched selection, exact identity separation, failure retention, no setup continuation, and successful selected-subject commit.
6. Regenerate the standalone `bootstrap-devbridge.mjs` in hosted isolation.
7. Run focused zero-state tests, standalone regeneration/check, repository preflight, and full Ubuntu/Windows smoke + full CI.
8. Only after exact-head hosted qualification, perform one physical install-only repair of `ecb6edf...`, verify the selection cleared and primary advanced to that exact subject, then run a separate ordinary `8147ede...` setup re-entry.

No direct host test/generator execution, manual installation-state mutation, setup/UAC, construction, provider/image/VM/guest mutation, repository execution, or GPU/CUDA work is authorized by this repository slice.

## Hosted regeneration and bounded qualification

Source, tests, and this repair contract were committed at `bc535050174b981f0b52d95d19f38079a15bae60`. Temporary hosted workflow run `33436424052`, job `99633860654`, then:

- regenerated `bootstrap-devbridge.mjs` from the committed source;
- passed the focused zero-state bootstrap, exact-source, nested Stage-0 LEGO, and standalone-launcher regressions;
- passed `npm run preflight -- --bound-targeted-test-concurrency`;
- passed diff hygiene;
- committed only the generated standalone bootstrap and deletion of the temporary workflow.

The self-cleaned generated-artifact commit is `147f019b666e3d4ccb15c5ee5b57adbe4d5d910a`. No repository-controlled generator or test ran on the physical workstation. The repair remains unqualified for physical use until the exact final PR head passes the normal full Ubuntu/Windows smoke and full matrix and is integrated into the Stage 8 branch.
