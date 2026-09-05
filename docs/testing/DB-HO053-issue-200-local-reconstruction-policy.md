# DB-HO053: local image-reconstruction distribution policy

Status: implemented and verified

Issue: [#200](https://github.com/iteathen/DevBridge/issues/200)

## Assessment

The setup-authority record already separates construction, distribution, activation, and declaration rows, but current setup never establishes or gates on the Windows distribution row. Exact media/image construction and activation-policy selection can therefore advance toward environment declaration without recording whether prepared image bytes may leave the machine or must be regenerated locally.

This is a missing primitive below GitHub repository/release publication. Implementing a publisher first would force an external-service choice before the local policy it must obey exists. It could also allow private hosting to be mistaken for distribution permission.

The existing #178 artifact bundle/acquisition contract and `GitHubReleaseImageSource` remain reusable. This slice does not alter their format or manufacture a remote source. It establishes the explicit source-neutral policy state that future publication and reconstruction adapters must consume.

## Primary-source research

- GitHub's authenticated-user endpoint works for current fine-grained user tokens without an additional permission, so the existing local credential can derive the personal owner proposal without a hard-coded developer: <https://docs.github.com/en/rest/users/users#get-the-authenticated-user>
- Creating a private repository for the authenticated user or an organization is a separate mutating endpoint requiring appropriate repository administration authority; a proposal or authenticated identity is not creation authority: <https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user> and <https://docs.github.com/en/rest/repos/repos#create-an-organization-repository>
- A repository observation can expose the authenticated principal's `permissions` projection, while private repository observation requires metadata access: <https://docs.github.com/en/rest/repos/repos#get-a-repository>
- Creating a Release requires push access and fine-grained `Contents: write`; Release creation may also trigger notifications and secondary rate limiting: <https://docs.github.com/en/rest/releases/releases#create-a-release>
- GitHub documents `X-Accepted-GitHub-Permissions` as the endpoint requirement, not evidence that the current credential possesses it: <https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#resource-not-accessible>

## Reassessment

Read-only discovery can safely derive and inspect candidates, but it cannot prove a not-yet-created repository or pre-authorize later mutations. Repository creation, draft Release creation, asset upload, and acceptance therefore need exact durable effect subjects and post-effect reconciliation under DB-009. They should not be compressed into a policy-selection transaction.

The smallest complete dependency is an explicit `local-reconstruction` distribution policy:

- it authorizes no upload and needs no distribution-rights claim;
- it preserves the exact existing construction/source authority rather than duplicating recipe or media identity;
- it does not claim that reconstruction will reproduce old canonical bytes;
- exact digest reproduction may satisfy an existing image subject, while different qualified bytes remain a new immutable generation requiring explicit declaration rebind;
- it is reusable for any profile, while setup composition initially attaches it only to the selected Windows profile;
- the setup-authority row carries only an opaque subject; the immutable policy record contains no provider, vendor, repository, URL, path, credential, or secret;
- the gate belongs after exact image construction and before environment declaration/publication or protected activation.

Remote-artifact policy remains unimplemented in this slice. It will require discover-first owner/repository candidates, explicit local rights confirmation for Windows, explicit repository/release approvals, adapter-local GitHub objects, exact #178 asset publication, durable numeric release/asset/digest identity, redownload, provider validation, boot qualification, and no-overwrite recovery.

## Plan

1. Add an isolated image-distribution policy value accepting only `local-reconstruction` and deriving a canonical opaque subject.
2. Add a profile-neutral setup reconciler that binds one opaque profile to the distribution authority row through a component/profile-owned restartable transaction and the existing immutable-record store.
3. Add `devbridge setup --windows-distribution local-reconstruction` without aliases; reject repeats, unknown values, non-Windows use, and protected-child propagation.
4. Reconcile the policy independently from activation and media, but enforce its gate only after selected image construction completes and before resource conflict, declaration publication, protected activation, or operational enablement.
5. Project only bounded state/readiness/mode/blocker in setup status and handoff.
6. Test strict schema/identity, LEGO isolation, exact restart and foreign-owner behavior, CLI boundaries, setup ordering, Linux independence, malformed projection denial, and absence of upload/provider/elevation effects.
7. Run focused tests, repository preflight, the complete suite, document exact implementation evidence, commit/push, and update #200/#116 while keeping their broader scope open.

## Protected-operation constraint

The operator has stated that UAC is unavailable for three days. This slice is local policy/control-plane work only. It must not request elevation, touch services/providers/VMs, perform guest work, publish artifacts, or create/modify a GitHub repository or Release.

## Implementation

The completed slice adds two isolated owners and one topology attachment:

- `image-distribution-policy.js` owns only the closed `local-reconstruction` value and its canonical opaque subject;
- `setup-image-distribution-policy.js` binds any supplied opaque profile identity to the existing distribution authority row through its own profile-scoped restartable operation;
- `setup.js` attaches that neutral reconciler to the selected Windows profile, validates its narrow status, and enforces the gate at the correct workflow frontier.

The policy value contains no current profile, OS/vendor, provider, repository, Release, asset, URL, path, credential, transport, or execution identity. The generic setup-authority record carries only its opaque subject. The immutable policy store is shared and source-neutral.

The public CLI accepts exactly:

```text
devbridge setup --windows-distribution local-reconstruction
```

There is no alias and no `remote`, `upload`, or repository option. The parser rejects repetitions, undeclared modes, use with an explicitly non-Windows profile, and propagation into the protected lifecycle child. The application repeats the profile check before invoking the reconciler.

Each profile receives a distinct operation-owner prefix derived from its opaque identity. Restart re-entry can resume only the exact profile's interrupted transaction; another profile or setup component is observed without consumption, and an explicit concurrent change is rejected before mutation. The reconciler publishes and re-observes the immutable policy record, marks its distribution row available, validates the working generation, commits it, and re-observes accepted authority. Missing, substituted, widened, imported, or mismatched state fails closed.

Setup reconciles distribution independently from media and activation so incomplete image work and independent Linux construction can continue. A completed Windows image cannot cross resource-conflict mutation, declaration publication, lifecycle authority, protected environment activation, or operational enablement until the distribution policy is accepted. Public status/handoff exposes only state, readiness, changed state, mode, and a bounded blocker.

No artifact bundle, remote source, credential, authenticated-owner proposal, repository/Release/asset object, Windows distribution-rights assertion, upload, reacquisition, image regeneration, declaration rebind, provider call, VM operation, guest operation, or elevation path was added.

## Verification evidence

- focused policy/recovery/setup/CLI/LEGO suite: 88 passed, 0 failed;
- repository preflight: 124 syntax files, 2 JSON files, and 119 targeted test files passed;
- complete repository suite: 1,648 total, 1,633 passed, 15 expected platform skips, 0 failed;
- `git diff --check`: passed;
- no installed setup, UAC request, provider/service/VM operation, guest command, media/activation effect, GitHub repository/Release mutation, or artifact upload occurred.

Tests cover strict value schema and identity, rejection of topology/transport/storage fields, immutable record substitution, exact restart recovery, cross-component and cross-profile transaction ownership, absent authority rows, CLI boundaries, public status narrowing, independent Linux progress, exact gate ordering, protected-child denial, no-upload handoff wording, and LEGO isolation in both the value and profile-neutral reconciler.

## Remaining issue scope

Issue #200 remains open. The remote-artifact path still needs authenticated candidate discovery, explicit Windows distribution-rights confirmation, repository capability/readiness projection, exact creation/publication approvals, DB-009 mutation reconciliation, #178 bundle upload to a draft Release, durable numeric Release/asset/manifest-digest authority, actual reacquisition into an empty cache, provider-native validation, boot qualification, and uninstall preservation/deletion choices.
