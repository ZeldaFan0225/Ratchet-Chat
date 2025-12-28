"use client"

import * as React from "react"
import { io } from "socket.io-client"
import { useAuth } from "@/context/AuthContext"
import { useSettings } from "@/hooks/useSettings"
import { apiFetch, getAuthToken } from "@/lib/api"
import { CONTACT_TRANSPORT_KEY_UPDATED_EVENT } from "@/lib/events"
import { decodeContactRecord, saveContactRecord } from "@/lib/messageUtils"
import {
  buildMessageSignaturePayload,
  decodeUtf8,
  decryptTransitBlob,
  decryptString,
  encodeUtf8,
  encryptTransitEnvelope,
  encryptString,
  signMessage,
  verifySignature,
} from "@/lib/crypto"
import { splitHandle } from "@/lib/handles"
import { db } from "@/lib/db"
import type { Contact } from "@/types/dashboard"
import type { CallMessagePayload } from "@/context/CallContext"

// Call signaling messages older than this are stale and should be ignored
const CALL_SIGNALING_MAX_AGE_MS = 120_000 // 120 seconds

type Attachment = {
  filename: string
  mimeType: string
  size: number
  data: string
}

type QueueItem = {
  id: string
  recipient_id: string
  sender_handle: string
  encrypted_blob: string
  created_at: string
}

type VaultItem = {
  id: string
  owner_id: string
  peer_handle?: string | null
  original_sender_handle: string
  encrypted_blob: string
  iv: string
  sender_signature_verified: boolean
  version: number
  created_at: string
  updated_at: string
  deleted_at?: string | null
}

type ConversationSummary = {
  id: string
  peer_handle: string | null
  original_sender_handle: string
  encrypted_blob: string
  iv: string
  sender_signature_verified: boolean
  version: number
  created_at: string
  updated_at: string
}

export type DecryptedSummary = {
  peerHandle: string
  lastMessageText: string
  lastMessageTimestamp: string
  direction: "in" | "out"
  isRead: boolean
}

type TransitPayload = {
  content?: string
  message?: string
  plaintext?: string
  attachments?: Attachment[]
  type?: "edit" | "delete" | "reaction" | "receipt" | "message" | "key_rotation" | "call"
  edited_at?: string
  editedAt?: string
  deleted_at?: string
  deletedAt?: string
  public_transport_key?: string
  publicTransportKey?: string
  rotated_at?: number
  rotatedAt?: number
  reaction_action?: "add" | "remove"
  reactionAction?: "add" | "remove"
  reaction_emoji?: string
  reactionEmoji?: string
  action?: "add" | "remove"
  emoji?: string
  receipt_status?: "PROCESSED_BY_CLIENT" | "READ_BY_USER"
  receiptStatus?: "PROCESSED_BY_CLIENT" | "READ_BY_USER"
  receipt_timestamp?: string
  receiptTimestamp?: string
  senderSignature?: string
  sender_signature?: string
  senderIdentityKey?: string
  sender_identity_key?: string
  senderHandle?: string
  sender_handle?: string
  messageId?: string
  message_id?: string
  reply_to_message_id?: string
  replyToMessageId?: string
  reply_to_text?: string
  replyToText?: string
  reply_to_sender_handle?: string
  replyToSenderHandle?: string
  reply_to_sender_name?: string
  replyToSenderName?: string
  // Call signaling fields
  call_type?: "AUDIO" | "VIDEO"
  call_id?: string
  call_action?: "offer" | "answer" | "ice" | "busy" | "declined" | "end" | "ringing" | "session_accepted" | "session_declined"
  sdp?: string
  candidate?: RTCIceCandidateInit
  timestamp?: string
  // Call notice fields (stored in vault)
  event_type?: "CALL_MISSED" | "CALL_DECLINED" | "CALL_ENDED"
}

function parseTransitPayload(bytes: Uint8Array): TransitPayload & { content: string } {
  const text = decodeUtf8(bytes)
  try {
    const parsed = JSON.parse(text) as TransitPayload
    return { content: parsed.content ?? parsed.message ?? parsed.plaintext ?? text, ...parsed }
  } catch {
    return { content: text }
  }
}

type DirectoryEntry = {
  id?: string
  handle: string
  host: string
  public_identity_key: string
  public_transport_key: string
}

type ReceiptEventStatus = "PROCESSED_BY_CLIENT" | "READ_BY_USER"

const isNewerTimestamp = (current: string | undefined, next: string) => {
  if (!next) {
    return false
  }
  if (!current) {
    return true
  }
  const currentDate = new Date(current)
  const nextDate = new Date(next)
  if (Number.isNaN(nextDate.valueOf())) {
    return false
  }
  if (Number.isNaN(currentDate.valueOf())) {
    return true
  }
  return nextDate > currentDate
}

type UseRatchetSyncOptions = {
  onCallMessage?: (senderHandle: string, senderIdentityKey: string, payload: CallMessagePayload) => void
  onVaultMessageSynced?: (messageId: string, action: "upsert" | "delete") => void
}

