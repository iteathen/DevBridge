# HO174 — durable task status delivery and early-transport boundary

## Assessment and scoped execution plan

Baseline: `4eabf61abec92192c35ca9ba31dec4bb8e6ebda6`, tree
`427ad4630d8fe1d159bf9c94b8f80b2871345964`. Live Stage8, merged PR #492,
and successful four-job CI 33968576880 match HO171–173. Issue #493 remains
open and unimplemented at assessment. Read AGENTS, DB-002/003/006/007/009/
014/017/019/020, application-management, VM migration/studs, the status,
run, persistence, provider-management/liveness and Ubuntu seed owners and tests.

The existing IssueStatusReporter loses initial creation intent across an
ambiguous POST and loses terminal delivery after the run becomes terminal.
The runtime-error fallback selects the oldest unfinished run without evidence
that this run caused the error. Those defects independently prevent #493
delivery acceptance even after an early installer transport is available.

Implement the complete delivery responsibility inside the existing status
owner: persist bounded redacted desired projection before network access;
preserve the exact outstanding creation attempt separately while coalescing
later status; bind reconciliation to an unpredictable host nonce, exact body,
destination and authenticated numeric publisher identity; observe paginated
issue comments before retry; keep missing/incomplete observation pending;
update the confirmed comment by ID; serialize local calls; preserve terminal
intent against later progress. Recovery runs from the existing runtime cycle,
including terminal tasks no longer returned by polling, under their original
task's lease. It never invokes the failed work. Capture runtime errors in the
task dispatch scope rather than guessing another task at the collection level.

Qualification: failing regression first, persistence/restart and ambiguous
POST/PATCH tests, hostile correlation, redaction/budget, pagination, rate
limits, concurrency, lease loss, and terminal recovery without execution.
Then focused/preflight/architecture/full Windows and hosted four-job matrix.
An actual GitHub preparation-failure fixture must use production task
provenance/status owners with no diagnostic request, and verify automatic
publication after an injected communication interruption. This fixture does
not execute repository code or qualify installer/guest transport.

## Early installer transport research and retained native evidence

The retained build remains exactly `db-image-build-ba14cbe72d248e48`, provider
`6a731c45-7987-42e1-8057-085ef5ec94e7`, subject
`subject-a946d290aed893d25efd02987452cbc1`. Read-only provider observation
finds Running, Gen2, Secure Boot enabled, template MicrosoftWindows, and
empty COM pipe paths. No lifecycle, media, disk or deadline mutation occurred.
The current computer-use skill and all required references were read. A new
ordinary VMConnect session initially failed to enumerate; entering the exact
name connected after asynchronous completion. The retained shell still shows
the original APT dependency failure. No elevation prompt was observed.

Primary research:

