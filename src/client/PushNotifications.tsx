/**
 * Phone-side Web Push control: one capability check, one user-gesture
 * subscribe, and the three actions the paired phone needs (enable, test,
 * disable). It renders inside the remote-access settings card, so the desktop
 * sees an honest "open this on the phone" note instead of a dead button.
 */

import { useEffect, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  PushRequestError,
  currentPushSubscription,
  disablePush,
  enablePush,
  pushCapability,
  readPushStatus,
  sendTestPush,
  type PushCapability,
} from './push-api.ts'

/** The surface states this card can show. */
type PushState = 'loading' | PushCapability | 'denied' | 'off' | 'on' | 'desktop' | 'error'

/** Props: the remote dictionary only. */
export interface PushNotificationsProps {
  /** Remote namespace translate seat. */
  t: TranslateNS<'remote'>
}

/** Whether this page is the desktop loopback shell (no phone pairing). */
function isLoopbackPage(): boolean {
  const host = window.location.hostname
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

/**
 * Render the Web Push section.
 * @param props - locale seat.
 * @returns the section.
 */
export function PushNotifications({ t }: PushNotificationsProps) {
  const [state, setState] = useState<PushState>('loading')
  const [busy, setBusy] = useState<'enable' | 'disable' | 'test' | undefined>(undefined)
  const [message, setMessage] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    const read = async (): Promise<void> => {
      const capability = pushCapability()
      if (capability !== 'supported') {
        if (alive) setState(capability)
        return
      }
      if (isLoopbackPage()) {
        if (alive) setState('desktop')
        return
      }
      if (Notification.permission === 'denied') {
        if (alive) setState('denied')
        return
      }
      try {
        const [subscription, count] = await Promise.all([currentPushSubscription(), readPushStatus()])
        if (!alive) return
        setState(subscription !== undefined || count > 0 ? 'on' : 'off')
      } catch (error) {
        if (!alive) return
        setState(error instanceof PushRequestError && error.status === 401 ? 'desktop' : 'error')
      }
    }
    void read()
    return () => { alive = false }
  }, [])

  const failure = (error: unknown): string => {
    if (error instanceof PushRequestError) {
      if (error.message === 'permission-denied') {
        setState('denied')
        return t('push.denied')
      }
      if (error.message === 'service-worker-missing') return t('push.noWorker')
      if (error.message === 'no-subscription') return t('push.noSubscription')
      if (error.code === 'delivery-failed') return t('push.deliveryFailed', { message: error.detail ?? error.message })
    }
    return t('push.failed', { message: error instanceof Error ? error.message : String(error) })
  }

  const enable = async (): Promise<void> => {
    setBusy('enable')
    setMessage(undefined)
    try {
      await enablePush()
      setState('on')
      setMessage(t('push.enabledDone'))
    } catch (error) {
      setMessage(failure(error))
      if (!(error instanceof PushRequestError) || error.message !== 'permission-denied') setState('error')
    } finally {
      setBusy(undefined)
    }
  }

  const disable = async (): Promise<void> => {
    setBusy('disable')
    setMessage(undefined)
    try {
      await disablePush()
      setState('off')
      setMessage(t('push.disabledDone'))
    } catch (error) {
      setMessage(failure(error))
    } finally {
      setBusy(undefined)
    }
  }

  const test = async (): Promise<void> => {
    setBusy('test')
    setMessage(undefined)
    try {
      const sent = await sendTestPush()
      setMessage(sent > 0 ? t('push.testSent') : t('push.noSubscription'))
    } catch (error) {
      setMessage(failure(error))
    } finally {
      setBusy(undefined)
    }
  }

  const primary = {
    appearance: 'none' as const,
    border: 'none',
    borderRadius: 8,
    padding: '7px 14px',
    fontSize: 13,
    fontWeight: 600,
    cursor: busy === undefined ? 'pointer' : 'default',
    background: 'var(--dsw-alias-button-primary-fill)',
    color: 'var(--dsw-alias-label-primary-foreground)',
    opacity: busy === undefined ? 1 : 0.6,
  }
  const secondary = {
    ...primary,
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l2)',
    fontWeight: 500,
  }

  const browserHint = /EdgA|MicroMessenger|; wv\)/i.test(navigator.userAgent)
  return (
    <div
      data-dsh-part="push-notifications"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        paddingTop: 12,
        marginTop: 4,
        borderTop: '1px solid var(--dsw-alias-border-l2)',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>{t('push.title')}</div>
      <div style={{ fontSize: 12, lineHeight: '18px', opacity: 0.8 }}>{t('push.description')}</div>
      {state === 'loading' && <div style={{ fontSize: 12, opacity: 0.8 }}>{t('push.loading')}</div>}
      {state === 'unsupported' && <div style={{ fontSize: 12, lineHeight: '18px', opacity: 0.8 }}>{t('push.unsupported')}</div>}
      {state === 'insecure' && <div style={{ fontSize: 12, lineHeight: '18px', opacity: 0.8 }}>{t('push.insecure')}</div>}
      {state === 'ios-not-installed' && <div style={{ fontSize: 12, lineHeight: '18px', opacity: 0.8 }}>{t('push.iosInstall')}</div>}
      {state === 'denied' && <div style={{ fontSize: 12, lineHeight: '18px', opacity: 0.8 }}>{t('push.denied')}</div>}
      {state === 'desktop' && <div style={{ fontSize: 12, lineHeight: '18px', opacity: 0.8 }}>{t('push.desktop')}</div>}
      {state === 'error' && <div style={{ fontSize: 12, lineHeight: '18px', opacity: 0.8 }}>{t('push.error')}</div>}
      {browserHint && state !== 'loading' && state !== 'unsupported' && (
        <div style={{ fontSize: 12, lineHeight: '18px', opacity: 0.8 }}>{t('push.browserHint')}</div>
      )}
      {(state === 'off' || state === 'on') && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, opacity: 0.85 }}>
            {state === 'on' ? t('push.enabled') : t('push.disabled')}
          </span>
          {state === 'off' && (
            <button type="button" style={primary} disabled={busy !== undefined} onClick={() => { void enable() }}>
              {busy === 'enable' ? t('push.enabling') : t('push.enable')}
            </button>
          )}
          {state === 'on' && (
            <>
              <button type="button" style={primary} disabled={busy !== undefined} onClick={() => { void test() }}>
                {busy === 'test' ? t('push.testing') : t('push.test')}
              </button>
              <button type="button" style={secondary} disabled={busy !== undefined} onClick={() => { void disable() }}>
                {busy === 'disable' ? t('push.disabling') : t('push.disable')}
              </button>
            </>
          )}
        </div>
      )}
      {message !== undefined && (
        <div role="status" style={{ fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' }}>
          {message}
        </div>
      )}
    </div>
  )
}
