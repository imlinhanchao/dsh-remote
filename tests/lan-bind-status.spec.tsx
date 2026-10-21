/** @vitest-environment jsdom */
/**
 * The LAN-bind status lines (issue #1893). The card used to derive "LAN access
 * is on" from `blockHost === '0.0.0.0'`, which stops being true the moment the
 * host refuses wildcard binds: DSH 0.2.1-rc.2 rejects them, so the managed
 * block pins a concrete LAN literal of this machine instead (or nothing at all
 * when the machine has no LAN address). These specs hold the card to that
 * reality: either end of the block may prove LAN access, and the two failure
 * shapes each earn their own line.
 */
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isLanHost, type LanBindFrame } from '../src/client/pair-api.ts'
import { LanBindStatus } from '../src/client/RemoteSettingsCard.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** English dictionary translate stub with {param} interpolation. */
const t: Parameters<typeof LanBindStatus>[0]['t'] = (key, params) => {
  let text = (en as Record<string, string>)[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

/** The copy the assertions name, kept beside the dictionary they come from. */
const COPY = {
  off: 'Currently localhost-only.',
  urls: 'LAN URLs: http://192.168.1.5:3080',
  untouched: 'The toggle has never been used',
  pendingRestart: 'The bind change takes effect after dsh web restarts.',
  wildcardUnsupported: 'refuses wildcard (0.0.0.0) binds',
  noLanAddress: 'LAN access cannot be pinned',
} as const

/**
 * One status frame as the loopback endpoint serves it.
 * @param overrides - the fields this test pins.
 */
function frame(overrides: Partial<LanBindFrame>): LanBindFrame {
  return {
    profile: 'web',
    setting: true,
    blockHost: '192.168.1.5',
    bindHost: '192.168.1.5',
    port: 3080,
    lanUrls: ['http://192.168.1.5:3080'],
    firewall: { ok: true, managed: true },
    platform: 'win32',
    ...overrides,
  }
}

/**
 * Answer the loopback-only status read with one frame and render the block.
 * @param frameValue - the frame the host reports.
 * @returns the text content of the rendered block, every line in order.
 */
async function renderStatus(frameValue: LanBindFrame): Promise<string> {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(frameValue), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })))
  const view = render(<LanBindStatus t={t} />)
  await waitFor(() => { expect(view.container.textContent).toContain('Bind:') })
  return view.container.textContent ?? ''
}

describe('isLanHost', () => {
  it('operator: an address another device can dial counts as LAN access', () => {
    // Given the literals a managed block may pin: the legacy wildcard (hosts
    // that still accept it) and a concrete interface address of this machine.
    // When the card asks whether each reaches the network.
    // Then both are LAN access.
    expect(isLanHost('0.0.0.0')).toBe(true)
    expect(isLanHost('192.168.1.5')).toBe(true)
  })

  it('operator: a loopback or empty literal is not LAN access', () => {
    // Given the loopback literals and the shapes an unset frame carries.
    // When the card asks whether each reaches the network.
    // Then none of them counts, so the card keeps the localhost-only line.
    expect(isLanHost('::1')).toBe(false)
    expect(isLanHost('localhost')).toBe(false)
    expect(isLanHost('127.0.0.1')).toBe(false)
    expect(isLanHost('')).toBe(false)
    expect(isLanHost(undefined)).toBe(false)
  })
})

describe('LanBindStatus', () => {
  it('operator: a host that still accepts the wildcard keeps the wildcard block', async () => {
    // Given a host whose webserver schema accepts 0.0.0.0 and a block pinning it.
    // When the card renders the live facts.
    // Then the LAN URLs show, the localhost-only line does not, and the card
    // makes no claim that a wildcard is refused.
    const text = await renderStatus(frame({
      blockHost: '0.0.0.0',
      bindHost: '0.0.0.0',
      desiredHost: '0.0.0.0',
      wildcardSupported: true,
      supportedHosts: ['192.168.1.5'],
    }))
    expect(text).toContain(COPY.urls)
    expect(text).not.toContain(COPY.off)
    expect(text).not.toContain(COPY.wildcardUnsupported)
  })

  it('operator: a concrete LAN literal the host accepts reads as LAN access', async () => {
    // Given a host that rejects wildcard binds and a block pinning this
    // machine's LAN address.
    // When the card renders the live facts.
    // Then the LAN URLs show instead of the localhost-only line.
    const text = await renderStatus(frame({ blockHost: '192.168.1.5', bindHost: '192.168.1.5', wildcardSupported: false }))
    expect(text).toContain(COPY.urls)
    expect(text).not.toContain(COPY.off)
  })

  it('operator: a host that refuses the wildcard says so', async () => {
    // Given a host whose webserver schema rejects 0.0.0.0 and a block that
    // therefore pins a concrete address.
    // When the card renders the live facts.
    // Then the card explains why the address is concrete rather than wildcard.
    const text = await renderStatus(frame({ wildcardSupported: false }))
    expect(text).toContain(COPY.wildcardUnsupported)
  })

  it('operator: a blocked toggle explains that nothing could be pinned', async () => {
    // Given the toggle on, the wildcard refused, and a machine whose LAN
    // addresses are all unadvertisable, so no block host exists at all.
    // When the card renders the live facts.
    // Then it reports both the refusal and the blocked state, and keeps the
    // localhost-only line because the live bind really is loopback.
    const text = await renderStatus(frame({
      blockHost: null,
      bindHost: '127.0.0.1',
      lanUrls: [],
      wildcardSupported: false,
      lanBlocked: true,
      desiredHost: null,
      supportedHosts: [],
    }))
    expect(text).toContain(COPY.wildcardUnsupported)
    expect(text).toContain(COPY.noLanAddress)
    expect(text).toContain(COPY.off)
  })

  it('operator: an untouched toggle names the untouched state, not a blocked one', async () => {
    // Given a profile whose toggle was never flipped on a host that refuses
    // wildcard binds, so the host property holds while nothing is pinned yet.
    // When the card renders the live facts.
    // Then the localhost-only line and the untouched hint show, the host's
    // wildcard refusal is reported as the reason a flip will pin a concrete
    // address, and no blocked claim is made.
    const text = await renderStatus(frame({
      setting: null,
      blockHost: null,
      bindHost: '127.0.0.1',
      lanUrls: [],
      wildcardSupported: false,
    }))
    expect(text).toContain(COPY.off)
    expect(text).toContain(COPY.untouched)
    expect(text).toContain(COPY.wildcardUnsupported)
    expect(text).not.toContain(COPY.noLanAddress)
  })

  it('operator: an older host half renders without the fields it never sent', async () => {
    // Given a host half that predates the new status fields, so the frame
    // carries none of them.
    // When the card renders the live facts.
    // Then it falls back to the legacy reading: the wildcard block is LAN
    // access and the card claims nothing about a wildcard refusal.
    const text = await renderStatus(frame({ blockHost: '0.0.0.0', bindHost: '0.0.0.0' }))
    expect(text).toContain(COPY.urls)
    expect(text).not.toContain(COPY.wildcardUnsupported)
    expect(text).not.toContain(COPY.noLanAddress)
    expect(text).not.toContain(COPY.off)
  })

  it('operator: a pinned address still asks for the restart', async () => {
    // Given a block that already pins a concrete LAN address while the running
    // bind has not caught up yet.
    // When the card renders the live facts.
    // Then the URLs are shown together with the pending-restart line.
    const text = await renderStatus(frame({ desiredHost: '192.168.1.5', pendingRestart: true }))
    expect(text).toContain(COPY.urls)
    expect(text).toContain(COPY.pendingRestart)
  })
})
