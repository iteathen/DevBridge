# HO165 — preserve the actual installer transaction basis

Status: implemented, under exact-head qualification; not native installation proof.

Tracking: #489 (installation capture owner), dependency of #197 and the #488 release-input/consumer qualification path. This does not replace #417's capsule availability owner.

## Assess, research, reassess

HO164 qualified source binding and exact minimal-source solving, but the actual seed's Subiquity SSH installation and curthooks precede its three APT late commands. The extracted minimal base is therefore not the pre-transaction installed state. Existing canary journals preserve tool/build summaries, not that earlier dpkg inventory. UbuntuProductionImageQualification operates only after installed boot and cannot reconstruct discarded history. No existing repository owner captures this seam; issue search found HO164/#488 but no competing implementation.

DB-008/019/020, the accepted DB-HO129 exact pre/post package-state contract, and the existing Ubuntu seed/construction owners govern this change. No package filtering, synthetic status, mutable snapshot, arbitrary guest repair, new resolver or second VM is an alternative to evidence.

## Smallest cohesive correction

Add one Ubuntu image-builder-owned capture command before the first package late command. Preserve the complete raw dpkg status at a fixed public-metadata path inside the target. The command must reject invalid/symbolic/nonregular input, preserve an already captured exact record on re-entry, reject conflicting state, publish a complete record without overwriting another entry, and clean its operation-owned staging file after failure. It performs no package operation and contains no provider, source-selection, host path or credential policy.

The existing seed composes this command, leaving package operations and selection unchanged. Advance recipe/output generations together so an old construction subject cannot adopt changed seed semantics. The record remains useful installer provenance and can later be read through existing qualified guest/file interfaces; it is not trusted release authority merely because it exists. Its source, exact canary subject and capture seam still require native qualification. Do not add a private SSH/Hyper-V path to obtain it.

Implementation uses exact argv into the installer's shell, complete private staging and no-replacement hard-link publication through GNU ln -T. The final raw record is read-only and single-link after successful cleanup. Catchable failure/interruption removes only the newly created staging file. SIGKILL/power loss can retain uncertain staging/link state; replay rejects unexpected links and does not erase that evidence. Coreutils target-directory semantics were checked against https://www.gnu.org/software/coreutils/manual/html_node/Target-directory.html .

Recipe advances from ubuntu-2604-autoinstall-v13 to v14, output from ubuntu-2604-production-v9 to v10; package/payload selection is unchanged. The old v9 accepted-profile fixture exposed one preflight failure and was corrected to the new current fixture generation; obsolete-profile rejection remains tested.

## Falsification and qualification

First demonstrate that the existing seed lacks this first-boundary record. Add permanent real POSIX filesystem tests for successful exact capture, unchanged replay, mismatched replay, nonregular/symbolic source/destination, publication collision and late failure cleanup. Keep Linux process evidence distinct from Windows portable seed tests. Check that the seed's capture precedes every APT command and that changed generations cannot reuse an old subject.

Then run focused tests, preflight and exact-head wider qualification. No physical run follows from local checks; the complete matrix and exact integrated subject remain required. Do not reset or alter current subject1247bff6897985fec3dc476b055e05a3. Actual package capture, consumer-aligned solving, offline application and GitHub Hello World in both VMs remain unfinished.

## Local checkpoint

The new first-late-command regression failed on the original three-command seed, then passed with capture composed before APT. Focused Windows checks passed24/36 with12 Linux-only skips at that point; separate setup/authority/qualification/architecture checks passed29/29. Additional permanent tests cover SIGKILL and cleanup refusal without falsely reporting successful capture. Local Windows runs do not execute those Linux shell tests.

Preflight12719 failed on the stale v9 fixture. After that fixture correction, preflight18589 passed3 artifacts /295 syntax /2 JSON /234 selected test files. The final cleanup-error propagation edit occurred at that checkpoint, so exact-final-head qualification still requires the ensuing CI; the earlier preflight is not presented as its proof. Author review checked this unit's path ownership, no-replacement publication, replay behavior, temporary-file cleanup, source/record indirection rejection and unchanged APT policy. Independent review and native installer evidence remain absent.
