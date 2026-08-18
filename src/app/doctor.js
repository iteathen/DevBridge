import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { WorkspacePolicy } from '../security/workspace-policy.js';
import { validateToolProfile } from '../runtime/cli-profile.js';
import { resolveExecutable } from '../runtime/executable-resolver.js';
import { GitClient } from '../git/git-client.js';
import { resolveGitHubCredential, publicGitHubCredentialStatus } from '../github/auth-provider.js';

export async function doctor(
  config,
  { resolveTools = true, checkGit = true, checkGitHubAuth = true, env = process.env } = {},
) {
  const workspace = new WorkspacePolicy(config.workspace);
  const workspaceRoot = await workspace.ensureRoot();
  await mkdir(config.state.directory, { recursive: true, mode: 0o700 });

  const tools = [];
  for (const [name, raw] of Object.entries(config.tools)) {
    const profile = validateToolProfile(name, raw, { allowUncontainedTools: config.execution.allowUncontainedTools });
    const executable = resolveTools ? await resolveExecutable(profile.executable) : profile.executable;
    tools.push({ name, executable, sandbox: profile.sandbox, inputMode: profile.inputMode });
  }

  if (config.execution.enabled && tools.length === 0) throw new Error('execution.enabled is true but no valid local tool profiles are configured');
  if (config.execution.defaultTool && !Object.hasOwn(config.tools, config.execution.defaultTool)) {
    throw new Error(`execution.defaultTool does not exist: ${config.execution.defaultTool}`);
  }

  let gitVersion = null;
  if (checkGit) {
    const git = new GitClient({ executable: config.git.executable, syntheticHome: path.join(config.state.directory, 'git-home') });
    gitVersion = await git.version();
  }

  let githubAuth = publicGitHubCredentialStatus(config.github.auth, null);
  if (checkGitHubAuth) {
    const credential = await resolveGitHubCredential(config.github.auth, { env });
    githubAuth = publicGitHubCredentialStatus(config.github.auth, credential);
    if (config.execution.enabled && !githubAuth.available) {
      throw new Error(
        'GitHub authentication is required when execution is enabled. ' +
        `Checked environment variables: ${githubAuth.environmentVariables.join(', ')}; ` +
        `GitHub CLI fallback: ${githubAuth.githubCliExecutable} auth token --hostname ${githubAuth.hostname}. ` +
        'Set one of the environment variables or authenticate GitHub CLI locally.',
      );
    }
  }

  return {
    ok: true,
    queueRepository: config.github.queueRepository,
    apiVersion: config.github.apiVersion,
    githubAuth,
    workspaceRoot,
    stateDirectory: path.resolve(config.state.directory),
    executionEnabled: config.execution.enabled,
    autoPushTaskBranches: config.publication.autoPushTaskBranches,
    gitVersion,
    tools
  };
}
