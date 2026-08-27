# Security policy

DevBridge is security-sensitive public-alpha software. It controls boundaries around untrusted repository execution, credentials, authoritative Git state, virtual machines, publication, and recovery. It is not yet production-qualified.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/iteathen/DevBridge/security/advisories/new). Do not publish exploit details, credentials, host paths, private data, proof-of-concept payloads, or sensitive logs in a public issue or discussion.

Include the affected commit, operating system/provider, expected and observed behavior, a minimal bounded reproduction, and the security boundary you believe was crossed. Scrub all secrets before attaching evidence.

If the private form is unavailable, open a minimal public issue asking the maintainer to establish a private channel. Include no vulnerability details.

## Current support boundary

There is no supported production release. Security fixes target the current development line. Hosted CI and simulated providers do not establish real Hyper-V/KVM isolation, recovery, or resource guarantees; those require the qualification identified in [`docs/roadmap.md`](docs/roadmap.md) and `DB-020`.

Never commit credentials or private keys. If one is exposed, revoke or rotate it immediately; removing it from Git history is not sufficient.
