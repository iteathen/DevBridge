# Contributing to DevBridge

DevBridge welcomes focused issues and pull requests. Read [`AGENTS.md`](AGENTS.md), the applicable `specs/DB-*` contracts, [`docs/design-principles.md`](docs/design-principles.md), and [`docs/portfolio-readiness.md`](docs/portfolio-readiness.md) before changing behavior.

Use a fork or topic branch and keep each pull request to one coherent ownership-sized change. Explain the authoritative owner, trust boundary, failure modes, recovery behavior, the highest-risk unproven boundary being advanced, and the cheapest decisive validation. Provider-specific behavior belongs behind provider-neutral VM lifecycle and bridge contracts; repository-controlled execution must never fall back to the host.

Do not represent a missing real-provider/host/CI qualification environment as a code defect without independent falsification. Keep architectural disposition, implementation status, qualification/support status, and priority separate. Once a boundary is sufficiently specified, prefer the thinnest meaningful executable proof through the intended contracts over more speculative layering; performance or concurrency expansion requires a real workload or measured bottleneck.

Run at least:

```text
npm run preflight
npm test
node src/cli.js doctor --config config/devbridge.example.json
```

State any unavailable real-provider checks explicitly. Mocks and hosted CI are useful regression evidence but do not replace real Hyper-V/KVM qualification for claims that depend on those boundaries.

By contributing, you agree that your contribution is licensed under the repository's AGPL-3.0-only license. Follow the shared code of conduct. Report vulnerabilities privately through [`SECURITY.md`](SECURITY.md).
