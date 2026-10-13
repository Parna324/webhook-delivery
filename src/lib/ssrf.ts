import dns from 'node:dns/promises';
import net from 'node:net';

function isPrivateIPv4(ip: string): boolean {
  const octets = ip.split('.').map((s) => parseInt(s, 10));
  if (octets.length !== 4 || octets.some((o) => isNaN(o) || o < 0 || o > 255)) {
    return true; // Malformed IPv4, treat as unsafe
  }

  const [o0, o1] = octets as [number, number, number, number];

  // 0.0.0.0/8 (Broadcast/Local)
  if (o0 === 0) return true;
  // 10.0.0.0/8 (Private RFC 1918)
  if (o0 === 10) return true;
  // 127.0.0.0/8 (Loopback)
  if (o0 === 127) return true;
  // 169.254.0.0/16 (Link-Local & Cloud Metadata e.g. AWS 169.254.169.254)
  if (o0 === 169 && o1 === 254) return true;
  // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255 RFC 1918)
  if (o0 === 172 && o1 >= 16 && o1 <= 31) return true;
  // 192.168.0.0/16 (Private RFC 1918)
  if (o0 === 192 && o1 === 168) return true;
  // 100.64.0.0/10 (Carrier-Grade NAT)
  if (o0 === 100 && o1 >= 64 && o1 <= 127) return true;
  // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (TEST-NET)
  if (o0 === 192 && o1 === 0) return true;
  // Multicast & Reserved (224.0.0.0/4 and 240.0.0.0/4)
  if (o0 >= 224) return true;

  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  // Loopback ::1, Unspecified ::
  if (normalized === '::1' || normalized === '::') return true;
  // Link-local fe80::/10
  if (
    normalized.startsWith('fe80:') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true;
  }
  // Unique Local Address fc00::/7 (fc00... or fd00...)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  // Multicast ff00::/8
  if (normalized.startsWith('ff')) return true;

  // IPv4-mapped IPv6 address (::ffff:192.168.x.x)
  if (normalized.startsWith('::ffff:')) {
    const ipv4Part = normalized.replace('::ffff:', '');
    if (net.isIPv4(ipv4Part)) {
      return isPrivateIPv4(ipv4Part);
    }
  }

  return false;
}

export function isPrivateIP(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true; // Unknown format, block for safety
}

/**
 * Validates a target URL against SSRF vulnerabilities.
 * Resolves DNS to concrete IPs and verifies none fall within private/link-local ranges.
 */
export async function validateWebhookUrl(
  urlStr: string,
  options: { allowLocal?: boolean } = {}
): Promise<{ valid: boolean; reason?: string; resolvedIp?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }

  // Only allow HTTP/HTTPS
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: `Disallowed protocol: ${parsed.protocol}. Only http and https are permitted.` };
  }

  const hostname = parsed.hostname;

  // Disallow loopback hostnames immediately
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '::1'
  ) {
    if (options.allowLocal) {
      return { valid: true, resolvedIp: '127.0.0.1' };
    }
    return { valid: false, reason: 'Loopback and localhost destinations are prohibited.' };
  }

  // Resolve hostname via DNS
  try {
    const lookups = await dns.lookup(hostname, { all: true });
    if (!lookups || lookups.length === 0) {
      return { valid: false, reason: 'DNS resolution returned no IP addresses.' };
    }

    for (const record of lookups) {
      if (isPrivateIP(record.address)) {
        if (options.allowLocal) {
          continue;
        }
        return {
          valid: false,
          reason: `Resolved IP address '${record.address}' belongs to a private/internal network.`,
          resolvedIp: record.address,
        };
      }
    }

    return { valid: true, resolvedIp: lookups[0]?.address };
  } catch (error) {
    return { valid: false, reason: `Failed to resolve host '${hostname}': ${(error as Error).message}` };
  }
}
