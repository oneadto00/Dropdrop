#!/usr/bin/env node
import { parseArgs } from "node:util";
import { networkInterfaces, homedir, platform } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isIPv4 } from "node:net";
import QRCode from "qrcode";
import {
  previewBatchCount,
  Instance,
  safeRoot,
} from "../../../packages/storage/src/index.js";

import {
  Transfers,
  defaults,
  makeHttp,
} from "../../../packages/server/src/index.js";

import { rankAddresses } from "./network-address.js";
import { listenControl, requestControl } from "./control.js";
const help =
  "Dropdrop 局域网文件中转\n  dropdrop start [--host IPv4] [--port 端口] [--data-dir 目录] [--cert 证书 --key 私钥]\n    [--max-file-bytes 字节] [--max-batch-bytes 字节] [--total-bytes 字节]\n    [--max-active-downloads <1-64>] [--max-active-uploads <1-16>]\n  dropdrop cleanup [--data-dir 目录] [--dry-run] [--json]";
function integer(
  input: string | undefined,
  fallback: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
) {
  if (input === undefined) return fallback;
  const n = Number(input);
  if (!/^\d+$/.test(input) || !Number.isSafeInteger(n) || n < min || n > max)
    throw Error("参数数值无效");
  return n;
}
async function main() {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      "data-dir": { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      cert: { type: "string" },
      key: { type: "string" },
      "max-file-bytes": { type: "string" },
      "max-batch-bytes": { type: "string" },
      "max-active-downloads": { type: "string" },
      "max-active-uploads": { type: "string" },
      "total-bytes": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (v.help || !positionals.length) {
    console.log(help);
    return;
  }
  const [cmd] = positionals;
  if (positionals.length !== 1 || !["start", "cleanup"].includes(cmd))
    throw Error("命令无效");
  const downloads = integer(
    v["max-active-downloads"],
    defaults.downloads,
    1,
    64,
  );
  const uploads = integer(v["max-active-uploads"], defaults.uploads, 1, 16);
  const base =
    platform() === "darwin"
      ? join(homedir(), "Library/Application Support")
      : platform() === "win32"
        ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"))
        : (process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"));
  const root = safeRoot(
    v["data-dir"] ?? process.env.DROPDROP_DATA_DIR ?? join(base, "Dropdrop"),
  );
  const preview = !!v["dry-run"];
  const output = (report: unknown) => {
    console.log(
      v.json
        ? JSON.stringify({ target: root, preview, report })
        : (preview ? "清理预览 " : "清理完成 ") +
            root +
            " " +
            JSON.stringify(report),
    );
  };
  if (cmd === "cleanup" && (!existsSync(root) || !readdirSync(root).length)) {
    output({ objects: 0, bytes: 0, batches: 0, active: 0 });
    return;
  }
  const instance = new Instance(root, cmd === "start");
  let lock;
  try {
    lock = instance.lock();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "SQLITE_BUSY") throw e;
    if (cmd === "start") throw Error("该实例已在运行");
    output(await requestControl(instance, preview));
    return;
  }
  let s: Transfers | undefined;
  try {
    if (cmd === "cleanup" && preview) {
      const files = instance.inventory();
      output({
        objects: files.length,
        bytes: files.reduce((a, f) => a + f.size, 0),
        batches: previewBatchCount(instance),
        active: 0,
      });
      return;
    }
    const limits = {
      ...defaults,
      downloads,
      uploads,
      fileBytes: integer(v["max-file-bytes"], defaults.fileBytes, 1),
      batchBytes: integer(v["max-batch-bytes"], defaults.batchBytes, 1),
      totalBytes: integer(v["total-bytes"], defaults.totalBytes, 1),
    };
    const service = new Transfers(instance, limits);
    s = service;
    if (cmd === "cleanup") {
      try {
        output(await s.clear());
      } catch {
        throw Error("清理未完成，请检查实例对象、磁盘权限和数据库占用后重试");
      }
      return;
    }
    const candidates = rankAddresses(networkInterfaces());
    const visible =
      v.host === undefined || v.host === "0.0.0.0"
        ? candidates.find((candidate) => candidate.isUsable)?.address
        : v.host;
    if (visible === undefined)
      throw Error(
        "未找到可用的局域网地址，可使用 --host 指定 IPv4，或使用 --host 127.0.0.1 本机试用",
      );
    const host = v.host ?? visible;
    const port = integer(v.port ?? process.env.DROPDROP_PORT, 0, 0, 65535);
    if (!isIPv4(host))
      throw Error("请选择本机 IPv4 网卡，可使用 --host 127.0.0.1");
    if (!!v.cert !== !!v.key) throw Error("证书和私钥需要同时设置");
    const tls =
      v.cert && v.key
        ? { cert: readFileSync(v.cert), key: readFileSync(v.key) }
        : undefined;
    await service.recover();
    const app = await makeHttp(
      service,
      host === "0.0.0.0"
        ? [
            ...candidates.map((candidate) => candidate.address),
            "127.0.0.1",
            "localhost",
          ]
        : [host, ...(host === "127.0.0.1" ? ["localhost"] : [])],
      tls,
    );
    await app.listen({ host, port });
    try {
      const stopControl = await listenControl(service);
      try {
        const address = app.server.address();
        if (!address || typeof address === "string")
          throw Error("端口读取失败");
        const url =
          (tls ? "https://" : "http://") + visible + ":" + address.port;
        console.log("实例目录 " + root + "\n访问地址 " + url);
        if (v.host === undefined || host === "0.0.0.0") {
          const others = candidates.filter(
            (candidate) => candidate.address !== visible,
          );
          if (others.length)
            console.log("其他网卡地址（二维码无法打开时可改用 --host 指定）：");
          for (const { interfaceName, address, isUsable } of others) {
            const note = isUsable ? "" : "（已跳过：链路本地或代理虚拟地址）";
            console.log(
              `  ${interfaceName}  ${address}  --host ${address}${note}`,
            );
          }
        }
        console.log(
          await QRCode.toString(
            url,
            process.stdout.isTTY
              ? { type: "terminal", small: true }
              : { type: "utf8" },
          ),
        );
        let stop = () => {};
        const stopped = new Promise<void>((r) => {
          stop = r;
        });
        process.once("SIGTERM", stop);
        process.once("SIGINT", stop);
        const tick = setInterval(() => {
          try {
            service.tick();
          } catch {
            service.maintenance = true;
            console.error("存储异常，已停止业务请求");
            stop();
          }
        }, 1000);
        try {
          await stopped;
        } finally {
          clearInterval(tick);
          process.off("SIGTERM", stop);
          process.off("SIGINT", stop);
        }
      } finally {
        await stopControl();
      }
    } finally {
      service.maintenance = true;
      const tasks = [...service.tasks];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (tasks.length)
          await Promise.race([
            Promise.all(tasks.map((t) => t.done)),
            new Promise((r) => {
              timer = setTimeout(r, 5000);
            }),
          ]);
      } finally {
        clearTimeout(timer);
      }
      for (const t of tasks) t.controller.abort();
      await Promise.all(tasks.map((t) => t.done));
      await app.close();
      if (!existsSync(instance.checked("maintenance"))) await service.recover();
    }
  } finally {
    s?.repo.close();
    lock.close();
  }
}
main().catch((error: unknown) => {
  const e = error as NodeJS.ErrnoException;
  const msg =
    e.code === "EADDRINUSE"
      ? "端口已被占用"
      : e.code === "ENOENT"
        ? "找不到实例文件或证书"
        : e.code === "EACCES"
          ? "没有访问权限"
          : e.message;
  const invalidLimit =
    e.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" &&
    /^Option '--max-active-(?:downloads|uploads)'/.test(msg);
  const message = invalidLimit
    ? "参数数值无效"
    : /^[\u3400-\u9fff]/.test(msg) || msg === "CLEANUP_BUSY"
      ? msg
      : "操作失败，请核对实例目录、权限和参数";
  if (process.argv.includes("--json"))
    console.error(JSON.stringify({ ok: false, message }));
  else console.error("Dropdrop：" + message);
  process.exitCode =
    e.code === "EIO" || e.code === "ENOSPC" || msg.includes("清理未完成")
      ? 1
      : 2;
});
