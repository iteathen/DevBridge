## Outcome

Describe the user-visible or engineering outcome and its authoritative owner.

## Trust and LEGO boundaries

Identify affected capabilities, security/recovery boundaries, provider adapters, and substitution/deletion effects. Confirm that repository-controlled execution cannot gain host authority or a host fallback.

## Validation

List exact checks and evidence. State explicitly which real Hyper-V/KVM or other environment-dependent checks were not run.

- [ ] I read the applicable `AGENTS.md` and `specs/DB-*` authority.
- [ ] I preserved provider-neutral core vocabulary and kept provider details inside adapters.
- [ ] I added or updated tests for changed behavior and failure/recovery paths.
- [ ] I did not add secrets, private paths, or sensitive evidence.
