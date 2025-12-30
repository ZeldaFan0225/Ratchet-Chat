// ============================================
// Sync Event Type Registry
// ============================================

import type { Socket } from "socket.io-client"

// Base event structure all sync events must follow
export interface BaseSyncEvent {
  type: string
  timestamp?: string
  originSessionId?: string // To detect self-originated events
}

// ---- Message Events ----

export interface IncomingMessageEvent extends BaseSyncEvent {
  type: "INCOMING_MESSAGE"
  id: string
  message_id?: string
  recipient_id: string
  sender_handle: string
  encrypted_blob: string
  created_at: string
}

export interface OutgoingMessageSyncedEvent extends BaseSyncEvent {
  type: "OUTGOING_MESSAGE_SYNCED"
  message_id: string
  owner_id: string
  original_sender_handle: string
  encrypted_blob: string
  iv: string
  sender_signature_verified: boolean
  created_at: string
}

export interface IncomingMessageSyncedEvent extends BaseSyncEvent {
  type: "INCOMING_MESSAGE_SYNCED"
  id: string
  owner_id: string
  original_sender_handle: string
  encrypted_blob: string
  iv: string
  sender_signature_verified: boolean
  created_at: string
}

export interface VaultMessageUpdatedEvent extends BaseSyncEvent {
  type: "VAULT_MESSAGE_UPDATED"
  id: string
  encrypted_blob: string
  iv: string
  version: number
  deleted_at: string | null
  updated_at: string
}

// ---- Block List Events ----

export interface BlockListUpdatedEvent extends BaseSyncEvent {
  type: "BLOCK_LIST_UPDATED"
  ciphertext: string
  iv: string
}

export interface ContactsUpdatedEvent extends BaseSyncEvent {
  type: "CONTACTS_UPDATED"
  ciphertext: string
  iv: string
}

// ---- Transport Key Events ----

export interface TransportKeyRotatedEvent extends BaseSyncEvent {
  type: "TRANSPORT_KEY_ROTATED"
  public_transport_key: string
  encrypted_transport_key: string
  encrypted_transport_iv: string
  rotated_at?: number
}

// ---- Settings Events ----

export interface SettingsUpdatedEvent extends BaseSyncEvent {
  type: "SETTINGS_UPDATED"
  showTypingIndicator?: boolean
  sendReadReceipts?: boolean
  displayName?: string | null
  displayNameVisibility?: "public" | "hidden"
}

export interface PrivacySettingsUpdatedEvent extends BaseSyncEvent {
  type: "PRIVACY_SETTINGS_UPDATED"
  ciphertext: string
  iv: string
}

// ---- Session Events ----

export interface SessionInvalidatedEvent extends BaseSyncEvent {
  type: "SESSION_INVALIDATED"
  sessionId?: string
  reason?: "deleted" | "expired" | "logout"
}

export interface SessionDeletedEvent extends BaseSyncEvent {
  type: "SESSION_DELETED"
  sessionId: string
  deletedAt: string
}

// ---- Passkey Events ----

export interface PasskeyAddedEvent extends BaseSyncEvent {
  type: "PASSKEY_ADDED"
  id: string
  credentialId: string
  name: string | null
  createdAt: string
}

export interface PasskeyRemovedEvent extends BaseSyncEvent {
  type: "PASSKEY_REMOVED"
  credentialId: string
}

// ---- Union Type for All Events ----

export type SyncEvent =
  | IncomingMessageEvent
  | OutgoingMessageSyncedEvent
  | IncomingMessageSyncedEvent
  | VaultMessageUpdatedEvent
  | BlockListUpdatedEvent
  | ContactsUpdatedEvent
  | TransportKeyRotatedEvent
  | SettingsUpdatedEvent
  | PrivacySettingsUpdatedEvent
  | SessionInvalidatedEvent
  | SessionDeletedEvent
  | PasskeyAddedEvent
  | PasskeyRemovedEvent

// Event type to payload mapping for type-safe handlers
export type SyncEventMap = {
  INCOMING_MESSAGE: IncomingMessageEvent
  OUTGOING_MESSAGE_SYNCED: OutgoingMessageSyncedEvent
  INCOMING_MESSAGE_SYNCED: IncomingMessageSyncedEvent
  VAULT_MESSAGE_UPDATED: VaultMessageUpdatedEvent
  BLOCK_LIST_UPDATED: BlockListUpdatedEvent
  CONTACTS_UPDATED: ContactsUpdatedEvent
  TRANSPORT_KEY_ROTATED: TransportKeyRotatedEvent
  SETTINGS_UPDATED: SettingsUpdatedEvent
  PRIVACY_SETTINGS_UPDATED: PrivacySettingsUpdatedEvent
  SESSION_INVALIDATED: SessionInvalidatedEvent
  SESSION_DELETED: SessionDeletedEvent
  PASSKEY_ADDED: PasskeyAddedEvent
  PASSKEY_REMOVED: PasskeyRemovedEvent
}

export type SyncEventType = keyof SyncEventMap

// All event types as array for iteration
export const SYNC_EVENT_TYPES: SyncEventType[] = [
  "INCOMING_MESSAGE",
  "OUTGOING_MESSAGE_SYNCED",
  "INCOMING_MESSAGE_SYNCED",
  "VAULT_MESSAGE_UPDATED",
  "BLOCK_LIST_UPDATED",
  "CONTACTS_UPDATED",
  "TRANSPORT_KEY_ROTATED",
  "SETTINGS_UPDATED",
  "PRIVACY_SETTINGS_UPDATED",
  "SESSION_INVALIDATED",
  "SESSION_DELETED",
  "PASSKEY_ADDED",
  "PASSKEY_REMOVED",
]

// Context passed to handlers
export interface SyncContext {
  userId: string | null
  userHandle: string | null
  sessionId: string | null
  masterKey: CryptoKey | null
  transportPrivateKey: Uint8Array | null
  identityPrivateKey: Uint8Array | null
  publicIdentityKey: string | null
  isBlocked: (handle: string) => boolean
}

// Handler interface
export interface SyncHandler<T extends SyncEventType = SyncEventType> {
  eventTypes: T[]
  validate(eventType: T, payload: unknown): payload is SyncEventMap[T]
  shouldProcess(event: SyncEventMap[T], context: SyncContext): boolean
  handle(event: SyncEventMap[T], context: SyncContext): Promise<void>
}

// Callback type for subscribers
export type SyncEventCallback<T extends SyncEventType> = (
  event: SyncEventMap[T]
) => void

// SyncManager interface
export interface ISyncManager {
  registerHandler<T extends SyncEventType>(handler: SyncHandler<T>): void
  subscribe<T extends SyncEventType>(
    eventType: T,
    callback: SyncEventCallback<T>
  ): () => void
  connect(socket: Socket): void
  disconnect(): void
  updateContext(updates: Partial<SyncContext>): void
  destroy(): void
}
