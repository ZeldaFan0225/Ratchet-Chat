"use client"

import * as React from "react"
import { useAuth } from "@/context/AuthContext"
import { useSync } from "@/context/SyncContext"
import { apiFetch } from "@/lib/api"
import { encryptString, decryptString, type EncryptedPayload } from "@/lib/crypto"
import { db } from "@/lib/db"
import { storeNotificationSettings, type NotificationSettings } from "@/lib/push"

export type PrivacyScope = "everybody" | "same_server" | "contacts" | "nobody"
export type MessageAcceptance = "everybody" | "same_server" | "contacts" | "nobody"
export type VisibilityScope = "everybody" | "contacts" | "nobody" // Legacy, kept for backwards compat

// Customization types
export type ChatBackground = "none" | "dots" | "grid" | "waves"

export type ThemePreset = {
  id: string
  name: string
  accent: string // main accent color for UI
  light: {
    outgoingBubble: string
    outgoingText: string
    incomingBubble: string
    incomingText: string
  }
  dark: {
    outgoingBubble: string
    outgoingText: string
    incomingBubble: string
    incomingText: string
  }
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: "default",
    name: "Default",
    accent: "#10b981",
    light: { outgoingBubble: "#10b981", outgoingText: "#ffffff", incomingBubble: "#f1f5f9", incomingText: "#1e293b" },
    dark: { outgoingBubble: "#059669", outgoingText: "#ffffff", incomingBubble: "#334155", incomingText: "#f1f5f9" },
  },
  {
    id: "classic",
    name: "Classic",
    accent: "#10b981",
    light: { outgoingBubble: "#d1fae5", outgoingText: "#065f46", incomingBubble: "#ffffff", incomingText: "#1e293b" },
    dark: { outgoingBubble: "#064e3b", outgoingText: "#a7f3d0", incomingBubble: "#1e293b", incomingText: "#e2e8f0" },
  },
  {
    id: "forest",
    name: "Forest",
    accent: "#22c55e",
    light: { outgoingBubble: "#22c55e", outgoingText: "#ffffff", incomingBubble: "#f0fdf4", incomingText: "#166534" },
    dark: { outgoingBubble: "#16a34a", outgoingText: "#ffffff", incomingBubble: "#1e3a2f", incomingText: "#bbf7d0" },
  },
  {
    id: "ocean",
    name: "Ocean",
    accent: "#3b82f6",
    light: { outgoingBubble: "#3b82f6", outgoingText: "#ffffff", incomingBubble: "#eff6ff", incomingText: "#1e40af" },
    dark: { outgoingBubble: "#2563eb", outgoingText: "#ffffff", incomingBubble: "#1e3a5f", incomingText: "#bfdbfe" },
  },
  {
    id: "indigo",
    name: "Indigo",
    accent: "#6366f1",
    light: { outgoingBubble: "#6366f1", outgoingText: "#ffffff", incomingBubble: "#eef2ff", incomingText: "#3730a3" },
    dark: { outgoingBubble: "#4f46e5", outgoingText: "#ffffff", incomingBubble: "#1e1b4b", incomingText: "#c7d2fe" },
  },
  {
    id: "lavender",
    name: "Lavender",
    accent: "#8b5cf6",
    light: { outgoingBubble: "#8b5cf6", outgoingText: "#ffffff", incomingBubble: "#f5f3ff", incomingText: "#5b21b6" },
    dark: { outgoingBubble: "#7c3aed", outgoingText: "#ffffff", incomingBubble: "#2e1f5e", incomingText: "#ddd6fe" },
  },
  {
    id: "grape",
    name: "Grape",
    accent: "#a855f7",
    light: { outgoingBubble: "#a855f7", outgoingText: "#ffffff", incomingBubble: "#faf5ff", incomingText: "#7e22ce" },
    dark: { outgoingBubble: "#9333ea", outgoingText: "#ffffff", incomingBubble: "#3b1f5e", incomingText: "#e9d5ff" },
  },
  {
    id: "fuchsia",
    name: "Fuchsia",
    accent: "#d946ef",
    light: { outgoingBubble: "#d946ef", outgoingText: "#ffffff", incomingBubble: "#fdf4ff", incomingText: "#a21caf" },
    dark: { outgoingBubble: "#c026d3", outgoingText: "#ffffff", incomingBubble: "#4a044e", incomingText: "#f5d0fe" },
  },
  {
    id: "rose",
    name: "Rose",
    accent: "#f43f5e",
    light: { outgoingBubble: "#f43f5e", outgoingText: "#ffffff", incomingBubble: "#fff1f2", incomingText: "#be123c" },
    dark: { outgoingBubble: "#e11d48", outgoingText: "#ffffff", incomingBubble: "#4c1d2d", incomingText: "#fecdd3" },
  },
  {
    id: "coral",
    name: "Coral",
    accent: "#fb7185",
    light: { outgoingBubble: "#f43f5e", outgoingText: "#ffffff", incomingBubble: "#fff5f6", incomingText: "#9f1239" },
    dark: { outgoingBubble: "#e11d48", outgoingText: "#ffffff", incomingBubble: "#4a1d2e", incomingText: "#fda4af" },
  },
  {
    id: "sunset",
    name: "Sunset",
    accent: "#f97316",
    light: { outgoingBubble: "#f97316", outgoingText: "#ffffff", incomingBubble: "#fff7ed", incomingText: "#c2410c" },
    dark: { outgoingBubble: "#ea580c", outgoingText: "#ffffff", incomingBubble: "#431d0d", incomingText: "#fed7aa" },
  },
  {
    id: "gold",
    name: "Gold",
    accent: "#eab308",
    light: { outgoingBubble: "#eab308", outgoingText: "#422006", incomingBubble: "#fefce8", incomingText: "#854d0e" },
    dark: { outgoingBubble: "#a16207", outgoingText: "#fef9c3", incomingBubble: "#3d2f0a", incomingText: "#fef08a" },
  },
  {
    id: "teal",
    name: "Teal",
    accent: "#14b8a6",
    light: { outgoingBubble: "#14b8a6", outgoingText: "#ffffff", incomingBubble: "#f0fdfa", incomingText: "#0f766e" },
    dark: { outgoingBubble: "#0d9488", outgoingText: "#ffffff", incomingBubble: "#134e4a", incomingText: "#99f6e4" },
  },
  {
    id: "sky",
    name: "Sky",
    accent: "#0ea5e9",
    light: { outgoingBubble: "#0ea5e9", outgoingText: "#ffffff", incomingBubble: "#f0f9ff", incomingText: "#0369a1" },
    dark: { outgoingBubble: "#0284c7", outgoingText: "#ffffff", incomingBubble: "#0c3d5e", incomingText: "#bae6fd" },
  },
  {
    id: "slate",
    name: "Slate",
    accent: "#64748b",
    light: { outgoingBubble: "#64748b", outgoingText: "#ffffff", incomingBubble: "#f8fafc", incomingText: "#334155" },
    dark: { outgoingBubble: "#475569", outgoingText: "#ffffff", incomingBubble: "#1e293b", incomingText: "#cbd5e1" },
  },
  {
    id: "midnight",
    name: "Midnight",
    accent: "#1e293b",
    light: { outgoingBubble: "#1e293b", outgoingText: "#f8fafc", incomingBubble: "#f1f5f9", incomingText: "#0f172a" },
    dark: { outgoingBubble: "#0f172a", outgoingText: "#e2e8f0", incomingBubble: "#334155", incomingText: "#f1f5f9" },
  },
]

