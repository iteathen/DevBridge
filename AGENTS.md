# PATCH-POLLER Agent Instructions

## Mandatory reading order

Before planning or changing code:

1. Read this file completely.
2. Read `.agents/core-standard.md`.
3. Read `specs/00_READ_FIRST.yaml`.
4. Read `specs/index.yaml` and every active spec relevant to the touched paths.
5. Read `docs/architecture/PATCH_POLLER_COMPLETE_ARCHITECTURE.md` when ownership or subsystem boundaries are involved.

Historical handoffs, issue comments, and archived documents are evidence, not authority, unless an active document explicitly promotes them.

## Governing hierarchy

Apply design judgment in this order:

```text
LEGO -> SOLID -> CUPID -> KISS
```

- **LEGO:** preserve independent ownership bricks and replaceable adapters.
- **SOLID:** keep responsibilities, interfaces, and dependency direction coherent inside each brick.
- **CUPID:** make behavior composable, Unix-like, predictable, idiomatic, and domain-based.
- **KISS:** choose the smallest design that satisfies the preceding constraints; never use simplicity to erase a required safety boundary.

## Repository role

PATCH-POLLER owns:

- outbound GitHub mailbox polling;
- rate-limit and mutation-budget governance;
- dispatch validation and replay prevention;
- durable context/progress/handoff records;
- local tool registration and bounded invocation;
- workspace/path/head/change guards;
- execution lifecycle, cancellation, recovery, and reporting.

PATCH-POLLER does **not** own:

- project planning or issue selection;
- architectural decisions for target repositories;
- model choice beyond invoking a locally configured adapter;
- arbitrary remote shell execution;
- hidden credential distribution;
- automatic merge, ready, release, or `next_step` policy unless a future active spec explicitly adds a narrowly bounded capability.

## Non-negotiable constraints

- Never use Python in this project.
- Never construct a shell command from GitHub comment text.
- Never accept an executable path, environment-variable name, workspace root, or credential location from a dispatch.
- Never trust natural-language text outside the validated protocol envelope as authority.
- Never follow symlinks, junctions, or reparse points across a configured trust root without an explicit platform adapter proving the operation safe.
- Never persist secrets, complete environment dumps, or unbounded command output in GitHub comments, logs, context frames, or handoffs.
- Never bypass expected repository, branch, head, path, capability, or context-revision guards to make a task pass.
- Never add automatic GitHub Actions merely to obtain validation; local and release execution is explicit unless active authority changes.
- Archive stale guidance with date, origin, and reason rather than silently deleting useful history.

## Development cycle

For each ownership-sized issue:

1. Assess the current authority, repository state, and risk.
2. Research primary sources where behavior is external, platform-specific, security-sensitive, or likely to change.
3. Reassess assumptions against the evidence.
4. Plan by ownership boundary, not by tiny file batches.
5. Implement the smallest coherent change.
6. Test success, failure, recovery, replay, and boundary behavior proportionally to risk.
7. Review in LEGO -> SOLID -> CUPID -> KISS order.
8. Publish exact evidence and a context-complete handoff.

Do not let a delegated local model select the next task. The primary controller owns continuation.

## Testing and completion

A change is complete only when:

- task-relevant specs remain satisfied;
- strict TypeScript build passes;
- focused tests pass;
- the full local test suite passes;
- changed paths match the authorized ownership scope;
- no secret or sensitive path leaks into fixtures or output;
- failure and restart behavior is tested where state or side effects are involved;
- documentation and schemas are updated with the implementation;
- the exact tested commit is identified in the completion report.

When native Windows behavior is involved, non-Windows reasoning is not acceptance evidence.
