import type { MailboxConfig } from "../config/model.js";
import { validateDispatchTimeWindow } from "../domain/dispatch.js";
import type { ParsedDispatch, SourceComment } from "../domain/model.js";

export class TrustPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TrustPolicyError";
  }
}

export class TrustPolicy {
  validateSource(comment: SourceComment, mailbox: MailboxConfig): void {
    if (comment.repository.toLowerCase() !== mailbox.repository.toLowerCase() ||
        comment.issueNumber !== mailbox.issueNumber) {
      throw new TrustPolicyError("SOURCE_MAILBOX_MISMATCH", "source comment does not belong to configured mailbox");
    }
    const trustedApp = comment.appId !== undefined && mailbox.trustedAppIds.includes(comment.appId);
    const trustedHuman = mailbox.trustedAuthors.some(
      (author) => author.toLowerCase() === comment.authorLogin.toLowerCase(),
    ) && mailbox.allowedAuthorAssociations.includes(
      comment.authorAssociation as "OWNER" | "MEMBER" | "COLLABORATOR",
    );
    if (!trustedApp && !trustedHuman) {
      throw new TrustPolicyError("UNTRUSTED_SOURCE", "source actor is not trusted by local mailbox policy");
    }
  }

  validateForClaim(parsed: ParsedDispatch, now: Date): void {
    validateDispatchTimeWindow(parsed.dispatch, now);
    if (!parsed.dispatch.requested_capabilities.includes("github.report")) {
      throw new TrustPolicyError("REPORT_CAPABILITY_REQUIRED", "dispatch must explicitly request github.report");
    }
  }
}
