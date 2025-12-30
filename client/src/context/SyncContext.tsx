"use client"

import * as React from "react"
import { useSocket } from "./SocketContext"
import { useAuth, type TransportKeyRotationPayload } from "./AuthContext"
import { useBlock } from "./BlockContext"
import { useContacts } from "./ContactsContext"
import {
  SyncManager,
  type SyncEventType,
  type SyncEventMap,
  type SyncEventCallback,
} from "@/sync"
import {
  BlockListSyncHandler,
  ContactsSyncHandler,
  TransportKeySyncHandler,
  SettingsSyncHandler,
  PrivacySettingsSyncHandler,
  SessionSyncHandler,
  PasskeySyncHandler,
  type Settings,
  type PasskeyInfo,
} from "@/sync/handlers"
import type { EncryptedPayload } from "@/lib/crypto"

type SyncContextValue = {
  subscribe: <T extends SyncEventType>(
    eventType: T,
    callback: SyncEventCallback<T>
  ) => () => void
  lastSync: number
  isConnected: boolean
}

const SyncContext = React.createContext<SyncContextValue | undefined>(undefined)

type SyncProviderProps = {
  children: React.ReactNode
  onSettingsUpdated?: (settings: Partial<Settings>) => void
  onPrivacySettingsUpdated?: (encrypted: EncryptedPayload | null) => Promise<void>
  onPasskeyAdded?: (passkey: PasskeyInfo) => void
  onPasskeyRemoved?: (credentialId: string) => void
  onSessionDeleted?: (sessionId: string) => void
}

