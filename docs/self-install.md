# Self-install and permanent-entry qualification

DevBridge supports a Node-only zero-state bootstrap plus a standalone permanent-entry installer. The permanent-entry transaction remains separate from the legacy Stage-0 launcher and from later setup/provider/image behavior.

`bootstrap-devbridge.mjs` is the first DevBridge stage for a blank host. `install-devbridge.mjs` is the permanent-entry installation stage. Both use only Node.js built-ins; the zero-state exact-subject path does not require a DevBridge checkout, Git, npm packages, GPG/GPGV, or provider/image tooling before bootstrap begins.

The installer remains an installation/control-plane boundary: source authority, installed component membership, filesystem ownership, manifest admission, and wrapper activation are closed local contracts. After that boundary commits successfully, normal CLI use immediately hands off to the exact installed runner's public `setup` surface; setup/provider/image behavior is not duplicated inside the installer.

## Zero-state entry

The supported blank-host entry starts with Node fetching the bounded bootstrap bytes itself. No installer file or checkout needs to exist first.

A stable/default first-byte invocation is:

```text
node --input-type=module -e "const u='https://raw.githubusercontent.com/iteathen/DevBridge/main/bootstrap-devbridge.mjs';const r=await fetch(u,{redirect:'error'});if(r.ok!==true)throw new Error('bootstrap fetch failed: '+r.status);const b=Buffer.from(await r.arrayBuffer());if(b.length<1||b.length>524288)throw new Error('bootstrap size invalid');await import('data:text/javascript;base64,'+b.toString('base64'))"
```

For development qualification against `cuda-target`:

```text
node --input-type=module -e "const u='https://raw.githubusercontent.com/iteathen/DevBridge/cuda-target/bootstrap-devbridge.mjs';const r=await fetch(u,{redirect:'error'});if(r.ok!==true)throw new Error('bootstrap fetch failed: '+r.status);const b=Buffer.from(await r.arrayBuffer());if(b.length<1||b.length>524288)throw new Error('bootstrap size invalid');await import('data:text/javascript;base64,'+b.toString('base64'))" -- --ref cuda-target
```

The development branch in the first-byte URL is only a locator for the disposable bootstrap stage. Inside Stage 0, `cuda-target` is resolved to one exact commit and persisted before permanent-entry publication. If the bootstrap is interrupted, an argument-equivalent rerun reads the durable selection first and resumes the persisted exact commit even if `cuda-target` moved meanwhile.

The first-byte loader bounds the bootstrap response and rejects redirects. Stage 0 independently bounds all later responses and fetches installation stages from the persisted exact commit.

The direct command `node .\install-devbridge.mjs ...` remains supported for installer-specific qualification when the file is already present. It is not the blank-host entrypoint.

## Stable/default install

With no selector, zero-state bootstrap resolves the exact current `main` head, persists it through the installation commit, installs the permanent-entry component from that exact subject, leaves normal stable runner selection active, and then enters `devbridge setup` through the installed entry.

The generated entry is:

```text
~/.devbridge/bin/devbridge-entry.mjs
```

On Windows the installer also writes `devbridge-entry.cmd`; on Unix-like hosts it writes `devbridge-entry`.

If setup reaches a real authentication/elevation/reboot/repository-selection/provider/readiness boundary, its exit status is preserved. The permanent entry remains installed, and the operator resumes through the normal `devbridge setup` re-entry surface rather than reinstalling.

Setup separately verifies persistent command registration and the current caller's command visibility. If an agent/runtime supplied a reduced PATH, the handoff prints the exact owned `devbridge` launcher under the canonical installation home; callers use that stable launcher rather than invoking `devbridge-entry.mjs` or assuming another child process will reconstruct User PATH. In-repository integrations that know the installation home use the installation-owned resolver to verify that same command before invocation.

For explicit installer-only qualification/recovery after acquiring the installer file, stop before the setup handoff with:

```text
node install-devbridge.mjs --install-only
```

The installer does **not** overwrite `~/.devbridge/bin/devbridge.mjs`. The existing legacy Stage-0 launcher therefore remains available during permanent-entry qualification and cutover.

## Exact development/qualification install

The zero-state development invocation above treats a moving branch as a locator, then persists one exact subject before permanent-entry mutation.

The bootstrap path:

1. resolves the selected branch to one exact commit;
2. durably records that exact subject before permanent-entry publication;
3. fetches `install-devbridge.mjs` from the exact commit with Node;
4. fetches the exact-source acquisition child from the same exact commit;
5. gives the child only the explicitly reviewed permanent-entry dependency closure;
6. fetches that fixed component set directly from the persisted exact commit with bounded Node requests;
7. passes the prepared exact source into the installer transaction;
8. verifies exact per-file SHA-256 evidence and component membership;
9. preserves an existing active JavaScript wrapper before replacement can become active;
10. stages platform delegates and the JavaScript wrapper before publication;
11. publishes the JavaScript wrapper last as the authority-changing commit point;
12. pins the exact selected runner commit as the wrapper's default selection for an explicit development selector;
13. invokes only that installed wrapper with the literal `setup` command unless `--install-only` was explicitly requested.

