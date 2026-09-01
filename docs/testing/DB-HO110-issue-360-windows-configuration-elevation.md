# DB-HO110 — issue #360 Windows configuration elevation recovery

Status: physical defect assessed and dependency-ordered improvement plan accepted from exact Stage 8 head `ee0bb9dc3cccef6fb2c8ad97278d53cbc0e5b1a7`. Implementation and qualification evidence will be appended without rewriting this pre-change record.

## Scope

Parent work is #360. The protected activity acceptance remains #362. This record owns only the Windows ordinary-to-elevated setup transaction, exact-generation service health, and a direct compiled-host proof for the configuration endpoint. It does not own image construction, lifecycle semantics, provider operations, repository execution, a second service implementation, or wider pipe policy.

## Physical evidence

The v6 image gate completed before this observation. An authorized ordinary `devbridge setup` then requested the supported single elevated child. The ordinary parent used the elevation adapter's fixed five-minute invocation timeout and returned:

```text
Windows lifecycle authority elevation did not complete. Re-run devbridge setup to retry the same protected reconciliation.
```

No retry was started. Read-only process observation found the exact elevated PowerShell broker and Node child still running. The child continued its Permanent Entry preparation and protected reconciliation for roughly another twenty-seven minutes. Its terminal broker receipt bound the requested runner to `ee0bb9dc3cccef6fb2c8ad97278d53cbc0e5b1a7` and recorded exit code 3.

The protected transaction staged, verified, promoted, and started candidate generation `63110125051bc2bfe5f466ed0ecbfbd6cd70df1bfec014a6730b497ca6325a69`. Candidate health failed because the environment configuration authority was unavailable. Recovery restored and restarted generation `c0183b754f638ee205a3c2d8c467a16c39d6ca8acbee87575be3829d50d9f2ae`, then rejected its health for the same missing configuration capability. That historical generation advertises read, mutation, acceptance, and activity only. Read-only pipe inventory after recovery confirms precisely those four endpoints and no configuration endpoint.

The timed-out parent attempted cleanup while the elevated broker still owned its stdout/stderr files. The exact directory later contained one terminal bounded broker receipt after the child exited. A separate 2026-08-27 input-only directory remains ambiguous historical evidence. Neither directory was manually removed.

## Primary-source research

Microsoft documents that `Start-Process -Wait` waits for the started process and all descendants. The DevBridge outer command timeout therefore cuts off the waiting broker, not the independently elevated process tree. A bounded elevation transaction must allow the tree to finish or reconcile its exact durable result; a five-minute transport timeout is not cancellation of the protected child.

- https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/start-process?view=powershell-5.1

Microsoft also documents that named-pipe access is enforced against the pipe DACL at both server-instance creation and client connection. The existing independent endpoint/DACL design remains the correct security boundary. The repair must not widen the configuration endpoint or merge it with lifecycle/activity.

- https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights
- https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipes

## Reassessment

Three owner-local corrections are required.

1. The elevation adapter must use one explicit bounded budget covering exact installed-runner preparation and protected reconciliation. An expired outer wait remains fail-closed because the operator-owned receipt path cannot independently authenticate elevation. The active channel remains preserved; on a later invocation, the same adapter may remove only an exact bounded terminal receipt. Input-only, malformed, foreign, or potentially active directories remain preserved.
2. Service health must be derived from the exact generation manifest's host-command protocol. A current candidate still requires all five endpoints. An activity-generation recovery requires only its declared four endpoints and cannot be rejected for lacking a later configuration pipe.
3. The Windows service host needs a direct compiled-host integration proof. Current tests compile the host and assert source text, while service tests inject mocked configuration clients. The new proof must exercise distinct named pipes through the real host dispatch path and prove the configuration request/result contract under the exact client ACL. It must close every disposable listener/process/file it creates.

The candidate configuration endpoint failure remains a physical fact, not yet an implementation diagnosis. Do not guess at pipe ACL or transport changes. The direct host proof must first determine whether the committed host can bind and serve configuration. If it passes, the next physical retry remains the service-identity integration proof; if it fails, repair only the failing host/worker stud.

## Dependency-ordered implementation plan

1. Isolate elevation wait and terminal-receipt retention constants in the Windows elevation adapter; accept no caller-selected timeout or path.
2. Add exact terminal-receipt discovery and cleanup limited to the adapter's UUID directory grammar, real-directory/file topology, and bounded valid broker protocol. Preserve every ambiguous directory, including the current channel whenever its outer wait does not complete.
3. Pass the manifest host-command protocol into the generation health probe and select only the endpoint set that generation declares.
4. Prove current-generation five-endpoint health, activity-generation four-endpoint rollback health, and legacy/acceptance variants without weakening current candidate requirements.
5. Add the direct Windows compiled-host configuration test with exact setup/teardown and no service installation.
6. Run focused tests, repository preflight, architecture/product boundaries, full serialized suite, artifact freshness, and diff hygiene.
7. Publish one narrow Stage 8 PR and require all four hosted Ubuntu/Windows smoke/full jobs before another physical setup authorization.

