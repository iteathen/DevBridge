# PATCH-POLLER Bootstrap Validation and Operation

This runbook validates and operates the initial **read-only** PATCH-POLLER capability stage on Windows. It does not authorize or test repository writes, worktree creation, commits, or pushes. Those capabilities must remain blocked until the later isolated-effect-audit stages are implemented and accepted.

## 1. Safety model

PATCH-POLLER has two independent authorities:

1. **Remote dispatch authority** states a bounded objective, exact repository/branch/head, context, requested capabilities, local tool ID, arguments, and reporting policy.
2. **Local policy authority** registers repositories, workspace roots, trusted GitHub actors/apps, executable paths, argument rules, environment variables, timeouts, output limits, and credentials.

A dispatch is executable only where those two authorities intersect. A GitHub comment is not trusted merely because it contains plausible instructions. Tool output, repository content, and prior results remain data unless their context frame is explicitly classified as trusted instruction or repository authority.

The bootstrap release permits only:

- `workspace.read`
- `process.execute`
- `github.report`

It blocks:

- `workspace.write`
- `git.worktree.create`
- `git.commit`
- `git.push`

Do not weaken this gate for a smoke test.

## 2. Prerequisites

- Windows 11 or another explicitly approved Windows host
- Node.js `24.15.0` or newer within the supported `<27` range
- Git
- A clean local clone of every registered repository
- A dedicated GitHub credential with only the permissions needed by the configured mailbox

For a fine-grained personal access token, scope it to the configured repository and only the issue/comment permissions needed for polling and lifecycle reporting. For long-term operation, prefer the planned GitHub App installation-token adapter once PP-05 is implemented.

### Account-wide budget rule

Treat every process using the same GitHub credential as sharing one API budget. During bootstrap validation, run **one PATCH-POLLER process per credential identity**. Do not run a second daemon, an old bridge, or an unrelated automation process with the same token while collecting rate evidence.

## 3. Build and unit validation

From a clean checkout of the exact candidate branch:

```powershell
node --version
npm --version
npm install --no-audit --no-fund
npm run build
npm test
```

Acceptance requires:

- Node reports an allowed version;
- TypeScript strict compilation exits `0`;
- all tests pass;
- no source file is changed by build or test;
- no test is weakened or skipped merely to obtain a pass.

Record:

```powershell
git rev-parse HEAD
git status --porcelain
```

## 4. Prepare local configuration

Copy the example without modifying the tracked template:

```powershell
Copy-Item config\example.config.json config\local.config.json
```

Edit `config\local.config.json`:

- set the mailbox repository and issue number;
- set trusted human logins and/or GitHub App IDs;
- keep author-association restrictions narrow;
- set each Windows workspace root and worktree root;
- register the exact repository-to-relative-checkout mapping;
- register only the local CLI tools needed for the smoke;
- keep `bootstrap` set to `ignore_existing` unless deliberately replay-testing a controlled mailbox;
- keep polling intervals conservative.

Never place a token, GitHub App private key, or other secret in this file.

Validate the file before setting a credential:

```powershell
node dist\src\cli.js --check-config --config config\local.config.json
```

## 5. Credential setup

The example expects:

```powershell
$env:PATCH_POLLER_GITHUB_TOKEN = '<narrow credential>'
```

Use a short-lived process environment or a dedicated service credential provider. Do not place the credential in command arguments, GitHub comments, logs, dispatch context, repository files, or screenshots.

## 6. Establish the mailbox baseline

The default `ignore_existing` bootstrap mode performs one narrow baseline request, records GitHub server time, and does not execute older comments.

Run once:

```powershell
node dist\src\cli.js --once --config config\local.config.json
```

Expected result:

- no historical comment executes;
- local state is created under the configured database path;
- the request respects the configured API base and version;
- rate headers are recorded without exposing the token;
- the process exits normally.

## 7. Generate a read-only dispatch

The repository includes `examples/read-only-node-version-dispatch.mjs`. Run it from the target repository checkout so the exact head is captured locally:

```powershell
node examples\read-only-node-version-dispatch.mjs `
  --repository iteathen/PATCH-POLLER `
  --workspace projects `
  --checkout PATCH-POLLER `
  --branch agent/bootstrap-foundation `
  --tool node-version `
  --context-id patch-poller-bootstrap-smoke `
  --revision 1
```

The helper prints one complete GitHub comment containing a strict `PATCH-POLLER-DISPATCH v1` envelope. Inspect it before posting. Confirm:

- repository, branch, and exact 40-character head are correct;
- `allowed_paths` is empty;
- capabilities are exactly read, execute, and report;
- the local tool ID is expected;
- expiry is bounded;
- objective, checkpoint, and constraints are sufficient for a fresh context;
- no secret or machine-sensitive path appears.

Post the generated comment to the configured mailbox issue.

## 8. Run the daemon

```powershell
node dist\src\cli.js --config config\local.config.json
```

Expected local progress includes:

- mailbox poll completed;
- trusted dispatch accepted;
- workspace guard started and completed;
- command step started;
- output activity or periodic liveness for a silent process;
- process exit;
- final exact-head/no-change audit;
- terminal completion or a bounded block/failure.

Stop with `Ctrl+C`. Cancellation must terminate the active process tree and record a safe terminal state where possible.

## 9. Verify one-comment lifecycle reporting

A successful dispatch creates one lifecycle report comment and edits that same comment as meaningful phases change. It must not append one comment per heartbeat or output event.

Verify in GitHub:

- exactly one report comment exists for the dispatch;
- its machine marker is `PATCH-POLLER-REPORT v1`;
- `dispatch_id`, payload SHA-256, context ID/revision, and source comment reference are present;
- progress sequence increases;
- the final state is terminal;
- the handoff records completed and remaining work;
- the handoff says the primary controller chooses the next action;
- no token, private key, absolute local path, or unbounded output appears.

## 10. Verify API stewardship

Collect bounded debug logs for these facts:

- conditional headers are used after a stable response;
- a stable mailbox can return `304 Not Modified`;
- `x-poll-interval`, when present, is used as a floor;
- no unsupported `sort` or `direction` parameter is sent to the issue-specific comment endpoint;
- multiple mailbox schedules are staggered;
- mutations are serialized and separated by at least one second;
- low budget suppresses background polling first;
- terminal reporting retains priority;
- `Retry-After` or primary reset time controls recovery after rate limiting;
- a persisted low-budget snapshot becomes normal after its reset deadline rather than suppressing polling forever.

Never log the Authorization header.

## 11. Required negative tests

Run controlled dispatches proving that PATCH-POLLER blocks before local effects when:

- the author/app is not locally trusted;
- the context revision is stale;
- a claimed comment is edited;
- a dispatch ID is reused with a different payload;
- the dispatch is expired or too far in the future;
- a frame digest is wrong;
- the repository, branch, or exact head differs;
- the checkout is dirty;
- a working directory crosses a symbolic link or junction;
- a tool ID is unknown;
- an argument violates local rules;
- the tool requests an unavailable secret;
- write, worktree, commit, or push authority is requested;
- a pagination URL changes API origin;
- output exceeds the configured local bound;
- a process exceeds its timeout.

## 12. Acceptance evidence

Attach to the draft PR:

- exact branch and SHA;
- Node and npm versions;
- build result;
- complete test result;
- Windows configuration smoke result;
- one successful read-only dispatch result;
- one blocked write-capability result;
- one lifecycle comment creation/update observation;
- conditional/304 and rate-header evidence;
- final clean worktree status;
- a primary LEGO → SOLID → CUPID → KISS review.

Keep the PR draft until all evidence is bound to the exact reviewed SHA.
