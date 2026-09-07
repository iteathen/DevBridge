# HO159 — immutable transport packs for #485 / #417

## Assessment and research

The real capsule's2579 unique chunks exceed GitHub's1000-assets/release limit. Sourceb5b912b and the signed capsule remain valid; this is a transport capability gap. The existing image bundle owns image identity/encoding, not this many-object domain. GitHub's documented binary download supports200/302, not an explicit portable range contract. Do not introduce an unqualified range dependency.

Primary sources: https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases and https://docs.github.com/en/rest/releases/assets . Provider bounds stay in the provider. DB-003/008/009/019 and the LEGO module contract govern.

## Reassessed plan

Reuse `immutable-object-set-v1` itself as the pack index: each transport object is a concatenation of existing unique chunks; its chunks contain exact original sizes/digests and contiguous pack offsets. No second manifest/schema/descriptor owner, compression, pathname archive parser or new signed package/source subject is needed. Derive a whole-pack transport descriptor (one chunk per pack) through the same value owner. Producer accepts a byte-source port and explicit caller-owned pack-size bound. Reject input/coverage before creating the exclusive output directory; stream bounded frames; verify each original chunk and complete pack; preserve explicit failure cleanup.

A packed byte-source consumes exact pack acquisition via an injected `ensure` port, independently reobserves its receipt, and returns only the requested original chunk through a held verified file. The existing acquisition owner retains cache/restart policy. Completed per-pack observation may be reused within one reader instance, but every returned slice is size/hash verified and file identity is reobserved. Rejected acquisition is not memoized. No network, credentials, provider name, arbitrary URL or cache selection lives in the pack module.

Publication composition must verify original chunk coverage against accepted manifests, then publish/read back whole packs through the existing gate before the index/public key and original manifest. This relies on exact whole-pack byte equality, not a pre-populated cache masking destination bytes. Index authenticity alone never replaces verification of the signed original chunk. GitHub capacity admission includes unrelated existing assets plus authority prerequisites before uploads. R2, Ubuntu signature normalization and the neutral publication gate remain unchanged.

## Qualification plan / non-claims

First prove missing capability, then normal/replacement-source operation, unchanged descriptors, duplicate chunks, size bounds, missing/corrupt/truncated/extra bytes, cancellation, late failure, exact owned rollback, retry, forged acquisition receipts and modified cached pack slices. Run focused tests, preflight/architecture and full exact-head Windows/Ubuntu matrix before live use. No physical installation, UAC, VM or end-to-end Hello World claim. Author review is not independent review.

## Local implementation evidence

The initial focused test failed with the missing pack module, confirming the capability did not exist. Implemented the neutral producer/transport-descriptor derivation/packed source using the existing descriptor and acquisition authorities. Eight pack tests cover2579 unique chunks, fake/source replacement, unchanged caller descriptors, exact packed publication ordering, empty-cache reacquisition, corrupt/short/extra/late-failed streams, cancellation/iterator closure, owned rollback/retry, foreign output preservation, forged receipts and changed cached files/handle closure. Provider tests admit/reject complete plans against both total and remaining asset capacity, reserve authority slots, allow exact existing assets, reject conflicting assets, and prove no mutation on rejection. Provider limits are exposed by the GitHub owner; the old unrelated164-page bound is derived from that same capacity owner instead.

Review caught a mutable input-frame hazard before qualification: hash and write now consume the same bounded copied frame, so a source cannot change the hashed bytes while an awaited write is pending. Failure cleanup also rechecks the exclusive output directory identity and reports an aggregate cleanup failure rather than deleting a substituted directory or silently losing orphan evidence. The neutral gate, R2, original release signatures and schemas are unchanged. Focused pack/GitHub/R2/gate qualification37/37 passes; wider exact-head qualification pending. This is author review, not independent review.
