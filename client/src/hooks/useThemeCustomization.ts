"use client"

import * as React from "react"
import { useTheme } from "next-themes"
import { useSettings } from "@/hooks/useSettings"
import { getThemePreset, DEFAULT_CUSTOMIZATION, type CustomizationSettings, type ThemePreset } from "@/context/SettingsContext"

export type ResolvedTheme = {
  preset: ThemePreset
  outgoingBubble: string
  outgoingText: string
  incomingBubble: string
  incomingText: string
  accent: string
  chatBackground: CustomizationSettings["chatBackground"]
  compactMode: boolean
  oledMode: boolean
}

// Convert hex to RGB for color mixing
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null
}

// Lighten a color
function lightenColor(hex: string, amount: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const r = Math.min(255, Math.round(rgb.r + (255 - rgb.r) * amount))
  const g = Math.min(255, Math.round(rgb.g + (255 - rgb.g) * amount))
  const b = Math.min(255, Math.round(rgb.b + (255 - rgb.b) * amount))
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`
}

// Darken a color
function darkenColor(hex: string, amount: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const r = Math.max(0, Math.round(rgb.r * (1 - amount)))
  const g = Math.max(0, Math.round(rgb.g * (1 - amount)))
  const b = Math.max(0, Math.round(rgb.b * (1 - amount)))
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`
}

export function useThemeCustomization(): ResolvedTheme {
  const { settings } = useSettings()
  const { resolvedTheme } = useTheme()
  const customization = settings.customization ?? DEFAULT_CUSTOMIZATION
  const preset = getThemePreset(customization.themeId)
  const isDark = resolvedTheme === "dark"
  const oledMode = customization.oledMode && isDark

  // Apply CSS variables
  React.useEffect(() => {
    const root = document.documentElement
    const colors = isDark ? preset.dark : preset.light
    const accent = preset.accent
    const rgb = hexToRgb(accent)

    root.style.setProperty("--theme-accent", accent)
    root.style.setProperty("--theme-accent-light", lightenColor(accent, 0.85))
    root.style.setProperty("--theme-accent-dark", darkenColor(accent, 0.6))
    root.style.setProperty("--bubble-outgoing", colors.outgoingBubble)
    root.style.setProperty("--bubble-outgoing-text", colors.outgoingText)
    root.style.setProperty("--bubble-incoming", colors.incomingBubble)
    root.style.setProperty("--bubble-incoming-text", colors.incomingText)

    // Set glow and grid colors based on accent
    if (isDark) {
      root.style.setProperty("--chat-glow", darkenColor(accent, 0.6))
      root.style.setProperty("--chat-grid", rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08)` : accent)

      // Active state colors (Sidebar)
      root.style.setProperty("--theme-accent-active-bg", darkenColor(accent, 0.6)) // Same as glow for dark
      root.style.setProperty("--theme-accent-active-text", lightenColor(accent, 0.8))
    } else {
      root.style.setProperty("--chat-glow", lightenColor(accent, 0.85))
      root.style.setProperty("--chat-grid", rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)` : accent)

      // Active state colors (Sidebar)
      root.style.setProperty("--theme-accent-active-bg", lightenColor(accent, 0.9))
      root.style.setProperty("--theme-accent-active-text", darkenColor(accent, 0.6))
    }

    // OLED mode - add class to enable pitch black backgrounds
    if (oledMode) {
      root.classList.add("oled")
    } else {
      root.classList.remove("oled")
    }

    return () => {
      root.style.removeProperty("--theme-accent")
      root.style.removeProperty("--theme-accent-light")
      root.style.removeProperty("--theme-accent-dark")
      root.style.removeProperty("--bubble-outgoing")
      root.style.removeProperty("--bubble-outgoing-text")
      root.style.removeProperty("--bubble-incoming")
      root.style.removeProperty("--bubble-incoming-text")
      root.style.removeProperty("--chat-glow")
      root.style.removeProperty("--chat-grid")
      root.style.removeProperty("--theme-accent-active-bg")
      root.style.removeProperty("--theme-accent-active-text")
      root.classList.remove("oled")
    }
  }, [preset, isDark, oledMode])

  const colors = isDark ? preset.dark : preset.light

  return {
    preset,
    outgoingBubble: colors.outgoingBubble,
    outgoingText: colors.outgoingText,
    incomingBubble: colors.incomingBubble,
    incomingText: colors.incomingText,
    accent: preset.accent,
    chatBackground: customization.chatBackground,
    compactMode: customization.compactMode,
    oledMode,
  }
}
