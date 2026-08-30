# DB-HO080 — issue #380 Linux required-group identity binding

Status: implementation complete and local qualification in progress on exact baseline `3ebd84716b78e0e61e26ce7d68e7e9a74c406d53`.

This checkpoint is a no-elevation correctness prerequisite for parent #293. It does not attach setup or elevation, run an account, systemd, provider, storage, VM, guest, repository-execution, or model effect, or claim Linux readiness.

## Assessment

Issues #376–#378 established an exact read-only chain:

1. classify every active full-management surface;
2. bind each group-only capability to an exact NSS name and numeric ID;
3. prove that the configured and current ordinary principal lacks every such capability; and
4. select one exact capability and map its name into the canonical lifecycle-authority plan.

The last step currently discards the selected numeric ID. `linux-lifecycle-authority-plan-selection.js` returns only the plan. `linux-lifecycle-authority-identity-binding.js` later projects only group names, and `linux-local-identity-reconciliation.js` resolves those names again.

That reconciler also treats all three groups as installation-owned. If any is absent and this is the first numeric binding, it invokes the same fixed `groupadd --system` effect for the read, coordination, and management groups. The read and coordination groups are DevBridge-owned. The management group is not: #376 selected it from an already active local authorization surface. Creating a replacement with the same name does not restore that capability and can grant the service an unrelated local group identity before a later positive provider probe fails.

The resulting time-of-check/time-of-use gap is below setup orchestration. Adding elevation around it would preserve the defect. The primitive boundary must be corrected first.

## Primary-source research

Linux name-service lookup treats group name and numeric group ID as separate lookup keys and returns both in the group record. A name-only re-observation is therefore not the same authority identity as the earlier name/ID pair. NSS may source the record from local files, NIS, or LDAP, so direct `/etc/group` inference is not sufficient.

Shadow-utils documents that supplementary-group lists require each group to exist, accept the same name-or-numeric-ID form as the primary group selector, and distinguish replacement from `--append`. The existing exact service-membership versus append-only ordinary-membership split remains correct, but a numeric selector is the safer effect input after an exact ID is bound. Nothing in that contract requires or justifies creating an externally selected required group.

Systemd accepts group names or numeric IDs for `SupplementaryGroups=` and extends the account database's supplementary set. The running process ultimately carries numeric group credentials used for access checks. The unit's name projection and the persisted/running numeric identity proof must therefore agree.

Libvirt documents that traditional UNIX-socket authorization can grant full read-write access through the socket's configured group and mode. A newly created same-name group is not evidence that it owns the active socket's numeric group identity.

Primary sources:

