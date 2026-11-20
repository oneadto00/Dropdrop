import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

export class ClaimTokenCodec {
  private readonly key: Buffer;
  constructor(secret: string) {
    this.key = createHmac("sha256", secret)
      .update("Dropdrop claim identifiers v1")
      .digest();
  }
  create(session: string, codeDigest: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(session));
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(codeDigest, "hex")),
      cipher.final(),
    ]);
    return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString(
      "base64url",
    );
  }
  // 接收会话记录删除后，服务端仍可为原浏览器查回摘要，用于解释失效原因。
  lookup(id: string, session: string) {
    if (!/^[A-Za-z0-9_-]{80}$/.test(id)) return;
    const token = Buffer.from(id, "base64url"),
      cipher = createDecipheriv("aes-256-gcm", this.key, token.subarray(0, 12));
    cipher.setAAD(Buffer.from(session));
    cipher.setAuthTag(token.subarray(44));
    try {
      return Buffer.concat([
        cipher.update(token.subarray(12, 44)),
        cipher.final(),
      ]).toString("hex");
    } catch {
      return;
    }
  }
}
