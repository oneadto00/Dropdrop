export function formatBytes(n: number) {
  return n < 1024
    ? n + " B"
    : n < 1024 ** 2
      ? (n / 1024).toFixed(1) + " KiB"
      : n < 1024 ** 3
        ? (n / 1024 ** 2).toFixed(1) + " MiB"
        : (n / 1024 ** 3).toFixed(1) + " GiB";
}
