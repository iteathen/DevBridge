# PP-001 — System Contract

Status: active

## Goal

Provide a durable bridge between trusted GitHub-issued coding tasks and a locally controlled development environment without making GitHub, a coding model, or repository content the security authority for the machine.

## Required ports

The application layer depends on narrow contracts for:

- `TaskSource`: discover task revisions.
- `StatusSink`: publish coalesced progress, feedback requests, and terminal handoffs.
- `CredentialProvider`: provide GitHub credentials only to the GitHub adapter.
- `StateStore`: persist restart-critical state atomically.
- `WorkspaceManager`: map repository identity to managed local workspace and provision safely.
- `ToolRunner`: run a locally configured coding tool under a declared containment contract.
- `Clock`: make polling/backoff behavior testable.
- `Logger`: bounded local observability.

Adapters may be replaced independently. Application logic must not depend on GitHub issue JSON shapes or Node child-process details.

## Run lifecycle

A run uses explicit states:

`discovered -> validated -> claimed -> preparing -> running -> verifying -> reporting -> completed`

Terminal alternatives are `blocked`, `failed`, and `cancelled`.

State transitions are persisted before irreversible or externally visible follow-up actions when practical. A restart may resume or conservatively stop; it must not silently execute the same task revision twice merely because memory was lost.

## Single-worker assumption

Version 1 supports one active worker per queue. Local process locking is required before daemon mode is considered production-ready. Distributed task claiming is out of scope until GitHub-side coordination can provide a credible lease/ownership protocol.

## Project identity

Remote input identifies projects by repository identity, never by a local path. Local policy owns the mapping. The canonical v1 form is `owner/name` with conservative GitHub-compatible segment validation.

## Dependency policy

Prefer Node standard-library capabilities. A dependency is justified only when it materially improves a boundary that would otherwise be fragile, especially authentication, sandboxing, or platform integration.
