/** The device-capture script the app landing injects: which reopen path each origin keeps. */
import { describe, expect, it } from 'vitest'
import { APP_DEVICE_STORAGE_KEY, appShellCaptureScript, PAIR_PATHS } from '../src/routes.ts'
import { REMOTE_HOST_GRANT_GLOBAL } from '../src/remote-channel-rules.ts'

const DEVICE_ID = 'dev-1867'

interface CaptureRun {
  /** Every path history.replaceState was handed, in order. */
  replaced: string[]
  /** What the script wrote into sessionStorage, by key. */
  stored: Record<string, string>
  /** Every service-worker registration the script asked the browser for. */
  registrations: { url: string; scope: string | undefined }[]
  /** The server-granted host-mode marker the shell boot patch reads. */
  hostGrant: unknown
}

/** The script body without its `<script>` wrapper. */
function scriptBody(deviceId: string): string {
  const wrapped = appShellCaptureScript(deviceId)
  const body = /^<script>([\s\S]*)<\/script>$/.exec(wrapped)
  if (body === null) throw new Error('capture script is not one bare script element')
  return body[1] as string
}

/**
 * Run the injected script against fakes for the four browser globals it
 * touches. `serviceWorker` exists only where a secure context exposes it,
 * which is exactly why the reopen path is origin-dependent.
 */
function runCapture(opts: { secureContext?: boolean; exposeServiceWorker?: boolean }): CaptureRun {
  const replaced: string[] = []
  const stored: Record<string, string> = {}
  const registrations: { url: string; scope: string | undefined }[] = []
  const win: Record<string, unknown> = {}
  if (opts.secureContext !== undefined) win.isSecureContext = opts.secureContext
  const browserNavigator: Record<string, unknown> = {}
  if (opts.exposeServiceWorker === true) {
    browserNavigator.serviceWorker = {
      register: (url: string, init?: { scope?: string }): Promise<unknown> => {
        registrations.push({ url, scope: init?.scope })
        return Promise.resolve({})
      },
    }
  }
  // The script reads these four globals by name; passing them as parameters
  // keeps the run in one function scope with no page environment needed.
  new Function('window', 'sessionStorage', 'navigator', 'history', scriptBody(DEVICE_ID))(
    win,
    { setItem: (key: string, value: string): void => { stored[key] = value } },
    browserNavigator,
    { replaceState: (_state: unknown, _title: string, url: string): void => { replaced.push(url) } },
  )
  return { replaced, stored, registrations, hostGrant: win[REMOTE_HOST_GRANT_GLOBAL] }
}

describe('the device-capture script', () => {
  it('operator: a plain-HTTP LAN phone reopens through the device landing, not the harness root', () => {
    // Given a paired phone on an origin the browser does not call a secure
    // context, so no reopen service worker can ever register there.
    // When the device-gated landing's capture script runs on the shell.
    // Then the address bar keeps the plugin-owned landing, which re-checks
    // the device cookie on every reload instead of the harness index gate.
    const run = runCapture({ secureContext: false })
    expect(run.replaced).toEqual([PAIR_PATHS.appPage])
    // The device credential and the server-granted host-mode marker still
    // land before any app script reads them.
    expect(run.stored).toEqual({ [APP_DEVICE_STORAGE_KEY]: DEVICE_ID })
    expect(run.hostGrant).toBe(true)
    expect(run.registrations).toEqual([])
    // The rewrite leaves a bare path: neither the spent one-time grant nor
    // the device credential survives into history or a shared URL.
    for (const url of run.replaced) {
      expect(url).toBe(PAIR_PATHS.appPage)
      expect(url).not.toContain('?')
      expect(url).not.toContain(DEVICE_ID)
      expect(url).not.toContain('grant')
    }
  })

  it('operator: an https phone keeps the canonical root and installs the reopen worker', () => {
    // Given a secure context, where the reopen worker can register and own
    // navigations to the root.
    // When the capture script runs.
    // Then the address bar returns to the canonical root the worker serves,
    // with the worker registered at its root-scoped script path.
    const run = runCapture({ secureContext: true, exposeServiceWorker: true })
    expect(run.replaced).toEqual(['/'])
    expect(run.registrations).toEqual([{ url: PAIR_PATHS.appServiceWorker, scope: '/' }])
    expect(run.stored).toEqual({ [APP_DEVICE_STORAGE_KEY]: DEVICE_ID })
    expect(run.hostGrant).toBe(true)
  })

  it('operator: an engine that reports no secure-context flag still reopens through the landing', () => {
    // Given an engine that never exposed window.isSecureContext (undefined),
    // so the branch cannot be evaluated from the origin.
    // When the capture script runs.
    // Then the unreadable flag resolves to the landing rather than to the
    // root, whose 401 no device credential can ever satisfy.
    const run = runCapture({})
    expect(run.replaced).toEqual([PAIR_PATHS.appPage])
    expect(run.stored).toEqual({ [APP_DEVICE_STORAGE_KEY]: DEVICE_ID })
  })
})
