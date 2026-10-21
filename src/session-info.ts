/**
 * Small read-only session lookups shared by the notification and pending
 * halves. Both resolve the same facts lazily from the Host's live services,
 * so neither module needs a value import from the official SDK.
 */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** The subset of a live Session these helpers read. */
interface SessionLike {
  id: string
  header?: {
    cwd?: string
    parentSession?: string
  }
}

/** The subset of the live session store this module reads. */
interface SessionStoreLike {
  get(id: string): SessionLike | undefined
}

/** The subset of the title service this module reads. */
interface SessionTitleLike {
  get(session: SessionLike): { title?: string } | undefined
}

/**
 * Resolve one live session without activating a cold one.
 * @param ctx - host context.
 * @param sessionId - session identity.
 * @returns the live session, or undefined.
 */
export function liveSessionOf(ctx: Context, sessionId: string): SessionLike | undefined {
  const store = ctx.get('sessions') as unknown as SessionStoreLike | undefined
  return store?.get(sessionId)
}

/**
 * Whether a live session is a runtime root (a subagent has no human answerer).
 * @param ctx - host context.
 * @param sessionId - session identity.
 * @returns true only for a live root.
 */
export function isRootSession(ctx: Context, sessionId: string): boolean {
  const session = liveSessionOf(ctx, sessionId)
  return session !== undefined && session.header?.parentSession === undefined
}

/**
 * Fold the live session title, falling back to its directory name.
 * @param ctx - host context.
 * @param sessionId - session identity.
 * @returns a short label, or undefined without a live session.
 */
export function sessionLabelOf(ctx: Context, sessionId: string): string | undefined {
  const session = liveSessionOf(ctx, sessionId)
  if (session === undefined) return undefined
  const titles = ctx.get('sessionTitle') as unknown as SessionTitleLike | undefined
  const title = titles?.get(session)?.title
  if (title !== undefined && title !== '') return title
  const folder = basename(session.header?.cwd ?? '')
  return folder !== '' ? folder : undefined
}
