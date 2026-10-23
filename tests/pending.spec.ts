/** Pending broker semantics: phone/desktop race, validation, timeout, abort. */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { PendingBroker } from '../src/pending.ts'

type QuestionListener = (
  request: { questions: Array<{ id: string; question: string; options?: Array<{ label: string }>; multiSelect?: boolean }>; agent?: { id: string }; signal?: AbortSignal; wait?: { callId?: string } },
  next: () => Promise<AskUserQuestionAnswer>,
) => Promise<AskUserQuestionAnswer>

type ApprovalListener = (
  request: { agent?: { id: string }; toolName?: string; callId?: string; reason?: string; signal?: AbortSignal },
  next: () => Promise<ApprovalOutcome>,
) => Promise<ApprovalOutcome>

/** A fake Cordis context that records the two waterfall listeners. */
function fakeContext(): { ctx: Context; listeners: Map<string, unknown> } {
  const listeners = new Map<string, unknown>()
  const ctx = {
    on: (event: string, listener: unknown) => {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    },
    get: () => undefined,
  } as unknown as Context
  return { ctx, listeners }
}

/** The standard one-question request. */
function questionRequest(signal?: AbortSignal) {
  return {
    questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }],
    agent: { id: 'session-1' },
    wait: { callId: 'call-1' },
    ...(signal !== undefined ? { signal } : {}),
  }
}

/** Build a broker over the fake context. */
function setup(options: { isRoot?: boolean; timeoutMs?: number } = {}) {
  const { ctx, listeners } = fakeContext()
  const acknowledge = vi.fn()
  const broker = new PendingBroker({
    titleOf: () => 'Session',
    isRoot: () => options.isRoot ?? true,
    timeoutMs: options.timeoutMs ?? 60_000,
    log: { warn: vi.fn(), error: vi.fn() },
    acknowledge,
  })
  const dispose = broker.install(ctx, () => true)
  return {
    broker,
    listeners,
    acknowledge,
    dispose,
    question: listeners.get('user-questions/request') as QuestionListener,
    approval: listeners.get('approval/request') as ApprovalListener,
  }
}

describe('PendingBroker', () => {
  it('lets the phone answer first and removes the item', async () => {
    const { broker, question, acknowledge } = setup()
    const desktop = Promise.withResolvers<AskUserQuestionAnswer>()
    const answered = question(questionRequest(), () => desktop.promise)
    const item = broker.list()[0]
    expect(item).toMatchObject({ kind: 'question', callId: 'call-1', title: 'Session' })
    expect(broker.answer(item!.id, [{ id: 'q1', selected: ['A'] }])).toMatchObject({ ok: true })
    expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({ id: 'session-1' }), 'call-1', { answers: [{ id: 'q1', selected: ['A'] }] })
    await expect(answered).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A'] }] })
    expect(broker.list()).toEqual([])
  })

  it('lets the desktop answer first and closes the phone item', async () => {
    const { broker, question } = setup()
    const desktop = Promise.withResolvers<AskUserQuestionAnswer>()
    const answered = question(questionRequest(), () => desktop.promise)
    const item = broker.list()[0]!
    const desktopAnswer = { answers: [{ id: 'q1', selected: ['B'] }] }
    desktop.resolve(desktopAnswer)
    await expect(answered).resolves.toEqual(desktopAnswer)
    expect(broker.list()).toEqual([])
    expect(broker.answer(item.id, [{ id: 'q1', selected: ['A'] }])).toEqual({ ok: false, code: 'not-found' })
  })

  it('rejects an invalid answer and keeps the item open', async () => {
    const { broker, question } = setup()
    const desktop = Promise.withResolvers<AskUserQuestionAnswer>()
    void question(questionRequest(), () => desktop.promise)
    const item = broker.list()[0]!
    expect(broker.answer(item.id, [])).toEqual({ ok: false, code: 'bad-answer' })
    expect(broker.answer(item.id, [{ id: 'q1', selected: ['C'] }])).toEqual({ ok: false, code: 'bad-answer' })
    expect(broker.list()).toHaveLength(1)
    expect(broker.answer(item.id, [{ id: 'q1', selected: ['A'] }])).toMatchObject({ ok: true })
  })

  it('allows once or rejects an approval from the phone', async () => {
    const { broker, approval } = setup()
    const firstDesktop = Promise.withResolvers<ApprovalOutcome>()
    const first = approval({ agent: { id: 'session-1' }, toolName: 'bash', reason: 'write' }, () => firstDesktop.promise)
    const firstItem = broker.list()[0]!
    expect(firstItem).toMatchObject({ kind: 'approval', toolName: 'bash' })
    expect(broker.decide(firstItem.id, 'allow')).toMatchObject({ ok: true })
    await expect(first).resolves.toBe('allowed-once')

    const secondDesktop = Promise.withResolvers<ApprovalOutcome>()
    const second = approval({ agent: { id: 'session-1' }, toolName: 'bash' }, () => secondDesktop.promise)
    const secondItem = broker.list()[0]!
    expect(broker.decide(secondItem.id, 'deny')).toMatchObject({ ok: true })
    await expect(second).resolves.toBe('rejected')
  })

  it('skips a subagent and leaves the official answerer in charge', async () => {
    const { broker, question } = setup({ isRoot: false })
    const desktop = Promise.withResolvers<AskUserQuestionAnswer>()
    const answer = { answers: [{ id: 'q1', selected: ['A'] }] }
    const answered = question(questionRequest(), () => {
      desktop.resolve(answer)
      return desktop.promise
    })
    await expect(answered).resolves.toEqual(answer)
    expect(broker.list()).toEqual([])
  })

  it('rejects when the tool signal aborts and removes the item', async () => {
    const { broker, question } = setup()
    const controller = new AbortController()
    const desktop = Promise.withResolvers<AskUserQuestionAnswer>()
    const answered = question(questionRequest(controller.signal), () => desktop.promise)
    const reason = new Error('timed out')
    controller.abort(reason)
    await expect(answered).rejects.toBe(reason)
    expect(broker.list()).toEqual([])
  })

  it('falls back to a ceiling when neither side answers', async () => {
    const { broker, question } = setup({ timeoutMs: 15 })
    const desktop = Promise.withResolvers<AskUserQuestionAnswer>()
    const answered = question(questionRequest(), () => desktop.promise)
    await expect(answered).rejects.toThrow(/timed out/)
    expect(broker.list()).toEqual([])
  })
})
