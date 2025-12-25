"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import {
  Check,
  CheckCheck,
  Download,
  FileIcon,
  Info,
  MoreVertical,
  PencilLine,
  Paperclip,
  Search,
  Send,
  SmilePlus,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react"
import TextareaAutosize from "react-textarea-autosize"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import EmojiPicker, { Theme } from "emoji-picker-react"
import { useTheme } from "next-themes"

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
import { useSocket } from "@/context/SocketContext"
import { useSettings } from "@/hooks/useSettings"
import { useRatchetSync } from "@/hooks/useRatchetSync"
import { apiFetch } from "@/lib/api"
import {
  decryptString,
  buildMessageSignaturePayload,
  encryptString,
  encryptTransitEnvelope,
  decryptTransitBlob,
  getIdentityPublicKey,
  signMessage,
  decodeUtf8,
} from "@/lib/crypto"
import { normalizeHandle, splitHandle } from "@/lib/handles"
import { db, type MessageRecord, type ContactRecord } from "@/lib/db"
import { cn } from "@/lib/utils"
import { RecipientInfoDialog } from "@/components/RecipientInfoDialog"
import { ImagePreviewDialog } from "@/components/ImagePreviewDialog"
import { LinkWarningDialog } from "@/components/LinkWarningDialog"

type Attachment = {
  filename: string
  mimeType: string
  size: number
  data: string // Base64
}

type Contact = {
  handle: string
  username: string
  host: string
  publicIdentityKey: string
  publicTransportKey: string
  createdAt?: string
}

type ReactionSummary = {
  emoji: string
  count: number
  reactedByMe: boolean
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
  attachments?: Attachment[]
  timestamp: string
  kind?: "message" | "edit" | "delete" | "reaction"
  editedAt?: string
  deletedAt?: string
  reactionAction?: "add" | "remove"
  reactions?: ReactionSummary[]
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
      createdAt: record.createdAt,
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
    createdAt: contact.createdAt || new Date().toISOString(),
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
      attachments?: Attachment[]
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
      type?: "edit" | "delete" | "reaction" | "message"
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
    } = {}
    try {
      payload = JSON.parse(plaintext) as typeof payload
    } catch {
      payload = { text: plaintext }
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

function getEventTimestamp(message: StoredMessage) {
  const value = message.editedAt ?? message.deletedAt ?? message.timestamp
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? 0 : parsed.valueOf()
}

function applyMessageEvents(messages: StoredMessage[]) {
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
      next.push(message)
    }
  }
  return next
}

