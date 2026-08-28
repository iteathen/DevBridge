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
