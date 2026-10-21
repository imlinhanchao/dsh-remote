/** Pure lan-bind decision helpers: flags-win precedence, pendingRestart, firewall gate. */
import { describe, expect, it } from 'vitest'
import { desiredBindHost, desiredBindPort, firewallActionNeeded, isLanReachableBind, pendingRestartOf, refusedStartupHost, resolveManagedProfile, type LanBindCapability } from '../src/lan-bind-plan.ts'

describe('resolveManagedProfile', () => {
  it('operator: an explicit config wins over the launched profile and the environment', () => {
    // Given an explicit profile config beside a launched profile and an
    // environment value
    // When the managed profile resolves
    // Then the explicit config wins
    expect(resolveManagedProfile('qa', 'desktop', 'web')).toBe('qa')
  })

  it('operator: the launched profile wins over the environment (the Desktop client)', () => {
    // Given the Desktop client, which boots "desktop" without exporting
    // DSH_PROFILE (an environment-only resolution edited profiles/web there)
    // When no explicit config is set
    // Then the launched profile is the managed one, environment or not
    expect(resolveManagedProfile(undefined, 'desktop', undefined)).toBe('desktop')
    expect(resolveManagedProfile(undefined, 'desktop', 'web')).toBe('desktop')
  })

  it('operator: resolution falls back to the environment, then to web', () => {
    // Given neither an explicit config nor a launched profile
    // When the environment names a profile, or names nothing
    // Then the environment wins, and the default managed profile is web
    expect(resolveManagedProfile(undefined, undefined, 'web')).toBe('web')
    expect(resolveManagedProfile(undefined, undefined, undefined)).toBe('web')
  })
})

/** A host whose webserver schema still accepts the wildcard bind. */
const WILDCARD_HOST: LanBindCapability = { wildcardSupported: true, candidates: ['192.168.1.5', '10.0.0.3'] }

/** A host whose webserver schema rejects the wildcard (0.2.1-rc.2 and later). */
const CONCRETE_HOST: LanBindCapability = { wildcardSupported: false, candidates: ['192.168.1.5', '10.0.0.3'] }

/**
 * The installed schema's rule, as the probe reports it: only a concrete IPv4
 * literal that is not the wildcard is a bind the host accepts.
 * @param host - the bind literal under test.
 * @returns true for a concrete non-wildcard IPv4 literal.
 */
function literalOnly(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false
  return host !== '0.0.0.0'
}

/** A wildcard-accepting host that also refuses every non-literal flag. */
const WILDCARD_LITERAL_HOST: LanBindCapability = {
  wildcardSupported: true,
  candidates: ['192.168.1.5', '10.0.0.3'],
  acceptsHost: literalOnly,
}

/** A wildcard-rejecting host that also refuses every non-literal flag. */
const CONCRETE_LITERAL_HOST: LanBindCapability = {
  wildcardSupported: false,
  candidates: ['192.168.1.5', '10.0.0.3'],
  acceptsHost: literalOnly,
}

describe('desiredBindHost', () => {
  it('operator: a concrete CLI host wins over the toggle on either host kind', () => {
    // Given a host that accepts the wildcard and one that rejects it
    // When an operator passes a concrete --host
    // Then that literal is pinned verbatim on both, and the toggle off still
    // pins loopback (the flag never reaches a disabled toggle)
    expect(desiredBindHost(true, '127.0.0.1', WILDCARD_HOST)).toBe('127.0.0.1')
    expect(desiredBindHost(true, '192.168.1.5', WILDCARD_HOST)).toBe('192.168.1.5')
    expect(desiredBindHost(true, '192.168.1.5', CONCRETE_HOST)).toBe('192.168.1.5')
    expect(desiredBindHost(false, '192.168.1.5', WILDCARD_HOST)).toBe('127.0.0.1')
  })

  it('operator: a wildcard CLI host is never echoed back on a rejecting host', () => {
    // Given a host whose schema rejects the wildcard
    // When the CLI still passed --host 0.0.0.0 (the flag that bricked the
    // profile before, because it feeds the same schema)
    // Then the planner falls through to the toggle decision instead of
    // rewriting the refused literal into the block
    expect(desiredBindHost(true, '0.0.0.0', CONCRETE_HOST)).toBe('192.168.1.5')
    expect(desiredBindHost(true, '::', CONCRETE_HOST)).toBe('192.168.1.5')
    expect(desiredBindHost(false, '0.0.0.0', CONCRETE_HOST)).toBe('127.0.0.1')
    // A wildcard-accepting host keeps the flag's literal as before.
    expect(desiredBindHost(true, '0.0.0.0', WILDCARD_HOST)).toBe('0.0.0.0')
  })

  it('operator: the toggle pins the wildcard while the host still accepts it', () => {
    // Given a host whose schema accepts 0.0.0.0
    // When the toggle is flipped without a CLI host
    // Then today's behaviour is unchanged
    expect(desiredBindHost(true, undefined, WILDCARD_HOST)).toBe('0.0.0.0')
    expect(desiredBindHost(false, undefined, WILDCARD_HOST)).toBe('127.0.0.1')
  })

  it('operator: a rejecting host pins the first LAN candidate', () => {
    // Given a host whose schema rejects the wildcard and two LAN addresses
    // When the toggle is flipped on
    // Then the first candidate is pinned, in interface order
    expect(desiredBindHost(true, undefined, CONCRETE_HOST)).toBe('192.168.1.5')
    expect(desiredBindHost(true, undefined, { wildcardSupported: false, candidates: ['10.0.0.3'] })).toBe('10.0.0.3')
  })

  it('operator: a rejecting host with no LAN address pins nothing', () => {
    // Given a host that rejects the wildcard and a machine with no
    // advertisable IPv4 address
    // When the toggle is flipped on
    // Then no literal is planned, so the caller writes no block at all
    // instead of one the next start refuses
    expect(desiredBindHost(true, undefined, { wildcardSupported: false, candidates: [] })).toBeUndefined()
    // The toggle off is always satisfiable, whatever the host accepts.
    expect(desiredBindHost(false, undefined, { wildcardSupported: false, candidates: [] })).toBe('127.0.0.1')
  })

  it('operator: a caller with no capability keeps the pre-capability behaviour', () => {
    // Given a caller that never read the installed schema
    // When the toggle is flipped on
    // Then the wildcard is assumed accepted, which is what this planner did
    // before the capability existed, and no unsampled address is invented
    expect(desiredBindHost(true, undefined)).toBe('0.0.0.0')
    expect(desiredBindHost(false, undefined)).toBe('127.0.0.1')
  })
})

