/**
 * Persistent pending-interaction broker for questions and tool approvals.
 *
 * The official answerer is a live client: when the phone's WebSocket drops or
 * the page reloads, its transient card can disappear even though the agent is
 * still waiting. This broker holds the request on the host instead, exposes it
 * through the pairing routes, and races the official answerer against the
 * phone. Whichever answers first wins; a disconnected client no longer owns
 * the outcome, and the item survives reconnects and page reloads.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'

/** One question row as the phone renders it. */
export interface PendingQuestionView {
  /** Question identity inside the tool call. */
  id: string
  /** Short heading. */
  header?: string
  /** Full question text. */
  question: string
  /** Optional detail. */
  detail?: string
  /** Selectable labels. */
  options?: readonly { label: string; description?: string }[]
  /** Whether several options may be selected. */
  multiSelect?: boolean
}

/** One open item as the phone lists it. */
export interface PendingItemView {
  /** Broker identity; the answer/decision route keys on it. */
  id: string
  /** Question or approval. */
  kind: 'question' | 'approval'
  /** Owning session. */
  sessionId: string
  /** Foreground tool call, when the request carries one. */
  callId?: string
  /** Session title or directory label. */
  title?: string
  /** One-line summary for the banner. */
  summary: string
  /** Creation time (ms epoch). */
  createdAt: number
  /** Questions, for `kind: 'question'`. */
  questions?: readonly PendingQuestionView[]
  /** Tool name, for `kind: 'approval'`. */
  toolName?: string
  /** Approval reason, for `kind: 'approval'`. */
  reason?: string
}

/** One internal pending item with its resolver. */
interface PendingItemBase {
  id: string
  sessionId: string
  callId?: string
  title?: string
  summary: string
  createdAt: number
  reject: (reason: unknown) => void
}

/** A held question. */
interface PendingQuestionItem extends PendingItemBase {
  kind: 'question'
  questions: AskUserQuestionItem[]
  resolve: (answer: AskUserQuestionAnswer) => void
}

/** A held approval. */
interface PendingApprovalItem extends PendingItemBase {
  kind: 'approval'
  toolName: string
  reason?: string
  resolve: (outcome: ApprovalOutcome) => void
}

/** Either held item. */
type PendingItem = PendingQuestionItem | PendingApprovalItem

/** Result of applying a phone answer or decision. */
export type PendingApplyResult =
  | { ok: true }
  | { ok: false; code: 'not-found' | 'wrong-kind' | 'bad-answer' | 'expired' }

/** Construction options. */
export interface PendingBrokerOptions {
  /** Session title lookup (falls back to the directory name). */
  titleOf: (sessionId: string) => string | undefined
  /** Whether a live session is a runtime root (subagents are skipped). */
  isRoot: (sessionId: string) => boolean
  /** Fallback ceiling when the tool's own signal never aborts (default 30 min). */
  timeoutMs?: number
  /** Failure logger. */
  log?: Pick<Console, 'warn' | 'error'>
}

/** A structurally narrowed question request, so this module needs no runtime import. */
interface QuestionRequestLike {
  questions: AskUserQuestionItem[]
  agent?: { id: string }
  signal?: AbortSignal
  wait?: { callId?: string }
}

/** A structurally narrowed approval request. */
interface ApprovalRequestLike {
  agent?: { id: string }
  toolName?: string
  callId?: string
  reason?: string
  displayReason?: Record<string, string>
  signal?: AbortSignal
}

/** A promise that intentionally never settles (desktop rejection fallback). */
const NEVER = new Promise<never>(() => undefined)

/** Default fallback ceiling. */
const DEFAULT_TIMEOUT_MS = 30 * 60_000

/** Cap on live items; a pathological question storm must not grow forever. */
const MAX_ITEMS = 32

/** Hold and expose pending questions and approvals. */
export class PendingBroker {
  private readonly items = new Map<string, PendingItem>()
  private readonly timeoutMs: number
  private readonly log: Pick<Console, 'warn' | 'error'>

  /**
   * @param options - title/root lookups and timeout.
   */
  constructor(private readonly options: PendingBrokerOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.log = options.log ?? console
  }

