# DB-HO026 — issue #343 Linux restart-safe generation verification

Status: planned from exact `cuda-target` baseline `e821e538f69acb6a734a0328d87639ac7af0729f` on isolated branch `security/343-linux-generation-verification`.

## Assessment

The lower Linux authority bricks can establish a protected claim, bind numeric identity, stage one immutable runtime tree, provision volatile endpoint topology, and reconcile one exact unit definition. The shared refresh reconciler also already owns durable stage/verify/quiesce/promote/start/health/restore sequencing.

The connection remains unsafe because the current Linux generation manifest records only aggregate package and Node digests. A fresh process can reconstruct the generation-addressed paths and unit bytes from those two digests, but it cannot reconstruct the exact package file inventory. The current broad runtime access walk proves root ownership and modes, and package measurement covers `package.json` plus `src`, but neither rejects every undeclared generation-root, `bin`, or package-root entry. Reusing stale staging evidence or assuming root-owned bytes never changed would make restart and rollback evidence weaker than initial installation evidence.

No production Linux authority generation has been installed or admitted. The incomplete generation protocol therefore has no live state to migrate. Retaining a compatibility reader would preserve an unverifiable rollback format and contradict the fail-closed migration state.

## Research and governing evidence

This slice is an internal evidence-format and verification boundary; it introduces no new external platform behavior.

- DB-009 requires restart recovery to observe and reconcile exact intended effects before replay. A historical recovery generation must be positively reverified rather than trusted because it was once staged.
- DB-019 requires reusable verification evidence to bind the exact subject and relevant environment, and requires conservative invalidation when applicability cannot be proven. Aggregate identity without exact inventory is insufficient for tree-shape reuse.
- `docs/environment-lifecycle-authority.md` requires staging exact content-addressed runtime bytes, retaining the prior verified generation, and rolling back from observed evidence without granting the service write access to its executable supply.
- `linux-protected-tree.js` already proves an exact declared tree during installation, but its no-op path is coupled to source-bearing installation input and performs parent durability sync. It is not a restart-safe, read-only historical verification stud.
- `linux-lifecycle-authority-generation.js` already validates the complete measured package inventory before staging, so it is the correct owner for persisting that bounded inventory in the generation record.

## Reassessment and ownership boundary

1. The neutral protected-tree owner gains a separate read-only verification interface. It accepts only one installed root, local numeric policy, declared directories, and file size/digest/mode evidence. It receives only observe/list/verify ports, performs no source transfer, directory creation, rename, sync, cleanup, or lifecycle action, and rejects undeclared entries.
2. The Linux generation owner replaces its incomplete manifest with one bounded self-describing record containing the exact normalized package inventory and Node size/digest. The aggregate package digest and generation identity remain derivable and are revalidated from the record.
3. The Linux generation owner projects either a current or historical normalized manifest into the neutral read-only tree contract and returns exact verification evidence. It may reconstruct generation-addressed local paths and unit bytes, but it does not inspect or operate a service.
4. The broad lifecycle inspector consumes the replacement manifest bound and continues to report runtime evidence without becoming a refresh/service mechanic.

The interface does not expose source paths, service names, provider objects, commands, elevation, repository identity, or cleanup authority. Historical verification has no mutation port by construction.

## Plan

1. Add a closed, read-only exact-tree verifier beside the existing generic installer. Reuse only neutral tree vocabulary and keep its ports strictly observation-only.
2. Replace the Linux generation manifest protocol rather than accepting the incomplete predecessor. Store the normalized package file inventory and Node evidence, enforce file/count/byte/path and manifest-size bounds, recompute the package aggregate, and bind the record to the exact authority and derived generation.
3. Add a historical generation projection that reconstructs the exact bound plan and neutral verification tree from an unbound local plan plus normalized manifest.
4. Add lifecycle-owned read-only generation verification over the neutral stud and return only exact generation/verified evidence.
5. Update broad inspection for the replacement bound and remove assumptions that two aggregate digests alone prove an exact tree.
6. Prove current and historical verification, extra/missing/substituted entry rejection, policy rejection, forged aggregate/inventory rejection, old-protocol rejection, over-bound manifest rejection, non-mutation, widened-interface rejection, and LEGO source isolation.
7. Add focused suites to repository preflight; run related Linux tests, preflight, repository-execution architecture gates, and the full suite before isolated publication.

This prerequisite does not promote, start, stop, restore, provision, elevate, authorize libvirt, touch a VM, or claim Linux readiness. After it is integrated, the higher lifecycle mechanic can safely load and reverify active/staged/retained generation subjects after restart.
