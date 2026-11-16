import type { Code } from "../../core/src/index.js";
import type { Repository, Instance } from "../../storage/src/index.js";

import type { TransferManager } from "./transfer-manager.js";
import type { BatchService } from "./batch-service.js";
import type { MaintenanceService } from "./maintenance-service.js";
import type { RateLimiter } from "./rate-limiter.js";
import { existsSync } from "node:fs";
export class CleanupService {
  constructor(
    private readonly repo: Repository,
    private readonly instance: Instance,
    private readonly now: () => number,
    private readonly manager: TransferManager,
    private readonly batches: BatchService,
    private readonly maintenanceGate: MaintenanceService,
    private readonly limiter: RateLimiter,
  ) {}
  recover() {
    if (existsSync(this.instance.checked("maintenance")))
      return this.maintenanceGate.clear();
    for (const { id, state } of this.repo.listBatches()) {
      if (state !== "deleting")
        this.mark(
          id,
          state === "exhausted" ? "QUOTA_EXHAUSTED" : "BATCH_EXPIRED",
        );
      this.erase(id);
    }
    for (const file of this.instance.inventory())
      this.instance.remove(file.kind, file.id);
    this.repo.clearSessions();
  }
  mark(id: string, reason: Code) {
    this.repo.mark(id, reason, this.now());
    this.batches.forgetCode(id);
    for (const task of this.manager.tasks)
      if (task.batch === id) task.controller.abort();
  }
  erase(id: string) {
    if (this.manager.active(id)) return;
    for (const file of this.repo.files(id)) {
      this.instance.remove("staging", file.id);
      this.instance.remove("objects", file.id);
    }
    this.repo.deleteBatch(id);
  }
  tick() {
    if (this.maintenanceGate.maintenance) return;
    const now = this.now();
    this.manager.heartbeat(now);
    for (const batch of this.repo.cleanupCandidates(now)) {
      if (batch.expires_at <= now) this.mark(batch.id, "BATCH_EXPIRED");
      else if (
        !this.manager.active(batch.id) &&
        !this.repo.resumableClaimCount(batch.id, now)
      )
        this.mark(batch.id, "QUOTA_EXHAUSTED");
    }
    for (const job of this.repo.dueCleanupJobs(now)) {
      try {
        this.erase(job.batch_id);
      } catch {
        this.repo.retryCleanup(
          now + Math.min(60000, 1000 * 2 ** Math.min(job.attempts, 6)),
          job.batch_id,
        );
        console.error("清理对象失败，将重试");
      }
    }
    this.repo.deleteExpiredClaims(now);
    this.repo.deleteExpiredCodes(now);
    this.repo.deleteExpiredSessions(now);
    this.limiter.expire(now);
  }
}
