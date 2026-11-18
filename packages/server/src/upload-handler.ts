import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyRequest } from "fastify";
import { fail, Fault } from "../../core/src/index.js";
import type { Transfers } from "./transfer-service.js";
export async function handleUpload(
  s: Transfers,
  req: FastifyRequest,
  sid: string,
  id: string,
  fileId: string,
) {
  const b = s.owned(id, sid);
  if (b.state !== "uploading" || !req.isMultipart()) fail("BAD_INPUT");
  const f = s.repo.files(id).find((f) => f.id === fileId) ?? fail("FORBIDDEN");
  const task = s.task("upload", id, sid, fileId);
  let staged = false,
    bytes = 0,
    received = false;
  const hash = createHash("sha256");
  const cancel = () => req.raw.destroy();
  task.signal.addEventListener("abort", cancel, { once: true });
  try {
    for await (const part of req.parts({
      limits: { files: 1, fields: 0, parts: 2, fileSize: f.size + 1 },
    })) {
      if (part.type !== "file" || part.fieldname !== "file" || received)
        fail("BAD_INPUT");
      received = true;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.length;
          task.last = s.now();
          if (bytes > f.size) return done(new Fault("BAD_INPUT"));
          hash.update(chunk);
          done(null, chunk);
        },
      });
      if (f.sha256) {
        // A retried request still has to supply the same bytes.
        meter.resume();
        await pipeline(part.file, meter, { signal: task.signal });
      } else {
        const fd = s.instance.stage(fileId);
        staged = true;
        await pipeline(part.file, meter, createWriteStream("", { fd }), {
          signal: task.signal,
        });
      }
      if (part.file.truncated || bytes !== f.size) fail("INCOMPLETE");
    }
    if (
      !received ||
      task.signal.aborted ||
      s.owned(id, sid).state !== "uploading"
    )
      fail("INCOMPLETE");
    const sum = hash.digest("hex");
    if (f.sha256 && f.sha256 !== sum) fail("BAD_INPUT");
    if (staged) {
      s.instance.publish(fileId);
      staged = false;
      s.repo.markFileUploaded(sum, fileId);
    }
    s.repo.extendBatchExpiry(s.now() + 900000, id);
    return { uploaded: true, bytes };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOSPC") fail("STORAGE_FULL");
    throw e;
  } finally {
    try {
      if (staged) s.instance.remove("staging", fileId);
    } finally {
      task.signal.removeEventListener("abort", cancel);
      task.finish();
    }
  }
}
