/**
 * Event-to-notification bridge: the Host-side half that turns the three
 * moments a phone cares about — a question, an approval, a finished turn —
 * into one collapsed Web Push notification. It is deliberately a bystander:
 * every waterfall listener calls `next()` synchronously and never awaits
 * delivery, so a broken push service cannot delay or fail an agent turn.
 */

import { hostname } from 'node:os'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PushNotifier } from './push.ts'

/** The subset of the session title service this module reads. */
interface SessionTitleLike {
  get(session: Session): { title?: string } | undefined
}

/** The subset of the live session store this module reads. */
interface SessionStoreLike {
  get(id: string): Session | undefined
}

/** One event bridge installation. */
export interface PushEventsOptions {
  /** Whether the plugin master switch is on, read per event. */
  enabled: () => boolean
  /** Override the host label shown in notification titles (tests). */
  hostName?: string
}

/** Longest notification body kept before the push service's 4 KiB budget. */
const MAX_BODY_CHARS = 160

/**
 * Wire the push bridge onto a Host context.
 * @param ctx - host plugin context.
 * @param push - subscription table and sender.
 * @param options - enablement and host-name overrides.
 * @returns the disposer that unregisters every listener.
 */
export function installPushEvents(ctx: Context, push: PushNotifier, options: PushEventsOptions): () => void {
  const bridge = new PushEvents(ctx, push, options)
  // Scoped waterfall: a root listener must opt into global delivery or the
  // Agent-scoped dispatch filters it out before it can notify.
  const offQuestion = ctx.on('user-questions/request', (request, next) => {
    bridge.question(request)
    return next()
  }, { prepend: true, global: true })
  const offApproval = ctx.on('approval/request', (request, next) => {
    bridge.approval(request)
    return next()
  }, { prepend: true, global: true })
  const offSession = ctx.on('session/event', (session, event) => {
    bridge.sessionEvent(session, event)
  }, { global: true })
  return () => {
    offQuestion()
    offApproval()
    offSession()
  }
}

/** Mutable bridge state: dedupe keys, turn clocks, and recent attention. */
class PushEvents {
  private readonly host: string
  private readonly lastSent = new Map<string, number>()
  private readonly turnStarted = new Map<string, number>()
  private readonly attentionAt = new Map<string, number>()

  /**
   * @param ctx - host context used to resolve sessions and titles lazily.
   * @param push - subscription table and sender.
   * @param options - enablement and host-name overrides.
   */
  constructor(
    private readonly ctx: Context,
    private readonly push: PushNotifier,
    private readonly options: PushEventsOptions,
  ) {
    this.host = (options.hostName ?? hostname()).slice(0, 40)
  }

  /** Send one question notification. */
  question(request: { questions?: readonly { id?: string; header?: string; question?: string }[]; agent?: { id: string }; wait?: { callId?: string } }): void {
    if (!this.ready()) return
    const sessionId = request.agent?.id
    if (sessionId === undefined) return
    const callId = request.wait?.callId
    const first = request.questions?.[0]
    const tag = `q:${sessionId}:${callId ?? first?.id ?? 'question'}`
    if (!this.allow(tag, 30_000)) return
    this.attentionAt.set(sessionId, Date.now())
    const title = this.titleOf(sessionId)
    const prompt = [first?.header, first?.question].filter((part): part is string => typeof part === 'string' && part.length > 0).join('：')
    const count = request.questions?.length ?? 0
    const suffix = count > 1 ? `（共 ${String(count)} 个问题）` : ''
    this.send({
      title: `DSH · ${this.host}`,
      body: clip(`${title !== undefined ? `${title} · ` : ''}${prompt !== '' ? prompt : '有一个问题需要你回答'}${suffix}`),
      tag,
      url: '/?pending=1',
      data: { kind: 'question', sessionId, ...(callId !== undefined ? { callId } : {}) },
    })
  }

