import { scrypt } from "node:crypto";
import { fail, Fault } from "../../core/src/index.js";
import type { Limits } from "./transfer-types.js";

export type Derive = (value: string, salt: string) => Promise<string>;
const derivePassword: Derive = (value, salt) =>
  new Promise((resolve, reject) =>
    scrypt(
      value,
      salt,
      32,
      { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 ** 2 },
      (error, buffer) =>
        error ? reject(error) : resolve(buffer.toString("hex")),
    ),
  );

interface Waiter {
  start(): void;
  cancel(error: Error): void;
}
export class PasswordHasher {
  private hashing = false;
  private readonly waiting = new Set<Waiter>();
  constructor(
    private readonly limits: Limits,
    private readonly derive: Derive = derivePassword,
  ) {}
  async hash(
    value: string,
    salt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    if (!this.hashing) return this.calculate(value, salt);
    if (this.waiting.size >= this.limits.passwordWaiting) fail("TRANSFER_BUSY");

    const deadline = performance.now() + this.limits.passwordWaitMs;
    return new Promise((resolve, reject) => {
      const remove = () => {
        this.waiting.delete(waiter);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () =>
        waiter.cancel(new DOMException("请求已断开", "AbortError"));
      const waiter: Waiter = {
        start: () => {
          remove();
          if (performance.now() >= deadline) {
            reject(new Fault("TRANSFER_BUSY"));
            return;
          }
          resolve(this.calculate(value, salt));
        },
        cancel: (error) => {
          remove();
          reject(error);
        },
      };
      const timer = setTimeout(
        () => waiter.cancel(new Fault("TRANSFER_BUSY")),
        this.limits.passwordWaitMs,
      );
      signal?.addEventListener("abort", abort, { once: true });
      this.waiting.add(waiter);
    });
  }
  private async calculate(value: string, salt: string) {
    this.hashing = true;
    try {
      return await this.derive(value, salt);
    } finally {
      this.hashing = false;
      for (const waiter of this.waiting) {
        waiter.start();
        if (this.hashing) break;
      }
    }
  }
  clearWaiting() {
    for (const waiter of this.waiting)
      waiter.cancel(new Fault("SERVICE_CLEANING"));
  }
}