- [Canonical autoinstall reference](https://raw.githubusercontent.com/canonical/subiquity/main/doc/reference/autoinstall-reference.rst):
  early-commands run before block/network discovery; error-commands run in the
  live installer, where installer logs and partial /target are available.
  Reporting hooks do not prove host receipt or cover invalid configuration.
- [Microsoft Gen2 guidance](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/plan/should-i-create-a-generation-1-or-2-virtual-machine-in-hyper-v#add-a-com-port-for-kernel-debugging):
  its COM example is kernel-debugging guidance requiring offline configuration
  and disabled Secure Boot; this is not qualified production diagnostic support.
- [Hyper-V sockets](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/make-integration-service):
  network-independent VM/service addressing with Linux AF_VSOCK; application
  registration in the host registry requires administrator authority. The
  existing bridge assessment deliberately deferred the native socket adapter.
- [GitHub issue comments](https://docs.github.com/en/rest/issues/comments):
  comments expose numeric author and destination identities and paginated
  observation; creation has no atomic transaction with local persistence.

No early transport has yet passed native qualification. No second VM, retrofit
of the retained VM, Secure Boot change, new privileged service registration or
physical construction is authorized by this checkpoint. #493 remains open for
pre-runtime correlation, transport/OS hooks, evidence collection, expanded
evidence access and Linux/Windows native GitHub delivery. #489 retains raw
installation-basis export/admission; #488/#197/#417 retain package-basis work.

Further protected integration requires authorization for the new exact
candidate/base/CI tuple. PR #492 approval does not cover this change.

## Retention

Implementation review found an additional crash window between terminal run
persistence and the reporter's first call. The run owner now persists a pending
delivery bit with terminal state; recovery reconstructs its projection from
that exact run if the reporter has no record yet. The reporter separately keeps
its exact pending bytes for ambiguous remote effects. Existing decision-gate
terminal transitions use the same run-state bit. No work is re-executed to
recover either window.

The live guest read-only command `ls /sys/module/hv_sock` confirms that module
is loaded in the retained live installer. This is capability inventory only;
no socket was opened, service registered or guest hook installed. Physical
keystroke punctuation was visually checked before submitting the command.

Focused qualification uses the retained unlinked Node22.16.0 runtime at
`C:/Users/josho/AppData/Local/Temp/devbridge-node22-ho148/node.exe` and ordinary
Node24.15.0 for compatibility checks. At the reviewed checkpoint, 39 focused
tests passed on Node22; later crash-gap and minimum-comment-budget regressions
also pass. Complete exact-head qualification is still pending.

Authentication research uses GitHub's documented GraphQL `viewer` identity
through the existing serialized client, supporting user and installation
token modes without inferring publisher identity from a task author. References:
[GraphQL authentication](https://docs.github.com/en/graphql/guides/forming-calls-with-graphql),
[viewer](https://docs.github.com/en/graphql/reference/users#viewer).

Preserve the failed VM, its disk, original expired deadlines, accepted images,
canonical runtime/cache receipts and historical evidence. Do not retry the
previously denied ho169-argv-probe, ho155-capture, ho155-offline-cache,
ho157-source-offline, ho159-pack-cache or retained Node22 cleanup paths.
All development and new evidence stay outside OneDrive.

## Actual GitHub delivery proof

Issue #495 was admitted through the production IssueTaskSource with verified
content provenance and an isolated local qualification label/author policy.
Revision `902500ce0d6a63186e6575506525e15e0c6fda40f1fd18a33b0d5f12d5a80dcb`,
content SHA-256 `66cae85275d1dc026ed66f3feb33a2525b3dc65fa65187e9cbe52998646665a4`,
run `pp-495-902500ce0d6a6318`, attempt 1. Four fresh Node22 processes:

- PID30464: preparation failed with exit17; injected status-network outage;
  one preparation, zero status mutations, durable pending terminal intent.
- PID15496: GitHub accepted initial POST; harness withheld the response;
  one preparation, one POST, intent remained pending.
- PID19336: observed exact accepted comment and patched latest terminal
  projection; one preparation, one PATCH, no pending delivery.
- PID19700: fresh verification cycle; one preparation, zero mutations,
  no pending delivery, exactly one remotely observed status comment.

[Automatically delivered comment](https://github.com/iteathen/DevBridge/issues/495#issuecomment-5555857739),
ID5555857739, final body SHA-256
`9efcee8bf696d6b2dc7c70996702b9ffde386460d3e1e45287aa74b3f0eb3988`.
The useful environment-selection error, preparing stage, attempt1 and exit17
are present. Fixture secret and private path are absent. No additional log
request was submitted. The harness injected preparation/communication faults;
this is actual GitHub control-plane delivery proof, not native guest proof.
Evidence is retained in operator `ho174-github-proof/` with phase JSON and
redacted delivered-comment.md; harness is `ho174-github-canary.mjs`.

Review added publisher-identity-change fencing before creation retries,
three-attempt exhaustion tests, persistence-before-effect tests, assertion
operation attribution, progress-to-terminal crash-intent protection and
redaction before truncation. The initial full preflight exposed inventory
expectations (234 -> 238 targeted files and the aggregate simulated allowance).
The inventory and deadline assertions now reflect actual selected work;
production timeout bounds were not increased. All 42 focused tests passed
on Node22 after these corrections; full qualification follows separately.

The second preflight passed1345 tests with29 platform skips and identified
one ownership test failure: adding a context dependency to the nested run
projection module. Terminal reconstruction was moved to the RunCoordinator
owner; the nested module is unchanged. The 11 ownership/recovery tests pass.
Preflight is rerunning. Initial/second failure logs remain retained.

Known finite delivery boundaries: ambiguous creation observes at most10
100-comment pages, makes at most3 paced creation attempts, and defers on
incomplete or changed evidence. It never treats exhaustion as reported.
Comment projections are capped at60,000 UTF-8 bytes (or the smaller configured
budget); per-operation diagnostic streams retain at most8,000 bytes each.
The runtime cycle attempts at most30 pending subjects. Native transport,
expanded evidence, installation-basis capture admission and dual-guest
Hello World remain unqualified. The successful live fault/restart proof
preceded the ownership-only relocation; its remote result is retained.
