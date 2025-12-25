const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? ""
let authToken: string | null = null
let unauthorizedHandler: (() => void) | null = null
let didHandleUnauthorized = false

export function setAuthToken(token: string | null) {
  authToken = token
  if (token) {
    didHandleUnauthorized = false
  }
}

export function getAuthToken() {
  return authToken
}

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler
  if (!handler) {
    didHandleUnauthorized = false
  }
}

type ApiFetchOptions = Omit<RequestInit, "body"> & {
  body?: unknown
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
  const finalHeaders = new Headers(headers)
  if (authToken && !finalHeaders.has("Authorization")) {
    finalHeaders.set("Authorization", `Bearer ${authToken}`)
  }
  const finalBody =
    body &&
    typeof body !== "string" &&
    !(body instanceof FormData) &&
    !(body instanceof URLSearchParams) &&
    !(body instanceof Blob)
      ? JSON.stringify(body)
      : body
  if (finalBody && !finalHeaders.has("Content-Type") && !(body instanceof FormData)) {
    finalHeaders.set("Content-Type", "application/json")
  }

  const response = await fetch(buildUrl(normalizedPath), {
    ...init,
    body: finalBody as BodyInit | null | undefined,
    headers: finalHeaders,
    credentials: "include",
  })

  if (response.status === 401 && authToken && unauthorizedHandler && !didHandleUnauthorized) {
    didHandleUnauthorized = true
    try {
      unauthorizedHandler()
    } catch {
      // Best-effort logout
    }
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
    throw new Error(errorMessage)
  }

  if (!parseJson) {
    return undefined as T
  }

  return (await response.json()) as T
}
