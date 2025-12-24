import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

import { getInstanceHost } from "./handles"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function parseUser(id: string) {
  const trimmed = id.trim()
  const fallbackHost =
    getInstanceHost() ?? process.env.NEXT_PUBLIC_API_HOST ?? ""
  if (!trimmed) {
    return { username: "", host: fallbackHost }
  }
  const atIndex = trimmed.lastIndexOf("@")
  if (atIndex > 0) {
    const username = trimmed.slice(0, atIndex)
    const host = trimmed.slice(atIndex + 1) || fallbackHost
    return { username, host }
  }
  return { username: trimmed, host: fallbackHost }
}
