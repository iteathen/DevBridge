# DB-HO093 — Issue #390 Node 24 GitHub Actions supply-chain checkpoint

Status: implementation and exact-head local/hosted qualification complete; documentation-head acceptance pending

Date: 2026-08-30

Issue: [#390](https://github.com/iteathen/DevBridge/issues/390)

## Assessment

The exact documentation-head CI run `33307843013` passed its Ubuntu and Windows smoke and full-test jobs, but every job reported that the pinned `actions/checkout@v4.2.2` and `actions/setup-node@v4.4.0` actions target deprecated Node 20 and are being forced onto Node 24 by the hosted runner. The tests are green, but the action bundles no longer run under the runtime declared by their pinned releases. That weakens exact evidence identity and leaves the workflow exposed to the announced removal of Node 20.

The workflow currently:

- grants only `contents: read`;
- checks out the exact pull-request head or push SHA with full history;
- pins both third-party actions by immutable commit SHA;
- tests DevBridge itself on exact Node `22.16.0`;
- performs no authenticated Git operation after checkout; and
- does not request dependency caching.

This is CI supply-chain and verification infrastructure. It does not change DevBridge runtime, VM, provider, setup, credential, publication, or repository-execution authority.

## Primary-source research

1. GitHub's [Node 20 runner deprecation notice](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/) says Node 20 reached end of life, hosted runners began using Node 24 by default on 2026-06-16, and workflow authors should update to action versions that run on Node 24. The warning on run `33307843013` is therefore an announced migration condition, not a harmless repository-local message.
2. The official [`actions/checkout` v7.0.1 release](https://github.com/actions/checkout/releases/tag/v7.0.1) resolves to immutable commit `3d3c42e5aac5ba805825da76410c181273ba90b1`. Its [exact `action.yml`](https://github.com/actions/checkout/blob/3d3c42e5aac5ba805825da76410c181273ba90b1/action.yml) declares `runs.using: node24`. It also documents that `persist-credentials` defaults to `true`.
3. The official [`actions/setup-node` v7.0.0 release](https://github.com/actions/setup-node/releases/tag/v7.0.0) resolves to immutable commit `820762786026740c76f36085b0efc47a31fe5020`. Its [exact `action.yml`](https://github.com/actions/setup-node/blob/820762786026740c76f36085b0efc47a31fe5020/action.yml) declares `runs.using: node24`. It also documents that `package-manager-cache` defaults to `true` when qualifying package metadata selects npm.
4. The current root `package.json` has no `packageManager` or `devEngines.packageManager` field, so the new setup-node default would not activate caching today. An explicit `false` is still required to keep future package metadata from silently changing CI persistence behavior.

## Reassessment and ownership decision

Update only the two official action subjects, preserve immutable SHA pinning, and make the unused authority/persistence defaults explicit:

- use checkout v7.0.1 at `3d3c42e5aac5ba805825da76410c181273ba90b1`;
- set `persist-credentials: false` because no later job step needs authenticated Git;
- use setup-node v7.0.0 at `820762786026740c76f36085b0efc47a31fe5020`;
- set `package-manager-cache: false` because this workflow does not own dependency-cache restore/save effects; and
- retain Node `22.16.0`, workflow permissions, events, matrices, timeouts, checkout ref/depth, and every command unchanged.

This is smaller and safer than suppressing the warning or opting back into an insecure runner runtime. It also avoids treating a moving major tag as authority. The existing exact commit pins remain the supply-chain identity.

## Dependency-ordered implementation plan

1. Add one isolated workflow-contract test that reads `.github/workflows/ci.yml` as data and proves:
   - both jobs use only the two accepted immutable action SHAs;
   - the comments identify the corresponding official releases and Node 24 runtime;
   - both checkout steps disable credential persistence;
   - both setup-node steps disable automatic package-manager caching;
   - workflow permissions remain `contents: read`; and
   - no floating action reference appears.
2. Update the smoke and full-test job steps identically.
3. Run the new focused test, cheap preflight, repository-execution architecture gates, and product/standalone integrity checks.
4. Run the complete serialized suite because this changes the workflow that supplies repository-wide acceptance evidence.
5. Commit and push the exact implementation, then require all four hosted Ubuntu/Windows jobs to pass without the Node-20 action warning.
6. Record exact local and hosted evidence, update #390, and close only #390.

## Required nonclaims

This checkpoint does not prove VM/provider/guest readiness, protected service refresh, environment activation, physical C acceptance, Stage 7 qualification, a main-branch merge, or GPU/CUDA capability. It invokes no setup, elevation, service/provider/VM/guest mutation, DevBridge repository execution, or model adapter.

## Implementation and evidence

Plan commit `4e539578e161619252fcecd0fdf789b28b0fe4eb` passed all four hosted jobs in [run `33308240607`](https://github.com/iteathen/DevBridge/actions/runs/33308240607) before the workflow changed. That run reproduced the Node-20 action annotation and established the exact pre-change baseline.

Implementation commit `1254170582f849429a45c3a1ea0b415f16cb7d06`:

- pins checkout v7.0.1 and setup-node v7.0.0 to the researched immutable commit subjects in both jobs;
- explicitly sets `persist-credentials: false` for both checkout steps;
- explicitly sets `package-manager-cache: false` for both setup-node steps;
- keeps exact tested Node `22.16.0`, read-only workflow permission, events, matrices, timeouts, ref/depth selection, and commands unchanged; and
- adds one workflow-contract test alongside the existing immutable-action identity test.

Local qualification on the exact implementation:

- focused public-repository/workflow contracts: 5 passed, 0 failed;
- bounded Windows preflight: 2 standalone artifacts, 219 syntax files, 2 JSON files, and 178 targeted test files passed;
- repository-execution architecture plus product/standalone gates: 37 total, 36 passed, 1 expected Windows symlink skip, 0 failed;
- complete serialized suite: 1,958 total, 1,937 passed, 21 expected platform skips, 0 failed in 189 seconds;
- doctor: green, coding-model adapters disabled, repository execution unavailable/fail-closed; and
- diff hygiene: clean.

[Hosted implementation run `33308595425`](https://github.com/iteathen/DevBridge/actions/runs/33308595425) passed Ubuntu and Windows smoke/full-test jobs. All four exact check runs report `annotations_count: 0`; the former Node-20 warning is absent, and the job records show the two new immutable action subjects. Require the documentation-only head to pass the same matrix before closing #390.
