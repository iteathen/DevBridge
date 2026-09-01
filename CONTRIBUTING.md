# Contributing to DevBridge

DevBridge welcomes focused issues and pull requests. Read [`AGENTS.md`](AGENTS.md), the applicable `specs/DB-*` contracts, [`docs/design-principles.md`](docs/design-principles.md), and [`docs/portfolio-readiness.md`](docs/portfolio-readiness.md) before changing behavior.

## AI-assisted development

DevBridge may use substantial AI-agent assistance in coding, review, research, and documentation. AI output is untrusted working material, not security evidence, an independent oracle, or proof of correctness. Contributors and maintainers remain responsible for understanding the change and for every authority, security, recovery, provenance, compatibility, test, and qualification claim attached to it.

AI-assisted contributions are welcome under the same exact-head review and validation bar as any other contribution. Routine AI use does not require a prompt log; disclose material assistance when it affects provenance, licensing, security review, reproducibility, or another repository requirement. Model agreement or model-to-model review never substitutes for adversarial tests, provider evidence, or required independent review.

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
