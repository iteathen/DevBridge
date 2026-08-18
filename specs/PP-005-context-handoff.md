# PP-005 — Context Capsules and Handoffs

Status: active

## Goal

No run may depend on a model remembering prior turns. Every coding-tool invocation can be treated as a fresh context window.

## Context capsule v1

A capsule is structured data with protocol `patch-poller/context-v1` and includes, when available:

- task identity and immutable revision digest;
- objective/instructions;
- trusted constraints;
- provenance for remote/local inputs;
- prior decisions and rationale summaries;
- completed progress;
- changed files;
- tests/builds and their outcomes;
- branch and HEAD identity;
- blockers/unresolved questions;
- next step;
- bounded recent tool-output tail;
- sequence number and timestamps.

Local capability grants and credentials are not copied into the model-visible capsule. The capsule may describe effective constraints (for example, `outside-project writes denied`) without exposing secrets.

## Turn protocol

A multi-turn runner writes the complete current capsule to a poller-owned run file and/or stdin for every invocation. A tool adapter may parse a structured result from the coding tool, but failure to emit a perfect result must not erase existing context.

The next capsule merges explicit durable state with new bounded observations. Critical constraints and unfinished work are retained before expendable transcript tail.

## Remote updates

Progress reports include a condensed context capsule so a chat-only coordinating agent can understand current state without relying on conversation memory.

Terminal handoffs include the fuller capsule. If it exceeds a single safe comment budget, it is deterministically chunked with:

- run ID;
- chunk index/count;
- whole-payload SHA-256;
- task revision digest.

Chunking is used only when necessary because each additional comment is an API mutation.

## Redaction

All capsule material is redacted before remote publication. A local, richer run record may exist, but it is still bounded and must not intentionally record credentials.
