/** Web Push store and delivery semantics: validation, caps, persistence, pruning. */
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const { sendNotification } = vi.hoisted(() => ({ sendNotification: vi.fn() }))

vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: 'test-public-key', privateKey: 'test-private-key' }),
    sendNotification,
  },
}))

import { PushService, type PushSubscriptionJson } from '../src/push.ts'

/** One valid browser subscription. */
function subscription(index: number): PushSubscriptionJson {
  return {
    endpoint: `https://push.example.com/${String(index)}`,
    keys: { p256dh: `p256dh-${String(index)}`, auth: `auth-${String(index)}` },
  }
}

/** A quiet logger for tests. */
function log(): { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), error: vi.fn() }
}

/** A fresh service rooted in a temporary DSH home. */
function service(home = mkdtempSync(join(tmpdir(), 'dsh-push-'))): PushService {
  return new PushService({ home, log: log(), subject: 'mailto:test@example.com' })
}

describe('PushService', () => {
  it('persists one VAPID identity with owner-only permissions', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-push-'))
    const first = service(home)
    const second = service(home)
    expect(first.publicKey).toBe('test-public-key')
    expect(second.publicKey).toBe(first.publicKey)
    const mode = statSync(join(home, 'remote-web-ui-push.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('registers, counts, and removes one device subscription', () => {
    const instance = service()
    expect(instance.subscribe('device-a', subscription(1), 'Android')).toBe(true)
    expect(instance.countFor('device-a')).toBe(1)
    expect(instance.hasSubscriptions()).toBe(true)
    expect(instance.unsubscribe('device-a', subscription(1).endpoint)).toBe(true)
    expect(instance.countFor('device-a')).toBe(0)
    expect(instance.hasSubscriptions()).toBe(false)
  })

  it('refuses a non-https or keyless subscription', () => {
    const instance = service()
    expect(instance.subscribe('device-a', { endpoint: 'http://push.example.com/1', keys: { p256dh: 'p', auth: 'a' } })).toBe(false)
    expect(instance.subscribe('device-a', { endpoint: 'https://push.example.com/1', keys: { p256dh: '', auth: 'a' } })).toBe(false)
    expect(instance.countFor('device-a')).toBe(0)
  })

  it('caps one device at eight endpoints and evicts the oldest', () => {
    const instance = service()
    for (let index = 0; index < 10; index += 1) instance.subscribe('device-a', subscription(index))
    expect(instance.countFor('device-a')).toBe(8)
    expect(instance.countFor('device-a')).toBeLessThanOrEqual(8)
  })

  it('restores subscriptions from disk', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-push-'))
    const first = service(home)
    first.subscribe('device-a', subscription(1))
    const second = service(home)
    expect(second.countFor('device-a')).toBe(1)
  })

  it('sends one payload to every endpoint of a device', async () => {
    sendNotification.mockReset()
    sendNotification.mockResolvedValue({ statusCode: 201 })
    const instance = service()
    instance.subscribe('device-a', subscription(1))
    instance.subscribe('device-a', subscription(2))
    const sent = await instance.sendToDevice('device-a', { title: 'DSH', body: 'test', tag: 't' })
    expect(sent).toBe(2)
    expect(sendNotification).toHaveBeenCalledTimes(2)
    expect(sendNotification.mock.calls[0]?.[0]).toMatchObject({ endpoint: subscription(1).endpoint })
    expect(sendNotification.mock.calls[0]?.[1]).toContain('"title":"DSH"')
  })

  it('prunes an endpoint the push service reports as gone', async () => {
    sendNotification.mockReset()
    sendNotification.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }))
    const instance = service()
    instance.subscribe('device-a', subscription(1))
    const sent = await instance.sendToDevice('device-a', { title: 'DSH', body: 'test' })
    expect(sent).toBe(0)
    expect(instance.countFor('device-a')).toBe(0)
    expect(instance.lastError()).toBe('subscription gone')
  })

  it('forgets one device and every device on revoke/stop', () => {
    const instance = service()
    instance.subscribe('device-a', subscription(1))
    instance.subscribe('device-b', subscription(2))
    expect(instance.forgetDevice('device-a')).toBe(1)
    expect(instance.countFor('device-a')).toBe(0)
    expect(instance.countFor('device-b')).toBe(1)
    expect(instance.forgetAll()).toBe(1)
    expect(instance.hasSubscriptions()).toBe(false)
  })
})
