import { createServer, request } from "node:http";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { writeFileSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { once } from "node:events";
import type { Instance } from "../../../packages/storage/src/index.js";
import type { Transfers } from "../../../packages/server/src/index.js";
function proof(instance: Instance, nonce: string, action: string) {
  return createHmac("sha256", instance.secret)
    .update(nonce + "|" + action)
    .digest("hex");
}
export async function listenControl(s: Transfers) {
  const nonce = randomBytes(24).toString("hex");
  const server = createServer(async (req, res) => {
    const action = req.url === "/preview" ? "preview" : "cleanup";
    const expected = Buffer.from("Bearer " + proof(s.instance, nonce, action)),
      actual = Buffer.from(String(req.headers.authorization ?? ""));
    if (
      req.method !== "POST" ||
      !["/cleanup", "/preview"].includes(req.url ?? "") ||
      req.socket.remoteAddress !== "127.0.0.1" ||
      req.headers.host !== "127.0.0.1:" + req.socket.localPort ||
      req.headers.origin !== undefined ||
      req.headers["sec-fetch-mode"] !== undefined ||
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      res.writeHead(403).end();
      return;
    }
    try {
      const report = action === "preview" ? s.summary() : await s.clear();
      const body = JSON.stringify(report);
      res
        .writeHead(200, {
          "Content-Type": "application/json",
          "X-Instance-Proof": proof(s.instance, nonce, body),
        })
        .end(body);
    } catch (e) {
      res
        .writeHead(
          e instanceof Error && e.message === "CLEANUP_BUSY" ? 409 : 500,
        )
        .end("清理未完成");
    }
  });
  server.maxConnections = 8;
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("控制端启动失败");
  const tmp = s.instance.checked("control.tmp"),
    path = s.instance.checked("control.json");
  try {
    writeFileSync(tmp, JSON.stringify({ port: address.port, nonce }), {
      mode: 0o600,
      flush: true,
    });
    renameSync(tmp, path);
  } catch (e) {
    server.close();
    throw e;
  }
  return async () => {
    const closed = once(server, "close");
    server.close();
    await closed;
    unlinkSync(path);
  };
}
export async function requestControl(instance: Instance, preview: boolean) {
  const { port, nonce } = JSON.parse(
    readFileSync(instance.checked("control.json"), "utf8"),
  );
  if (
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65535 ||
    typeof nonce !== "string" ||
    !/^[a-f0-9]{48}$/.test(nonce)
  )
    throw Error("控制端标识无效");
  const action = preview ? "preview" : "cleanup";
  return await new Promise<unknown>((ok, no) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/" + action,
        method: "POST",
        headers: { Authorization: "Bearer " + proof(instance, nonce, action) },
        signal: AbortSignal.timeout(120000),
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 16384) res.destroy(Error("控制端响应过大"));
        });
        res.on("error", no);
        res.on("end", () => {
          if (
            res.statusCode !== 200 ||
            res.headers["x-instance-proof"] !== proof(instance, nonce, body)
          ) {
            no(
              Error(
                res.statusCode === 409
                  ? "CLEANUP_BUSY"
                  : res.statusCode === 500
                    ? "清理未完成，请检查实例对象及磁盘权限"
                    : "控制端未确认清理结果",
              ),
            );
            return;
          }
          try {
            ok(JSON.parse(body));
          } catch {
            no(Error("控制端响应格式错误"));
          }
        });
      },
    );
    req.on("error", no);
    req.end();
  });
}
