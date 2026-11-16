import { randomUUID } from "node:crypto";
import { closeSync, createReadStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Fault, fail, selectRange, mergeRanges } from "../../core/src/index.js";
import type { Transfers, Task } from "./transfers.js";
function matches(value: string | undefined, tag: string, weak: boolean) {
  return value?.split(",").some((s) => {
    const t = s.trim();
    return t === "*" || (weak ? t.replace(/^W\//, "") : t) === tag;
  });
}
export async function content(
  s: Transfers,
  req: FastifyRequest,
  reply: FastifyReply,
  sid: string,
  id: string,
  fileId: string,
) {
  const c = s.claim(id, sid),
    b = s.repo.batch(c.batch_id);
  s.repo.authorize(c, b, s.now());
  const file =
    s.repo.files(b.id).find((f) => f.id === fileId) ?? fail("FORBIDDEN");
  let fd: number | undefined;
  try {
    fd = s.instance.open(file.id, file.size);
  } catch {
    fail("FILE_UNAVAILABLE");
  }
  const attempt = randomUUID();
  let emitted = 0,
    finished = false;
  let task: Task | undefined;
  try {
    const tag = '"' + file.sha256 + '"',
      h = req.headers;
    const modified = Math.floor((b.expires_at - b.ttl) / 1000) * 1000;
    reply
      .header("Last-Modified", new Date(modified).toUTCString())
      .header("ETag", tag)
      .header("Accept-Ranges", "bytes");
    if (h["if-match"] && !matches(h["if-match"], tag, false))
      fail("PRECONDITION");
    if (
      !h["if-match"] &&
      h["if-unmodified-since"] &&
      modified > Date.parse(h["if-unmodified-since"])
    )
      fail("PRECONDITION");
    if (
      !h["if-none-match"] &&
      h["if-modified-since"] &&
      modified <= Date.parse(h["if-modified-since"])
    )
      return reply.code(304).send();
    if (matches(h["if-none-match"], tag, true)) return reply.code(304).send();
    let partial;
    try {
      if (
        req.method === "GET" &&
        (!h["if-range"] ||
          h["if-range"] === tag ||
          h["if-range"] === new Date(modified).toUTCString())
      )
        partial = selectRange(h.range, file.size);
    } catch (e) {
      if (e instanceof Fault && e.code === "RANGE_INVALID")
        reply.header("Content-Range", "bytes */" + file.size);
      throw e;
    }
    const [start, end] = partial ?? [0, file.size - 1];
    if (req.method === "GET") {
      if (mergeRanges(s.repo.ranges(id, fileId), [start, end]).length > 256)
        fail("BAD_INPUT");
      task = s.task("download", b.id, id, file.id);
      s.repo.admit(id, sid, s.now(), {
        id: attempt,
        file: file.id,
        start,
        end,
      });
    }
    const disposition =
      "attachment; filename=\"download\"; filename*=UTF-8''" +
      encodeURIComponent(
        file.display_name.toWellFormed().replace(/[/\\]/g, "_"),
      ).replace(/['()*]/g, (x) => "%" + x.charCodeAt(0).toString(16));
    reply
      .type("application/octet-stream")
      .header("Content-Disposition", disposition)
      .header("Content-Length", end - start + 1);
    if (partial)
      reply
        .code(206)
        .header("Content-Range", `bytes ${start}-${end}/${file.size}`);
    if (!task) return reply.send();
    const source = file.size
      ? createReadStream("", { fd, start, end, autoClose: true })
      : Readable.from([]);
    if (file.size) fd = undefined;
    const active = task;
    const progress = new Transform({
      transform(chunk, _encoding, done) {
        active.last = s.now();
        emitted += chunk.length;
        active.bytes = emitted;
        done(null, chunk);
      },
    });
    reply.hijack();
    for (const [key, value] of Object.entries(reply.getHeaders()))
      if (value !== undefined) reply.raw.setHeader(key, value);
    reply.raw.writeHead(reply.statusCode);
    try {
      await pipeline(source, progress, reply.raw, { signal: task.signal });
      if (!task.signal.aborted && !s.maintenance) {
        s.repo.finish(id, file, [start, end]);
        finished = true;
      }
    } catch {
      if (reply.raw.writableFinished && !task.signal.aborted)
        console.error("传输完成记录失败，将保留续传窗口");
      reply.raw.destroy();
    }
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
      if (task && !s.maintenance)
        s.repo.endTransferAttempt(
          finished ? "finished" : "interrupted",
          emitted,
          s.now(),
          attempt,
        );
    } finally {
      task?.finish();
    }
  }
}
