"use client"

import * as React from "react"
import { useAuth } from "@/context/AuthContext"
import { apiFetch } from "@/lib/api"

type Settings = {
  showTypingIndicator: boolean
  sendReadReceipts: boolean
}

const DEFAULT_SETTINGS: Settings = {
  showTypingIndicator: true,
  sendReadReceipts: true,
}

type SettingsContextValue = {
  settings: Settings
  updateSettings: (updates: Partial<Settings>) => void
}

const SettingsContext = React.createContext<SettingsContextValue | undefined>(undefined)

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const [settings, setSettings] = React.useState<Settings>(DEFAULT_SETTINGS)

  // Load from local storage immediately for UI responsiveness
  React.useEffect(() => {
    if (!user?.id) {
      setSettings(DEFAULT_SETTINGS)
      return
    }
    const key = `ratchet_settings_${user.id}`
    const stored = localStorage.getItem(key)
    if (stored) {
      try {
        setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(stored) })
      } catch {
        // ignore
      }
    } else {
        setSettings(DEFAULT_SETTINGS)
    }
  }, [user?.id])

  // Sync with server on mount/auth change
  React.useEffect(() => {
    if (!user?.id) return
    let active = true
    apiFetch<Partial<Settings>>("/auth/settings")
      .then((remote) => {
        if (active && remote) {
          setSettings((prev) => {
            const next = { ...prev, ...remote }
            localStorage.setItem(`ratchet_settings_${user?.id}`, JSON.stringify(next))
            return next
          })
        }
      })
      .catch(() => {
        // Ignore fetch errors, fallback to local
      })
    return () => {
      active = false
    }
  }, [user?.id])

  const updateSettings = React.useCallback(
    async (updates: Partial<Settings>) => {
      if (!user?.id) return
      
      // Optimistic update
      setSettings((prev) => {
        const next = { ...prev, ...updates }
        localStorage.setItem(`ratchet_settings_${user.id}`, JSON.stringify(next))
        return next
      })

      // Sync to server
      try {
        await apiFetch("/auth/settings", {
          method: "PATCH",
          body: updates,
        })
      } catch (error) {
        console.error("Failed to sync settings", error)
      }
    },
    [user?.id]
  )

  const value = React.useMemo(() => ({ settings, updateSettings }), [settings, updateSettings])

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings() {
  const context = React.useContext(SettingsContext)
  if (!context) {
    throw new Error("useSettings must be used within a SettingsProvider")
  }
  return context
}
