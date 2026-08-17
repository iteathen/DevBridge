import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { WorkspaceConfig } from "../../config/model.js";
import type { DispatchTarget } from "../../domain/model.js";

function normalizeRelative(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRepositoryRemote(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/\.git$/u, "").replace(/\/$/u, "");
  const scp = trimmed.match(/^[^@]+@[^:]+:([^/]+\/[^/]+)$/u);
  if (scp?.[1] !== undefined) return scp[1];
  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.replace(/^\//u, "");
    return /^[^/]+\/[^/]+$/u.test(pathname) ? pathname : undefined;
  } catch {
    return undefined;
  }
}

function git(gitExecutable: string, checkout: string, args: readonly string[]): string {
  const result = spawnSync(gitExecutable, ["-C", checkout, ...args], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = [result.error?.message, result.stderr, result.stdout]
      .filter((item): item is string => typeof item === "string" && item.trim() !== "")
      .join("\n")
      .slice(0, 1024);
    throw new Error(`git guard failed: ${detail || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}

function assertNoLinks(root: string, checkout: string): void {
  const rootStatus = lstatSync(root);
  if (rootStatus.isSymbolicLink()) throw new Error("workspace root is a symbolic link or junction");
  const relative = path.relative(root, checkout);
  let current = root;
  for (const segment of relative.split(path.sep).filter((item) => item !== "")) {
    current = path.join(current, segment);
    const status = lstatSync(current);
    if (status.isSymbolicLink()) throw new Error(`workspace path crosses a symbolic link or junction: ${segment}`);
  }
}

export interface VerifiedWorkspace {
  readonly workspaceId: string;
  readonly checkoutPath: string;
  readonly repository: string;
  readonly branch: string;
  readonly head: string;
}

export class ReadOnlyWorkspaceGuard {
  readonly #workspaces: readonly WorkspaceConfig[];

  constructor(workspaces: readonly WorkspaceConfig[]) {
    this.#workspaces = workspaces;
  }

  verify(target: DispatchTarget): VerifiedWorkspace {
    const workspace = this.#workspaces.find((item) => item.id === target.workspace_id);
    if (workspace === undefined) throw new Error(`unknown workspace: ${target.workspace_id}`);
    const checkout = workspace.checkouts.find(
      (item) => item.repository.toLowerCase() === target.repository.toLowerCase(),
    );
    if (checkout === undefined) throw new Error(`repository is not registered in workspace ${workspace.id}`);
    if (normalizeRelative(checkout.relativePath) !== normalizeRelative(target.checkout)) {
      throw new Error("dispatch checkout does not match local repository registration");
    }

    const root = path.resolve(workspace.root);
    const checkoutPath = path.resolve(root, checkout.relativePath);
    if (!contained(root, checkoutPath)) throw new Error("registered checkout escapes workspace root");
    assertNoLinks(root, checkoutPath);
    const realRoot = realpathSync.native(root);
    const realCheckout = realpathSync.native(checkoutPath);
    if (!contained(realRoot, realCheckout)) throw new Error("checkout real path escapes workspace root");

    const remote = normalizeRepositoryRemote(git(workspace.gitExecutable, checkoutPath, ["config", "--get", "remote.origin.url"]));
    if (remote?.toLowerCase() !== target.repository.toLowerCase()) throw new Error("local origin does not match dispatch repository");
    const branch = git(workspace.gitExecutable, checkoutPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (branch !== target.branch) throw new Error(`local branch ${branch} does not match expected ${target.branch}`);
    const head = git(workspace.gitExecutable, checkoutPath, ["rev-parse", "HEAD"]);
    if (head !== target.expected_head) throw new Error(`local head ${head} does not match expected ${target.expected_head}`);
    const status = git(workspace.gitExecutable, checkoutPath, ["status", "--porcelain", "--untracked-files=all"]);
    if (status !== "") throw new Error("read-only execution requires a clean checkout");

    return { workspaceId: workspace.id, checkoutPath, repository: target.repository, branch, head };
  }
}