export function useRatchetSync(options: UseRatchetSyncOptions = {}) {
  const { onCallMessage, onVaultMessageSynced } = options
  const {
    masterKey,
    transportPrivateKey,
    identityPrivateKey,
    publicIdentityKey,
    user,
  } = useAuth()
  const { settings } = useSettings()
  const isSyncingRef = React.useRef(false)
  const directoryCacheRef = React.useRef(new Map<string, DirectoryEntry>())
  const processedIdsRef = React.useRef(new Set<string>())
  const [lastSync, setLastSync] = React.useState(0)
  const [summaries, setSummaries] = React.useState<Map<string, DecryptedSummary>>(new Map())
  const [summariesLoaded, setSummariesLoaded] = React.useState(false)
  const bumpLastSync = React.useCallback(() => {
    setLastSync((prev) => {
      const now = Date.now()
      return now > prev ? now : prev + 1
    })
  }, [])

  const updateMessageTimestamps = React.useCallback(
    async (params: {
      messageId: string
      senderHandle?: string
      processedAt?: string
      readAt?: string
    }) => {
      if (!masterKey) {
        return false
      }
      const record = await db.messages.get(params.messageId)
      if (!record) {
        return false
      }
      let envelope: { encrypted_blob: string; iv: string } | null = null
      try {
        envelope = JSON.parse(record.content) as {
          encrypted_blob: string
          iv: string
        }
      } catch {
        return false
      }
      if (!envelope?.encrypted_blob || !envelope.iv) {
        return false
      }
      let payload: {
        direction?: "in" | "out"
        peerHandle?: string
        peerId?: string
        processed_at?: string
        processedAt?: string
        read_at?: string
        readAt?: string
      } = {}
      try {
        const plaintext = await decryptString(masterKey, {
          ciphertext: envelope.encrypted_blob,
          iv: envelope.iv,
        })
        payload = JSON.parse(plaintext) as typeof payload
      } catch {
        return false
      }
      if (payload.direction !== "out") {
        return false
      }
      const peerHandle = payload.peerHandle ?? payload.peerId
      if (params.senderHandle && peerHandle && peerHandle !== params.senderHandle) {
        return false
      }

      const currentProcessed = payload.processed_at ?? payload.processedAt
      const currentRead = payload.read_at ?? payload.readAt
      const nextPayload: Record<string, unknown> = { ...payload }
      let didUpdate = false

      if (params.processedAt && isNewerTimestamp(currentProcessed, params.processedAt)) {
        nextPayload.processed_at = params.processedAt
        didUpdate = true
      }
      if (params.readAt && isNewerTimestamp(currentRead, params.readAt)) {
        nextPayload.read_at = params.readAt
        didUpdate = true
      }
      if (!didUpdate) {
        return true
      }

      const encrypted = await encryptString(masterKey, JSON.stringify(nextPayload))
      const contentJson = JSON.stringify({
        encrypted_blob: encrypted.ciphertext,
        iv: encrypted.iv,
      })
      await db.messages.update(params.messageId, { content: contentJson })
      try {
        await apiFetch(`/messages/vault/${params.messageId}`, {
          method: "PATCH",
          body: {
            encrypted_blob: encrypted.ciphertext,
            iv: encrypted.iv,
          },
        })
      } catch {
        // Best-effort: local state remains authoritative for this device.
      }
      bumpLastSync()
      return true
    },
    [masterKey, bumpLastSync]
  )

  const sendReceiptEvent = React.useCallback(
    async (params: {
      recipientHandle: string
      recipientTransportKey: string
      messageId: string
      status: ReceiptEventStatus
      timestamp: string
    }) => {
      if (!identityPrivateKey || !publicIdentityKey || !user?.handle) {
        return
      }
      const signatureBody = `receipt:${params.status}:${params.timestamp}`
      const signature = signMessage(
        buildMessageSignaturePayload(
          user.handle,
          signatureBody,
          params.messageId
        ),
        identityPrivateKey
      )
      const payload = JSON.stringify({
        type: "receipt",
        content: signatureBody,
        receipt_status: params.status,
        receipt_timestamp: params.timestamp,
        sender_handle: user.handle,
        sender_signature: signature,
        sender_identity_key: publicIdentityKey,
        message_id: params.messageId,
      })
      const encryptedBlob = await encryptTransitEnvelope(
        payload,
        params.recipientTransportKey
      )
      await apiFetch("/messages/send", {
        method: "POST",
        body: {
          recipient_handle: params.recipientHandle,
          encrypted_blob: encryptedBlob,
          message_id: crypto.randomUUID(),
          event_type: "receipt",
        },
      })
    },
    [identityPrivateKey, publicIdentityKey, user?.handle]
  )

  const processSingleQueueItem = React.useCallback(
    async (item: QueueItem) => {
      if (!masterKey || !transportPrivateKey) {
        return
      }

      let decryptedBytes: Uint8Array
      try {
        decryptedBytes = await decryptTransitBlob(
          item.encrypted_blob,
          transportPrivateKey
        )
      } catch (e) {
        return
      }

      const payload = parseTransitPayload(decryptedBytes)

      // Handle call signaling messages (ephemeral, not stored in vault)
      if (payload.type === "call" && payload.call_action) {
        const senderHandle = item.sender_handle
        const inlineIdentityKey = payload.senderIdentityKey ?? payload.sender_identity_key

        // Deduplicate call signaling messages
        const callDedupeKey = `call:${item.id}`
        if (processedIdsRef.current.has(callDedupeKey)) {
          console.log("[RatchetSync] Ignoring duplicate call signaling", { id: item.id })
          return
        }
        processedIdsRef.current.add(callDedupeKey)

        // Check if message is stale (older than 120 seconds)
        const messageTimestamp = payload.timestamp ? new Date(payload.timestamp).getTime() : 0
        const messageAge = Date.now() - messageTimestamp

        if (messageAge > CALL_SIGNALING_MAX_AGE_MS) {
          console.warn("[RatchetSync] Ignoring stale call signaling", {
            call_action: payload.call_action,
            call_id: payload.call_id,
            age_seconds: Math.floor(messageAge / 1000),
          })
          // ACK and discard without processing
          try {
            await apiFetch(`/messages/queue/${item.id}/ack`, { method: "POST" })
          } catch {
            // Best-effort ACK
          }
          return
        }

        // Route to CallContext for live signaling
        if (onCallMessage && senderHandle && inlineIdentityKey) {
          // Verify signature before processing
          const senderSignature = payload.sender_signature ?? payload.senderSignature
          if (senderSignature) {
            // Reconstruct the payload that was signed (without signature and identity key)
            const unsignedPayload: Record<string, unknown> = {
              type: "call",
              call_type: payload.call_type ?? "AUDIO",
              call_id: payload.call_id ?? "",
              call_action: payload.call_action,
              timestamp: payload.timestamp,
            }
            if (payload.sdp) unsignedPayload.sdp = payload.sdp
            if (payload.candidate) unsignedPayload.candidate = payload.candidate

            const signaturePayload = buildMessageSignaturePayload(
              senderHandle,
              JSON.stringify(unsignedPayload),
              payload.call_id ?? ""
            )
            const signatureValid = verifySignature(
              signaturePayload,
              senderSignature,
              inlineIdentityKey
            )

            if (!signatureValid) {
              console.warn("[RatchetSync] Invalid signature on call signaling, rejecting", {
                call_action: payload.call_action,
                call_id: payload.call_id,
                sender: senderHandle,
              })
              // ACK to remove from queue but don't process
              try {
                await apiFetch(`/messages/queue/${item.id}/ack`, { method: "POST" })
              } catch {
                // Best-effort ACK
              }
              return
            }
          } else {
            console.warn("[RatchetSync] Call signaling missing signature, rejecting", {
              call_action: payload.call_action,
              call_id: payload.call_id,
              sender: senderHandle,
            })
            // ACK to remove from queue but don't process
            try {
              await apiFetch(`/messages/queue/${item.id}/ack`, { method: "POST" })
            } catch {
              // Best-effort ACK
            }
            return
          }

          const callPayload: CallMessagePayload = {
            type: "call",
            call_type: payload.call_type ?? "AUDIO",
            call_id: payload.call_id ?? "",
            call_action: payload.call_action,
            sdp: payload.sdp,
            candidate: payload.candidate,
            sender_signature: senderSignature,
            sender_identity_key: inlineIdentityKey,
            timestamp: payload.timestamp ?? new Date().toISOString(),
          }
          onCallMessage(senderHandle, inlineIdentityKey, callPayload)
        }

        // ACK without storing in vault (signaling is ephemeral)
        try {
          await apiFetch(`/messages/queue/${item.id}/ack`, { method: "POST" })
        } catch {
          // Best-effort ACK
        }
        return
      }

      // Call notices (CALL_MISSED, CALL_ENDED, etc.) fall through to normal message handling
      // and will be stored in vault for chat history

      const senderSignature =
        payload.senderSignature ?? payload.sender_signature
      const inlineIdentityKey =
        payload.senderIdentityKey ?? payload.sender_identity_key
      const payloadSenderHandle =
        payload.senderHandle ?? payload.sender_handle
      const payloadMessageId = payload.messageId ?? payload.message_id
      const payloadType = payload.type ?? "message"
      let payloadReactionAction =
        payload.reaction_action ?? payload.reactionAction ?? payload.action
      let normalizedReactionAction =
        payloadReactionAction === "remove" ? "remove" : "add"
      let payloadReactionEmoji =
        payload.reaction_emoji ?? payload.reactionEmoji ?? payload.emoji
      if (payloadType === "reaction" && typeof payload.content === "string") {
        const signedContent = payload.content
        if (signedContent.startsWith("reaction:")) {
          const parts = signedContent.split(":")
          const signedAction = parts[1]
          const signedEmoji = parts.slice(2).join(":")
          const signedNormalizedAction =
            signedAction === "remove" ? "remove" : "add"
          if (
            payloadReactionAction &&
            payloadReactionAction !== signedNormalizedAction
          ) {
            return
          }
          if (
            payloadReactionEmoji &&
            signedEmoji &&
            payloadReactionEmoji !== signedEmoji
          ) {
            return
          }
          payloadReactionAction = signedNormalizedAction
          normalizedReactionAction = signedNormalizedAction
          if (signedEmoji) {
            payloadReactionEmoji = signedEmoji
          }
        }
      }
      let payloadReceiptStatus =
        payload.receipt_status ?? payload.receiptStatus
      let payloadReceiptTimestamp =
        payload.receipt_timestamp ?? payload.receiptTimestamp
      let payloadRotationKey =
        payload.public_transport_key ?? payload.publicTransportKey
      let payloadRotationTimestamp =
        payload.rotated_at ?? payload.rotatedAt
      if (payloadType === "receipt" && typeof payload.content === "string") {
        const signedContent = payload.content
        if (!signedContent.startsWith("receipt:")) {
          return
        }
        const parts = signedContent.split(":")
        const signedStatus = parts[1]
        const signedTimestamp = parts.slice(2).join(":")
        if (
          signedStatus !== "PROCESSED_BY_CLIENT" &&
          signedStatus !== "READ_BY_USER"
        ) {
          return
        }
        if (
          payloadReceiptStatus &&
          payloadReceiptStatus !== signedStatus
        ) {
          return
        }
        if (
          payloadReceiptTimestamp &&
          signedTimestamp &&
          payloadReceiptTimestamp !== signedTimestamp
        ) {
          return
        }
        payloadReceiptStatus = signedStatus as ReceiptEventStatus
        payloadReceiptTimestamp = signedTimestamp
      }
      if (payloadType === "key_rotation" && typeof payload.content === "string") {
        const signedContent = payload.content
        if (!signedContent.startsWith("key-rotation:")) {
          return
        }
        const parts = signedContent.split(":")
        if (parts.length < 3) {
          return
        }
        const signedTimestamp = parts[1]
        const signedKey = parts.slice(2).join(":")
        if (
          payloadRotationTimestamp !== undefined &&
          Number(payloadRotationTimestamp) !== Number(signedTimestamp)
        ) {
          return
        }
        if (payloadRotationKey && payloadRotationKey !== signedKey) {
          return
        }
        payloadRotationTimestamp = Number(signedTimestamp)
        payloadRotationKey = signedKey

        // Freshness check: reject rotations older than 24 hours or in the future
        const MAX_ROTATION_AGE_MS = 24 * 60 * 60 * 1000
        const MAX_FUTURE_DRIFT_MS = 5 * 60 * 1000 // 5 min clock drift allowance
        const now = Date.now()
        if (
          payloadRotationTimestamp < now - MAX_ROTATION_AGE_MS ||
          payloadRotationTimestamp > now + MAX_FUTURE_DRIFT_MS
        ) {
          return
        }
      }
      const senderHandle = item.sender_handle
      let signatureVerified = false
      let directoryEntry: DirectoryEntry | null = null
      let authenticityVerified = false
      let peerIdentityKey: string | undefined
      let peerTransportKey: string | undefined

      if (senderHandle) {
        const cached = directoryCacheRef.current.get(senderHandle)
        if (cached) {
          directoryEntry = cached
        } else {
          try {
            directoryEntry = await apiFetch<DirectoryEntry>(
              `/api/directory?handle=${encodeURIComponent(senderHandle)}`
            )
            directoryCacheRef.current.set(senderHandle, directoryEntry)
          } catch {
            directoryEntry = null
          }
        }
      }

      if (
        (payloadType === "edit" ||
          payloadType === "delete" ||
          payloadType === "reaction" ||
          payloadType === "receipt") &&
        !payloadMessageId
      ) {
        return
      }
      if (
        payloadType === "receipt" &&
        (!payloadReceiptStatus || !payloadReceiptTimestamp)
      ) {
        return
      }

      if (senderSignature) {
        const verificationKey =
          directoryEntry?.public_identity_key ?? inlineIdentityKey
        if (verificationKey) {
          const signaturePayload = senderHandle
            ? buildMessageSignaturePayload(
                senderHandle,
                payload.content,
                payloadMessageId ?? undefined
              )
            : encodeUtf8(payload.content)
          signatureVerified = verifySignature(
            signaturePayload,
            senderSignature,
            verificationKey
          )
        }
      }

      const handleMatchesQueue = !payloadSenderHandle
        ? true
        : payloadSenderHandle === item.sender_handle

      if (!handleMatchesQueue) {
        signatureVerified = false
      }

      authenticityVerified = senderHandle
        ? signatureVerified &&
          !!directoryEntry &&
          directoryEntry.handle === senderHandle &&
          handleMatchesQueue &&
          (!inlineIdentityKey ||
            directoryEntry.public_identity_key === inlineIdentityKey)
        : signatureVerified && handleMatchesQueue

      if (!authenticityVerified) {
        return
      }

      if (authenticityVerified && directoryEntry) {
        peerIdentityKey = directoryEntry.public_identity_key
        peerTransportKey = directoryEntry.public_transport_key
      }

      if (payloadType === "key_rotation") {
        if (!senderHandle || !payloadRotationKey || !masterKey || !user) {
          return
        }
        if (
          directoryEntry?.public_transport_key &&
          directoryEntry.public_transport_key !== payloadRotationKey
        ) {
          return
        }
        const ownerId = user.id ?? user.handle
        const handleParts = splitHandle(senderHandle)
        const existingRecord = await db.contacts.get(senderHandle)
        const existingContact = existingRecord
          ? await decodeContactRecord(existingRecord, masterKey)
          : null
        const nextContact: Contact = {
          handle: senderHandle,
          username:
            existingContact?.username ??
            handleParts?.username ??
            senderHandle,
          host: existingContact?.host ?? handleParts?.host ?? "",
          publicIdentityKey:
            existingContact?.publicIdentityKey ??
            directoryEntry?.public_identity_key ??
            inlineIdentityKey ??
            "",
          publicTransportKey: payloadRotationKey,
          createdAt: existingContact?.createdAt ?? item.created_at,
        }
        try {
          await saveContactRecord(masterKey, ownerId, nextContact)
          if (senderHandle) {
            directoryCacheRef.current.set(senderHandle, {
              id: directoryEntry?.id,
              handle: senderHandle,
              host: handleParts?.host ?? directoryEntry?.host ?? "",
              public_identity_key:
                directoryEntry?.public_identity_key ??
                inlineIdentityKey ??
                nextContact.publicIdentityKey,
              public_transport_key: payloadRotationKey,
            })
          }
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent(CONTACT_TRANSPORT_KEY_UPDATED_EVENT, {
                detail: {
                  handle: senderHandle,
                  publicTransportKey: payloadRotationKey,
                },
              })
            )
          }
          await apiFetch(`/messages/queue/${item.id}/ack`, { method: "POST" })
        } catch {
          // Retry key rotation on next sync
        }
        return
      }

      if (payloadType === "receipt") {
        if (!payloadMessageId || !payloadReceiptStatus || !payloadReceiptTimestamp) {
          return
        }
        if (
          payloadReceiptStatus === "READ_BY_USER" &&
          !settings.sendReadReceipts
        ) {
          try {
            await apiFetch(`/messages/queue/${item.id}/ack`, { method: "POST" })
          } catch {
            // Best-effort: retry next sync.
          }
          return
        }
        const updates =
          payloadReceiptStatus === "PROCESSED_BY_CLIENT"
            ? { processedAt: payloadReceiptTimestamp }
            : payloadReceiptStatus === "READ_BY_USER"
              ? { readAt: payloadReceiptTimestamp }
              : {}
        if (Object.keys(updates).length > 0) {
          await updateMessageTimestamps({
            messageId: payloadMessageId,
            senderHandle,
            ...updates,
          })
        }
        try {
          await apiFetch(`/messages/queue/${item.id}/ack`, { method: "POST" })
        } catch {
          // Best-effort: retry next sync.
        }
        return
      }

      const handleParts = senderHandle ? splitHandle(senderHandle) : null
      const vaultPayload = await encryptString(
        masterKey,
        JSON.stringify({
          text:
            payloadType === "reaction"
              ? payloadReactionEmoji ?? payload.content
              : payload.content,
          attachments: payload.attachments,
          peerHandle: senderHandle,
          peerUsername: handleParts?.username,
          peerHost: handleParts?.host,
          peerIdentityKey,
          peerTransportKey,
          direction: "in",
          timestamp: item.created_at,
          type: payloadType,
          edited_at: payload.edited_at ?? payload.editedAt,
          deleted_at: payload.deleted_at ?? payload.deletedAt,
          reaction_action:
            payloadType === "reaction" ? normalizedReactionAction : undefined,
          reaction_emoji:
            payloadType === "reaction" ? payloadReactionEmoji : undefined,
          message_id: payloadMessageId,
          reply_to_message_id:
            payload.reply_to_message_id ?? payload.replyToMessageId,
        })
      )
      
      let stored: VaultItem | null = null
      try {
        stored = await apiFetch<VaultItem>(
          `/messages/queue/${item.id}/store`,
          {
            method: "POST",
            body: {
              encrypted_blob: vaultPayload.ciphertext,
              iv: vaultPayload.iv,
              sender_signature_verified: authenticityVerified,
            },
          }
        )
      } catch (e) {
        return
      }

      const contentJson = JSON.stringify({
        encrypted_blob: stored.encrypted_blob,
        iv: stored.iv,
      })

      await db.messages.put({
        id: stored.id,
        ownerId:
          user?.id ??
          user?.handle ??
          stored.owner_id ??
          item.recipient_id,
        senderId: stored.original_sender_handle ?? item.sender_handle,
        peerHandle: senderHandle ?? item.sender_handle,  // Incoming: peer is sender
        content: contentJson,
        verified: stored.sender_signature_verified ?? authenticityVerified,
        isRead: false,
        vaultSynced: true,
        createdAt: stored.created_at ?? item.created_at,
      })

      if (
        payloadType === "message" &&
        senderHandle &&
        peerTransportKey &&
        payloadMessageId
      ) {
        try {
          await sendReceiptEvent({
            recipientHandle: senderHandle,
            recipientTransportKey: peerTransportKey,
            messageId: payloadMessageId,
            status: "PROCESSED_BY_CLIENT",
            timestamp: new Date().toISOString(),
          })
        } catch {
          // Receipts are best-effort.
        }
      }
      
      bumpLastSync()
    },
    [
      masterKey,
      transportPrivateKey,
      user?.id,
      user?.handle,
      sendReceiptEvent,
      settings.sendReadReceipts,
      updateMessageTimestamps,
      onCallMessage,
      bumpLastSync,
    ]
  )

  const processQueue = React.useCallback(async () => {
    if (!masterKey || !transportPrivateKey || isSyncingRef.current) {
      return
    }
    isSyncingRef.current = true
    try {
      const queue = await apiFetch<QueueItem[]>("/messages/queue")
      for (const item of queue) {
        await processSingleQueueItem(item)
      }
    } finally {
      isSyncingRef.current = false
      bumpLastSync()
    }
  }, [masterKey, transportPrivateKey, processSingleQueueItem, bumpLastSync])

  const syncVault = React.useCallback(async () => {
    if (!masterKey) {
      return
    }
    try {
      // Get last sync timestamp from IndexedDB
      const syncRecord = await db.syncState.get("lastVaultSync")
      const lastSyncTime = (syncRecord?.value as string) ?? null

      let cursor: string | null = null
      let totalFetched = 0
      const maxPages = 10 // Safety limit
      let pageCount = 0
      const ownerId = user?.id ?? user?.handle ?? ""

      do {
        const params = new URLSearchParams()
        params.set("limit", "100")
        if (lastSyncTime) params.set("since", lastSyncTime)
        if (cursor) params.set("cursor", cursor)

        const response = await apiFetch<{
          items: VaultItem[]
          nextCursor: string | null
          hasMore: boolean
          syncedAt: string
        }>(`/messages/vault/sync?${params.toString()}`)

        if (response.items.length > 0) {
          // Check which items already exist locally
          const existingRecords = await db.messages
            .where("id")
            .anyOf(response.items.map((item) => item.id))
            .toArray()
          const existingMap = new Map(existingRecords.map((r) => [r.id, r]))

          // Separate new items from updates
          const newItems: VaultItem[] = []
          const updatedItems: VaultItem[] = []

          for (const item of response.items) {
            if (existingMap.has(item.id)) {
              updatedItems.push(item)
            } else {
              newItems.push(item)
            }
          }

          // Insert new items (excluding soft-deleted ones)
          const activeNewItems = newItems.filter((item) => !item.deleted_at)
          if (activeNewItems.length > 0) {
            await db.messages.bulkPut(
              activeNewItems.map((item) => ({
                id: item.id,
                ownerId: item.owner_id || ownerId,
                senderId: item.peer_handle ?? item.original_sender_handle,
                peerHandle: item.peer_handle ?? item.original_sender_handle,
                content: JSON.stringify({
                  encrypted_blob: item.encrypted_blob,
                  iv: item.iv,
                }),
                verified: item.sender_signature_verified,
                isRead: false,
                vaultSynced: true,
                createdAt: item.created_at,
              }))
            )
            totalFetched += activeNewItems.length
          }

          // Handle updates - update content or delete if soft-deleted
          for (const item of updatedItems) {
            if (item.deleted_at) {
              // Soft delete: remove from local DB
              await db.messages.delete(item.id)
            } else {
              // Update content (edits, reactions, etc.)
              await db.messages.update(item.id, {
                content: JSON.stringify({
                  encrypted_blob: item.encrypted_blob,
                  iv: item.iv,
                }),
                senderId: item.peer_handle ?? item.original_sender_handle,
                peerHandle: item.peer_handle ?? item.original_sender_handle,
              })
            }
          }
        }

        cursor = response.nextCursor
        pageCount++

        // Update sync timestamp after last page
        if (!response.hasMore || pageCount >= maxPages) {
          await db.syncState.put({ key: "lastVaultSync", value: response.syncedAt })
        }
      } while (cursor && pageCount < maxPages)
    } finally {
      bumpLastSync()
    }
  }, [masterKey, user?.handle, user?.id, bumpLastSync])

  const syncOutgoingVault = React.useCallback(async () => {
    if (!masterKey || !user?.handle) {
      return
    }
    const ownerId = user.id ?? user.handle
    const records = await db.messages.where("ownerId").equals(ownerId).toArray()
    for (const record of records) {
      if (record.vaultSynced) {
        continue
      }
      let envelope: { encrypted_blob: string; iv: string } | null = null
      try {
        const raw = record.content
        envelope = JSON.parse(raw) as { encrypted_blob: string; iv: string }
      } catch {
        envelope = null
      }
      if (!envelope?.encrypted_blob || !envelope.iv) {
        continue
      }
      let payload: {
        direction?: "in" | "out"
        peerHandle?: string
        peerId?: string
        type?: string
      } = {}
      try {
        const plaintext = await decryptString(masterKey, {
          ciphertext: envelope.encrypted_blob,
          iv: envelope.iv,
        })
        payload = JSON.parse(plaintext) as typeof payload
      } catch {
        continue
      }
      const payloadType = payload.type ?? "message"
      const isCallNotice = payloadType === "call"
      if (!isCallNotice && payload.direction !== "out") {
        await db.messages.update(record.id, { vaultSynced: true })
        continue
      }
      const peerHandle = payload.peerHandle ?? payload.peerId
      if (!peerHandle) {
        continue
      }
      try {
        await apiFetch("/messages/vault", {
          method: "POST",
          body: {
            message_id: record.id,
            original_sender_handle: peerHandle,
            encrypted_blob: envelope.encrypted_blob,
            iv: envelope.iv,
            sender_signature_verified: true,
          },
        })
        await db.messages.update(record.id, { vaultSynced: true })
      } catch {
        // Best-effort: retry on next sync.
      }
    }
  }, [masterKey, user?.handle, user?.id])

  const fetchSummaries = React.useCallback(async () => {
    if (!masterKey) {
      return
    }
    try {
      const rawSummaries = await apiFetch<ConversationSummary[]>("/messages/vault/summaries")
      const decryptedMap = new Map<string, DecryptedSummary>()

      for (const summary of rawSummaries) {
        const peerHandle = summary.peer_handle ?? summary.original_sender_handle
        if (!peerHandle) continue

        try {
          const plaintext = await decryptString(masterKey, {
            ciphertext: summary.encrypted_blob,
            iv: summary.iv,
          })
          const payload = JSON.parse(plaintext) as {
            text?: string
            content?: string
            direction?: "in" | "out"
            timestamp?: string
            isRead?: boolean
          }

          decryptedMap.set(peerHandle, {
            peerHandle,
            lastMessageText: payload.text ?? payload.content ?? "",
            lastMessageTimestamp: payload.timestamp ?? summary.created_at,
            direction: payload.direction ?? "in",
            isRead: payload.isRead ?? false,
          })
        } catch {
          // Skip messages that fail to decrypt
        }
      }

      setSummaries(decryptedMap)
      setSummariesLoaded(true)
    } catch {
      // Best-effort: summaries are optional for fast load
    }
  }, [masterKey])

  // Migration: backfill peerHandle for existing messages that don't have it
  const migratePeerHandle = React.useCallback(async () => {
    if (!masterKey || !user) {
      return
    }
    const ownerId = user.id ?? user.handle
    if (!ownerId) return

    // Check if migration was already done
    const migrationKey = "peerHandleMigrationDone"
    const migrationRecord = await db.syncState.get(migrationKey)
    if (migrationRecord?.value === true) {
      return
    }

    // Get all messages for this owner that might need peerHandle backfill
    const allRecords = await db.messages
      .where("ownerId")
      .equals(ownerId)
      .toArray()

    // Filter records that don't have peerHandle
    const needsMigration = allRecords.filter((r) => !r.peerHandle)
    if (needsMigration.length === 0) {
      // Mark migration as complete
      await db.syncState.put({ key: migrationKey, value: true })
      return
    }

    // Process in batches of 50 to avoid blocking UI
    const batchSize = 50
    for (let i = 0; i < needsMigration.length; i += batchSize) {
      const batch = needsMigration.slice(i, i + batchSize)
      const updates: Array<{ id: string; peerHandle: string }> = []

      for (const record of batch) {
        try {
          const envelope = JSON.parse(record.content) as {
            encrypted_blob: string
            iv: string
          }
          if (!envelope?.encrypted_blob || !envelope.iv) continue

          const plaintext = await decryptString(masterKey, {
            ciphertext: envelope.encrypted_blob,
            iv: envelope.iv,
          })
          const payload = JSON.parse(plaintext) as {
            peerHandle?: string
            peerId?: string
            direction?: "in" | "out"
          }

          // Extract peerHandle from payload
          const peerHandle = payload.peerHandle ?? payload.peerId
          if (peerHandle) {
            updates.push({ id: record.id, peerHandle })
          } else if (payload.direction === "in" && record.senderId) {
            // For incoming messages, peer is the sender
            updates.push({ id: record.id, peerHandle: record.senderId })
          }
        } catch {
          // Skip records that fail to decrypt
        }
      }

      // Bulk update records with peerHandle
      for (const update of updates) {
        await db.messages.update(update.id, { peerHandle: update.peerHandle })
      }

      // Yield to UI between batches
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    // Mark migration as complete
    await db.syncState.put({ key: migrationKey, value: true })
  }, [masterKey, user])

  const runSync = React.useCallback(async () => {
    if (!masterKey || !transportPrivateKey) {
      return
    }

    // Phase 1: Fast - get to usable UI quickly
    try {
      await processQueue()
    } catch {
      // Continue even if queue fetch fails
    }
    try {
      await fetchSummaries()
    } catch {
      // Summaries are optional for fast load
    }

    // Phase 2: Background - full sync (non-blocking)
    // Use setTimeout to allow UI to render before heavy sync
    setTimeout(async () => {
      try {
        await syncVault()
      } catch {
        // Best-effort
      }
      try {
        await syncOutgoingVault()
      } catch {
        // Best-effort
      }
      try {
        await migratePeerHandle()
      } catch {
        // Best-effort migration
      }
    }, 100)
  }, [
    masterKey,
    transportPrivateKey,
    processQueue,
    fetchSummaries,
    syncVault,
    syncOutgoingVault,
    migratePeerHandle,
  ])

  React.useEffect(() => {
    if (!masterKey || !transportPrivateKey) {
      return
    }
    void runSync()
  }, [masterKey, transportPrivateKey, runSync])

  React.useEffect(() => {
    if (!masterKey) {
      return
    }
    const runVaultSync = async () => {
      try {
        await syncVault()
      } catch {
        // Best-effort.
      }
      try {
        await syncOutgoingVault()
      } catch {
        // Best-effort.
      }
    }
    void runVaultSync()
  }, [masterKey, syncVault, syncOutgoingVault])

  React.useEffect(() => {
    if (!masterKey || !transportPrivateKey) {
      return
    }
    const url = process.env.NEXT_PUBLIC_API_URL
    if (!url) {
      return
    }
    const token = getAuthToken()
    const socket = io(url, {
      withCredentials: true,
      auth: token ? { token: `Bearer ${token}` } : undefined,
    })
    const handler = async (payload: QueueItem) => {
      // Deduplication check
      if (payload?.id && processedIdsRef.current.has(payload.id)) {
        return
      }
      if (payload?.id) {
        processedIdsRef.current.add(payload.id)
        // Clean up old IDs (keep last 1000)
        if (processedIdsRef.current.size > 1000) {
          const ids = Array.from(processedIdsRef.current)
          ids.slice(0, 500).forEach((id) => processedIdsRef.current.delete(id))
        }
      }
      // If the payload has the encrypted blob, process it directly.
      if (payload && payload.encrypted_blob) {
        void processSingleQueueItem(payload)
      } else {
        // Fallback for backward compatibility or if full payload isn't sent
        void runSync()
      }
    }
    socket.on("connect", () => {
    })
    socket.on("connect_error", () => {
    })
    socket.on("INCOMING_MESSAGE", handler)

    // Handle outgoing messages synced from other devices
    const outgoingHandler = async (payload: {
      message_id: string
      owner_id?: string
      original_sender_handle: string
      encrypted_blob: string
      iv: string
      sender_signature_verified: boolean
      created_at: string
    }) => {
      if (!payload?.message_id || !payload?.encrypted_blob || !payload?.iv) {
        return
      }
      // Deduplication check
      if (processedIdsRef.current.has(payload.message_id)) {
        return
      }
      processedIdsRef.current.add(payload.message_id)
      // Clean up old IDs (keep last 1000)
      if (processedIdsRef.current.size > 1000) {
        const ids = Array.from(processedIdsRef.current)
        ids.slice(0, 500).forEach((id) => processedIdsRef.current.delete(id))
      }
      // Check if message already exists locally
      const existing = await db.messages.get(payload.message_id)
      if (existing) {
        bumpLastSync()
        onVaultMessageSynced?.(payload.message_id, "upsert")
        return
      }
      // Store the outgoing message from another device
      const ownerId = payload.owner_id ?? user?.id ?? user?.handle ?? ""
      // Use original_sender_handle for both senderId and peerHandle to match syncVault behavior
      // This ensures consistent decoding for both regular messages and call events
      await db.messages.put({
        id: payload.message_id,
        ownerId,
        senderId: payload.original_sender_handle,
        peerHandle: payload.original_sender_handle,
        content: JSON.stringify({
          encrypted_blob: payload.encrypted_blob,
          iv: payload.iv,
        }),
        verified: payload.sender_signature_verified,
        isRead: true, // Our own messages are always read
        vaultSynced: true,
        createdAt: payload.created_at,
      })
      bumpLastSync()
      onVaultMessageSynced?.(payload.message_id, "upsert")
    }
    socket.on("OUTGOING_MESSAGE_SYNCED", outgoingHandler)

    // Handle incoming messages synced from other devices (when another device stored the message to vault)
    const incomingSyncedHandler = async (payload: {
      id: string
      owner_id: string
      original_sender_handle: string
      encrypted_blob: string
      iv: string
      sender_signature_verified: boolean
      created_at: string
    }) => {
      if (!payload?.id || !payload?.encrypted_blob || !payload?.iv) {
        return
      }
      // Deduplication check
      if (processedIdsRef.current.has(payload.id)) {
        return
      }
      processedIdsRef.current.add(payload.id)
      // Clean up old IDs (keep last 1000)
      if (processedIdsRef.current.size > 1000) {
        const ids = Array.from(processedIdsRef.current)
        ids.slice(0, 500).forEach((id) => processedIdsRef.current.delete(id))
      }
      // Check if message already exists locally
      const existing = await db.messages.get(payload.id)
      if (existing) {
        bumpLastSync()
        onVaultMessageSynced?.(payload.id, "upsert")
        return
      }
      // Store the incoming message that was stored to vault by another device
      const ownerId = payload.owner_id ?? user?.id ?? user?.handle ?? ""
      await db.messages.put({
        id: payload.id,
        ownerId,
        senderId: payload.original_sender_handle,
        peerHandle: payload.original_sender_handle, // Incoming: peer is sender
        content: JSON.stringify({
          encrypted_blob: payload.encrypted_blob,
          iv: payload.iv,
        }),
        verified: payload.sender_signature_verified,
        isRead: false,
        vaultSynced: true,
        createdAt: payload.created_at,
      })
      bumpLastSync()
      onVaultMessageSynced?.(payload.id, "upsert")
    }
    socket.on("INCOMING_MESSAGE_SYNCED", incomingSyncedHandler)

    // Handle vault message updates from other devices (edits, reactions, deletes)
    const vaultUpdateHandler = async (payload: {
      id: string
      encrypted_blob: string
      iv: string
      version: number
      deleted_at: string | null
      updated_at: string
    }) => {
      if (!payload?.id) {
        return
      }
      if (payload.deleted_at) {
        // Soft delete: remove from local DB
        await db.messages.delete(payload.id)
        onVaultMessageSynced?.(payload.id, "delete")
      } else {
        // Update content
        await db.messages.update(payload.id, {
          content: JSON.stringify({
            encrypted_blob: payload.encrypted_blob,
            iv: payload.iv,
          }),
        })
        onVaultMessageSynced?.(payload.id, "upsert")
      }
      bumpLastSync()
    }
    socket.on("VAULT_MESSAGE_UPDATED", vaultUpdateHandler)

    return () => {
      socket.off("connect")
      socket.off("connect_error")
      socket.off("INCOMING_MESSAGE", handler)
      socket.off("OUTGOING_MESSAGE_SYNCED", outgoingHandler)
      socket.off("INCOMING_MESSAGE_SYNCED", incomingSyncedHandler)
      socket.off("VAULT_MESSAGE_UPDATED", vaultUpdateHandler)
      socket.disconnect()
    }
  }, [
    masterKey,
    transportPrivateKey,
    runSync,
    user?.handle,
    user?.id,
    processSingleQueueItem,
    bumpLastSync,
    onVaultMessageSynced,
  ])

  return { processQueue, syncVault, runSync, lastSync, summaries, summariesLoaded, fetchSummaries }
}
