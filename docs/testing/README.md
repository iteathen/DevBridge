# Testing and audit evidence

Documents in this directory are **point-in-time test/audit records**. They preserve what was tested, observed, missing, or recommended at a particular repository state.

They are useful for provenance and regression archaeology, but they are not a live feature-status matrix.

For current implementation and remaining work, use:

- active `specs/PP-*.md` contracts;
- current `README.md`;
- `docs/architecture.md`;
- `docs/roadmap.md`;
- current CI/tests and exact-head acceptance evidence.

When a historical audit says a feature is missing but a later accepted PR/spec implements it, keep the audit unchanged and update the live documentation instead. Conversely, a historical passing audit does not prove current correctness after later changes; current acceptance must come from current tests/evidence.

`PP-DURABILITY-AUDIT-0818.md` predates multiple later hardening and capability slices, including the DB-013 controller-plan campaign, DB-014 context rollover, DB-015 tool inventory/onboarding, DB-016 leases/fencing, DB-017 baseline reverification, and DB-018 runtime governance. Read it as historical evidence only.
