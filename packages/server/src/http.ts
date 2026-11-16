import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import cookie from "@fastify/cookie";
import serve from "@fastify/static";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ServerOptions } from "node:https";
import { Fault, fail, messages } from "../../core/src/index.js";
import { Transfers, digest, type Manifest } from "./transfers.js";
import { content } from "./content.js";
import { upload } from "./upload.js";
async function whileConnected<Result>(
  reply: FastifyReply,
  operation: (signal: AbortSignal) => Promise<Result>,
) {
  const controller = new AbortController();
  const onClose = () => {
    if (!reply.raw.writableFinished) controller.abort();
  };
  reply.raw.once("close", onClose);
  try {
    if (reply.raw.destroyed) onClose();
    return await operation(controller.signal);
  } finally {
    reply.raw.off("close", onClose);
  }
}
const prefix = "/api/v1";
const password = { type: "string", maxLength: 128 };
const manifest = {
  type: "object",
  additionalProperties: false,
  required: ["files", "maxDownloads", "expiresInSeconds"],
  properties: {
    files: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "size"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 255 },
          size: {
            type: "integer",
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
          },
        },
      },
    },
    maxDownloads: { type: "integer", minimum: 1, maximum: 1000 },
    expiresInSeconds: { type: "integer", minimum: 60, maximum: 86400 },
    password,
  },
};
const pickup = {
  type: "object",
  additionalProperties: false,
  required: ["code"],
  properties: {
    code: { type: "string", pattern: "^[0-9]{6}$" },
    password,
    idempotencyKey: { type: "string", maxLength: 128 },
  },
};
type Params = { batchId: string; fileId: string; claimId: string };
export async function makeHttp(
  s: Transfers,
  hosts: string[],
  tls?: ServerOptions,
) {
  const app = Fastify({
    logger: false,
    trustProxy: false,
    exposeHeadRoutes: false,
    bodyLimit: 32768,
    requestTimeout: 0,
    connectionTimeout: 60000,
    ...(tls ? { https: tls } : {}),
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  app.server.headersTimeout = 10000;
  app.server.maxConnections = 256;
  await app.register(multipart);
  await app.register(cookie);
  const html = (r: FastifyRequest) =>
    r.headers.accept?.includes("text/html") ||
    r.headers["sec-fetch-mode"] === "navigate";
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    const host = req.headers.host;
    const port = req.raw.socket.localPort;
    if (
      !hosts.some(
        (h) =>
          host === h + ":" + port || (port === (tls ? 443 : 80) && host === h),
      )
    )
      fail("FORBIDDEN");
    if (
      req.headers.origin &&
      req.headers.origin !== (tls ? "https://" : "http://") + host
    )
      fail("FORBIDDEN");
    if (
      req.headers["sec-fetch-site"] === "cross-site" &&
      req.url.startsWith(prefix)
    )
      fail("FORBIDDEN");
    if (req.url.startsWith(prefix)) s.guard();
  });
  app.setErrorHandler((error, req, reply) => {
    if (reply.raw.headersSent) {
      reply.raw.destroy();
      return;
    }
    const status = (error as { statusCode?: number }).statusCode;
    const e =
      error instanceof Fault
        ? error
        : new Fault(
            status && status >= 400 && status < 500
              ? "BAD_INPUT"
              : "INTERNAL_ERROR",
          );
    const [code, msg] = messages[e.code];
    reply.removeHeader("Content-Disposition");
    reply.removeHeader("Content-Length");
    reply.code(code);
    if (code === 429)
      reply.header("Retry-After", e.code === "RATE_LIMITED" ? 60 : 1);
    if (html(req))
      return reply
        .type("text/html; charset=utf-8")
        .send(
          `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dropdrop · 下载提示</title><main><h1>${msg}</h1><a href="/download">返回取件</a></main></html>`,
        );
    return reply
      .type("application/json")
      .send({ code: e.code, message: msg, requestId: req.id });
  });
  const session = (req: FastifyRequest) => {
    const token = req.cookies.dropbin;
    return token && token.length === 64
      ? s.repo.findSession(digest(token), s.now())
      : undefined;
  };
  function sid(req: FastifyRequest) {
    const row = session(req) ?? fail("SESSION_REQUIRED");
    if (
      !["GET", "HEAD"].includes(req.method) &&
      (req.headers.origin !==
        (tls ? "https://" : "http://") + req.headers.host ||
        req.headers["x-csrf-token"] !== row.csrf)
    )
      fail("FORBIDDEN");
    return row.id;
  }
  app.get(prefix + "/session", async (req, reply) => {
    let row = session(req);
    if (!row) {
      s.limit("new:" + req.ip, 120);
      s.limit("all-new", 240);
      if (s.repo.sessionCount() >= 8192) fail("TRANSFER_BUSY");
      const token = randomBytes(32).toString("hex");
      row = { id: digest(token), csrf: randomBytes(24).toString("hex") };
      s.repo.createSession(row.id, row.csrf, s.now() + 86400000);
      reply.setCookie("dropbin", token, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        secure: !!tls,
        maxAge: 86400,
      });
    }
    return { csrf: row.csrf };
  });
  app.post<{ Body: Manifest }>(
    prefix + "/uploads",
    { schema: { body: manifest } },
    async (req, reply) => {
      const owner = sid(req);
      s.limit("upload:" + req.ip, 30);
      return whileConnected(reply, (signal) =>
        s.create(owner, req.body, signal),
      );
    },
  );
  app.get<{ Params: Params }>(prefix + "/uploads/:batchId", async (req) =>
    s.owner(req.params.batchId, sid(req)),
  );
  app.post<{ Params: Params }>(
    prefix + "/uploads/:batchId/files/:fileId",
    async (req) =>
      upload(s, req, sid(req), req.params.batchId, req.params.fileId),
  );
  app.post<{ Params: Params }>(
    prefix + "/uploads/:batchId/finalize",
    async (req) => s.publish(req.params.batchId, sid(req)),
  );
  app.delete<{ Params: Params }>(
    prefix + "/uploads/:batchId",
    async (req, reply) => {
      const b = s.owned(req.params.batchId, sid(req));
      s.mark(b.id, "BATCH_REVOKED");
      return reply.code(202).send({ state: "deleting" });
    },
  );
  app.post<{ Body: { code: string; password?: string } }>(
    prefix + "/claims",
    { schema: { body: pickup } },
    async (req, reply) =>
      whileConnected(reply, (signal) =>
        s.pickup(
          sid(req),
          req.body.code,
          req.body.password ?? "",
          req.ip,
          signal,
        ),
      ),
  );
  app.get<{ Params: Params }>(prefix + "/claims/:claimId", async (req) =>
    s.status(req.params.claimId, sid(req)),
  );
  app.route<{ Params: Params }>({
    method: ["GET", "HEAD"],
    url: prefix + "/claims/:claimId/files/:fileId/content",
    handler: (req, reply) =>
      content(s, req, reply, sid(req), req.params.claimId, req.params.fileId),
  });
  await app.register(serve, {
    root: fileURLToPath(new URL("../../../web/", import.meta.url)),
    wildcard: false,
  });
  for (const path of ["/upload", "/download", "/receive/:claimId"])
    app.get(path, (_req, reply) => reply.sendFile("index.html"));
  app.setNotFoundHandler(() => fail("FILE_UNAVAILABLE"));
  return app;
}
