import { decryptString, encryptString } from "@/lib/crypto"
import { splitHandle } from "@/lib/handles"
import { db, type MessageRecord, type ContactRecord } from "@/lib/db"
import type { Contact, StoredMessage, Attachment, ReactionSummary } from "@/types/dashboard"

export const DELETE_SIGNATURE_BODY = "ratchet-chat:delete"
export const REACTION_PICKER_SIZE = 320
export const REACTION_PICKER_GUTTER = 12
export const REACTION_PICKER_OFFSET = 8

export async function decodeContactRecord(
  record: ContactRecord,
  masterKey: CryptoKey
): Promise<Contact | null> {
  try {
    const raw = record.content
    const envelope = JSON.parse(raw) as { encrypted_blob: string; iv: string }
    const plaintext = await decryptString(masterKey, {
      ciphertext: envelope.encrypted_blob,
      iv: envelope.iv,
    })
    const payload = JSON.parse(plaintext) as Partial<Contact>
    if (!payload.handle) {
      return null
    }
    const parts = splitHandle(payload.handle)
    return {
      handle: payload.handle,
      username: payload.username ?? parts?.username ?? payload.handle,
      host: payload.host ?? parts?.host ?? "",
      publicIdentityKey: payload.publicIdentityKey ?? "",
      publicTransportKey: payload.publicTransportKey ?? "",
      createdAt: record.createdAt,
    }
  } catch {
    return null
  }
}

export async function saveContactRecord(
  masterKey: CryptoKey,
  ownerId: string,
  contact: Contact
) {
  const encrypted = await encryptString(
    masterKey,
    JSON.stringify({
      handle: contact.handle,
      username: contact.username,
      host: contact.host,
      publicIdentityKey: contact.publicIdentityKey,
      publicTransportKey: contact.publicTransportKey,
    })
  )
  await db.contacts.put({
    id: contact.handle,
    ownerId,
    content: JSON.stringify({
      encrypted_blob: encrypted.ciphertext,
      iv: encrypted.iv,
    }),
    createdAt: contact.createdAt || new Date().toISOString(),
  })
}