export type CustomizationSettings = {
  themeId: string
  chatBackground: ChatBackground
  compactMode: boolean
  oledMode: boolean
}

export const DEFAULT_CUSTOMIZATION: CustomizationSettings = {
  themeId: "default",
  chatBackground: "grid",
  compactMode: false,
  oledMode: false,
}

export function getThemePreset(id: string): ThemePreset {
  return THEME_PRESETS.find((t) => t.id === id) ?? THEME_PRESETS[0]
}

// Legacy settings stored unencrypted on server (backwards compatible)
type LegacySettings = {
  showTypingIndicator: boolean
  sendReadReceipts: boolean
  displayName: string | null
  displayNameVisibility: "public" | "hidden"
}

type AvatarSettings = {
  avatarFilename: string | null
  avatarVisibility: "public" | "hidden"
}

// Privacy settings stored encrypted (server cannot see them)
type PrivacySettings = {
  messageAcceptance: MessageAcceptance
  enableMessageRequests: boolean
  typingIndicatorScope: PrivacyScope
  sendReadReceiptsTo: PrivacyScope
  avatarFilename?: string | null
  avatarVisibility?: "public" | "hidden"
  enableLinkPreviews: boolean
  // Push notification settings
  pushNotificationsEnabled: boolean
  pushShowContent: boolean
  pushShowSenderName: boolean
  // Customization settings
  customization: CustomizationSettings
}

