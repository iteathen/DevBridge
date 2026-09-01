# DB-HO113 — issue #430 elevated exact-runner re-entry

Date: 2026-09-01

Status: implementation candidate; hosted and repeated physical acceptance pending

Coordinates with: #103, #116, #159, #360, #430, DB-003, DB-009, DB-011, DB-019, DB-020, DB-HO105, DB-HO110, DB-HO111, and DB-HO112.

## Physical evidence

PR #433 merged into Stage 8 at exact head `5bd566d5cb65e32f6b382f4a08d2e7a1c84614ff`. Both its pull-request matrix (`33546177470`) and the fresh draft-branch matrix (`33546601340`) passed Ubuntu/Windows smoke and full jobs. The zero-state install-only path then committed that exact component, selected runner, and pinned runner into the canonical `C:\Users\josho\.devbridge` installation.

The first ordinary setup invocation completed in 68,700 ms. Cold exact-runner handoff consumed approximately 52.7 seconds; setup then reached and durably prepared the protected-apply frontier in 16 seconds without UAC. On explicit ordinary re-entry, setup reported `elevation-consent: requested` at elapsed setup time zero. This proves the new immediate-entry ordering from DB-HO111.

The UAC child failed closed five seconds later with:

`Windows lifecycle authority elevated broker reported: [devbridge-entry] Another protected activity is active for this root.`

The ordinary exact-checkout provider correctly holds the runner-cache activity lease through the awaited setup process so cache cleanup cannot race executing runner bytes. The elevation broker then recursively invoked `devbridge-entry --ref <same-head>`. That second PID attempted to acquire the same cache lease and correctly treated the live parent as another activity. The prepared frontier remained durable, the setup invocation returned blocked, and no second UAC prompt, setup replay, construction, or manual lease cleanup occurred.

## Nested ownership decision

1. **LEGO:** Permanent Entry remains the outer selector/cache owner. The elevation adapter remains the sole UAC child owner. The accepted runtime CLI remains the lifecycle-authority child entry. These are three distinct bricks; the UAC child must not recursively re-enter the selector brick already held by its parent.
2. **SOLID:** the installed entry path is still validated as the operator-facing authorization entry point. A separate exact-runner descriptor binds the current detached checkout root, exact 40-hex head, and fixed real `src/cli.js`. The elevation adapter consumes those two proofs and launches only the exact runtime CLI.
3. **CUPID:** the child command is the predictable closed tuple `setup --lifecycle-authority-child --no-update`. Existing broker input/result protocols, parent marker, home binding, single-UAC behavior, bounded output, cleanup, and post-child ordinary verification remain unchanged.
4. **KISS:** do not share an exclusive lease across PIDs, invent a child exception, release the parent lease around elevation, add another broker/service, or copy runtime bytes. The parent lease already prevents cleanup of the exact checkout while the direct child reads it.

## Candidate behavior

`resolveWindowsLifecycleAuthorityElevationRunner` now returns one immutable `{ head, root, launcher }` descriptor only when the current package root is a real directory, `.git` is a real directory, `.git/HEAD` is a bounded detached exact head, and `src/cli.js` is a real file. Before UAC, the elevation adapter independently proves:

- the installed entry launcher is one allowed real file in the managed `bin` directory;
- the current Node executable is a real file;
- the runner descriptor has only the three closed fields;
- the runner launcher is exactly `<runner-root>/src/cli.js`; and
- the complete runner-launcher parent chain remains real and inside the canonical managed home.

The broker input contains the direct runner launcher, not the installed entry launcher. The fixed broker no longer supplies `--ref`; therefore it performs no runner selection, fetch, receipt mutation, or runner-cache lease acquisition. It still checks the descriptor head against the independently encoded expected head before starting the child.

## Candidate evidence

Final-byte local qualification uses the exact supported minimum Node 22.16.0 runtime and passes:

- bounded repository preflight: two standalone artifacts, 255 syntax files, two JSON files, and 205 targeted test files;
- expanded setup/frontier/provider/cache/elevation boundary: 116/116;
- architecture/product/standalone gate: 11/11;
- read-only doctor: `ok: true`, with GitHub authentication available and repository execution still correctly unavailable until protected setup publishes a route; and
- complete serialized suite: 2,107 total, 2,086 passed, 21 expected platform skips, and zero failures in 332.5 seconds.

Tests prove:

- detached exact descriptor acceptance and symbolic-head rejection;
- managed installed-entry validation remains mandatory;
- exact-looking runner launchers outside the managed home fail before UAC;
- the real rendered PowerShell broker executes the direct CLI with exactly the three internal arguments and returns bounded child evidence;
- timeout preserves the exact result channel;
- completed old channels are cleaned only after the UAC transaction;
- child failure/diagnostics remain bounded and exact; and
- setup preparation, one-child, cancellation, capability denial, and post-child verification contracts remain green.

## Remaining acceptance

Require all four hosted jobs on the exact candidate and post-integration Stage 8 heads. Then install only that accepted Stage 8 head and repeat the existing durable protected-apply re-entry. The physical proof must show one immediate UAC prompt, no runner-cache activity conflict, exact protected child evidence, fresh ordinary verification, and setup continuation. Do not manually remove the runner activity lease, protected service state, elevation channel, or prepared frontier.
