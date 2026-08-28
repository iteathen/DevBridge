# DB-HO038 — issue #364 approval-bound setup conflict retirement

Status: assessment, primary-source research, reassessment, and implementation plan from exact predecessor `14206e1999ba06c9b60fd6802df46e270167be37` on `stage8/362-protected-activity-channel`.

## Assessment

The public Windows setup path can create the accepted protected network only when the host's single WinNAT slot is free. The provider adapter correctly inspects all current translations and fails before mutation when a different translation occupies that slot. Public setup does not currently expose a bounded conflict subject or accept exact operator consent, so the only available recovery is an ad hoc elevated shell outside DevBridge.

The live host contains one previously created disposable translation. Ordinary read-only observation proves its exact prefix and switch identity and currently finds no static mapping, active session, or guest adapter. Those facts are transient and cannot be treated as continuing removal authority. The elevated operation must re-observe all of them immediately before mutation.

Encoding the historical object name or automatically adopting/removing any foreign translation would create legacy coupling and unsafe cleanup authority. Adding a second administrator helper would duplicate the existing protected setup boundary.

## Primary-source research

- Microsoft's [Hyper-V NAT guidance](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/setup-nat-network) documents the Windows host limitation of one internal NAT network.
- Microsoft's [`Remove-NetNat`](https://learn.microsoft.com/en-us/powershell/module/netnat/remove-netnat?view=windowsserver2025-ps) documentation states that the cmdlet removes an exact NAT object and its translations. Exact predecessor observation therefore must be part of the authorization subject.
- Microsoft's [Service Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights) keeps protected setup/service authority administrator-controlled. Retirement belongs inside the existing one-shot elevated setup child.

## Reassessment

The smallest complete design is a provider-local adapter behind a neutral setup-conflict stud:

1. ordinary discovery enumerates the single blocking candidate and returns a bounded human description plus an opaque SHA-256 subject;
2. the CLI accepts only that opaque subject as consent and persists one bounded setup intent;
3. the elevated child enumerates current state again and derives the subject locally rather than accepting a provider name, path, command, switch, VM, or provider object;
4. retirement is admitted only when one exact candidate still matches and has zero mappings, sessions, and guest attachments;
5. only the translation is removed; its switch is preserved;
6. absence after an already-realized effect is an idempotent success, while a different or ambiguous conflict fails closed;
7. protected network reconciliation then continues through the existing setup transaction and ordinary postcondition proof.

This is not a migration alias. The contract applies to any exact locally observed setup conflict and contains no historical identity.

## Dependency-ordered implementation plan

1. Define bounded neutral conflict observation, consent, and result values.
2. Implement provider-local read and retire operations with deterministic subject hashing and immediate dependency re-observation.
3. Persist accepted consent in setup-owned state and add one explicit CLI option carrying only the opaque subject.
4. Compose discovery into ordinary setup before elevation.
5. Consume the accepted intent inside the existing elevated configuration reconciler before owned resource reconciliation.
6. Project actionable handoff text without leaking an executable command or granting implicit consent.
7. Test absent, exact, changed, active, attached, ambiguous, replay, malformed-consent, and no-elevation behavior.
8. Run focused tests, architecture/preflight checks, the complete suite, diff review, and then the physical installed-selector qualification.

## Implementation checkpoint

The implementation now keeps the generic consent contract, provider observation, and protected composition separate:

- the neutral conflict value exposes only `state`, an optional opaque SHA-256 `subject`, and a bounded reason;
- the Windows adapter derives the intended network identity locally, enumerates current translation/switch/dependency state, and never projects provider identities;
- a retirement subject binds the exact translation name/prefix, switch identity/type/marker, and zero dependency counts without exposing those fields to setup;
- `--retire-conflict` accepts only one exact digest and is rejected on the elevated-child CLI surface;
- consent is one bounded hardened local record, is reused only for the same observed subject after a cancelled UAC attempt, and is cleared after successful environment activation;
- the elevated configuration owner loads that record, re-observes the exact subject and dependency counts inside one provider operation, removes only the translation, verifies its absence, preserves the switch, and then continues existing owned-network reconciliation;
- no historical NAT name, prefix, switch identity, branch identity, raw command, arbitrary cleanup path, or compatibility alias appears in production code.

Real-host ordinary inspection returned one `approval-required` neutral observation with an opaque 64-character subject and no provider details. No mutation occurred during that probe.

Verification from the exact working tree on 2026-08-28:

- focused conflict/setup/configuration/provider tests: 64 total, 63 passed, zero failed, one Windows symlink-fixture skip;
- complete repository suite: 1,506 total, 1,492 passed, zero failed, 14 platform-specific skips;
- candidate preflight after adding every new owner: 98 syntax files, two JSON files, and 94 targeted test files passed;
- `git diff --cached --check`: no whitespace errors; Git emitted only the repository's expected LF-to-CRLF checkout notices.

Physical consent/elevation remains the next gate. The direct shell-elevation attempt was rejected before reaching Windows and made no change; the installed product path remains the only accepted mutation route.

## Physical reassessment — 2026-08-28

