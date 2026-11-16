import { TransferManager } from "./transfer-manager.js";
import { BatchService } from "./batch-service.js";
import { MaintenanceService } from "./maintenance-service.js";
import { RateLimiter } from "./rate-limiter.js";
import { PasswordHasher, type Derive } from "./password-hasher.js";
import { PickupService } from "./pickup-service.js";
import { CleanupService } from "./cleanup-service.js";
import { ClaimIds } from "./claim-id.js";
import { createHash, randomInt } from "node:crypto";
import { clock, type Code } from "../../core/src/index.js";
import {
  Repository,
  type Batch,
  type StoredFile,
  type Instance,
} from "../../storage/src/index.js";

import type { Limits, Manifest, Task } from "./transfer-types.js";
export type { Limits, Manifest, Task } from "./transfer-types.js";
export const defaults = {
  fileBytes: 10 * 1024 ** 3,
  batchBytes: 20 * 1024 ** 3,
  totalBytes: 50 * 1024 ** 3,
  reserveBytes: 1024 ** 3,
  downloads: 4,
  uploads: 2,
  passwordWaiting: 8,
  passwordWaitMs: 5000,
  ipLimit: 10,
  codeLimit: 5,
  globalLimit: 60,
};
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class Transfers {
  readonly repo: Repository;
  private readonly manager: TransferManager;
  private readonly batches: BatchService;
  private readonly maintenanceGate: MaintenanceService;
  private readonly limiter: RateLimiter;
  private readonly passwords: PasswordHasher;
  private readonly pickups: PickupService;
  private readonly cleanup: CleanupService;
  constructor(
    readonly instance: Instance,
    readonly limits: Limits = defaults,
    readonly now = clock(),
    nextCode = () => randomInt(1000000).toString().padStart(6, "0"),
    derive?: Derive,
  ) {
    this.repo = new Repository(instance);
    this.limiter = new RateLimiter(now);
    this.passwords = new PasswordHasher(limits, derive);
    this.manager = new TransferManager(this.repo, limits, now, () =>
      this.maintenanceGate.guard(),
    );
    this.maintenanceGate = new MaintenanceService(
      this.repo,
      instance,
      now,
      this.manager,
      this.limiter,
      this.passwords,
      () => this.batches.clearCodes(),
    );
    this.batches = new BatchService(
      this.repo,
      instance,
      limits,
      now,
      nextCode,
      this.manager,
      this.maintenanceGate,
      this.passwords,
    );
    this.pickups = new PickupService(
      this.repo,
      limits,
      now,
      new ClaimIds(instance.secret),
      this.manager,
      this.maintenanceGate,
      this.passwords,
      this.batches,
      this.limiter,
    );
    this.cleanup = new CleanupService(
      this.repo,
      instance,
      now,
      this.manager,
      this.batches,
      this.maintenanceGate,
      this.limiter,
    );
  }
  get nextCode() {
    return this.batches.nextCode;
  }
  get tasks() {
    return this.manager.tasks;
  }
  get generation() {
    return this.maintenanceGate.generation;
  }
  get maintenance() {
    return this.maintenanceGate.maintenance;
  }
  set maintenance(value: boolean) {
    this.maintenanceGate.maintenance = value;
  }
  limit(key: string, max: number) {
    return this.limiter.limit(key, max);
  }
  password(value: string, salt: string, signal?: AbortSignal) {
    return this.passwords.hash(value, salt, signal);
  }
  task(kind: Task["kind"], batch: string, group: string, file: string) {
    return this.manager.task(kind, batch, group, file);
  }
  active(batch: string) {
    return this.manager.active(batch);
  }
  create(sid: string, input: Manifest, signal?: AbortSignal) {
    return this.batches.create(sid, input, signal);
  }
  owned(id: string, sid: string) {
    return this.batches.owned(id, sid);
  }
  owner(id: string, sid: string) {
    return this.batches.owner(id, sid);
  }
  metadata(batch: Batch, files?: StoredFile[]) {
    return this.batches.metadata(batch, files);
  }
  publish(id: string, sid: string) {
    return this.batches.publish(id, sid);
  }
  codeHash(code: string) {
    return this.batches.codeHash(code);
  }
  pickup(
    sid: string,
    code: string,
    password: string,
    ip: string,
    signal?: AbortSignal,
  ) {
    return this.pickups.pickup(sid, code, password, ip, signal);
  }
  claim(id: string, sid: string) {
    return this.pickups.claim(id, sid);
  }
  status(id: string, sid: string) {
    return this.pickups.status(id, sid);
  }
  recover() {
    return this.cleanup.recover();
  }
  mark(id: string, reason: Code) {
    return this.cleanup.mark(id, reason);
  }
  erase(id: string) {
    return this.cleanup.erase(id);
  }
  tick() {
    return this.cleanup.tick();
  }
  clear() {
    return this.maintenanceGate.clear();
  }
  summary() {
    return this.maintenanceGate.summary();
  }
  guard() {
    return this.maintenanceGate.guard();
  }
}