export async function decodeMessageRecord(
  record: MessageRecord,
  masterKey: CryptoKey,
  fallbackPeerHandle: string
): Promise<StoredMessage | null> {
  try {
    const raw = record.content
    const envelope = JSON.parse(raw) as { encrypted_blob: string; iv: string }
    const plaintext = await decryptString(masterKey, {
      ciphertext: envelope.encrypted_blob,
      iv: envelope.iv,
    })
    let payload: {
      text?: string
      content?: string
      attachments?: Attachment[]
      peerId?: string
      peerHandle?: string
      peer_handle?: string
      peerUsername?: string
      peerHost?: string
      direction?: "in" | "out"
      timestamp?: string
      peerIdentityKey?: string
      peerTransportKey?: string
      messageId?: string
      message_id?: string
      type?: "edit" | "delete" | "reaction" | "receipt" | "message" | "call"
      edited_at?: string
      editedAt?: string
      deleted_at?: string
      deletedAt?: string
      reaction_action?: "add" | "remove"
      reactionAction?: "add" | "remove"
      reaction_emoji?: string
      reactionEmoji?: string
      action?: "add" | "remove"
      emoji?: string
      delivered_at?: string
      deliveredAt?: string
      processed_at?: string
      processedAt?: string
      read_at?: string
      readAt?: string
      reply_to_message_id?: string
      replyToMessageId?: string
      reply_to_text?: string
      replyToText?: string
      reply_to_sender_handle?: string
      replyToSenderHandle?: string
      reply_to_sender_name?: string
      replyToSenderName?: string
      event_type?: string
      eventType?: string
      call_event?: string
      callEvent?: string
      call_type?: "AUDIO" | "VIDEO"
      callType?: "AUDIO" | "VIDEO"
      call_direction?: string
      callDirection?: string
      duration_seconds?: number
      durationSeconds?: number
      duration?: number
    } = {}
    try {
      payload = JSON.parse(plaintext) as typeof payload
    } catch {
      payload = { text: plaintext }
    }
    if (payload.type === "receipt") {
      return null
    }
    if (payload.type === "call") {
      const callEventType =
        payload.event_type ?? payload.eventType ?? payload.call_event ?? payload.callEvent
      const callType = payload.call_type ?? payload.callType ?? "AUDIO"
      const callDirection =
        payload.direction ?? payload.call_direction ?? payload.callDirection ?? "incoming"
      const messageDirection = callDirection === "outgoing" ? "out" : "in"
      const isRead = record.isRead ?? messageDirection === "out"
      const messageId =
        payload.messageId ??
        payload.message_id ??
        (messageDirection === "out" ? record.id : undefined)
      const replyMessageId =
        payload.reply_to_message_id ?? payload.replyToMessageId
      const fallbackHandle = fallbackPeerHandle
      let resolvedHandle =
        payload.peerHandle ?? payload.peerId ?? payload.peer_handle ?? fallbackHandle
      if (messageDirection === "in" && fallbackHandle && resolvedHandle !== fallbackHandle) {
        resolvedHandle = fallbackHandle
      }
      const text = payload.text ?? payload.content ?? ""
      return {
        id: record.id,
        peerHandle: resolvedHandle,
        peerUsername: payload.peerUsername,
        peerHost: payload.peerHost,
        peerIdentityKey: payload.peerIdentityKey,
        peerTransportKey: payload.peerTransportKey,
        direction: messageDirection,
        text,
        timestamp: payload.timestamp ?? record.createdAt,
        kind: "call",
        callEventType: callEventType as any,
        callType: callType,
        callDirection: callDirection as any,
        callDurationSeconds:
          payload.duration_seconds ?? payload.durationSeconds ?? payload.duration,
        replyTo: replyMessageId
          ? {
              messageId: replyMessageId,
            }
          : undefined,
        verified: record.verified,
        isRead,
        messageId,
      }
    }
    const isReaction = payload.type === "reaction"
    const reactionEmoji =
      payload.reaction_emoji ?? payload.reactionEmoji ?? payload.emoji
    const text = isReaction
      ? reactionEmoji ?? payload.text ?? payload.content ?? plaintext
      : payload.text ?? payload.content ?? plaintext
    const kind =
      payload.type === "edit"
        ? "edit"
        : payload.type === "delete"
        ? "delete"
        : payload.type === "reaction"
        ? "reaction"
        : "message"
    const direction = payload.direction ?? "in"
    const isRead = record.isRead ?? direction === "out"
    const messageId =
      payload.messageId ??
      payload.message_id ??
      (direction === "out" ? record.id : undefined)
    const replyMessageId =
      payload.reply_to_message_id ?? payload.replyToMessageId
    const fallbackHandle = fallbackPeerHandle
    let resolvedHandle =
      payload.peerHandle ?? payload.peerId ?? fallbackHandle
    if (direction === "in" && fallbackHandle && resolvedHandle !== fallbackHandle) {
      resolvedHandle = fallbackHandle
    }
    return {
      id: record.id,
      peerHandle: resolvedHandle,
      peerUsername: payload.peerUsername,
      peerHost: payload.peerHost,
      peerIdentityKey: payload.peerIdentityKey,
      peerTransportKey: payload.peerTransportKey,
      direction,
      text,
      attachments: payload.attachments,
      timestamp: payload.timestamp ?? record.createdAt,
      kind,
      editedAt: payload.edited_at ?? payload.editedAt,
      deletedAt: payload.deleted_at ?? payload.deletedAt,
      reactionAction:
        payload.reaction_action ??
        payload.reactionAction ??
        payload.action,
      deliveredAt: payload.delivered_at ?? payload.deliveredAt,
      processedAt: payload.processed_at ?? payload.processedAt,
      readAt: payload.read_at ?? payload.readAt,
      replyTo: replyMessageId
        ? {
            messageId: replyMessageId,
          }
        : undefined,
      verified: record.verified,
      isRead,
      messageId,
    }
  } catch {
    return null
  }
}

export function getEventTimestamp(message: StoredMessage) {
  const value =
    message.editedAt ??
    message.deletedAt ??
    message.timestamp
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? 0 : parsed.valueOf()
}

