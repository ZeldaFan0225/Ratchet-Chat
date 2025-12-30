"use client"

import * as React from "react"
import { FileIcon, Paperclip, Send, X } from "lucide-react"
import TextareaAutosize from "react-textarea-autosize"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { getContactDisplayName } from "@/lib/contacts"
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
  const replySenderLabel = replyToMessage
    ? replyToMessage.direction === "out"
      ? "You"
      : replyToMessage.peerUsername ?? replyToMessage.peerHandle ?? "Unknown"
    : "Unknown"

  const replyPreviewText = replyToMessage
    ? truncateText(getReplyPreviewText(replyToMessage), 80)
    : ""

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
            size="icon"
            className="h-7 w-7 text-emerald-700 hover:text-emerald-900 dark:text-emerald-200 dark:hover:text-emerald-50"
            onClick={onCancelEdit}
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
            size="icon"
            className="h-7 w-7 text-emerald-700 hover:text-emerald-900 dark:text-emerald-200 dark:hover:text-emerald-50"
            onClick={onCancelReply}
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
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={onRemoveAttachment}
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
            onChange={onFileSelect}
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
            className="bg-emerald-600 text-white hover:bg-emerald-600/90 shrink-0 mb-1"
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
    </div>
  )
}
