# DB-HO135 — issue #372 Hyper-V stop compatibility

Date: 2026-09-02

Status: local qualification complete; hosted acceptance and physical resume remain pending

Coordinates with: #372, DB-HO134, and the accepted Stage 8 protected lifecycle authority.

## Physical evidence

DB-HO134 merged as exact Stage 8 head `d8ece3db3be0f1e7710260ad954b7ef7017e16b7`, with candidate and integrated tree `9bf62f2477f21c1ece43ac9940d94f6b588bbba9`. Candidate run `33676937795` and fresh Stage 8 run `33677388018` each passed all four Ubuntu/Windows smoke and full jobs. Canonical preparation bound the exact accepted runner, and explicit re-entry requested consent at setup elapsed zero with the protected action and reason shown before launch.

The exact accepted child reached DB-HO134's provider-requested lifecycle cycle, then failed before stopping the VM because this host's Hyper-V module rejects the nonexistent `Stop-VM -Shutdown` parameter. Read-only evidence showed uninterrupted VM uptime, proving no stop/start occurred. The lifecycle remains fenced and resumable; no manual VM action followed.

Microsoft's [`Stop-VM` contract](https://learn.microsoft.com/en-us/powershell/module/hyper-v/stop-vm?view=windowsserver2025-ps) documents the default invocation as guest-mediated shutdown, `-TurnOff` as the explicit power-cut path, and no `-Shutdown` parameter. The local host's `Get-Command Stop-VM -Syntax` reports the same interface.

## Smallest LEGO correction

Remove only the invalid `-Shutdown` token from the graceful branch in each of the three Hyper-V lifecycle adapters. Preserve their existing identity/ownership checks, default graceful-first behavior, explicit force-to-`-TurnOff` branch, parent lifecycle policy, and every existing bound. Direct tests inspect all three emitted scripts so the same invalid parameter cannot remain latent in another Hyper-V child.

This adds no abstraction, authority, retry, timeout, forced shutdown, VM/image/disk/network identity, PATH, OneDrive, or D-drive change. After hosted acceptance and exact installation, one attended supported resume must prove the owned cycle and then continue toward the real GitHub-delivered Hello World compile/test outcome.

## Local qualification

Focused Hyper-V environment, persistent-environment, image-construction, bootstrap, and generic lifecycle coverage passes 45/45. Exact Node.js 22.16.0 bounded preflight passes 3 standalone artifacts / 276 syntax files / 2 JSON files / 218 selected test files; the hosted-equivalent architecture/product/standalone gate passes 37 total / 36 passed / one expected Windows symlink-capability skip. The complete serialized suite passes 2,239 total / 2,217 passed / 22 expected skips / zero failed or cancelled in 405.065 seconds. Exact doctor is green while truthfully reporting that repository execution remains unavailable before construction; standalone-artifact and diff hygiene pass. Cleanup unlinked three test-created reparse points, removed the 22,539,324-byte suite root plus the 85,119,640-byte private Node runtime, and verified both exact roots absent.
