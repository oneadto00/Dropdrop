export interface Manifest {
  files: { name: string; size: number }[];
  maxDownloads: number;
  expiresInSeconds: number;
  password?: string;
}
export type Task = {
  kind: "upload" | "download";
  batch: string;
  group: string;
  file: string;
  signal: AbortSignal;
  controller: AbortController;
  bytes: number;
  last: number;
  done: Promise<void>;
  finish: () => void;
};
export interface Limits {
  fileBytes: number;
  batchBytes: number;
  totalBytes: number;
  reserveBytes: number;
  downloads: number;
  uploads: number;
  passwordWaiting: number;
  passwordWaitMs: number;
  ipLimit: number;
  codeLimit: number;
  globalLimit: number;
}
