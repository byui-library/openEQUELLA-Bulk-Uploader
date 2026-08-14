// src/core/ai/endpoint.ts

/**
 * Is this host THIS MACHINE?
 *
 * WHY THE ANSWER MATTERS TWICE. A model endpoint on loopback is exempt from two
 * separate rules, for the same underlying reason -- nothing leaves the computer:
 *
 * 1. `provider.ts` refuses to send a bearer key over plain http to anywhere
 *    else, and permits it here.
 * 2. Task 9's confirmation dialog is not shown for a local run, because nothing
 *    is sent anywhere and nothing is billed.
 *
 * It lives in its own module rather than privately inside either, so the two
 * cannot drift into disagreeing about what "local" means -- which would show up
 * as a dialog that says nothing is being sent while a key crosses the network.
 *
 * PURE, and free of `node:*`, so `src/desktop/ui/` may import it. The renderer
 * is sandboxed and a Node import there blanks the window silently.
 *
 * A PRIVATE LAN ADDRESS IS NOT LOOPBACK. `192.168.1.10` is somebody else's
 * machine on a network with other people's machines on it; the traffic is
 * readable by every one of them, and it is genuinely being sent somewhere.
 * Only this host counts.
 */
export function isLoopbackHost(hostname: string): boolean {
  // `URL.hostname` keeps the brackets on an IPv6 literal.
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === 'localhost') return true;
  // RFC 6761 reserves the entire .localhost TLD for loopback; some runtimes and
  // reverse proxies use it. `localhost.example.edu` is NOT covered -- it is an
  // ordinary name under somebody's domain, which is exactly the trap.
  if (host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  // The whole 127.0.0.0/8, not 127.0.0.1 alone: runtimes and container setups
  // bind elsewhere in it. Anchored at both ends so `127.0.0.1.example.edu`
  // cannot pass, and each octet is bounded so `1270.0.1` cannot either.
  return /^127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/.test(host) && everyOctetInRange(host);
}

function everyOctetInRange(host: string): boolean {
  return host.split('.').every((octet) => Number(octet) <= 255);
}

/**
 * Is this base URL served by this machine?
 *
 * AN ADDRESS THAT WILL NOT PARSE IS NOT LOCAL. Every caller reads this as "is
 * this safe and free", so the unknown case has to be the cautious one:
 * answering true for a typo would exempt it from the check that stops a key
 * crossing the network.
 */
export function isLoopbackEndpoint(baseUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}
