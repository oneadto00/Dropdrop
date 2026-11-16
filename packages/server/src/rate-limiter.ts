import { fail } from "../../core/src/index.js";

export class RateLimiter {
  private readonly buckets = new Map<string, { until: number; n: number }>();
  constructor(private readonly now: () => number) {}
  limit(key: string, max: number) {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.until <= now) {
      if (this.buckets.size >= 8192) fail("RATE_LIMITED");
      bucket = { until: now + 60000, n: 0 };
      this.buckets.set(key, bucket);
    }
    if (++bucket.n > max) fail("RATE_LIMITED");
  }
  expire(now: number) {
    for (const [key, bucket] of this.buckets)
      if (bucket.until <= now) this.buckets.delete(key);
  }
  clear() {
    this.buckets.clear();
  }
}
