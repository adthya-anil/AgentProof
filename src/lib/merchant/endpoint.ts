/**
 * Deciding which merchant to test, from something a stranger typed.
 *
 * The point of the mapping layer is that the merchant is a *parameter*: infer where the
 * fields live, then run the same twelve invariants against whatever answered. That was true
 * internally long before it was reachable, because the endpoint was computed from the request
 * and pointed at one built-in shop. Anyone was entitled to read that as "the second merchant
 * is just another route in the same app".
 *
 * Accepting a URL from the browser and fetching it server-side is textbook SSRF: the request
 * leaves from inside the deployment, with whatever the deployment can reach. So the address is
 * checked before anything connects to it.
 *
 * A stated limitation, because a security control whose limits are not written down gets
 * trusted past them: this validates the *literal host* in the URL, not the address it
 * eventually resolves to. A hostname that resolves to a private address — DNS rebinding —
 * passes here. Closing that means resolving first and pinning the connection to the resolved
 * IP, which Node's fetch does not expose. For a tool that a developer points at a catalogue
 * they chose, host-level checks plus a short timeout are proportionate; for anything holding
 * real credentials they would not be.
 */

/** Where a blocked address gets its own explanation rather than a generic refusal. */
export type EndpointDecision =
  | { ok: true; url: string; builtIn: boolean }
  | { ok: false; reason: string };

/**
 * Addresses that exist to hand out credentials.
 *
 * On every major cloud these return instance metadata — frequently including short-lived
 * access tokens — to anything that can make an HTTP request from the instance. They are the
 * first thing an SSRF probe tries and they are never a shop.
 */
const METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
  "100.100.100.100",
  "192.0.0.192",
  "alibaba-inc.com",
]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopback(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true;
  // The whole 127/8 range, not just .0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Private and link-local ranges, which a shop on the public internet is never on.
 *
 * Matched literally rather than by parsing into an integer, because the goal is to reject the
 * obvious cases legibly, not to reimplement an IP library.
 */
function isPrivateAddress(host: string): boolean {
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // Link-local, including the metadata range these hosts live in.
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // Carrier-grade NAT, routinely internal.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^0\./.test(host)) return true;

  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/i.test(bare)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(bare)) return true;
  // IPv4-mapped IPv6, which would otherwise slip the checks above.
  if (/^::ffff:/i.test(bare)) return isPrivateAddress(bare.replace(/^::ffff:/i, ""));

  return false;
}

/**
 * Validates a merchant endpoint, or explains why it was refused.
 *
 * Refusing with a reason rather than attempting the request and reporting a failure: a blocked
 * address is a decision this tool made, and presenting it as though the merchant were down
 * would be the same category of lie the reporting layer exists to avoid.
 */
export function validateMerchantEndpoint(raw: string): EndpointDecision {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "no endpoint was given" };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      reason: `'${trimmed}' is not a URL. Include the scheme, e.g. https://shop.example/graphql`,
    };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      reason:
        `'${url.protocol}' is not supported. A merchant is reached over http or https; ` +
        "schemes like file: and gopher: exist in SSRF payloads, not in catalogues",
    };
  }

  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      reason:
        "credentials in the URL are not accepted — they would be written to the run log " +
        "and the audit trail. Use the mapping's headers instead",
    };
  }

  const host = url.hostname.toLowerCase();

  if (METADATA_HOSTS.has(host)) {
    return {
      ok: false,
      reason:
        `${host} is a cloud metadata address, not a merchant. It serves instance ` +
        "credentials to anything that can reach it",
    };
  }

  /**
   * Loopback is allowed, deliberately.
   *
   * It is what the built-in merchant runs on and what local development uses, so blocking it
   * would break the default path in the name of protecting it. The exposure is real but
   * narrow: a caller can probe ports on the machine already serving them this page. Private
   * *networks* stay blocked, which is where the interesting internal targets live.
   */
  if (isLoopback(host)) {
    return { ok: true, url: url.toString(), builtIn: false };
  }

  if (isPrivateAddress(host)) {
    return {
      ok: false,
      reason:
        `${host} is on a private or link-local network. This runs server-side, so that ` +
        "would reach machines inside the deployment rather than a shop on the internet",
    };
  }

  return { ok: true, url: url.toString(), builtIn: false };
}

/**
 * The endpoint a run should use: whatever was asked for, or the built-in merchant.
 *
 * The built-in stays the default so the demo is hermetic — nothing external can be down at
 * the moment someone is watching — while the parameter is what makes the claim checkable.
 */
export function resolveMerchantEndpoint(
  requested: string | null,
  builtIn: string,
): EndpointDecision {
  if (requested === null || requested.trim() === "") {
    return { ok: true, url: builtIn, builtIn: true };
  }
  return validateMerchantEndpoint(requested);
}
