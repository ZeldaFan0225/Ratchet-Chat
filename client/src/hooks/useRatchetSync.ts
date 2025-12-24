"use client"

import * as React from "react"
import { io } from "socket.io-client"
import { useAuth } from "@/context/AuthContext"
import { useSettings } from "@/hooks/useSettings"
import { apiFetch, getAuthToken } from "@/lib/api"
import {
  buildMessageSignaturePayload,
  decodeUtf8,
  decryptTransitBlob,
  decryptString,
  encodeUtf8,
  encryptString,
  verifySignature,
} from "@/lib/crypto"
import { splitHandle } from "@/lib/handles"
import { db, type ReceiptStatus } from "@/lib/db"

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
  senderSignature?: string
  sender_signature?: string
  senderIdentityKey?: string
  sender_identity_key?: string
  senderHandle?: string
  sender_handle?: string
  messageId?: string
  message_id?: string
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

type ReceiptBase = {
  id?: string
  message_id: string
  type: ReceiptStatus
  timestamp: string
}

type ReceiptItem = ReceiptBase & { id: string }

type ReceiptEvent = ReceiptBase

const RECEIPT_CURSOR_PREFIX = "ratchet-chat:receipts:since"
const RECEIPT_PENDING_PREFIX = "ratchet-chat:receipts:pending"

function receiptCursorKey(handle?: string | null) {
  return handle ? `${RECEIPT_CURSOR_PREFIX}:${handle}` : null
}

function receiptPendingKey(handle?: string | null) {
  return handle ? `${RECEIPT_PENDING_PREFIX}:${handle}` : null
}

async function loadReceiptCursor(handle?: string | null): Promise<string | null> {
  const key = receiptCursorKey(handle)
  if (!key) {
    return null
  }
  const record = await db.syncState.get(key)
  return (record?.value as string) ?? null
}

async function storeReceiptCursor(handle: string | null | undefined, value: string) {
  const key = receiptCursorKey(handle)
  if (!key) {
    return
  }
  await db.syncState.put({ key, value })
}

async function loadPendingReceipts(handle?: string | null): Promise<ReceiptBase[]> {
  const key = receiptPendingKey(handle)
  if (!key) {
    return []
  }
  const record = await db.syncState.get(key)
  if (!record || !record.value) {
    return []
  }
  return record.value as ReceiptItem[]
}

async function storePendingReceipts(
  handle: string | null | undefined,
  receipts: ReceiptBase[]
) {
  const key = receiptPendingKey(handle)
  if (!key) {
    return
  }
  if (receipts.length === 0) {
    await db.syncState.delete(key)
    return
  }
  await db.syncState.put({ key, value: receipts })
}

const receiptRank: Record<ReceiptStatus, number> = {
  DELIVERED_TO_SERVER: 1,
  PROCESSED_BY_CLIENT: 2,
  READ_BY_USER: 3,
}

function getReceiptRank(value?: ReceiptStatus) {
  if (!value) {
    return 0
  }
  return receiptRank[value] ?? 0
}

function normalizeReceipts(receipts: ReceiptBase[]) {
  const map = new Map<string, ReceiptBase>()
  for (const receipt of receipts) {
    const existing = map.get(receipt.message_id)
    if (!existing) {
      map.set(receipt.message_id, receipt)
      continue
    }
    const existingRank = getReceiptRank(existing.type)
    const nextRank = getReceiptRank(receipt.type)
    if (nextRank > existingRank) {
      map.set(receipt.message_id, receipt)
      continue
    }
    if (
      nextRank === existingRank &&
      new Date(receipt.timestamp) > new Date(existing.timestamp)
    ) {
      map.set(receipt.message_id, receipt)
    }
  }
  return Array.from(map.values())
}

