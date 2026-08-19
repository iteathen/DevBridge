# DevBridge naming and compatibility

The product name is **DevBridge**.

New user-facing names use `DevBridge` for the product and `devbridge` for the CLI/bootstrap entrypoint. The repository is intended to be `iteathen/DevBridge`.

The rename deliberately does **not** rewrite every v1 protocol identifier. Strings such as `patch-poller/task-v1`, `patch-poller/context-v1`, `patch-poller/task-lease-v1`, release-manifest subjects, daemon-control records, and other `patch-poller/*` protocol names are durable compatibility identifiers. They are not current product branding.

Likewise, existing installations may continue using legacy `~/.patch-poller` state and the `patch-poller.mjs` launcher. New installations should use `devbridge.mjs` and `~/.devbridge`.

Do not rename durable protocol identifiers or persisted state keys merely for cosmetic consistency. Such changes require an explicit versioned migration with backward-reading support, tests, and recovery behavior.

## Repository rename

GitHub redirects existing web and Git remote traffic after a repository rename. Existing clones and bootstrap runtimes can therefore continue using the former repository URL during the migration, but new documentation and new installations should use the DevBridge repository URL.

Do not reuse the old repository name for a new repository; doing so can destroy GitHub's redirect from the former location.

## Package and CLI transition

The canonical CLI name is `devbridge`.

The legacy `patch-poller` binary/package identity remains available during the compatibility window because current bootstrap/runtime validation and existing installations may depend on it. Removing those aliases is a separate compatibility migration, not part of the branding rename.
