"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import EmojiPicker, { Theme } from "emoji-picker-react"
import { Ban, Check, ShieldAlert, ShieldCheck, ShieldOff, Trash2, UserPlus } from "lucide-react"
import { useTheme } from "next-themes"

import { AppSidebar, type ConversationPreview } from "@/components/app-sidebar"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/context/AuthContext"
import { useBlock } from "@/context/BlockContext"
import { useCall } from "@/context/CallContext"
import { useContacts } from "@/context/ContactsContext"
import { useSocket } from "@/context/SocketContext"
import { useSettings } from "@/hooks/useSettings"
import { useRatchetSync } from "@/hooks/useRatchetSync"
import { apiFetch } from "@/lib/api"
import { getContactDisplayName, normalizeNickname } from "@/lib/contacts"
import {
  CONTACT_TRANSPORT_KEY_UPDATED_EVENT,
  OPEN_CONTACT_CHAT_EVENT,
  type ContactTransportKeyUpdatedDetail,
  type OpenContactChatDetail,
} from "@/lib/events"
import {
  decryptString,
  buildMessageSignaturePayload,
  encryptString,
  encryptTransitEnvelope,
  decryptTransitBlob,
  signMessage,
  decodeUtf8,
} from "@/lib/crypto"
import { normalizeHandle, splitHandle } from "@/lib/handles"
import { db, type MessageRecord } from "@/lib/db"
import { cn } from "@/lib/utils"
import { RecipientInfoDialog } from "@/components/RecipientInfoDialog"
import { ImagePreviewDialog } from "@/components/ImagePreviewDialog"
import { LinkWarningDialog } from "@/components/LinkWarningDialog"
import { MessageBubble, ComposeArea, ChatHeader } from "@/components/chat"
import { CallNotice, type CallEventType } from "@/components/chat/CallNotice"
import { resumeAudioContext } from "@/components/call"
import { formatDuration } from "@/lib/webrtc"
import type { Contact, StoredMessage, DirectoryEntry, Attachment } from "@/types/dashboard"
import {
  decodeContactRecord,
  decodeMessageRecord,
  applyMessageEvents,
  formatTimestamp,
  truncateText,
  getReplyPreviewText,
  DELETE_SIGNATURE_BODY,
  REACTION_PICKER_SIZE,
  REACTION_PICKER_GUTTER,
  REACTION_PICKER_OFFSET,
} from "@/lib/messageUtils"

const MS_PER_DAY = 24 * 60 * 60 * 1000

const getMessageDateKey = (date: Date) => {
  if (Number.isNaN(date.valueOf())) return ""
  return date.toDateString()
}

const formatMessageDateLabel = (date: Date, now: Date) => {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.round((startOfToday.getTime() - startOfDate.getTime()) / MS_PER_DAY)
  if (diffDays === 0) return "Today"
  if (diffDays === 1) return "Yesterday"
  const includeYear = date.getFullYear() !== now.getFullYear()
  return date.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
  })
}

const normalizeContact = (contact: Contact): Contact => {
  const handle = normalizeHandle(contact.handle)
  const parts = splitHandle(handle)
  const normalizedNickname = normalizeNickname(contact.nickname)
  return {
    handle: parts?.handle ?? handle,
    username: contact.username || parts?.username || handle,
    nickname: normalizedNickname,
    host: contact.host || parts?.host || "",
    publicIdentityKey: contact.publicIdentityKey ?? "",
    publicTransportKey: contact.publicTransportKey ?? "",
    avatar_filename: contact.avatar_filename ?? null,
    createdAt: contact.createdAt,
  }
}

const mergeContact = (existing: Contact, incoming: Contact): Contact => {
  const createdAt = existing.createdAt
    ? incoming.createdAt
      ? new Date(existing.createdAt) <= new Date(incoming.createdAt)
        ? existing.createdAt
        : incoming.createdAt
      : existing.createdAt
    : incoming.createdAt
  return {
    handle: incoming.handle || existing.handle,
    username: incoming.username || existing.username,
    nickname:
      incoming.nickname !== undefined ? incoming.nickname : existing.nickname,
    host: incoming.host || existing.host,
    publicIdentityKey: incoming.publicIdentityKey || existing.publicIdentityKey,
    publicTransportKey: incoming.publicTransportKey || existing.publicTransportKey,
    avatar_filename: incoming.avatar_filename !== undefined ? incoming.avatar_filename : existing.avatar_filename,
    createdAt,
  }
}

const mergeContactLists = (base: Contact[], incoming: Contact[]) => {
  const map = new Map<string, Contact>()
  for (const contact of base) {
    const normalized = normalizeContact(contact)
    map.set(normalized.handle.toLowerCase(), normalized)
  }
  for (const contact of incoming) {
    const normalized = normalizeContact(contact)
    const key = normalized.handle.toLowerCase()
    const existing = map.get(key)
    map.set(key, existing ? mergeContact(existing, normalized) : normalized)
  }
  return Array.from(map.values())
}

