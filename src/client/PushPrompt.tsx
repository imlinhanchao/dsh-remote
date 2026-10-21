/**
 * One-time phone prompt for Web Push. The settings card is several taps deep;
 * a paired phone that has never enabled notifications gets a small banner with
 * the one action that matters, plus an honest note when the current browser
 * cannot do Web Push at all.
 */

import { useEffect, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  PushRequestError,
  currentPushSubscription,
  enablePush,
  isMobileBrowser,
  pushCapability,
  sendTestPush,
} from './push-api.ts'

/** Local dismissal marker; one prompt per week. */
const DISMISS_KEY = 'dsh-push-prompt-dismissed'
/** Prompt again after this long. */
const DISMISS_MS = 7 * 24 * 60 * 60 * 1000

/** Props: the remote dictionary only. */
export interface PushPromptProps {
  /** Remote namespace translate seat. */
  t: TranslateNS<'remote'>
}

/**
 * Render the prompt when the page can subscribe but has not, or when the
 * browser cannot subscribe at all.
 * @param props - locale seat.
 * @returns the banner, or null.
 */
export function PushPrompt({ t }: PushPromptProps) {
  const [visible, setVisible] = useState(false)
  const [mode, setMode] = useState<'offer' | 'unsupported'>('offer')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    const check = async (): Promise<void> => {
      // The prompt is a phone affordance: a paired desktop already renders the
      // official question cards and must not be nagged about phone push.
      if (!isMobileBrowser()) {
        if (alive) setVisible(false)
        return
      }
      try {
        const dismissed = Number(localStorage.getItem(DISMISS_KEY) ?? '0')
        if (Number.isFinite(dismissed) && Date.now() - dismissed < DISMISS_MS) return
      } catch {
        // Storage unavailable: still offer the prompt.
      }
      const capability = pushCapability()
      if (capability === 'insecure') return
      if (capability !== 'supported') {
        if (alive) {
          setMode('unsupported')
          setVisible(true)
        }
        return
      }
      try {
        const subscription = await currentPushSubscription()
        if (!alive) return
        if (subscription === undefined) {
          setMode('offer')
          setVisible(true)
        } else {
          // Enabled from the settings card or another surface: retract the
          // already-open prompt instead of leaving a stale offer on screen.
          setVisible(false)
          setMessage(undefined)
        }
      } catch {
        // A boot-time service-worker race is retried by the settings card.
      }
    }
    const timer = window.setTimeout(() => { void check() }, 1_500)
    const recheck = (): void => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', recheck)
    window.addEventListener('focus', recheck)
    window.addEventListener('dsh-push-enabled', recheck)
    window.addEventListener('dsh-push-disabled', recheck)
    return () => {
      alive = false
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', recheck)
      window.removeEventListener('focus', recheck)
      window.removeEventListener('dsh-push-enabled', recheck)
      window.removeEventListener('dsh-push-disabled', recheck)
    }
  }, [])

  const dismiss = (): void => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()))
    } catch {
      // Ignore.
    }
    setVisible(false)
  }

  const enable = async (): Promise<void> => {
    setBusy(true)
    setMessage(undefined)
    try {
      await enablePush()
      await sendTestPush()
      setMessage(t('pushPrompt.enabled'))
      window.setTimeout(dismiss, 1_200)
    } catch (error) {
      setMessage(error instanceof PushRequestError
        ? t('pushPrompt.failed', { message: error.detail ?? error.code ?? error.message })
        : t('pushPrompt.failed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(false)
    }
  }

  if (!visible) return null

  const primary = {
    appearance: 'none' as const,
    border: 'none',
    borderRadius: 8,
    padding: '7px 14px',
    fontSize: 13,
    fontWeight: 600,
    cursor: busy ? 'default' : 'pointer',
    background: 'var(--dsw-alias-button-primary-fill)',
    color: 'var(--dsw-alias-label-primary-foreground)',
    opacity: busy ? 0.6 : 1,
  }
  const secondary = {
    ...primary,
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l2)',
    fontWeight: 500,
  }

  return (
    <div
      data-dsh-part="push-prompt"
      style={{
        position: 'fixed',
        top: 'calc(8px + env(safe-area-inset-top))',
        left: 12,
        right: 12,
        zIndex: 2147482900,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-module-platform)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{t('pushPrompt.title')}</div>
        <div style={{ fontSize: 12, lineHeight: '18px', opacity: 0.8 }}>
          {mode === 'unsupported' ? t('pushPrompt.unsupported') : (message ?? t('pushPrompt.body'))}
        </div>
      </div>
      {mode === 'offer' && (
        <button type="button" style={primary} disabled={busy} onClick={() => { void enable() }}>
          {busy ? t('pushPrompt.enabling') : t('pushPrompt.enable')}
        </button>
      )}
      <button type="button" style={secondary} onClick={dismiss}>{t('pushPrompt.later')}</button>
    </div>
  )
}
