# CUDA-JS Issue #4 Preparation Through DevBridge

Status: current non-qualifying preparation boundary and execution recipe.

CUDA-JS issue #4 is the authoritative qualification contract. Its current acceptance condition is one coherent run on a **native Ubuntu 24.04 x86-64 host with a directly exposed physical NVIDIA GPU**. The issue explicitly states that VM, emulated, WSL, container, hosted-CI, portable, mock and source-review evidence do not qualify that native Linux cell.

DevBridge's current governing boundary is also explicit: repository-controlled code runs only inside an admitted execution-profile VM/workspace; there is no direct-host repository-execution fallback. Those two contracts therefore do **not** currently compose into a qualifying CUDA-JS #4 run.

DevBridge can still perform useful Linux **preparation and falsification** before an external contributor runs the unchanged native qualification chain. It can prove that a repository checkout installs in an admitted Linux profile, exercise the repository's non-native Linux-readiness commands, verify controller/profile routing, and return bounded evidence. That result must remain labeled non-qualifying preparation. It does not clear an OS axis, GPU axis, or any other subset of CUDA-JS #4.

## Authoritative CUDA-JS #4 boundary

Current CUDA-JS #4 requires all of these together on the qualifying host:

- native Ubuntu 24.04 LTS, x86-64/glibc;
- a directly exposed physical NVIDIA GPU and working native Driver/device nodes;
- exact Node v26.7.0 and required compiler/toolkit providers;
- a clean exact CUDA-JS checkout; and
- the unchanged repository-owned `npm run hardware:qualify` chain after reviewing `npm run hardware:plan -- --profile=linux-native-x64`.

The complete evidence bundle is retained locally and only its sanitized public summary/first failure is published. Promotion is exact-profile only.

Because current DevBridge repository execution is VM-only, a successful DevBridge run is not evidence that these acceptance conditions have been met.

## Useful DevBridge preparation task

Work still enters through the normal GitHub issue task protocol. A trusted actor can open or update a DevBridge queue issue with exactly one `devbridge-task` block targeting `iteathen/CUDA-JS`.

The task may request a neutral Linux profile for **non-qualifying readiness**:

```json
{
  "protocol": "devbridge/task-v1",
  "target": { "repository": "iteathen/CUDA-JS" },
  "instructions": "Run non-qualifying CUDA-JS Linux readiness/preparation checks on an admitted Linux execution profile and report the exact pass/fail evidence. Do not bypass DevBridge's VM-only repository-execution boundary and do not claim that any part of CUDA-JS issue #4 is qualified by this run.",
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

This is a preparation recipe, not qualification authority. The local operator configuration must still admit the repository, trust the actor, enable execution, load the operation manifests, and provide a route satisfying `profile:linux`.

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

The profile name is a DevBridge routing label. It does not make the VM a CUDA-JS `linux-native-x64` qualification host, and it must not be reported as such.

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

Each operation must run through the selected repository execution profile, inherit the profile's approved Node/npm toolchain, and keep output bounded. These scripts are useful preparation checks because they are current CUDA-JS package scripts; passing them still does not authorize any native-Linux support claim.

## Relationship to the real contributor run

The qualifying run remains outside the current DevBridge repository-execution path. On an accepted native Ubuntu/physical-NVIDIA host, the contributor follows CUDA-JS #4 directly:

```text
npm ci
npm run hardware:plan -- --profile=linux-native-x64
npm run hardware:qualify
```

DevBridge preparation may catch package, Node, Linux-readiness, controller-plan or cleanup failures before that scarce physical-host run. It may not rewrite, split, weaken, or partially satisfy the upstream acceptance contract.

## Remaining Gaps

1. **Qualification-boundary mismatch:** current DevBridge repository execution is VM-only; current CUDA-JS #4 explicitly rejects VM evidence. Therefore DevBridge cannot presently execute a qualifying #4 run.
2. **Physical-host availability:** a clean native Ubuntu 24.04 x86-64 host with a directly exposed physical NVIDIA GPU and the exact required providers is still needed for #4.
3. **Runtime-substrate preparation:** the selected DevBridge Linux profile should still prove its own distribution/version, architecture, glibc, kernel, Node/npm identity, compiler/toolchain availability and permissions so preparation failures are not confused with CUDA-JS native qualification failures.
4. **Evidence return:** DevBridge can capture bounded stdout/stderr from preparation today; CUDA-JS #4 separately owns the complete native evidence bundle and sanitized public-summary rules for the real run.
5. **No axis splitting:** there is no accepted “Linux-only half” of #4 for DevBridge to close. Any future split would require an explicit CUDA-JS issue/specification change first, not a DevBridge documentation interpretation.

## Completion Criteria

A DevBridge preparation attempt is complete only when it truthfully proves the preparation facts it exercised:

- `requestedCapabilities` selected a locally admitted `profile:linux` route;
- repository code ran inside the admitted DevBridge VM/workspace, not on the host as a fallback;
- the exact CUDA-JS source revision, DevBridge profile identity, Linux/Node/npm/toolchain facts, command results and cleanup state are included in bounded evidence; and
- the result is labeled **non-qualifying preparation for CUDA-JS #4**.

CUDA-JS #4 itself remains incomplete until its unchanged native Ubuntu 24.04 + directly exposed physical NVIDIA qualification chain passes and the exact evidence is accepted under the CUDA-JS issue's own checklist.
