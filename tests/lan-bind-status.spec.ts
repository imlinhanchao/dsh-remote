/**
 * The LAN-bind status frame and the block the boot re-assert writes (issue
 * #1893). The reused projection `lanBindFrameOf` is the shape
 * `GET /api/pair/lan-bind` serves, and `desiredBindHost` is the only planner
 * behind the managed block: these specs hold one side of that contract - what
 * the card reads, and what reaches the patch file.
 *
 * The write half runs the real `writeLanBind` against a temp DSH home, so the
 * "never writes a wildcard on a host that refuses it" property is asserted on
 * the file content rather than on a call.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { lanBindState, writeLanBind } from '../src/lan-bind.ts'
import { desiredBindHost, type LanBindCapability } from '../src/lan-bind-plan.ts'
import { lanBindFrameOf, type LanBindFrameInput } from '../src/index.ts'

/** A host whose webserver schema still accepts the wildcard bind. */
const WILDCARD_HOST: LanBindCapability = { wildcardSupported: true, candidates: ['192.168.1.5'] }

/** A host whose webserver schema rejects the wildcard (0.2.1-rc.2 and later). */
const CONCRETE_HOST: LanBindCapability = { wildcardSupported: false, candidates: ['192.168.1.5', '10.0.0.3'] }

/** No firewall manager on this platform, so the frame never probes the real OS. */
const NO_FIREWALL = { ok: true, managed: false } as const

const tempDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'remote-web-ui-lan-bind-status-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * The frame input one test pins, with the neutral defaults the other fields
 * would otherwise carry.
 * @param overrides - the fields this test pins.
 * @returns the input the frame is built from.
 */
function inputOf(overrides: Partial<LanBindFrameInput>): LanBindFrameInput {
  return {
    profile: 'web',
    setting: undefined,
    blockHost: undefined,
    bindHost: '127.0.0.1',
    port: 3080,
    wildcardSupported: false,
    candidates: CONCRETE_HOST.candidates,
    startupHost: undefined,
    ...overrides,
  }
}

describe('lanBindFrameOf on a host that still accepts the wildcard', () => {
  it('operator: the toggle on plans the wildcard and advertises every interface', () => {
    // Given a host whose schema accepts 0.0.0.0 and the toggle flipped on
    // When the status frame is built for a running wildcard bind
    // Then the next write pins the wildcard, the host reports that capability,
    // and the LAN URLs name each candidate interface
    const frame = lanBindFrameOf(inputOf({
      setting: true,
      blockHost: '0.0.0.0',
      bindHost: '0.0.0.0',
      wildcardSupported: true,
    }), () => NO_FIREWALL)
    expect(frame).toMatchObject({
      profile: 'web',
      setting: true,
      blockHost: '0.0.0.0',
      bindHost: '0.0.0.0',
      desiredHost: '0.0.0.0',
      wildcardSupported: true,
      supportedHosts: ['192.168.1.5', '10.0.0.3'],
      lanBlocked: false,
      pendingRestart: false,
      firewall: NO_FIREWALL,
    })
  })
})

