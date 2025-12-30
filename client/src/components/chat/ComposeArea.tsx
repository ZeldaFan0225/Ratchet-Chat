"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { FileIcon, Paperclip, Send, SmilePlus, X } from "lucide-react"
import TextareaAutosize from "react-textarea-autosize"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { EmojiMartPicker } from "@/components/emoji/EmojiMartPicker"
import { getContactDisplayName } from "@/lib/contacts"
import { cn } from "@/lib/utils"
import type { StoredMessage } from "@/types/dashboard"
import { truncateText, getReplyPreviewText } from "@/lib/messageUtils"

type AttachmentPreview = {
  name: string
  type: string
  size: number
  data: string
}

type ComposeAreaProps = {
  activeContact: {
    handle: string
    username: string
    nickname?: string | null
  } | null
  composeText: string
  onComposeTextChange: (text: string) => void
  editingMessage: StoredMessage | null
  replyToMessage: StoredMessage | null
  attachment: AttachmentPreview | null
  isBusy: boolean
  sendError: string | null
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  fileInputRef: React.RefObject<HTMLInputElement | null>
  onCancelEdit: () => void
  onCancelReply: () => void
  onRemoveAttachment: () => void
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void
  onTyping: () => void
  onSubmit: () => void
  onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void
  onUnselectChat: () => void
}

