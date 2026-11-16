import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const folded = new Map();
for (const path of files) {
  const key = path.toLowerCase();
  assert.ok(
    !folded.has(key) || folded.get(key) === path,
    "路径大小写冲突 " + path,
  );
  folded.set(key, path);
  const name = path.split("/").at(-1);
  if (key.endsWith(".md") && path !== "README.md")
    assert.match(
      name,
      /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/,
      "文档命名异常 " + path,
    );
}
for (const file of files.filter((path) => path.endsWith(".md"))) {
  const source = readFileSync(file, "utf8");
  assert.equal(
    (source.match(/^```/gm) ?? []).length % 2,
    0,
    "代码围栏未闭合 " + file,
  );
  for (const [, link] of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    if (!link.includes("://") && !link.startsWith("#"))
      assert.ok(
        existsSync(resolve(dirname(file), link.split("#")[0])),
        file + " " + link,
      );
  }
}
console.log("通过：仓库路径大小写、规范文件名、Markdown 本地链接与代码围栏");