  /**
   * Register the two waterfall listeners. Every listener returns to `next()`
   * when the plugin is off, when the request has no live root agent, or when
   * the broker cannot hold it; the official UI keeps working unchanged.
   * @param ctx - host context.
   * @param enabled - master switch, read per request.
   * @returns the disposer that unregisters both listeners.
   */
  install(ctx: Context, enabled: () => boolean): () => void {
    // Prepend: the broker must see the request before the official answerer,
    // otherwise a connected desktop can consume it and the phone item never
    // exists. Its `next()` still invokes the official chain.
    const offQuestion = ctx.on('user-questions/request', (request, next) => (
      this.question(request, next, enabled)
    ), { prepend: true, global: true })
    const offApproval = ctx.on('approval/request', (request, next) => (
      this.approval(request, next, enabled)
    ), { prepend: true, global: true })
    return () => {
      offQuestion()
      offApproval()
      this.dispose()
    }
  }

  /** Open items, newest first. */
  list(): PendingItemView[] {
    return [...this.items.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(item => viewOf(item))
  }

  /**
   * Apply one phone answer to a held question.
   * @param id - broker item id.
   * @param answers - one answer item per question, in any order.
   * @returns ok, or the stable refusal code.
   */
  answer(id: string, answers: AskUserQuestionAnswer['answers']): PendingApplyResult {
    const item = this.items.get(id)
    if (item === undefined) return { ok: false, code: 'not-found' }
    if (item.kind !== 'question') return { ok: false, code: 'wrong-kind' }
    if (!validAnswers(item.questions, answers)) return { ok: false, code: 'bad-answer' }
    this.items.delete(id)
    item.resolve({ answers })
    return { ok: true }
  }

  /**
   * Apply one phone decision to a held approval.
   * @param id - broker item id.
   * @param decision - allow once or reject.
   * @returns ok, or the stable refusal code.
   */
  decide(id: string, decision: 'allow' | 'deny'): PendingApplyResult {
    const item = this.items.get(id)
    if (item === undefined) return { ok: false, code: 'not-found' }
    if (item.kind !== 'approval') return { ok: false, code: 'wrong-kind' }
    this.items.delete(id)
    item.resolve(decision === 'allow' ? 'allowed-once' : 'rejected')
    return { ok: true }
  }

  /** Reject every held item; called when the plugin unloads. */
  dispose(): void {
    for (const item of this.items.values()) item.reject(new Error('pending broker disposed'))
    this.items.clear()
  }

  /** Hold a question and race the official answerer against the phone. */
  private async question(
    request: QuestionRequestLike,
    next: () => Promise<AskUserQuestionAnswer>,
    enabled: () => boolean,
  ): Promise<AskUserQuestionAnswer> {
    const sessionId = request.agent?.id
    if (!enabled() || sessionId === undefined || !this.options.isRoot(sessionId) || this.items.size >= MAX_ITEMS) {
      return next()
    }
    const item = this.createQuestion(request, sessionId)
    return this.race(item, next, request.signal)
  }

  /** Hold an approval and race the official answerer against the phone. */
  private async approval(
    request: ApprovalRequestLike,
    next: () => Promise<ApprovalOutcome>,
    enabled: () => boolean,
  ): Promise<ApprovalOutcome> {
    const sessionId = request.agent?.id
    if (!enabled() || sessionId === undefined || !this.options.isRoot(sessionId) || this.items.size >= MAX_ITEMS) {
      return next()
    }
    const item = this.createApproval(request, sessionId)
    return this.race(item, next, request.signal)
  }

  /** Build and register one question item. */
  private createQuestion(request: QuestionRequestLike, sessionId: string): PendingQuestionItem {
    const first = request.questions[0]
    const prompt = [first?.header, first?.question].filter((part): part is string => typeof part === 'string' && part.length > 0).join('：')
    const count = request.questions.length
    let resolve: (answer: AskUserQuestionAnswer) => void = () => undefined
    let reject: (reason: unknown) => void = () => undefined
    const phone = new Promise<AskUserQuestionAnswer>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const item: PendingQuestionItem = {
      id: randomUUID(),
      kind: 'question',
      sessionId,
      ...(request.wait?.callId !== undefined ? { callId: request.wait.callId } : {}),
      title: this.options.titleOf(sessionId),
      summary: prompt !== '' ? `${prompt}${count > 1 ? `（共 ${String(count)} 个）` : ''}` : '有一个问题需要你回答',
      createdAt: Date.now(),
      questions: request.questions,
      resolve,
      reject,
    }
    // The promise is stored on the item through the closure below; keep a
    // reference so the race can await it.
    ;(item as PendingQuestionItem & { phone?: Promise<AskUserQuestionAnswer> }).phone = phone
    this.items.set(item.id, item)
    return item
  }

  /** Build and register one approval item. */
  private createApproval(request: ApprovalRequestLike, sessionId: string): PendingApprovalItem {
    const reason = request.displayReason?.zh ?? request.displayReason?.en ?? request.reason
    let resolve: (outcome: ApprovalOutcome) => void = () => undefined
    let reject: (reason: unknown) => void = () => undefined
    const phone = new Promise<ApprovalOutcome>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const item: PendingApprovalItem = {
      id: randomUUID(),
      kind: 'approval',
      sessionId,
      ...(request.callId !== undefined ? { callId: request.callId } : {}),
      title: this.options.titleOf(sessionId),
      summary: `需要授权：${request.toolName ?? '工具调用'}${reason !== undefined && reason !== '' ? ` — ${reason}` : ''}`,
      createdAt: Date.now(),
      toolName: request.toolName ?? '工具调用',
      ...(reason !== undefined ? { reason } : {}),
      resolve,
      reject,
    }
    ;(item as PendingApprovalItem & { phone?: Promise<ApprovalOutcome> }).phone = phone
    this.items.set(item.id, item)
    return item
  }

  /** Race the phone promise, the official answerer, and the request signal. */
  private async race<T>(
    item: PendingItem,
    next: () => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const phone = (item as PendingItem & { phone: Promise<T> }).phone
    const desktop = Promise.resolve()
      .then(() => next())
      .then(value => ({ source: 'desktop' as const, value }))
      .catch(() => NEVER)
    const aborted = abortPromise(signal)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('pending interaction timed out')) }, this.timeoutMs)
      timer.unref?.()
    })
    try {
      const winner = await Promise.race([
        phone.then(value => ({ source: 'phone' as const, value })),
        desktop,
        aborted,
        timeout,
      ])
      this.items.delete(item.id)
      return winner.value
    } catch (error) {
      this.items.delete(item.id)
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

/** Resolve when the request signal aborts, rejecting with its reason. */
function abortPromise(signal: AbortSignal | undefined): Promise<never> {
  if (signal === undefined) return NEVER
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('pending interaction aborted'))
      return
    }
    signal.addEventListener('abort', () => {
      reject(signal.reason ?? new Error('pending interaction aborted'))
    }, { once: true })
  })
}

