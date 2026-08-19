# Historical handoffs

Files in this directory are **point-in-time recovery evidence**, not current PATCH-POLLER specification or implementation status.

A handoff records what one controller/context knew, had completed, and intended to do next at the time it was created. Later implementation may have merged, changed, superseded, or invalidated statements inside that handoff.

## Authority

For current work, use this order:

1. current user/operator instruction;
2. current local operator configuration/control state;
3. current `AGENTS.md` and active `specs/PP-*.md` contracts;
4. current `README.md`, `docs/architecture.md`, `docs/bootstrap.md`, `docs/tool-profiles.md`, and `docs/roadmap.md`;
5. historical handoffs only as evidence/recovery context.

A historical handoff never overrides a newer active spec or current mainline behavior.

## Integrity

Handoffs accompanied by `.sha256` files are checksum-bound artifacts. **Do not edit the handoff merely to make old language look current.** Doing so destroys the evidence the checksum was intended to preserve.

When a historical handoff contains stale implementation status or a superseded design:

- leave the original artifact intact;
- update the live spec/roadmap/documentation instead;
- add a new handoff only when a new recovery checkpoint is actually needed.

The PP-013/PP-014/PP-015/PP-016/PP-017/PP-018 implementations have advanced beyond several handoffs in this directory. In particular, historical campaign-specific constraints, branch names, issue states, or “next step” instructions are not standing instructions after their campaign has completed.

## Fresh-controller recovery

For live coordinating-chat rollover, PP-014 `patch-poller/chat-handoff-v1` control state is authoritative over ad hoc transcript reconstruction. A fresh controller must observe/reconcile current repository/task/spec identity before acting on an old next action.