- [Linux `getgrnam` / `getgrgid`](https://man7.org/linux/man-pages/man3/getgrnam.3.html)
- [shadow-utils `usermod`](https://man7.org/linux/man-pages/man8/usermod.8.html)
- [shadow-utils `useradd`](https://man7.org/linux/man-pages/man8/useradd.8.html)
- [systemd execution identity and `SupplementaryGroups=`](https://man7.org/linux/man-pages/man5/systemd.exec.5.html)
- [libvirt UNIX-socket authentication](https://libvirt.org/auth.html)

## Reassessment and selected design

The initial sidecar design was rejected during implementation review. Rechecking a name/ID pair immediately before `usermod` still leaves shadow-utils and systemd to resolve the name again at the effect boundary. Shadow-utils and systemd both accept numeric group selectors, so retaining a name-only service plan would preserve the race after apparently fixing it.

The deterministic plan remains pure but now requires one closed neutral management-group value containing exactly `name` and `id`. The #378 composition is still the only production path that supplies it: the composition maps its exact locally observed selected capability into the projector, and the projector retains both fields. It performs no NSS observation itself.

The connection path is:

`plan selection -> exact numeric-bound plan -> refresh composition -> lifecycle identity binding -> local identity reconciliation`

Each owner validates only its local contract:

- plan selection maps the complete selected name/ID pair into one canonical plan and returns no duplicate sidecar authority;
- the plan projects the numeric ID into `SupplementaryGroups=` while retaining the bounded name for local observation and diagnostics;
- the root-owned ownership record persists both the group name and numeric ID so restart reconstruction does not infer either;
- refresh composition validates the plan contains a complete required identity before establishing a claim;
- identity binding requires the plan ID to match the persisted numeric management GID after an installation is bound;
- local identity reconciliation requires the group to exist with the exact numeric ID before any mutation and after every observation refresh;
- only the read and coordination groups may be created;
- shadow-utils effects receive numeric group selectors, so a concurrent name rebind cannot redirect the requested group ID;
- service observation, process credentials, and the ownership record must all retain that exact numeric binding.

The value is evidence, not caller authority. Production setup must obtain the plan only from the accepted local selection root. No group name or ID is added to remote input, configuration, CLI, protected-child arguments, environment, or repository-controlled data.

There is no compatibility reader or name-only fallback. No production Linux protected generation exists, so retaining the unsafe contract would only create migration garbage.

## Implementation plan

1. Add one strict neutral name/ID normalizer at each owning boundary rather than sharing foreign object types across modules.
2. Require the complete immutable identity in the plan projector, map #378's exact selection into it, and reject widened or invalid values.
3. Persist the required numeric ID in the root-owned ownership record and use it when reconstructing the plan after restart; add no v1 reader.
4. Require the plan-bound identity in lifecycle identity binding and Linux refresh composition; reject missing, aliased, invalid, or persisted-ID-mismatched evidence before effects.
5. Replace the identity reconciler's management-group name input with exact `requiredGroup` evidence. Require that record to exist and match before creating either owned group, after each observation refresh, and before service or operator mutation.
6. Remove management-group creation completely. Retain fixed `groupadd` only for the two installation-owned groups, use numeric group selectors for account effects and the service unit, preserve exact service supplementary membership, append-only ordinary read/coordination membership, and ordinary required-group denial.
7. Extend the existing focused test processes rather than add another Windows smoke process. Cover exact selection propagation, missing/rebound/widened evidence, numeric effect projection, no required-group creation, first mutation ordering, persisted identity mismatch, interrupted observation, restart reconstruction, and source isolation.
8. Run focused tests on current and exact Node 22.16, repository preflight, repository-execution architecture gates, the complete serialized suite, doctor, generated-artifact checks, and diff hygiene.
9. Push the isolated implementation, require the complete hosted Windows/Ubuntu matrix on the exact head, document acceptance, and close only #380. Keep #293 open for bounded setup/elevation and physical provider/storage/guest qualification.

## Implementation checkpoint

The unsafe name-only contract is deleted. Plan selection now carries the complete locally observed `{name, id}` capability into plan protocol v2. Base and runtime-bound candidate plans must retain the same pair before claim admission. Ownership protocol v2 persists both values and restart reconstruction consumes both; there is no v1 reader or inferred default.

The identity reconciler now distinguishes its two installation-owned groups from one externally owned `requiredGroup`. It can create only the read and coordination groups. The required group must preexist with the exact bounded numeric identity before the first effect and after every observation refresh. `useradd`, `usermod`, and `SupplementaryGroups=` receive numeric selectors, so their own resolution boundary cannot redirect a concurrent same-name rebind. Service observation and protected runtime admission require that persisted numeric identity, while the ordinary process remains denied it.

Focused Linux qualification passes 214 total / 208 passed / 6 expected Windows skips / zero failures on both current Node and exact minimum Node 22.16.0. Current and exact-Node preflights pass the same 2 standalone artifacts / 205 syntax files / 2 JSON files / 168 targeted tests. Exact-Node repository-execution architecture gates pass 34 total / 33 passed / 1 expected Windows capability skip / zero failures. The complete exact-Node serialized suite passes 1,851 total / 1,834 passed / 17 expected platform skips / zero failures in 198 seconds. The direct product-identity/standalone regression passes 3/3. Exact-Node doctor reports `ok: true`, coding adapters disabled, and repository execution unavailable/fail-closed because no persistent-environment routes are configured. Preflight-generated artifacts and diff hygiene pass. Hosted exact-head acceptance remains pending. No setup, elevation, protected service, provider, VM, guest, repository execution, or model effect occurred.

## Stop conditions

Stop rather than implement if the correction requires caller-selected group authority, a generic privileged helper, a provider object/path/unit in the identity components, a second refresh state machine, compatibility with the unsafe name-only contract, or any real privileged/provider/VM effect during hosted qualification.
