# Contributing to DevBridge

DevBridge welcomes focused issues and pull requests. Read [`AGENTS.md`](AGENTS.md), the applicable `specs/DB-*` contracts, and [`docs/design-principles.md`](docs/design-principles.md) before changing behavior.

Use a fork or topic branch and keep each pull request to one coherent ownership-sized change. Explain the authoritative owner, trust boundary, failure modes, recovery behavior, and the cheapest decisive validation. Provider-specific behavior belongs behind provider-neutral VM lifecycle and bridge contracts; repository-controlled execution must never fall back to the host.

Run at least:

```text
npm run preflight
npm test
node src/cli.js doctor --config config/devbridge.example.json
```

State any unavailable real-provider checks explicitly. Mocks and hosted CI are useful regression evidence but do not replace real Hyper-V/KVM qualification for claims that depend on those boundaries.

By contributing, you agree that your contribution is licensed under the repository's AGPL-3.0-only license. Follow the shared code of conduct. Report vulnerabilities privately through [`SECURITY.md`](SECURITY.md).
