/**
 * Pure decision helpers shared by the lan-bind sync path (index.ts) and the
 * status path (lanBindStatus). Extracted so the flags-win precedence, the
 * pending-restart divergence check, and the firewall re-apply gate have one
 * implementation and direct unit coverage.
 */

import { isLoopbackBind, isWildcardLiteral } from './host-bind-capability.ts'

/**
 * A bind host the managed block may pin. The literal is whatever the installed
 * host approved: `'0.0.0.0'` only on a host that still accepts the wildcard,
 * otherwise a loopback literal or one concrete interface address of this
 * machine (the CLI `--host` an operator asked for, or the first LAN candidate).
 */
export type LanBindPlanHost = string

/** webStartup facts the CLI hands the process (absent unless a flag was passed). */
export interface StartupFacts {
  host?: string
  port?: number
}

/**
 * What the running host accepts, and which concrete addresses it could pin.
 * Sampled once per boot: the webserver package cannot change under a running
 * process, and the interface list is frozen for the same reason the QR bases
 * are (see src/lan.ts).
 */
export interface LanBindCapability {
  /** Whether the installed webserver schema accepts the wildcard bind. */
  wildcardSupported: boolean
  /** Local non-loopback IPv4 literals, in preference order (`lanIPv4Addresses()`). */
  candidates: string[]
  /**
   * Whether the running host accepts one bind literal. Optional so the pure
   * planner stays testable without importing the webserver package; a caller
   * running on a real host passes the schema probe (see bindAccepted in
   * host-bind-capability.ts).
   */
  acceptsHost?: (host: string) => boolean
}

/**
 * The permissive stand-in for a capability that carries no `acceptsHost`: a
 * planner with no schema probe cannot tell a hostname from a literal, so it
 * keeps the pre-capability rule and only refuses what it can prove refused -
 * the wildcard classes, which the schema's error names explicitly. This is the
 * historical behaviour for callers that never read the installed schema.
 * @param host - the bind literal under test.
 * @returns false for the wildcard classes, true for anything else.
 */
function acceptsUnlessWildcard(host: string): boolean {
  return !isWildcardLiteral(host)
}

/**
 * The capability assumed when a caller does not pass one: the wildcard is
 * accepted and no concrete candidate exists. That keeps the pre-capability
 * behaviour (the toggle on pins `0.0.0.0`) for callers that never read the
 * installed schema, and never manufactures an address that was not sampled.
 */
const ASSUMED_WILDCARD_CAPABILITY: LanBindCapability = {
  wildcardSupported: true,
  candidates: [],
  acceptsHost: acceptsUnlessWildcard,
}

/**
 * The bind host the managed block should pin.
 *
 * The order is: the toggle off always pins loopback; the toggle on lets a CLI
 * `--host` win only while the running host accepts that literal, because the
 * managed block REPLACES the webserver row's config wholesale - the flag's own
 * schema expression never reaches the row that boots, so nothing else would
 * validate it; then the wildcard while the host accepts it; then this
 * machine's first LAN candidate; and `undefined` when nothing bindable could be
 * pinned, which the caller reports instead of writing a block.
 *
 * A refused `--host` (a wildcard, or any value the schema will not bind -
 * `localhost`, a DNS name, a bare hostname) is therefore DROPPED and the plan
 * falls through to the toggle decision, exactly as a wildcard flag already
 * did: rewriting it into the block would brick the next start with a literal
 * the settings card cannot repair (issue #1893).
 *
 * Passing no capability keeps the historical behaviour for a host that accepts
 * the wildcard (`{ wildcardSupported: true, candidates: [] }`); a caller that
 * runs on a host refusing wildcards must pass the real capability.
 * @param lanBind - the toggle value.
 * @param startupHost - the CLI-provided bind host, when given.
 * @param capability - what the installed host accepts and could pin.
 * @returns the desired bind host literal, or undefined when nothing can be pinned.
 */
export function desiredBindHost(
  lanBind: boolean,
  startupHost: string | undefined,
  capability: LanBindCapability = ASSUMED_WILDCARD_CAPABILITY,
): LanBindPlanHost | undefined {
  if (!lanBind) return '127.0.0.1'
  if (typeof startupHost === 'string' && startupHost !== '') {
    const accepts = capability.acceptsHost ?? acceptsUnlessWildcard
    let accepted = false
    try {
      accepted = accepts(startupHost) === true
    } catch {
      // A probe that cannot answer must not make the plan pin a literal the
      // host would refuse: fall through to the toggle decision.
      accepted = false
    }
    if (accepted) return startupHost
  }
  if (capability.wildcardSupported) return '0.0.0.0'
  return capability.candidates[0]
}