export function ComposeArea({
  activeContact,
  composeText,
  onComposeTextChange,
  editingMessage,
  replyToMessage,
  attachment,
  isBusy,
  sendError,
  textareaRef,
  fileInputRef,
  onCancelEdit,
  onCancelReply,
  onRemoveAttachment,
  onFileSelect,
  onTyping,
  onSubmit,
  onPaste,
  onUnselectChat,
}: ComposeAreaProps) {
  const { theme } = useTheme()
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = React.useState(false)
  const emojiButtonRef = React.useRef<HTMLButtonElement | null>(null)
  const emojiPickerRef = React.useRef<HTMLDivElement | null>(null)
  const [emojiPickerPosition, setEmojiPickerPosition] = React.useState<{
    top: number
    left: number
    width: number
    height: number
  } | null>(null)
  const emojiTheme = theme === "dark" ? "dark" : theme === "system" ? "auto" : "light"

  const updateEmojiPickerPosition = React.useCallback(() => {
    const anchor = emojiButtonRef.current
    if (!anchor) {
      return
    }
    const rect = anchor.getBoundingClientRect()
    const gutter = 12
    const offset = 8
    const maxWidth = Math.max(0, window.innerWidth - gutter * 2)
    const maxHeight = Math.max(0, window.innerHeight - gutter * 2)
    const width = Math.min(360, maxWidth)
    const height = Math.min(360, maxHeight)
    let left = rect.left
    const maxLeft = window.innerWidth - width - gutter
    left = Math.min(Math.max(left, gutter), maxLeft)
    let top = rect.top - height - offset
    if (top < gutter) {
      top = rect.bottom + offset
    }
    const maxTop = window.innerHeight - height - gutter
    top = Math.min(Math.max(top, gutter), maxTop)
    setEmojiPickerPosition({ top, left, width, height })
  }, [])

  const handleEmojiSelect = React.useCallback(
    (emoji: string) => {
      const textarea = textareaRef.current
      const currentText = composeText
      if (!textarea) {
        onComposeTextChange(`${currentText}${emoji}`)
        onTyping()
        setIsEmojiPickerOpen(false)
        return
      }
      const start = textarea.selectionStart ?? currentText.length
      const end = textarea.selectionEnd ?? currentText.length
      const nextValue = `${currentText.slice(0, start)}${emoji}${currentText.slice(end)}`
      onComposeTextChange(nextValue)
      onTyping()
      setIsEmojiPickerOpen(false)
      requestAnimationFrame(() => {
        textarea.focus()
        const caret = start + emoji.length
        textarea.setSelectionRange(caret, caret)
      })
    },
    [composeText, onComposeTextChange, onTyping, textareaRef]
  )

  React.useEffect(() => {
    if (!isEmojiPickerOpen) {
      return
    }
    updateEmojiPickerPosition()
    const handleResize = () => updateEmojiPickerPosition()
    const handleScroll = () => updateEmojiPickerPosition()
    window.addEventListener("resize", handleResize)
    window.addEventListener("scroll", handleScroll, true)
    return () => {
      window.removeEventListener("resize", handleResize)
      window.removeEventListener("scroll", handleScroll, true)
    }
  }, [isEmojiPickerOpen, updateEmojiPickerPosition])

  React.useEffect(() => {
    if (!isEmojiPickerOpen) {
      return
    }
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (emojiPickerRef.current?.contains(target)) {
        return
      }
      if (emojiButtonRef.current?.contains(target)) {
        return
      }
      setIsEmojiPickerOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsEmojiPickerOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside, true)
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("mousedown", handleClickOutside, true)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [isEmojiPickerOpen])

  const replySenderLabel = replyToMessage
    ? replyToMessage.direction === "out"
      ? "You"
      : replyToMessage.peerUsername ?? replyToMessage.peerHandle ?? "Unknown"
    : "Unknown"

  const replyPreviewText = replyToMessage
    ? truncateText(getReplyPreviewText(replyToMessage), 80)
    : ""

  const portalRoot = typeof document !== "undefined" ? document.body : null
  const emojiPickerPortal =
    portalRoot && isEmojiPickerOpen && emojiPickerPosition
      ? createPortal(
          <div
            ref={emojiPickerRef}
            className="fixed z-[9999] overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
            style={{
              top: emojiPickerPosition.top,
              left: emojiPickerPosition.left,
              width: emojiPickerPosition.width,
              height: emojiPickerPosition.height,
            }}
          >
            <EmojiMartPicker
              height={emojiPickerPosition.height}
              width={emojiPickerPosition.width}
              theme={emojiTheme}
              onEmojiSelect={handleEmojiSelect}
            />
          </div>,
          portalRoot
        )
      : null

  return (
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
            size="icon-sm"
            className="text-emerald-700 hover:text-emerald-900 dark:text-emerald-200 dark:hover:text-emerald-50"
            onClick={onCancelEdit}
            title="Cancel editing"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
      {!editingMessage && replyToMessage ? (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-900/30 dark:bg-emerald-900/20 dark:text-emerald-100">
          <div className="min-w-0">
            <p className="font-semibold">Replying to {replySenderLabel}</p>
            <p className="truncate text-[10px] text-emerald-700 dark:text-emerald-300">
              {replyPreviewText}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-emerald-700 hover:text-emerald-900 dark:text-emerald-200 dark:hover:text-emerald-50"
            onClick={onCancelReply}
            title="Cancel reply"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : null}
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
              <span className="text-xs font-medium max-w-[200px] truncate">
                {attachment.name}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {(attachment.size / 1024).toFixed(1)} KB
              </span>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={onRemoveAttachment}
            title="Remove attachment"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
      <Card className="border-border bg-card/90 shadow-sm">
        <CardContent className="flex items-center gap-3 p-3">
          <input
            type="file"
            className="hidden"
            ref={fileInputRef}
            onChange={onFileSelect}
          />
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground shrink-0"
            onClick={() => fileInputRef.current?.click()}
            disabled={!activeContact || isBusy || Boolean(editingMessage)}
          >
            <Paperclip />
          </Button>
          <Button
            ref={emojiButtonRef}
            variant="ghost"
            size="icon"
            className={cn(
              "shrink-0",
              isEmojiPickerOpen ? "text-foreground" : "text-muted-foreground"
            )}
            onClick={() => setIsEmojiPickerOpen((open) => !open)}
            aria-label="Insert emoji"
            aria-expanded={isEmojiPickerOpen}
            disabled={!activeContact || isBusy}
          >
            <SmilePlus />
          </Button>
          <TextareaAutosize
            ref={textareaRef}
            placeholder={
              editingMessage
                ? "Edit message"
                : activeContact
                ? `Message ${getContactDisplayName(activeContact)}`
                : "Select a chat to start messaging"
            }
            className="flex-1 min-h-[40px] max-h-[200px] w-full resize-none border-none bg-transparent py-2.5 px-0 text-sm shadow-none focus-visible:ring-0 outline-none"
            value={composeText}
            onChange={(event) => {
              onComposeTextChange(event.target.value)
              onTyping()
            }}
            onPaste={onPaste}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                if (isEmojiPickerOpen) {
                  event.preventDefault()
                  setIsEmojiPickerOpen(false)
                  return
                }
                if (attachment) {
                  event.preventDefault()
                  onRemoveAttachment()
                  return
                }
                if (replyToMessage) {
                  event.preventDefault()
                  onCancelReply()
                  return
                }
                if (!editingMessage && !composeText.trim()) {
                  event.preventDefault()
                  onUnselectChat()
                }
                return
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                onSubmit()
              }
            }}
            disabled={!activeContact || isBusy}
          />
          <Button
            variant="accept"
            className="shrink-0"
            disabled={
              (!composeText.trim() && (!attachment || Boolean(editingMessage))) ||
              !activeContact ||
              isBusy
            }
            onClick={onSubmit}
          >
            <Send className="h-4 w-4 mr-2" />
            {editingMessage ? "Save" : "Send"}
          </Button>
        </CardContent>
      </Card>
      {sendError ? (
        <p className="mt-2 text-center text-xs text-destructive">{sendError}</p>
      ) : null}
      {emojiPickerPortal}
    </div>
  )
}
