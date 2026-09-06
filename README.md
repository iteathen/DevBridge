# DevBridge

DevBridge connects remote coding controllers to a locally controlled development environment. It is a Node.js control plane for admitting development tasks, managing repository work, verifying results, and recovering interrupted runs.

**Active public alpha development. There is no published package or signed production release, and no production security claim.** Hyper-V and KVM/libvirt execution paths are implemented, but real-provider security, resource, and recovery qualification is incomplete.

## What exists

- GitHub task admission with locally configured provenance and capability rules.
- Host-owned Git state, candidate verification, and controlled publication.
- Persistent VM execution profiles with repository workspaces.
- Durable run state, checkpoints, restart recovery, and runtime updates.
- Installation identity, signed coordination leases, and fencing for multiple agents.

Repository code executes through VMs. Host credentials and control authority remain outside guests; an unavailable VM route does not fall back to direct host execution.

Task envelopes are **not cryptographically addressed to a destination workstation**. Coordination identity does not provide that isolation; runner-local queue and task-author policy must enforce it. Broader privileged or multi-user deployment requires independent security review.

## Intended development

The project aims to make remote development work reproducible and recoverable under local operator control. Installation/reconfiguration, reconstructable runtime and VM lifecycle, and real-provider qualification remain development priorities. GPU execution profiles are planned after those foundations.

See [readiness](docs/portfolio-readiness.md) and the [roadmap](docs/roadmap.md) for current progress and limits.

## Evaluate the source

Requirements: Node.js 22.16.0 or later and Git. VM execution additionally requires a configured Hyper-V host on Windows or KVM/QEMU/libvirt host on Linux.

```bash
git clone https://github.com/iteathen/DevBridge.git
cd DevBridge
npm run preflight
npm test
```

These commands check the source and regression suite; they do not configure a production installation or qualify a hypervisor. Use the [setup guide](docs/setup.md) for installation and local policy, and [operations](docs/operations.md) for running configured work.

## Further information

- [Documentation](docs/README.md), [architecture](docs/architecture.md), and [troubleshooting](docs/troubleshooting.md).
- [Contributing](CONTRIBUTING.md) and [developer instructions](AGENTS.md).
- [Private security reporting](SECURITY.md).
- [AGPL-3.0-only license](LICENSE).
