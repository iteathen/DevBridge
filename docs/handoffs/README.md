# Historical handoffs

This directory contains point-in-time recovery records: what a controller knew, completed, and intended to do next when the record was written.

Some files use the former PATCH-POLLER name and PP-* identifiers. Treat those as historical terminology. Use the [current developer instructions](../../AGENTS.md), [architecture](../architecture.md), and [roadmap](../roadmap.md) for current DevBridge behavior.

Handoffs accompanied by `.sha256` files are checksum-bound evidence. Preserve the original artifacts; corrections and current progress belong in live documentation.

For fresh-controller recovery, follow the current DB-014 contract and [operations guide](../operations.md). Reconcile present task and repository state before following a historical next action.
