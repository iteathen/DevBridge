# DB-HO109 — issue #197 semantic payload output generation

Status: implemented and locally software-qualified from the preserved physical Windows blocker at Stage 8 head `41bbb02d7f490e915a8c532d88432ae9a4786204`; hosted CI and protected-runtime installation remain required before physical re-entry.

## Physical evidence

One explicitly authorized ordinary, non-elevated `devbridge setup --construct` invocation completed installation, qualification, finalization, power-off reconciliation, and retention for exact subject `subject-729bbc937efefaca4c1e4743fde1a75f`. Publication then failed closed:

`image generation is immutable and already contains different bytes`

The immutable library already owns:

- profile/generation: `linux-development` / `ubuntu-2604-production-v5`;
- image: `img-dd12f7d5088dc62281a89a887be9dc1b`;
- digest: `c3fde8830056262b9466a9c6c4fed979402306ba9cacff93aa9e7c3eeb933bf6`;
- accepted payload: `guest-image-688e4295403761cf5ae78fd1`.

The new retained subject is bound to payload `guest-image-6c102cff53ad6d9f10f03530` but still claims output generation `ubuntu-2604-production-v5`. Its parentless VHDX has content identity `3888723C-B8BE-4343-88CA-A49ED423655A` and 10,204,741,632 allocated bytes. The image library correctly removed its temporary staging copy and refused to overwrite or alias the accepted generation.

## Assessment

This is not the earlier source-delivery defect recorded by DB-HO043. That defect changed only CRLF/LF representation across otherwise identical six-member payloads, and canonical LF restored exact accepted payload generation `guest-image-688e4295403761cf5ae78fd1`.

Since that checkpoint, the payload contract changed semantically:

- membership expanded from six to nine files;
- `activity-store.mjs`, `local-process.mjs`, and `transfer-channel.mjs` were added;
- `bridge-agent.mjs` and `environment-bootstrap-agent.mjs` changed materially;
- canonical LF remains active and the current exact payload is `guest-image-6c102cff53ad6d9f10f03530`.

The setup authority advanced the payload identity but left the immutable output label at `ubuntu-2604-production-v5`. The late image-library rejection is therefore correct but unnecessarily expensive: the mismatch was knowable before source acquisition, VM allocation, installation, qualification, and finalization.

DB-020 requires immutable/versioned base images and states that base-image updates create a new image identity rather than rewriting an existing parent. DB-009 requires preserving and reconciling the exact failed effect evidence before repetition. The LEGO boundary is the setup-owned Ubuntu construction authority, not the provider, guest payload owner, image library, journal, or catalog.

No external platform behavior is implicated, so no new external research is required. The decisive evidence is the exact local authority/catalog/journal state and the repository's normative DB-009/DB-020 contracts.

## Dependency-ordered plan

1. Advance only the Ubuntu output generation from `ubuntu-2604-production-v5` to `ubuntu-2604-production-v6`.
2. Bind that output generation to exact semantic payload generation `guest-image-6c102cff53ad6d9f10f03530` at authority composition.
3. Fail before construction authority creation if current payload bytes change without a corresponding output-generation decision.
4. Add positive exact-pair and negative unbound-payload tests at the setup authority boundary.
5. Run the focused payload/authority/seed/canary/setup tests, repository preflight, and full regression suite in dependency order.
6. Record exact software evidence and publish one narrow Stage 8 correction.
7. Require hosted Ubuntu/Windows smoke and full CI before installing or physically re-entering the candidate.
8. Preserve the accepted v5 image, both retained failed subjects, their journals, and the catalog throughout correction and verification. Retire artifacts only through the existing exact-owned retention lifecycle after replacement acceptance.

## Non-goals

- Do not weaken or special-case the immutable image-library guard.
- Do not overwrite, relabel, retire, or manually delete the accepted v5 image.
- Do not edit the canary journal, construction state, authority state, retention state, or image catalog.
- Do not adopt the retained VHDX under a different authority after the fact.
- Do not add provider, filesystem, Git, checkout, setup-topology, or host identity to the guest payload LEGO.
- Do not invoke construction again until the correction is integrated, installed through the supported path, and freshly authorized.

## Implementation checkpoint

The setup-owned Ubuntu authority now publishes output generation `ubuntu-2604-production-v6` and binds it to exact current payload generation `guest-image-6c102cff53ad6d9f10f03530`. Authority composition rejects any other payload generation before a construction authority can be created. The payload LEGO, construction provider, image library, journal, catalog, and retention owners are unchanged.

The setup-authority test now derives the real current payload and proves the exact v6 pair. A separate negative case supplies another well-shaped payload generation and requires fail-closed refusal. The accepted-profile fixture was advanced to v6 because it models the current setup authority; the obsolete-generation refusal remains separately covered.

Exact local evidence on 2026-09-01:

- focused payload/authority/construction/seed/canary/setup tests: 53 distinct tests passed, 0 failed;
- the first repository preflight found one owned stale v5 accepted-image fixture; its focused correction passed 11/11 with the authority tests;
- repeated repository preflight: 2 standalone artifacts, 253 syntax files, 2 JSON files, and 203 targeted test files passed;
- complete suite: 2,082 total, 2,061 passed, 21 expected platform skips, 0 failed;
- `git diff --check`: no whitespace errors; only the checkout's existing LF-to-CRLF conversion notices were reported.

The physical v5 catalog and canary state were not mutated. Exact subject `subject-729bbc937efefaca4c1e4743fde1a75f` remains retained at journal revision 10 with its failed immutable-publication evidence. No new setup or construction invocation is authorized by this software checkpoint.
