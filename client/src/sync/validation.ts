import type {
  SyncEventType,
  SyncEventMap,
  IncomingMessageEvent,
  OutgoingMessageSyncedEvent,
  IncomingMessageSyncedEvent,
  VaultMessageUpdatedEvent,
  BlockListUpdatedEvent,
  ContactsUpdatedEvent,
  TransportKeyRotatedEvent,
  SettingsUpdatedEvent,
  PrivacySettingsUpdatedEvent,
  SessionInvalidatedEvent,
  SessionDeletedEvent,
  PasskeyAddedEvent,
  PasskeyRemovedEvent,
} from "./types"

// Type guard helpers
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean"
}

function isNumber(value: unknown): value is number {
  return typeof value === "number"
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

// Individual validators
function validateIncomingMessage(
  payload: unknown
): payload is Omit<IncomingMessageEvent, "type"> {
  if (!isObject(payload)) return false
  return (
    isString(payload.id) &&
    isString(payload.recipient_id) &&
    isString(payload.sender_handle) &&
    isString(payload.encrypted_blob) &&
    isString(payload.created_at)
  )
}

function validateOutgoingMessageSynced(
  payload: unknown
): payload is Omit<OutgoingMessageSyncedEvent, "type"> {
  if (!isObject(payload)) return false
  return (
    isString(payload.message_id) &&
    isString(payload.owner_id) &&
    isString(payload.original_sender_handle) &&
    isString(payload.encrypted_blob) &&
    isString(payload.iv) &&
    isBoolean(payload.sender_signature_verified) &&
    isString(payload.created_at)
  )
}

function validateIncomingMessageSynced(
  payload: unknown
): payload is Omit<IncomingMessageSyncedEvent, "type"> {
  if (!isObject(payload)) return false
  return (
    isString(payload.id) &&
    isString(payload.owner_id) &&
    isString(payload.original_sender_handle) &&
    isString(payload.encrypted_blob) &&
    isString(payload.iv) &&
    isBoolean(payload.sender_signature_verified) &&
    isString(payload.created_at)
  )
}

function validateVaultMessageUpdated(
  payload: unknown
): payload is Omit<VaultMessageUpdatedEvent, "type"> {
  if (!isObject(payload)) return false
  return (
    isString(payload.id) &&
    isString(payload.encrypted_blob) &&
    isString(payload.iv) &&
    isNumber(payload.version) &&
    isStringOrNull(payload.deleted_at) &&
    isString(payload.updated_at)
  )
}

function validateBlockListUpdated(
  payload: unknown
): payload is Omit<BlockListUpdatedEvent, "type"> {
  if (!isObject(payload)) return false
  return isString(payload.ciphertext) && isString(payload.iv)
}

function validateContactsUpdated(
  payload: unknown
): payload is Omit<ContactsUpdatedEvent, "type"> {
  if (!isObject(payload)) return false
  return isString(payload.ciphertext) && isString(payload.iv)
}

function validateTransportKeyRotated(
  payload: unknown
): payload is Omit<TransportKeyRotatedEvent, "type"> {
  if (!isObject(payload)) return false
  return (
    isString(payload.public_transport_key) &&
    isString(payload.encrypted_transport_key) &&
    isString(payload.encrypted_transport_iv) &&
    (payload.rotated_at === undefined || isNumber(payload.rotated_at))
  )
}

function validateSettingsUpdated(
  payload: unknown
): payload is Omit<SettingsUpdatedEvent, "type"> {
  if (!isObject(payload)) return false
  // At least one setting must be present
  const hasTypingIndicator =
    payload.showTypingIndicator === undefined ||
    isBoolean(payload.showTypingIndicator)
  const hasReadReceipts =
    payload.sendReadReceipts === undefined ||
    isBoolean(payload.sendReadReceipts)
  const hasDisplayName =
    payload.displayName === undefined || isStringOrNull(payload.displayName)
  const hasDisplayNameVisibility =
    payload.displayNameVisibility === undefined ||
    payload.displayNameVisibility === "public" ||
    payload.displayNameVisibility === "hidden"
  return (
    hasTypingIndicator &&
    hasReadReceipts &&
    hasDisplayName &&
    hasDisplayNameVisibility &&
    (payload.showTypingIndicator !== undefined ||
      payload.sendReadReceipts !== undefined ||
      payload.displayName !== undefined ||
      payload.displayNameVisibility !== undefined)
  )
}

function validatePrivacySettingsUpdated(
  payload: unknown
): payload is Omit<PrivacySettingsUpdatedEvent, "type"> {
  if (!isObject(payload)) return false
  return isString(payload.ciphertext) && isString(payload.iv)
}

function validateSessionInvalidated(
  payload: unknown
): payload is Omit<SessionInvalidatedEvent, "type"> {
  if (!isObject(payload)) return false
  // sessionId is optional for legacy compatibility
  const validSessionId =
    payload.sessionId === undefined || isString(payload.sessionId)
  const validReason =
    payload.reason === undefined ||
    payload.reason === "deleted" ||
    payload.reason === "expired" ||
    payload.reason === "logout"
  return validSessionId && validReason
}

function validateSessionDeleted(
  payload: unknown
): payload is Omit<SessionDeletedEvent, "type"> {
  if (!isObject(payload)) return false
  return isString(payload.sessionId) && isString(payload.deletedAt)
}

function validatePasskeyAdded(
  payload: unknown
): payload is Omit<PasskeyAddedEvent, "type"> {
  if (!isObject(payload)) return false
  return (
    isString(payload.id) &&
    isString(payload.credentialId) &&
    isStringOrNull(payload.name) &&
    isString(payload.createdAt)
  )
}

function validatePasskeyRemoved(
  payload: unknown
): payload is Omit<PasskeyRemovedEvent, "type"> {
  if (!isObject(payload)) return false
  return isString(payload.credentialId)
}

// Main validation function
const validators: Record<
  SyncEventType,
  (payload: unknown) => boolean
> = {
  INCOMING_MESSAGE: validateIncomingMessage,
  OUTGOING_MESSAGE_SYNCED: validateOutgoingMessageSynced,
  INCOMING_MESSAGE_SYNCED: validateIncomingMessageSynced,
  VAULT_MESSAGE_UPDATED: validateVaultMessageUpdated,
  BLOCK_LIST_UPDATED: validateBlockListUpdated,
  CONTACTS_UPDATED: validateContactsUpdated,
  TRANSPORT_KEY_ROTATED: validateTransportKeyRotated,
  SETTINGS_UPDATED: validateSettingsUpdated,
  PRIVACY_SETTINGS_UPDATED: validatePrivacySettingsUpdated,
  SESSION_INVALIDATED: validateSessionInvalidated,
  SESSION_DELETED: validateSessionDeleted,
  PASSKEY_ADDED: validatePasskeyAdded,
  PASSKEY_REMOVED: validatePasskeyRemoved,
}

export function validateSyncEvent<T extends SyncEventType>(
  eventType: T,
  payload: unknown
): SyncEventMap[T] | null {
  const validator = validators[eventType]
  if (!validator) {
    return null
  }

  if (!validator(payload)) {
    console.warn(`[Validation] Invalid ${eventType} payload:`, payload)
    return null
  }

  return { type: eventType, ...(payload as Record<string, unknown>) } as SyncEventMap[T]
}

export function isValidSyncEvent<T extends SyncEventType>(
  eventType: T,
  payload: unknown
): payload is SyncEventMap[T] {
  return validateSyncEvent(eventType, payload) !== null
}
