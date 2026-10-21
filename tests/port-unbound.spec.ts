/**
 * The 0.2.1-rc.2 webServer type leaves `ctx.webServer.port` undefined until
 * the listener binds (a recompose pass can run this apply ahead of the bind).
 * The host half must degrade honestly in that window: the loopback proxies
 * refuse with 503 (remote-api.spec.ts / remote-upgrade.spec.ts), the posture
 * probe skips the round, and the quick tunnel defers to a re-plan instead of
 * minting an http://127.0.0.1:undefined target (tunnel-plan.spec.ts). This
 * file pins those guards inside applyImpl, the same source-body idiom as
 * lan-bind-hmr-nesting.spec.ts.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')

/**
 * The body of one top-level const declaration inside applyImpl, found by brace
 * balance from its opening brace.
 * @param name - the local const's name.
 * @returns the function body source, without the closing brace.
 */
function bodyOf(name: string): string {
  const head = new RegExp('const ' + name + ' = \\([^)]*\\): void => \\{')
  const match = head.exec(source)
  if (match === null) throw new Error('no ' + name + ' declaration in src/index.ts')
  const start = match.index + match[0].length - 1
  let depth = 0
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start + 1, i)
    }
  }
  throw new Error('unbalanced braces after ' + name)
}

describe('webServer port unsettled (0.2.1-rc.2)', () => {
  it('operator skips the posture round while the port is unbound', () => {
    // Given the posture probe, whose LAN targets and requests need the bound port
    // When the port has not settled yet
    // Then the round is skipped before any target or probe is built — the
    // previous snapshot stays and the next trigger retries
    const probe = bodyOf('runPostureProbe')
    const guard = probe.indexOf('if (port === undefined) return')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(probe.indexOf('postureTargets('))
    expect(guard).toBeLessThan(probe.indexOf('probePosture({'))
  })

  it('operator defers the quick tunnel instead of planning an undefined target', () => {
    // Given the settings sync that applies the tunnel plan
    // When autoTunnel is on while the port is unbound
    // Then the plan branch is deferred behind the port-settle guard (with a
    // retry timer), so sync never plans against an unsettled port
    const syncBody = bodyOf('sync')
    expect(syncBody).toContain('livePort === undefined && value.autoTunnel === true')
    expect(syncBody).toContain('PORT_SETTLE_RETRY_MS')
    expect(syncBody).not.toContain('tunnelPlanOf(')
    // The planner only runs inside the apply helper, behind the guard.
    const apply = bodyOf('applyTunnelPlan')
    expect(apply).toContain('tunnelPlanOf(value, port)')
  })

  it('operator clears the port-settle retry with the tunnel lifecycle', () => {
    // Given the deferral retry timer
    // When the plugin disposes
    // Then the pending timer goes with the tunnel teardown
    const clearAt = source.indexOf('clearTimeout(portSettleTimer)')
    expect(clearAt).toBeGreaterThan(-1)
    // The clear sits inside the auto-tunnel dispose effect, ahead of its label.
    expect(clearAt).toBeLessThan(source.indexOf("'remote-web-ui: auto tunnel'"))
  })
})

/**
 * Issue #1893: the managed block pinned host 0.0.0.0, which the webserver
 * schema rejects since 0.2.1-rc.2, so every later start failed at config
 * validation. The block can only be written from this one worker, and only
 * with a literal the capability approved.
 */
describe('the lan-bind write path versus the bind capability (issue #1893)', () => {
  it('operator loses no write when nothing bindable could be planned', () => {
    // Given the boot re-assert, which owns the only call that writes the block
    // When the plan comes back undefined (a host that rejects the wildcard and
    // a machine with no advertisable LAN address)
    // Then the write sits in the else branch of that guard, so an unplanned
    // literal can never reach the patch file
    const work = bodyOf('applyLanBindWork')
    const guard = work.indexOf('desiredPort === undefined')
    const blocked = work.indexOf('desiredHost === undefined')
    const write = work.indexOf('writeLanBind(')
    expect(guard).toBeGreaterThan(-1)
    expect(blocked).toBeGreaterThan(guard)
    expect(write).toBeGreaterThan(blocked)
  })

  it('operator gets the block planned against what the host accepts', () => {
    // Given the boot re-assert on a host that may refuse the wildcard
    // When it plans the bind host
    // Then the capability sampled once per boot is passed in, so the planner
    // can pin a concrete address instead of echoing the refused literal
    const work = bodyOf('applyLanBindWork')
    const plan = work.indexOf('desiredBindHost(')
    expect(plan).toBeGreaterThan(-1)
    expect(work.slice(plan, plan + 160)).toContain(', capability)')
    // One sample per boot drives the block and the status frame alike, so the
    // card never explains a literal the write path would not have chosen.
    expect(source).toContain('const capability = lanBindCapabilityOf()')
  })

  it('operator is told when the CLI --host is refused and what was pinned instead', () => {
    // Given a --host the installed schema will not bind (a wildcard, or any
    // value that is not a concrete literal) while the block replaces the row's
    // config wholesale, so nothing else validates that flag
    // When the boot re-assert plans the block
    // Then the planner drops the flag and one warning names the refused value
    // and the literal pinned instead - the operator is never left guessing
    // why their flag had no effect (issue #1893)
    const work = bodyOf('applyLanBindWork')
    expect(work).toContain('refusedStartupHost(startup?.host, capability)')
    const warnAt = work.indexOf('console.warn(')
    expect(warnAt).toBeGreaterThan(-1)
    expect(work.slice(warnAt, warnAt + 240)).toContain('ignoring --host')
    // The warning sits in the branch that does write, after the plan settled,
    // so it can name the literal that was pinned instead.
    expect(warnAt).toBeGreaterThan(work.indexOf('desiredBindHost('))
    expect(warnAt).toBeGreaterThan(work.indexOf('desiredHost === undefined'))
    expect(warnAt).toBeLessThan(work.indexOf('writeLanBind('))
  })

  it('operator sees the blocked state explained instead of a silent skip', () => {
    // Given the same guard
    // When nothing could be pinned
    // Then one error line names the situation and points at the tunnel
    const work = bodyOf('applyLanBindWork')
    expect(work).toContain('the host rejects wildcard binds and no LAN IPv4 address is available')
    expect(work).toContain('use a tunnel instead')
  })
})