The exact approved translation retirement subsequently completed through the installed one-shot elevated setup path. The protected runtime refreshed successfully and the translation is now absent. Protected profile reconciliation then failed closed before network readiness because an older partial setup attempt had left the deterministic target internal switch present with an empty ownership marker. It has no guest adapters and only one automatically assigned link-local IPv4 address. No declaration, persistent profile environment, route, operational configuration, or guest execution was created.

The original implementation deliberately preserved the translation's switch. That is correct for a foreign translation, but it exposed a second independent conflict: the deterministic target name is occupied without provider-verifiable ownership. Protected planned state is not sufficient authority to seize or stamp that object because it does not prove the object was absent before the historical creation attempt.

Current Microsoft provider contracts confirm the bounded recovery surface:

- [`Remove-VMSwitch`](https://learn.microsoft.com/en-us/powershell/module/hyper-v/remove-vmswitch?view=windowsserver2025-ps) removes an exact virtual switch;
- [`Get-VMNetworkAdapter`](https://learn.microsoft.com/en-us/powershell/module/hyper-v/get-vmnetworkadapter?view=windowsserver2025-ps) provides the attachment observation required before switch retirement; and
- [`Get-NetIPAddress`](https://learn.microsoft.com/en-us/powershell/module/nettcpip/get-netipaddress?view=windowsserver2025-ps) provides exact interface-address observation so setup does not discard a configured operator network under an apparently idle switch.

The conflict owner therefore needs one additional provider-local candidate class behind the unchanged neutral stud. When no translation occupies the host, an exact-name internal switch with an empty marker may expose an opaque approval subject only when it has zero guest attachments and no configured non-link-local IPv4 address. The subject binds the candidate class, switch name/ID/type/marker, attachment count, and sorted address evidence. A non-empty foreign marker, external/private switch, guest attachment, configured address, multiple candidate, changed subject, or observation failure remains blocked without consent.

After exact subject consent, the same elevated setup child re-observes every bound field, removes only that exact switch, verifies absence, and resumes the normal provider path, which recreates and marks its own switch before address/NAT reconciliation. No caller supplies a switch name, provider object, command, or path. No manual marker adoption or ordinary-process Hyper-V mutation is permitted.

Dependency-ordered amendment:

1. Generalize the Windows-local conflict classifier to distinguish translation and unclaimed-switch candidates without changing the neutral public contract.
2. Fingerprint and re-observe bounded switch attachment/address evidence.
3. Retire only the exact approved candidate kind and verify its kind-specific absence.
4. Test clear owned/absent state, safe switch consent/retirement, configured address, attachment, marker/type mismatch, changed subject, and preservation of the existing translation cases.
5. Run focused tests, preflight, and the complete suite before requesting the final host elevation transaction.

## Partial-switch implementation checkpoint — 2026-08-28

The Windows-local adapter now classifies two independent candidate kinds behind the same neutral conflict contract. Translation behavior is preserved. With no translation present, an exact-name unmarked internal switch is eligible for an opaque approval subject only when guest-only adapter enumeration reports zero attachments and every observed IPv4 address is link-local. The subject binds sorted address evidence as well as exact switch identity and state.

Retirement re-observes the subject inside the existing elevated child, dispatches only on the locally derived candidate kind, removes the exact approved switch, verifies absence, and exposes no provider identity. Owned/absent state remains a no-op. Foreign marker/type, configured address, guest attachment, drift, ambiguity, or invalid evidence remains fail-closed.

The first live read-only probe exposed that Hyper-V's all-adapter inventory includes the mandatory management-OS vNIC for an internal switch. The implementation therefore retains the guest-only `-VMName *` query and includes a regression test proving the host vNIC is not misclassified as a guest dependency. The corrected live probe returns one `approval-required` neutral observation with subject `00dbc6dd7feff1861a435eb45c715739819ce3d1ec75e044bc50919e9d8b67ef`; it performed no mutation.

Verification:

- focused real-Windows PowerShell tests: 18/18 passed;
- repository preflight: 99 syntax files, two JSON files, and 95 targeted tests passed;
- complete suite: 1,541 total, 1,526 passed, 15 platform-specific skips, and zero failures.

The code checkpoint must be committed/pushed before the exact subject is supplied to the installed selector. Physical switch retirement, owned network reconciliation, declaration publication, environment activation, and guest execution remain unclaimed.

## Physical transaction checkpoint — 2026-08-28

Commit `dc60348d7eee64ff8db7b7003517be5dd315d8fc` is pushed on `stage8/362-protected-activity-channel`. The installed selector persisted the exact switch consent and attempted the one-shot elevation, but Windows reported that elevation was cancelled or refused before the protected child transaction began. No second prompt was launched.

Post-attempt re-observation proves:

- the protected service is still running its previously refreshed generation `c0183b754f638ee205a3c2d8c467a16c39d6ca8acbee87575be3829d50d9f2ae`;
- no WinNAT translation exists;
- the exact target switch remains unchanged, internal, and unmarked;
- no persistent profile VM exists; and
- consent subject `00dbc6dd7feff1861a435eb45c715739819ce3d1ec75e044bc50919e9d8b67ef` remains durably available for exact re-entry.

The next setup re-entry must reuse that subject only after a future explicit operator-ready UAC window. Until then, protected Linux activation remains fail-closed and no direct Hyper-V mutation or marker adoption is permitted.
