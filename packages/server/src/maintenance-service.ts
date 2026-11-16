import type { PasswordHasher } from "./password-hasher.js";
import { fail } from "../../core/src/index.js";
import type { Repository, Instance } from "../../storage/src/index.js";

import type { TransferManager } from "./transfer-manager.js";
import type { RateLimiter } from "./rate-limiter.js";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { setImmediate as yieldIO } from "node:timers/promises";
export class MaintenanceService {
  private clearing = false;
  maintenance = false;
  generation = 0;
  constructor(
    private readonly repo: Repository,
    private readonly instance: Instance,
    private readonly now: () => number,
    private readonly manager: TransferManager,
    private readonly limiter: RateLimiter,
    private readonly passwords: PasswordHasher,
    private readonly clearCodes: () => void,
  ) {}
  guard() {
    if (this.maintenance) fail("SERVICE_CLEANING");
  }
  afterAwait(generation: number, sid: string) {
    this.guard();
    if (
      this.generation !== generation ||
      !this.repo.hasSession(sid, this.now())
    )
      fail("SESSION_REQUIRED");
  }
  summary() {
    const entries = this.instance.inventory();
    return {
      batches: this.repo.batchCount(),
      objects: entries.length,
      bytes: entries.reduce((total, entry) => total + entry.size, 0),
      active: this.manager.tasks.size,
    };
  }
  async clear() {
    if (this.clearing) throw Error("CLEANUP_BUSY");
    this.clearing = true;
    this.maintenance = true;
    this.generation++;
    this.passwords.clearWaiting();
    try {
      const marker = this.instance.checked("maintenance");
      if (!existsSync(marker))
        writeFileSync(marker, "1", { mode: 0o600, flag: "wx", flush: true });
      const tasks = [...this.manager.tasks];
      for (const transfer of tasks) transfer.controller.abort();
      await Promise.all(tasks.map((transfer) => transfer.done));
      const report = this.summary();
      const entries = this.instance.inventory();
      for (const [index, entry] of entries.entries()) {
        this.instance.remove(entry.kind, entry.id);
        if (index % 32 === 0) await yieldIO();
      }
      this.repo.clearBusinessData();
      this.clearCodes();
      this.limiter.clear();
      this.repo.checkpointTruncate();
      this.repo.verifyEmpty();
      if (Object.values(this.summary()).some(Boolean))
        throw Error("清理校验失败");
      unlinkSync(marker);
      this.maintenance = false;
      return report;
    } finally {
      this.clearing = false;
    }
  }
}
