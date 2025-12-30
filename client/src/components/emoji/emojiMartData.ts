"use client"

import data from "@emoji-mart/data"
import { init } from "emoji-mart"

let initPromise: Promise<void> | null = null

export const ensureEmojiMartInit = () => {
  if (!initPromise) {
    initPromise = init({ data, set: "native" })
  }
  return initPromise
}

export default data
