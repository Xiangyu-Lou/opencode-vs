// vsworker-seam: pure error-shape handling, kept out of api.ts so it can be unit tested without pulling in
// Solid's context modules.

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

export type ErrorDetail = { name?: string; file?: string; message?: string; status?: number }

// The throwing client rejects with an Error whose message is the body's `message` and whose `cause` carries
// `{ body, status }`. The declared fields a route returns, such as which file a conflict was on, only exist
// there, so read the body out of the cause rather than off the Error itself.
export function errorOf(error: unknown): ErrorDetail {
  const root = asRecord(error)
  if (!root) return {}
  const cause = asRecord(root.cause)
  const body = asRecord(cause?.body) ?? asRecord(root.body) ?? asRecord(root.data)
  const status = typeof cause?.status === "number" ? cause.status : undefined
  const string = (value: unknown) => (typeof value === "string" ? value : undefined)
  return {
    name: string(body?.name),
    file: string(body?.file),
    message: string(body?.message) ?? string(root.message),
    status,
  }
}

export function isConflict(error: unknown) {
  const detail = errorOf(error)
  return detail.name === "VsWorkerConflictError" || detail.status === 409
}
