import { fail } from "../../core/src/index.js";
import type { Repository } from "../../storage/src/index.js";
import type { Limits } from "./transfer-types.js";
import type { TransferManager } from "./transfer-manager.js";
import type { MaintenanceService } from "./maintenance-service.js";
import type { PasswordHasher } from "./password-hasher.js";
import type { BatchService } from "./batch-service.js";
import type { RateLimiter } from "./rate-limiter.js";
import type { ClaimTokenCodec } from "./claim-token.js";
import { timingSafeEqual } from "node:crypto";
export class PickupService {
  constructor(
    private readonly repo: Repository,
    private readonly limits: Limits,
    private readonly now: () => number,
    private readonly claimTokens: ClaimTokenCodec,
    private readonly manager: TransferManager,
    private readonly maintenanceGate: MaintenanceService,
    private readonly passwords: PasswordHasher,
    private readonly batches: BatchService,
    private readonly limiter: RateLimiter,
  ) {}
  async pickup(
    sid: string,
    code: string,
    password: string,
    ip: string,
    signal?: AbortSignal,
  ) {
    const key = this.batches.codeHash(code);
    this.limiter.limit("pickup:" + ip, this.limits.ipLimit);
    this.limiter.limit("pickup-global", this.limits.globalLimit);
    this.limiter.limit("code:" + key, this.limits.codeLimit);
    const record = () =>
      this.repo.findPickupCode(key, this.now()) ?? fail("PICKUP_UNAVAILABLE");
    const pickupCode = record();
    if (!pickupCode.batch_id) fail(pickupCode.reason ?? "PICKUP_UNAVAILABLE");
    let batch = this.repo.batch(pickupCode.batch_id);
    if (batch.password_hash && batch.salt) {
      const generation = this.maintenanceGate.generation;
      const hash = await this.passwords.hash(password, batch.salt, signal);
      this.maintenanceGate.afterAwait(generation, sid);
      if (
        !timingSafeEqual(
          Buffer.from(hash, "hex"),
          Buffer.from(batch.password_hash, "hex"),
        )
      )
        fail("PICKUP_UNAVAILABLE");
      const fresh = record();
      if (fresh.batch_id !== batch.id)
        fail(fresh.reason ?? "PICKUP_UNAVAILABLE");
      batch = this.repo.batch(batch.id);
    }
    const now = this.now();
    if (batch.expires_at <= now) fail("BATCH_EXPIRED");
    let claim = this.repo.findBatchClaim(batch.id, sid);
    if (
      claim &&
      batch.state === "ready" &&
      (claim.completed || claim.until_at <= now) &&
      ![...this.manager.tasks].some((task) => task.group === claim?.id)
    ) {
      this.repo.deleteClaim(claim.id);
      claim = undefined;
    }
    if (!claim) {
      if (batch.state === "exhausted") fail("QUOTA_EXHAUSTED");
      if (batch.state !== "ready") fail("PICKUP_UNAVAILABLE");
      if (this.repo.pendingClaimCount(sid, now) >= 5) fail("TRANSFER_BUSY");
      const id = this.claimTokens.create(sid, key);
      this.repo.createClaim(
        id,
        batch.id,
        sid,
        Math.min(now + 120000, batch.expires_at),
      );
      claim = this.repo.claim(id, sid);
    }
    return this.status(claim.id, sid);
  }
  claim(id: string, sid: string) {
    const row = this.repo.findClaim(id, sid);
    if (row) return row;
    const digest = this.claimTokens.lookup(id, sid);
    if (!digest) fail("FORBIDDEN");
    const cooldown = this.repo.findCooldown(digest, this.now());
    fail(cooldown?.reason ?? "CLAIM_EXPIRED");
  }
  status(id: string, sid: string) {
    const claim = this.claim(id, sid),
      batch = this.repo.batch(claim.batch_id);
    this.repo.authorize(claim, batch, this.now(), true);
    const files = this.repo.files(batch.id);
    const ranges = this.repo.claimRanges(id);
    return {
      ...this.batches.metadata(batch, files),
      claimId: id,
      counted: claim.counted_at !== null,
      completed: !!claim.completed,
      active: [...this.manager.tasks]
        .filter((task) => task.kind === "download" && task.group === id)
        .map((task) => ({ fileId: task.file, emittedBytes: task.bytes })),
      progress: files.map((file) => ({
        fileId: file.id,
        servedBytes: (ranges.get(file.id) ?? []).reduce(
          (total, [start, end]) => total + end - start + 1,
          0,
        ),
      })),
    };
  }
}