export function DashboardLayout() {
  const LAST_SELECTED_CHAT_KEY = "lastSelectedChat"
  const {
    user,
    masterKey,
    identityPrivateKey,
    publicIdentityKey,
    transportPrivateKey,
    logout,
  } = useAuth()
  const { theme } = useTheme()
  const socket = useSocket()
  const { settings } = useSettings()
  const { initiateCall, callState, handleCallMessage, externalCallActive } = useCall()
  const { isBlocked, blockUser } = useBlock()
  const { contacts: syncedContacts, addContact, removeContact } = useContacts()
  const [contacts, setContacts] = React.useState<Contact[]>([])
  const savedContactHandles = React.useMemo(() => {
    return new Set(
      syncedContacts.map((contact) =>
        normalizeHandle(contact.handle).toLowerCase()
      )
    )
  }, [syncedContacts])
  const [activeId, setActiveId] = React.useState<string>("")
  const [messages, setMessages] = React.useState<StoredMessage[]>([])
  const [conversationMessages, setConversationMessages] = React.useState<Map<string, StoredMessage[]>>(new Map())
  const [loadedConversations, setLoadedConversations] = React.useState<Set<string>>(new Set())
  const [loadingConversation, setLoadingConversation] = React.useState<string | null>(null)
  const [messageRequestHandles, setMessageRequestHandles] = React.useState<Set<string>>(new Set())
  const [composeText, setComposeText] = React.useState("")
  const [editingMessage, setEditingMessage] = React.useState<StoredMessage | null>(null)
  const [replyToMessage, setReplyToMessage] = React.useState<StoredMessage | null>(null)
  const [reactionPickerId, setReactionPickerId] = React.useState<string | null>(null)
  const [startError, setStartError] = React.useState<string | null>(null)
  const [sendError, setSendError] = React.useState<string | null>(null)
  const [isBusy, setIsBusy] = React.useState(false)
  const [sidebarSearchQuery, setSidebarSearchQuery] = React.useState("")
  const [chatSearchQuery, setChatSearchQuery] = React.useState("")
  const [isChatSearchOpen, setIsChatSearchOpen] = React.useState(false)
  const [scrollToMessageId, setScrollToMessageId] = React.useState<string | null>(null)
  const [highlightedMessageId, setHighlightedMessageId] = React.useState<string | null>(null)
  const [typingStatus, setTypingStatus] = React.useState<Record<string, boolean>>({})
  const [showRecipientInfo, setShowRecipientInfo] = React.useState(false)
  const [showBlockConfirm, setShowBlockConfirm] = React.useState(false)
  const [addToContactsOnAccept, setAddToContactsOnAccept] = React.useState(false)
  const [attachment, setAttachment] = React.useState<{ name: string; type: string; size: number; data: string } | null>(null)
  const [previewImage, setPreviewImage] = React.useState<string | null>(null)
  const [pendingLink, setPendingLink] = React.useState<string | null>(null)
  const [activeActionMessageId, setActiveActionMessageId] = React.useState<string | null>(null)
  const [isTouchActions, setIsTouchActions] = React.useState(false)
  const [isDragOver, setIsDragOver] = React.useState(false)
  const [storedActiveId, setStoredActiveId] = React.useState<string | null>(null)
  const [hasLoadedStoredActiveId, setHasLoadedStoredActiveId] = React.useState(false)
  const [contactsLoaded, setContactsLoaded] = React.useState(false)
  const [suppressStoredSelection, setSuppressStoredSelection] = React.useState(false)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const typingTimeoutRef = React.useRef<NodeJS.Timeout | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const reactionPickerRef = React.useRef<HTMLDivElement | null>(null)
  const reactionPickerAnchorRef = React.useRef<HTMLButtonElement | null>(null)
  const [reactionPickerPosition, setReactionPickerPosition] = React.useState<{
    top: number
    left: number
    width: number
    height: number
  } | null>(null)
  const emojiTheme = theme === "dark" ? Theme.DARK : theme === "system" ? Theme.AUTO : Theme.LIGHT
  const lastCallStateRef = React.useRef<typeof callState | null>(null)
  const lastCallEventKeyRef = React.useRef<string | null>(null)
  const isSavedContact = React.useCallback(
    (handle: string) =>
      savedContactHandles.has(normalizeHandle(handle).toLowerCase()),
    [savedContactHandles]
  )
  const upsertLocalContact = React.useCallback((incoming: Contact) => {
    const normalized = normalizeContact(incoming)
    setContacts((current) => {
      const key = normalized.handle.toLowerCase()
      const index = current.findIndex(
        (contact) => contact.handle.toLowerCase() === key
      )
      if (index === -1) {
        return [normalized, ...current]
      }
      const next = [...current]
      // Ensure we preserve avatar_filename if the incoming update doesn't have it
      // But normalizeContact ensures it's at least null. 
      // The mergeContact function handles the logic of "incoming vs existing"
      next[index] = mergeContact(next[index], normalized)
      return next
    })
    return normalized
  }, [])
  const upsertContact = React.useCallback(
    (incoming: Contact, options?: { syncIfSaved?: boolean }) => {
      const normalized = upsertLocalContact(incoming)
      if (options?.syncIfSaved && isSavedContact(normalized.handle)) {
        void addContact(normalized)
      }
      return normalized
    },
    [addContact, isSavedContact, upsertLocalContact]
  )
  const handleVaultMessageSync = React.useCallback(
    async (messageId: string, action: "upsert" | "delete") => {
      if (!masterKey) {
        return
      }
      if (action === "delete") {
        setMessages((current) =>
          current.filter((message) => message.id !== messageId)
        )
        return
      }
      const record = await db.messages.get(messageId)
      if (!record) {
        return
      }
      // For vault synced messages, peerHandle is more reliable than senderId
      // (especially for call events where direction doesn't match sender semantics)
      const decoded = await decodeMessageRecord(record, masterKey, record.peerHandle ?? record.senderId)
      if (!decoded) {
        return
      }
      setMessages((current) => {
        const index = current.findIndex((message) => message.id === decoded.id)
        if (index === -1) {
          return [...current, decoded]
        }
        const next = [...current]
        next[index] = decoded
        return next
      })
    },
    [masterKey]
  )
  const { lastSync, runSync, summaries, summariesLoaded } = useRatchetSync({
    onCallMessage: handleCallMessage,
    onVaultMessageSynced: handleVaultMessageSync,
  })
  React.useEffect(() => {
    setContacts((current) => mergeContactLists(current, syncedContacts))
  }, [syncedContacts])
  React.useEffect(() => {
    if (typeof window === "undefined") {
      return
    }
    const handleOpenChat = (event: Event) => {
      const detail = (event as CustomEvent<OpenContactChatDetail>).detail
      if (!detail?.handle) {
        return
      }
      setActiveId(detail.handle)
      setShowRecipientInfo(false)
    }
    const handleUpdate = (event: Event) => {
      const detail = (event as CustomEvent<ContactTransportKeyUpdatedDetail>).detail
      if (!detail?.handle || !detail.publicTransportKey) {
        return
      }
      const existing = contacts.find((contact) => contact.handle === detail.handle)
      const parts = splitHandle(detail.handle)
      const nextContact = existing
        ? { ...existing, publicTransportKey: detail.publicTransportKey }
        : {
            handle: detail.handle,
            username: parts?.username ?? detail.handle,
            host: parts?.host ?? "",
            publicIdentityKey: "",
            publicTransportKey: detail.publicTransportKey,
          }
      void upsertContact(nextContact, { syncIfSaved: true })
    }
    window.addEventListener(OPEN_CONTACT_CHAT_EVENT, handleOpenChat)
    window.addEventListener(CONTACT_TRANSPORT_KEY_UPDATED_EVENT, handleUpdate)
    return () => {
      window.removeEventListener(OPEN_CONTACT_CHAT_EVENT, handleOpenChat)
      window.removeEventListener(CONTACT_TRANSPORT_KEY_UPDATED_EVENT, handleUpdate)
    }
  }, [contacts, upsertContact])
  // TRANSPORT_KEY_ROTATED is now handled by SyncManager in SyncContext
  React.useEffect(() => {
    if (typeof window === "undefined") {
      return
    }
    const media = window.matchMedia("(hover: none) and (pointer: coarse)")
    const update = () => setIsTouchActions(media.matches)
    update()
    if (media.addEventListener) {
      media.addEventListener("change", update)
    } else {
      media.addListener(update)
    }
    return () => {
      if (media.removeEventListener) {
        media.removeEventListener("change", update)
      } else {
        media.removeListener(update)
      }
    }
  }, [])
  const visibleMessages = React.useMemo(
    () => applyMessageEvents(messages),
    [messages]
  )
  const buildReplyPayload = React.useCallback(
    (message: StoredMessage) => {
      const replyMessageId = message.messageId ?? message.id
      if (!replyMessageId) {
        return null
      }
      return {
        reply_to_message_id: replyMessageId,
      }
    },
    []
  )

  const updateMessagePayload = React.useCallback(
    async (
      messageId: string,
      updates: { deliveredAt?: string; processedAt?: string; readAt?: string }
    ) => {
      if (!masterKey) {
        return null
      }
      const record = await db.messages.get(messageId)
      if (!record) {
        return null
      }
      let envelope: { encrypted_blob: string; iv: string } | null = null
      try {
        envelope = JSON.parse(record.content) as {
          encrypted_blob: string
          iv: string
        }
      } catch {
        return null
      }
      if (!envelope?.encrypted_blob || !envelope.iv) {
        return null
      }
      let payload: Record<string, unknown> = {}
      try {
        const plaintext = await decryptString(masterKey, {
          ciphertext: envelope.encrypted_blob,
          iv: envelope.iv,
        })
        payload = JSON.parse(plaintext) as Record<string, unknown>
      } catch {
        return null
      }
      const nextPayload = { ...payload }
      if (updates.deliveredAt) {
        nextPayload.delivered_at = updates.deliveredAt
      }
      if (updates.processedAt) {
        nextPayload.processed_at = updates.processedAt
      }
      if (updates.readAt) {
        nextPayload.read_at = updates.readAt
      }
      const encrypted = await encryptString(masterKey, JSON.stringify(nextPayload))
      const contentJson = JSON.stringify({
        encrypted_blob: encrypted.ciphertext,
        iv: encrypted.iv,
      })
      await db.messages.update(messageId, { content: contentJson })
      try {
        await apiFetch(`/messages/vault/${messageId}`, {
          method: "PATCH",
          body: {
            encrypted_blob: encrypted.ciphertext,
            iv: encrypted.iv,
          },
        })
      } catch {
        // Best-effort: local updates remain in place if sync fails.
      }
      const decoded = await decodeMessageRecord(
        { ...record, content: contentJson },
        masterKey,
        record.senderId
      )
      if (decoded) {
        setMessages((current) =>
          current.map((message) =>
            message.id === messageId ? { ...message, ...decoded } : message
          )
        )
      }
      return decoded
    },
    [masterKey]
  )

  const sendReadReceipt = React.useCallback(
    async (
      message: StoredMessage,
      timestamp: string,
      fallbackTransportKey?: string
    ) => {
      if (!identityPrivateKey || !publicIdentityKey || !user?.handle) {
        return false
      }
      const targetMessageId = message.messageId ?? message.id
      if (!targetMessageId) {
        return false
      }
      const recipientTransportKey =
        message.peerTransportKey ?? fallbackTransportKey
      if (!recipientTransportKey) {
        return false
      }
      const signatureBody = `receipt:READ_BY_USER:${timestamp}`
      const signature = signMessage(
        buildMessageSignaturePayload(
          user.handle,
          signatureBody,
          targetMessageId
        ),
        identityPrivateKey
      )
      const payload = JSON.stringify({
        type: "receipt",
        content: signatureBody,
        receipt_status: "READ_BY_USER",
        receipt_timestamp: timestamp,
        sender_handle: user.handle,
        sender_signature: signature,
        sender_identity_key: publicIdentityKey,
        message_id: targetMessageId,
      })
      const encryptedBlob = await encryptTransitEnvelope(
        payload,
        recipientTransportKey
      )
      await apiFetch("/messages/send", {
        method: "POST",
        body: {
          recipient_handle: message.peerHandle,
          encrypted_blob: encryptedBlob,
          message_id: crypto.randomUUID(),
          event_type: "receipt",
        },
      })
      return true
    },
    [identityPrivateKey, publicIdentityKey, user?.handle]
  )

  const updateReactionPickerPosition = React.useCallback(() => {
    const anchor = reactionPickerAnchorRef.current
    if (!anchor) {
      return
    }
    const rect = anchor.getBoundingClientRect()
    const availableWidth = Math.max(
      0,
      window.innerWidth - REACTION_PICKER_GUTTER * 2
    )
    const availableHeight = Math.max(
      0,
      window.innerHeight - REACTION_PICKER_GUTTER * 2
    )
    const width = Math.min(REACTION_PICKER_SIZE, availableWidth)
    const height = Math.min(REACTION_PICKER_SIZE, availableHeight)
    let left = rect.right - width
    const maxLeft = window.innerWidth - width - REACTION_PICKER_GUTTER
    left = Math.min(Math.max(left, REACTION_PICKER_GUTTER), maxLeft)
    let top = rect.bottom + REACTION_PICKER_OFFSET
    const maxTop = window.innerHeight - height - REACTION_PICKER_GUTTER
    if (top > maxTop) {
      top = rect.top - height - REACTION_PICKER_OFFSET
    }
    top = Math.min(Math.max(top, REACTION_PICKER_GUTTER), maxTop)
    setReactionPickerPosition({ top, left, width, height })
  }, [])

  // Auto-focus input when chat changes
  React.useEffect(() => {
    if (activeId && !isBusy) {
      // Small delay to ensure the disabled state has updated if we were switching fast
      const timer = setTimeout(() => {
        textareaRef.current?.focus()
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [activeId, isBusy])

  // Listen for ephemeral signals (typing indicators)
  React.useEffect(() => {
    if (!socket || !transportPrivateKey) return

    const handleSignal = async (data: { sender_handle: string; encrypted_blob: string }) => {
      try {
        let plaintextBytes: Uint8Array
        try {
          plaintextBytes = await decryptTransitBlob(data.encrypted_blob, transportPrivateKey)
        } catch {
          return
        }
        const plaintext = decodeUtf8(plaintextBytes)
        const payload = JSON.parse(plaintext) as {
          type: string
          status?: boolean
        }

        if (payload.type === "typing") {
          const isTyping = Boolean(payload.status)
          console.log("[typing] signal", {
            sender: data.sender_handle,
            status: payload.status,
            isTyping,
          })
          setTypingStatus((prev) => ({
            ...prev,
            [data.sender_handle]: isTyping
          }))

          // Auto-clear typing status after 5 seconds just in case we miss the 'false' signal
          if (isTyping) {
            setTimeout(() => {
               setTypingStatus((prev) => ({
                ...prev,
                [data.sender_handle]: false
              }))
            }, 5000)
          }
        } else {
          void runSync()
        }
      } catch (err) {
        // Ignore decryption failures
      }
    }

    socket.on("signal", handleSignal)
    return () => {
      socket.off("signal", handleSignal)
    }
  }, [socket, transportPrivateKey, runSync])

  const messagesByPeer = React.useMemo(() => {
    const map = new Map<string, StoredMessage[]>()
    for (const message of visibleMessages) {
      const bucket = map.get(message.peerHandle) ?? []
      bucket.push(message)
      map.set(message.peerHandle, bucket)
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    }
    return map
  }, [visibleMessages])

  const activeContact =
    contacts.find((contact) => contact.handle === activeId) ?? null
  const isActiveContactSaved = activeContact
    ? isSavedContact(activeContact.handle)
    : false
  const isMessageRequestChat = activeContact
    ? messageRequestHandles.has(activeContact.handle)
    : false
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

  const activeMessageItems = React.useMemo(() => {
    const items: Array<
      | { type: "date"; key: string; label: string }
      | { type: "message"; message: StoredMessage }
    > = []
    let lastDateKey = ""
    const today = new Date()

    for (const message of activeMessages) {
      const parsed = new Date(message.timestamp)
      const dateKey = getMessageDateKey(parsed)
      if (dateKey && dateKey !== lastDateKey) {
        items.push({
          type: "date",
          key: dateKey,
          label: formatMessageDateLabel(parsed, today),
        })
        lastDateKey = dateKey
      }
      items.push({ type: "message", message })
    }

    return items
  }, [activeMessages])

  const activeMessageLookup = React.useMemo(() => {
    const map = new Map<string, StoredMessage>()
    for (const message of activeMessagesRaw) {
      const key = message.messageId ?? message.id
      if (key) {
        map.set(key, message)
      }
    }
    return map
  }, [activeMessagesRaw])

  const reactionPickerMessage = React.useMemo(() => {
    if (!reactionPickerId) {
      return null
    }
    return (
      activeMessagesRaw.find((message) => message.id === reactionPickerId) ?? null
    )
  }, [activeMessagesRaw, reactionPickerId])

  const conversations = React.useMemo<ConversationPreview[]>(() => {
    const query = sidebarSearchQuery.toLowerCase().trim()

    const truncate = (text: string, limit = 20) => {
      if (text.length <= limit) return text
      return text.substring(0, limit) + "..."
    }

    if (!query) {
      // Use summaries for fast sidebar when available (no search query)
      // Filter out blocked users/servers
      const visibleContacts = contacts.filter((contact) => !isBlocked(contact.handle))
      const list = visibleContacts.map((contact) => {
        const summary = summaries.get(contact.handle)
        const isActive = contact.handle === activeId

        // For unread count, check local messages if available
        const thread = messagesByPeer.get(contact.handle) ?? []
        const unread = isActive
          ? 0
          : thread.filter((m) => m.direction === "in" && !m.isRead).length

        // Get last message from local thread
        const lastMessage = thread[thread.length - 1]
        const localTimestamp = lastMessage?.timestamp || ""
        const summaryTimestamp = summary?.lastMessageTimestamp || ""

        // Use whichever is more recent (local message or summary)
        const useLocal = localTimestamp && (!summaryTimestamp || localTimestamp > summaryTimestamp)

        let rawText: string
        let lastTimestampRaw: string
        if (useLocal && lastMessage) {
          rawText = lastMessage.text || (lastMessage.attachments?.length ? "Attachment" : "No messages yet")
          lastTimestampRaw = localTimestamp
        } else if (summary) {
          rawText = summary.lastMessageText || "No messages yet"
          lastTimestampRaw = summaryTimestamp
        } else {
          rawText = "No messages yet"
          lastTimestampRaw = contact.createdAt || ""
        }

        return {
          id: contact.handle,
          uid: contact.handle,
          name: getContactDisplayName(contact),
          handle: contact.handle,
          avatarUrl: contact.avatar_filename ? `${process.env.NEXT_PUBLIC_API_URL}/uploads/avatars/${contact.avatar_filename}` : undefined,
          lastMessage: truncate(rawText),
          lastTimestamp: formatTimestamp(lastTimestampRaw),
          lastTimestampRaw,
          unread,
        }
      })

      // Sort: unread chats first (by activity), then read chats (by activity)
      return list
        .sort((a, b) => {
          // Unread chats come first
          if (a.unread > 0 && b.unread === 0) return -1
          if (a.unread === 0 && b.unread > 0) return 1
          // Within same group, sort by last activity (most recent first)
          return b.lastTimestampRaw.localeCompare(a.lastTimestampRaw)
        })
        .map(({ lastTimestampRaw, ...conv }) => conv)
    }

    const results: ConversationPreview[] = []

    // Filter out blocked users/servers
    const visibleContacts = contacts.filter((contact) => !isBlocked(contact.handle))

    // 1. Chats matching contact name/handle
    const matchingContacts = visibleContacts.filter((contact) =>
      getContactDisplayName(contact).toLowerCase().includes(query) ||
      contact.handle.toLowerCase().includes(query)
    )

    for (const contact of matchingContacts) {
      const thread = messagesByPeer.get(contact.handle) ?? []
      const lastMessage = thread[thread.length - 1]
      const isActive = contact.handle === activeId
      const unread = isActive
        ? 0
        : thread.filter((m) => m.direction === "in" && !m.isRead).length

      const rawText = lastMessage?.text || (lastMessage?.attachments?.length ? "📎 Attachment" : "No messages yet")

      results.push({
        id: contact.handle,
        uid: contact.handle,
        name: getContactDisplayName(contact),
        handle: contact.handle,
        avatarUrl: contact.avatar_filename ? `${process.env.NEXT_PUBLIC_API_URL}/uploads/avatars/${contact.avatar_filename}` : undefined,
        lastMessage: truncate(rawText),
        lastTimestamp: formatTimestamp(lastMessage?.timestamp ?? ""),
        unread,
      })
    }

    // 2. Found messages
    for (const contact of visibleContacts) {
      const thread = messagesByPeer.get(contact.handle) ?? []
      const matchingMessages = thread.filter((msg) =>
        msg.text.toLowerCase().includes(query)
      )

      for (const msg of matchingMessages) {
        // Create an entry for each matching message
        results.push({
          id: contact.handle,
          uid: `${contact.handle}:${msg.id}`,
          name: getContactDisplayName(contact),
          handle: contact.handle,
          avatarUrl: contact.avatar_filename ? `${process.env.NEXT_PUBLIC_API_URL}/uploads/avatars/${contact.avatar_filename}` : undefined,
          lastMessage: truncate(msg.text),
          lastTimestamp: formatTimestamp(msg.timestamp),
          unread: 0, // Search results typically don't show unread counts for the message itself
          foundMessageId: msg.id
        })
      }
    }

    return results
  }, [contacts, messagesByPeer, activeId, sidebarSearchQuery, summaries, isBlocked])

  // Build message requests list (conversations from unknown senders)
  const messageRequests = React.useMemo<ConversationPreview[]>(() => {
    if (messageRequestHandles.size === 0) {
      return []
    }

    const truncate = (text: string, limit = 20) => {
      if (text.length <= limit) return text
      return text.substring(0, limit) + "..."
    }

    const requestList: ConversationPreview[] = []

    for (const handle of messageRequestHandles) {
      // Skip if blocked
      if (isBlocked(handle)) continue

      const thread = messagesByPeer.get(handle) ?? []
      const requestMessages = thread.filter((m) => m.isMessageRequest)
      if (requestMessages.length === 0) continue

      const lastMessage = requestMessages[requestMessages.length - 1]
      const unread = requestMessages.filter((m) => m.direction === "in" && !m.isRead).length

      // Try to get username from the message or derive from handle
      const parts = splitHandle(handle)
      const username = lastMessage?.peerUsername ?? parts?.username ?? handle

      requestList.push({
        id: handle,
        uid: `request:${handle}`,
        name: username,
        handle,
        lastMessage: truncate(lastMessage?.text || "Attachment"),
        lastTimestamp: formatTimestamp(lastMessage?.timestamp ?? ""),
        unread,
        isMessageRequest: true,
      })
    }

    // Sort by most recent first
    return requestList.sort((a, b) => {
      const aThread = messagesByPeer.get(a.handle) ?? []
      const bThread = messagesByPeer.get(b.handle) ?? []
      const aLast = aThread[aThread.length - 1]?.timestamp ?? ""
      const bLast = bThread[bThread.length - 1]?.timestamp ?? ""
      return bLast.localeCompare(aLast)
    })
  }, [messageRequestHandles, messagesByPeer, isBlocked])

  const handleTyping = React.useCallback(async () => {
    if (!activeContact || !socket || !activeContact.publicTransportKey) return

    // Check if we should send typing indicator based on scope
    const scope = settings.typingIndicatorScope
    if (scope === "nobody") return

    const isContact = isSavedContact(activeContact.handle)
    if (scope === "contacts" && !isContact) return

    if (scope === "same_server") {
      const userParts = user?.handle ? splitHandle(user.handle) : null
      const recipientParts = splitHandle(activeContact.handle)
      const isSameServer =
        userParts?.host && recipientParts?.host
          ? userParts.host.toLowerCase() === recipientParts.host.toLowerCase()
          : false
      if (!isSameServer) return
    }

    // Clear existing timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current)
    } else {
       const payload = JSON.stringify({ type: "typing", status: true })
       encryptTransitEnvelope(payload, activeContact.publicTransportKey).then(blob => {
         console.log("[typing] send", {
           recipient: activeContact.handle,
           status: true,
         })
         socket.emit("signal", {
           recipient_handle: activeContact.handle,
           encrypted_blob: blob
         })
       })
    }

    // Set timeout to send "stop typing"
    typingTimeoutRef.current = setTimeout(() => {
      const payload = JSON.stringify({ type: "typing", status: false })
       encryptTransitEnvelope(payload, activeContact.publicTransportKey).then(blob => {
         console.log("[typing] send", {
           recipient: activeContact.handle,
           status: false,
         })
         socket.emit("signal", {
           recipient_handle: activeContact.handle,
           encrypted_blob: blob
         })
       })
       typingTimeoutRef.current = null
    }, 2000)
  }, [activeContact, settings.typingIndicatorScope, socket, isSavedContact, user?.handle])

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
  }, [visibleMessages, activeId, chatSearchQuery]) // Removed scrollToMessageId from dependencies to avoid re-triggering on clear

  React.useEffect(() => {
    if (!user?.handle) {
      console.log("[chat-selection] user cleared; reset state")
      setContacts([])
      setActiveId("")
      setStoredActiveId(null)
      setHasLoadedStoredActiveId(false)
      setContactsLoaded(false)
      setSuppressStoredSelection(false)
      return
    }
    if (!masterKey) {
      console.log("[chat-selection] masterKey missing; waiting for contacts load")
      setContacts([])
      setContactsLoaded(false)
      return
    }
    const ownerId = user.id ?? user.handle
    const load = async () => {
      setContactsLoaded(false)
      console.log("[chat-selection] loading contacts")
      const records = await db.contacts
        .where("ownerId")
        .equals(ownerId)
        .toArray()
      const decoded = await Promise.all(
        records.map((record) => decodeContactRecord(record, masterKey))
      )
      const nextContacts = decoded.filter(Boolean) as Contact[]
      setContacts((current) => mergeContactLists(current, nextContacts))
      setContactsLoaded(true)
      console.log("[chat-selection] contacts loaded", nextContacts.map((c) => c.handle))
      // Don't auto-select here - let the conversations effect handle it
      // so we always select the most recent conversation
    }
    void load()
  }, [user?.handle, user?.id, masterKey])

  React.useEffect(() => {
    if (!user?.handle) {
      return
    }
    let cancelled = false
    const ownerId = user.id ?? user.handle
    const loadStored = async () => {
      console.log("[chat-selection] loading stored selection")
      const record = await db.syncState.get(LAST_SELECTED_CHAT_KEY)
      if (cancelled) return
      const value = record?.value
      let nextStored: string | null = null
      if (typeof value === "string") {
        nextStored = value
      } else if (value && typeof value === "object") {
        const payload = value as { ownerId?: string; handle?: string }
        if (!payload.ownerId || payload.ownerId === ownerId) {
          nextStored = typeof payload.handle === "string" ? payload.handle : null
        }
      }
      if (!nextStored && typeof window !== "undefined") {
        const raw = window.localStorage.getItem(LAST_SELECTED_CHAT_KEY)
        nextStored = raw?.trim() ? raw : null
      }
      console.log("[chat-selection] stored selection resolved", {
        stored: nextStored,
        raw: value,
      })
      setStoredActiveId(nextStored)
      setHasLoadedStoredActiveId(true)
    }
    void loadStored()
    return () => {
      cancelled = true
    }
  }, [user?.handle, user?.id])

  // Restore last selected chat, fallback to most recent when missing.
  React.useEffect(() => {
    if (!hasLoadedStoredActiveId || !contactsLoaded) {
      return
    }
    if (activeId) {
      if (
        conversations.length > 0 &&
        !conversations.some((c) => c.id === activeId)
      ) {
        console.log("[chat-selection] activeId missing; clearing", {
          activeId,
          conversations: conversations.map((c) => c.id),
        })
        setActiveId("")
      }
      return
    }
    if (storedActiveId && conversations.some((c) => c.id === storedActiveId)) {
      console.log("[chat-selection] selecting storedActiveId", storedActiveId)
      if (!suppressStoredSelection) {
        setActiveId(storedActiveId)
      }
    } else {
      console.log("[chat-selection] no stored selection match; leaving empty")
    }
  }, [
    activeId,
    conversations,
    storedActiveId,
    hasLoadedStoredActiveId,
    contactsLoaded,
    suppressStoredSelection,
  ])

  React.useEffect(() => {
    if (!hasLoadedStoredActiveId || !contactsLoaded || !user?.handle || !activeId) {
      return
    }
    if (suppressStoredSelection) {
      return
    }
    console.log("[chat-selection] persist selection", activeId)
    setStoredActiveId(activeId)
    void db.syncState.put({
      key: LAST_SELECTED_CHAT_KEY,
      value: activeId,
    })
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LAST_SELECTED_CHAT_KEY, activeId)
    }
  }, [
    activeId,
    hasLoadedStoredActiveId,
    contactsLoaded,
    user?.handle,
    user?.id,
    suppressStoredSelection,
  ])

  // Refresh contact info (avatar, keys) when selecting a chat
  React.useEffect(() => {
    if (!activeContact) return

    const refreshInfo = async () => {
      try {
        const entry = await apiFetch<DirectoryEntry>(
          `/api/directory?handle=${encodeURIComponent(activeContact.handle)}`
        )

        const handleParts = splitHandle(activeContact.handle)
        const trimmedDisplayName = entry.display_name?.trim() ?? ""
        const resolvedUsername =
          trimmedDisplayName.length > 0
            ? trimmedDisplayName
            : handleParts?.username ?? activeContact.handle
        
        // Check if anything changed that is worth saving
        const hasChanges = 
          entry.public_transport_key !== activeContact.publicTransportKey ||
          entry.public_identity_key !== activeContact.publicIdentityKey ||
          entry.avatar_filename !== activeContact.avatar_filename ||
          resolvedUsername !== activeContact.username

        if (hasChanges) {
          const updatedContact: Contact = {
            ...activeContact,
            username: resolvedUsername,
            publicIdentityKey: entry.public_identity_key ?? activeContact.publicIdentityKey,
            publicTransportKey: entry.public_transport_key ?? activeContact.publicTransportKey,
            avatar_filename: entry.avatar_filename ?? null // Null if hidden/missing
          }
          
          // Update local state immediately
          upsertLocalContact(updatedContact)
          
          // Persist if it's a saved contact
          if (isSavedContact(updatedContact.handle)) {
            void addContact(updatedContact)
          }
        }
      } catch (err) {
        // Ignore directory lookup errors (offline, etc)
      }
    }

    // Debounce slightly to avoid rapid requests on rapid switching
    const timer = setTimeout(() => void refreshInfo(), 100)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeContact?.handle])

  React.useEffect(() => {
    console.log("[chat-selection] activeId changed", activeId)
  }, [activeId])

  React.useEffect(() => {
    if (!editingMessage) {
      return
    }
    if (!activeContact || editingMessage.peerHandle !== activeContact.handle) {
      setEditingMessage(null)
      setComposeText("")
      setSendError(null)
      setAttachment(null)
    }
  }, [activeContact, editingMessage])

  React.useEffect(() => {
    if (!replyToMessage) {
      return
    }
    if (!activeContact || replyToMessage.peerHandle !== activeContact.handle) {
      setReplyToMessage(null)
    }
  }, [activeContact, replyToMessage])

  React.useEffect(() => {
    if (!replyToMessage) {
      return
    }
    const targetId = replyToMessage.messageId ?? replyToMessage.id
    if (!targetId || !activeMessageLookup.has(targetId)) {
      setReplyToMessage(null)
    }
  }, [replyToMessage, activeMessageLookup])

  React.useEffect(() => {
    if (!reactionPickerId) {
      return
    }
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      if (reactionPickerRef.current?.contains(target)) {
        return
      }
      if (target.closest('[data-reaction-button="true"]')) {
        return
      }
      setReactionPickerId(null)
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [reactionPickerId])

  React.useEffect(() => {
    if (!isTouchActions || !activeActionMessageId) {
      return
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement
      const container = target.closest("[data-message-id]")
      const containerId = container?.getAttribute("data-message-id")
      if (!container || containerId !== activeActionMessageId) {
        setActiveActionMessageId(null)
      }
    }
    document.addEventListener("pointerdown", handlePointerDown)
    return () => document.removeEventListener("pointerdown", handlePointerDown)
  }, [activeActionMessageId, isTouchActions])

  React.useLayoutEffect(() => {
    if (!reactionPickerId) {
      return
    }
    updateReactionPickerPosition()
  }, [reactionPickerId, updateReactionPickerPosition])

  React.useEffect(() => {
    if (!reactionPickerId) {
      return
    }
    const handleViewportChange = () => updateReactionPickerPosition()
    window.addEventListener("resize", handleViewportChange)
    window.addEventListener("scroll", handleViewportChange, true)
    return () => {
      window.removeEventListener("resize", handleViewportChange)
      window.removeEventListener("scroll", handleViewportChange, true)
    }
  }, [reactionPickerId, updateReactionPickerPosition])

  React.useEffect(() => {
    if (reactionPickerId) {
      return
    }
    reactionPickerAnchorRef.current = null
    setReactionPickerPosition(null)
  }, [reactionPickerId])

  React.useEffect(() => {
    setReactionPickerId(null)
    setActiveActionMessageId(null)
  }, [activeContact?.handle])

  React.useEffect(() => {
    if (reactionPickerId && !reactionPickerMessage) {
      setReactionPickerId(null)
    }
  }, [reactionPickerId, reactionPickerMessage])

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
          decodeMessageRecord(record, masterKey, record.peerHandle ?? record.senderId)
        )
      )
      const nextMessages = decoded.filter(Boolean) as StoredMessage[]
      setMessages(nextMessages)

      // Also extract unique peer handles from message requests
      const requestHandles = new Set<string>()
      for (const msg of nextMessages) {
        if (msg.isMessageRequest) {
          requestHandles.add(msg.peerHandle)
        }
      }
      setMessageRequestHandles(requestHandles)
    }
    void loadMessages()
  }, [masterKey, lastSync, user])

  // Load messages for a specific conversation (lazy loading)
  const loadConversationMessages = React.useCallback(async (peerHandle: string) => {
    if (loadedConversations.has(peerHandle) || !masterKey || !user) {
      return
    }

    setLoadingConversation(peerHandle)

    try {
      const ownerId = user.id ?? user.handle
      // Query IndexedDB by peerHandle (efficient with the new index)
      const records = await db.messages
        .where("[ownerId+peerHandle]")
        .equals([ownerId, peerHandle])
        .toArray()

      // Decrypt messages for this conversation
      const decoded = await Promise.all(
        records.map((record) =>
          decodeMessageRecord(record, masterKey, record.peerHandle ?? record.senderId)
        )
      )

      const conversationMsgs = decoded.filter(Boolean) as StoredMessage[]

      setConversationMessages((prev) => new Map(prev).set(peerHandle, conversationMsgs))
      setLoadedConversations((prev) => new Set(prev).add(peerHandle))
    } finally {
      setLoadingConversation(null)
    }
  }, [masterKey, user, loadedConversations])

  // Trigger conversation load when active contact changes
  React.useEffect(() => {
    if (activeContact?.handle && !loadedConversations.has(activeContact.handle)) {
      void loadConversationMessages(activeContact.handle)
    }
  }, [activeContact?.handle, loadedConversations, loadConversationMessages])

  React.useEffect(() => {
    if (!masterKey || !user || visibleMessages.length === 0) {
      return
    }
    const pendingSaves = new Map<string, Contact>()
    setContacts((current) => {
      let changed = false
      let next = [...current]
      for (const message of visibleMessages) {
        if (!message.peerHandle) {
          continue
        }
        const normalizedHandle = normalizeHandle(message.peerHandle)
        const handleKey = normalizedHandle.toLowerCase()
        const index = next.findIndex(
          (contact) => contact.handle.toLowerCase() === handleKey
        )
        if (index === -1) {
          const parts = splitHandle(normalizedHandle)
          const newContact = normalizeContact({
            handle: normalizedHandle,
            username: message.peerUsername ?? parts?.username ?? normalizedHandle,
            host: message.peerHost ?? parts?.host ?? "",
            publicIdentityKey: message.peerIdentityKey ?? "",
            publicTransportKey: message.peerTransportKey ?? "",
            createdAt: message.timestamp ?? new Date().toISOString(),
          })
          next = [newContact, ...next]
          changed = true
          if (isSavedContact(newContact.handle)) {
            pendingSaves.set(handleKey, newContact)
          }
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
          changed = true
          if (isSavedContact(updatedContact.handle)) {
            pendingSaves.set(handleKey, updatedContact)
          }
        }
      }
      if (!changed) {
        return current
      }
      return next
    })
    if (pendingSaves.size > 0) {
      void Promise.all([...pendingSaves.values()].map((contact) => addContact(contact)))
    }
  }, [visibleMessages, masterKey, user, addContact, isSavedContact])

  React.useEffect(() => {
    if (!activeContact) {
      return
    }
    const unreadMessages = activeMessagesRaw.filter(
      (message) => message.direction === "in" && !message.isRead
    )
    const unreadIds = unreadMessages.map((message) => message.id)

    // Check if we should send receipts based on sendReadReceiptsTo setting
    const isContactSaved = isSavedContact(activeContact.handle)
    const shouldSendReceipts =
      settings.sendReadReceiptsTo === "everybody" ||
      (settings.sendReadReceiptsTo === "contacts" && isContactSaved)

    const receiptTargets = shouldSendReceipts
      ? activeMessagesRaw.filter(
          (message) =>
            message.direction === "in" &&
            message.messageId &&
            message.peerHandle &&
            !message.readAt
        )
      : []
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

      // Gate read receipts based on settings
      if (!shouldSendReceipts) return

      const sentIds: string[] = []
      const readAt = new Date().toISOString()
      for (const message of receiptTargets) {
        try {
          const didSend = await sendReadReceipt(
            message,
            readAt,
            activeContact?.publicTransportKey
          )
          if (!didSend) {
            continue
          }
          sentIds.push(message.id)
        } catch {
          // Best-effort: keep unsent receipts for the next open.
        }
      }
      if (sentIds.length > 0) {
        await Promise.all(
          sentIds.map((id) => updateMessagePayload(id, { readAt }))
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
  }, [
    activeContact,
    activeMessagesRaw,
    sendReadReceipt,
    settings.sendReadReceiptsTo,
    isSavedContact,
    updateMessagePayload,
  ])

  const handleDeleteChat = React.useCallback(async () => {
    if (!activeContact || !user) return
    const displayName = getContactDisplayName(activeContact)
    const confirmDelete = window.confirm(
      `Are you sure you want to delete the chat with ${displayName}? This cannot be undone.`
    )
    if (!confirmDelete) return

    const ownerId = user.id ?? user.handle
    // Delete messages locally (include edit/delete events)
    const ids = messages
      .filter((message) => message.peerHandle === activeContact.handle)
      .map((message) => message.id)
    await db.messages.bulkDelete(ids)
    
    await removeContact(activeContact.handle)
    setContacts((current) =>
      current.filter(
        (contact) =>
          contact.handle.toLowerCase() !== activeContact.handle.toLowerCase()
      )
    )

    // Delete from server vault
    try {
      await apiFetch("/messages/vault/delete-chat", {
        method: "POST",
        body: { peer_handle: activeContact.handle },
      })
    } catch (error) {
    }

    // Update state
    setMessages((prev) => prev.filter((m) => !ids.includes(m.id)))
    setActiveId("")
  }, [activeContact, user, messages, removeContact])

  const handleBlockUser = React.useCallback(() => {
    if (!activeContact) return
    setShowBlockConfirm(true)
  }, [activeContact])

  const confirmBlockUser = React.useCallback(async () => {
    if (!activeContact) return
    await blockUser(activeContact.handle)
    setShowBlockConfirm(false)
    // Clear active selection since the user is now blocked
    setActiveId("")
  }, [activeContact, blockUser])

  // Accept a message request - marks all messages from this sender as not a request
  const handleAcceptRequest = React.useCallback(async (shouldAddToContacts: boolean) => {
    if (!activeContact || !user) return
    const handle = activeContact.handle
    const ownerId = user.id ?? user.handle

    // Update IndexedDB - clear isMessageRequest flag for all messages from this handle
    await db.messages
      .where("[ownerId+peerHandle]")
      .equals([ownerId, handle])
      .modify({ isMessageRequest: false })

    // Update local state
    setMessages((prev) =>
      prev.map((m) =>
        m.peerHandle === handle ? { ...m, isMessageRequest: false } : m
      )
    )
    setMessageRequestHandles((prev) => {
      const next = new Set(prev)
      next.delete(handle)
      return next
    })

    // Optionally add to contacts
    if (shouldAddToContacts && !isSavedContact(handle)) {
      await addContact({
        handle: activeContact.handle,
        username: activeContact.username,
        host: activeContact.host,
        publicIdentityKey: activeContact.publicIdentityKey,
        publicTransportKey: activeContact.publicTransportKey,
      })
    }
  }, [activeContact, user, addContact, isSavedContact])

  // Delete a message request - removes all messages and the conversation
  const handleDeleteRequest = React.useCallback(async () => {
    if (!activeContact || !user) return
    const handle = activeContact.handle
    const ownerId = user.id ?? user.handle

    // Delete from IndexedDB
    const ids = activeMessagesRaw
      .filter((m) => m.peerHandle === handle)
      .map((m) => m.id)
    await db.messages.bulkDelete(ids)

    // Try to delete from server vault
    try {
      await apiFetch("/messages/vault/delete-chat", {
        method: "POST",
        body: { peer_handle: handle },
      })
    } catch {
      // Best-effort
    }

    // Update local state
    setMessages((prev) => prev.filter((m) => !ids.includes(m.id)))
    setMessageRequestHandles((prev) => {
      const next = new Set(prev)
      next.delete(handle)
      return next
    })

    // Remove from contacts if exists
    await removeContact(handle)
    setContacts((prev) => prev.filter((c) => c.handle !== handle))
    setActiveId("")
  }, [activeContact, user, activeMessagesRaw, removeContact])

  const handleBlockContact = React.useCallback(
    async (contact: Contact) => {
      const label = getContactDisplayName(contact)
      const confirmed = window.confirm(`Block ${label}?`)
      if (!confirmed) return
      await blockUser(contact.handle)
      setShowRecipientInfo(false)
      if (activeId === contact.handle) {
        setActiveId("")
      }
    },
    [blockUser, activeId]
  )

  const handleRemoveContact = React.useCallback(
    async (contact: Contact) => {
      const label = getContactDisplayName(contact)
      const confirmed = window.confirm(`Remove ${label} from contacts?`)
      if (!confirmed) return
      await removeContact(contact.handle)
      setShowRecipientInfo(false)
    },
    [removeContact]
  )

  const handleAddContact = React.useCallback(
    async (contact: Contact) => {
      let nextContact = contact
      try {
        const entry = await apiFetch<DirectoryEntry>(
          `/api/directory?handle=${encodeURIComponent(contact.handle)}`
        )
        const handleParts = splitHandle(contact.handle)
        const trimmedDisplayName = entry.display_name?.trim() ?? ""
        nextContact = {
          ...contact,
          username:
            trimmedDisplayName.length > 0
              ? trimmedDisplayName
              : handleParts?.username ?? contact.username,
          publicIdentityKey: entry.public_identity_key ?? contact.publicIdentityKey,
          publicTransportKey: entry.public_transport_key ?? contact.publicTransportKey,
        }
      } catch {
        // Directory lookup is best-effort; proceed with what we have.
      }
      const savedContact = {
        ...nextContact,
        createdAt: nextContact.createdAt ?? new Date().toISOString(),
      }
      upsertLocalContact(savedContact)
      await addContact(savedContact)
      setShowRecipientInfo(false)
    },
    [addContact, upsertLocalContact]
  )

  const handleStartCall = React.useCallback(
    async (callType: "AUDIO" | "VIDEO") => {
      if (!activeContact) {
        return
      }
      let publicTransportKey = activeContact.publicTransportKey
      let publicIdentityKey = activeContact.publicIdentityKey

      try {
        const entry = await apiFetch<DirectoryEntry>(
          `/api/directory?handle=${encodeURIComponent(activeContact.handle)}`
        )
        if (entry.public_transport_key) {
          publicTransportKey = entry.public_transport_key
          publicIdentityKey = entry.public_identity_key ?? publicIdentityKey
          if (entry.public_transport_key !== activeContact.publicTransportKey) {
            const updatedContact: Contact = {
              ...activeContact,
              publicIdentityKey: entry.public_identity_key ?? activeContact.publicIdentityKey,
              publicTransportKey: entry.public_transport_key,
            }
            void upsertContact(updatedContact, { syncIfSaved: true })
          }
        }
      } catch {
        // Directory lookup is best-effort; fall back to stored key.
      }

      if (!publicTransportKey || !publicIdentityKey) {
        return
      }

      // Resume AudioContext on user gesture for Safari
      resumeAudioContext()
      void initiateCall(activeContact.handle, publicTransportKey, publicIdentityKey, callType)
    },
    [activeContact, initiateCall, upsertContact]
  )

  const buildCallEventText = React.useCallback(
    (
      eventType: CallEventType,
      callType: "AUDIO" | "VIDEO",
      direction: "incoming" | "outgoing",
      durationSeconds?: number
    ) => {
      const callTypeLabel = callType === "VIDEO" ? "video" : "voice"
      switch (eventType) {
        case "CALL_STARTED":
          return direction === "incoming"
            ? `Incoming ${callTypeLabel} call`
            : `Outgoing ${callTypeLabel} call`
        case "CALL_ENDED": {
          const durationStr = durationSeconds ? ` - ${formatDuration(durationSeconds)}` : ""
          return `${direction === "incoming" ? "Incoming" : "Outgoing"} ${callTypeLabel} call ended${durationStr}`
        }
        case "CALL_MISSED":
          return direction === "outgoing"
            ? `Outgoing ${callTypeLabel} call (no answer)`
            : `Missed ${callTypeLabel} call`
        case "CALL_DECLINED":
          return direction === "incoming"
            ? `Declined ${callTypeLabel} call`
            : `${callTypeLabel.charAt(0).toUpperCase() + callTypeLabel.slice(1)} call declined`
      }
    },
    []
  )

  const addCallEventMessage = React.useCallback(
    async ({
      peerHandle,
      callType,
      direction,
      eventType,
      durationSeconds,
      timestamp,
      callId,
    }: {
      peerHandle: string
      callType: "AUDIO" | "VIDEO"
      direction: "incoming" | "outgoing"
      eventType: CallEventType
      durationSeconds?: number
      timestamp?: string
      callId?: string | null
    }) => {
      if (!masterKey || !user?.handle) {
        return
      }

      const eventKey = `${eventType}:${callId ?? timestamp ?? ""}:${peerHandle}`
      if (lastCallEventKeyRef.current === eventKey) {
        return
      }
      lastCallEventKeyRef.current = eventKey

      const contact = contacts.find((entry) => entry.handle === peerHandle) ?? null
      const handleParts = splitHandle(peerHandle)
      const peerUsername = contact?.username ?? handleParts?.username ?? peerHandle
      const peerHost = contact?.host ?? handleParts?.host ?? ""
      const createdAt = timestamp ?? new Date().toISOString()
      const text = buildCallEventText(eventType, callType, direction, durationSeconds)

      const payload = JSON.stringify({
        type: "call",
        event_type: eventType,
        call_type: callType,
        direction,
        duration_seconds: durationSeconds,
        text,
        peerHandle,
        peerUsername,
        peerHost,
        peerIdentityKey: contact?.publicIdentityKey ?? "",
        peerTransportKey: contact?.publicTransportKey ?? "",
        timestamp: createdAt,
      })

      const encryptedLocal = await encryptString(masterKey, payload)
      const recordId = crypto.randomUUID()
      const localRecord: MessageRecord = {
        id: recordId,
        ownerId: user?.id ?? user?.handle ?? "me",
        senderId: direction === "incoming" ? peerHandle : user?.handle ?? "me",
        peerHandle,
        content: JSON.stringify({
          encrypted_blob: encryptedLocal.ciphertext,
          iv: encryptedLocal.iv,
        }),
        verified: true,
        isRead: direction === "outgoing",
        vaultSynced: false,
        createdAt,
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

      try {
        await apiFetch("/messages/vault", {
          method: "POST",
          body: {
            message_id: recordId,
            original_sender_handle: peerHandle,
            encrypted_blob: encryptedLocal.ciphertext,
            iv: encryptedLocal.iv,
            sender_signature_verified: true,
          },
        })
        await db.messages.update(recordId, { vaultSynced: true })
      } catch {
        // Best-effort: syncOutgoingVault will retry.
      }
    },
    [buildCallEventText, contacts, masterKey, user]
  )

  React.useEffect(() => {
    const prev = lastCallStateRef.current
    lastCallStateRef.current = callState

    const peerHandle = callState.peerHandle ?? prev?.peerHandle
    const callType = callState.callType ?? prev?.callType
    const direction = callState.direction ?? prev?.direction
    if (!peerHandle || !callType || !direction) {
      return
    }

    if (prev?.status === "incoming" && callState.status === "idle") {
      if (callState.suppressNotifications) {
        return
      }
      void addCallEventMessage({
        peerHandle,
        callType,
        direction: "incoming",
        eventType: "CALL_DECLINED",
        timestamp: new Date().toISOString(),
        callId: prev?.callId,
      })
      return
    }

    if (callState.status === "ended" && prev?.status !== "ended") {
      const startedAt = callState.startedAt ?? prev?.startedAt
      const durationSeconds = startedAt
        ? Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000))
        : undefined
      const errorText = callState.error?.toLowerCase() ?? ""
      let eventType: CallEventType
      if (errorText.includes("declined") || errorText.includes("busy")) {
        eventType = "CALL_DECLINED"
      } else if (!startedAt) {
        eventType = "CALL_MISSED"
      } else {
        eventType = "CALL_ENDED"
      }

      void addCallEventMessage({
        peerHandle,
        callType,
        direction,
        eventType,
        durationSeconds,
        timestamp: new Date().toISOString(),
        callId: callState.callId ?? prev?.callId,
      })
    }
  }, [addCallEventMessage, callState])

  const handleExportChat = React.useCallback(() => {
    if (!activeContact) return
    const displayName = getContactDisplayName(activeContact)
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
    a.download = `chat-export-${displayName}-${new Date().toISOString().split('T')[0]}.json`
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
        const trimmedDisplayName = entry.display_name?.trim() ?? ""
        const nextContact: Contact = {
          handle,
          username: trimmedDisplayName.length > 0 ? trimmedDisplayName : handleParts.username,
          host: handleParts.host,
          publicIdentityKey: entry.public_identity_key,
          publicTransportKey: entry.public_transport_key,
        }
        const resolvedContact = upsertContact(nextContact, { syncIfSaved: true })
        setActiveId(resolvedContact.handle)
      } catch (error) {
        setStartError(
          error instanceof Error ? error.message : "Unable to start chat"
        )
      } finally {
        setIsBusy(false)
      }
    },
    [upsertContact]
  )

  const handleAttachFile = React.useCallback(
    async (file: File) => {
      if (!activeContact) {
        setSendError("Select a chat before attaching files.")
        return
      }
      if (editingMessage) {
        setSendError("Finish editing before attaching files.")
        return
      }
      if (isBusy) {
        return
      }
      if (file.size > 10 * 1024 * 1024) {
        setSendError("File too large (max 10MB)")
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        const base64 = dataUrl.split(",")[1]
        if (!base64) {
          setSendError("Unable to read file.")
          return
        }
        setAttachment({
          name: file.name,
          type: file.type,
          size: file.size,
          data: base64,
        })
        setSendError(null)
        if (fileInputRef.current) fileInputRef.current.value = ""
      }
      reader.onerror = () => {
        setSendError("Unable to read file.")
      }
      reader.readAsDataURL(file)
    },
    [activeContact, editingMessage, isBusy]
  )

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    void handleAttachFile(file)
  }

  const handlePasteAttachment = React.useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const clipboard = event.clipboardData
      if (!clipboard) return
      const directFile = clipboard.files?.[0]
      const itemFile =
        directFile ??
        Array.from(clipboard.items ?? [])
          .find((item) => item.kind === "file")
          ?.getAsFile() ??
        null
      if (!itemFile) {
        return
      }
      event.preventDefault()
      void handleAttachFile(itemFile)
    },
    [handleAttachFile]
  )

  const hasFileTransfer = (types: readonly string[] | undefined) =>
    Array.from(types ?? []).includes("Files")

  const canAttachFiles = Boolean(activeContact) && !editingMessage && !isBusy

  const handleDragEnter = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasFileTransfer(event.dataTransfer?.types)) {
        return
      }
      event.preventDefault()
      if (canAttachFiles) {
        setIsDragOver(true)
      }
    },
    [canAttachFiles]
  )

  const handleDragOver = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasFileTransfer(event.dataTransfer?.types)) {
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = "copy"
      if (canAttachFiles) {
        setIsDragOver(true)
      }
    },
    [canAttachFiles]
  )

  const handleDragLeave = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!isDragOver) {
        return
      }
      const relatedTarget = event.relatedTarget as Node | null
      if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
        return
      }
      setIsDragOver(false)
    },
    [isDragOver]
  )

  const handleDropAttachment = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasFileTransfer(event.dataTransfer?.types)) {
        return
      }
      event.preventDefault()
      setIsDragOver(false)
      const file = event.dataTransfer?.files?.[0]
      if (!file) {
        return
      }
      void handleAttachFile(file)
    },
    [handleAttachFile]
  )

  const beginReply = React.useCallback(
    (message: StoredMessage) => {
      if (!activeContact) {
        return
      }
      if (editingMessage) {
        return
      }
      if (message.peerHandle !== activeContact.handle) {
        return
      }
      setReplyToMessage(message)
      setSendError(null)
      setReactionPickerId(null)
      setActiveActionMessageId(null)
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
    [activeContact, editingMessage]
  )

  const cancelReply = React.useCallback(() => {
    setReplyToMessage(null)
  }, [])

  const beginEdit = React.useCallback((message: StoredMessage) => {
    if (message.direction !== "out" || !message.text) {
      return
    }
    setReplyToMessage(null)
    setActiveActionMessageId(null)
    setEditingMessage(message)
    setComposeText(message.text)
    setSendError(null)
    setAttachment(null)
    setReactionPickerId(null)
    if (fileInputRef.current) fileInputRef.current.value = ""
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [])

  const cancelEdit = React.useCallback(() => {
    setEditingMessage(null)
    setComposeText("")
    setSendError(null)
    setReactionPickerId(null)
  }, [])

  const handleMessageTap = React.useCallback(
    (event: React.MouseEvent, message: StoredMessage) => {
      if (!isTouchActions) {
        return
      }
      const target = event.target as HTMLElement
      if (target.closest('[data-no-action-toggle="true"]')) {
        return
      }
      if (target.closest("a,button,input,textarea,select,label")) {
        return
      }
      setReactionPickerId(null)
      setActiveActionMessageId((current) =>
        current === message.id ? null : message.id
      )
    },
    [isTouchActions]
  )

  const handleSendMessage = React.useCallback(async () => {
    const trimmed = composeText.trim()
    if (!trimmed && !attachment) {
      return
    }
    if (!activeContact || !masterKey || !identityPrivateKey || !publicIdentityKey) {
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
    setActiveActionMessageId(null)

    // Stop typing indicator immediately when sending
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current)
      typingTimeoutRef.current = null
    }
    if (settings.typingIndicatorScope !== "nobody" && socket && activeContact.publicTransportKey) {
      const stopTypingPayload = JSON.stringify({ type: "typing", status: false })
      encryptTransitEnvelope(stopTypingPayload, activeContact.publicTransportKey).then(blob => {
        socket.emit("signal", {
          recipient_handle: activeContact.handle,
          encrypted_blob: blob
        })
      })
    }

    setIsBusy(true)
    try {
      const messageId = crypto.randomUUID()
      const signature = signMessage(
        buildMessageSignaturePayload(user.handle, trimmed, messageId),
        identityPrivateKey
      )
      
      const attachments = attachment ? [{
        filename: attachment.name,
        mimeType: attachment.type,
        size: attachment.size,
        data: attachment.data
      }] : undefined
      const replyPayload = replyToMessage
        ? buildReplyPayload(replyToMessage)
        : null

      const payload = JSON.stringify({
        content: trimmed,
        sender_handle: user.handle,
        sender_signature: signature,
        sender_identity_key: publicIdentityKey,
        message_id: messageId,
        attachments,
        ...(replyPayload ?? {}),
      })
      const encryptedBlob = await encryptTransitEnvelope(
        payload,
        activeContact.publicTransportKey
      )
      const localPayload = JSON.stringify({
        text: trimmed,
        attachments,
        peerHandle: activeContact.handle,
        peerUsername: getContactDisplayName(activeContact),
        peerHost: activeContact.host,
        peerIdentityKey: activeContact.publicIdentityKey,
        peerTransportKey: activeContact.publicTransportKey,
        direction: "out",
        timestamp: new Date().toISOString(),
        message_id: messageId,
        ...(replyPayload ?? {}),
      })
      const encryptedLocal = await encryptString(masterKey, localPayload)
      const localRecord: MessageRecord = {
        id: messageId,
        ownerId: user?.id ?? user?.handle ?? "me",
        senderId: user?.handle ?? "me",
        peerHandle: activeContact.handle, // Outgoing: peer is recipient
        content: JSON.stringify({
          encrypted_blob: encryptedLocal.ciphertext,
          iv: encryptedLocal.iv,
        }),
        verified: true,
        isRead: true,
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
          event_type: "message",
          sender_vault_blob: encryptedLocal.ciphertext,
          sender_vault_iv: encryptedLocal.iv,
          sender_vault_signature_verified: true,
        },
      })
      const vaultStored = Boolean(sendResponse?.sender_vault_stored)
      await db.messages.update(messageId, {
        vaultSynced: vaultStored,
      })
      await updateMessagePayload(messageId, {
        deliveredAt: new Date().toISOString(),
      })
      setComposeText("")
      setReplyToMessage(null)
      setAttachment(null)
      if (fileInputRef.current) fileInputRef.current.value = ""
    } catch (error) {
      setSendError(
        error instanceof Error ? error.message : "Unable to send message"
      )
    } finally {
      setIsBusy(false)
    }
  }, [
    activeContact,
    composeText,
    identityPrivateKey,
    publicIdentityKey,
    masterKey,
    updateMessagePayload,
    user?.handle,
    user?.id,
    attachment,
    replyToMessage,
    buildReplyPayload,
  ])

  const handleEdit = React.useCallback(async () => {
    if (!editingMessage) {
      return
    }
    const trimmed = composeText.trim()
    if (!trimmed) {
      setSendError("Edited message cannot be empty.")
      return
    }
    if (trimmed === editingMessage.text) {
      cancelEdit()
      return
    }
    if (!activeContact || !masterKey || !identityPrivateKey || !publicIdentityKey) {
      setSendError("Select a recipient before editing.")
      return
    }
    if (!user?.handle) {
      setSendError("You must be signed in to edit messages.")
      return
    }
    if (!activeContact.publicTransportKey) {
      setSendError("Missing recipient keys. Add the handle again.")
      return
    }
    if (editingMessage.peerHandle !== activeContact.handle) {
      setSendError("Selected message is not in this chat.")
      return
    }
    const targetMessageId = editingMessage.messageId ?? editingMessage.id
    if (!targetMessageId) {
      setSendError("Unable to edit this message.")
      return
    }
    setSendError(null)
    setActiveActionMessageId(null)
    setIsBusy(true)
    try {
      const editedAt = new Date().toISOString()
      const editEventId = crypto.randomUUID()
      const signature = signMessage(
        buildMessageSignaturePayload(user.handle, trimmed, targetMessageId),
        identityPrivateKey
      )
      const payload = JSON.stringify({
        type: "edit",
        content: trimmed,
        sender_handle: user.handle,
        sender_signature: signature,
        sender_identity_key: publicIdentityKey,
        message_id: targetMessageId,
        edited_at: editedAt,
      })
      const encryptedBlob = await encryptTransitEnvelope(
        payload,
        activeContact.publicTransportKey
      )
      const localPayload = JSON.stringify({
        type: "edit",
        text: trimmed,
        peerHandle: activeContact.handle,
        peerUsername: getContactDisplayName(activeContact),
        peerHost: activeContact.host,
        peerIdentityKey: activeContact.publicIdentityKey,
        peerTransportKey: activeContact.publicTransportKey,
        direction: "out",
        timestamp: editedAt,
        edited_at: editedAt,
        message_id: targetMessageId,
      })
      const encryptedLocal = await encryptString(masterKey, localPayload)
      const localRecord: MessageRecord = {
        id: editEventId,
        ownerId: user?.id ?? user?.handle ?? "me",
        senderId: user?.handle ?? "me",
        peerHandle: activeContact.handle, // Outgoing: peer is recipient
        content: JSON.stringify({
          encrypted_blob: encryptedLocal.ciphertext,
          iv: encryptedLocal.iv,
        }),
        verified: true,
        isRead: true,
        vaultSynced: false,
        createdAt: editedAt,
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
          message_id: targetMessageId,
          event_id: editEventId,
          sender_vault_blob: encryptedLocal.ciphertext,
          sender_vault_iv: encryptedLocal.iv,
          sender_vault_signature_verified: true,
        },
      })
      const vaultStored = Boolean(sendResponse?.sender_vault_stored)
      await db.messages.update(editEventId, {
        vaultSynced: vaultStored,
      })
      if (socket) {
        socket.emit("signal", {
          recipient_handle: activeContact.handle,
          encrypted_blob: encryptedBlob,
        })
      }
      setComposeText("")
      setEditingMessage(null)
    } catch (error) {
      setSendError(
        error instanceof Error ? error.message : "Unable to edit message"
      )
    } finally {
      setIsBusy(false)
    }
  }, [
    editingMessage,
    cancelEdit,
    composeText,
    activeContact,
    masterKey,
    identityPrivateKey,
    publicIdentityKey,
    user?.handle,
    user?.id,
    socket,
  ])

  const handleDeleteMessage = React.useCallback(
    async (message: StoredMessage) => {
      if (message.direction !== "out") {
        return
      }
      if (!activeContact || !masterKey || !identityPrivateKey || !publicIdentityKey) {
        setSendError("Select a recipient before deleting.")
        return
      }
      if (!user?.handle) {
        setSendError("You must be signed in to delete messages.")
        return
      }
      if (!activeContact.publicTransportKey) {
        setSendError("Missing recipient keys. Add the handle again.")
        return
      }
      if (message.peerHandle !== activeContact.handle) {
        setSendError("Selected message is not in this chat.")
        return
      }
      const targetMessageId = message.messageId ?? message.id
      if (!targetMessageId) {
        setSendError("Unable to delete this message.")
        return
      }
      const confirmed = window.confirm(
        "Delete this message for everyone? This cannot be undone."
      )
      if (!confirmed) {
        return
      }
      if (editingMessage?.id === message.id) {
        cancelEdit()
      }
      setReactionPickerId(null)
      setActiveActionMessageId(null)
      setSendError(null)
      setIsBusy(true)
      try {
        const deletedAt = new Date().toISOString()
        const deleteEventId = crypto.randomUUID()
        const signature = signMessage(
          buildMessageSignaturePayload(
            user.handle,
            DELETE_SIGNATURE_BODY,
            targetMessageId
          ),
          identityPrivateKey
        )
        const payload = JSON.stringify({
          type: "delete",
        content: DELETE_SIGNATURE_BODY,
        sender_handle: user.handle,
        sender_signature: signature,
        sender_identity_key: publicIdentityKey,
        message_id: targetMessageId,
        deleted_at: deletedAt,
      })
        const encryptedBlob = await encryptTransitEnvelope(
          payload,
          activeContact.publicTransportKey
        )
        const localPayload = JSON.stringify({
          type: "delete",
          text: DELETE_SIGNATURE_BODY,
          peerHandle: activeContact.handle,
          peerUsername: getContactDisplayName(activeContact),
          peerHost: activeContact.host,
          peerIdentityKey: activeContact.publicIdentityKey,
          peerTransportKey: activeContact.publicTransportKey,
          direction: "out",
          timestamp: deletedAt,
          deleted_at: deletedAt,
          message_id: targetMessageId,
        })
        const encryptedLocal = await encryptString(masterKey, localPayload)
        const localRecord: MessageRecord = {
          id: deleteEventId,
          ownerId: user?.id ?? user?.handle ?? "me",
          senderId: user?.handle ?? "me",
          peerHandle: activeContact.handle, // Outgoing: peer is recipient
          content: JSON.stringify({
            encrypted_blob: encryptedLocal.ciphertext,
            iv: encryptedLocal.iv,
          }),
          verified: true,
          isRead: true,
          vaultSynced: false,
          createdAt: deletedAt,
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
            message_id: targetMessageId,
            event_id: deleteEventId,
            sender_vault_blob: encryptedLocal.ciphertext,
            sender_vault_iv: encryptedLocal.iv,
            sender_vault_signature_verified: true,
          },
        })
      const vaultStored = Boolean(sendResponse?.sender_vault_stored)
      await db.messages.update(deleteEventId, {
        vaultSynced: vaultStored,
      })
        if (socket) {
          socket.emit("signal", {
            recipient_handle: activeContact.handle,
            encrypted_blob: encryptedBlob,
          })
        }
      } catch (error) {
        setSendError(
          error instanceof Error ? error.message : "Unable to delete message"
        )
      } finally {
        setIsBusy(false)
      }
    },
    [
      activeContact,
      masterKey,
      identityPrivateKey,
      publicIdentityKey,
      user?.handle,
      user?.id,
      editingMessage,
      cancelEdit,
      socket,
    ]
  )

  const handleSendReaction = React.useCallback(
    async (
      message: StoredMessage,
      emoji: string,
      action: "add" | "remove" = "add"
    ) => {
      if (!emoji) {
        return
      }
      if (!activeContact || !masterKey || !identityPrivateKey || !publicIdentityKey) {
        setSendError("Select a recipient before reacting.")
        return
      }
      if (!user?.handle) {
        setSendError("You must be signed in to react.")
        return
      }
      if (!activeContact.publicTransportKey) {
        setSendError("Missing recipient keys. Add the handle again.")
        return
      }
      if (message.peerHandle !== activeContact.handle) {
        setSendError("Selected message is not in this chat.")
        return
      }
      const targetMessageId = message.messageId ?? message.id
      if (!targetMessageId) {
        setSendError("Unable to react to this message.")
        return
      }
      const reactionAction = action === "remove" ? "remove" : "add"
      setSendError(null)
      setActiveActionMessageId(null)
      setIsBusy(true)
      try {
        const reactedAt = new Date().toISOString()
        const reactionEventId = crypto.randomUUID()
        const signatureBody = `reaction:${reactionAction}:${emoji}`
        const signature = signMessage(
          buildMessageSignaturePayload(
            user.handle,
            signatureBody,
            targetMessageId
          ),
          identityPrivateKey
        )
        const payload = JSON.stringify({
          type: "reaction",
          content: signatureBody,
          reaction_action: reactionAction,
          reaction_emoji: emoji,
          sender_handle: user.handle,
          sender_signature: signature,
          sender_identity_key: publicIdentityKey,
          message_id: targetMessageId,
        })
        const encryptedBlob = await encryptTransitEnvelope(
          payload,
          activeContact.publicTransportKey
        )
        const localPayload = JSON.stringify({
          type: "reaction",
          text: emoji,
          reaction_action: reactionAction,
          reaction_emoji: emoji,
          peerHandle: activeContact.handle,
          peerUsername: getContactDisplayName(activeContact),
          peerHost: activeContact.host,
          peerIdentityKey: activeContact.publicIdentityKey,
          peerTransportKey: activeContact.publicTransportKey,
          direction: "out",
          timestamp: reactedAt,
          message_id: targetMessageId,
        })
        const encryptedLocal = await encryptString(masterKey, localPayload)
        const localRecord: MessageRecord = {
          id: reactionEventId,
          ownerId: user?.id ?? user?.handle ?? "me",
          senderId: user?.handle ?? "me",
          peerHandle: activeContact.handle, // Outgoing: peer is recipient
          content: JSON.stringify({
            encrypted_blob: encryptedLocal.ciphertext,
            iv: encryptedLocal.iv,
          }),
          verified: true,
          isRead: true,
          vaultSynced: false,
          createdAt: reactedAt,
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
            message_id: targetMessageId,
            event_id: reactionEventId,
            sender_vault_blob: encryptedLocal.ciphertext,
            sender_vault_iv: encryptedLocal.iv,
            sender_vault_signature_verified: true,
          },
        })
      const vaultStored = Boolean(sendResponse?.sender_vault_stored)
      await db.messages.update(reactionEventId, {
        vaultSynced: vaultStored,
      })
        if (socket) {
          socket.emit("signal", {
            recipient_handle: activeContact.handle,
            encrypted_blob: encryptedBlob,
          })
        }
      } catch (error) {
        setSendError(
          error instanceof Error ? error.message : "Unable to react"
        )
      } finally {
        setIsBusy(false)
      }
    },
    [
      activeContact,
      masterKey,
      identityPrivateKey,
      publicIdentityKey,
      user?.handle,
      user?.id,
      socket,
    ]
  )

  const handleSubmit = React.useCallback(async () => {
    if (editingMessage) {
      await handleEdit()
      return
    }
    await handleSendMessage()
  }, [editingMessage, handleEdit, handleSendMessage])

  const portalRoot =
    typeof document !== "undefined" ? document.body : null
  const reactionPickerPortal =
    portalRoot &&
    reactionPickerId &&
    reactionPickerPosition &&
    reactionPickerMessage
      ? createPortal(
          <div
            ref={reactionPickerRef}
            className="fixed z-[9999] overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
            style={{
              top: reactionPickerPosition.top,
              left: reactionPickerPosition.left,
              width: reactionPickerPosition.width,
            }}
          >
            <EmojiPicker
              theme={emojiTheme}
              onEmojiClick={(emojiData) => {
                void handleSendReaction(reactionPickerMessage, emojiData.emoji)
                setReactionPickerId(null)
              }}
              height={reactionPickerPosition.height}
              width={reactionPickerPosition.width}
            />
          </div>,
          portalRoot
        )
      : null

  return (
    <TooltipProvider>
      <SidebarProvider
        style={
          {
            "--sidebar-width": "360px",
          } as React.CSSProperties
        }
      >
      <RecipientInfoDialog 
        contact={activeContact}
        open={showRecipientInfo}
        onOpenChange={setShowRecipientInfo}
        onBlockUser={handleBlockContact}
        onAddContact={!isActiveContactSaved ? handleAddContact : undefined}
        onRemoveContact={isActiveContactSaved ? handleRemoveContact : undefined}
      />
      <ImagePreviewDialog 
        src={previewImage} 
        open={!!previewImage} 
        onOpenChange={(open) => !open && setPreviewImage(null)} 
      />
      <LinkWarningDialog
        url={pendingLink}
        open={!!pendingLink}
        onOpenChange={(open) => !open && setPendingLink(null)}
      />

      {/* Block User Confirmation Dialog */}
      <Dialog open={showBlockConfirm} onOpenChange={setShowBlockConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Ban className="h-5 w-5 text-destructive" />
              Block {activeContact ? getContactDisplayName(activeContact) : "user"}?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 pt-2 text-sm text-muted-foreground">
                <p>Blocking this user will:</p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>Hide all their messages from your chats</li>
                  <li>Remove them from your conversation list</li>
                  <li>Prevent future messages from appearing</li>
                </ul>
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/30 dark:bg-amber-900/10">
                  <ShieldOff className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                  <span className="text-xs text-amber-700 dark:text-amber-300">
                    Your block list is encrypted. The server cannot see who you&apos;ve blocked.
                  </span>
                </div>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowBlockConfirm(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmBlockUser}>
              <Ban className="h-4 w-4 mr-2" />
              Block User
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AppSidebar
        conversations={conversations}
        messageRequests={messageRequests}
        activeId={activeContact?.handle ?? ""}
        onSelectConversation={(id, messageId) => {
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
      <SidebarInset className="flex h-dvh flex-col overflow-hidden bg-background">
        <ChatHeader
          activeContact={activeContact}
          typingStatus={typingStatus}
          isChatSearchOpen={isChatSearchOpen}
          chatSearchQuery={chatSearchQuery}
          onChatSearchQueryChange={setChatSearchQuery}
          onChatSearchOpen={() => setIsChatSearchOpen(true)}
          onChatSearchClose={() => {
            setChatSearchQuery("")
            setIsChatSearchOpen(false)
          }}
          onShowRecipientInfo={() => setShowRecipientInfo(true)}
          onExportChat={handleExportChat}
          onDeleteChat={handleDeleteChat}
          onBlockUser={handleBlockUser}
          onAddContact={
            !isActiveContactSaved && activeContact
              ? () => void handleAddContact(activeContact)
              : undefined
          }
          showAddContact={!isActiveContactSaved}
          onStartCall={handleStartCall}
          isCallDisabled={callState.status !== "idle" || externalCallActive}
        />

        <div
          className="relative flex flex-1 flex-col overflow-hidden isolate"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDropAttachment}
        >
          <div className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(circle_at_top,_var(--chat-glow),_transparent_55%)]" />
          <div className="pointer-events-none absolute inset-0 z-0 opacity-40 bg-[linear-gradient(90deg,var(--chat-grid)_1px,transparent_1px),linear-gradient(0deg,var(--chat-grid)_1px,transparent_1px)] bg-[size:32px_32px]" />
          {isDragOver ? (
            <div className="pointer-events-none absolute inset-4 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-emerald-300 bg-emerald-50/80 text-sm font-medium text-emerald-700 shadow-lg dark:border-emerald-400/50 dark:bg-emerald-900/40 dark:text-emerald-100">
              Drop file to attach
            </div>
          ) : null}
          <ScrollArea className="relative z-10 h-full">
            <div className="relative z-10 mx-auto flex w-full max-w-none flex-col gap-2 px-4 py-4">
              {!activeContact ? (
                <div className="flex min-h-[60vh] items-center justify-center px-4 py-8">
                  <div className="w-full max-w-md rounded-2xl border bg-card/80 p-6 text-center shadow-sm">
                    <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm">
                      <ShieldCheck className="h-6 w-6" />
                    </div>
                    <h2 className="text-lg font-semibold">Ratchet Chat</h2>
                    <p className="mt-2 text-sm text-muted-foreground">
                      End-to-end encrypted messaging built for private conversations.
                    </p>
                    <div className="mt-4 space-y-2 text-left text-xs text-muted-foreground">
                      <div className="flex items-start gap-2">
                        <span className="mt-1 h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        <span>Keys stay on your devices, never the server.</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="mt-1 h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        <span>Server stores ciphertext only, not readable content.</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="mt-1 h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        <span>Select a chat on the left to begin.</span>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mx-auto rounded-full bg-card/80 px-4 py-2 text-xs text-muted-foreground shadow-sm">
                    Messages are sealed locally. The server only stores ciphertext.
                  </div>
                  {isMessageRequestChat && (
                    <div className="mx-auto w-full max-w-lg rounded-xl border border-amber-300 bg-amber-50 p-4 shadow-sm dark:border-amber-700 dark:bg-amber-950/50">
                      <div className="flex items-start gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/50">
                          <ShieldAlert className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                        </div>
                        <div className="flex-1 space-y-3">
                          <div>
                            <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                              Message Request
                            </h3>
                            <p className="text-xs text-amber-700 dark:text-amber-300">
                              This is a message from someone not in your contacts.
                              Attachments are hidden for your safety.
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              size="sm"
                              variant="accept"
                              onClick={() => void handleAcceptRequest(addToContactsOnAccept)}
                            >
                              <Check className="h-3.5 w-3.5 mr-1.5" />
                              Accept
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => setShowBlockConfirm(true)}
                            >
                              <Ban className="h-3.5 w-3.5 mr-1.5" />
                              Block
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void handleDeleteRequest()}
                            >
                              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                              Delete
                            </Button>
                          </div>
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={addToContactsOnAccept}
                              onChange={(e) => setAddToContactsOnAccept(e.target.checked)}
                              className="h-4 w-4 rounded border-amber-400 text-emerald-600 focus:ring-emerald-500 dark:border-amber-600"
                            />
                            <span className="text-xs text-amber-700 dark:text-amber-300">
                              Add to contacts when accepting
                            </span>
                          </label>
                        </div>
                      </div>
                    </div>
                  )}
                  {loadingConversation === activeContact?.handle && (
                    <div className="flex justify-center py-4">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                        <span className="text-sm">Loading messages...</span>
                      </div>
                    </div>
                  )}
                  {activeMessageItems.map((item) => {
                    if (item.type === "date") {
                      return (
                        <div key={`date-${item.key}`} className="flex w-full items-center gap-3 py-3">
                          <div className="h-px flex-1 bg-border/70" />
                          <div className="rounded-full border border-border bg-muted px-4 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground shadow-sm backdrop-blur-sm">
                            {item.label}
                          </div>
                          <div className="h-px flex-1 bg-border/70" />
                        </div>
                      )
                    }

                    const message = item.message
                    if (message.kind === "call" && message.callEventType && message.callType) {
                      return (
                        <CallNotice
                          key={message.id}
                          eventType={message.callEventType}
                          callType={message.callType}
                          direction={
                            message.callDirection ??
                            (message.direction === "out" ? "outgoing" : "incoming")
                          }
                          durationSeconds={message.callDurationSeconds}
                          timestamp={new Date(message.timestamp)}
                        />
                      )
                    }
                    const isPickerOpen = reactionPickerId === message.id
                    const showActions = isTouchActions
                      ? activeActionMessageId === message.id
                      : isPickerOpen
                    return (
                      <MessageBubble
                        key={message.id}
                        message={message}
                        activeMessageLookup={activeMessageLookup}
                        isPickerOpen={isPickerOpen}
                        showActions={showActions}
                        isTouchActions={isTouchActions}
                        isBusy={isBusy}
                        editingMessage={editingMessage}
                        highlightedMessageId={highlightedMessageId}
                        onMessageTap={handleMessageTap}
                        onScrollToMessage={(id) => setScrollToMessageId(id)}
                        onPreviewImage={setPreviewImage}
                        onPendingLink={setPendingLink}
                        onReaction={(msg, emoji, action) =>
                          void handleSendReaction(msg, emoji, action)
                        }
                        onReactionPickerOpen={(event, messageId) => {
                          if (messageId) {
                            reactionPickerAnchorRef.current = event.currentTarget
                            setActiveActionMessageId(messageId)
                            setReactionPickerId(messageId)
                          } else {
                            setReactionPickerId(null)
                          }
                        }}
                        onReply={beginReply}
                        onEdit={beginEdit}
                        onDelete={(msg) => void handleDeleteMessage(msg)}
                      />
                    )
                  })}
                  <div ref={scrollRef} />
                </>
              )}
            </div>
          </ScrollArea>
        </div>

        {activeContact ? (
          <ComposeArea
            activeContact={activeContact}
            composeText={composeText}
            onComposeTextChange={setComposeText}
            editingMessage={editingMessage}
            replyToMessage={replyToMessage}
            attachment={attachment}
            isBusy={isBusy}
            sendError={sendError}
            textareaRef={textareaRef}
            fileInputRef={fileInputRef}
            onCancelEdit={cancelEdit}
            onCancelReply={cancelReply}
            onRemoveAttachment={() => {
              setAttachment(null)
              if (fileInputRef.current) fileInputRef.current.value = ""
            }}
            onFileSelect={handleFileSelect}
            onTyping={handleTyping}
            onSubmit={() => void handleSubmit()}
            onPaste={handlePasteAttachment}
            onUnselectChat={() => {
              console.log("[chat-selection] unselect chat via ESC")
              setSuppressStoredSelection(true)
              setStoredActiveId(null)
              setActiveId("")
              void db.syncState.delete(LAST_SELECTED_CHAT_KEY)
              if (typeof window !== "undefined") {
                window.localStorage.removeItem(LAST_SELECTED_CHAT_KEY)
              }
            }}
          />
        ) : null}
      </SidebarInset>
      </SidebarProvider>
      {reactionPickerPortal}
    </TooltipProvider>
  )
}