export function applyMessageEvents(messages: StoredMessage[]) {
  const edits = messages.filter(
    (message) => message.kind === "edit" && message.messageId
  )
  const deletes = messages.filter(
    (message) => message.kind === "delete" && message.messageId
  )
  const reactions = messages.filter(
    (message) =>
      message.kind === "reaction" && message.messageId && message.text
  )
  const latestEdits = new Map<string, StoredMessage>()
  for (const edit of edits) {
    if (!edit.messageId) continue
    const existing = latestEdits.get(edit.messageId)
    if (!existing || getEventTimestamp(edit) > getEventTimestamp(existing)) {
      latestEdits.set(edit.messageId, edit)
    }
  }
  const latestDeletes = new Map<string, StoredMessage>()
  for (const deletion of deletes) {
    if (!deletion.messageId) continue
    const existing = latestDeletes.get(deletion.messageId)
    if (!existing || getEventTimestamp(deletion) > getEventTimestamp(existing)) {
      latestDeletes.set(deletion.messageId, deletion)
    }
  }
  const reactionsByMessage = new Map<
    string,
    Map<string, { byMe: boolean; byPeer: boolean }>
  >()
  const sortedReactions = [...reactions].sort(
    (a, b) => getEventTimestamp(a) - getEventTimestamp(b)
  )
  for (const reaction of sortedReactions) {
    if (!reaction.messageId || !reaction.text || !reaction.verified) continue
    const key = `${reaction.messageId}:${reaction.peerHandle}`
    const bucket =
      reactionsByMessage.get(key) ??
      new Map<string, { byMe: boolean; byPeer: boolean }>()
    const state = bucket.get(reaction.text) ?? { byMe: false, byPeer: false }
    const action = reaction.reactionAction === "remove" ? "remove" : "add"
    if (reaction.direction === "out") {
      state.byMe = action === "add"
    } else {
      state.byPeer = action === "add"
    }
    bucket.set(reaction.text, state)
    reactionsByMessage.set(key, bucket)
  }
  const next: StoredMessage[] = []
  for (const message of messages) {
    if (
      message.kind === "edit" ||
      message.kind === "delete" ||
      message.kind === "reaction"
    ) {
      continue
    }
    const targetId = message.messageId ?? message.id
    const reactionKey = `${targetId}:${message.peerHandle}`
    const reactionBucket = reactionsByMessage.get(reactionKey)
    const reactionList = reactionBucket
      ? Array.from(reactionBucket.entries())
          .map(([emoji, state]) => {
            const count = (state.byMe ? 1 : 0) + (state.byPeer ? 1 : 0)
            if (count === 0) {
              return null
            }
            return { emoji, count, reactedByMe: state.byMe }
          })
          .filter(Boolean) as ReactionSummary[]
      : undefined
    const deletion = targetId ? latestDeletes.get(targetId) : null
    if (
      deletion &&
      deletion.verified &&
      deletion.peerHandle === message.peerHandle &&
      deletion.direction === message.direction
    ) {
      continue
    }
    const edit = targetId ? latestEdits.get(targetId) : null
    if (
      edit &&
      edit.verified &&
      edit.peerHandle === message.peerHandle &&
      edit.direction === message.direction
    ) {
      next.push({
        ...message,
        text: edit.text,
        editedAt: edit.editedAt ?? edit.timestamp,
        attachments: message.attachments,
        reactions: reactionList,
      })
      continue
    }
    if (reactionList && reactionList.length > 0) {
      next.push({ ...message, reactions: reactionList })
    } else {
      next.push({ ...message })
    }
  }
  return next
}

export function truncateText(value: string, max = 140) {
  if (value.length <= max) return value
  return value.slice(0, Math.max(0, max - 3)) + "..."
}

export function getReplyPreviewText(message: StoredMessage) {
  const trimmed = message.text?.trim()
  if (trimmed) {
    return trimmed
  }
  if (message.attachments?.length) {
    if (message.attachments.length === 1) {
      return message.attachments[0].filename || "Attachment"
    }
    return `${message.attachments.length} attachments`
  }
  return "Message"
}

export function formatTimestamp(isoString: string) {
  if (!isoString) return ""
  try {
    const date = new Date(isoString)
    if (Number.isNaN(date.getTime())) return ""
    const now = new Date()
    if (
      date.getDate() === now.getDate() &&
      date.getMonth() === now.getMonth() &&
      date.getFullYear() === now.getFullYear()
    ) {
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    }
    return date.toLocaleDateString()
  } catch {
    return ""
  }
}

export function formatMessageTime(isoString: string) {
  if (!isoString) return ""
  try {
    const date = new Date(isoString)
    if (Number.isNaN(date.getTime())) return ""
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  } catch {
    return ""
  }
}
