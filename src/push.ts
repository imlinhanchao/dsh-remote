/**
 * Web Push transport for paired phones: VAPID key ownership, the durable
 * subscription table, and delivery. The pairing service authenticates the
 * device; this module only stores endpoints bound to that device id, so a
 * revoked device's push endpoints can be dropped with it.
 *
 * The VAPID private key never leaves the host: the browser receives only the
 * public key, and every push payload is encrypted by `web-push` for one
 * subscription. Notifications carry no conversation content — the app fetches
 * details after the user opens it.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import webpush from 'web-push'
import { dshHome } from './dsh-home.ts'

/** One browser push subscription, in the shape `PushSubscription.toJSON()` returns. */
export interface PushSubscriptionJson {
  /** Absolute push-service endpoint (https only). */
  endpoint: string
  /** Expiry supplied by the browser, when known. */
  expirationTime?: number | null
  /** Base64url key material for payload encryption. */
  keys: {
    /** P-256 ECDH public key. */
    p256dh: string
    /** Authentication secret. */
    auth: string
  }
}

/** Notification content one push carries. */
export interface PushPayload {
  /** Notification title. */
  title: string
  /** Notification body. */
  body: string
  /** Collapse/replace key; one live notification per tag. */
  tag?: string
  /** Same-origin URL the click opens. */
  url?: string
  /** Notification icon path. */
  icon?: string
  /** Android badge path. */
  badge?: string
  /** Opaque data the service worker forwards to `notificationclick`. */
  data?: Record<string, unknown>
}

/** One stored subscription, bound to the device that registered it. */
interface StoredSubscription extends PushSubscriptionJson {
  /** Paired device session that registered this endpoint. */
  deviceId: string
  /** Sanitized User-Agent captured at subscribe time. */
  ua?: string
  /** First registration time (ms epoch). */
  createdAt: number
  /** Last successful registration or delivery time (ms epoch). */
  lastSeenAt: number
}

/** VAPID identity persisted next to the subscription table. */
interface VapidRecord {
  publicKey: string
  privateKey: string
  subject: string
}

/** On-disk subscription file. */
interface SubscriptionFile {
  version: 1
  subscriptions: StoredSubscription[]
}

/** Hard cap on stored subscriptions across every device. */
const MAX_SUBSCRIPTIONS = 64
/** Per-device cap; a phone re-subscribing repeatedly must not grow forever. */
const MAX_PER_DEVICE = 8
/** VAPID identity file name under DSH_HOME. */
const VAPID_FILE = 'remote-web-ui-push.json'
/** Subscription table file name under DSH_HOME. */
const SUBSCRIPTIONS_FILE = 'remote-web-ui-push-subscriptions.json'
/** VAPID contact; a mailto or https URI is required by the push services. */
const DEFAULT_SUBJECT = 'https://github.com/zhu1090093659/dsh-web'
/** Push-service retention for a missed notification. */
const PUSH_TTL_SECONDS = 300
/** Longest endpoint/key string accepted from a browser. */
const MAX_ENDPOINT_CHARS = 4096
const MAX_KEY_CHARS = 512

/** The subset of `console` this module uses (test seam). */
export interface PushLog {
  warn(message: string): void
  error(message: string): void
}

/** Construction options. */
export interface PushServiceOptions {
  /** DSH home override (tests); defaults to the live `dshHome()`. */
  home?: string
  /** VAPID subject override; defaults to DSH_PUSH_SUBJECT or the placeholder. */
  subject?: string
  /** Logger override (tests). */
  log?: PushLog
}

/**
 * Resolve the VAPID identity, generating and persisting one on first use.
 * A malformed file is replaced: a broken key cannot send anything, and
 * keeping it would turn every notification into a permanent failure.
 * @param file - absolute path of the VAPID record.
 * @param subject - contact URI to persist with the keys.
 * @param log - failure logger.
 * @returns the VAPID identity in use.
 */
function loadOrCreateVapid(file: string, subject: string, log: PushLog): VapidRecord {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<VapidRecord>
    if (isNonEmptyString(parsed.publicKey) && isNonEmptyString(parsed.privateKey)) {
      return { publicKey: parsed.publicKey, privateKey: parsed.privateKey, subject }
    }
  } catch {
    // Missing or malformed: generate a fresh identity below.
  }
  const keys = webpush.generateVAPIDKeys()
  const record: VapidRecord = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject }
  writePrivateJson(file, record, log)
  return record
}

/**
 * Load and validate the subscription table. A malformed file yields an empty
 * table rather than failing plugin startup; the next subscribe rewrites it.
 * @param file - absolute path of the subscription file.
 * @param log - failure logger.
 * @returns the valid stored subscriptions, capped.
 */