The generated wrapper still permits an explicit local `--ref`/`--branch` override. Remote task content does not participate in installer selection.

The installed component is deliberately **not** copied with a `src/entry/*` wildcard. Its file membership is an explicit installer contract. Adding a new permanent-entry dependency therefore requires an intentional installer/test review rather than silently expanding the host-installed trusted component.

Inspect which entry component and exact default runner were installed with:

```text
devbridge-entry entry-install-status
```

`entry-install-status` is wrapper-owned and does not import the installed component first, so the local operator can still identify the selected installed component when that component itself needs repair.

## Nested acquisition boundary

The Git-free exact-source acquisition logic is not embedded in `install-devbridge.mjs`. It is a nested bootstrap LEGO under `src/bootstrap/` with a narrow contract:

- accept one exact 40-hex revision;
- accept the fixed reviewed relative component paths;
- fetch only from the fixed HTTPS raw-source base;
- enforce path containment, per-file and aggregate byte bounds, and no redirects;
- create private disposable materialization;
- remove partial materialization on failure;
- return the exact prepared root to the installer.

It does not know PATH, wrapper topology, GitHub repository selection, Ubuntu authority, Hyper-V, VM identity, or setup/provider behavior. The parent bootstrap retains sequencing and exact-subject authority; the permanent-entry installer retains manifest admission and publication authority.

## Dependency boundary

Node.js 22.16.0 or newer is the only assumed zero-state runtime prerequisite.

The direct standalone installer still has a managed Git compatibility path for explicit moving-ref/local-fixture qualification when it was invoked as an already-present file. The supported zero-state exact-subject path does not execute Git for component acquisition.

Later setup paths own later system prerequisites instead of treating them as bootstrap assumptions. Ownership continues until the prerequisite is verified usable or its adapter proves a genuine external-authority boundary. A missing dependency alone is not a reason to hand package installation to the operator.

The current setup dependency behavior includes:

- `gpgv`/`gpgv.exe` is executed as a usability probe before Ubuntu release-signature verification consumes it;
- on Windows, an already-usable verifier is reused without package mutation;
- when the verifier is absent and setup is already elevated, the owning Windows prerequisite adapter fetches only the exact runtime-pinned official GnuPG 2.5.21 Windows installer with bounded Node networking, verifies its pinned SHA-256 before execution, performs the Nullsoft silent installation, cleans the transient installer, and re-discovers `gpgv.exe` from the refreshed system/user PATH or the package-owned `GnuPG\bin` location under Program Files before executing it and claiming readiness;
- the exact discovered verifier executable is carried only as a local binding into Ubuntu release verification, allowing the same setup invocation to continue even when the parent process cannot see a newly persisted PATH; that local path is not projected through remote `setup.status`;
- a non-elevated missing verifier stops before download/mutation at the elevation boundary; digest disagreement, download/integrity failure, installer failure, or an unusable post-install verifier is a focused resumable blocker rather than an instruction to install a package manually;
- on Windows, setup inspects OpenSSH Client readiness and may establish only the exact `OpenSSH.Client~~~~0.0.1.0` Windows capability when it is `NotPresent` and the current setup process is already elevated;
- OpenSSH establishment is verified by re-inspecting `ssh.exe` and `ssh-keygen.exe` afterward;
- non-elevated setup, pending servicing/restart state, servicing-policy/source failure, or inconsistent capability state stops with a resumable blocker;
- setup never self-elevates or silently enables/restarts Hyper-V;
- provider/image tooling and Hyper-V readiness remain independently verified by the read-only physical status/preflight owner.

DevBridge currently declares no npm runtime dependencies. `npm install` is therefore not part of self-install recovery. If JavaScript dependencies are introduced later, they must use an exact lockfile-backed installation/verification path such as `npm ci` rather than treating npm as a general system dependency manager.

## Direct-installer Git isolation

The command-line source authority is fixed to `iteathen/DevBridge`.

When the direct installer uses its compatibility Git acquisition path, Git runs with a deliberately reduced environment:

- inherited user/system Git configuration is disabled;
- inherited `GIT_*`, SSH command/agent, askpass, and credential-helper authority is not accepted;
- interactive credential prompting is disabled;
- only the platform process prerequisites, locale/temp values, and standard proxy transport variables needed to reach the fixed source are retained;
- `protocol.ext` is disabled and local `file` transport is disabled in production installation.

The internal local-source seam exists only for deterministic tests. There is no CLI option that changes repository/source authority.

This compatibility isolation still matters for direct installer qualification, but it is not a zero-state requirement because the normal exact-subject bootstrap does not invoke Git.

## Filesystem and component admission

