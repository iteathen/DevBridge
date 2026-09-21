# Evidence status

This repository follows the shared [iteathen evidence and validation policy](https://github.com/iteathen/.github/blob/main/EVIDENCE_POLICY.md).

## Current posture

DevBridge is an active public alpha. Its source and regression suite provide **INTERNAL-QUALIFICATION** evidence for repository-controlled behavior. They do not constitute an independent security assessment or production qualification.

## Registered claims

| Claim | Evidence class | Status |
| --- | --- | --- |
| `DEVBRIDGE-INT-001` — the maintained source passes its repository preflight/regression suite under the documented development environment | **INTERNAL-QUALIFICATION** | reproducible repository-controlled check |
| `DEVBRIDGE-SEC-001` — real-provider security/resource/recovery qualification is sufficient for production use | **UNVALIDATED** | explicitly not claimed |

Machine-readable records: [`evidence/claims.json`](evidence/claims.json).

## What current evidence establishes

The repository can demonstrate its own documented tests, architecture gates, VM execution boundaries, and recovery behaviors under the environments those tests exercise.

## What it does not establish

It does not establish production security, hostile multi-user isolation, independent penetration-test results, complete real-provider coverage, or third-party reproduction.

## Path to stronger evidence

Security claims should advance through externally controlled threat-model review and independent reproduction/assessment. Real-provider claims should preserve exact hypervisor/OS/revision evidence and failure/recovery logs.

## Non-mutation rule

Evidence work may exercise and inspect DevBridge, but must not alter host/guest control semantics or production behavior merely to make the evidence pass.
