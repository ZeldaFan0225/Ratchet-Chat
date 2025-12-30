"use client"

import * as React from "react"
import {
  Check,
  CheckCheck,
  CornerUpLeft,
  Download,
  FileIcon,
  Info,
  PencilLine,
  ShieldAlert,
  ShieldCheck,
  SmilePlus,
  Trash2,
} from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { formatMessageTime, truncateText, getReplyPreviewText } from "@/lib/messageUtils"
import { extractUrl, isEmbeddable } from "@/lib/urlUtils"
import { useEmbedPreview } from "@/hooks/useEmbedPreview"
import { useSettings } from "@/hooks/useSettings"
import { LinkEmbed, LinkEmbedSkeleton } from "@/components/chat/LinkEmbed"
import type { StoredMessage } from "@/types/dashboard"

type MessageBubbleProps = {
  message: StoredMessage
  activeMessageLookup: Map<string, StoredMessage>
  isPickerOpen: boolean
  showActions: boolean
  isTouchActions: boolean
  isBusy: boolean
  editingMessage: StoredMessage | null
  highlightedMessageId: string | null
  onMessageTap: (event: React.MouseEvent, message: StoredMessage) => void
  onScrollToMessage: (id: string) => void
  onPreviewImage: (src: string) => void
  onPendingLink: (url: string) => void
  onReaction: (message: StoredMessage, emoji: string, action: "add" | "remove") => void
  onReactionPickerOpen: (event: React.MouseEvent<HTMLButtonElement>, messageId: string) => void
  onReply: (message: StoredMessage) => void
  onEdit: (message: StoredMessage) => void
  onDelete: (message: StoredMessage) => void
}

