/**
 * Phone-side access to the host's pending-interaction broker. The broker owns
 * the question/approval while it is open, so these reads and writes do not
 * depend on the live WebSocket or on the official UI card still being mounted.
 */

/** Broker route family. */
const PENDING = '/api/pair/pending'

/** One selectable option the phone renders. */
export interface PendingQuestionOption {
  label: string
  description?: string
}

/** One question inside a pending item. */
export interface PendingQuestion {
  id: string
  header?: string
  question: string
  detail?: string
  options?: PendingQuestionOption[]
  multiSelect?: boolean
}

/** One open question or approval. */
export interface PendingItem {
  id: string
  kind: 'question' | 'approval'
  sessionId: string
  callId?: string
  title?: string
  summary: string
  createdAt: number
  questions?: PendingQuestion[]
  toolName?: string
  reason?: string
}

/** One answer item in the shape the host broker validates. */
export interface PendingAnswer {
  id: string
  selected: string[]
  custom?: string
}

/** A route failure with its HTTP status and business code. */
export class PendingRequestError extends Error {
  /**
   * @param message - readable failure.
   * @param status - HTTP status, when the server answered.
   * @param code - business code.
   */
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message)
    this.name = 'PendingRequestError'
  }
}

/** The cookieless device credential, when the browser blocks cookies. */
function deviceHeaders(): Record<string, string> {
  try {
    const id = sessionStorage.getItem('dsh-remote-device')
    return id === null || id === '' ? {} : { 'x-dsh-remote-device': id }
  } catch {
    return {}
  }
}

/** Read one JSON response, normalizing a business refusal. */
async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  for (const [name, value] of Object.entries(deviceHeaders())) headers.set(name, value)
  const response = await fetch(url, { ...init, headers, credentials: 'same-origin', cache: 'no-store' })
  let body: Record<string, unknown> = {}
  try {
    body = await response.json() as Record<string, unknown>
  } catch {
    body = {}
  }
  if (!response.ok) {
    throw new PendingRequestError(
      typeof body.code === 'string' ? body.code : `HTTP ${String(response.status)}`,
      response.status,
      typeof body.code === 'string' ? body.code : undefined,
    )
  }
  return body as T
}

/** List every open item. */
export async function listPending(): Promise<PendingItem[]> {
  const body = await request<{ items?: PendingItem[] }>(PENDING)
  return Array.isArray(body.items) ? body.items : []
}

/** Answer one held question. */
export async function answerPending(id: string, answers: PendingAnswer[]): Promise<void> {
  await request(`${PENDING}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, answers }),
  })
}

/** Allow once or reject one held approval. */
export async function decidePending(id: string, decision: 'allow' | 'deny'): Promise<void> {
  await request(`${PENDING}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, decision }),
  })
}
