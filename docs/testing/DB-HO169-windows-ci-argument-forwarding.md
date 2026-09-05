# HO169 — Windows CI argument forwarding

Owner: repository CI composition, the invocation slice of #475/#290. Dependency of PR #492 native cache qualification; not an installer, cache, VM, or general scheduler change.

## Assess / research / reassess

Candidate `318d30b0f5059d7f0c9c456696d39f59f99399b2` passes both Ubuntu jobs and Windows full in CI33959956279, but Windows smoke expires at the existing three-minute preflight step on attempts 1 and 2. Attempt 1 emitted a successful preflight result immediately before the enclosing timeout; attempt 2 emitted no terminal preflight result. No third retry was requested.

Both hosted invocations echo their npm script without the requested concurrency argument. A workflow step name and static invocation string do not prove the child's actual argv. Inspection found the installed CI toolchain is Node22.16.0/npm10.9.2, while the workstation uses Node24.15.0/npm11.12.1. This explains why the ordinary local npm forwarding check alone could miss the defect.

Primary authority:

- [npm10 run-script contract](https://docs.npmjs.com/cli/v10/commands/npm-run-script/) defines the argument separator and retains package scripts as the command owner.
- [npm10.9.2 PowerShell wrapper](https://github.com/npm/cli/blob/v10.9.2/bin/npm.ps1) forwards PowerShell's already-parsed argument array; the [upstream correction](https://github.com/npm/cli/pull/8278) documents the resulting lost flag arguments.
- [Microsoft PowerShell parsing](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing) distinguishes script/native argument handling; [GitHub workflow shell behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) identifies the generated PowerShell script boundary.
- AGENTS.md, DB-019 and DB-HO055 require the existing closed Windows scheduling policy without reduced validation or widened product deadlines.

A disposable real PowerShell7.6.5 probe used the published npm10.9.2 archive (2,714,270 bytes, verified registry SHA512 `iriPEPIkoMYUy3F6f3wwSZAU93E0Eg6cHwIR6jzzOXWSy+SD/rOODEs74cVONHKSx2obXtuUoyidVEhISrisgQ==`). On Node24.15.0, the unmodified npm10 PowerShell wrapper reports version10.9.2 and delivers `[]` for `run probe -- --bound-targeted-test-concurrency`; its unmodified published `npm.cmd` delivers exactly `["--bound-targeted-test-concurrency"]`. The currently installed npm11 wrapper also preserves that argument. The fixture changed no installed npm, PATH or global configuration; its process-local prefix/cache stayed inside the disposable root.

Reassessment: the missing argv is a demonstrated CI composition defect, not permission to increase timeouts or infer a product performance regression. #475's separate progress/parent-child deadline coordination remains open; correct invocation alone does not prove every slow-runner case is fixed.

## Smallest correction and qualification plan

Select the published Windows `npm.cmd` entry point explicitly for the two Windows steps that forward scheduling arguments. Keep `package.json` as the sole script owner, both existing flags, all test inventories, non-Windows commands, exact Node/action versions, and all deadlines unchanged. Do not copy scripts into workflow commands, upgrade dependencies, change developer installation state, add a scheduler or retry loop, or implement an npm shim.

The two existing workflow regressions are strengthened to require the correct Windows entry point; both fail on the old workflow before its correction. Run those contracts plus preflight option/diagnostic contracts, the real forwarding probe for both flags, regeneration/diff hygiene, and a fresh complete four-job exact-head matrix. Earlier 318d30b local full evidence remains historical to its exact head; it is not relabeled as new-head CI. Preserve the two failed runs and classify any new failure before acting.

This is a separate CI-only commit in the same qualification PR because it is the demonstrated dependency preventing that candidate's acceptance. It adds no runtime behavior beyond HO168 and does not close #475/#290 broadly. Author review is not independent review. Clean up the probe/archive/isolated npm cache after recording its evidence.

Local correction evidence: all 12 workflow/preflight option/diagnostic contracts pass on Node22.16.0. The published npm10.9.2 fixture also drops `--test-concurrency=1` through its PowerShell wrapper and preserves it through `npm.cmd test`; both corrected workflow invocation forms delivered their exact intended flags. The original hosted full-job log independently echoes `node --test` without serialization despite its step label, so that older hosted pass must not be described as proof of serialized scheduling. The local HO168 full run used Node directly and remains genuine serialized evidence. Generated products and diff hygiene pass; require the fresh hosted result before promotion.
