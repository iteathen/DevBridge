import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { LifecycleReport, ParsedDispatch, SourceComment } from "../../domain/model.js";
import type { RateSnapshot } from "../../domain/rate-budget.js";
import type { DispatchClaimResult, MailboxCache, StateStore } from "../../ports/state-store.js";

interface MailboxRow {
  etag: string | null;
  last_modified: string | null;
  cursor_updated_at: string | null;
  initialized: number;
  unchanged_streak: number;
  x_poll_interval_seconds: number | null;
}

interface SourceRow {
  body_sha256: string;
}

interface DispatchRow {
  dispatch_id: string;
  payload_sha256: string;
  repository: string;
  comment_id: number;
  report_json: string | null;
  report_comment_id: number | null;
}

interface ContextRow {
  maximum_revision: number;
}

interface ProgressRow {
  report_json: string;
}

interface RateRow {
  resource: string;
  limit_value: number;
  remaining: number;
  used: number;
  reset_at_ms: number;
  observed_at_ms: number;
}

interface MetadataRow {
  value: string;
}

export class SqliteStateStore implements StateStore {
  readonly #database: DatabaseSync;

  constructor(filename: string) {
    const resolved = path.resolve(filename);
    mkdirSync(path.dirname(resolved), { recursive: true });
    this.#database = new DatabaseSync(resolved, {
      timeout: 5000,
      defensive: true,
      allowExtension: false,
    });
  }

  initialize(): void {
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS schema_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      INSERT OR IGNORE INTO schema_metadata (key, value)
      VALUES ('schema_version', '1');

      CREATE TABLE IF NOT EXISTS mailbox_state (
        mailbox_id TEXT PRIMARY KEY,
        etag TEXT,
        last_modified TEXT,
        cursor_updated_at TEXT,
        initialized INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0, 1)),
        unchanged_streak INTEGER NOT NULL DEFAULT 0 CHECK (unchanged_streak >= 0),
        x_poll_interval_seconds INTEGER CHECK (x_poll_interval_seconds IS NULL OR x_poll_interval_seconds >= 0)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS source_comments (
        repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        comment_id INTEGER NOT NULL,
        node_id TEXT NOT NULL,
        author_login TEXT NOT NULL,
        body_sha256 TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        dispatch_id TEXT,
        PRIMARY KEY (repository, comment_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS context_revisions (
        context_id TEXT PRIMARY KEY,
        maximum_revision INTEGER NOT NULL CHECK (maximum_revision >= 1)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS dispatches (
        dispatch_id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        comment_id INTEGER NOT NULL,
        payload_sha256 TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        context_id TEXT NOT NULL,
        context_revision INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL,
        report_json TEXT,
        report_comment_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (repository, comment_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS progress_events (
        dispatch_id TEXT NOT NULL REFERENCES dispatches(dispatch_id),
        progress_sequence INTEGER NOT NULL CHECK (progress_sequence >= 0),
        state TEXT NOT NULL,
        phase TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        report_json TEXT NOT NULL,
        PRIMARY KEY (dispatch_id, progress_sequence)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS rate_snapshots (
        resource TEXT PRIMARY KEY,
        limit_value INTEGER NOT NULL,
        remaining INTEGER NOT NULL,
        used INTEGER NOT NULL,
        reset_at_ms INTEGER NOT NULL,
        observed_at_ms INTEGER NOT NULL
      ) STRICT;
    `);
    const version = this.#database.prepare(`
      SELECT value FROM schema_metadata WHERE key = 'schema_version'
    `).get() as MetadataRow | undefined;
    if (version?.value !== "1") throw new Error("unsupported PATCH-POLLER state schema version");
  }

  close(): void {
    this.#database.close();
  }

  getMailboxCache(mailboxId: string): MailboxCache {
    const row = this.#database.prepare(`
      SELECT etag, last_modified, cursor_updated_at, initialized,
             unchanged_streak, x_poll_interval_seconds
      FROM mailbox_state WHERE mailbox_id = ?
    `).get(mailboxId) as MailboxRow | undefined;
    if (row === undefined) return { initialized: false, unchangedStreak: 0 };
    return {
      ...(row.etag === null ? {} : { etag: row.etag }),
      ...(row.last_modified === null ? {} : { lastModified: row.last_modified }),
      ...(row.cursor_updated_at === null ? {} : { cursorUpdatedAt: row.cursor_updated_at }),
      initialized: row.initialized === 1,
      unchangedStreak: row.unchanged_streak,
      ...(row.x_poll_interval_seconds === null ? {} : { xPollIntervalSeconds: row.x_poll_interval_seconds }),
    };
  }

  updateMailboxCache(mailboxId: string, cache: MailboxCache): void {
    this.#database.prepare(`
      INSERT INTO mailbox_state (
        mailbox_id, etag, last_modified, cursor_updated_at, initialized,
        unchanged_streak, x_poll_interval_seconds
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mailbox_id) DO UPDATE SET
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        cursor_updated_at = excluded.cursor_updated_at,
        initialized = excluded.initialized,
        unchanged_streak = excluded.unchanged_streak,
        x_poll_interval_seconds = excluded.x_poll_interval_seconds
    `).run(
      mailboxId,
      cache.etag ?? null,
      cache.lastModified ?? null,
      cache.cursorUpdatedAt ?? null,
      cache.initialized ? 1 : 0,
      cache.unchangedStreak,
      cache.xPollIntervalSeconds ?? null,
    );
  }

  markSourceCommentSeen(comment: SourceComment, bodySha256: string): "new" | "same" | "edited" {
    const row = this.#database.prepare(`
      SELECT body_sha256 FROM source_comments
      WHERE repository = ? AND comment_id = ?
    `).get(comment.repository, comment.id) as SourceRow | undefined;
    if (row === undefined) {
      this.#database.prepare(`
        INSERT INTO source_comments (
          repository, issue_number, comment_id, node_id, author_login,
          body_sha256, first_seen_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        comment.repository,
        comment.issueNumber,
        comment.id,
        comment.nodeId,
        comment.authorLogin,
        bodySha256,
        new Date().toISOString(),
        comment.updatedAt,
      );
      return "new";
    }
    if (row.body_sha256 === bodySha256) return "same";
    this.#database.prepare(`
      UPDATE source_comments SET body_sha256 = ?, updated_at = ?
      WHERE repository = ? AND comment_id = ?
    `).run(bodySha256, comment.updatedAt, comment.repository, comment.id);
    return "edited";
  }

  claimDispatch(comment: SourceComment, parsed: ParsedDispatch): DispatchClaimResult {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const byComment = this.#database.prepare(`
        SELECT dispatch_id, payload_sha256, repository, comment_id,
               report_json, report_comment_id
        FROM dispatches WHERE repository = ? AND comment_id = ?
      `).get(comment.repository, comment.id) as DispatchRow | undefined;
      if (byComment !== undefined) {
        this.#database.exec("COMMIT");
        return byComment.payload_sha256 === parsed.payloadSha256
          ? { status: "duplicate" }
          : { status: "comment_tampered" };
      }

      const byId = this.#database.prepare(`
        SELECT dispatch_id, payload_sha256, repository, comment_id,
               report_json, report_comment_id
        FROM dispatches WHERE dispatch_id = ?
      `).get(parsed.dispatch.dispatch_id) as DispatchRow | undefined;
      if (byId !== undefined) {
        this.#database.exec("COMMIT");
        return byId.payload_sha256 === parsed.payloadSha256
          ? { status: "duplicate" }
          : { status: "dispatch_id_conflict" };
      }

      const context = this.#database.prepare(`
        SELECT maximum_revision FROM context_revisions WHERE context_id = ?
      `).get(parsed.dispatch.context.id) as ContextRow | undefined;
      if (context !== undefined && parsed.dispatch.context.revision <= context.maximum_revision) {
        this.#database.exec("COMMIT");
        return { status: "stale_context_revision" };
      }

      const now = new Date().toISOString();
      this.#database.prepare(`
        INSERT INTO dispatches (
          dispatch_id, repository, issue_number, comment_id, payload_sha256,
          payload_json, context_id, context_revision, attempt, state,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'accepted', ?, ?)
      `).run(
        parsed.dispatch.dispatch_id,
        comment.repository,
        comment.issueNumber,
        comment.id,
        parsed.payloadSha256,
        parsed.payloadText,
        parsed.dispatch.context.id,
        parsed.dispatch.context.revision,
        now,
        now,
      );
      this.#database.prepare(`
        INSERT INTO context_revisions (context_id, maximum_revision)
        VALUES (?, ?)
        ON CONFLICT(context_id) DO UPDATE SET maximum_revision = excluded.maximum_revision
      `).run(parsed.dispatch.context.id, parsed.dispatch.context.revision);
      this.#database.prepare(`
        UPDATE source_comments SET dispatch_id = ?
        WHERE repository = ? AND comment_id = ?
      `).run(parsed.dispatch.dispatch_id, comment.repository, comment.id);
      this.#database.exec("COMMIT");
      return { status: "claimed", attempt: 1 };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  saveLifecycleReport(report: LifecycleReport): void {
    const reportJson = JSON.stringify(report);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database.prepare(`
        SELECT report_json FROM progress_events
        WHERE dispatch_id = ? AND progress_sequence = ?
      `).get(report.dispatch_id, report.progress_sequence) as ProgressRow | undefined;
      if (existing === undefined) {
        this.#database.prepare(`
          INSERT INTO progress_events (
            dispatch_id, progress_sequence, state, phase, occurred_at, report_json
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          report.dispatch_id,
          report.progress_sequence,
          report.state,
          report.phase,
          report.updated_at,
          reportJson,
        );
      } else if (existing.report_json !== reportJson) {
        throw new Error("progress sequence was reused with different lifecycle content");
      }
      const result = this.#database.prepare(`
        UPDATE dispatches SET state = ?, report_json = ?, updated_at = ?
        WHERE dispatch_id = ?
      `).run(report.state, reportJson, report.updated_at, report.dispatch_id);
      if (result.changes !== 1) throw new Error(`unknown dispatch: ${report.dispatch_id}`);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  getLifecycleReport(dispatchId: string): LifecycleReport | undefined {
    const row = this.#database.prepare(`
      SELECT dispatch_id, payload_sha256, repository, comment_id,
             report_json, report_comment_id
      FROM dispatches WHERE dispatch_id = ?
    `).get(dispatchId) as DispatchRow | undefined;
    if (row === undefined || row.report_json === null) return undefined;
    return JSON.parse(row.report_json) as LifecycleReport;
  }

  setReportCommentId(dispatchId: string, commentId: number): void {
    const result = this.#database.prepare(`
      UPDATE dispatches SET report_comment_id = ? WHERE dispatch_id = ?
    `).run(commentId, dispatchId);
    if (result.changes !== 1) throw new Error(`unknown dispatch: ${dispatchId}`);
  }

  getReportCommentId(dispatchId: string): number | undefined {
    const row = this.#database.prepare(`
      SELECT dispatch_id, payload_sha256, repository, comment_id,
             report_json, report_comment_id
      FROM dispatches WHERE dispatch_id = ?
    `).get(dispatchId) as DispatchRow | undefined;
    return row?.report_comment_id ?? undefined;
  }

  recordRateSnapshot(snapshot: RateSnapshot): void {
    this.#database.prepare(`
      INSERT INTO rate_snapshots (
        resource, limit_value, remaining, used, reset_at_ms, observed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(resource) DO UPDATE SET
        limit_value = excluded.limit_value,
        remaining = excluded.remaining,
        used = excluded.used,
        reset_at_ms = excluded.reset_at_ms,
        observed_at_ms = excluded.observed_at_ms
    `).run(
      snapshot.resource,
      snapshot.limit,
      snapshot.remaining,
      snapshot.used,
      snapshot.resetAtMs,
      snapshot.observedAtMs,
    );
  }

  getRateSnapshots(): readonly RateSnapshot[] {
    const rows = this.#database.prepare(`
      SELECT resource, limit_value, remaining, used, reset_at_ms, observed_at_ms
      FROM rate_snapshots
    `).all() as unknown as readonly RateRow[];
    return rows.map((row) => ({
      resource: row.resource,
      limit: row.limit_value,
      remaining: row.remaining,
      used: row.used,
      resetAtMs: row.reset_at_ms,
      observedAtMs: row.observed_at_ms,
    }));
  }
}