export function SyncProvider({
  children,
  onSettingsUpdated,
  onPrivacySettingsUpdated,
  onPasskeyAdded,
  onPasskeyRemoved,
  onSessionDeleted,
}: SyncProviderProps) {
  const socket = useSocket()
  const {
    user,
    masterKey,
    transportPrivateKey,
    identityPrivateKey,
    publicIdentityKey,
    logout,
    applyTransportKeyRotation,
  } = useAuth()
  const { isBlocked, applyEncryptedBlockList } = useBlock()
  const { applyEncryptedContacts } = useContacts()
  const [lastSync, setLastSync] = React.useState(0)
  const [isConnected, setIsConnected] = React.useState(false)
  const [handlersReady, setHandlersReady] = React.useState(false)

  const [manager] = React.useState(() => new SyncManager())

  // Stable callbacks for handlers - use refs to avoid recreating manager on callback changes
  const settingsCallbackRef = React.useRef(onSettingsUpdated)
  const privacySettingsCallbackRef = React.useRef(onPrivacySettingsUpdated)
  const passkeyAddedCallbackRef = React.useRef(onPasskeyAdded)
  const passkeyRemovedCallbackRef = React.useRef(onPasskeyRemoved)
  const sessionDeletedCallbackRef = React.useRef(onSessionDeleted)
  const applyBlockListRef = React.useRef(applyEncryptedBlockList)
  const applyContactsRef = React.useRef(applyEncryptedContacts)
  const applyTransportKeyRef = React.useRef(applyTransportKeyRotation)
  const logoutRef = React.useRef(logout)

  React.useEffect(() => {
    settingsCallbackRef.current = onSettingsUpdated
  }, [onSettingsUpdated])

  React.useEffect(() => {
    privacySettingsCallbackRef.current = onPrivacySettingsUpdated
  }, [onPrivacySettingsUpdated])

  React.useEffect(() => {
    passkeyAddedCallbackRef.current = onPasskeyAdded
  }, [onPasskeyAdded])

  React.useEffect(() => {
    passkeyRemovedCallbackRef.current = onPasskeyRemoved
  }, [onPasskeyRemoved])

  React.useEffect(() => {
    sessionDeletedCallbackRef.current = onSessionDeleted
  }, [onSessionDeleted])

  React.useEffect(() => {
    applyBlockListRef.current = applyEncryptedBlockList
  }, [applyEncryptedBlockList])

  React.useEffect(() => {
    applyContactsRef.current = applyEncryptedContacts
  }, [applyEncryptedContacts])

  React.useEffect(() => {
    applyTransportKeyRef.current = applyTransportKeyRotation
  }, [applyTransportKeyRotation])

  React.useEffect(() => {
    logoutRef.current = logout
  }, [logout])

  // Initialize manager once - use refs for callbacks to avoid recreating on callback changes
  React.useEffect(() => {

    // Register BlockList handler
    manager.registerHandler(
      new BlockListSyncHandler(async (encrypted) => {
        await applyBlockListRef.current(encrypted)
      })
    )

    manager.registerHandler(
      new ContactsSyncHandler(async (encrypted) => {
        await applyContactsRef.current(encrypted)
      })
    )

    // Register TransportKey handler
    manager.registerHandler(
      new TransportKeySyncHandler(async (payload: TransportKeyRotationPayload) => {
        await applyTransportKeyRef.current(payload)
      })
    )

    // Register Settings handler
    manager.registerHandler(
      new SettingsSyncHandler((settings) => {
        settingsCallbackRef.current?.(settings)
      })
    )

    // Register Privacy Settings handler
    manager.registerHandler(
      new PrivacySettingsSyncHandler(async (encrypted) => {
        await privacySettingsCallbackRef.current?.(encrypted)
      })
    )

    // Register Session handler
    const sessionHandler = new SessionSyncHandler(
      () => {
        // Session invalidated - logout
        void logoutRef.current()
      },
      (sessionId) => {
        // Session deleted from another device - notify UI
        sessionDeletedCallbackRef.current?.(sessionId)
      }
    )
    manager.registerHandler(sessionHandler)

    // Register Passkey handler
    manager.registerHandler(
      new PasskeySyncHandler(
        (passkey) => {
          passkeyAddedCallbackRef.current?.(passkey)
        },
        (credentialId) => {
          passkeyRemovedCallbackRef.current?.(credentialId)
        }
      )
    )

    setHandlersReady(true)

    return () => {
      manager.destroy()
    }
  }, [manager]) // Uses refs for latest callbacks

  // Update context when auth changes
  React.useEffect(() => {
    manager.updateContext({
      userId: user?.id ?? null,
      userHandle: user?.handle ?? null,
      masterKey,
      transportPrivateKey,
      identityPrivateKey,
      publicIdentityKey,
      isBlocked,
    })
  }, [
    user?.id,
    user?.handle,
    masterKey,
    transportPrivateKey,
    identityPrivateKey,
    publicIdentityKey,
    isBlocked,
  ])

  // Connect/disconnect socket
  React.useEffect(() => {
    if (!handlersReady) {
      return
    }
    if (socket) {
      manager.connect(socket)
      setIsConnected(true)
    } else {
      manager.disconnect()
      setIsConnected(false)
    }
  }, [socket, manager, handlersReady])

  const subscribe = React.useCallback(
    <T extends SyncEventType>(
      eventType: T,
      callback: SyncEventCallback<T>
    ): (() => void) => {
      return manager.subscribe(eventType, callback)
    },
    [manager]
  )

  const bumpLastSync = React.useCallback(() => {
    setLastSync((prev) => {
      const now = Date.now()
      return now > prev ? now : prev + 1
    })
  }, [])

  // Subscribe to all message events to bump lastSync
  React.useEffect(() => {
    const unsubscribers = [
      manager.subscribe("INCOMING_MESSAGE", () => bumpLastSync()),
      manager.subscribe("OUTGOING_MESSAGE_SYNCED", () => bumpLastSync()),
      manager.subscribe("INCOMING_MESSAGE_SYNCED", () => bumpLastSync()),
      manager.subscribe("VAULT_MESSAGE_UPDATED", () => bumpLastSync()),
      manager.subscribe("BLOCK_LIST_UPDATED", () => bumpLastSync()),
      manager.subscribe("SETTINGS_UPDATED", () => bumpLastSync()),
      manager.subscribe("PRIVACY_SETTINGS_UPDATED", () => bumpLastSync()),
    ]

    return () => {
      unsubscribers.forEach((unsub) => unsub())
    }
  }, [bumpLastSync])

  const value = React.useMemo(
    (): SyncContextValue => ({
      subscribe,
      lastSync,
      isConnected,
    }),
    [subscribe, lastSync, isConnected]
  )

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>
}

// Fallback value for when useSync is called outside SyncProvider (e.g., during SSR)
const fallbackSyncValue: SyncContextValue = {
  subscribe: () => () => {},
  lastSync: 0,
  isConnected: false,
}

export function useSync(): SyncContextValue {
  const context = React.useContext(SyncContext)
  // Return fallback during SSR or when outside provider
  return context ?? fallbackSyncValue
}

// Hook to get the SyncManager instance directly (for registering message handlers)
export function useSyncManager(): SyncManager | null {
  const [manager, setManager] = React.useState<SyncManager | null>(null)

  React.useEffect(() => {
    // This is a bit of a hack - we need to access the manager from the context
    // In practice, the manager is created in SyncProvider and we need to expose it
    // For now, we'll return null and handle message handlers differently
    setManager(null)
  }, [])

  return manager
}
