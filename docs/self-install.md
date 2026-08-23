# Self-install and permanent-entry qualification

DevBridge supports a standalone installer for the permanent-entry component without replacing the existing Stage-0 launcher.

The installer is `install-devbridge.mjs`. It has only Node.js built-in imports and can be downloaded into an otherwise empty directory.

## Stable/default install

With no selector, the installer resolves the exact current `main` head, installs the permanent-entry component content-addressed by that exact commit, and leaves normal stable runner selection active:

```text
node install-devbridge.mjs
```

The generated entry is:

```text
~/.devbridge/bin/devbridge-entry.mjs
```

On Windows the installer also writes `devbridge-entry.cmd`; on Unix-like hosts it writes `devbridge-entry`.

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
4. copies only `devbridge-entry.mjs` plus `src/entry/*` into the installed permanent-entry component;
5. records and verifies a per-file SHA-256 manifest for the installed component;
6. atomically replaces only the `devbridge-entry.*` wrappers;
7. pins the resolved exact runner commit as the wrapper's default selection.

The generated wrapper still permits an explicit local `--ref`/`--branch` override. Remote task content does not participate in installer selection.

Inspect which entry component and exact default runner were installed with:

```text
devbridge-entry entry-install-status
```

## Corruption and rollback behavior

An installed component is reused only when its exact per-file manifest verifies. Corrupt component content is reconstructed from the exact selected Git subject.

Wrapper replacement is staged before the active wrapper is moved. The previous JavaScript wrapper is retained as `devbridge-entry.previous.mjs`. Content-addressed older entry components are not deleted by ordinary installation.

The legacy Stage-0 launcher is intentionally not removed by this installer. Full Stage-0 retirement remains a separate #159 cutover/qualification decision.

## Security boundary

The command-line installer source authority is fixed to `iteathen/DevBridge`. There is no CLI option for arbitrary repository URLs, filesystem sources, signing-policy changes, provider identities, VM objects, credentials, or repository task authority.

An explicit `--ref`/`--branch` is local development authority. It is resolved once to an exact immutable commit before installed content is admitted. The installed permanent-entry component remains provider-, repository-task-, model-, and guest-topology-agnostic.
