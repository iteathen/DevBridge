import type { DispatchTarget } from "../domain/model.js";

export interface VerifiedWorkspace {
  readonly workspaceId: string;
  readonly checkoutPath: string;
  readonly repository: string;
  readonly branch: string;
  readonly head: string;
}

export interface WorkspaceGuard {
  verify(target: DispatchTarget): VerifiedWorkspace;
}
