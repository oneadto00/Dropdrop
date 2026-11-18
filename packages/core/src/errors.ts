export const messages = {
  BAD_INPUT: [400, "请检查输入内容后重试"],
  PICKUP_UNAVAILABLE: [400, "取件码或访问密码不正确，请检查后重试"],
  FORBIDDEN: [403, "没有访问权限，请返回后重试"],
  SESSION_REQUIRED: [401, "会话已失效，请重新进入"],
  QUOTA_EXHAUSTED: [409, "无下载名额"],
  BATCH_EXPIRED: [409, "文件已过期，请联系上传者重新上传"],
  BATCH_REVOKED: [409, "上传者已撤销文件"],
  FILE_UNAVAILABLE: [409, "文件暂时无法下载，请联系上传者"],
  CLAIM_EXPIRED: [409, "本次取件会话已结束，请重新输入取件码"],
  INCOMPLETE: [409, "文件尚未完整上传"],
  STORAGE_FULL: [507, "暂存空间不足，请减少文件或稍后再试"],
  TRANSFER_BUSY: [429, "当前传输繁忙，请稍后重试"],
  RATE_LIMITED: [429, "操作过于频繁，请稍后重试"],
  SERVICE_CLEANING: [503, "服务正在清理，请稍后再试"],
  RANGE_INVALID: [416, "请求的文件范围不可用"],
  PRECONDITION: [412, "文件版本不匹配，请重新取件"],
  INTERNAL_ERROR: [500, "服务暂时不可用，请稍后重试"],
} as const;

export type Code = keyof typeof messages;

export class Fault extends Error {
  constructor(readonly code: Code) {
    super(messages[code][1]);
  }
}

export function fail(code: Code): never {
  throw new Fault(code);
}
