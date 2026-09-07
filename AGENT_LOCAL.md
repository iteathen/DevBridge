# Repository context: DevBridge

Universal engineering and design guidance comes from the account-global `AGENTS.md`.

## Mission and ownership

DevBridge is security-sensitive automation that turns remote task input into local development activity. It owns its capability boundaries, provider isolation, durable run state, lease/fence behavior, recovery, rate-limit discipline, and remote-to-local automation contracts.

## Local routing

Read the accepted DevBridge specifications governing the changed boundary. For VM program issues #107–#117, also read DB-020, prerequisite VM stages, `docs/vm-migration.md`, and `docs/vm-lego-studs.md` before changing the VM path.

## Local constraints

Credential-bearing and remote-execution paths are high-authority surfaces. Preserve provenance, capability isolation, recoverability, lease/fence correctness, provider boundaries, and durable run-state truth. A chat/model context is not the sole authoritative record of a run or recovery state.