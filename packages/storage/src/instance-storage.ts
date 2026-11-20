import { acquireInstanceLock } from "./instance-lock.js";
import {
  mkdirSync,
  readdirSync,
  realpathSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  constants,
  openSync,
  closeSync,
  fstatSync,
  statfsSync,
  renameSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, dirname, join, parse } from "node:path";
import { homedir } from "node:os";
import { verifyWindowsAccess } from "./windows-access.js";
import Database from "better-sqlite3";
const objectName = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
type Identity = { dev: number; ino: number };
function identity(path: string, directory: boolean) {
  const s = lstatSync(path);
  if (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)
    throw Error("状态目录对象类型异常");
  if (
    process.platform !== "win32" &&
    (s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0)
  )
    throw Error("状态目录需要仅当前用户可访问");
  return { dev: s.dev, ino: s.ino };
}
function same(a: Identity, b: Identity) {
  return a.dev === b.dev && a.ino === b.ino;
}
export function safeRoot(input: string) {
  const absolute = resolve(input);
  // 先解析 macOS 的系统路径别名，再检查实例路径是否包含符号链接。
  const path =
    process.platform === "darwin"
      ? absolute.replace(/^\/(tmp|var)(?=\/|$)/, "/private/$1")
      : absolute;
  if (path === parse(path).root || path === realpathSync(homedir()))
    throw Error("请选择专用实例目录");
  let parent = path;
  while (!existsSync(parent) && parent !== dirname(parent))
    parent = dirname(parent);
  if (realpathSync(parent) !== parent) throw Error("实例路径不能包含符号链接");
  return path;
}
interface Marker {
  format: string;
  root: Identity;
  objects: Identity;
  staging: Identity;
  secret: string;
}
export class Instance {
  readonly root: string;
  private marker: Marker;
  constructor(input: string, create: boolean) {
    this.root = safeRoot(input);
    if (create) mkdirSync(this.root, { recursive: true, mode: 0o700 });
    verifyWindowsAccess(this.root);
    const root = identity(this.root, true);
    const marker = join(this.root, "instance.json");
    if (create && !existsSync(marker) && readdirSync(this.root).length === 0) {
      for (const name of ["staging", "objects"])
        mkdirSync(join(this.root, name), { mode: 0o700 });
      const data: Marker = {
        format: "Dropdrop-1",
        root,
        objects: identity(join(this.root, "objects"), true),
        staging: identity(join(this.root, "staging"), true),
        secret: randomBytes(32).toString("hex"),
      };
      writeFileSync(marker, JSON.stringify(data), { mode: 0o600, flag: "wx" });
    }
    identity(marker, false);
    this.marker = JSON.parse(readFileSync(marker, "utf8"));
    if (
      this.marker.format !== "Dropdrop-1" ||
      !same(root, this.marker.root) ||
      !/^[a-f0-9]{64}$/.test(this.marker.secret)
    )
      throw Error("实例标识不符");
    this.dir("staging");
    this.dir("objects");
  }
  get secret() {
    return this.marker.secret;
  }
  dir(kind: "staging" | "objects") {
    const dir = join(this.root, kind);
    if (
      !same(identity(this.root, true), this.marker.root) ||
      !same(identity(dir, true), this.marker[kind])
    )
      throw Error("实例目录身份改变");
    return dir;
  }
  private path(kind: "staging" | "objects", id: string) {
    if (!objectName.test(id)) throw Error("对象标识无效");
    return join(this.dir(kind), id);
  }
  diskFree() {
    const s = statfsSync(this.dir("staging"));
    return s.bavail * s.bsize;
  }
  stage(id: string) {
    return openSync(this.path("staging", id), "wx", 0o600);
  }
  publish(id: string) {
    const src = this.path("staging", id);
    identity(src, false);
    const dest = this.path("objects", id);
    try {
      lstatSync(dest);
      throw Error("目标对象已存在");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    renameSync(src, dest);
  }
  open(id: string, size: number) {
    const path = this.path("objects", id),
      entry = identity(path, false);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const s = fstatSync(fd);
      if (!same(s, entry) || s.nlink !== 1 || s.size !== size)
        throw Error("对象异常");
      return fd;
    } catch (e) {
      closeSync(fd);
      throw e;
    }
  }
  remove(kind: "staging" | "objects", id: string) {
    const path = this.path(kind, id);
    try {
      identity(path, false);
      unlinkSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  inventory() {
    return (["objects", "staging"] as const).flatMap((kind) =>
      readdirSync(this.dir(kind)).map((id) => {
        const p = this.path(kind, id);
        identity(p, false);
        return { id, kind, size: lstatSync(p).size };
      }),
    );
  }
  checked(name: string) {
    if (!same(identity(this.root, true), this.marker.root))
      throw Error("实例目录身份改变");
    const path = join(this.root, name);
    try {
      identity(path, false);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return path;
  }
  database(name: string, readonly = false) {
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      this.checked(name + suffix);
    const path = this.checked(name);
    if (!existsSync(path) && !readonly) closeSync(openSync(path, "wx", 0o600));
    return new Database(path, { readonly, timeout: 0 });
  }
  lock() {
    return acquireInstanceLock(this);
  }
}
