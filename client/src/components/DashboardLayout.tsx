"use client"

import * as React from "react"
import {
  Check,
  CheckCheck,
  Download,
  Info,
  MoreVertical,
  Paperclip,
  Search,
  Send,
  ShieldCheck,
  Trash2,
} from "lucide-react"

import { AppSidebar, type ConversationPreview } from "@/components/app-sidebar"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useAuth } from "@/context/AuthContext"
import { useRatchetSync } from "@/hooks/useRatchetSync"
import { apiFetch } from "@/lib/api"
import {
  decryptString,
  buildMessageSignaturePayload,
  encryptString,
  encryptTransitEnvelope,
  getIdentityPublicKey,
  signMessage,
} from "@/lib/crypto"
import { getInstanceHost, normalizeHandle, splitHandle } from "@/lib/handles"
import { db, type MessageRecord, type ContactRecord } from "@/lib/db"
import { cn } from "@/lib/utils"
import { logClientEvent } from "@/lib/client-logger"

type Contact = {
  handle: string
  username: string
  host: string
  publicIdentityKey: string
  publicTransportKey: string
}

type StoredMessage = {
  id: string
  peerHandle: string
  peerUsername?: string
  peerHost?: string
  peerIdentityKey?: string
  peerTransportKey?: string
  direction: "in" | "out"
  text: string
  timestamp: string
  verified: boolean
  isRead: boolean
  receiptStatus?: MessageRecord["receiptStatus"]
  messageId?: string
  readReceiptSent?: boolean
}

type DirectoryEntry = {
  id?: string
  handle: string
  host: string
  public_identity_key: string
  public_transport_key: string
}

async function decodeContactRecord(
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
    }
  } catch {
    return null
  }
}

async function saveContactRecord(
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
    createdAt: new Date().toISOString(),
  })
}

async function decodeMessageRecord(
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
      peerId?: string
      peerHandle?: string
      peerUsername?: string
      peerHost?: string
      direction?: "in" | "out"
      timestamp?: string
      peerIdentityKey?: string
      peerTransportKey?: string
      messageId?: string
      message_id?: string
    } = {}
    try {
      payload = JSON.parse(plaintext) as typeof payload
    } catch {
      payload = { text: plaintext }
    }
    const text = payload.text ?? payload.content ?? plaintext
    const direction = payload.direction ?? "in"
    const isRead = record.isRead ?? direction === "out"
    const messageId =
      payload.messageId ??
      payload.message_id ??
      (direction === "out" ? record.id : undefined)
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
      timestamp: payload.timestamp ?? record.createdAt,
      verified: record.verified,
      isRead,
      receiptStatus: record.receiptStatus,
      messageId,
      readReceiptSent: record.readReceiptSent,
    }
  } catch {
    return null
  }
}