export function useRatchetSync() {
  const { masterKey, transportPrivateKey, user } = useAuth()
  const { settings } = useSettings()
  const isSyncingRef = React.useRef(false)
  const directoryCacheRef = React.useRef(new Map<string, DirectoryEntry>())
  const [lastSync, setLastSync] = React.useState(0)

  const applyReceipts = React.useCallback(
    async (handle: string | null | undefined, receipts: ReceiptEvent[]) => {
      if (receipts.length === 0) {
        return false
      }
      const pending = await loadPendingReceipts(handle)
      const combined = normalizeReceipts([...pending, ...receipts])
      const remaining: ReceiptBase[] = []
      let updated = false
      for (const receipt of combined) {
        const record = await db.messages.get(receipt.message_id)
        if (!record) {
          remaining.push(receipt)
          continue
        }
        const currentRank = getReceiptRank(record.receiptStatus)
        const nextRank = getReceiptRank(receipt.type)
        if (nextRank <= currentRank) {
          continue
        }
        await db.messages.update(receipt.message_id, {
          receiptStatus: receipt.type,
        })
        updated = true
      }
      await storePendingReceipts(handle, remaining)
      return updated
    },
    []
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
          text: payload.content,
          peerHandle: senderHandle,
          peerUsername: handleParts?.username,
          peerHost: handleParts?.host,
          peerIdentityKey,
          peerTransportKey,
          direction: "in",
          timestamp: item.created_at,
          message_id: payloadMessageId,
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
        readReceiptSent: false,
        vaultSynced: true,
        createdAt: stored.created_at ?? item.created_at,
      })


      try {
        await apiFetch("/receipts", {
          method: "POST",
          body: {
            recipient_handle: item.sender_handle,
            message_id: payloadMessageId ?? item.id,
            type: "PROCESSED_BY_CLIENT",
          },
        })
      } catch {
        // Receipts are best-effort.
      }
      
      setLastSync(Date.now())
    },
    [masterKey, transportPrivateKey, user?.id, user?.handle]
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

  const syncReceipts = React.useCallback(async () => {
    if (!user?.handle && !user?.id) {
      return
    }
    const handle = user?.handle
    const since = await loadReceiptCursor(handle)
    const query = since ? `?since=${encodeURIComponent(since)}` : ""
    try {
      const receipts = await apiFetch<ReceiptItem[]>(`/receipts${query}`)
      const filteredReceipts = receipts.filter(
        (r) => r.type !== "READ_BY_USER" || settings.sendReadReceipts
      )
      
      let latestTimestamp = since ? new Date(since) : new Date(0)
      for (const receipt of receipts) {
        const receiptTime = new Date(receipt.timestamp)
        if (
          !Number.isNaN(receiptTime.valueOf()) &&
          receiptTime > latestTimestamp
        ) {
          latestTimestamp = receiptTime
        }
      }
      await applyReceipts(handle, filteredReceipts)
      if (receipts.length > 0) {
        await storeReceiptCursor(handle, latestTimestamp.toISOString())
      }
    } finally {
      setLastSync(Date.now())
    }
  }, [applyReceipts, user?.handle, user?.id, settings.sendReadReceipts])

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
          readReceiptSent: false,
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
    try {
      await syncReceipts()
    } catch {
      // Best-effort.
    }
  }, [
    masterKey,
    transportPrivateKey,
    processQueue,
    syncVault,
    syncOutgoingVault,
    syncReceipts,
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
      try {
        await syncReceipts()
      } catch {
        // Best-effort.
      }
    }
    void runVaultSync()
  }, [masterKey, syncVault, syncOutgoingVault, syncReceipts])

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
    const handleReceiptEvent = async (payload: ReceiptEvent) => {
      const handle = user?.handle
      if (!payload?.message_id || !payload?.type) {
        return
      }
      if (payload.type === "READ_BY_USER" && !settings.sendReadReceipts) {
        return
      }
      const updated = await applyReceipts(handle, [payload])
      if (updated) {
        setLastSync(Date.now())
      }
    }
    socket.on("connect", () => {
    })
    socket.on("connect_error", (err) => {
    })
    socket.on("INCOMING_MESSAGE", handler)
    socket.on("RECEIPT_UPDATE", handleReceiptEvent)
    return () => {
      socket.off("connect")
      socket.off("connect_error")
      socket.off("INCOMING_MESSAGE", handler)
      socket.off("RECEIPT_UPDATE", handleReceiptEvent)
      socket.disconnect()
    }
  }, [masterKey, transportPrivateKey, runSync, applyReceipts, user?.handle, processSingleQueueItem, settings.sendReadReceipts])

  return { processQueue, syncVault, syncReceipts, runSync, lastSync }
}