const DELETE_SIGNATURE_BODY = "ratchet-chat:delete"
const REACTION_PICKER_SIZE = 320
const REACTION_PICKER_GUTTER = 12
const REACTION_PICKER_OFFSET = 8

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
  const { user, masterKey, identityPrivateKey, transportPrivateKey, logout } = useAuth()
  const { theme } = useTheme()
  const socket = useSocket()
  const { settings } = useSettings()
  const { lastSync, runSync } = useRatchetSync()
  const [contacts, setContacts] = React.useState<Contact[]>([])
  const [activeId, setActiveId] = React.useState<string>("")
  const [messages, setMessages] = React.useState<StoredMessage[]>([])
  const [composeText, setComposeText] = React.useState("")
  const [editingMessage, setEditingMessage] = React.useState<StoredMessage | null>(null)
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
  const [attachment, setAttachment] = React.useState<{ name: string; type: string; size: number; data: string } | null>(null)
  const [previewImage, setPreviewImage] = React.useState<string | null>(null)
  const [pendingLink, setPendingLink] = React.useState<string | null>(null)
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
  const visibleMessages = React.useMemo(
    () => applyMessageEvents(messages),
    [messages]
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
        const plaintextBytes = await decryptTransitBlob(data.encrypted_blob, transportPrivateKey)
        const plaintext = decodeUtf8(plaintextBytes)
        const payload = JSON.parse(plaintext) as { type: string; status?: boolean }
        
        if (payload.type === "typing") {
          const isTyping = Boolean(payload.status)
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
      const list = contacts.map((contact) => {
        const thread = messagesByPeer.get(contact.handle) ?? []
        const lastMessage = thread[thread.length - 1]
        const isActive = contact.handle === activeId
        const unread = isActive
          ? 0
          : thread.filter((m) => m.direction === "in" && !m.isRead).length
        
        const rawText = lastMessage?.text || (lastMessage?.attachments?.length ? "📎 Attachment" : "No messages yet")

        return {
          id: contact.handle,
          uid: contact.handle,
          name: contact.username,
          handle: contact.handle,
          lastMessage: truncate(rawText),
          lastTimestamp: formatTimestamp(lastMessage?.timestamp ?? ""),
          lastTimestampRaw: lastMessage?.timestamp || contact.createdAt || "",
          unread,
          status: "offline" as const,
        }
      })

      // Sort by last activity (message timestamp or contact creation date)
      return list
        .sort((a, b) => b.lastTimestampRaw.localeCompare(a.lastTimestampRaw))
        .map(({ lastTimestampRaw, ...conv }) => conv)
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

      const rawText = lastMessage?.text || (lastMessage?.attachments?.length ? "📎 Attachment" : "No messages yet")

      results.push({
        id: contact.handle,
        uid: contact.handle,
        name: contact.username,
        handle: contact.handle,
        lastMessage: truncate(rawText),
        lastTimestamp: formatTimestamp(lastMessage?.timestamp ?? ""),
        unread,
        status: "offline" as const,
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
          lastMessage: truncate(msg.text),
          lastTimestamp: formatTimestamp(msg.timestamp),
          unread: 0, // Search results typically don't show unread counts for the message itself
          status: "offline" as const,
          foundMessageId: msg.id
        })
      }
    }

    return results
  }, [contacts, messagesByPeer, activeId, sidebarSearchQuery])


  const handleTyping = React.useCallback(async () => {
    if (!settings.showTypingIndicator || !activeContact || !socket || !activeContact.publicTransportKey) return

    // Clear existing timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current)
    } else {
       const payload = JSON.stringify({ type: "typing", status: true })
       encryptTransitEnvelope(payload, activeContact.publicTransportKey).then(blob => {
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
         socket.emit("signal", {
           recipient_handle: activeContact.handle,
           encrypted_blob: blob
         })
       })
       typingTimeoutRef.current = null
    }, 2000)
  }, [activeContact, settings.showTypingIndicator, socket])

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
          decodeMessageRecord(record, masterKey, record.senderId)
        )
      )
      const nextMessages = decoded.filter(Boolean) as StoredMessage[]
      setMessages(nextMessages)
    }
    void loadMessages()
  }, [masterKey, lastSync, user])

  React.useEffect(() => {
    if (!masterKey || !user || visibleMessages.length === 0) {
      return
    }
    const ownerId = user.id ?? user.handle
    const pendingSaves: Contact[] = []
    setContacts((current) => {
      let changed = false
      const next = [...current]
      for (const message of visibleMessages) {
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
            createdAt: message.timestamp,
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
  }, [visibleMessages, masterKey, user])

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
      
      // Gate read receipts based on settings
      if (!settings.sendReadReceipts) return

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
  }, [activeContact, activeMessagesRaw, settings.sendReadReceipts])

  const handleDeleteChat = React.useCallback(async () => {
    if (!activeContact || !user) return
    const confirmDelete = window.confirm(
      `Are you sure you want to delete the chat with ${activeContact.username}? This cannot be undone.`
    )
    if (!confirmDelete) return

    const ownerId = user.id ?? user.handle
    // Delete messages locally (include edit/delete events)
    const ids = messages
      .filter((message) => message.peerHandle === activeContact.handle)
      .map((message) => message.id)
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
    }

    // Update state
    setContacts((prev) => prev.filter((c) => c.handle !== activeContact.handle))
    setMessages((prev) => prev.filter((m) => !ids.includes(m.id)))
    setActiveId("")
  }, [activeContact, user, messages])

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

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 10 * 1024 * 1024) {
      setSendError("File too large (max 10MB)")
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      // Extract base64 data (remove "data:mime/type;base64,")
      const base64 = dataUrl.split(",")[1]
      setAttachment({
        name: file.name,
        type: file.type,
        size: file.size,
        data: base64
      })
      setSendError(null)
    }
    reader.readAsDataURL(file)
  }

  const beginEdit = React.useCallback((message: StoredMessage) => {
    if (message.direction !== "out" || !message.text) {
      return
    }
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

  const handleSendMessage = React.useCallback(async () => {
    const trimmed = composeText.trim()
    if (!trimmed && !attachment) {
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
      
      const attachments = attachment ? [{
        filename: attachment.name,
        mimeType: attachment.type,
        size: attachment.size,
        data: attachment.data
      }] : undefined

      const payload = JSON.stringify({
        content: trimmed,
        sender_handle: user.handle,
        sender_signature: signature,
        sender_identity_key: getIdentityPublicKey(identityPrivateKey),
        message_id: messageId,
        attachments
      })
      const encryptedBlob = await encryptTransitEnvelope(
        payload,
        activeContact.publicTransportKey
      )
      const localPayload = JSON.stringify({
        text: trimmed,
        attachments,
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
      setAttachment(null)
      if (fileInputRef.current) fileInputRef.current.value = ""
    } catch (error) {
      setSendError(
        error instanceof Error ? error.message : "Unable to send message"
      )
    } finally {
      setIsBusy(false)
    }
  }, [activeContact, composeText, identityPrivateKey, masterKey, user?.handle, attachment])

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
    if (!activeContact || !masterKey || !identityPrivateKey) {
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
        sender_identity_key: getIdentityPublicKey(identityPrivateKey),
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
        peerUsername: activeContact.username,
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
        content: JSON.stringify({
          encrypted_blob: encryptedLocal.ciphertext,
          iv: encryptedLocal.iv,
        }),
        verified: true,
        isRead: true,
        receiptStatus: undefined,
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
          message_id: editEventId,
          sender_vault_blob: encryptedLocal.ciphertext,
          sender_vault_iv: encryptedLocal.iv,
          sender_vault_signature_verified: true,
        },
      })
      const vaultStored = Boolean(sendResponse?.sender_vault_stored)
      await db.messages.update(editEventId, {
        receiptStatus: "DELIVERED_TO_SERVER",
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
    user?.handle,
    user?.id,
    socket,
  ])

  const handleDeleteMessage = React.useCallback(
    async (message: StoredMessage) => {
      if (message.direction !== "out") {
        return
      }
      if (!activeContact || !masterKey || !identityPrivateKey) {
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
          sender_identity_key: getIdentityPublicKey(identityPrivateKey),
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
          peerUsername: activeContact.username,
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
          content: JSON.stringify({
            encrypted_blob: encryptedLocal.ciphertext,
            iv: encryptedLocal.iv,
          }),
          verified: true,
          isRead: true,
          receiptStatus: undefined,
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
            message_id: deleteEventId,
            sender_vault_blob: encryptedLocal.ciphertext,
            sender_vault_iv: encryptedLocal.iv,
            sender_vault_signature_verified: true,
          },
        })
        const vaultStored = Boolean(sendResponse?.sender_vault_stored)
        await db.messages.update(deleteEventId, {
          receiptStatus: "DELIVERED_TO_SERVER",
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
      if (!activeContact || !masterKey || !identityPrivateKey) {
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
          sender_identity_key: getIdentityPublicKey(identityPrivateKey),
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
          peerUsername: activeContact.username,
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
          content: JSON.stringify({
            encrypted_blob: encryptedLocal.ciphertext,
            iv: encryptedLocal.iv,
          }),
          verified: true,
          isRead: true,
          receiptStatus: undefined,
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
            message_id: reactionEventId,
            sender_vault_blob: encryptedLocal.ciphertext,
            sender_vault_iv: encryptedLocal.iv,
            sender_vault_signature_verified: true,
          },
        })
        const vaultStored = Boolean(sendResponse?.sender_vault_stored)
        await db.messages.update(reactionEventId, {
          receiptStatus: "DELIVERED_TO_SERVER",
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
      <AppSidebar
        conversations={conversations}
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
        <header className="flex flex-none items-center gap-3 border-b bg-background/85 px-5 py-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <div 
            className="flex flex-1 items-center gap-3 cursor-pointer transition-opacity hover:opacity-80 -ml-2 pl-2 rounded-md py-1 hover:bg-muted/50"
            onClick={() => activeContact && setShowRecipientInfo(true)}
          >
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
              {activeContact ? (
                activeContact.handle && typingStatus[activeContact.handle] ? (
                  <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 animate-pulse">
                    Typing...
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Encrypted session
                  </p>
                )
              ) : (
                <p className="text-xs text-muted-foreground">
                  Start by adding a username on the left.
                </p>
              )}
            </div>
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

        <div className="relative flex flex-1 flex-col overflow-hidden isolate">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_var(--chat-glow),_transparent_55%)] -z-10" />
          <div className="pointer-events-none absolute inset-0 opacity-40 bg-[linear-gradient(90deg,var(--chat-grid)_1px,transparent_1px),linear-gradient(0deg,var(--chat-grid)_1px,transparent_1px)] bg-[size:32px_32px] -z-10" />
          <ScrollArea className="h-full relative z-10">
            <div className="mx-auto flex w-full max-w-none flex-col gap-2 px-4 py-4">
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
                const isPickerOpen = reactionPickerId === message.id
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
                        "group flex items-start gap-2",
                        message.direction === "out"
                          ? "flex-row-reverse"
                          : "flex-row"
                      )}
                    >
                      <div
                        className={cn(
                          "flex w-fit max-w-[92%] flex-col",
                          message.direction === "out"
                            ? "items-end"
                            : "items-start"
                        )}
                      >
                        <div
                          className={cn(
                            "w-fit max-w-full pl-3 pr-5 py-2.5 text-sm leading-relaxed shadow-sm transition-all duration-500 break-words [word-break:break-word] overflow-hidden",
                            highlightedMessageId === message.id &&
                              "ring-2 ring-emerald-500 ring-offset-2 dark:ring-offset-slate-900 scale-[1.02]",
                            message.direction === "out"
                              ? "bg-emerald-100 dark:bg-emerald-900 text-foreground rounded-2xl rounded-br-sm"
                              : "bg-card dark:bg-muted text-foreground rounded-2xl rounded-bl-sm"
                          )}
                        >
                          {message.attachments?.map((att, i) => (
                            <div key={i} className="mb-2 rounded-lg overflow-hidden">
                              {att.mimeType.startsWith("image/") ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={`data:${att.mimeType};base64,${att.data}`}
                                  alt={att.filename}
                                  className="max-w-full h-auto max-h-64 object-cover cursor-pointer hover:opacity-90 transition-opacity"
                                  onClick={() =>
                                    setPreviewImage(
                                      `data:${att.mimeType};base64,${att.data}`
                                    )
                                  }
                                />
                              ) : (
                                <a
                                  href={`data:${att.mimeType};base64,${att.data}`}
                                  download={att.filename}
                                  className="flex items-center gap-2 p-3 bg-background/50 rounded-lg hover:bg-background/80 transition-colors"
                                >
                                  <div className="p-2 bg-emerald-500/10 rounded-md">
                                    <FileIcon className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="font-medium truncate">
                                      {att.filename}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                      {(att.size / 1024).toFixed(1)} KB
                                    </p>
                                  </div>
                                  <Download className="h-4 w-4 text-muted-foreground" />
                                </a>
                              )}
                            </div>
                          ))}
                          {message.text && (
                            <div className="whitespace-pre-wrap prose prose-sm dark:prose-invert prose-emerald max-w-none prose-p:leading-relaxed prose-pre:bg-muted prose-pre:p-2 prose-pre:rounded-md prose-code:text-emerald-600 dark:prose-code:text-emerald-400 break-words [word-break:break-word]">
                              <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                components={{
                                  a: ({ node, href, children, ...props }) => {
                                    return (
                                      <a
                                        href={href}
                                        onClick={(e) => {
                                          e.preventDefault()
                                          if (href) setPendingLink(href)
                                        }}
                                        {...props}
                                      >
                                        {children}
                                      </a>
                                    )
                                  },
                                }}
                              >
                                {message.text}
                              </ReactMarkdown>
                            </div>
                          )}
                          <div className="mt-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                            <span>{meta}</span>
                            {message.editedAt ? <span>Edited</span> : null}
                            {message.verified && (
                              <ShieldCheck
                                className="h-3 w-3 text-emerald-500"
                                aria-label="Verified Signature"
                              />
                            )}
                            {receiptStatus ? (
                              receiptStatus === "DELIVERED_TO_SERVER" ? (
                                <Check className="h-3 w-3" aria-label="Sent" />
                              ) : receiptStatus === "PROCESSED_BY_CLIENT" ? (
                                <CheckCheck
                                  className="h-3 w-3"
                                  aria-label="Delivered"
                                />
                              ) : receiptStatus === "READ_BY_USER" ? (
                                <CheckCheck
                                  className="h-3 w-3 text-sky-500"
                                  aria-label="Read"
                                />
                              ) : null
                            ) : null}
                          </div>
                        </div>
                        {message.reactions && message.reactions.length > 0 ? (
                          <div
                            className={cn(
                              "-mt-1 inline-flex flex-wrap items-center gap-1 rounded-full border px-2 py-1 text-[11px] shadow-sm",
                              message.direction === "out"
                                ? "self-end border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-900/30 dark:text-emerald-200"
                                : "self-start border-border bg-card/90 text-muted-foreground"
                            )}
                          >
                            {message.reactions.map((reaction) => (
                              <button
                                key={reaction.emoji}
                                type="button"
                                className={cn(
                                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors",
                                  reaction.reactedByMe
                                    ? "bg-emerald-200/70 text-emerald-900 dark:bg-emerald-800/60 dark:text-emerald-100"
                                    : "hover:bg-muted/80"
                                )}
                                onClick={() =>
                                  void handleSendReaction(
                                    message,
                                    reaction.emoji,
                                    reaction.reactedByMe ? "remove" : "add"
                                  )
                                }
                                disabled={isBusy}
                                aria-pressed={reaction.reactedByMe}
                                aria-label={`React ${reaction.emoji}`}
                              >
                                <span>{reaction.emoji}</span>
                                <span className="text-[10px]">
                                  {reaction.count}
                                </span>
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <div
                        className={cn(
                          "relative flex items-center opacity-0 transition-opacity duration-200 group-hover:opacity-100",
                          isPickerOpen && "opacity-100"
                        )}
                      >
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              data-reaction-button="true"
                              className="h-6 w-6 text-slate-400 hover:text-slate-600"
                              onClick={(event) => {
                                if (isPickerOpen) {
                                  setReactionPickerId(null)
                                  return
                                }
                                reactionPickerAnchorRef.current = event.currentTarget
                                setReactionPickerId(message.id)
                              }}
                              disabled={Boolean(editingMessage) || isBusy}
                            >
                              <SmilePlus className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">
                            Add reaction
                          </TooltipContent>
                        </Tooltip>
                        {message.direction === "out" && message.text ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-slate-400 hover:text-slate-600"
                                onClick={() => beginEdit(message)}
                                disabled={Boolean(editingMessage)}
                              >
                                <PencilLine className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-xs">
                              Edit message
                            </TooltipContent>
                          </Tooltip>
                        ) : null}
                        {message.direction === "out" ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-slate-400 hover:text-destructive"
                                onClick={() => void handleDeleteMessage(message)}
                                disabled={Boolean(editingMessage) || isBusy}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-xs">
                              Delete message
                            </TooltipContent>
                          </Tooltip>
                        ) : null}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-6 w-6 text-slate-400 hover:text-slate-600">
                              <Info className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent
                            side="top"
                            className="text-xs"
                          >
                            <div className="space-y-1">
                              <p><span className="font-semibold">Status:</span> {message.direction === 'out' && receiptStatus ? receiptStatus : (message.direction === 'in' ? 'received' : 'sending...')}</p>
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
          {editingMessage && (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-900/30 dark:bg-emerald-900/20 dark:text-emerald-100">
              <div className="min-w-0">
                <p className="font-semibold">Editing message</p>
                <p className="truncate text-[10px] text-emerald-700 dark:text-emerald-300">
                  {editingMessage.text}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-emerald-700 hover:text-emerald-900 dark:text-emerald-200 dark:hover:text-emerald-50"
                onClick={cancelEdit}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}
          {attachment && (
            <div className="mb-3 flex items-center justify-between rounded-lg border bg-card p-2 shadow-sm">
              <div className="flex items-center gap-3">
                {attachment.type.startsWith("image/") ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`data:${attachment.type};base64,${attachment.data}`}
                    alt="Preview"
                    className="h-10 w-10 rounded-md object-cover"
                  />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
                    <FileIcon className="h-5 w-5 text-muted-foreground" />
                  </div>
                )}
                <div className="flex flex-col">
                  <span className="text-xs font-medium max-w-[200px] truncate">{attachment.name}</span>
                  <span className="text-[10px] text-muted-foreground">{(attachment.size / 1024).toFixed(1)} KB</span>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={() => {
                  setAttachment(null)
                  if (fileInputRef.current) fileInputRef.current.value = ""
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}
          <Card className="border-border bg-card/90 shadow-sm">
            <CardContent className="flex items-end gap-3 p-3">
              <input
                type="file"
                className="hidden"
                ref={fileInputRef}
                onChange={handleFileSelect}
              />
              <Button 
                variant="ghost" 
                size="icon" 
                className="text-muted-foreground shrink-0 mb-1"
                onClick={() => fileInputRef.current?.click()}
                disabled={!activeContact || isBusy || Boolean(editingMessage)}
              >
                <Paperclip />
              </Button>
              <TextareaAutosize
                ref={textareaRef}
                placeholder={
                  editingMessage
                    ? "Edit message"
                    : activeContact
                    ? `Message ${activeContact.username}`
                    : "Select a chat to start messaging"
                }
                className="flex-1 min-h-[40px] max-h-[200px] w-full resize-none border-none bg-transparent py-2.5 px-0 text-sm shadow-none focus-visible:ring-0 outline-none"
                value={composeText}
                onChange={(event) => {
                  setComposeText(event.target.value)
                  handleTyping()
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault()
                    void handleSubmit()
                  }
                }}
                disabled={!activeContact || isBusy}
              />
              <Button
                className="bg-emerald-600 text-white hover:bg-emerald-600/90 shrink-0 mb-1"
                disabled={
                  (!composeText.trim() && (!attachment || Boolean(editingMessage))) ||
                  !activeContact ||
                  isBusy
                }
                onClick={() => void handleSubmit()}
              >
                <Send className="h-4 w-4 mr-2" />
                {editingMessage ? "Save" : "Send"}
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
      {reactionPickerPortal}
    </TooltipProvider>
  )
}
