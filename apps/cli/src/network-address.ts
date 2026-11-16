import type { networkInterfaces } from "node:os";

interface Candidate {
  interfaceName: string;
  address: string;
  isUsable: boolean;
}
const virtualInterface =
  /^(utun|tun|tap|bridge|docker|br-|veth|vmnet|vboxnet|vethernet|awdl|llw|feth|zt|tailscale|wg)/i;

function subnetPriority(address: string) {
  const [first, second] = address.split(".").map(Number);
  if (first === 192 && second === 168) return 0;
  if (first === 10) return 1;
  if (first === 172 && second >= 16 && second <= 31) return 2;
  return 3;
}

export function rankAddresses(
  interfaces: ReturnType<typeof networkInterfaces>,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    for (const { family, internal, address } of entries ?? []) {
      if (family === "IPv4" && !internal)
        candidates.push({
          interfaceName,
          address,
          isUsable: !/^(169\.254|198\.(18|19))\./.test(address),
        });
    }
  }
  return candidates.sort((left, right) => {
    if (left.isUsable !== right.isUsable) return left.isUsable ? -1 : 1;
    if (!left.isUsable) return 0;
    return (
      Number(virtualInterface.test(left.interfaceName)) -
        Number(virtualInterface.test(right.interfaceName)) ||
      subnetPriority(left.address) - subnetPriority(right.address)
    );
  });
}