/**
 * The CLI `--host` value the running host would refuse, when the capability's
 * probe says so. The planner drops such a flag silently by design (it is a
 * pure decision), so the caller reads it back here to warn once, naming the
 * value that was ignored. Absent when no flag was passed, when the capability
 * carries no probe (nothing to contradict), or when the host accepts it.
 * @param startupHost - the CLI-provided bind host, when given.
 * @param capability - what the installed host accepts.
 * @returns the refused flag value, or undefined when there is nothing to report.
 */
export function refusedStartupHost(startupHost: string | undefined, capability: LanBindCapability): string | undefined {
  if (typeof startupHost !== 'string' || startupHost === '') return undefined
  const accepts = capability.acceptsHost
  if (accepts === undefined) return undefined
  try {
    return accepts(startupHost) === true ? undefined : startupHost
  } catch {
    // A probe that cannot answer counts as a refusal: the flag is dropped by
    // the planner either way, and the operator is told instead of guessing.
    return startupHost
  }
}

/**
 * The reachability decision behind the QR bases, the status `lanUrls`, the
 * firewall summary and the boot's LAN warning: a bind that is not loopback is
 * reachable from another device, whatever literal it names. Equality with the
 * wildcard is deliberately not the test - on a host that refuses wildcard
 * binds the only LAN bind is a concrete interface address.
 * @param host - the block host or the live bind (absent before it settles).
 * @returns true when another device could dial the listener.
 */
export function isLanReachableBind(host: string | undefined): boolean {
  return !isLoopbackBind(host)
}

/**
 * The port the managed block should pin: the CLI port when given, else the
 * currently bound port. Undefined when neither is readable yet (the caller
 * skips the write and reports why).
 * @param startupPort - the CLI-provided port, when given.
 * @param livePort - the currently bound port, when finite.
 */
export function desiredBindPort(startupPort: number | undefined, livePort: number | undefined): number | undefined {
  if (typeof startupPort === 'number' && Number.isFinite(startupPort)) return startupPort
  return typeof livePort === 'number' && Number.isFinite(livePort) ? livePort : undefined
}

/**
 * Whether the running bind has not caught up with what the toggle (plus a
 * possibly overriding CLI host) will pin. Compared against the effective
 * desired host — not the raw toggle — so a flag-managed bind is not reported
 * as pending forever.
 * @param lanBind - the toggle value (undefined = untouched, never pending).
 * @param desiredHost - the effective desired host, or undefined when untouched.
 * @param liveHost - the currently bound host.
 */
export function pendingRestartOf(
  lanBind: boolean | undefined,
  desiredHost: LanBindPlanHost | undefined,
  liveHost: string | undefined,
): boolean {
  if (lanBind === undefined || desiredHost === undefined) return false
  return liveHost !== desiredHost
}

/** The last firewall state this process applied. */
export interface AppliedFirewallState {
  enabled: boolean
  port: number
}

/** The managed profile when neither the config nor the runtime names one. */
export const DEFAULT_MANAGED_PROFILE = 'web'

/**
 * The profile whose `cordis.patch.yml` the LAN bind toggle manages. An
 * explicit `profile` config wins; otherwise the launched profile the Host
 * publishes is authoritative, because the DSH Desktop client boots the
 * `desktop` profile without exporting `DSH_PROFILE` — an environment-only
 * fallback edited `profiles/web` there, so the toggle looked applied while
 * the running host never followed the block.
 * @param configured - the explicit `profile` plugin config, when set.
 * @param launched - the launched profile name the Host published, when available.
 * @param env - the DSH_PROFILE environment value, when set.
 */
export function resolveManagedProfile(
  configured: string | undefined,
  launched: string | undefined,
  env: string | undefined,
): string {
  return configured ?? launched ?? env ?? DEFAULT_MANAGED_PROFILE
}

/**
 * Whether the firewall rule must be (re)applied: only when the toggle or the
 * bound port moved since the last application. Keeps unrelated settings
 * saves from spawning netsh/firewall-cmd delete+add churn.
 * @param previous - the state applied earlier by this process, if any.
 * @param next - the state the settings now ask for, if derivable.
 */
export function firewallActionNeeded(
  previous: AppliedFirewallState | undefined,
  next: AppliedFirewallState | undefined,
): boolean {
  if (next === undefined) return false
  if (previous === undefined) return true
  return previous.enabled !== next.enabled || previous.port !== next.port
}
