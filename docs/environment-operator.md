# Environment lifecycle operator

Issue #176 exposes the reconstructable environment lifecycle implemented by #170–#175 through one local operator surface. It composes existing lifecycle owners; it does not move provider authority into the CLI and does not replace the guided setup/reconfiguration work owned by #116.

## Commands

Use `--identity <logical-environment-id>` or derive the logical identity with `--profile <profile>`.

```text
devbridge environment list --config <path>
devbridge environment show --profile <profile> --config <path>
devbridge environment plan --profile <profile> --operation rebuild --config <path>
devbridge environment create --profile <profile> --config <path>
devbridge environment repair --profile <profile> --config <path>
devbridge environment rebuild --profile <profile> --confirm <authorization-subject> --config <path>
devbridge environment reset --profile <profile> --confirm <authorization-subject> --config <path>
devbridge environment recreate --profile <profile> --confirm <authorization-subject> --config <path>
devbridge environment resume --profile <profile> --config <path>
devbridge environment setup-reentry --profile <profile> --config <path>
```

`list`, `show`, and `plan` are inspection operations. `create` and `repair` are bounded lifecycle mutations. `rebuild`, `reset`, and `recreate` are destructive lifecycle operations and require the exact confirmation subject shown by the current impact plan.

The surface is intentionally provider-neutral. It may report logical environment/profile identity, declaration and desired generations, observed implementation generation, health classes, exact pinned image identity/generation, workspace identities, lifecycle operation/stage, blockers, impact, and the supported next action. It must not expose VM disk paths, provider-native commands or objects, image source URLs, credentials, guest secrets, or unrestricted provider operations.

## Doctor next actions

`devbridge doctor` consumes the environment operator's read-only inspection contract. Diagnosis does not start, stop, rebuild, reset, recreate, seed, or execute code in an environment.

| Condition | Next action |
| --- | --- |
| Local declaration/authority incomplete | `setup-reentry` |
| Declaration exists; implementation absent | `create` |
| Bounded in-place defect | `repair` |
| System storage missing or invalid | `rebuild` |
| Explicit clean-baseline replacement requested | `reset` |
| Provider implementation must be replaced | `recreate` |
| Durable lifecycle journal has a non-terminal operation | `resume` |
| Environment is healthy | none |

A missing or invalid system disk is therefore never reported as a generic repair problem.

## Destructive preview and confirmation

Run `environment plan` before `rebuild`, `reset`, or `recreate`. The lifecycle-owned preview remains the source of truth for current/proposed generations, affected workspaces, preserved/reseeded/replaced/discarded state, protected-state blockers, prerequisites, rollback/staging semantics, warnings, and authorization binding.

Execution accepts only the exact authorization subject from the current plan. Reset/recreate retain their lifecycle-owner authorization verification. Rebuild receives an operator confirmation subject derived from the exact current impact payload. Material drift causes the lifecycle owner to refuse stale authorization.

## Interrupted work

Long lifecycle operations use the durable journal stages established by #170. When an operation is non-terminal, `list`, `show`, and `doctor` report `resume` plus the operation and durable stage. `environment resume` re-enters the same lifecycle owner and operation identity rather than replaying provider commands or requiring manual Hyper-V/libvirt surgery.

If interruption occurs at destructive `intent`, exact confirmation is required again before the first destructive effect. After an authorized operation has advanced beyond intent, resume continues the same durable operation without inventing a new implementation generation or widening authority.

## Setup re-entry and image recovery

`setup-reentry` is a local capability handoff to the guided setup/reconfiguration workflow tracked by #116. Remote issue text and remote model output cannot authorize provider/setup mutation, and the handoff itself grants no provider mutation capability.

The operator reports only the exact pinned image identity/generation and a bounded recovery state. The default local composition uses an exact verified local image when available. If the required image or immutable local workspace authority cannot be proven, it fails closed into setup re-entry rather than inventing a source or authority. Windows 11 media/licensing remains an explicit local setup responsibility when approved media is unavailable.

## Security boundary

#176 is operator UX, not the #177 authority boundary. Ordinary coding-model processes still must be prevented at the OS/provider layer from directly deleting DevBridge VM backing storage. The operator contract deliberately keeps provider mutation behind the existing lifecycle/foundation adapters so #177 can move those adapters behind a stronger authority boundary without changing the operator surface.
