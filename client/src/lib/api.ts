import { logClientEvent } from "@/lib/client-logger"

const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? ""
let authToken: string | null = null

export function setAuthToken(token: string | null) {
  authToken = token
}

export function getAuthToken() {
  return authToken
}

type ApiFetchOptions = RequestInit & {
  parseJson?: boolean
}

function buildUrl(path: string) {
  if (!baseUrl) {
    throw new Error("NEXT_PUBLIC_API_URL is not set")
  }
  const normalized = path.startsWith("/") ? path : `/${path}`
  return `${baseUrl.replace(/\/$/, "")}${normalized}`
}

export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {}
): Promise<T> {
  const { parseJson = true, headers, body, ...init } = options
  const normalizedPath = path.startsWith("/") ? path : `/${path}`
  const shouldLog = !normalizedPath.startsWith("/api/logs")
  const finalHeaders = new Headers(headers)
  if (authToken && !finalHeaders.has("Authorization")) {
    finalHeaders.set("Authorization", `Bearer ${authToken}`)
  }
  const finalBody =
    body && typeof body !== "string" && !(body instanceof FormData)
      ? JSON.stringify(body)
      : body
  if (finalBody && !finalHeaders.has("Content-Type") && !(body instanceof FormData)) {
    finalHeaders.set("Content-Type", "application/json")
  }

  if (shouldLog) {
    void logClientEvent(
      {
        level: "info",
        event: "api.request",
        payload: {
          path: normalizedPath,
          method: init.method ?? "GET",
          headers: Object.fromEntries(finalHeaders.entries()),
          body,
        },
      },
      authToken ?? undefined
    )
  }

  const response = await fetch(buildUrl(normalizedPath), {
    ...init,
    body: finalBody,
    headers: finalHeaders,
    credentials: "include",
  })

  if (shouldLog) {
    void logClientEvent(
      {
        level: response.ok ? "info" : "warn",
        event: "api.response",
        payload: {
          path: normalizedPath,
          status: response.status,
          ok: response.ok,
        },
      },
      authToken ?? undefined
    )
  }

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? ""
    const message = await response.text()
    const looksLikeHtml =
      contentType.includes("text/html") ||
      message.trim().startsWith("<!DOCTYPE html") ||
      message.trim().startsWith("<html")
    if (looksLikeHtml) {
      throw new Error(
        "API request returned HTML. Check NEXT_PUBLIC_API_URL (it is likely pointing at the Next.js app instead of the API server)."
      )
    }
    const errorMessage = message || `Request failed with ${response.status}`
    if (shouldLog) {
      void logClientEvent(
        {
        level: "error",
        event: "api.error",
        payload: {
          path: normalizedPath,
          status: response.status,
          message: errorMessage,
        },
        },
        authToken ?? undefined
      )
    }
    throw new Error(errorMessage)
  }

  if (!parseJson) {
    return undefined as T
  }

  return (await response.json()) as T
}
