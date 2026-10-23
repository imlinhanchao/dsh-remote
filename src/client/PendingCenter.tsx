/**
 * Persistent phone-side pending surface. It polls the host broker rather than
 * the live WebSocket, so a question that the official card dropped — because
 * the page reloaded, iOS backgrounded it, or the transport reconnected — is
 * still here with its options and can still be answered.
 */

import { useCallback, useEffect, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  PendingRequestError,
  answerPending,
  decidePending,
  listPending,
  type PendingAnswer,
  type PendingItem,
  type PendingQuestion,
} from './pending-api.ts'

/** Poll cadence while the page is visible. */
const POLL_MS = 4_000

/** Props: the remote dictionary only. */
export interface PendingCenterProps {
  /** Remote namespace translate seat. */
  t: TranslateNS<'remote'>
}

/** Selected labels, keyed item -> question -> labels. */
type SelectionState = Record<string, Record<string, string[]>>

/** Custom text, keyed item -> question. */
type CustomState = Record<string, Record<string, string>>

/**
 * Render the persistent pending banner and modal.
 * @param props - locale seat.
 * @returns the banner/modal, or null while nothing is open.
 */
export function PendingCenter({ t }: PendingCenterProps) {
  const [items, setItems] = useState<PendingItem[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [selection, setSelection] = useState<SelectionState>({})
  const [customs, setCustoms] = useState<CustomState>({})

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await listPending()
      setItems(previous => sameItems(previous, next) ? previous : next)
      // Do not auto-close an explicitly opened sheet: a notification click
      // for an item that expired should still explain why it is empty.
    } catch {
      // A transient transport failure is not actionable here; the next poll
      // retries. A 401 means the page is no longer paired and the official
      // fence notice owns the explanation.
    }
  }, [])

  // Opening the app means the user is looking at the list; stale system
  // notifications for already-answered or expired items must not linger and
  // send them into an empty sheet later.
  useEffect(() => {
    const clear = (): void => {
      void navigator.serviceWorker.getRegistration()
        .then(registration => registration?.getNotifications())
        .then(list => { for (const notification of list ?? []) notification.close() })
        .catch(() => undefined)
    }
    clear()
    const onVisible = (): void => { if (document.visibilityState === 'visible') clear() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { document.removeEventListener('visibilitychange', onVisible) }
  }, [])

  // Home-screen badge where the browser supports the Badging API.
  useEffect(() => {
    const nav = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>
      clearAppBadge?: () => Promise<void>
    }
    if (items.length > 0) void nav.setAppBadge?.(items.length)
    else void nav.clearAppBadge?.()
  }, [items.length])

  useEffect(() => {
    const tick = (): void => {
      if (document.visibilityState === 'visible') void load()
    }
    tick()
    const timer = window.setInterval(tick, POLL_MS)
    const onVisible = (): void => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onVisible)
    }
  }, [load])

  // A notification click lands on `/?pending=1`: open the modal once, then
  // drop the marker so a later reload does not reopen a dismissed sheet.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('pending')) return
    url.searchParams.delete('pending')
    try { window.history.replaceState(null, '', url.pathname + url.search + url.hash) } catch { /* ignore */ }
    setOpen(true)
  }, [])

  const toggle = (itemId: string, question: PendingQuestion, label: string): void => {
    setSelection((previous) => {
      const forItem = previous[itemId] ?? {}
      const current = forItem[question.id] ?? []
      const next = question.multiSelect === true
        ? (current.includes(label) ? current.filter(entry => entry !== label) : [...current, label])
        : [label]
      return { ...previous, [itemId]: { ...forItem, [question.id]: next } }
    })
  }

  const setCustom = (itemId: string, questionId: string, value: string): void => {
    setCustoms((previous) => ({
      ...previous,
      [itemId]: { ...(previous[itemId] ?? {}), [questionId]: value },
    }))
  }

  const failure = (cause: unknown): string => {
    if (cause instanceof PendingRequestError) {
      if (cause.status === 404 || cause.code === 'not-found') return t('pending.stale')
      return t('pending.failed', { message: cause.code ?? cause.message })
    }
    return t('pending.failed', { message: cause instanceof Error ? cause.message : String(cause) })
  }

  const submit = async (item: PendingItem): Promise<void> => {
    const incomplete = (item.questions ?? []).some((question) => {
      const selected = selection[item.id]?.[question.id] ?? []
      const custom = customs[item.id]?.[question.id]?.trim() ?? ''
      return selected.length === 0 && custom === ''
    })
    if (incomplete) {
      setError(t('pending.incomplete'))
      return
    }
    setBusy(`${item.id}:answer`)
    setError(undefined)
    try {
      const answers: PendingAnswer[] = (item.questions ?? []).map((question) => {
        const selected = selection[item.id]?.[question.id] ?? []
        const custom = customs[item.id]?.[question.id]?.trim()
        return { id: question.id, selected, ...(custom !== undefined && custom !== '' ? { custom } : {}) }
      })
      await answerPending(item.id, answers)
      window.setTimeout(() => { dismissOfficialQuestionCards(item.questions ?? []) }, 60)
      setItems(previous => previous.filter(entry => entry.id !== item.id))
      if (items.length <= 1) setOpen(false)
      setSelection(previous => { const next = { ...previous }; delete next[item.id]; return next })
      setCustoms(previous => { const next = { ...previous }; delete next[item.id]; return next })
      await load()
    } catch (cause) {
      setError(failure(cause))
      await load()
    } finally {
      setBusy(undefined)
    }
  }

  const decide = async (item: PendingItem, decision: 'allow' | 'deny'): Promise<void> => {
    setBusy(`${item.id}:${decision}`)
    setError(undefined)
    try {
      await decidePending(item.id, decision)
      setItems(previous => previous.filter(entry => entry.id !== item.id))
      if (items.length <= 1) setOpen(false)
      await load()
    } catch (cause) {
      setError(failure(cause))
      await load()
    } finally {
      setBusy(undefined)
    }
  }

  if (items.length === 0 && !open) return null

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
  }
  const secondary = {
    ...primary,
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l2)',
    fontWeight: 500,
  }

  return (
    <>
      {!open && (
        <div
          data-dsh-part="pending-banner"
          style={{
            position: 'fixed',
            left: 12,
            right: 12,
            bottom: 'calc(12px + env(safe-area-inset-bottom))',
            zIndex: 2147483000,
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
            <div style={{ fontSize: 13, fontWeight: 600 }}>{t('pending.banner', { n: String(items.length) })}</div>
            <div style={{ fontSize: 12, opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {items[0]?.summary}
            </div>
          </div>
          <button type="button" style={primary} onClick={() => { setOpen(true) }}>{t('pending.open')}</button>
        </div>
      )}
      {open && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 2147483100,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            padding: 12,
            background: 'rgba(0,0,0,0.45)',
          }}
          onClick={(event) => { if (event.target === event.currentTarget) setOpen(false) }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('pending.title')}
            style={{
              width: '100%',
              maxWidth: 560,
              maxHeight: '85vh',
              overflowY: 'auto',
              borderRadius: 16,
              padding: 16,
              background: 'var(--dsw-alias-bg-module-platform)',
              boxShadow: '0 12px 40px rgba(0,0,0,0.3)',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>{t('pending.title')}</span>
              <button type="button" style={secondary} aria-label={t('pending.close')} onClick={() => { setOpen(false) }}>
                {t('pending.close')}
              </button>
            </div>
            {error !== undefined && (
              <div role="alert" style={{ fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' }}>{error}</div>
            )}
            {items.length === 0 && (
              <div style={{ fontSize: 13, lineHeight: '20px', opacity: 0.8 }}>{t('pending.stale')}</div>
            )}
            {items.map(item => (
              <div
                key={item.id}
                data-dsh-part="pending-item"
                style={{
                  border: '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: 12,
                  padding: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  {item.kind === 'question' ? t('pending.question') : t('pending.approval')}
                  {item.title !== undefined ? ` · ${item.title}` : ''}
                </div>
                {item.kind === 'approval' && (
                  <>
                    <div style={{ fontSize: 13, lineHeight: '20px' }}>{item.summary}</div>
                    <div style={{ fontSize: 12, opacity: 0.75 }}>{t('pending.approvalHint')}</div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        style={primary}
                        disabled={busy !== undefined}
                        onClick={() => { void decide(item, 'allow') }}
                      >
                        {busy === `${item.id}:allow` ? t('pending.submitting') : t('pending.allow')}
                      </button>
                      <button
                        type="button"
                        style={secondary}
                        disabled={busy !== undefined}
                        onClick={() => { void decide(item, 'deny') }}
                      >
                        {busy === `${item.id}:deny` ? t('pending.submitting') : t('pending.deny')}
                      </button>
                    </div>
                  </>
                )}
                {item.kind === 'question' && (item.questions ?? []).map(question => {
                  const chosen = selection[item.id]?.[question.id] ?? []
                  return (
                    <div key={question.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{question.header ?? question.question}</div>
                      {question.header !== undefined && (
                        <div style={{ fontSize: 13, lineHeight: '20px' }}>{question.question}</div>
                      )}
                      {question.detail !== undefined && (
                        <div style={{ fontSize: 12, lineHeight: '18px', opacity: 0.8 }}>{question.detail}</div>
                      )}
                      <div style={{ fontSize: 11, opacity: 0.65 }}>
                        {question.multiSelect === true ? t('pending.multiHint') : t('pending.selectHint')}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {(question.options ?? []).map(option => {
                          const active = chosen.includes(option.label)
                          return (
                            <button
                              key={option.label}
                              type="button"
                              onClick={() => { toggle(item.id, question, option.label) }}
                              style={{
                                textAlign: 'left',
                                padding: '8px 10px',
                                borderRadius: 8,
                                cursor: 'pointer',
                                border: `1px solid ${active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'}`,
                                background: active ? 'var(--dsw-alias-bg-module-hover)' : 'transparent',
                                color: 'var(--dsw-alias-label-primary)',
                              }}
                            >
                              <div style={{ fontSize: 13, fontWeight: 600 }}>{option.label}</div>
                              {option.description !== undefined && (
                                <div style={{ fontSize: 12, lineHeight: '18px', opacity: 0.8 }}>{option.description}</div>
                              )}
                            </button>
                          )
                        })}
                      </div>
                      <input
                        value={customs[item.id]?.[question.id] ?? ''}
                        onChange={(event) => { setCustom(item.id, question.id, event.target.value) }}
                        placeholder={t('pending.custom')}
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          padding: '8px 10px',
                          borderRadius: 8,
                          border: '1px solid var(--dsw-alias-border-l2)',
                          background: 'transparent',
                          color: 'var(--dsw-alias-label-primary)',
                          fontSize: 13,
                        }}
                      />
                    </div>
                  )
                })}
                {item.kind === 'question' && (
                  <button
                    type="button"
                    style={primary}
                    disabled={busy !== undefined}
                    onClick={() => { void submit(item) }}
                  >
                    {busy === `${item.id}:answer` ? t('pending.submitting') : t('pending.submit')}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}


/** Whether two poll snapshots are identical enough to skip a render. */
function sameItems(previous: readonly PendingItem[], next: readonly PendingItem[]): boolean {
  if (previous.length !== next.length) return false
  return previous.every((item, index) => {
    const other = next[index]
    return other !== undefined && item.id === other.id && item.createdAt === other.createdAt && item.summary === other.summary
  })
}


/**
 * Best-effort dismissal of the official question card after the broker has
 * accepted an answer. The official card is an optimistic client surface keyed
 * by its own submit handler; a host-side answer closes the tool call but not
 * that local surface. Find the card by its question text and hide the nearest
 * card/dialog ancestor. The pending sheet's own DOM is excluded.
 */
function dismissOfficialQuestionCards(questions: readonly PendingQuestion[]): void {
  const texts = questions
    .flatMap(question => [question.question, question.header])
    .filter((text): text is string => typeof text === 'string' && text.trim().length > 4)
  if (texts.length === 0) return
  const candidates = [...document.querySelectorAll<HTMLElement>('body *')].filter((element) => {
    if (element.closest('[data-dsh-part]') !== null) return false
    const content = element.textContent ?? ''
    return texts.some(text => content.includes(text))
  })
  const cards = new Set<HTMLElement>()
  for (const candidate of candidates) {
    let node: HTMLElement | null = candidate
    let fallback: HTMLElement | null = null
    for (let depth = 0; depth < 8 && node !== null; depth += 1) {
      const className = typeof node.className === 'string' ? node.className : ''
      if (node.getAttribute('role') === 'dialog' || /(?:^|[\s_-])(?:card|panel|modal|dialog|sheet|question)/i.test(className)) {
        cards.add(node)
        break
      }
      if (fallback === null && node.querySelector('button') !== null) fallback = node
      node = node.parentElement
    }
    if (node === null && fallback !== null) cards.add(fallback)
  }
  for (const card of cards) {
    if (card === document.body || card === document.documentElement) continue
    card.style.display = 'none'
  }
}
