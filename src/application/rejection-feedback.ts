import type { SourceComment } from "../domain/model.js";
import type { Clock } from "../ports/clock.js";
import type { GitHubMailbox } from "../ports/github-mailbox.js";
import type { Logger } from "../ports/logger.js";

export interface RejectionFeedback {
  readonly version: 1;
  readonly source_comment: {
    readonly repository: string;
    readonly issue_number: number;
    readonly comment_id: number;
    readonly html_url: string;
  };
  readonly dispatch_id?: string;
  readonly code: string;
  readonly message: string;
  readonly rejected_at: string;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${characters.slice(0, middle).join("")}…`;
    if (Buffer.byteLength(candidate, "utf8") <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return `${characters.slice(0, low).join("")}…`;
}

export function renderRejectionFeedback(
  comment: SourceComment,
  code: string,
  message: string,
  rejectedAt: string,
  dispatchId?: string,
): string {
  const feedback: RejectionFeedback = {
    version: 1,
    source_comment: {
      repository: comment.repository,
      issue_number: comment.issueNumber,
      comment_id: comment.id,
      html_url: comment.htmlUrl,
    },
    ...(dispatchId === undefined ? {} : { dispatch_id: truncateUtf8(dispatchId, 128) }),
    code: truncateUtf8(code, 128),
    message: truncateUtf8(message, 2048),
    rejected_at: rejectedAt,
  };
  return [
    "### PATCH-POLLER — dispatch rejected",
    "",
    `- Source: ${comment.htmlUrl}`,
    ...(dispatchId === undefined ? [] : [`- Dispatch: \`${feedback.dispatch_id}\``]),
    `- Code: \`${feedback.code}\``,
    "",
    feedback.message,
    "",
    "The source was trusted, but the dispatch was not accepted. No local tool, workspace write, commit, or push was authorized by this rejection.",
    "",
    `<!-- PATCH-POLLER-REJECTION v1\n${JSON.stringify(feedback)}\n-->`,
  ].join("\n");
}

export async function reportTrustedRejection(
  mailbox: GitHubMailbox,
  comment: SourceComment,
  code: string,
  message: string,
  clock: Clock,
  logger: Logger,
  dispatchId?: string,
): Promise<void> {
  const body = renderRejectionFeedback(
    comment,
    code,
    message,
    clock.now().toISOString(),
    dispatchId,
  );
  try {
    await mailbox.createLifecycleComment(body, "normal");
  } catch (error) {
    logger.warn("trusted dispatch rejection could not be projected", {
      mailboxId: mailbox.id,
      commentId: comment.id,
      code,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 1024),
    });
  }
}
