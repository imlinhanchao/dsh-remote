/**
 * Parse the operator's extra remote authorities. The pairing/push/pending
 * fences already trust loopback, the LAN literals, the configured public
 * base, and the deployment `trustedHosts`; this list adds ad-hoc hosts such as
 * a second frp domain, a Tailscale name, or a reverse proxy. Entries are
 * normalized to the `host[:port]` shape `isTrustedHost` compares, so a pasted
 * URL works as well as a bare authority.
 */

/** Cap on parsed entries; a settings typo must not grow the fence unbounded. */
const MAX_HOSTS = 32
/** Cap on one entry's length. */
const MAX_ENTRY_CHARS = 255

/**
 * Parse a comma/newline-separated host list.
 * @param text - raw settings value (undefined/empty yields no hosts).
 * @returns distinct normalized `host[:port]` authorities, in input order.
 */
export function parseRemoteHosts(text: string | undefined): string[] {
  if (text === undefined || text.trim() === '') return []
  const result: string[] = []
  for (const raw of text.split(/[\n,;]+/)) {
    if (result.length >= MAX_HOSTS) break
    const entry = raw.trim()
    if (entry === '' || entry.startsWith('#')) continue
    if (entry.length > MAX_ENTRY_CHARS) continue
    const host = normalizeEntry(entry)
    if (host === undefined) continue
    if (!result.includes(host)) result.push(host)
  }
  return result
}

/**
 * Normalize one entry to a URL authority.
 * @param entry - bare host, host:port, or a URL with a scheme/path.
 * @returns the lowercase authority, or undefined when unparsable.
 */
function normalizeEntry(entry: string): string | undefined {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(entry) ? entry : `http://${entry}`
  try {
    const url = new URL(candidate)
    const host = url.host.toLowerCase()
    if (host === '' || url.hostname === '') return undefined
    return host
  } catch {
    return undefined
  }
}
