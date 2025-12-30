import * as React from "react"
import { db, type EmbedCacheRecord } from "@/lib/db"
import { apiFetch } from "@/lib/api"

export type EmbedData = {
  url: string
  title: string | null
  description: string | null
  image: string | null
  siteName: string | null
}

type EmbedState = {
  data: EmbedData | null
  isLoading: boolean
  error: Error | null
}

// Cache TTL: 24 hours (client-side)
const CACHE_TTL = 24 * 60 * 60 * 1000

// In-flight request deduplication
const pendingRequests = new Map<string, Promise<EmbedData | null>>()

async function fetchFromCache(url: string): Promise<EmbedData | null> {
  try {
    const record = await db.embedCache.get(url)
    if (record && Date.now() - record.cachedAt < CACHE_TTL) {
      return {
        url: record.url,
        title: record.title,
        description: record.description,
        image: record.image,
        siteName: record.siteName,
      }
    }
    // Delete expired cache entry
    if (record) {
      await db.embedCache.delete(url)
    }
    return null
  } catch {
    return null
  }
}

async function saveToCache(data: EmbedData): Promise<void> {
  try {
    const record: EmbedCacheRecord = {
      url: data.url,
      title: data.title,
      description: data.description,
      image: data.image,
      siteName: data.siteName,
      cachedAt: Date.now(),
    }
    await db.embedCache.put(record)
  } catch {
    // Ignore cache errors
  }
}

async function fetchEmbed(url: string): Promise<EmbedData | null> {
  // Check for pending request
  const pending = pendingRequests.get(url)
  if (pending) {
    return pending
  }

  const request = (async () => {
    try {
      // Check cache first
      const cached = await fetchFromCache(url)
      if (cached) {
        return cached
      }

      // Fetch from server
      const data = await apiFetch<EmbedData>(`/api/embed?url=${encodeURIComponent(url)}`)

      // Only cache if we got useful data
      if (data.title || data.description) {
        await saveToCache(data)
      }

      return data
    } catch {
      return null
    } finally {
      pendingRequests.delete(url)
    }
  })()

  pendingRequests.set(url, request)
  return request
}

export function useEmbedPreview(url: string | null, enabled: boolean): EmbedState {
  const [state, setState] = React.useState<EmbedState>({
    data: null,
    isLoading: false,
    error: null,
  })

  React.useEffect(() => {
    if (!url || !enabled) {
      setState({ data: null, isLoading: false, error: null })
      return
    }

    let cancelled = false
    setState((prev) => ({ ...prev, isLoading: true, error: null }))

    fetchEmbed(url)
      .then((data) => {
        if (!cancelled) {
          setState({ data, isLoading: false, error: null })
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState({ data: null, isLoading: false, error })
        }
      })

    return () => {
      cancelled = true
    }
  }, [url, enabled])

  return state
}