// Combined settings type
export type Settings = LegacySettings & PrivacySettings & AvatarSettings

const DEFAULT_LEGACY_SETTINGS: LegacySettings = {
  showTypingIndicator: true,
  sendReadReceipts: true,
  displayName: null,
  displayNameVisibility: "public",
}

const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  messageAcceptance: "everybody",
  enableMessageRequests: false,
  typingIndicatorScope: "everybody",
  sendReadReceiptsTo: "everybody",
  enableLinkPreviews: true,
  pushNotificationsEnabled: true,
  pushShowContent: true,
  pushShowSenderName: true,
  customization: DEFAULT_CUSTOMIZATION,
}

const DEFAULT_AVATAR_SETTINGS: AvatarSettings = {
  avatarFilename: null,
  avatarVisibility: "public",
}

const DEFAULT_SETTINGS: Settings = {
  ...DEFAULT_LEGACY_SETTINGS,
  ...DEFAULT_PRIVACY_SETTINGS,
  ...DEFAULT_AVATAR_SETTINGS,
}

const PRIVACY_SETTINGS_KEY = "encryptedPrivacySettings"

type SettingsContextValue = {
  settings: Settings
  isLoading: boolean
  updateSettings: (updates: Partial<Settings>) => Promise<void>
  applyRemoteSettings: (updates: Partial<LegacySettings>) => void
  applyEncryptedPrivacySettings: (encrypted: EncryptedPayload | null) => Promise<void>
}

