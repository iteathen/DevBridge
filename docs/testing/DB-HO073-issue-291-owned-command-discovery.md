# DB-HO073 — Issue #291 owned-command discovery

Date: 2026-08-29

Status: implementation and local qualification complete; hosted Windows/Ubuntu qualification pending

## Scope and authority

Issue #291 is a setup/install handoff correction. It does not grant elevation, provider management, VM lifecycle, guest access, repository execution, model execution, or publication authority.

The physical Windows observation is internally consistent: the installing user's persistent PATH contains the DevBridge command directory and the exact owned launcher works, while the already-running caller's effective PATH omits that directory. The current implementation reduces every current-PATH miss to `requiresNewShell: true` and recommends a Node implementation entry instead of the stable owned command. That is inaccurate for a caller which deliberately constructs a reduced environment, because its descendants inherit the same reduced block.

## Governing contracts read

- DB-003: host control paths/executables remain local authority; no repository-controlled host execution or privilege broadening.
- DB-009: installation effects must be observed after mutation and recovery must preserve exact ownership.
- DB-011: Permanent Entry is the stable installed boundary; ordinary runtime repair occurs behind it.
- DB-020: this host-control correction cannot create a repository-execution fallback or provider authority.
- `docs/setup.md`: setup owns the stable command, persistent user PATH, collision handling, verification, and accurate handoff.
- `docs/self-install.md` and `docs/bootstrap-durability.md`: permanent entry and setup are separate owners; PATH points to one stable command surface.

## Exact implementation assessment

Baseline head: `8231235184fbbe1cb9a8e2e1ea39e09211861247`

Current owner: `src/setup/path-installation.js`.

- It writes and verifies the owned launcher file.
- On Windows it writes User PATH through a fixed noninteractive PowerShell operation, but accepts the mutation result without rereading and projecting an exact persisted-state observation.
- It checks only the inherited process PATH for current visibility.
- It returns `requiresNewShell` for every current visibility miss, even when User PATH was already correct before the process began.
- It exposes `command`, but its displayed fallback is `node <implementation-entry>` rather than the stable owned launcher.

Current presentation owner: `formatSetupHandoff()` in `src/app/setup.js`.

- Blocked and construction-gate handoffs describe every miss as a shell-refresh condition.
- The operational-ready handoff always recommends bare `devbridge`, even when that exact caller cannot resolve it.
- Other completed/deferred handoffs do not consistently project command visibility.

There is no in-repository controller integration that currently spawns bare `devbridge`; the defect is the install/status contract consumed by human and agent callers. The correction should provide one verified installation-owned resolver rather than add caller-specific path guesses.

Focused baseline:

- `node --test test/setup-path-installation.test.js test/setup-prerequisite-binding.test.js test/setup-construction.test.js test/setup.test.js`
- 49 passed, 0 failed.

## Primary-source research

Microsoft's Win32 environment documentation states that a child inherits the parent's environment block by default and that a parent may instead pass an explicit environment block to `CreateProcess`:

- <https://learn.microsoft.com/en-us/windows/win32/procthread/environment-variables>
- <https://learn.microsoft.com/en-us/windows/win32/procthread/changing-environment-variables>
- <https://learn.microsoft.com/en-us/windows/win32/procthread/inheritance>

Microsoft also states that one process cannot directly change an unrelated process's environment, while a User-targeted `.NET Environment.SetEnvironmentVariable` persists through the current user's registry environment and notifies applications of the update:

- <https://learn.microsoft.com/en-us/dotnet/api/system.environment.setenvironmentvariable>
- <https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_environment_variables>

Therefore an ordinary child shell launched by a sanitized caller can remain sanitized indefinitely. A persisted User PATH update and effective-process visibility are separate observations.

## Reassessment

The correct closed classification uses facts the installer can prove:

1. `not-persisted`: post-effect observation does not contain the owned command directory; setup fails closed with a focused blocker.
2. `refresh-required`: persistence was added by this invocation but the already-running process does not contain it.
3. `caller-omitted`: persistence was already correct before this invocation but the caller's effective PATH omits it.
4. `available`: persistence and the current effective PATH both contain it.

The third state deliberately says `caller-omitted`, not `sanitized`, because DevBridge can observe omission but cannot prove why the caller constructed that environment.

