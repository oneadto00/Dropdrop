import { fail } from "./errors.js";

export type RangePair = [number, number];

function offset(s: string) {
  const n = Number(s);
  if (!Number.isSafeInteger(n)) fail("BAD_INPUT");
  return n;
}

export function selectRange(
  header: string | undefined,
  size: number,
): RangePair | undefined {
  if (!header) return;
  if (header.length > 4096) fail("BAD_INPUT");
  const match = /^([^=]+)=(.*)$/.exec(header);
  if (!match) fail("BAD_INPUT");
  if (match[1].toLowerCase() !== "bytes") return;
  const parts = match[2].split(",").map((s) => {
    const m = /^(\d*)-(\d*)$/.exec(s.trim());
    if (!m || (!m[1] && !m[2])) fail("BAD_INPUT");
    const start = m[1] ? offset(m[1]) : undefined,
      end = m[2] ? offset(m[2]) : undefined;
    if (start !== undefined && end !== undefined && end < start)
      fail("BAD_INPUT");
    return { start, end };
  });
  if (parts.length > 1) return;
  const { start, end } = parts[0];
  const first = start ?? Math.max(0, size - (end ?? 0)),
    last = start === undefined ? size - 1 : Math.min(end ?? size - 1, size - 1);
  if (first >= size || last < first) fail("RANGE_INVALID");
  return [first, last];
}

export function mergeRanges(
  existing: RangePair[],
  added: RangePair,
): RangePair[] {
  const merged: RangePair[] = [];
  for (const [a, b] of [...existing, added].sort((x, y) => x[0] - y[0])) {
    const last = merged.at(-1);
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}