export function MessageBubble({
  message,
  activeMessageLookup,
  isPickerOpen,
  showActions,
  isTouchActions,
  isBusy,
  editingMessage,
  highlightedMessageId,
  onMessageTap,
  onScrollToMessage,
  onPreviewImage,
  onPendingLink,
  onReaction,
  onReactionPickerOpen,
  onReply,
  onEdit,
  onDelete,
}: MessageBubbleProps) {
  const meta = formatMessageTime(message.timestamp)
  const deliveredAt = message.direction === "out" ? message.deliveredAt : null
  const processedAt = message.direction === "out" ? message.processedAt : null
  const readAt = message.direction === "out" ? message.readAt : null
  const receiptState = readAt
    ? "READ"
    : processedAt
    ? "PROCESSED"
    : deliveredAt
    ? "DELIVERED"
    : null

  const replyTarget = message.replyTo?.messageId
    ? activeMessageLookup.get(message.replyTo.messageId)
    : null
  const replySender = replyTarget
    ? replyTarget.direction === "out"
      ? "You"
      : replyTarget.peerUsername ?? replyTarget.peerHandle
    : null
  const replyPreview = replyTarget
    ? truncateText(getReplyPreviewText(replyTarget), 90)
    : "Message deleted"

  // Link embed preview
  const { settings } = useSettings()
  const embeddableUrl = React.useMemo(() => {
    if (!message.text) return null
    const url = extractUrl(message.text)
    return url && isEmbeddable(url) ? url : null
  }, [message.text])
  const { data: embedData, isLoading: isEmbedLoading } = useEmbedPreview(
    embeddableUrl,
    settings.enableLinkPreviews
  )

  return (
    <div
      key={message.id}
      id={`message-${message.id}`}
      className={cn(
        "flex w-full",
        message.direction === "out" ? "justify-end" : "justify-start"
      )}
    >
      <div
        className={cn(
          "group flex items-start gap-2",
          message.direction === "out" ? "flex-row-reverse" : "flex-row"
        )}
        data-message-id={message.id}
      >
        <div
          className={cn(
            "flex w-fit max-w-[92%] flex-col",
            message.direction === "out" ? "items-end" : "items-start"
          )}
        >
          <div
            className={cn(
              "w-fit max-w-full px-2.5 py-2.5 text-sm leading-relaxed shadow-sm transition-all duration-500 break-words [word-break:break-word] overflow-hidden",
              highlightedMessageId === message.id &&
                "ring-2 ring-emerald-500 ring-offset-2 dark:ring-offset-slate-900 scale-[1.02]",
              message.direction === "out"
                ? "bg-emerald-100 dark:bg-emerald-900 text-foreground rounded-2xl rounded-br-sm"
                : "bg-card dark:bg-muted text-foreground rounded-2xl rounded-bl-sm"
            )}
            onClick={(event) => onMessageTap(event, message)}
          >
            {message.replyTo?.messageId ? (
              <div
                data-no-action-toggle="true"
                role={replyTarget ? "button" : undefined}
                onClick={() => {
                  if (replyTarget) {
                    onScrollToMessage(replyTarget.id)
                  }
                }}
                className={cn(
                  "mb-2 flex flex-col gap-0.5 rounded-md px-2 py-1 text-[11px]",
                  message.direction === "out"
                    ? "bg-emerald-300/70 text-emerald-950 dark:bg-emerald-800/70 dark:text-emerald-100"
                    : "bg-slate-200/80 text-slate-700 dark:bg-slate-700/60 dark:text-slate-200",
                  replyTarget &&
                    (message.direction === "out"
                      ? "cursor-pointer hover:bg-emerald-300/90 dark:hover:bg-emerald-800/90"
                      : "cursor-pointer hover:bg-slate-200/95 dark:hover:bg-slate-700/80")
                )}
              >
                {replyTarget ? (
                  <>
                    <span className="font-semibold">
                      Replying to {replySender}
                    </span>
                    <span className="truncate text-muted-foreground">
                      {replyPreview}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">Message deleted</span>
                )}
              </div>
            ) : null}
            {message.isMessageRequest && message.attachments?.length ? (
              <div
                className="mb-2 rounded-lg overflow-hidden border border-dashed border-amber-300 bg-amber-50/50 dark:border-amber-700 dark:bg-amber-950/30 p-4"
                data-no-action-toggle="true"
              >
                <div className="flex items-center gap-3 text-amber-700 dark:text-amber-300">
                  <ShieldAlert className="h-5 w-5 shrink-0" />
                  <div className="text-xs">
                    <p className="font-medium">
                      {message.attachments.length === 1
                        ? "1 attachment hidden"
                        : `${message.attachments.length} attachments hidden`}
                    </p>
                    <p className="text-amber-600 dark:text-amber-400">
                      Accept this request to view
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              message.attachments?.map((att, i) => (
                <div
                  key={i}
                  className="mb-2 rounded-lg overflow-hidden"
                  data-no-action-toggle="true"
                >
                  {att.mimeType.startsWith("image/") ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`data:${att.mimeType};base64,${att.data}`}
                      alt={att.filename}
                      className="max-w-full h-auto max-h-64 object-cover cursor-pointer hover:opacity-90 transition-opacity"
                      onClick={() =>
                        onPreviewImage(`data:${att.mimeType};base64,${att.data}`)
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
                        <p className="font-medium truncate">{att.filename}</p>
                        <p className="text-xs text-muted-foreground">
                          {(att.size / 1024).toFixed(1)} KB
                        </p>
                      </div>
                      <Download className="h-4 w-4 text-muted-foreground" />
                    </a>
                  )}
                </div>
              ))
            )}
            {message.text && (
              <div className="whitespace-pre-wrap prose prose-sm dark:prose-invert prose-emerald max-w-none prose-p:leading-relaxed prose-pre:bg-muted prose-pre:p-2 prose-pre:rounded-md prose-code:text-emerald-600 dark:prose-code:text-emerald-400 break-words [word-break:break-word]">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({ href, children, ...props }) => {
                      return (
                        <a
                          href={href}
                          onClick={(e) => {
                            e.preventDefault()
                            if (href) onPendingLink(href)
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
            {embeddableUrl && settings.enableLinkPreviews && (
              isEmbedLoading ? (
                <LinkEmbedSkeleton direction={message.direction} />
              ) : embedData ? (
                <LinkEmbed
                  data={embedData}
                  direction={message.direction}
                  onLinkClick={onPendingLink}
                />
              ) : null
            )}
            <div
              className={cn(
                "mt-2 flex w-full items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground",
                message.direction === "out" ? "justify-end text-right" : "justify-start"
              )}
            >
              <span>{meta}</span>
              {message.editedAt ? <span>Edited</span> : null}
              {message.verified && (
                <ShieldCheck
                  className="h-3 w-3 text-emerald-500"
                  aria-label="Verified Signature"
                />
              )}
              {receiptState ? (
                receiptState === "DELIVERED" ? (
                  <Check className="h-3 w-3" aria-label="Sent" />
                ) : receiptState === "PROCESSED" ? (
                  <CheckCheck className="h-3 w-3" aria-label="Delivered" />
                ) : receiptState === "READ" ? (
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
                    onReaction(
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
                  <span className="text-[10px]">{reaction.count}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div
          className={cn(
            "relative flex items-center opacity-0 transition-opacity duration-200 group-hover:opacity-100",
            (isPickerOpen || showActions) && "opacity-100",
            isTouchActions &&
              !(isPickerOpen || showActions) &&
              "pointer-events-none"
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
                    onReactionPickerOpen(event, "")
                    return
                  }
                  onReactionPickerOpen(event, message.id)
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-slate-400 hover:text-slate-600"
                onClick={() => onReply(message)}
                disabled={Boolean(editingMessage) || isBusy}
              >
                <CornerUpLeft className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              Reply
            </TooltipContent>
          </Tooltip>
          {message.direction === "out" && message.text ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-slate-400 hover:text-slate-600"
                  onClick={() => onEdit(message)}
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
                  onClick={() => onDelete(message)}
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
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-slate-400 hover:text-slate-600"
              >
                <Info className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              <div className="space-y-1">
                <p>
                  <span className="font-semibold">Status:</span>{" "}
                  {message.direction === "out"
                    ? receiptState
                      ? receiptState.toLowerCase()
                      : "sending..."
                    : "received"}
                </p>
                {message.direction === "out" && deliveredAt ? (
                  <p>
                    <span className="font-semibold">Delivered:</span>{" "}
                    {new Date(deliveredAt).toLocaleString()}
                  </p>
                ) : null}
                {message.direction === "out" && processedAt ? (
                  <p>
                    <span className="font-semibold">Processed:</span>{" "}
                    {new Date(processedAt).toLocaleString()}
                  </p>
                ) : null}
                {message.direction === "out" && readAt ? (
                  <p>
                    <span className="font-semibold">Read:</span>{" "}
                    {new Date(readAt).toLocaleString()}
                  </p>
                ) : null}
                <p>
                  <span className="font-semibold">Signature:</span>{" "}
                  {message.verified ? "Verified" : "Unverified"}
                </p>
                <p>
                  <span className="font-semibold">Time:</span>{" "}
                  {new Date(message.timestamp).toLocaleString()}
                </p>
                <p className="font-mono text-[9px] text-muted-foreground break-all">
                  {message.id}
                </p>
              </div>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}