describe('lanBindFrameOf on a host that rejects the wildcard', () => {
  it('operator: the toggle on plans the first concrete address, not the wildcard', () => {
    // Given a host whose schema rejects 0.0.0.0 and two LAN addresses
    // When the status frame is built
    // Then the planned literal is the first candidate, the card is told the
    // wildcard is refused, and the next start will pin that address
    const frame = lanBindFrameOf(inputOf({
      setting: true,
      blockHost: '192.168.1.5',
      bindHost: '127.0.0.1',
      wildcardSupported: false,
    }))
    expect(frame).toMatchObject({
      desiredHost: '192.168.1.5',
      wildcardSupported: false,
      supportedHosts: ['192.168.1.5', '10.0.0.3'],
      lanBlocked: false,
      pendingRestart: true,
    })
  })

  it('operator: a concrete bind advertises its own address as the LAN URL', () => {
    // Given a running bind on one concrete interface address
    // When the status frame is built
    // Then the LAN URL names that address, because a bind to one interface is
    // only reachable there, and the live bind is not reported as pending
    const frame = lanBindFrameOf(inputOf({
      setting: true,
      blockHost: '192.168.1.5',
      bindHost: '192.168.1.5',
      wildcardSupported: false,
    }))
    expect(frame.lanUrls).toEqual(['http://192.168.1.5:3080'])
    expect(frame.pendingRestart).toBe(false)
  })

  it('operator: a machine with no LAN address reports the blocked toggle', () => {
    // Given a host that rejects the wildcard and no advertisable IPv4 address
    // When the toggle is on
    // Then nothing can be pinned: desiredHost is null and lanBlocked says why,
    // so the card can explain the state instead of showing a dead toggle
    const frame = lanBindFrameOf(inputOf({
      setting: true,
      bindHost: '127.0.0.1',
      wildcardSupported: false,
      candidates: [],
    }))
    expect(frame).toMatchObject({
      desiredHost: null,
      wildcardSupported: false,
      supportedHosts: [],
      lanBlocked: true,
      lanUrls: [],
    })
  })

  it('operator: a wildcard CLI flag is not planned back into the block', () => {
    // Given a rejecting host and the CLI flag that feeds the same schema
    // When the frame plans the next write
    // Then the wildcard is not echoed: the concrete candidate is planned
    // instead, which is what the write path receives
    const frame = lanBindFrameOf(inputOf({
      setting: true,
      bindHost: '127.0.0.1',
      startupHost: '0.0.0.0',
      wildcardSupported: false,
    }))
    expect(frame.desiredHost).toBe('192.168.1.5')
    expect(frame.lanBlocked).toBe(false)
  })
})

describe('lanBindFrameOf on either host kind', () => {
  it('operator: an untouched toggle plans nothing and claims no block', () => {
    // Given a profile whose toggle was never flipped
    // When the status frame is built
    // Then no host is planned, the setting reads null, and the state is not
    // reported as blocked (nothing was asked for)
    const frame = lanBindFrameOf(inputOf({ setting: undefined, wildcardSupported: false }))
    expect(frame).toMatchObject({ setting: null, desiredHost: null, lanBlocked: false, pendingRestart: false })
    // The capability is still stated, so the card can explain a future flip.
    expect(frame.wildcardSupported).toBe(false)
  })

  it('operator: a loopback bind advertises no LAN URL and needs no firewall rule', () => {
    // Given a toggle off and the loopback bind it pins
    // When the status frame is built
    // Then there is no LAN URL, the firewall summary is read with LAN off
    const seen: boolean[] = []
    const frame = lanBindFrameOf(
      inputOf({ setting: false, blockHost: '127.0.0.1', bindHost: '127.0.0.1' }),
      (_port, lanOn) => {
        seen.push(lanOn)
        return NO_FIREWALL
      },
    )
    expect(frame.lanUrls).toEqual([])
    expect(seen).toEqual([false])
  })

  it('operator: a concrete-literal bind reads as LAN on for the firewall summary', () => {
    // Given a running bind on a concrete interface address
    // When the status frame is built
    // Then the firewall state is read with LAN on, because that bind exposes
    // the port exactly like the wildcard did
    const seen: boolean[] = []
    lanBindFrameOf(
      inputOf({ setting: true, bindHost: '192.168.1.5' }),
      (_port, lanOn) => {
        seen.push(lanOn)
        return NO_FIREWALL
      },
    )
    expect(seen).toEqual([true])
  })

  it('operator: the frame keeps every field the card already reads', () => {
    // Given a settled frame on a concrete-address bind (the shape every field
    // can be asserted on without reading this machine's interfaces)
    // When the frame is read back
    // Then the pre-existing field names and meanings are unchanged
    const frame = lanBindFrameOf(
      inputOf({ setting: true, blockHost: '192.168.1.5', bindHost: '192.168.1.5', wildcardSupported: false }),
      () => NO_FIREWALL,
    )
    expect(Object.keys(frame).sort()).toEqual([
      'bindHost',
      'blockHost',
      'desiredHost',
      'firewall',
      'lanBlocked',
      'lanUrls',
      'pendingRestart',
      'platform',
      'port',
      'profile',
      'setting',
      'supportedHosts',
      'wildcardSupported',
    ])
    expect(frame).toMatchObject({
      profile: 'web',
      setting: true,
      blockHost: '192.168.1.5',
      bindHost: '192.168.1.5',
      port: 3080,
      platform: process.platform,
      firewall: NO_FIREWALL,
    })
    expect(frame.lanUrls).toEqual(['http://192.168.1.5:3080'])
    expect(frame.pendingRestart).toBe(false)
  })
})

