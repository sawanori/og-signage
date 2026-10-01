import { isIP } from "node:net";

export class UrlPolicyError extends Error {
  readonly code = "unsafe_url";
  constructor() { super("The URL is outside the permitted public website scope"); }
}

/** DNS service trouble says nothing about the registered URL; retry instead of skipping it. */
export class DnsLookupError extends Error {
  readonly code = "dns_lookup_unavailable";
  constructor() { super("Public DNS lookup is temporarily unavailable"); }
}

export type HostResolver = (hostname: string) => Promise<string[]>;

export function normalizeResearchUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new UrlPolicyError(); }
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
      !host.includes('.') || host.includes(':') || isIP(host) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid|lan|home|onion)$/u.test(host)) {
    throw new UrlPolicyError();
  }
  url.hostname = host;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_.+|fbclid|gclid)$/iu.test(key)) url.searchParams.delete(key);
  }
  return url.href;
}

export function isPublicIp(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  const words = new URL(`http://[${address}]/`).hostname.slice(1, -1).split(":");
  const first = Number.parseInt(words[0] || "0", 16);
  const second = Number.parseInt(words[1] || "0", 16);
  // Only ordinary global unicast: exclude IETF special-purpose /23, documentation and 6to4.
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
    !(first === 0x2001 && (second <= 0x01ff || second === 0x0db8));
}

export async function resolvePublicHostname(hostname: string, fetcher: typeof fetch = fetch): Promise<string[]> {
  const answers = await Promise.all(["A", "AAAA"].map(async (type) => {
    const endpoint = new URL("https://cloudflare-dns.com/dns-query");
    endpoint.searchParams.set("name", hostname);
    endpoint.searchParams.set("type", type);
    const response = await fetcher(endpoint, {
      // Manual mode is supported by workerd; !ok below rejects redirects without following them.
      headers: { Accept: "application/dns-json" }, redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new DnsLookupError();
    const data = await response.json() as { Status?: number; Answer?: { type: number; data: string }[] };
    if (data.Status === 2) throw new DnsLookupError(); // SERVFAIL
    if (data.Status !== 0) throw new UrlPolicyError();
    return (data.Answer ?? []).filter((answer) => answer.type === 1 || answer.type === 28).map((answer) => answer.data);
  }));
  return answers.flat();
}

export async function assertPublicUrl(input: string, resolve: HostResolver = resolvePublicHostname): Promise<string> {
  const canonical = normalizeResearchUrl(input);
  const addresses = await resolve(new URL(canonical).hostname);
  if (!addresses.length || addresses.some((address) => !isPublicIp(address))) throw new UrlPolicyError();
  return canonical;
}

export function isInResearchScope(input: string, startingUrls: string[]): boolean {
  try {
    const candidate = new URL(normalizeResearchUrl(input));
    return startingUrls.some((start) => {
      const initial = new URL(normalizeResearchUrl(start));
      return candidate.hostname === initial.hostname;
    });
  } catch { return false; }
}

export function pagePriority(url: string): number {
  const path = new URL(url).pathname;
  if (path === "/") return 0;
  if (/company|about|business|service|product|事業|会社|サービス/iu.test(path)) return 1;
  if (/case|work|price|pricing|area|実績|料金/iu.test(path)) return 2;
  return 3;
}