function formatTimestamp(isoString: string) {
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

export function DashboardLayout() {
  const { user, masterKey, identityPrivateKey, logout } = useAuth()
  const { lastSync } = useRatchetSync()
  const instanceHost = getInstanceHost()
  const [contacts, setContacts] = React.useState<Contact[]>([])
  const [activeId, setActiveId] = React.useState<string>("")
  const [messages, setMessages] = React.useState<StoredMessage[]>([])
  const [composeText, setComposeText] = React.useState("")
  const [startError, setStartError] = React.useState<string | null>(null)
  const [sendError, setSendError] = React.useState<string | null>(null)
  const [isBusy, setIsBusy] = React.useState(false)
  const [sidebarSearchQuery, setSidebarSearchQuery] = React.useState("")
  const [chatSearchQuery, setChatSearchQuery] = React.useState("")
  const [isChatSearchOpen, setIsChatSearchOpen] = React.useState(false)
  const [scrollToMessageId, setScrollToMessageId] = React.useState<string | null>(null)
  const [highlightedMessageId, setHighlightedMessageId] = React.useState<string | null>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  // Effect 1: Handle scrolling to a specific message
  React.useEffect(() => {
    if (!scrollToMessageId) return

    // Small timeout to ensure DOM has rendered if chat switched
    const timer = setTimeout(() => {
      const element = document.getElementById(`message-${scrollToMessageId}`)
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" })
        setHighlightedMessageId(scrollToMessageId)
        // Clear the target so future auto-scrolls work, but do it silently
        // We don't want to trigger the "scroll to bottom" effect here
        setScrollToMessageId(null)
        
        setTimeout(() => setHighlightedMessageId(null), 3000)
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [scrollToMessageId])

  // Effect 2: Handle auto-scroll to bottom (on new message or chat switch)
  React.useEffect(() => {
    // If we have a specific target, don't auto-scroll to bottom
    if (scrollToMessageId || chatSearchQuery) return

    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: "smooth" })
    }
  }, [messages, activeId, chatSearchQuery]) // Removed scrollToMessageId from dependencies to avoid re-triggering on clear

  React.useEffect(() => {
    if (!user?.handle || !masterKey) {
      setContacts([])
      setActiveId("")
      return
    }
    const ownerId = user.id ?? user.handle
    const load = async () => {
      const records = await db.contacts
        .where("ownerId")
        .equals(ownerId)
        .toArray()
      const decoded = await Promise.all(
        records.map((record) => decodeContactRecord(record, masterKey))
      )
      const nextContacts = decoded.filter(Boolean) as Contact[]
      setContacts(nextContacts)
      if (nextContacts.length > 0) {
        setActiveId((current) => current || nextContacts[0].handle)
      }
    }
    void load()
  }, [user?.handle, user?.id, masterKey])

  React.useEffect(() => {
    if (!activeId && contacts.length > 0) {
      setActiveId(contacts[0].handle)
    }
  }, [activeId, contacts])

  React.useEffect(() => {
    if (!masterKey || !user) {
      return
    }
    const loadMessages = async () => {
      const ownerKeys = [user.id, user.handle].filter(
        (value): value is string => Boolean(value)
      )
      if (ownerKeys.length === 0) {
        setMessages([])
        return
      }
      const records =
        ownerKeys.length === 1
          ? await db.messages.where("ownerId").equals(ownerKeys[0]).toArray()
          : await db.messages.where("ownerId").anyOf(ownerKeys).toArray()
      const decoded = await Promise.all(
        records.map((record) =>
          decodeMessageRecord(record, masterKey, record.senderId)
        )
      )
      const nextMessages = decoded.filter(Boolean) as StoredMessage[]
      setMessages(nextMessages)
    }
    void loadMessages()
  }, [masterKey, lastSync, user])

  React.useEffect(() => {
    if (!masterKey || !user || messages.length === 0) {
      return
    }
    const ownerId = user.id ?? user.handle
    const pendingSaves: Contact[] = []
    setContacts((current) => {
      let changed = false
      const next = [...current]
      for (const message of messages) {
        const index = next.findIndex(
          (contact) => contact.handle === message.peerHandle
        )
        if (index === -1) {
          const parts = splitHandle(message.peerHandle)
          const contact = {
            handle: message.peerHandle,
            username:
              message.peerUsername ??
              parts?.username ??
              `Unknown ${message.peerHandle.slice(0, 8)}`,
            host: message.peerHost ?? parts?.host ?? "",
            publicIdentityKey: message.peerIdentityKey ?? "",
            publicTransportKey: message.peerTransportKey ?? "",
          }
          next.push(contact)
          pendingSaves.push(contact)
          changed = true
          continue
        }
        const existing = next[index]
        const updates: Partial<Contact> = {}
        if (
          message.peerUsername &&
          existing.username.startsWith("Unknown ")
        ) {
          updates.username = message.peerUsername
        }
        if (message.peerHost && !existing.host) {
          updates.host = message.peerHost
        }
        if (message.peerIdentityKey && !existing.publicIdentityKey) {
          updates.publicIdentityKey = message.peerIdentityKey
        }
        if (message.peerTransportKey && !existing.publicTransportKey) {
          updates.publicTransportKey = message.peerTransportKey
        }
        if (Object.keys(updates).length > 0) {
          const updatedContact = { ...existing, ...updates }
          next[index] = updatedContact
          pendingSaves.push(updatedContact)
          changed = true
        }
      }
      if (!changed) {
        return current
      }
      return next
    })
    if (pendingSaves.length > 0) {
      void Promise.all(
        pendingSaves.map((contact) =>
          saveContactRecord(masterKey, ownerId, contact)
        )
      )
    }
  }, [messages, masterKey, user])

  const messagesByPeer = React.useMemo(() => {
    const map = new Map<string, StoredMessage[]>()
    for (const message of messages) {
      const bucket = map.get(message.peerHandle) ?? []
      bucket.push(message)
      map.set(message.peerHandle, bucket)
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    }
    return map
  }, [messages])

  const conversations = React.useMemo<ConversationPreview[]>(() => {
    const query = sidebarSearchQuery.toLowerCase().trim()
    
    if (!query) {
      return contacts.map((contact) => {
        const thread = messagesByPeer.get(contact.handle) ?? []
        const lastMessage = thread[thread.length - 1]
        const isActive = contact.handle === activeId
        const unread = isActive
          ? 0
          : thread.filter((m) => m.direction === "in" && !m.isRead).length
        
        return {
          id: contact.handle,
          uid: contact.handle,
          name: contact.username,
          handle: contact.handle,
          lastMessage: lastMessage?.text ?? "No messages yet",
          lastTimestamp: formatTimestamp(lastMessage?.timestamp ?? ""),
          unread,
          status: "offline",
        }
      })
    }

    const results: ConversationPreview[] = []

    // 1. Chats matching contact name/handle
    const matchingContacts = contacts.filter((contact) => 
      contact.username.toLowerCase().includes(query) ||
      contact.handle.toLowerCase().includes(query)
    )

    for (const contact of matchingContacts) {
      const thread = messagesByPeer.get(contact.handle) ?? []
      const lastMessage = thread[thread.length - 1]
      const isActive = contact.handle === activeId
      const unread = isActive
        ? 0
        : thread.filter((m) => m.direction === "in" && !m.isRead).length

      results.push({
        id: contact.handle,
        uid: contact.handle,
        name: contact.username,
        handle: contact.handle,
        lastMessage: lastMessage?.text ?? "No messages yet",
        lastTimestamp: formatTimestamp(lastMessage?.timestamp ?? ""),
        unread,
        status: "offline",
      })
    }

    // 2. Found messages
    for (const contact of contacts) {
      const thread = messagesByPeer.get(contact.handle) ?? []
      const matchingMessages = thread.filter((msg) => 
        msg.text.toLowerCase().includes(query)
      )

      for (const msg of matchingMessages) {
        // Create an entry for each matching message
        results.push({
          id: contact.handle,
          uid: `${contact.handle}:${msg.id}`,
          name: contact.username,
          handle: contact.handle,
          lastMessage: msg.text,
          lastTimestamp: formatTimestamp(msg.timestamp),
          unread: 0, // Search results typically don't show unread counts for the message itself
          status: "offline",
          foundMessageId: msg.id
        })
      }
    }

    return results
  }, [contacts, messagesByPeer, activeId, sidebarSearchQuery])

  const activeContact =
    contacts.find((contact) => contact.handle === activeId) ?? null
  const activeMessagesRaw = activeContact
    ? messagesByPeer.get(activeContact.handle) ?? []
    : []

  const activeMessages = React.useMemo(() => {
    if (!chatSearchQuery.trim()) {
      return activeMessagesRaw
    }
    const lower = chatSearchQuery.toLowerCase()
    return activeMessagesRaw.filter((msg) => msg.text.toLowerCase().includes(lower))
  }, [activeMessagesRaw, chatSearchQuery])

  React.useEffect(() => {
    if (!activeContact) {
      return
    }
    const unreadMessages = activeMessagesRaw.filter(
      (message) => message.direction === "in" && !message.isRead
    )
    const unreadIds = unreadMessages.map((message) => message.id)
    const receiptTargets = activeMessagesRaw.filter(
      (message) =>
        message.direction === "in" &&
        message.messageId &&
        message.peerHandle &&
        !message.readReceiptSent
    )
    if (unreadIds.length === 0 && receiptTargets.length === 0) {
      return
    }
    // ... markRead logic continues ...
    const markRead = async () => {
      if (typeof document !== "undefined" && (document.hidden || !document.hasFocus())) {
        return
      }
      if (unreadIds.length > 0) {
        await db.messages.where("id").anyOf(unreadIds).modify({ isRead: true })
        setMessages((current) =>
          current.map((message) =>
            unreadIds.includes(message.id)
              ? { ...message, isRead: true }
              : message
          )
        )
      }
      const sentIds: string[] = []
      for (const message of receiptTargets) {
        const messageId = message.messageId
        const peerHandle = message.peerHandle
        if (!messageId || !peerHandle) {
          continue
        }
        try {
          await apiFetch("/receipts", {
            method: "POST",
            body: {
              recipient_handle: peerHandle,
              message_id: messageId,
              type: "READ_BY_USER",
            },
          })
          sentIds.push(message.id)
        } catch {
          // Best-effort: keep unsent receipts for the next open.
        }
      }
      if (sentIds.length > 0) {
        await db.messages
          .where("id")
          .anyOf(sentIds)
          .modify({ readReceiptSent: true })
        setMessages((current) =>
          current.map((message) =>
            sentIds.includes(message.id)
              ? { ...message, readReceiptSent: true }
              : message
          )
        )
      }
    }
    void markRead()

    const handleVisibilityChange = () => void markRead()
    const handleFocus = () => void markRead()

    document.addEventListener("visibilitychange", handleVisibilityChange)
    window.addEventListener("focus", handleFocus)
    
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("focus", handleFocus)
    }
  }, [activeContact, activeMessagesRaw])

  const handleDeleteChat = React.useCallback(async () => {
    if (!activeContact || !user) return
    const confirmDelete = window.confirm(
      `Are you sure you want to delete the chat with ${activeContact.username}? This cannot be undone.`
    )
    if (!confirmDelete) return

    const ownerId = user.id ?? user.handle
    // Delete messages locally
    const threadMessages = messagesByPeer.get(activeContact.handle) ?? []
    const ids = threadMessages.map((m) => m.id)
    await db.messages.bulkDelete(ids)
    
    // Delete contact locally
    await db.contacts.delete(activeContact.handle)

    // Delete from server vault
    try {
      await apiFetch("/messages/vault/delete-chat", {
        method: "POST",
        body: { peer_handle: activeContact.handle },
      })
    } catch (error) {
      console.error("Failed to delete chat from server:", error)
    }

    // Update state
    setContacts((prev) => prev.filter((c) => c.handle !== activeContact.handle))
    setMessages((prev) => prev.filter((m) => !ids.includes(m.id)))
    setActiveId("")
  }, [activeContact, user, messagesByPeer])

  const handleExportChat = React.useCallback(() => {
    if (!activeContact) return
    const threadMessages = messagesByPeer.get(activeContact.handle) ?? []
    const exportData = {
      contact: activeContact,
      messages: threadMessages.map(m => ({
        ...m,
        timestamp: new Date(m.timestamp).toISOString()
      }))
    }
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `chat-export-${activeContact.username}-${new Date().toISOString().split('T')[0]}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [activeContact, messagesByPeer])

  const handleStartChat = React.useCallback(
    async (handleInput: string) => {
      setStartError(null)
      setIsBusy(true)
      try {
        const normalized = normalizeHandle(handleInput)
        const parts = splitHandle(normalized)
        if (!parts) {
          throw new Error("Enter a valid handle like alice@host")
        }
        const entry = await apiFetch<DirectoryEntry>(
          `/api/directory?handle=${encodeURIComponent(normalized)}`
        )
        const handle = entry.handle ?? normalized
        const handleParts = splitHandle(handle) ?? parts
        const nextContact: Contact = {
          handle,
          username: handleParts.username,
          host: handleParts.host,
          publicIdentityKey: entry.public_identity_key,
          publicTransportKey: entry.public_transport_key,
        }
        if (masterKey && user?.handle) {
          const ownerId = user.id ?? user.handle
          await saveContactRecord(masterKey, ownerId, nextContact)
        }
        setContacts((current) => {
          const index = current.findIndex(
            (contact) => contact.handle === nextContact.handle
          )
          let next = current
          if (index >= 0) {
            next = [...current]
            next[index] = {
              ...current[index],
              username: nextContact.username,
              host: nextContact.host,
              publicIdentityKey: nextContact.publicIdentityKey,
              publicTransportKey: nextContact.publicTransportKey,
            }
          } else {
            next = [nextContact, ...current]
          }
          return next
        })
        setActiveId(nextContact.handle)
        void logClientEvent({
          level: "info",
          event: "contact.start_chat",
          payload: {
            handle: nextContact.handle,
            host: nextContact.host,
            has_identity_key: Boolean(nextContact.publicIdentityKey),
            has_transport_key: Boolean(nextContact.publicTransportKey),
          },
        })
      } catch (error) {
        setStartError(
          error instanceof Error ? error.message : "Unable to start chat"
        )
      } finally {
        setIsBusy(false)
      }
    },
    [masterKey, user]
  )

  const handleSend = React.useCallback(async () => {
    const trimmed = composeText.trim()
    if (!trimmed) {
      return
    }
    if (!activeContact || !masterKey || !identityPrivateKey) {
      setSendError("Select a recipient before sending.")
      return
    }
    if (!user?.handle) {
      setSendError("You must be signed in to send messages.")
      return
    }
    if (!activeContact.publicTransportKey) {
      setSendError("Missing recipient keys. Add the handle again.")
      return
    }
    setSendError(null)
    setIsBusy(true)
    try {
      const messageId = crypto.randomUUID()
      const signature = signMessage(
        buildMessageSignaturePayload(user.handle, trimmed, messageId),
        identityPrivateKey
      )
      const payload = JSON.stringify({
        content: trimmed,
        sender_handle: user.handle,
        sender_signature: signature,
        sender_identity_key: getIdentityPublicKey(identityPrivateKey),
        message_id: messageId,
      })
      const encryptedBlob = await encryptTransitEnvelope(
        payload,
        activeContact.publicTransportKey
      )
      void logClientEvent({
        level: "info",
        event: "message.send.prepared",
        payload: {
          recipient_handle: activeContact.handle,
          sender_handle: user.handle,
          message_id: messageId,
          content_length: trimmed.length,
          encrypted_blob_length: encryptedBlob.length,
        },
      })
      const localPayload = JSON.stringify({
        text: trimmed,
        peerHandle: activeContact.handle,
        peerUsername: activeContact.username,
        peerHost: activeContact.host,
        peerIdentityKey: activeContact.publicIdentityKey,
        peerTransportKey: activeContact.publicTransportKey,
        direction: "out",
        timestamp: new Date().toISOString(),
        message_id: messageId,
      })
      const encryptedLocal = await encryptString(masterKey, localPayload)
      const localRecord: MessageRecord = {
        id: messageId,
        ownerId: user?.id ?? user?.handle ?? "me",
        senderId: user?.handle ?? "me",
        content: JSON.stringify({
          encrypted_blob: encryptedLocal.ciphertext,
          iv: encryptedLocal.iv,
        }),
        verified: true,
        isRead: true,
        receiptStatus: undefined,
        vaultSynced: false,
        createdAt: new Date().toISOString(),
      }
      await db.messages.put(localRecord)
      const decoded = await decodeMessageRecord(
        localRecord,
        masterKey,
        localRecord.senderId
      )
      if (decoded) {
        setMessages((current) => [...current, decoded])
      }
      const sendResponse = await apiFetch<{
        sender_vault_stored?: boolean
      }>("/messages/send", {
        method: "POST",
        body: {
          recipient_handle: activeContact.handle,
          encrypted_blob: encryptedBlob,
          message_id: messageId,
          sender_vault_blob: encryptedLocal.ciphertext,
          sender_vault_iv: encryptedLocal.iv,
          sender_vault_signature_verified: true,
        },
      })
      void logClientEvent({
        level: "info",
        event: "message.send.sent",
        payload: {
          recipient_handle: activeContact.handle,
          message_id: messageId,
          sender_vault_stored: Boolean(sendResponse?.sender_vault_stored),
        },
      })
      const vaultStored = Boolean(sendResponse?.sender_vault_stored)
      await db.messages.update(messageId, {
        receiptStatus: "DELIVERED_TO_SERVER",
        vaultSynced: vaultStored,
      })
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? {
                ...message,
                receiptStatus: "DELIVERED_TO_SERVER",
                vaultSynced: vaultStored,
              }
            : message
        )
      )
      setComposeText("")
    } catch (error) {
      void logClientEvent({
        level: "error",
        event: "message.send.failed",
        payload: {
          recipient_handle: activeContact?.handle,
          error: error instanceof Error ? error.message : "Unable to send message",
        },
      })
      setSendError(
        error instanceof Error ? error.message : "Unable to send message"
      )
    } finally {
      setIsBusy(false)
    }
  }, [activeContact, composeText, identityPrivateKey, masterKey, user?.handle])

  return (
    <TooltipProvider>
      <SidebarProvider
        style={
          {
            "--sidebar-width": "360px",
          } as React.CSSProperties
        }
      >
      <AppSidebar
        conversations={conversations}
        activeId={activeContact?.id ?? ""}
        onSelect={(id, messageId) => {
          setActiveId(id)
          if (messageId) {
            setScrollToMessageId(messageId)
            setChatSearchQuery("")
            setIsChatSearchOpen(false)
          }
        }}
        onStartChat={handleStartChat}
        onLogout={logout}
        startError={startError}
        isBusy={isBusy}
        searchQuery={sidebarSearchQuery}
        onSearchChange={setSidebarSearchQuery}
      />
      <SidebarInset className="flex h-screen flex-col overflow-hidden bg-background">
        <header className="flex flex-none items-center gap-3 border-b bg-background/85 px-5 py-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          {activeContact && (
            <Avatar className="h-10 w-10 bg-emerald-600 text-white">
              <AvatarFallback>
                {activeContact.username.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          )}
          <div className="flex-1">
            <p className="text-sm font-semibold">
              {activeContact?.username ?? "Select a chat"}
            </p>
            <p className="text-xs text-muted-foreground">
              {activeContact
                ? "Encrypted session"
                : "Start by adding a username on the left."}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {isChatSearchOpen ? (
              <div className="relative w-40 md:w-60">
                <Input
                  placeholder="Search in chat..."
                  className="h-8 pr-8"
                  value={chatSearchQuery}
                  onChange={(e) => setChatSearchQuery(e.target.value)}
                  autoFocus
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-8 w-8 text-muted-foreground hover:bg-transparent"
                  onClick={() => {
                    setChatSearchQuery("")
                    setIsChatSearchOpen(false)
                  }}
                >
                  <Search className="h-4 w-4 rotate-45" />
                </Button>
              </div>
            ) : (
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground"
              onClick={() => setIsChatSearchOpen(true)}
              disabled={!activeContact}
            >
              <Search />
            </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="text-muted-foreground">
                  <MoreVertical />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleExportChat}>
                  <Download className="mr-2 h-4 w-4" />
                  <span>Export Chat</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleDeleteChat} className="text-destructive focus:text-destructive">
                  <Trash2 className="mr-2 h-4 w-4" />
                  <span>Delete Chat</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <div className="relative flex flex-1 flex-col overflow-hidden">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_var(--chat-glow),_transparent_55%)]" />
          <div className="pointer-events-none absolute inset-0 opacity-40 bg-[linear-gradient(90deg,var(--chat-grid)_1px,transparent_1px),linear-gradient(0deg,var(--chat-grid)_1px,transparent_1px)] bg-[size:32px_32px]" />
          <ScrollArea className="h-full">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-8">
              {!activeContact ? (
                <div className="mx-auto rounded-full bg-card/80 px-4 py-2 text-xs text-muted-foreground shadow-sm">
                  Add a handle to begin a secure chat.
                </div>
              ) : (
                <div className="mx-auto rounded-full bg-card/80 px-4 py-2 text-xs text-muted-foreground shadow-sm">
                  Messages are sealed locally. The server only stores ciphertext.
                </div>
              )}
              {activeMessages.map((message) => {
                const meta = formatTimestamp(message.timestamp)
                const receiptStatus =
                  message.direction === "out" ? message.receiptStatus ?? null : null
                const receiptLabel =
                  receiptStatus === "DELIVERED_TO_SERVER"
                    ? "sent"
                    : receiptStatus === "PROCESSED_BY_CLIENT"
                      ? "delivered"
                      : receiptStatus === "READ_BY_USER"
                    ? "read"
                    : null
                const senderHandle =
                  message.direction === "in" ? message.peerHandle : null
                const senderParts = senderHandle ? splitHandle(senderHandle) : null
                const senderHost = senderParts?.host ?? message.peerHost
                const showRemoteBadge =
                  message.direction === "in" &&
                  Boolean(senderHost) &&
                  Boolean(instanceHost) &&
                  senderHost !== instanceHost
                return (
                  <div
                    key={message.id}
                    id={`message-${message.id}`}
                    className={cn(
                      "flex w-full",
                      message.direction === "out"
                        ? "justify-end"
                        : "justify-start"
                    )}
                  >
                    <div
                      className={cn(
                        "group flex items-center gap-2",
                        message.direction === "out"
                          ? "flex-row-reverse"
                          : "flex-row"
                      )}
                    >
                      <div
                        className={cn(
                          "max-w-[85%] px-4 py-3 text-sm leading-relaxed shadow-sm sm:max-w-[70%] transition-all duration-500",
                          highlightedMessageId === message.id &&
                            "ring-2 ring-emerald-500 ring-offset-2 dark:ring-offset-slate-900 scale-[1.02]",
                          message.direction === "out"
                            ? "bg-emerald-100 dark:bg-emerald-900/30 text-foreground rounded-2xl rounded-br-sm"
                            : "bg-card dark:bg-muted text-foreground rounded-2xl rounded-bl-sm"
                        )}
                      >
                        {senderHandle ? (
                          <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                            <span className="font-mono">{senderHandle}</span>
                            {showRemoteBadge && senderHost ? (
                              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[9px] font-semibold text-amber-700">
                                Remote: {senderHost}
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                        <p className="whitespace-pre-wrap">{message.text}</p>
                        <div className="mt-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          <span>{meta}</span>
                          {message.verified && (
                            <ShieldCheck className="h-3 w-3 text-emerald-500" title="Verified Signature" />
                          )}
                          {receiptStatus ? (
                            receiptStatus === "DELIVERED_TO_SERVER" ? (
                              <Check className="h-3 w-3" title="Sent" />
                            ) : receiptStatus === "PROCESSED_BY_CLIENT" ? (
                              <CheckCheck className="h-3 w-3" title="Delivered" />
                            ) : receiptStatus === "READ_BY_USER" ? (
                              <CheckCheck
                                className="h-3 w-3 text-sky-500"
                                title="Read"
                              />
                            ) : null
                          ) : null}
                        </div>
                      </div>
                      <div className="flex items-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-6 w-6 text-slate-400 hover:text-slate-600">
                              <Info className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">
                            <div className="space-y-1">
                              <p><span className="font-semibold">Status:</span> {receiptLabel ?? (message.direction === 'in' ? 'received' : 'sending...')}</p>
                              <p><span className="font-semibold">Signature:</span> {message.verified ? 'Verified' : 'Unverified'}</p>
                              <p><span className="font-semibold">Time:</span> {new Date(message.timestamp).toLocaleString()}</p>
                              <p className="font-mono text-[9px] text-muted-foreground break-all">{message.id}</p>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  </div>
                )
              })}
              <div ref={scrollRef} />
            </div>
          </ScrollArea>
        </div>

        <div className="flex-none border-t bg-background/80 px-5 py-4 backdrop-blur">
          <Card className="border-border bg-card/90 shadow-sm">
            <CardContent className="flex items-center gap-3 p-3">
              <Button variant="ghost" size="icon" className="text-muted-foreground">
                <Paperclip />
              </Button>
              <Input
                placeholder={
                  activeContact
                    ? `Message ${activeContact.username}`
                    : "Select a chat to start messaging"
                }
                className="border-none bg-transparent shadow-none focus-visible:ring-0"
                value={composeText}
                onChange={(event) => setComposeText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault()
                    void handleSend()
                  }
                }}
                disabled={!activeContact || isBusy}
              />
              <Button
                className="bg-emerald-600 text-white hover:bg-emerald-600/90"
                disabled={!activeContact || isBusy}
                onClick={() => void handleSend()}
              >
                <Send />
                Send
              </Button>
            </CardContent>
          </Card>
          {sendError ? (
            <p className="mt-2 text-center text-xs text-destructive">
              {sendError}
            </p>
          ) : null}
        </div>
      </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