describe('the managed block the boot re-assert writes', () => {
  it('operator: a rejecting host writes the concrete address verbatim', () => {
    // Given a profile the toggle has turned on and a host whose schema
    // rejects the wildcard
    // When the boot re-assert plans and writes the block
    // Then the file pins this machine's LAN address, never the wildcard
    const home = tempHome()
    const patch = join(home, 'profiles', 'web', 'cordis.patch.yml')
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    const host = desiredBindHost(true, undefined, CONCRETE_HOST)
    expect(host).toBe('192.168.1.5')
    writeLanBind(host as string, 3080, 'web', home)
    const content = readFileSync(patch, 'utf8')
    expect(content).toContain("host: '192.168.1.5'")
    expect(content).not.toContain('0.0.0.0')
    expect(lanBindState('web', home)).toEqual({ blockPresent: true, host: '192.168.1.5', port: 3080 })
  })

  it('operator: a wildcard-accepting host keeps the wildcard block', () => {
    // Given a host whose schema still accepts the wildcard
    // When the boot re-assert plans and writes the block
    // Then the block keeps pinning 0.0.0.0, which is today's behaviour
    const home = tempHome()
    const patch = join(home, 'profiles', 'web', 'cordis.patch.yml')
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    const host = desiredBindHost(true, undefined, WILDCARD_HOST)
    writeLanBind(host as string, 3080, 'web', home)
    expect(lanBindState('web', home)).toEqual({ blockPresent: true, host: '0.0.0.0', port: 3080 })
  })

  it('operator: a blocked plan leaves the profile file untouched', () => {
    // Given a toggle on, a rejecting host and no LAN address to pin
    // When the plan comes back undefined (the write path skips it)
    // Then the profile keeps exactly the bytes it had
    const home = tempHome()
    const patch = join(home, 'profiles', 'web', 'cordis.patch.yml')
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    const original = '- id: keep\n  config:\n    lanBind: true\n'
    writeFileSync(patch, original)
    const host = desiredBindHost(true, undefined, { wildcardSupported: false, candidates: [] })
    expect(host).toBeUndefined()
    // The write path guards on exactly this: no planned host, no write.
    if (host !== undefined) writeLanBind(host, 3080, 'web', home)
    expect(readFileSync(patch, 'utf8')).toBe(original)
  })

  it('operator: a stale wildcard block is rewritten to the concrete address', () => {
    // Given a profile a previous version pinned 0.0.0.0 into (the brick)
    // When this version's boot re-assert runs on a rejecting host
    // Then the block is rewritten to the concrete address, so the next start
    // validates
    const home = tempHome()
    const patch = join(home, 'profiles', 'web', 'cordis.patch.yml')
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    writeLanBind('0.0.0.0', 3080, 'web', home)
    expect(lanBindState('web', home)).toEqual({ blockPresent: true, host: '0.0.0.0', port: 3080 })
    const host = desiredBindHost(true, undefined, CONCRETE_HOST)
    writeLanBind(host as string, 3080, 'web', home)
    const content = readFileSync(patch, 'utf8')
    expect(content).not.toContain("host: '0.0.0.0'")
    expect(lanBindState('web', home)).toEqual({ blockPresent: true, host: '192.168.1.5', port: 3080 })
  })
})
