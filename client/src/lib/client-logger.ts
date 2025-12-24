"use client"

const LOG_ENDPOINT = "/api/logs"
const MAX_STRING_LENGTH = Number(
  process.env.NEXT_PUBLIC_CLIENT_LOG_MAX_STRING_LENGTH ?? 20000
)

const SENSITIVE_KEYS = new Set([
  "password",
  "auth_hash",
  "auth_salt",
  "kdf_salt",
  "encrypted_identity_key",
  "encrypted_transport_key",
  "encrypted_identity_iv",
  "encrypted_transport_iv",
  "private_key",
  "server_private_key",
  "token",
  "authorization",
  "cookie",
  "masterkey",
  "identityprivatekey",
  "transportprivatekey",
  "content",
  "plaintext",
  "message",
  "text",
])

type ClientLogEntry = {
  level?: "debug" | "info" | "warn" | "error"
  event: string
  payload?: unknown
  context?: unknown
  timestamp?: string
}

const sanitize = (value: unknown): unknown => {
  const seen = new WeakSet<object>()

  const walk = (input: unknown, key?: string): unknown => {
    const loweredKey = key?.toLowerCase()
    if (loweredKey && SENSITIVE_KEYS.has(loweredKey)) {
      if (typeof input === "string") {
        return {
          redacted: true,
          length: input.length,
        }
      }
      return "[redacted]"
    }
    if (typeof input === "string") {
      if (input.length > MAX_STRING_LENGTH) {
        return `${input.slice(0, MAX_STRING_LENGTH)}...[truncated]`
      }
      return input
    }
    if (!input || typeof input !== "object") {
      return input
    }
    if (seen.has(input)) {
      return "[circular]"
    }
    seen.add(input)
    if (Array.isArray(input)) {
      return input.map((item) => walk(item))
    }
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([childKey, val]) => [
        childKey,
        walk(val, childKey),
      ])
    )
  }

  return walk(value)
}

export async function logClientEvent(entry: ClientLogEntry, authToken?: string) {
  if (typeof window === "undefined") {
    return
  }
  const payload = {
    ...entry,
    payload: sanitize(entry.payload),
    context: sanitize(entry.context),
    timestamp: entry.timestamp ?? new Date().toISOString(),
  }
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`
    }
    await fetch(LOG_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      credentials: "include",
      keepalive: true,
    })
  } catch {
    // Best effort; avoid throwing in UI paths.
  }
}