/** Validate a phone answer batch against the held questions. */
function validAnswers(
  questions: readonly AskUserQuestionItem[],
  answers: AskUserQuestionAnswer['answers'],
): boolean {
  if (answers.length !== questions.length) return false
  const byId = new Map(questions.map(question => [question.id, question]))
  const seen = new Set<string>()
  for (const answer of answers) {
    const question = byId.get(answer.id)
    if (question === undefined || seen.has(answer.id)) return false
    seen.add(answer.id)
    if (!Array.isArray(answer.selected) || answer.selected.some(label => typeof label !== 'string')) return false
    if (question.multiSelect !== true && answer.selected.length > 1) return false
    if (answer.selected.length === 0 && (answer.custom === undefined || answer.custom.trim() === '')) return false
    if (question.options !== undefined) {
      const labels = new Set(question.options.map(option => option.label))
      if (answer.selected.some(label => !labels.has(label))) return false
    }
    if (answer.custom !== undefined && typeof answer.custom !== 'string') return false
  }
  return true
}

/** Project one internal item into the phone-facing view. */
function viewOf(item: PendingItem): PendingItemView {
  if (item.kind === 'question') {
    return {
      id: item.id,
      kind: 'question',
      sessionId: item.sessionId,
      ...(item.callId !== undefined ? { callId: item.callId } : {}),
      ...(item.title !== undefined ? { title: item.title } : {}),
      summary: item.summary,
      createdAt: item.createdAt,
      questions: item.questions.map(question => ({
        id: question.id,
        question: question.question,
        ...(question.header !== undefined ? { header: question.header } : {}),
        ...(question.detail !== undefined ? { detail: question.detail } : {}),
        ...(question.options !== undefined ? { options: question.options } : {}),
        ...(question.multiSelect === true ? { multiSelect: true } : {}),
      })),
    }
  }
  return {
    id: item.id,
    kind: 'approval',
    sessionId: item.sessionId,
    ...(item.callId !== undefined ? { callId: item.callId } : {}),
    ...(item.title !== undefined ? { title: item.title } : {}),
    summary: item.summary,
    createdAt: item.createdAt,
    toolName: item.toolName,
    ...(item.reason !== undefined ? { reason: item.reason } : {}),
  }
}