function loadSubscriptions(file: string, log: PushLog): StoredSubscription[] {
  let parsed: Partial<SubscriptionFile>
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SubscriptionFile>
  } catch {
    return []
  }
  if (!Array.isArray(parsed.subscriptions)) return []
  const result: StoredSubscription[] = []
  for (const item of parsed.subscriptions) {
    if (result.length >= MAX_SUBSCRIPTIONS) break
    if (isStoredSubscription(item)) result.push(item)
  }
  if (result.length !== parsed.subscriptions.length) {
    log.warn('remote-web-ui: ignored malformed Web Push subscription rows')
  }
  return result
}

/**
 * Write a JSON file with owner-only permissions, creating its directory.
 * A failed write is logged and leaves the previous file untouched.
 * @param file - absolute target path.
 * @param value - JSON-serializable value.
 * @param log - failure logger.
 */
function writePrivateJson(file: string, value: unknown, log: PushLog): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
    renameSync(temp, file)
  } catch (error) {
    log.error(`remote-web-ui: failed to persist Web Push state: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Whether a value is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Validate one browser subscription before it reaches the table. */
function isPushSubscriptionJson(value: unknown): value is PushSubscriptionJson {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const keys = record.keys as Record<string, unknown> | undefined
  if (typeof record.endpoint !== 'string' || !record.endpoint.startsWith('https://')) return false
  if (record.endpoint.length > MAX_ENDPOINT_CHARS) return false
  if (keys === undefined || typeof keys !== 'object' || keys === null) return false
  const p256dh = keys.p256dh
  const auth = keys.auth
  return isNonEmptyString(p256dh) && p256dh.length <= MAX_KEY_CHARS
    && isNonEmptyString(auth) && auth.length <= MAX_KEY_CHARS
}

/** Validate one row read back from disk. */
function isStoredSubscription(value: unknown): value is StoredSubscription {
  if (!isPushSubscriptionJson(value)) return false
  const record = value as unknown as Record<string, unknown>
  return isNonEmptyString(record.deviceId)
    && typeof record.createdAt === 'number'
    && typeof record.lastSeenAt === 'number'
}

/** The public shape of the push service used by routes and event hooks. */
export interface PushNotifier {
  /** VAPID public key the browser subscribes with. */
  readonly publicKey: string
  /**
   * Register or refresh one browser subscription for a device.
   * @returns false when the subscription shape is invalid.
   */
  subscribe(deviceId: string, subscription: PushSubscriptionJson, userAgent?: string): boolean
  /** Remove one endpoint owned by the device. */
  unsubscribe(deviceId: string, endpoint: string): boolean
  /** Number of live endpoints for one device. */
  countFor(deviceId: string): number
  /** Whether any device has a live endpoint. */
  hasSubscriptions(): boolean
  /** Send one payload to every endpoint of one device; returns the success count. */
  sendToDevice(deviceId: string, payload: PushPayload): Promise<number>
  /** Send one payload to every stored endpoint; returns the success count. */
  sendAll(payload: PushPayload): Promise<number>
  /** Send the built-in test notification to one device; returns the success count. */
  test(deviceId: string): Promise<number>
  /** Last delivery failure, for the phone's test action (undefined when the last send worked). */
  lastError?(): string | undefined
  /** Drop every endpoint bound to a revoked device. */
  forgetDevice(deviceId: string): number
  /** Drop every endpoint (the panel's stop action revokes every device). */
  forgetAll(): number
}

/** VAPID-backed subscription table and delivery. */
export class PushService implements PushNotifier {
  readonly file: string
  private readonly vapid: VapidRecord
  private readonly log: PushLog
  private subscriptions: StoredSubscription[]
  private lastFailure: string | undefined

  /**
   * @param options - home/subject/log overrides.
   */
  constructor(options: PushServiceOptions = {}) {
    const home = options.home ?? dshHome()
    this.file = join(home, SUBSCRIPTIONS_FILE)
    this.log = options.log ?? console
    const subject = options.subject ?? process.env.DSH_PUSH_SUBJECT ?? DEFAULT_SUBJECT
    this.vapid = loadOrCreateVapid(join(home, VAPID_FILE), subject, this.log)
    this.subscriptions = loadSubscriptions(this.file, this.log)
  }

  /** VAPID public key exposed to the browser. */
  get publicKey(): string {
    return this.vapid.publicKey
  }

  /** @inheritdoc */
  subscribe(deviceId: string, subscription: PushSubscriptionJson, userAgent?: string): boolean {
    if (!isPushSubscriptionJson(subscription)) return false
    const now = Date.now()
    const existing = this.subscriptions.find(item => item.endpoint === subscription.endpoint)
    if (existing !== undefined) {
      existing.deviceId = deviceId
      existing.lastSeenAt = now
      if (userAgent !== undefined) existing.ua = userAgent.slice(0, 180)
      this.persist()
      return true
    }
    const mine = this.subscriptions.filter(item => item.deviceId === deviceId)
    if (mine.length >= MAX_PER_DEVICE) {
      const oldest = mine.reduce((a, b) => (a.lastSeenAt <= b.lastSeenAt ? a : b))
      this.subscriptions = this.subscriptions.filter(item => item !== oldest)
    }
    while (this.subscriptions.length >= MAX_SUBSCRIPTIONS) {
      const oldest = this.subscriptions.reduce((a, b) => (a.lastSeenAt <= b.lastSeenAt ? a : b))
      this.subscriptions = this.subscriptions.filter(item => item !== oldest)
    }
    this.subscriptions.push({
      ...subscription,
      deviceId,
      ...(userAgent !== undefined ? { ua: userAgent.slice(0, 180) } : {}),
      createdAt: now,
      lastSeenAt: now,
    })
    this.persist()
    return true
  }

  /** @inheritdoc */
  unsubscribe(deviceId: string, endpoint: string): boolean {
    const before = this.subscriptions.length
    this.subscriptions = this.subscriptions.filter(item => !(item.deviceId === deviceId && item.endpoint === endpoint))
    if (this.subscriptions.length === before) return false
    this.persist()
    return true
  }

  /** @inheritdoc */
  countFor(deviceId: string): number {
    return this.subscriptions.filter(item => item.deviceId === deviceId).length
  }

  /** @inheritdoc */
  hasSubscriptions(): boolean {
    return this.subscriptions.length > 0
  }

  /** @inheritdoc */
  async sendToDevice(deviceId: string, payload: PushPayload): Promise<number> {
    return this.deliver(this.subscriptions.filter(item => item.deviceId === deviceId), payload)
  }

  /** @inheritdoc */
  async sendAll(payload: PushPayload): Promise<number> {
    const unique = new Map<string, StoredSubscription>()
    for (const item of this.subscriptions) unique.set(item.endpoint, item)
    return this.deliver([...unique.values()], payload)
  }

  /** @inheritdoc */
  async test(deviceId: string): Promise<number> {
    return this.sendToDevice(deviceId, {
      title: 'DSH Web Push',
      body: '通知已连接。需要你选择、审批或任务完成时会在这里提醒。',
      tag: 'dsh-test',
      url: '/',
      data: { kind: 'test' },
    })
  }

  /** @inheritdoc */
  lastError(): string | undefined {
    return this.lastFailure
  }

  /** @inheritdoc */
  forgetDevice(deviceId: string): number {
    const before = this.subscriptions.length
    this.subscriptions = this.subscriptions.filter(item => item.deviceId !== deviceId)
    const removed = before - this.subscriptions.length
    if (removed > 0) this.persist()
    return removed
  }

  /** @inheritdoc */
  forgetAll(): number {
    const removed = this.subscriptions.length
    if (removed > 0) {
      this.subscriptions = []
      this.persist()
    }
    return removed
  }

  /** Drop one endpoint after the push service reports it gone. */
  private dropEndpoint(endpoint: string): void {
    const before = this.subscriptions.length
    this.subscriptions = this.subscriptions.filter(item => item.endpoint !== endpoint)
    if (this.subscriptions.length !== before) this.persist()
  }

  /** Persist the current table. */
  private persist(): void {
    const value: SubscriptionFile = { version: 1, subscriptions: this.subscriptions }
    writePrivateJson(this.file, value, this.log)
  }

  /**
   * Deliver one payload concurrently and prune endpoints the push service
   * reports as gone. Other failures are logged and keep the endpoint: a
   * transient 5xx or a quota answer must not silently unsubscribe a phone.
   */
  private async deliver(items: readonly StoredSubscription[], payload: PushPayload): Promise<number> {
    if (items.length > 0) this.lastFailure = undefined
    let sent = 0
    await Promise.all(items.map(async (item) => {
      try {
        await webpush.sendNotification(item, JSON.stringify(payload), {
          vapidDetails: this.vapid,
          TTL: PUSH_TTL_SECONDS,
          urgency: 'high',
        })
        sent += 1
      } catch (error) {
        const status = (error as { statusCode?: unknown }).statusCode
        if (status === 404 || status === 410) {
          this.lastFailure = 'subscription gone'
          this.dropEndpoint(item.endpoint)
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        this.lastFailure = `HTTP ${typeof status === 'number' ? String(status) : 'unknown'}: ${message}`
        this.log.warn(`remote-web-ui: Web Push delivery failed (${typeof status === 'number' ? String(status) : 'unknown'})`)
      }
    }))
    return sent
  }
}
