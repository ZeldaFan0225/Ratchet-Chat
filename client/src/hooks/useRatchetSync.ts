"use client"

import * as React from "react"
import { io } from "socket.io-client"
import { useAuth } from "@/context/AuthContext"
import { apiFetch, getAuthToken } from "@/lib/api"
import {
  buildMessageSignaturePayload,
  decodeUtf8,
  decryptTransitBlob,
  decryptString,
  encodeUtf8,
  encryptTransitEnvelope,
  encryptString,
  getIdentityPublicKey,
  signMessage,
  verifySignature,
} from "@/lib/crypto"
import { splitHandle } from "@/lib/handles"
import { db } from "@/lib/db"

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
  original_sender_handle: string
  encrypted_blob: string
  iv: string
  sender_signature_verified: boolean
  created_at: string
}

type TransitPayload = {
  content?: string
  message?: string
  plaintext?: string
  attachments?: Attachment[]
  type?: "edit" | "delete" | "reaction" | "receipt" | "message"
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

export function useRatchetSync() {
  const { masterKey, transportPrivateKey, identityPrivateKey, user } = useAuth()
  const isSyncingRef = React.useRef(false)
  const directoryCacheRef = React.useRef(new Map<string, DirectoryEntry>())
  const [lastSync, setLastSync] = React.useState(0)

  const sendReceiptEvent = React.useCallback(
    async (params: {
      recipientHandle: string
      recipientTransportKey: string
      messageId: string
      status: ReceiptEventStatus
      timestamp: string
    }) => {
      if (!identityPrivateKey || !user?.handle) {
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
        sender_identity_key: getIdentityPublicKey(identityPrivateKey),
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
        },
      })
    },
    [identityPrivateKey, user?.handle]
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
          receipt_status:
            payloadType === "receipt" ? payloadReceiptStatus : undefined,
          receipt_timestamp:
            payloadType === "receipt" ? payloadReceiptTimestamp : undefined,
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
      
      setLastSync(Date.now())
    },
    [masterKey, transportPrivateKey, user?.id, user?.handle, sendReceiptEvent]
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
      setLastSync(Date.now())
    }
  }, [masterKey, transportPrivateKey, processSingleQueueItem])

  const syncVault = React.useCallback(async () => {
    if (!masterKey) {
      return
    }
    try {
      const vault = await apiFetch<VaultItem[]>("/messages/vault?order=desc")
      const ownerId = user?.id ?? user?.handle ?? ""
      const existingIds = ownerId
        ? new Set(
            (await db.messages
              .where("ownerId")
              .equals(ownerId)
              .primaryKeys()) as string[]
          )
        : new Set<string>()
      const missing = vault.filter((item) => !existingIds.has(item.id))
      if (missing.length === 0) {
        return
      }
      await db.messages.bulkPut(
        missing.map((item) => ({
          id: item.id,
          ownerId: item.owner_id,
          senderId: item.original_sender_handle,
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
    } finally {
      setLastSync(Date.now())
    }
  }, [masterKey, user?.handle, user?.id])

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
      if (payload.direction !== "out") {
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

  const runSync = React.useCallback(async () => {
    if (!masterKey || !transportPrivateKey) {
      return
    }
    try {
      await processQueue()
    } catch {
      // Continue to vault sync even if queue fetch fails.
    }
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
  }, [
    masterKey,
    transportPrivateKey,
    processQueue,
    syncVault,
    syncOutgoingVault,
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
    const handler = (payload: QueueItem) => {
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
    socket.on("connect_error", (err) => {
    })
    socket.on("INCOMING_MESSAGE", handler)
    return () => {
      socket.off("connect")
      socket.off("connect_error")
      socket.off("INCOMING_MESSAGE", handler)
      socket.disconnect()
    }
  }, [masterKey, transportPrivateKey, runSync, user?.handle, processSingleQueueItem])

  return { processQueue, syncVault, runSync, lastSync }
}