## Implementation qualification

The focused implementation uses one adapter-owned 45-minute elevation budget, preserves the current channel on every incomplete outer invocation, and cleans only prior receipt-only directories containing one bounded valid broker result. It never consumes a prior receipt as elevation authority. Generation health now validates the manifest host-command protocol and selects only the endpoint set declared by that exact generation; current generations still require lifecycle, activity, and configuration.

A Windows-only integration test compiles the committed C# host as a disposable library, starts its real five distinct named-pipe listeners through a reflection harness, and sends the production configuration client's inspection request through the real host-to-worker dispatch. The test installs no service, closes the host, and removes its temporary runtime. This proof passed locally, so the committed host can bind and serve configuration in a current five-endpoint plan. The remaining new-host uncertainty is therefore the installed protected service identity/startup integration, which requires a fresh physical setup only after the repository matrix is green.

Local qualification completed on Windows with the focused lifecycle/host set at 60/60, the architecture boundary set at 33 passed plus one platform skip, doctor healthy, and the serialized repository suite at 2,068 passed plus 21 platform skips out of 2,089. A final cleanup-boundary hardening then narrowed stale-directory admission to a canonical managed state root and exact UUID-v4 directory grammar; the affected 60-test set and bounded preflight were rerun from those final bytes. Final preflight covered 253 syntax files, two JSON files, 203 targeted tests, and two standalone artifacts. No disposable compiled-host or elevation-test directory remained afterward.

## Post-integration physical composition finding

Stage 8 integrated the first correction at `c0b24d356afe8ad8cab08dd1d5ed8a8413757f9d`, and fresh four-job CI passed. One newly authorized ordinary setup invocation then ran from 02:32:01 through 02:55:16 and stopped before UAC with `Windows lifecycle authority elevation could not be started.` Read-only classification found no elevated child, no new elevation channel, and no protected mutation.

The elevation owner requested its new 45-minute transaction budget through the default generic `invokeCommand`, whose deliberately narrower validation ceiling remained five minutes. Production therefore rejected the request before process spawn. The injected focused invocation had asserted the requested value but did not exercise the default composition policy.

The follow-up correction preserves the five-minute default. The shared process mechanic now exposes a closed local factory for an explicitly bounded invoker, with 45 minutes as its hard maximum. The Windows elevation adapter alone composes that exact maximum as its default invocation port. A real-process regression proves the ordinary invoker rejects the 45-minute request, the explicitly composed invoker admits it, and neither the policy nor an individual request may exceed the hard ceiling. A separate composition guard proves the elevation default remains attached to that explicit policy rather than the ordinary invoker.

Follow-up qualification passed 39 focused command/elevation tests, regenerated and byte-verified the standalone installer, passed bounded preflight (253 syntax files, two JSON files, 203 targeted tests, two standalone artifacts), passed the architecture boundary set and doctor, and passed the Windows-serialized full suite with 2,070 passed plus 21 platform skips out of 2,091 and zero failures. Diff and disposable-test-directory hygiene were clean.

## Post-integration setup-composition finding

Stage 8 integrated the explicit elevation invoker at `43bf74205062d726743d1312beb3a22be6d2df25`, and fresh four-job CI run `33496146955` passed. One newly authorized ordinary setup invocation then ran from `2026-09-01T10:16:24Z` through `2026-09-01T10:39:31Z` and again stopped before UAC with `Windows lifecycle authority elevation could not be started.` No retry was started. Read-only classification found no new elevation channel, elevated child, or protected mutation. The exact runner checkout used head `43bf74205062d726743d1312beb3a22be6d2df25`.

The elevation module's explicit 45-minute invoker was correct but remained only its default. The application setup composition injected its ordinary five-minute `invoke` port into `requestWindowsLifecycleAuthorityElevation`, replacing that default at the physical call site. The long request was therefore rejected by the same ordinary validation ceiling before spawn. This was a split-authority composition defect, not a Windows or UAC refusal.

The correction removes the ordinary invocation port from the elevation request. Ordinary setup mechanics retain their bounded generic invoker, while the elevation adapter exclusively owns its separately bounded transaction invoker. A dynamic application-composition regression injects a failing ordinary invoker, requests elevation through the real setup closure, and proves the elevation request contains no `invoke` field. The adapter's existing real-process policy proof continues to own the 45-minute boundary.

## Stop conditions

Stop rather than broaden scope if the repair requires a second privileged helper, caller-selected executable/path/pipe identity, ordinary provider credentials, direct provider mutation, pipe ACL widening, service/manual host repair, repository-code host execution, or deletion of ambiguous elevation evidence.
