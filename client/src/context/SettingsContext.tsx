"use client"

import * as React from "react"
import { useAuth } from "@/context/AuthContext"
import { useSync } from "@/context/SyncContext"
import { apiFetch } from "@/lib/api"
import { encryptString, decryptString, type EncryptedPayload } from "@/lib/crypto"
import { db } from "@/lib/db"

export type PrivacyScope = "everybody" | "same_server" | "contacts" | "nobody"
export type MessageAcceptance = "everybody" | "same_server" | "contacts" | "nobody"
export type VisibilityScope = "everybody" | "contacts" | "nobody" // Legacy, kept for backwards compat

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
        setSettings((prev) => ({
          ...prev,
          ...DEFAULT_PRIVACY_SETTINGS,
          ...privacySettings,
        }))
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
            ...privacyUpdates,
          }
          void savePrivacySettings(newPrivacySettings)
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
