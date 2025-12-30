"use client"

import * as React from "react"
import { Picker } from "emoji-mart"
import data, { ensureEmojiMartInit } from "@/components/emoji/emojiMartData"

type EmojiMartTheme = "light" | "dark" | "auto"

type EmojiMartPickerProps = {
  height: number
  width: number
  onEmojiSelect: (emoji: string) => void
  theme?: EmojiMartTheme
}

type EmojiMartSelection = {
  native?: string
  emoji?: string
}

const applyPickerSizing = (
  pickerElement: HTMLElement,
  container: HTMLDivElement,
  height: number,
  width: number
) => {
  const widthPx = `${width}px`
  const heightPx = `${height}px`
  pickerElement.style.width = widthPx
  pickerElement.style.height = heightPx
  container.style.width = widthPx
  container.style.height = heightPx
}

export function EmojiMartPicker({
  height,
  width,
  onEmojiSelect,
  theme = "auto",
}: EmojiMartPickerProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const pickerRef = React.useRef<HTMLElement | null>(null)
  const onEmojiSelectRef = React.useRef(onEmojiSelect)
  const sizeRef = React.useRef({ height, width })

  React.useEffect(() => {
    onEmojiSelectRef.current = onEmojiSelect
  }, [onEmojiSelect])

  React.useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    container.innerHTML = ""
    if (pickerRef.current) {
      pickerRef.current.remove()
      pickerRef.current = null
    }
    let cancelled = false
    void (async () => {
      await ensureEmojiMartInit()
      if (cancelled) {
        return
      }
      const picker = new Picker({
        data,
        set: "native",
        theme,
        onEmojiSelect: (emoji: EmojiMartSelection) => {
          const selection = emoji?.native ?? emoji?.emoji ?? ""
          if (selection) {
            onEmojiSelectRef.current(selection)
          }
        },
      })
      const pickerElement = picker as unknown as HTMLElement
      pickerRef.current = pickerElement
      container.appendChild(pickerElement)
      applyPickerSizing(
        pickerElement,
        container,
        sizeRef.current.height,
        sizeRef.current.width
      )
    })()

    return () => {
      cancelled = true
      pickerRef.current?.remove()
      pickerRef.current = null
    }
  }, [theme])

  React.useEffect(() => {
    const pickerElement = pickerRef.current
    const container = containerRef.current
    if (!pickerElement || !container) {
      return
    }
    sizeRef.current = { height, width }
    applyPickerSizing(pickerElement, container, height, width)
  }, [height, width])

  return <div ref={containerRef} />
}