const SettingsContext = React.createContext<SettingsContextValue | undefined>(undefined)

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const { user, masterKey, status } = useAuth()
  const { subscribe } = useSync()
  const [settings, setSettings] = React.useState<Settings>(DEFAULT_SETTINGS)
  const [isLoading, setIsLoading] = React.useState(true)

  // Apply encrypted privacy settings from server or cache
  const applyEncryptedPrivacySettings = React.useCallback(
    async (encrypted: EncryptedPayload | null) => {
      if (!encrypted) {
        setSettings((prev) => ({ ...prev, ...DEFAULT_PRIVACY_SETTINGS }))
        await db.syncState.delete(PRIVACY_SETTINGS_KEY)
        return
      }

      // Store locally for offline access
      await db.syncState.put({ key: PRIVACY_SETTINGS_KEY, value: encrypted })

      if (!masterKey) {
        return
      }

      try {
        const decrypted = await decryptString(masterKey, encrypted)
        const raw = JSON.parse(decrypted) as Partial<Record<string, unknown>>
        const privacySettings: Partial<PrivacySettings> = {}

        if (
          raw.messageAcceptance === "everybody" ||
          raw.messageAcceptance === "same_server" ||
          raw.messageAcceptance === "contacts" ||
          raw.messageAcceptance === "nobody"
        ) {
          privacySettings.messageAcceptance = raw.messageAcceptance
        } else if (raw.messageAcceptance === "none") {
          // Migrate legacy "none" to "nobody"
          privacySettings.messageAcceptance = "nobody"
        }
        if (typeof raw.enableMessageRequests === "boolean") {
          privacySettings.enableMessageRequests = raw.enableMessageRequests
        }
        // Handle new typingIndicatorScope or migrate from legacy showTypingToContactsOnly
        if (
          raw.typingIndicatorScope === "everybody" ||
          raw.typingIndicatorScope === "same_server" ||
          raw.typingIndicatorScope === "contacts" ||
          raw.typingIndicatorScope === "nobody"
        ) {
          privacySettings.typingIndicatorScope = raw.typingIndicatorScope
        } else if (typeof raw.showTypingToContactsOnly === "boolean") {
          // Migrate legacy boolean to new scope
          privacySettings.typingIndicatorScope = raw.showTypingToContactsOnly ? "contacts" : "everybody"
        }
        if (
          raw.sendReadReceiptsTo === "everybody" ||
          raw.sendReadReceiptsTo === "same_server" ||
          raw.sendReadReceiptsTo === "contacts" ||
          raw.sendReadReceiptsTo === "nobody"
        ) {
          privacySettings.sendReadReceiptsTo = raw.sendReadReceiptsTo
        }
        if (typeof raw.avatarFilename === "string" || raw.avatarFilename === null) {
          privacySettings.avatarFilename = raw.avatarFilename
        }
        if (raw.avatarVisibility === "public" || raw.avatarVisibility === "hidden") {
          privacySettings.avatarVisibility = raw.avatarVisibility
        }
        if (typeof raw.enableLinkPreviews === "boolean") {
          privacySettings.enableLinkPreviews = raw.enableLinkPreviews
        }
        // Push notification settings
        if (typeof raw.pushNotificationsEnabled === "boolean") {
          privacySettings.pushNotificationsEnabled = raw.pushNotificationsEnabled
        }
        if (typeof raw.pushShowContent === "boolean") {
          privacySettings.pushShowContent = raw.pushShowContent
        }
        if (typeof raw.pushShowSenderName === "boolean") {
          privacySettings.pushShowSenderName = raw.pushShowSenderName
        }
        // Customization settings
        if (raw.customization && typeof raw.customization === "object") {
          const customRaw = raw.customization as Partial<Record<string, unknown>>
          const customization: Partial<CustomizationSettings> = {}
          if (typeof customRaw.themeId === "string") {
            // Validate theme exists
            if (THEME_PRESETS.some((t) => t.id === customRaw.themeId)) {
              customization.themeId = customRaw.themeId
            }
          }
          if (
            customRaw.chatBackground === "none" ||
            customRaw.chatBackground === "dots" ||
            customRaw.chatBackground === "grid" ||
            customRaw.chatBackground === "waves"
          ) {
            customization.chatBackground = customRaw.chatBackground
          }
          if (typeof customRaw.compactMode === "boolean") {
            customization.compactMode = customRaw.compactMode
          }
          if (typeof customRaw.oledMode === "boolean") {
            customization.oledMode = customRaw.oledMode
          }
          privacySettings.customization = {
            ...DEFAULT_CUSTOMIZATION,
            ...customization,
          }
        }

        const finalSettings = {
          ...DEFAULT_PRIVACY_SETTINGS,
          ...privacySettings,
        }
        setSettings((prev) => ({
          ...prev,
          ...finalSettings,
        }))

        // Sync notification settings to IndexedDB for service worker
        void storeNotificationSettings({
          pushNotificationsEnabled: finalSettings.pushNotificationsEnabled,
          pushShowContent: finalSettings.pushShowContent,
          pushShowSenderName: finalSettings.pushShowSenderName,
        })
      } catch (error) {
        console.error("Failed to decrypt privacy settings:", error)
      }
    },
    [masterKey]
  )

  const savePrivacySettings = React.useCallback(
    async (privacySettings: PrivacySettings) => {
      if (!masterKey) return

      const encrypted = await encryptString(masterKey, JSON.stringify(privacySettings))

      // Save to local cache
      await db.syncState.put({ key: PRIVACY_SETTINGS_KEY, value: encrypted })

      // Sync to server (fire and forget)
      apiFetch("/auth/privacy-settings", {
        method: "PUT",
        body: encrypted,
      }).catch((error) => {
        console.error("Failed to sync privacy settings to server:", error)
      })
    },
    [masterKey]
  )

  // Listen for sync events
  React.useEffect(() => {
    const unsubSettings = subscribe("SETTINGS_UPDATED", (data: Partial<LegacySettings>) => {
      setSettings((prev) => ({ ...prev, ...data }))
    })
    return () => {
      unsubSettings()
    }
  }, [subscribe])

  // Load settings on auth change
  React.useEffect(() => {
    if (status !== "authenticated" || !user?.id) {
      setSettings(DEFAULT_SETTINGS)
      setIsLoading(false)
      return
    }

    let active = true
    setIsLoading(true)

    async function loadSettings() {
      try {
        // Load legacy settings from server (unencrypted)
        const legacyRemote = await apiFetch<Partial<LegacySettings & AvatarSettings>>(
          "/auth/settings"
        ).catch(
          () => null
        )

        const legacyUpdates: Partial<Settings> = {}
        const legacyAvatar: Partial<AvatarSettings> = {}

        if (legacyRemote) {
          if (typeof legacyRemote.showTypingIndicator === "boolean") {
            legacyUpdates.showTypingIndicator = legacyRemote.showTypingIndicator
          }
          if (typeof legacyRemote.sendReadReceipts === "boolean") {
            legacyUpdates.sendReadReceipts = legacyRemote.sendReadReceipts
          }
          if (typeof legacyRemote.displayName === "string" || legacyRemote.displayName === null) {
            const trimmed = legacyRemote.displayName?.trim() ?? ""
            legacyUpdates.displayName = trimmed.length > 0 ? trimmed : null
          }
          if (
            legacyRemote.displayNameVisibility === "public" ||
            legacyRemote.displayNameVisibility === "hidden"
          ) {
            legacyUpdates.displayNameVisibility = legacyRemote.displayNameVisibility
          }
          if (typeof legacyRemote.avatarFilename === "string" || legacyRemote.avatarFilename === null) {
            legacyUpdates.avatarFilename = legacyRemote.avatarFilename
            legacyAvatar.avatarFilename = legacyRemote.avatarFilename
          }
          if (
            legacyRemote.avatarVisibility === "public" ||
            legacyRemote.avatarVisibility === "hidden"
          ) {
            legacyUpdates.avatarVisibility = legacyRemote.avatarVisibility
            legacyAvatar.avatarVisibility = legacyRemote.avatarVisibility
          }
        }

        // Load encrypted privacy settings
        let encrypted: EncryptedPayload | null = null

        // Try server first
        const serverData = await apiFetch<{ ciphertext: string | null; iv: string | null }>(
          "/auth/privacy-settings"
        ).catch(() => null)

        if (serverData?.ciphertext && serverData?.iv) {
          encrypted = { ciphertext: serverData.ciphertext, iv: serverData.iv }
        } else {
          // Fall back to local cache
          const record = await db.syncState.get(PRIVACY_SETTINGS_KEY)
          if (record?.value) {
            encrypted = record.value as EncryptedPayload
          }
        }

        if (encrypted && masterKey) {
          try {
            const decrypted = await decryptString(masterKey, encrypted)
            const raw = JSON.parse(decrypted) as Partial<Record<string, unknown>>
            const migrationUpdates: Partial<LegacySettings> = {}

            if (typeof raw.displayName === "string") {
              const trimmed = raw.displayName.trim()
              migrationUpdates.displayName = trimmed.length > 0 ? trimmed : null
            }
            if (raw.displayName === null) {
              migrationUpdates.displayName = null
            }
            if (
              raw.displayNameVisibility === "public" ||
              raw.displayNameVisibility === "hidden"
            ) {
              migrationUpdates.displayNameVisibility = raw.displayNameVisibility
            }

            const patchUpdates: Partial<LegacySettings> = {}
            if (
              migrationUpdates.displayName !== undefined &&
              legacyUpdates.displayName === undefined
            ) {
              legacyUpdates.displayName = migrationUpdates.displayName
              patchUpdates.displayName = migrationUpdates.displayName
            }
            if (
              migrationUpdates.displayNameVisibility !== undefined &&
              legacyUpdates.displayNameVisibility === undefined
            ) {
              legacyUpdates.displayNameVisibility = migrationUpdates.displayNameVisibility
              patchUpdates.displayNameVisibility = migrationUpdates.displayNameVisibility
            }

            if (Object.keys(patchUpdates).length > 0) {
              apiFetch("/auth/settings", {
                method: "PATCH",
                body: patchUpdates,
              }).catch((error) => {
                console.error("Failed to migrate display name:", error)
              })
            }
          } catch (error) {
            console.error("Failed to read privacy settings for migration:", error)
          }
        }

        if (active) {
          if (Object.keys(legacyUpdates).length > 0) {
            setSettings((prev) => ({ ...prev, ...legacyUpdates }))
          }
          await applyEncryptedPrivacySettings(encrypted)

          if (!encrypted && masterKey) {
            const seededPrivacySettings: PrivacySettings = {
              ...DEFAULT_PRIVACY_SETTINGS,
              avatarFilename:
                legacyAvatar.avatarFilename ?? DEFAULT_AVATAR_SETTINGS.avatarFilename,
              avatarVisibility:
                legacyAvatar.avatarVisibility ?? DEFAULT_AVATAR_SETTINGS.avatarVisibility,
            }
            void savePrivacySettings(seededPrivacySettings)
          }
        }
      } catch (error) {
        console.error("Failed to load settings:", error)
      } finally {
        if (active) {
          setIsLoading(false)
        }
      }
    }

    void loadSettings()
    return () => {
      active = false
    }
  }, [status, user?.id, masterKey, applyEncryptedPrivacySettings, savePrivacySettings])

  const updateSettings = React.useCallback(
    async (updates: Partial<Settings>) => {
      if (!user?.id) return

      // Separate legacy and privacy updates
      const legacyUpdates: Partial<LegacySettings> = {}
      const privacyUpdates: Partial<PrivacySettings> = {}

      if ("sendReadReceipts" in updates) {
        legacyUpdates.sendReadReceipts = updates.sendReadReceipts
      }
      if ("avatarFilename" in updates) {
        privacyUpdates.avatarFilename = updates.avatarFilename
      }
      if ("avatarVisibility" in updates) {
        privacyUpdates.avatarVisibility = updates.avatarVisibility
      }
      if ("displayName" in updates) {
        legacyUpdates.displayName = updates.displayName
      }
      if ("displayNameVisibility" in updates) {
        legacyUpdates.displayNameVisibility = updates.displayNameVisibility
      }
      if ("showTypingIndicator" in updates) {
        legacyUpdates.showTypingIndicator = updates.showTypingIndicator
      }
      if ("messageAcceptance" in updates) {
        privacyUpdates.messageAcceptance = updates.messageAcceptance
      }
      if ("enableMessageRequests" in updates) {
        privacyUpdates.enableMessageRequests = updates.enableMessageRequests
      }
      if ("typingIndicatorScope" in updates) {
        privacyUpdates.typingIndicatorScope = updates.typingIndicatorScope
      }
      if ("sendReadReceiptsTo" in updates) {
        privacyUpdates.sendReadReceiptsTo = updates.sendReadReceiptsTo
      }
      if ("enableLinkPreviews" in updates) {
        privacyUpdates.enableLinkPreviews = updates.enableLinkPreviews
      }
      if ("pushNotificationsEnabled" in updates) {
        privacyUpdates.pushNotificationsEnabled = updates.pushNotificationsEnabled
      }
      if ("pushShowContent" in updates) {
        privacyUpdates.pushShowContent = updates.pushShowContent
      }
      if ("pushShowSenderName" in updates) {
        privacyUpdates.pushShowSenderName = updates.pushShowSenderName
      }
      if ("customization" in updates) {
        privacyUpdates.customization = updates.customization
      }

      // Optimistic update
      setSettings((prev) => ({ ...prev, ...updates }))

      // Sync legacy settings to server (unencrypted)
      if (Object.keys(legacyUpdates).length > 0) {
        try {
          await apiFetch("/auth/settings", {
            method: "PATCH",
            body: legacyUpdates,
          })
        } catch (error) {
          console.error("Failed to sync legacy settings:", error)
        }
      }

      // Sync privacy settings to server (encrypted)
      if (Object.keys(privacyUpdates).length > 0) {
        setSettings((prev) => {
          const newPrivacySettings: PrivacySettings = {
            messageAcceptance: prev.messageAcceptance,
            enableMessageRequests: prev.enableMessageRequests,
            typingIndicatorScope: prev.typingIndicatorScope,
            sendReadReceiptsTo: prev.sendReadReceiptsTo,
            avatarFilename: prev.avatarFilename ?? DEFAULT_AVATAR_SETTINGS.avatarFilename,
            avatarVisibility: prev.avatarVisibility ?? DEFAULT_AVATAR_SETTINGS.avatarVisibility,
            enableLinkPreviews: prev.enableLinkPreviews,
            pushNotificationsEnabled: prev.pushNotificationsEnabled,
            pushShowContent: prev.pushShowContent,
            pushShowSenderName: prev.pushShowSenderName,
            customization: prev.customization ?? DEFAULT_CUSTOMIZATION,
            ...privacyUpdates,
          }
          void savePrivacySettings(newPrivacySettings)

          // Sync notification settings to IndexedDB for service worker
          void storeNotificationSettings({
            pushNotificationsEnabled: newPrivacySettings.pushNotificationsEnabled,
            pushShowContent: newPrivacySettings.pushShowContent,
            pushShowSenderName: newPrivacySettings.pushShowSenderName,
          })

          return prev
        })
      }
    },
    [user?.id, savePrivacySettings]
  )

  // Apply legacy settings from remote sync (SETTINGS_UPDATED event)
  const applyRemoteSettings = React.useCallback((updates: Partial<LegacySettings>) => {
    setSettings((prev) => ({ ...prev, ...updates }))
  }, [])

  const value = React.useMemo(
    (): SettingsContextValue => ({
      settings,
      isLoading,
      updateSettings,
      applyRemoteSettings,
      applyEncryptedPrivacySettings,
    }),
    [settings, isLoading, updateSettings, applyRemoteSettings, applyEncryptedPrivacySettings]
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings() {
  const context = React.useContext(SettingsContext)
  if (!context) {
    throw new Error("useSettings must be used within a SettingsProvider")
  }
  return context
}
