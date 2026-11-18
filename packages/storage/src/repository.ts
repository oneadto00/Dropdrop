import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import type { Instance } from "./instance-storage.js";
import {
  fail,
  mergeRanges,
  type Code,
  type RangePair,
} from "../../core/src/index.js";
export type Batch = {
  id: string;
  owner: string;
  state: "uploading" | "ready" | "exhausted" | "deleting";
  max_downloads: number;
  started_downloads: number;
  created_at: number;
  expires_at: number;
  ttl: number;
  password_hash: string | null;
  salt: string | null;
};
export type StoredFile = {
  id: string;
  batch_id: string;
  display_name: string;
  size: number;
  sha256: string | null;
};
export type Claim = {
  id: string;
  session_id: string;
  batch_id: string;
  counted_at: number | null;
  until_at: number;
  completed: number;
};
export class Repository {
  private readonly statements = new Map<
    string,
    Database.Statement<unknown[]>
  >();
  readonly db: Database.Database;
  constructor(instance: Instance) {
    this.db = instance.database("dropdrop.sqlite");
    this.db.pragma("journal_mode=WAL");
    this.db.pragma("foreign_keys=ON");
    this.db.pragma("synchronous=FULL");
    this.db.pragma("busy_timeout=500");
    if (
      !this.one("SELECT name FROM sqlite_master WHERE name='schema_migrations'")
    )
      this.tx(() =>
        this.db.exec(
          readFileSync(
            new URL("../migrations/0001_initial_schema.sql", import.meta.url),
            "utf8",
          ),
        ),
      );
    if (this.value("SELECT max(version) FROM schema_migrations") !== 1)
      throw Error("数据库版本不兼容");
  }
  tx<T>(fn: () => T) {
    return this.db.transaction(fn).immediate();
  }
  private statement(sql: string, pluck = false) {
    const key = (pluck ? "pluck:" : "row:") + sql;
    const existing = this.statements.get(key);
    if (existing) return existing;
    const statement = this.db.prepare(sql);
    if (pluck) statement.pluck();
    if (this.statements.size < 128) this.statements.set(key, statement);
    return statement;
  }
  one<T>(sql: string, ...args: unknown[]) {
    return this.statement(sql).get(...args) as T | undefined;
  }
  all<T>(sql: string, ...args: unknown[]) {
    return this.statement(sql).all(...args) as T[];
  }
  run(sql: string, ...args: unknown[]) {
    return this.statement(sql).run(...args);
  }
  value(sql: string, ...args: unknown[]) {
    return Number(this.statement(sql, true).get(...args));
  }
  batch(id: string) {
    return (
      this.one<Batch>("SELECT * FROM batches WHERE id=?", id) ??
      fail("FILE_UNAVAILABLE")
    );
  }
  files(id: string) {
    return this.all<StoredFile>(
      "SELECT * FROM files WHERE batch_id=? ORDER BY rowid",
      id,
    );
  }
  findClaim(id: string, sid: string) {
    return this.one<Claim>(
      "SELECT * FROM download_claims WHERE id=? AND session_id=?",
      id,
      sid,
    );
  }
  claim(id: string, sid: string) {
    return this.findClaim(id, sid) ?? fail("FORBIDDEN");
  }
  authorize(c: Claim, b: Batch, now: number, allowCompleted = false) {
    if (b.state === "deleting")
      fail(
        this.one<{ reason: Code }>(
          "SELECT reason FROM cleanup_jobs WHERE batch_id=?",
          b.id,
        )?.reason ?? "FILE_UNAVAILABLE",
      );
    if (b.expires_at <= now) fail("BATCH_EXPIRED");
    if (b.state === "exhausted" && c.counted_at === null)
      fail("QUOTA_EXHAUSTED");
    if ((c.completed && !allowCompleted) || c.until_at <= now)
      fail("CLAIM_EXPIRED");
    if (b.state !== "ready" && b.state !== "exhausted")
      fail("FILE_UNAVAILABLE");
  }
  admit(
    id: string,
    sid: string,
    now: number,
    attempt: { id: string; file: string; start: number; end: number },
  ) {
    this.tx(() => {
      const c = this.claim(id, sid),
        b = this.batch(c.batch_id);
      this.authorize(c, b, now);
      if (c.counted_at === null) {
        const r = this.run(
          "UPDATE batches SET started_downloads=started_downloads+1,state=CASE WHEN started_downloads+1=max_downloads THEN 'exhausted' ELSE 'ready' END WHERE id=? AND state='ready' AND started_downloads<max_downloads AND expires_at>?",
          b.id,
          now,
        );
        if (r.changes !== 1) fail("QUOTA_EXHAUSTED");
      }
      this.run(
        "UPDATE download_claims SET counted_at=coalesce(counted_at,?),until_at=? WHERE id=?",
        now,
        Math.min(b.expires_at, now + 600000),
        id,
      );
      this.run(
        "DELETE FROM transfer_attempts WHERE id IN (SELECT id FROM transfer_attempts WHERE claim_id=? AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT -1 OFFSET 63)",
        id,
      );
      this.run(
        "INSERT INTO transfer_attempts(id,claim_id,file_id,range_start,range_end,state,started_at) VALUES(?,?,?,?,?,'streaming',?)",
        attempt.id,
        id,
        attempt.file,
        attempt.start,
        attempt.end,
        now,
      );
    });
  }
  claimRanges(claimId: string) {
    const rows = this.all<{ file_id: string; ranges: string }>(
      "SELECT file_id,ranges FROM claim_files WHERE claim_id=?",
      claimId,
    );
    return new Map(
      rows.map((row) => [row.file_id, JSON.parse(row.ranges) as RangePair[]]),
    );
  }
  ranges(claim: string, file: string): RangePair[] {
    const row = this.one<{ ranges: string }>(
      "SELECT ranges FROM claim_files WHERE claim_id=? AND file_id=?",
      claim,
      file,
    );
    return row ? JSON.parse(row.ranges) : [];
  }
  finish(claim: string, file: StoredFile, range: RangePair) {
    this.tx(() => {
      const merged = mergeRanges(this.ranges(claim, file.id), range);
      const complete =
        merged.length === 1 &&
        merged[0][0] === 0 &&
        merged[0][1] === file.size - 1;
      this.run(
        "INSERT OR REPLACE INTO claim_files VALUES(?,?,?,?)",
        claim,
        file.id,
        JSON.stringify(merged),
        Number(complete),
      );
      this.run(
        "UPDATE download_claims SET completed=1 WHERE id=? AND (SELECT count(*) FROM files WHERE batch_id=?)=(SELECT count(*) FROM claim_files WHERE claim_id=? AND complete=1)",
        claim,
        file.batch_id,
        claim,
      );
    });
  }
  mark(id: string, reason: Code, now: number) {
    this.tx(() => {
      this.run("UPDATE batches SET state='deleting' WHERE id=?", id);
      this.run(
        "INSERT OR IGNORE INTO cleanup_jobs(batch_id,reason) VALUES(?,?)",
        id,
        reason,
      );
      this.run(
        "UPDATE pickup_codes SET reason=?,until_at=?,batch_id=NULL WHERE batch_id=?",
        reason,
        now + 86400000,
        id,
      );
    });
  }
  batchCount() {
    return this.value("SELECT count(*) FROM batches");
  }
  deleteExpiredSessions(now: number) {
    return this.run("DELETE FROM browser_sessions WHERE expires_at<=?", now);
  }
  deleteExpiredCodes(now: number) {
    return this.run("DELETE FROM pickup_codes WHERE until_at<=?", now);
  }
  deleteExpiredClaims(now: number) {
    return this.run(
      "DELETE FROM download_claims WHERE counted_at IS NULL AND until_at<=?",
      now,
    );
  }
  retryCleanup(nextRetryAt: number, batchId: string) {
    return this.run(
      "UPDATE cleanup_jobs SET attempts=attempts+1,next_retry_at=? WHERE batch_id=?",
      nextRetryAt,
      batchId,
    );
  }
  dueCleanupJobs(now: number) {
    return this.all<{ batch_id: string; attempts: number }>(
      "SELECT * FROM cleanup_jobs WHERE next_retry_at<=? LIMIT 32",
      now,
    );
  }
  resumableClaimCount(batchId: string, now: number) {
    return this.value(
      "SELECT count(*) FROM download_claims WHERE batch_id=? AND counted_at IS NOT NULL AND completed=0 AND until_at>?",
      batchId,
      now,
    );
  }
  cleanupCandidates(now: number) {
    return this.all<Batch>(
      "SELECT * FROM batches WHERE state!='deleting' AND (expires_at<=? OR state='exhausted')",
      now,
    );
  }
  renewUploadingBatch(expiresAt: number, batchId: string) {
    return this.run(
      "UPDATE batches SET expires_at=min(created_at+7200000,?) WHERE id=? AND state='uploading'",
      expiresAt,
      batchId,
    );
  }
  renewClaim(untilAt: number, claimId: string) {
    return this.run(
      "UPDATE download_claims SET until_at=? WHERE id=?",
      untilAt,
      claimId,
    );
  }
  deleteBatch(batchId: string) {
    return this.run("DELETE FROM batches WHERE id=?", batchId);
  }
  findCooldown(digest: string, now: number) {
    return this.one<{ reason: Code }>(
      "SELECT reason FROM pickup_codes WHERE digest=? AND reason IS NOT NULL AND until_at>?",
      digest,
      now,
    );
  }
  createClaim(
    claimId: string,
    batchId: string,
    sessionId: string,
    untilAt: number,
  ) {
    return this.run(
      "INSERT INTO download_claims(id,batch_id,session_id,until_at) VALUES(?,?,?,?)",
      claimId,
      batchId,
      sessionId,
      untilAt,
    );
  }
  pendingClaimCount(sessionId: string, now: number) {
    return this.value(
      "SELECT count(*) FROM download_claims WHERE session_id=? AND counted_at IS NULL AND until_at>?",
      sessionId,
      now,
    );
  }
  deleteClaim(claimId: string) {
    return this.run("DELETE FROM download_claims WHERE id=?", claimId);
  }
  findBatchClaim(batchId: string, sessionId: string) {
    return this.one<Claim>(
      "SELECT * FROM download_claims WHERE batch_id=? AND session_id=?",
      batchId,
      sessionId,
    );
  }
  findPickupCode(digest: string, now: number) {
    return this.one<{ batch_id: string | null; reason: Code | null }>(
      "SELECT * FROM pickup_codes WHERE digest=? AND (until_at IS NULL OR until_at>?)",
      digest,
      now,
    );
  }
  publishBatch(expiresAt: number, batchId: string) {
    return this.run(
      "UPDATE batches SET state='ready',expires_at=? WHERE id=?",
      expiresAt,
      batchId,
    );
  }
  reservePickupCode(digest: string, batchId: string) {
    return this.run(
      "INSERT OR IGNORE INTO pickup_codes(digest,batch_id) VALUES(?,?)",
      digest,
      batchId,
    );
  }
  findOwnedBatch(batchId: string, owner: string) {
    return this.one<Batch>(
      "SELECT * FROM batches WHERE id=? AND owner=?",
      batchId,
      owner,
    );
  }
  createFile(
    fileId: string,
    batchId: string,
    displayName: string,
    size: number,
  ) {
    return this.run(
      "INSERT INTO files(id,batch_id,display_name,size) VALUES(?,?,?,?)",
      fileId,
      batchId,
      displayName,
      size,
    );
  }
  createBatch(
    batchId: string,
    owner: string,
    maxDownloads: number,
    ttl: number,
    createdAt: number,
    expiresAt: number,
    passwordHash: string | null,
    salt: string | null,
  ) {
    return this.run(
      "INSERT INTO batches(id,owner,state,max_downloads,ttl,created_at,expires_at,password_hash,salt) VALUES(?,?,'uploading',?,?,?,?,?,?)",
      batchId,
      owner,
      maxDownloads,
      ttl,
      createdAt,
      expiresAt,
      passwordHash,
      salt,
    );
  }
  pendingBytes() {
    return this.value(
      "SELECT coalesce(sum(size),0) FROM files WHERE sha256 IS NULL",
    );
  }
  storedBytes() {
    return this.value("SELECT coalesce(sum(size),0) FROM files");
  }
  hasSession(sessionId: string, now: number) {
    return Boolean(
      this.one(
        "SELECT 1 FROM browser_sessions WHERE id=? AND expires_at>?",
        sessionId,
        now,
      ),
    );
  }
  clearSessions() {
    return this.run("DELETE FROM browser_sessions");
  }
  listBatches() {
    return this.all<Batch>("SELECT * FROM batches");
  }
  createSession(sessionId: string, csrf: string, expiresAt: number) {
    return this.run(
      "INSERT INTO browser_sessions VALUES(?,?,?)",
      sessionId,
      csrf,
      expiresAt,
    );
  }
  sessionCount() {
    return this.value("SELECT count(*) FROM browser_sessions");
  }
  findSession(sessionId: string, now: number) {
    return this.one<{ id: string; csrf: string }>(
      "SELECT id,csrf FROM browser_sessions WHERE id=? AND expires_at>?",
      sessionId,
      now,
    );
  }
  extendBatchExpiry(expiresAt: number, batchId: string) {
    return this.run(
      "UPDATE batches SET expires_at=min(created_at+7200000,?) WHERE id=?",
      expiresAt,
      batchId,
    );
  }
  markFileUploaded(sha256: string, fileId: string) {
    return this.run("UPDATE files SET sha256=? WHERE id=?", sha256, fileId);
  }
  endTransferAttempt(
    state: string,
    emittedBytes: number,
    endedAt: number,
    attemptId: string,
  ) {
    return this.run(
      "UPDATE transfer_attempts SET state=?,emitted_bytes=?,ended_at=? WHERE id=?",
      state,
      emittedBytes,
      endedAt,
      attemptId,
    );
  }

  clearBusinessData() {
    this.tx(() => {
      this.run("DELETE FROM pickup_codes");
      this.run("DELETE FROM batches");
      this.clearSessions();
    });
  }
  checkpointTruncate() {
    const [checkpoint] = this.db.pragma("wal_checkpoint(TRUNCATE)") as {
      busy: number;
    }[];
    if (checkpoint.busy) throw Error("数据库正在使用，清理未完成");
  }
  verifyEmpty() {
    if (
      this.batchCount() ||
      this.value("SELECT count(*) FROM files") ||
      this.value("SELECT count(*) FROM pickup_codes") ||
      this.sessionCount() ||
      this.value("SELECT count(*) FROM download_claims") ||
      this.value("SELECT count(*) FROM claim_files") ||
      this.value("SELECT count(*) FROM transfer_attempts") ||
      this.value("SELECT count(*) FROM cleanup_jobs")
    )
      throw Error("清理校验失败");
  }
  close() {
    this.statements.clear();
    this.db.close();
  }
}
export function previewBatchCount(instance: Instance) {
  const connection = instance.database("dropdrop.sqlite", true);
  try {
    return Number(
      connection.prepare("SELECT count(*) FROM batches").pluck().get(),
    );
  } finally {
    connection.close();
  }
}
