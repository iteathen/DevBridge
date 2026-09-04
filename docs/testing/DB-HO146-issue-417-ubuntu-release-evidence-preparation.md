# DB-HO146 — issue #417 Ubuntu release-evidence preparation

Date: 2026-09-04

Status: implementation planned

Coordinates with: #197, #417, DB-003, DB-008, DB-009, DB-017, DB-019, DB-020, and DB-HO129 through DB-HO145.

## Accepted predecessor and exact seam

DB-HO145 merged through PR #471 as exact Stage 8 head `7e7d614b25b83d6668e1209eafe9acaa61096658`. Candidate run `33913890579` and fresh integrated run `33914266638` each passed all four Ubuntu/Windows smoke and full jobs.

The accepted stack can solve one immutable APT transaction, capture and seal its complete Canonical binary/source closure, reacquire the signed capsule from replaceable sources, and publish exact objects with authority last. A real production capsule is still absent. DB-HO143 deliberately requires caller-provided base dpkg state and immutable APT lists, but the current production recipe accepts those paths independently from `policy.baseMediaSha256`. It can therefore record a media digest and a package-state digest without proving that the state was extracted from that exact media.

Read-only workstation evidence confirms the gap rather than supplying an unsafe shortcut:

- the accepted Ubuntu release ISO remains present at exact SHA-256 `dec49008a71f6098d0bcfc822021f4d042d5f2db279e4d75bdd981304f1ca5d9` and size `2,918,598,656` bytes;
- its own `casper/install-sources.yaml` selects `ubuntu-server` by default and declares `ubuntu-server-minimal.ubuntu-server.squashfs` as a layered source;
- Canonical Curtin expands that name into the base and `ubuntu-server` layers and mounts the latter above the base before copying the target filesystem;
- the durable v9 construction state contains authority, preparation, media, journal, and console evidence, but no retained base dpkg-status or immutable APT-list files; and
- the failed v9 guest is not release authority and will not be queried, repaired, or mutated to manufacture these inputs.

## Primary-source research and reassessment

Canonical's current Subiquity documentation says the installation ISO's `install-sources.yaml` is the authority for the source identifier. Curtin's `fsimage-layered` implementation derives the ordered layer stack from the selected dotted image name and overlays later layers above earlier ones. Ubuntu's snapshot documentation requires `apt update --snapshot <exact-id>` immediately before snapshot-bound operations and states that Ubuntu 24.04 and later automatically enable snapshot support for official repositories.

References:

- <https://canonical-subiquity.readthedocs-hosted.com/en/latest/reference/autoinstall-reference.html#source>
- <https://github.com/canonical/curtin/blob/main/curtin/commands/extract.py>
- <https://github.com/canonical/curtin/blob/main/doc/topics/config.rst>
- <https://ubuntu.com/server/docs/how-to/software/snapshot-service/>

Reassessment rejects three tempting shortcuts:

1. an ISO package manifest is not a dpkg status database and must not be synthesized into one;
2. the failed construction VM is operational evidence, not a release-production source; and
3. a host runner's live `/var/lib/dpkg/status`, APT lists, sources, or trust configuration cannot stand in for the exact signed ISO/snapshot subject.

## LEGO contract

Add one Ubuntu-specific release-evidence preparer with two narrow injected adapters:

```text
exact signed installer media
  -> declared layered target reader
  -> exact dpkg status bytes

exact snapshot policy + explicit Canonical trust input
  -> isolated APT metadata update
  -> immutable direct list files

both observations
  -> one versioned preparation receipt
  -> one exact DB-HO131 solver request
```

The parent owns only the binding between these observations. The installer-layer adapter owns ISO/layer tooling. The APT adapter owns one update invocation against explicit official sources and the caller-selected snapshot. DB-HO131 continues to own transaction solving. DB-HO141 continues to own archive capture. DB-HO130 continues to own sealing. DB-HO145 continues to own publication ordering.

The receipt binds at least:

- protocol and exact release/codename/architecture/snapshot;
- installer media path observation, exact size, and SHA-256;
- selected install-source identifier, declared leaf layer, ordered layer identities, and extracted status SHA-256;
- explicit Ubuntu archive keyring size/SHA-256;
- exact isolated APT configuration and sources-file SHA-256;
- complete sorted regular-file APT-list inventory with individual size/SHA-256 plus one semantic inventory digest; and
- exact requested package names.

The producer must accept this receipt only when its policy and solver request match exactly and must re-observe the bound status/configuration/sources/list files before solving. This closes the media/status split without moving extraction, APT, signing, publication, setup, provider, or VM behavior into the producer.

## Failure, recovery, and cleanup

- Validate media, tool, trust, policy, destination, and bounds before creating the operation-owned workspace.
- Refuse an existing destination; never adopt or clean caller-owned state.
- Use direct regular files and direct directories only. Reject symlinks, hard links, traversal, unknown fields, layer ambiguity, missing status, unexpected APT output, list topology drift, empty lists, or changed inputs.
- Child processes use fixed arguments with `shell: false`, bounded output, cancellation, and an explicit caller-owned total duration. No generic retry is added.
- A failure removes only the newly created operation-owned workspace after exact root re-observation. A successful workspace remains until capsule production finishes, then its owning production composition removes it.
- No OneDrive path, host package state, VM state, setup state, credential, release key, or publication destination enters this owner.

## Validation plan

1. Focused fake-port proof for exact binding, top-layer status selection, deterministic receipt, producer admission, substitution rejection, interruption, and owned cleanup.
2. Boundary proof for path escape, symlink/hard-link inputs, existing destinations, media/status/list drift, wrong snapshot/architecture/media digest, malformed list inventory, noisy/failed child processes, and unknown fields.
3. Hosted Ubuntu proof against the exact signed ISO: extract the declared layered target status, perform one isolated exact-snapshot update, and run DB-HO131 without using hosted-runner package state as the base.
4. Run bounded preflight, architecture/product/standalone gates, exact Node.js 22.16.0 serialized suite, doctor, and attributable cleanup.
5. Require all-four candidate CI, exact integration, and fresh all-four integrated CI before using the resulting workspace for a real signed capsule.

This slice creates no signing key, retained capsule, remote release, second-provider credential, setup/UAC effect, provider action, VM action, or physical construction retry. Real capsule publication still requires a locally authorized release-signing key and an independently controlled second production origin in addition to offline media.
