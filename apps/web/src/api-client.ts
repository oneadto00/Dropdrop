import { messages, type Code } from "../../../packages/core/src/index";
export interface Batch {
  batchId: string;
  expiresAt: number;
  startedDownloads: number;
  maxDownloads: number;
  state: string;
  files: { id: string; name: string; size: number; uploaded: boolean }[];
}
export interface Claim extends Batch {
  claimId: string;
  counted: boolean;
  completed: boolean;
  active: { fileId: string; emittedBytes: number }[];
  progress: { fileId: string; servedBytes: number }[];
}
export const prefix = "/api/v1";
let csrf = "";
export class ApiError extends Error {
  constructor(
    readonly code: Code,
    readonly retryAfter = 0,
  ) {
    super(messages[code][1]);
  }
}
function checkError(data: { code?: string }, retryAfter = 0): never {
  const code = data?.code;
  throw new ApiError(
    code && Object.hasOwn(messages, code) ? (code as Code) : "INTERNAL_ERROR",
    retryAfter,
  );
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  if (!csrf && path !== "/session")
    csrf = (await api<{ csrf: string }>("/session")).csrf;
  const response = await fetch(prefix + path, {
    method,
    signal,
    headers: {
      "x-csrf-token": csrf,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    if (response.status === 401) csrf = "";
    checkError(
      await response.json().catch(() => ({})),
      Number(response.headers.get("retry-after")) || 0,
    );
  }
  return response.json();
}
export function sendFile(
  path: string,
  file: File,
  signal: AbortSignal,
  progress: (bytes: number) => void,
) {
  return new Promise<void>((ok, no) => {
    const xhr = new XMLHttpRequest(),
      form = new FormData();
    const abort = () => xhr.abort();
    if (signal.aborted) {
      no(Error("取消"));
      return;
    }
    form.append("file", file);
    xhr.open("POST", prefix + path);
    xhr.setRequestHeader("x-csrf-token", csrf);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        progress(Math.floor((file.size * e.loaded) / e.total));
    };
    xhr.onerror = () => no(new Error("连接失败"));
    xhr.onabort = () => no(new Error("取消"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) ok();
      else {
        try {
          checkError(xhr.response ?? {});
        } catch (e) {
          no(e);
        }
      }
    };
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(form);
  });
}
export function explain(e: unknown) {
  return e instanceof ApiError ? e.message : "连接失败，请检查网络后重试";
}
