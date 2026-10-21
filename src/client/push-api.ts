/**
 * Browser-side Web Push plumbing: capability checks, VAPID subscription, and
 * the small authenticated route family the phone calls. It never stores a
 * secret; the device cookie is the credential, and the VAPID public key is
 * public by design.
 */

/** Route family served by the host push routes. */
const PUSH_KEY = '/api/pair/push/key'
const PUSH_SUBSCRIBE = '/api/pair/push/subscribe'
const PUSH_UNSUBSCRIBE = '/api/pair/push/unsubscribe'
const PUSH_TEST = '/api/pair/push/test'
const PUSH_STATUS = '/api/pair/push/status'

/** Why the surface cannot subscribe, when it cannot. */
export type PushCapability = 'supported' | 'unsupported' | 'insecure' | 'ios-not-installed'

/** One JSON response from the push route family. */
interface PushResponse {
  ok?: boolean
  key?: string
  count?: number
  sent?: number
  removed?: boolean
  code?: string
  error?: string
}

/** A route failure with its HTTP status and business code. */
export class PushRequestError extends Error {
  /**
   * @param message - readable failure.
   * @param status - HTTP status, when the server answered.
   * @param code - business code (`unpaired`, `bad-subscription`, ...).
   */
  constructor(message: string, readonly status?: number, readonly code?: string, readonly detail?: string) {
    super(message)
    this.name = 'PushRequestError'
  }
}

/** Whether this page can use Web Push at all. */
export function pushCapability(): PushCapability {
  if (!window.isSecureContext) return 'insecure'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported'
  if (isIos() && !isStandalone()) return 'ios-not-installed'
  return 'supported'
}

/** Whether this is a phone/tablet browser, the only surface the push prompt targets. */
export function isMobileBrowser(): boolean {
  if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

/** Whether the page is the installed home-screen web app on iOS. */
export function isStandalone(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
    || window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: fullscreen)').matches
}

/** Whether the current browser is an iOS/iPadOS WebKit browser. */
export function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

/**
 * The cookieless device credential: the boot patch stores it in
 * sessionStorage and the `/remote` channel carries it in a header. The push
 * routes accept the same header, so a phone whose browser blocks cookies can
 * still subscribe.
 */
function deviceHeaders(): Record<string, string> {
  try {
    const id = sessionStorage.getItem('dsh-remote-device')
    return id === null || id === '' ? {} : { 'x-dsh-remote-device': id }
  } catch {
    return {}
  }
}

/** Read one JSON response and normalize the failure shape. */
async function readResponse(response: Response): Promise<PushResponse> {
  let body: PushResponse = {}
  try {
    body = await response.json() as PushResponse
  } catch {
    body = {}
  }
  if (!response.ok) {
    throw new PushRequestError(
      typeof body.code === 'string' ? body.code : `HTTP ${String(response.status)}`,
      response.status,
      typeof body.code === 'string' ? body.code : undefined,
      typeof body.error === 'string' ? body.error : undefined,
    )
  }
  return body
}

/** Read the VAPID public key for this paired device. */
export async function readPushKey(): Promise<string> {
  const body = await readResponse(await fetch(PUSH_KEY, { credentials: 'same-origin', cache: 'no-store', headers: deviceHeaders() }))
  if (typeof body.key !== 'string' || body.key === '') throw new PushRequestError('missing VAPID key', 200)
  return body.key
}

/** Read the device's live subscription count. */
export async function readPushStatus(): Promise<number> {
  const body = await readResponse(await fetch(PUSH_STATUS, { credentials: 'same-origin', cache: 'no-store', headers: deviceHeaders() }))
  return typeof body.count === 'number' ? body.count : 0
}

/** Convert a base64url VAPID key into the bytes `PushManager.subscribe` wants. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const output = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index)
  return output
}

/** Resolve the service worker registration the shell installed, if any. */
async function pushRegistration(wait = false): Promise<ServiceWorkerRegistration | undefined> {
  if (!wait) return navigator.serviceWorker.getRegistration()
  // The capture script registers the worker asynchronously on the first
  // landing; a settings tap can arrive before activation. Wait for `ready`
  // with a bounded race so a browser that never activates still fails with
  // a readable error instead of hanging the button.
  const timeout = new Promise<undefined>(resolve => {
    window.setTimeout(() => { resolve(undefined) }, 5_000)
  })
  return Promise.race([navigator.serviceWorker.ready, timeout])
}

/** The current browser subscription, when one exists. */
export async function currentPushSubscription(): Promise<PushSubscription | undefined> {
  const registration = await pushRegistration()
  if (registration === undefined) return undefined
  return (await registration.pushManager.getSubscription()) ?? undefined
}

/**
 * Ask for notification permission, subscribe, and register the endpoint with
 * the host. Must be called from a user gesture: iOS rejects a programmatic
 * permission request.
 * @returns the browser subscription now registered with the host.
 */
export async function enablePush(): Promise<PushSubscription> {
  const capability = pushCapability()
  if (capability !== 'supported') throw new PushRequestError(capability)
  const permission = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission()
  if (permission !== 'granted') throw new PushRequestError('permission-denied')
  const registration = await pushRegistration(true)
  if (registration === undefined) throw new PushRequestError('service-worker-missing')
  const key = await readPushKey()
  let subscription = await registration.pushManager.getSubscription()
  if (subscription === null) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key).buffer as ArrayBuffer,
    })
  }
  if (subscription === null) throw new PushRequestError('subscribe-failed')
  await readResponse(await fetch(PUSH_SUBSCRIBE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...deviceHeaders() },
    body: JSON.stringify(subscription.toJSON()),
  }))
  window.dispatchEvent(new Event('dsh-push-enabled'))
  return subscription
}

/** Remove this browser's subscription locally and on the host. */
export async function disablePush(): Promise<void> {
  const subscription = await currentPushSubscription()
  if (subscription === undefined) return
  await readResponse(await fetch(PUSH_UNSUBSCRIBE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...deviceHeaders() },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }))
  await subscription.unsubscribe()
  window.dispatchEvent(new Event('dsh-push-disabled'))
}

/** Send one test notification to this device's endpoints. */
export async function sendTestPush(): Promise<number> {
  const body = await readResponse(await fetch(PUSH_TEST, { method: 'POST', credentials: 'same-origin', headers: deviceHeaders() }))
  return typeof body.sent === 'number' ? body.sent : 0
}