The exact owned command remains the stable launcher under the canonical installation home. Agent/controller callers that know that home should resolve and verify the owned command through the installation owner, then invoke the returned absolute path. They should not guess PATH or bypass Permanent Entry by invoking an implementation module.

## Scoped LEGO plan

1. Add one closed, dependency-free classifier whose contract contains only neutral booleans and neutral visibility states. It imports no sibling and names no installer, platform, caller, shell, agent, or DevBridge topology.
2. Make each persistence adapter return a verified `persisted`/`changed` observation. Windows rereads User PATH after the fixed write. POSIX verifies the exact managed profile record and rejects a malformed owned marker.
3. Add one installation-owned exact-command resolver that derives only the canonical command location, proves the target is the owned non-link regular file, and returns the absolute command path. Installation uses the same resolver after publication.
4. Replace the v1 `requiresNewShell`/`temporaryCommand` result with one v2 visibility classification and the exact stable command. Do not retain aliases or a second compatibility result.
5. Make every relevant setup handoff describe persistent state versus current visibility accurately. When bare discovery is unavailable, always display the exact stable launcher path. The operational-ready handoff must not recommend a bare command that the current caller cannot resolve.
6. Add direct classifier, persistence, ownership, sanitized-caller, and handoff regression coverage. Prove a healthy preexisting Windows User PATH plus an omitted current PATH returns `caller-omitted` and the exact owned launcher.
7. Qualify focused setup tests, repository preflight, complete suite, doctor, generated-artifact identity, diff hygiene, and hosted Windows/Ubuntu CI before closing #291.

## Safety boundary

This slice invokes no setup command, package installer, UAC/sudo flow, protected service, provider, image constructor, VM, guest, repository execution, or coding-model adapter. It changes only host-control installation observation and presentation contracts. GPU/CUDA work remains deferred.

## Implementation checkpoint

The old v1 `requiresNewShell` and Node-entry `temporaryCommand` fields are deleted. The v2 path result now carries only exact installed command identity, exact human invocation, verified persistence/change observations, and one closed visibility state.

- `src/setup/path-visibility.js` is a dependency-free closed LEGO. It accepts exactly three neutral booleans, rejects widened input, and returns only `not-persisted`, `available`, `refresh-required`, or `caller-omitted`.
- The Windows persistence adapter rereads User PATH after its fixed write and accepts only the exact two-boolean subprocess result. Unverified persistence blocks setup.
- The POSIX adapter verifies the exact managed profile record and rejects a marker whose owned record is absent.
- `resolveInstalledCommand()` derives the canonical command from the installation home, requires a non-link regular file, reconstructs the exact expected wrapper bytes around the currently installed Permanent Entry or owned Stage 0 source, and rejects content substitution.
- Setup installation calls that same resolver after writing the launcher. Agent/controller integrations can call it when installation identity is known rather than guessing the caller's PATH.
- Every relevant handoff now distinguishes persistent state from current visibility. Operational success uses the exact stable invocation for start, doctor, status, and setup whenever the current caller cannot resolve bare `devbridge`.
- Repository preflight now explicitly includes both path source modules plus the classifier, installer, and topology tests.

No legacy result reader, alias, implementation-entry workaround, PATH guess, privilege expansion, or host repository-execution fallback remains.

## Local qualification

- Current Node focused setup/path/architecture/preflight-options suite: 64 passed, 0 failed.
- Exact Node 22.16.0 focused setup/path/architecture/preflight-options suite: 64 passed, 0 failed.
- Default repository preflight: 2 standalone artifacts, 202 syntax files, 2 JSON files, 166 targeted tests; passed.
- Exact Node 22.16.0 serialized repository preflight: the same 202/2/166 inventory; passed in approximately 71 seconds.
- Complete serialized Windows suite on the final implementation bytes: 1,820 total, 1,804 passed, 16 expected platform skips, 0 failed in approximately 195 seconds.
- Read-only doctor: `ok: true`; repository execution remained explicitly unavailable because no local persistent-environment routes are configured; coding-model adapters remained disabled.
- `git diff --check` passed before documentation completion; repeat it after the documentation change.

No setup command, package installation, elevation request, protected-service mutation, provider/VM lifecycle mutation, guest access, repository execution, or coding-model invocation occurred. The doctor performed read-only host capability observation only.

Commit and push the exact implementation, then require hosted Windows and Ubuntu smoke/full acceptance before closing #291.