After the installation home is canonicalized, installer-owned `entry`, `components`, `staging`, `quarantine`, and `bin` directories must be real directories at their owned boundary. Symlinked installer-owned directory/file targets fail closed.

Component manifests use canonical `/`-separated relative names. Backslashes, traversal segments, absolute/drive-shaped paths, duplicate records, unknown files, missing files, symlinks, and digest/size mismatches are rejected.

A verified component must contain exactly the reviewed permanent-entry file set plus its installer manifest. An unrelated future file appearing under `src/entry` does not become installed authority automatically.

Prepared zero-state source is accepted only when it is an absolute real directory explicitly paired with the same exact subject the installer is committing. The installer still reads/copies each fixed component through its containment checks; prepared source does not bypass manifest admission.

## Corruption and retained evidence

An installed component is reused only when its exact manifest and every admitted file verify.

If the exact component path exists but verification fails, the installer does not recursively delete the bad bytes. It moves that object into the installer-owned quarantine and reconstructs the exact component from the selected exact source. Older valid content-addressed components are likewise not deleted by ordinary installation.

This keeps repair evidence separate from the active exact component and avoids turning automatic repair into broad cleanup authority.

Partial zero-state source materialization is disposable. If acquisition is interrupted, the exact-source child removes its incomplete root while the durable selection record remains. The next supported invocation reacquires the same fixed component set from the same persisted exact commit.

## Wrapper transaction and commit

`devbridge-entry.cmd` and the Unix `devbridge-entry` file are fixed delegates to `devbridge-entry.mjs`; they do not contain runner/component selection authority.

For a replacement:

1. all existing wrapper targets are checked to be real regular files rather than filesystem indirection;
2. replacement files are fully written and permissioned in same-directory staging names;
3. the currently active JavaScript wrapper, when present, is first published as `devbridge-entry.previous.mjs`;
4. fixed platform delegates are published;
5. the new JavaScript wrapper is published last.

There is no fallible backup/copy/chmod step after JavaScript activation. If staging, rollback preservation, or delegate publication fails first, the previous JavaScript authority remains active.

Installer processes are serialized by a local installation lock. The lock has exact owner evidence, rejects a live competing installer, and reclaims a stale lock only after the recorded owner process is no longer live. Lock cleanup is not itself allowed to turn a completed authority transition into a reported installation failure.

The setup handoff occurs only after the installer lock has been released and the exact wrapper transaction is complete. A setup blocker therefore cannot roll back or corrupt an already committed permanent-entry installation. Stage 0 clears its durable bootstrap selection only after that installation commit succeeds.

The legacy Stage-0 launcher remains separate from this transaction. Full Stage-0 retirement remains a separate #159 cutover/qualification decision.

## Setup recovery and physical gate

`devbridge setup` is the ordinary repair/resume surface after permanent entry commits.

Setup persists accepted GitHub identity/repository selection and the exact Ubuntu package snapshot before later prerequisite and construction-authority work. Re-entry therefore preserves accepted authority unless the operator explicitly changes it.

After prerequisite reconciliation and Ubuntu authority verification, setup calls only the production-image canary `status()` surface. It never calls physical construction `run()` as part of install/setup recovery.

A status result may report a genuine external-authority/provider/tool/elevation/storage/memory/keyring blocker or may report that the construction gate is ready. Neither outcome means setup constructed an image or VM. Physical construction remains a separate explicit gate.

## Security boundary

There is no CLI option for arbitrary repository URLs, filesystem sources, signing-policy changes, provider identities, VM objects, credentials, or repository task authority.

An explicit `--ref`/`--branch` is local development authority. It is bound to an exact immutable commit before installed content is admitted. The installed permanent-entry component remains provider-, repository-task-, model-, and guest-topology-agnostic.

The install-to-setup transition does not widen installer authority. It launches the exact installed permanent-entry wrapper with a fixed `setup` argument and preserves the setup result. Setup remains the owner of discovery, configuration, PATH, prerequisite reconciliation, provider/image status gates, and later locally authorized effects.

The self-installer does not make the permanent-entry component responsible for VM lifecycle, repository execution, CUDA/GPU support, model selection, or runtime supervision. Those remain separate downstream LEGO responsibilities.

## Qualification boundary

Hosted qualification proves the zero-state exact-subject path on Windows and Linux without touching the physical development host. Focused tests cover durable branch binding, Git-unreachable component acquisition, partial acquisition cleanup, component/wrapper recovery, setup-owned prerequisite acquisition and verification, same-invocation local binding, re-entry, bad-package fail-closed behavior, and the `status()`-only setup gate.

The first real-host attempt exposed missing-GPGV handling as an incomplete #238 prerequisite contract, so #238 remains open until the corrected behavior is qualified and proved on the real Windows host. Do not manually preinstall that dependency to bypass the qualification case. The next authorized real-host setup pass must exercise setup-owned reconciliation and then stop at the read-only physical status gate; no installer/setup work here authorizes image or VM construction automatically.
