import { fail } from "../../core/src/index.js";
import type { Repository, Batch, Instance } from "../../storage/src/index.js";

import type { Limits, Manifest } from "./transfer-types.js";
import type { TransferManager } from "./transfer-manager.js";
import type { MaintenanceService } from "./maintenance-service.js";
import type { PasswordHasher } from "./password-hasher.js";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { closeSync } from "node:fs";
export class BatchService {
  private readonly codes = new Map<string, string>();
  constructor(
    private readonly repo: Repository,
    private readonly instance: Instance,
    private readonly limits: Limits,
    private readonly now: () => number,
    readonly nextCode: () => string,
    private readonly manager: TransferManager,
    private readonly maintenanceGate: MaintenanceService,
    private readonly passwords: PasswordHasher,
  ) {}
  async create(sid: string, input: Manifest, signal?: AbortSignal) {
    const total = input.files.reduce(
      (totalBytes, file) => totalBytes + file.size,
      0,
    );
    if (
      total > this.limits.batchBytes ||
      input.files.some((file) => file.size > this.limits.fileBytes)
    )
      fail("BAD_INPUT");
    const generation = this.maintenanceGate.generation,
      salt = input.password ? randomBytes(16).toString("hex") : null;
    const hash = salt
      ? await this.passwords.hash(input.password ?? "", salt, signal)
      : null;
    this.maintenanceGate.afterAwait(generation, sid);
    const id = randomUUID(),
      now = this.now();
    this.repo.tx(() => {
      if (this.repo.batchCount() >= 1024) fail("TRANSFER_BUSY");
      const used = this.repo.storedBytes(),
        pending = this.repo.pendingBytes();
      if (
        total > this.limits.totalBytes - used ||
        total + pending + this.limits.reserveBytes > this.instance.diskFree()
      )
        fail("STORAGE_FULL");
      this.repo.createBatch(
        id,
        sid,
        input.maxDownloads,
        input.expiresInSeconds * 1000,
        now,
        now + 900000,
        hash,
        salt,
      );
      for (const file of input.files)
        this.repo.createFile(randomUUID(), id, file.name, file.size);
    });
    return this.owner(id, sid);
  }
  owned(id: string, sid: string) {
    const batch = this.repo.findOwnedBatch(id, sid) ?? fail("FORBIDDEN");
    if (batch.expires_at <= this.now()) fail("BATCH_EXPIRED");
    return batch;
  }
  metadata(batch: Batch, files = this.repo.files(batch.id)) {
    return {
      batchId: batch.id,
      state: batch.state,
      expiresAt: batch.expires_at,
      maxDownloads: batch.max_downloads,
      startedDownloads: batch.started_downloads,
      files: files.map((file) => ({
        id: file.id,
        name: file.display_name,
        size: file.size,
        uploaded: !!file.sha256,
      })),
    };
  }
  owner(id: string, sid: string) {
    return this.metadata(this.owned(id, sid));
  }
  publish(id: string, sid: string) {
    const batch = this.owned(id, sid);
    if (batch.state === "ready" || batch.state === "exhausted")
      return {
        code: this.codes.get(id) ?? fail("FILE_UNAVAILABLE"),
        expiresAt: batch.expires_at,
      };
    if (batch.state !== "uploading" || this.manager.active(id))
      fail("INCOMPLETE");
    const files = this.repo.files(id);
    for (const file of files) {
      if (!file.sha256) fail("INCOMPLETE");
      try {
        closeSync(this.instance.open(file.id, file.size));
      } catch {
        fail("FILE_UNAVAILABLE");
      }
    }
    const expiresAt = this.now() + batch.ttl;
    const code = this.repo.tx(() => {
      for (let attempt = 0; attempt < 32; attempt++) {
        const codeCandidate = this.nextCode();
        if (
          !this.repo.reservePickupCode(this.codeHash(codeCandidate), id).changes
        )
          continue;
        this.repo.publishBatch(expiresAt, id);
        return codeCandidate;
      }
      return fail("TRANSFER_BUSY");
    });
    this.codes.set(id, code);
    return { code, expiresAt };
  }
  codeHash(code: string) {
    return createHmac("sha256", this.instance.secret)
      .update(code)
      .digest("hex");
  }
  forgetCode(id: string) {
    this.codes.delete(id);
  }
  clearCodes() {
    this.codes.clear();
  }
}