describe('desiredBindHost against what the running host accepts', () => {
  it('operator: a flag the host refuses is dropped on either host kind', () => {
    // Given a CLI --host naming something the webserver schema will not bind
    // (the managed block REPLACES the row's config, so nothing else validates
    // the flag that lands in it - issue #1893)
    // When the toggle is on
    // Then the flag loses and the plan falls through to the toggle decision:
    // the first LAN candidate on a rejecting host, the wildcard while it is
    // still accepted. Writing the refused value would brick the next start.
    expect(desiredBindHost(true, 'localhost', CONCRETE_LITERAL_HOST)).toBe('192.168.1.5')
    expect(desiredBindHost(true, 'example.com', CONCRETE_LITERAL_HOST)).toBe('192.168.1.5')
    expect(desiredBindHost(true, 'my-box', CONCRETE_LITERAL_HOST)).toBe('192.168.1.5')
    expect(desiredBindHost(true, 'localhost', WILDCARD_LITERAL_HOST)).toBe('0.0.0.0')
    expect(desiredBindHost(true, 'example.com', WILDCARD_LITERAL_HOST)).toBe('0.0.0.0')
  })

  it('operator: a refused flag with the toggle off still pins loopback', () => {
    // Given the same refused flag
    // When the toggle is off
    // Then loopback is pinned, exactly as it is with no flag at all
    expect(desiredBindHost(false, 'localhost', CONCRETE_LITERAL_HOST)).toBe('127.0.0.1')
    expect(desiredBindHost(false, 'example.com', CONCRETE_LITERAL_HOST)).toBe('127.0.0.1')
  })

  it('operator: a concrete literal flag still wins on both host kinds', () => {
    // Given a --host the schema does bind
    // When the toggle is on
    // Then the operator's literal is pinned verbatim, whatever the host is
    expect(desiredBindHost(true, '192.168.1.6', CONCRETE_LITERAL_HOST)).toBe('192.168.1.6')
    expect(desiredBindHost(true, '192.168.1.6', WILDCARD_LITERAL_HOST)).toBe('192.168.1.6')
    expect(desiredBindHost(true, '127.0.0.1', CONCRETE_LITERAL_HOST)).toBe('127.0.0.1')
  })

  it('operator: a probe that throws drops the flag instead of pinning it', () => {
    // Given a capability whose probe cannot answer
    // When a flag is passed
    // Then the flag is not pinned: an unreadable schema must never make the
    // plan write a literal the host might refuse
    const throwing: LanBindCapability = {
      wildcardSupported: false,
      candidates: ['192.168.1.5'],
      acceptsHost: () => { throw new Error('unreadable schema') },
    }
    expect(desiredBindHost(true, '192.168.1.6', throwing)).toBe('192.168.1.5')
  })

  it('operator: a capability without a probe keeps the pre-capability rule', () => {
    // Given a caller that never read the installed schema
    // When a concrete flag is passed
    // Then it is still honoured, and only the wildcard classes are dropped,
    // which is exactly what this planner did before the probe existed
    expect(desiredBindHost(true, 'localhost', CONCRETE_HOST)).toBe('localhost')
    expect(desiredBindHost(true, '192.168.1.6', CONCRETE_HOST)).toBe('192.168.1.6')
    expect(desiredBindHost(true, '0.0.0.0', CONCRETE_HOST)).toBe('192.168.1.5')
    expect(desiredBindHost(true, 'localhost')).toBe('localhost')
  })
})

