# Self-install and permanent-entry qualification

DevBridge supports a standalone installer for the permanent-entry component without replacing the existing Stage-0 launcher.

The installer is `install-devbridge.mjs`. It has only Node.js built-in imports and can be downloaded into an otherwise empty directory. The installer remains an installation/control-plane boundary: source authority, installed component membership, filesystem ownership, and wrapper activation are closed local contracts. After that boundary commits successfully, normal CLI use immediately hands off to the exact installed runner's public `setup` surface; setup/provider/image behavior is not duplicated inside the installer.

## Stable/default install

With no selector, the installer resolves the exact current `main` head, installs the permanent-entry component bound to that exact commit, leaves normal stable runner selection active, and then enters `devbridge setup` through the installed entry:

```text
node install-devbridge.mjs
```

The generated entry is:

```text
~/.devbridge/bin/devbridge-entry.mjs
```

On Windows the installer also writes `devbridge-entry.cmd`; on Unix-like hosts it writes `devbridge-entry`.

If setup reaches a real authentication/elevation/reboot/repository-selection/provider/readiness boundary, its exit status is preserved. The permanent entry remains installed, and the operator resumes through the normal `devbridge setup` re-entry surface rather than reinstalling.

For explicit installer-only qualification/recovery, stop before the setup handoff with:

```text
node install-devbridge.mjs --install-only
```

The installer does **not** overwrite `~/.devbridge/bin/devbridge.mjs`. The existing Stage-0 launcher therefore remains available during permanent-entry qualification and cutover.

## Explicit development/qualification install

A local operator can install from a development branch without turning the moving branch name into runtime identity:

```text
node install-devbridge.mjs --ref cuda-target
```

The installer:

1. resolves the fixed DevBridge repository branch to one exact commit;
2. fetches that exact subject into private staging;
3. verifies exact `HEAD`, fixed origin, and clean source state;
4. copies only the explicitly reviewed permanent-entry dependency closure into a new component;
5. records and verifies exact per-file SHA-256 evidence for that closed component;
6. preserves an existing active JavaScript wrapper before any replacement can become active;
7. stages the platform delegates and JavaScript wrapper before publication;
8. publishes the JavaScript wrapper last as the authority-changing step;
9. pins the resolved exact runner commit as the wrapper's default selection;
10. invokes only that installed wrapper with the literal `setup` command unless `--install-only` was explicitly requested.

The generated wrapper still permits an explicit local `--ref`/`--branch` override. Remote task content does not participate in installer selection.

The installed component is deliberately **not** copied with a `src/entry/*` wildcard. Its file membership is an explicit installer contract. Adding a new permanent-entry dependency therefore requires an intentional installer/test review rather than silently expanding the host-installed trusted component.

Inspect which entry component and exact default runner were installed with:

```text
devbridge-entry entry-install-status
```

`entry-install-status` is wrapper-owned and does not import the installed component first, so the local operator can still identify the selected installed component when that component itself needs repair.

## Fixed source and Git isolation

The command-line source authority is fixed to `iteathen/DevBridge`.

Git used for installer acquisition runs with a deliberately reduced environment:

- inherited user/system Git configuration is disabled;
- inherited `GIT_*`, SSH command/agent, askpass, and credential-helper authority is not accepted;
- interactive credential prompting is disabled;
- only the platform process prerequisites, locale/temp values, and standard proxy transport variables needed to reach the fixed source are retained;
- `protocol.ext` is disabled and local `file` transport is disabled in production installation.

The internal local-source seam exists only for deterministic tests. There is no CLI option that changes repository/source authority.

This separation matters because a fixed command-line URL is not a fixed source boundary if inherited Git configuration can rewrite that URL.

## Filesystem and component admission

After the installation home is canonicalized, installer-owned `entry`, `components`, `staging`, `quarantine`, and `bin` directories must be real directories at their owned boundary. Symlinked installer-owned directory/file targets fail closed.

Component manifests use canonical `/`-separated relative names. Backslashes, traversal segments, absolute/drive-shaped paths, duplicate records, unknown files, missing files, symlinks, and digest/size mismatches are rejected.

A verified component must contain exactly the reviewed permanent-entry file set plus its installer manifest. An unrelated future file appearing under `src/entry` does not become installed authority automatically.

## Corruption and retained evidence

An installed component is reused only when its exact manifest and every admitted file verify.

If the exact component path exists but verification fails, the installer does not recursively delete the bad bytes. It moves that object into the installer-owned quarantine and reconstructs the exact component from the selected Git subject. Older valid content-addressed components are likewise not deleted by ordinary installation.

This keeps repair evidence separate from the active exact component and avoids turning automatic repair into broad cleanup authority.

## Wrapper transaction and rollback

`devbridge-entry.cmd` and the Unix `devbridge-entry` file are fixed delegates to `devbridge-entry.mjs`; they do not contain runner/component selection authority.

For a replacement:

1. all existing wrapper targets are checked to be real regular files rather than filesystem indirection;
2. replacement files are fully written and permissioned in same-directory staging names;
3. the currently active JavaScript wrapper, when present, is first published as `devbridge-entry.previous.mjs`;
4. fixed platform delegates are published;
5. the new JavaScript wrapper is published last.

There is no fallible backup/copy/chmod step after JavaScript activation. If staging, rollback preservation, or delegate publication fails first, the previous JavaScript authority remains active.

Installer processes are serialized by a local installation lock. The lock has exact owner evidence, rejects a live competing installer, and reclaims a stale lock only after the recorded owner process is no longer live. Lock cleanup is not itself allowed to turn a completed authority transition into a reported installation failure.

The setup handoff occurs only after the installer lock has been released and the exact wrapper transaction is complete. A setup blocker therefore cannot roll back or corrupt an already committed permanent-entry installation.

The legacy Stage-0 launcher remains separate from this transaction. Full Stage-0 retirement remains a separate #159 cutover/qualification decision.

## Security boundary

There is no CLI option for arbitrary repository URLs, filesystem sources, signing-policy changes, provider identities, VM objects, credentials, or repository task authority.

An explicit `--ref`/`--branch` is local development authority. It is resolved once to an exact immutable commit before installed content is admitted. The installed permanent-entry component remains provider-, repository-task-, model-, and guest-topology-agnostic.

The install-to-setup transition does not widen installer authority. It launches the exact installed permanent-entry wrapper with a fixed `setup` argument and preserves the setup result. Setup remains the owner of discovery, configuration, PATH, provider/image status gates, and any later locally authorized effects.

The self-installer does not make the permanent-entry component responsible for VM lifecycle, repository execution, CUDA/GPU support, model selection, or runtime supervision. Those remain separate downstream LEGO responsibilities.