  /** Send one approval notification. */
  approval(request: { agent?: { id: string }; toolName?: string; callId?: string; reason?: string; displayReason?: Record<string, string> }): void {
    if (!this.ready()) return
    const sessionId = request.agent?.id
    if (sessionId === undefined) return
    const tag = `a:${sessionId}:${request.callId ?? request.toolName ?? 'approval'}`
    if (!this.allow(tag, 30_000)) return
    this.attentionAt.set(sessionId, Date.now())
    const title = this.titleOf(sessionId)
    const reason = request.displayReason?.zh ?? request.displayReason?.en ?? request.reason
    const tool = request.toolName ?? '工具调用'
    this.send({
      title: `DSH · ${this.host}`,
      body: clip(`${title !== undefined ? `${title} · ` : ''}需要授权：${tool}${reason !== undefined && reason !== '' ? ` — ${reason}` : ''}`),
      tag,
      url: '/?pending=1',
      data: { kind: 'approval', sessionId, ...(request.callId !== undefined ? { callId: request.callId } : {}) },
    })
  }

  /** Track a turn clock and announce its terminal state. */
  sessionEvent(session: Session, event: SessionEvent): void {
    if (session.header.parentSession !== undefined) return
    if (event.type === 'turn/start') {
      this.turnStarted.set(session.id, event.time)
      return
    }
    if (event.type !== 'turn/end') return
    const started = this.turnStarted.get(session.id)
    this.turnStarted.delete(session.id)
    const reason = event.data.reason
    if (reason.kind === 'aborted' || reason.kind === 'interrupted' || reason.kind === 'forked') return
    if (!this.ready()) return
    // A question or approval raised during this turn already woke the phone;
    // a second "completed" notification one second later is noise.
    const attention = this.attentionAt.get(session.id)
    if (attention !== undefined && Date.now() - attention < 60_000) return
    if (started !== undefined && event.time - started < 3_000) return
    const tag = `t:${session.id}`
    if (!this.allow(tag, 30_000)) return
    const title = this.titleOf(session.id)
    const duration = started !== undefined ? ` · ${formatDuration(event.time - started)}` : ''
    const outcome = reason.kind === 'completed'
      ? '任务完成'
      : reason.kind === 'error'
        ? '任务失败'
        : reason.kind === 'blocked'
          ? '任务被阻塞'
          : '输出达到上限'
    this.send({
      title: `DSH · ${this.host}`,
      body: clip(`${title !== undefined ? `${title} · ` : ''}${outcome}${duration}`),
      tag,
      url: '/',
      data: { kind: 'turn-end', sessionId: session.id, outcome: reason.kind },
    })
  }

  /** Whether the master switch is on and at least one endpoint exists. */
  private ready(): boolean {
    return this.options.enabled() && this.push.hasSubscriptions()
  }

  /** Rate-limit one dedupe key and keep the table bounded. */
  private allow(tag: string, windowMs: number): boolean {
    const now = Date.now()
    const previous = this.lastSent.get(tag)
    if (previous !== undefined && now - previous < windowMs) return false
    this.lastSent.set(tag, now)
    while (this.lastSent.size > 256) {
      const oldest = this.lastSent.keys().next().value
      if (oldest === undefined) break
      this.lastSent.delete(oldest)
    }
    return true
  }

  /** Fire-and-forget delivery; failures are logged by the push service. */
  private send(payload: { title: string; body: string; tag: string; url: string; data: Record<string, unknown> }): void {
    void this.push.sendAll(payload).catch(() => undefined)
  }

  /** Fold the live session's title, falling back to its directory name. */
  private titleOf(sessionId: string): string | undefined {
    const sessions = this.ctx.get('sessions') as unknown as SessionStoreLike | undefined
    const session = sessions?.get(sessionId)
    if (session === undefined) return undefined
    const titles = this.ctx.get('sessionTitle') as unknown as SessionTitleLike | undefined
    const title = titles?.get(session)?.title
    if (title !== undefined && title !== '') return title
    const folder = basename(session.header.cwd ?? '')
    return folder !== '' ? folder : undefined
  }
}

/** Truncate a notification body without splitting a surrogate pair. */
function clip(text: string): string {
  if (text.length <= MAX_BODY_CHARS) return text
  return `${text.slice(0, MAX_BODY_CHARS - 1)}…`
}

/** Render a compact duration for the completion notification. */
function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`
}
