import { fail } from "../../core/src/index.js";
import type { Repository } from "../../storage/src/index.js";
import type { Limits, Task } from "./transfer-types.js";

export class TransferManager {
  readonly tasks = new Set<Task>();
  constructor(
    private readonly repo: Repository,
    private readonly limits: Limits,
    private readonly now: () => number,
    private readonly guard: () => void,
  ) {}
  active(batch: string) {
    return [...this.tasks].some((transfer) => transfer.batch === batch);
  }
  task(kind: Task["kind"], batch: string, group: string, file: string) {
    this.guard();
    const same = [...this.tasks].filter((transfer) => transfer.kind === kind),
      mine = same.filter((transfer) => transfer.group === group);
    if (
      same.length >= this.limits[kind === "upload" ? "uploads" : "downloads"] ||
      mine.length >= (kind === "upload" ? 1 : 2) ||
      mine.some((transfer) => transfer.file === file)
    )
      fail("TRANSFER_BUSY");
    const controller = new AbortController();
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const task: Task = {
      kind,
      batch,
      group,
      file,
      controller,
      bytes: 0,
      signal: controller.signal,
      last: this.now(),
      done,
      finish: () => {
        this.tasks.delete(task);
        finish();
      },
    };
    this.tasks.add(task);
    return task;
  }
  heartbeat(now: number) {
    for (const transfer of this.tasks) {
      if (now - transfer.last >= 60000) {
        transfer.controller.abort();
        continue;
      }
      if (transfer.kind === "download")
        this.repo.renewClaim(
          Math.min(
            transfer.last + 600000,
            this.repo.batch(transfer.batch).expires_at,
          ),
          transfer.group,
        );
      else
        this.repo.renewUploadingBatch(transfer.last + 900000, transfer.batch);
    }
  }
}
