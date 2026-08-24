# Testing and audit evidence

This directory contains both current testing guidance and point-in-time test/audit records.

## Current guidance

`verification-governance.md` is live engineering guidance for the normative `specs/DB-019-verification-cost-evidence.md` contract. It defines how DevBridge should reason about expensive/long-running verification, test tiers, risk-driven selection, durable evidence reuse, selective invalidation, per-suite timing, resumability, liveness, and future resource-aware scheduling.

The core principle is that long tests are allowed when they provide required evidence, but expensive tests must not run accidentally, redundantly, silently, or without a defined reason for being on the candidate's verification path.

## Historical audits

Other audit documents in this directory are **point-in-time test/audit records**. They preserve what was tested, observed, missing, or recommended at a particular repository state.

`DB-HO005-issue-197-physical-qualification.md` records the physical Windows/Hyper-V problems, bounded solutions, exact accepted PR evidence, and preserved host state encountered while qualifying issue #197. It remains point-in-time evidence; issue #197 and exact current code/CI govern subsequent progress.

They are useful for provenance and regression archaeology, but they are not a live feature-status matrix.

For current implementation and remaining work, use:

- active `specs/DB-*.md` contracts;
- current `README.md`;
- `docs/architecture.md`;
- `docs/roadmap.md`;
- current testing guidance in this directory;
- current CI/tests and exact-head acceptance evidence.

When a historical audit says a feature is missing but a later accepted PR/spec implements it, keep the audit unchanged and update the live documentation instead. Conversely, a historical passing audit does not prove current correctness after later changes; current acceptance must come from current tests/evidence whose identity is still valid under the active verification contract.

`PP-DURABILITY-AUDIT-0818.md` predates multiple later hardening and capability slices, including DB-013 controller plans, DB-014 context rollover, DB-015 tool inventory/onboarding, DB-016 leases/fencing, DB-017 baseline reverification, DB-018 runtime governance, and DB-019 verification-cost/evidence governance. Read it as historical evidence only.
