"use client"

import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

type AudioLevelIndicatorProps = {
  stream?: MediaStream | null
  level?: number | null
  label?: string
  className?: string
}

// Safari compatibility: use webkitAudioContext if AudioContext is not available
const getAudioContextClass = (): typeof AudioContext | null => {
  if (typeof window === "undefined") return null
  return window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext || null
}

// Global shared AudioContext to avoid Safari's limit and ensure user gesture activation
let sharedAudioContext: AudioContext | null = null

const getOrCreateAudioContext = (): AudioContext | null => {
  const AudioContextClass = getAudioContextClass()
  if (!AudioContextClass) return null

  if (!sharedAudioContext || sharedAudioContext.state === "closed") {
    sharedAudioContext = new AudioContextClass()
  }
  return sharedAudioContext
}

// Resume audio context - call this on user gesture
export const resumeAudioContext = async (): Promise<void> => {
  const ctx = getOrCreateAudioContext()
  if (ctx && ctx.state === "suspended") {
    await ctx.resume()
  }
}

export function AudioLevelIndicator({ stream, level, label, className }: AudioLevelIndicatorProps) {
  const [measuredLevel, setMeasuredLevel] = useState(0)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const displayLevel =
    typeof level === "number" ? Math.max(0, Math.min(1, level)) : measuredLevel

  useEffect(() => {
    setMeasuredLevel(0)
    if (typeof level === "number") {
      return
    }
    if (!stream) {
      return
    }

    let isActive = true
    let removeTrackListener: (() => void) | null = null

    const teardownAudioNodes = () => {
      if (processorRef.current) {
        processorRef.current.disconnect()
        processorRef.current.onaudioprocess = null
        processorRef.current = null
      }
      if (sourceRef.current) {
        sourceRef.current.disconnect()
        sourceRef.current = null
      }
    }

    const setupWithStream = async (inputStream: MediaStream) => {
      const audioContext = getOrCreateAudioContext()
      if (!audioContext) {
        console.log("[AudioLevel] No AudioContext available")
        return
      }

      // Resume if suspended
      if (audioContext.state === "suspended") {
        console.log("[AudioLevel] Resuming suspended AudioContext")
        try {
          await audioContext.resume()
        } catch (e) {
          console.log("[AudioLevel] Failed to resume:", e)
        }
      }

      console.log("[AudioLevel] AudioContext state:", audioContext.state)

      if (audioContext.state !== "running") {
        console.log("[AudioLevel] AudioContext not running, will retry on user gesture")
        return
      }

      try {
        teardownAudioNodes()

        // Create source from the audio-only stream
        const source = audioContext.createMediaStreamSource(inputStream)
        sourceRef.current = source

        // Use ScriptProcessorNode for Safari compatibility
        // (deprecated but works reliably across browsers including Safari)
        const bufferSize = 2048
        const processor = audioContext.createScriptProcessor(bufferSize, 1, 1)
        processorRef.current = processor

        processor.onaudioprocess = (event) => {
          if (!isActive) return

          const input = event.inputBuffer.getChannelData(0)
          let sum = 0
          for (let i = 0; i < input.length; i++) {
            sum += input[i] * input[i]
          }
          const rms = Math.sqrt(sum / input.length)
          const amplifiedLevel = Math.min(1, rms * 4)
          setMeasuredLevel(amplifiedLevel)
        }

        source.connect(processor)
        // Connect to destination to make it work (but it outputs silence)
        processor.connect(audioContext.destination)

        console.log("[AudioLevel] Setup complete with ScriptProcessor")
      } catch (error) {
        console.error("[AudioLevel] Error setting up:", error)
      }
    }

    const ensureAudioProcessing = () => {
      const audioTracks = stream.getAudioTracks()
      if (audioTracks.length === 0) {
        console.log("[AudioLevel] No audio tracks")
        return false
      }

      const audioOnlyStream = new MediaStream(audioTracks)
      void setupWithStream(audioOnlyStream)
      return true
    }

    if (!ensureAudioProcessing()) {
      const handleAddTrack = () => {
        if (!isActive) return
        if (ensureAudioProcessing()) {
          stream.removeEventListener("addtrack", handleAddTrack)
        }
      }
      stream.addEventListener("addtrack", handleAddTrack)
      removeTrackListener = () => stream.removeEventListener("addtrack", handleAddTrack)
    }

    // Retry setup when AudioContext might be resumed
    const handleClick = () => {
      const ctx = getOrCreateAudioContext()
      if (ctx?.state === "suspended") {
        ctx.resume().then(() => {
          if (isActive) {
            ensureAudioProcessing()
          }
        })
      } else {
        ensureAudioProcessing()
      }
    }
    document.addEventListener("click", handleClick, { once: true })

    return () => {
      isActive = false
      document.removeEventListener("click", handleClick)
      removeTrackListener?.()
      teardownAudioNodes()
    }
  }, [stream, level])

  // Create 5 bars for the indicator
  const bars = [0.1, 0.25, 0.45, 0.65, 0.85]

  return (
    <div className={cn("flex flex-col items-center gap-1", className)}>
      <div className="flex items-end gap-0.5 h-6">
        {bars.map((threshold, index) => (
          <div
            key={index}
            className={cn(
              "w-1 rounded-full transition-all duration-75",
              displayLevel > threshold ? "bg-green-500" : "bg-muted-foreground/30"
            )}
            style={{
              height: `${(index + 1) * 4 + 4}px`,
            }}
          />
        ))}
      </div>
      {label && (
        <span className="text-xs text-muted-foreground">{label}</span>
      )}
    </div>
  )
}