describe('refusedStartupHost', () => {
  it('operator: names the flag value the host refuses, and nothing else', () => {
    // Given the CLI flags an operator may pass
    // When the boot path asks which one the host refuses
    // Then only the refused values are reported, so the warning names a real
    // override instead of firing on every start
    expect(refusedStartupHost('localhost', CONCRETE_LITERAL_HOST)).toBe('localhost')
    expect(refusedStartupHost('example.com', CONCRETE_LITERAL_HOST)).toBe('example.com')
    expect(refusedStartupHost('192.168.1.6', CONCRETE_LITERAL_HOST)).toBeUndefined()
    expect(refusedStartupHost(undefined, CONCRETE_LITERAL_HOST)).toBeUndefined()
    expect(refusedStartupHost('', CONCRETE_LITERAL_HOST)).toBeUndefined()
  })

  it('operator: a capability without a probe reports no refusal', () => {
    // Given a caller that never read the installed schema
    // When the boot path asks which flag the host refuses
    // Then nothing is reported, because nothing contradicts the flag
    expect(refusedStartupHost('localhost', CONCRETE_HOST)).toBeUndefined()
  })

  it('operator: a probe that throws reports the flag as refused', () => {
    // Given a probe that cannot answer
    // When the boot path asks which flag the host refuses
    // Then the flag is reported, matching the planner's drop-it decision
    const throwing: LanBindCapability = {
      wildcardSupported: false,
      candidates: ['192.168.1.5'],
      acceptsHost: () => { throw new Error('unreadable schema') },
    }
    expect(refusedStartupHost('192.168.1.6', throwing)).toBe('192.168.1.6')
  })
})

describe('isLanReachableBind', () => {
  it('operator: a wildcard and a concrete interface address both reach the LAN', () => {
    // Given the literals a managed block may pin
    // When the reachability decision runs
    // Then both are LAN reachable, so a host that refuses the wildcard does
    // not silently drop LAN access for the only bind it permits
    expect(isLanReachableBind('0.0.0.0')).toBe(true)
    expect(isLanReachableBind('192.168.1.5')).toBe(true)
    expect(isLanReachableBind('::')).toBe(true)
  })

  it('operator: loopback and an unsettled bind never reach the LAN', () => {
    // Given the loopback literals, a localhost token and an absent bind
    // When the reachability decision runs
    // Then none counts as LAN access
    expect(isLanReachableBind('127.0.0.1')).toBe(false)
    expect(isLanReachableBind('127.0.0.5')).toBe(false)
    expect(isLanReachableBind('::1')).toBe(false)
    expect(isLanReachableBind('localhost')).toBe(false)
    expect(isLanReachableBind(undefined)).toBe(false)
  })
})

describe('desiredBindPort', () => {
  it('prefers the CLI port, else the live port, else undefined', () => {
    expect(desiredBindPort(4000, 3080)).toBe(4000)
    expect(desiredBindPort(undefined, 3080)).toBe(3080)
    expect(desiredBindPort(undefined, undefined)).toBeUndefined()
    expect(desiredBindPort(undefined, Number.NaN)).toBeUndefined()
  })
})

describe('pendingRestartOf', () => {
  it('is false while the toggle has never been set', () => {
    expect(pendingRestartOf(undefined, undefined, '127.0.0.1')).toBe(false)
  })

  it('flags a live bind that has not caught up with the desired host', () => {
    expect(pendingRestartOf(true, '0.0.0.0', '127.0.0.1')).toBe(true)
    expect(pendingRestartOf(true, '0.0.0.0', '0.0.0.0')).toBe(false)
    expect(pendingRestartOf(false, '127.0.0.1', '0.0.0.0')).toBe(true)
  })

  it('does not flag a flag-managed bind as pending forever', () => {
    // --host 127.0.0.1 with the toggle on: the desired host IS 127.0.0.1.
    expect(pendingRestartOf(true, '127.0.0.1', '127.0.0.1')).toBe(false)
  })
})

describe('firewallActionNeeded', () => {
  it('applies once, then only on state movement', () => {
    expect(firewallActionNeeded(undefined, { enabled: true, port: 3080 })).toBe(true)
    const applied = { enabled: true, port: 3080 }
    expect(firewallActionNeeded(applied, { enabled: true, port: 3080 })).toBe(false)
    expect(firewallActionNeeded(applied, { enabled: false, port: 3080 })).toBe(true)
    expect(firewallActionNeeded(applied, { enabled: true, port: 3191 })).toBe(true)
  })

  it('skips entirely when the next state is not derivable', () => {
    expect(firewallActionNeeded(undefined, undefined)).toBe(false)
    expect(firewallActionNeeded({ enabled: true, port: 3080 }, undefined)).toBe(false)
  })
})
