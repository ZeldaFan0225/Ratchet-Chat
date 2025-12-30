"use client"

import * as React from "react"
import { Emoji, getEmojiDataFromNative } from "emoji-mart"
import { ensureEmojiMartInit } from "@/components/emoji/emojiMartData"

type EmojiMartEmojiProps = {
  emoji: string
  size?: number
  className?: string
  label?: string
}

export function EmojiMartEmoji({
  emoji,
  size = 16,
  className,
  label,
}: EmojiMartEmojiProps) {
  const containerRef = React.useRef<HTMLSpanElement>(null)

  React.useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    container.textContent = ""
    let cancelled = false
    let element: HTMLElement | null = null
    void (async () => {
      try {
        await ensureEmojiMartInit()
        if (cancelled) {
          return
        }
        const emojiData = await getEmojiDataFromNative(emoji)
        if (cancelled) {
          return
        }
        const emojiElement = new Emoji({
          native: emoji,
          skin: emojiData?.skin,
          size,
          set: "native",
          fallback: emoji,
        }) as unknown as HTMLElement
        element = emojiElement
        container.appendChild(emojiElement)
      } catch {
        if (!cancelled) {
          container.textContent = emoji
        }
      }
    })()

    return () => {
      cancelled = true
      element?.remove()
    }
  }, [emoji, size])

  const accessibilityProps = label
    ? { role: "img", "aria-label": label }
    : { "aria-hidden": true }

  return <span ref={containerRef} className={className} {...accessibilityProps} />
}
