# CUDA-JS Issue #4 Linux Gate Through DevBridge

Status: current implementation gap map and execution recipe.

CUDA-JS issue #4 originally grouped OS, Node, CUDA toolkit, and physical GPU evidence. The current managed-risk split treats the physical GPU gate as already handled separately. This document covers only the remaining Linux OS/profile gate through DevBridge.

DevBridge's governing boundary remains unchanged: repository-controlled code must run inside an admitted execution-profile VM/workspace, with GitHub credentials, authoritative Git state, provider management, route policy, and evidence publication retained by the host. The correct goal for this slice is a DevBridge-submitted Linux qualification attempt with truthful evidence identity and claim limits. It must not re-open or depend on the separate GPU gate.

## Required GitHub Interface

Work must enter through the normal GitHub issue task protocol. A trusted actor opens or updates a DevBridge queue issue with exactly one `devbridge-task` block targeting `iteathen/CUDA-JS`.

The task may request a neutral Linux profile capability:

```json
{
  "protocol": "devbridge/task-v1",
  "target": { "repository": "iteathen/CUDA-JS" },
  "instructions": "Run the CUDA-JS Linux gate checks on an admitted Linux execution profile and report the exact pass/fail evidence. Do not bypass DevBridge's repository execution boundary. Do not include the separate GPU gate in this claim.",
  "requestedCapabilities": ["profile:linux"],
  "controllerPlan": {
    "protocol": "devbridge/controller-plan-v1",
    "operations": [
      { "id": "install", "operation": "tool.npm-ci", "params": {} },
      { "id": "node", "operation": "tool.cuda-js-node-check", "params": {} },
      { "id": "f6", "operation": "tool.cuda-js-f6-linux-readiness", "params": {} },
      { "id": "f7", "operation": "tool.cuda-js-f7-linux-readiness", "params": {} },
      { "id": "f8", "operation": "tool.cuda-js-f8-linux-readiness", "params": {} },
      { "id": "f9", "operation": "tool.cuda-js-f9-linux-readiness", "params": {} }
    ],
    "assertions": [
      { "kind": "exit-equals", "operation": "install", "value": 0 },
      { "kind": "exit-equals", "operation": "node", "value": 0 },
      { "kind": "exit-equals", "operation": "f6", "value": 0 },
      { "kind": "exit-equals", "operation": "f7", "value": 0 },
      { "kind": "exit-equals", "operation": "f8", "value": 0 },
      { "kind": "exit-equals", "operation": "f9", "value": 0 },
      { "kind": "workspace-clean" }
    ]
  }
}
```

This is a recipe, not authority by itself. The local operator configuration must still admit the repository, trust the actor, enable execution, load the operation manifests, and provide a route satisfying `profile:linux`.

## Local Route Requirement

The execution route for the CUDA-JS stable repository identity must point to a compatible Linux profile. Capability strings are local policy metadata; GitHub task text cannot name host device IDs, PCI addresses, sockets, service names, driver paths, provider commands, VM attachment objects, or any other provider-native selector.

Example route shape:

```json
{
  "protocol": "devbridge/environment-execution-routes-v1",
  "routes": [
    {
      "subject": "<github-repository-id-for-iteathen/CUDA-JS>",
      "profile": "linux-native-x64",
      "capabilities": ["profile:linux"],
      "preferred": true,
      "validation": false,
      "access": { "family": "linux", "user": "devbridge", "identityFile": "<local-host-path>", "knownHostsFile": "<local-host-path>" }
    }
  ]
}
```

## Local Operation Manifests

The DevBridge controller plan must reference locally registered operations, not shell commands. Operator-owned local operation manifests can express the required package-script calls without expanding GitHub task authority.

Examples:

```json
{
  "protocol": "devbridge/local-operation-manifest-v1",
  "operation": "tool.npm-ci",
  "executable": "npm",
  "arguments": [{ "kind": "literal", "value": "ci" }],
  "timeoutMs": 1800000,
  "maxOutputBytes": 4194304,
  "requireAnyParameter": false,
  "source": { "kind": "operator" }
}
```

```json
{
  "protocol": "devbridge/local-operation-manifest-v1",
  "operation": "tool.cuda-js-node-check",
  "executable": "npm",
  "arguments": [
    { "kind": "literal", "value": "run" },
    { "kind": "literal", "value": "node:check" }
  ],
  "timeoutMs": 1800000,
  "maxOutputBytes": 4194304,
  "requireAnyParameter": false,
  "source": { "kind": "operator" }
}
```

```json
{
  "protocol": "devbridge/local-operation-manifest-v1",
  "operation": "tool.cuda-js-f6-linux-readiness",
  "executable": "npm",
  "arguments": [
    { "kind": "literal", "value": "run" },
    { "kind": "literal", "value": "f6:linux-readiness" }
  ],
  "timeoutMs": 1800000,
  "maxOutputBytes": 4194304,
  "requireAnyParameter": false,
  "source": { "kind": "operator" }
}
```

Equivalent manifests are needed for:

- `tool.cuda-js-f7-linux-readiness` -> `npm run f7:linux-readiness`;
- `tool.cuda-js-f8-linux-readiness` -> `npm run f8:linux-readiness`;
- `tool.cuda-js-f9-linux-readiness` -> `npm run f9:linux-readiness`.

Each operation must run through the selected repository execution profile, inherit the profile's approved Node/npm toolchain, and keep output bounded.

```json
{
  "protocol": "devbridge/local-operation-manifest-v1",
  "operation": "tool.cuda-js-f9-linux-readiness",
  "executable": "npm",
  "arguments": [
    { "kind": "literal", "value": "run" },
    { "kind": "literal", "value": "f9:linux-readiness" }
  ],
  "timeoutMs": 1800000,
  "maxOutputBytes": 4194304,
  "requireAnyParameter": false,
  "source": { "kind": "operator" }
}
```

## Remaining Gaps

1. Acceptance split gap: CUDA-JS issue tracking must recognize that this attempt clears only the Linux OS/profile axis. The already-handled GPU axis must remain separate evidence and must not be requalified or implied by this run.
2. Physical profile gap: DevBridge must have a proven Linux execution profile that can run repository code through the DB-020 boundary. This is a Linux VM/workspace readiness requirement, not an accelerator transport requirement.
3. Runtime substrate gap: the selected profile must provide exact Linux distribution/version, architecture, glibc, kernel, Node v26.7.0, npm pairing, compiler/toolchain availability required by the readiness scripts, and permissions as profile evidence, not as assumptions.
4. Evidence return gap: CUDA-JS Linux readiness commands currently return process output rather than a single standardized public issue summary. DevBridge can capture bounded stdout/stderr today; a cleaner workflow would add a CUDA-JS public-summary emitter or a DevBridge-owned evidence-artifact transfer contract.
5. Tracker reconciliation gap: the originating GitHub task and CUDA-JS issue must record exactly which axis was demonstrated. The result must not claim broader CUDA, GPU, performance, or universal Linux support.

## Completion Criteria

A DevBridge-mediated attempt can clear only the evidence it actually proves:

- `requestedCapabilities` route selection chose a locally admitted `profile:linux` profile;
- repository code ran inside the admitted DevBridge repository-execution environment, not on the host as a fallback;
- the exact CUDA-JS source commit/tree, Linux distribution/version, architecture, glibc, kernel, Node/npm identity, profile generation, command results, and cleanup state are included in bounded evidence;
- the sanitized summary or first failure is returned through the originating GitHub task;
- CUDA-JS maintainers accept the demonstrated Linux axis before issue #4 is closed or promoted for that axis.
