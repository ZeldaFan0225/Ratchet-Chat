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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
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
import { EmojiMartEmoji } from "@/components/emoji/EmojiMartEmoji"
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
  searchQuery?: string
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
  searchQuery,
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

  const [isInfoOpen, setIsInfoOpen] = React.useState(false)
  const [isSwiping, setIsSwiping] = React.useState(false)
  const [swipeOffset, setSwipeOffset] = React.useState(0)
  const swipeStartRef = React.useRef<{
    x: number
    y: number
    time: number
    target: EventTarget | null
  } | null>(null)
  const swipeAxisRef = React.useRef<"x" | "y" | null>(null)
  const lastSwipeAtRef = React.useRef<number | null>(null)

  // Link embed preview
  const { settings } = useSettings()

  // Search text highlighting
  const highlightText = React.useCallback(
    (text: string): React.ReactNode => {
      if (!searchQuery?.trim() || !text) return text

      const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const regex = new RegExp(`(${escaped})`, "gi")
      const parts = text.split(regex)

      return parts.map((part, i) =>
        part.toLowerCase() === searchQuery.toLowerCase() ? (
          <mark
            key={i}
            className="bg-yellow-300 dark:bg-yellow-500/50 rounded px-0.5"
          >
            {part}
          </mark>
        ) : (
          part
        )
      )
    },
    [searchQuery]
  )

  // Memoize ReactMarkdown components to avoid re-renders
  const markdownComponents = React.useMemo(
    () => ({
      a: ({ href, children, ...props }: React.ComponentProps<"a">) => (
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
      ),
      p: ({ children }: { children?: React.ReactNode }) => (
        <p>
          {React.Children.map(children, (child) =>
            typeof child === "string" ? highlightText(child) : child
          )}
        </p>
      ),
      li: ({ children, ...props }: React.ComponentProps<"li">) => (
        <li {...props}>
          {React.Children.map(children, (child) =>
            typeof child === "string" ? highlightText(child) : child
          )}
        </li>
      ),
      strong: ({ children, ...props }: React.ComponentProps<"strong">) => (
        <strong {...props}>
          {React.Children.map(children, (child) =>
            typeof child === "string" ? highlightText(child) : child
          )}
        </strong>
      ),
      em: ({ children, ...props }: React.ComponentProps<"em">) => (
        <em {...props}>
          {React.Children.map(children, (child) =>
            typeof child === "string" ? highlightText(child) : child
          )}
        </em>
      ),
    }),
    [highlightText, onPendingLink]
  )

  const embeddableUrl = React.useMemo(() => {
    if (!message.text) return null
    const url = extractUrl(message.text)
    return url && isEmbeddable(url) ? url : null
  }, [message.text])
  const { data: embedData, isLoading: isEmbedLoading } = useEmbedPreview(
    embeddableUrl,
    settings.enableLinkPreviews
  )
  const attachmentsCount = message.attachments?.length ?? 0
  const attachmentsSize = message.attachments?.reduce((sum, att) => sum + att.size, 0) ?? 0
  const statusLabel =
    message.direction === "out"
      ? receiptState
        ? receiptState.toLowerCase()
        : "sending..."
      : "received"
  const statusTone =
    receiptState === "READ"
      ? "text-sky-600"
      : receiptState === "PROCESSED"
      ? "text-amber-600"
      : receiptState === "DELIVERED"
      ? "text-emerald-600"
      : "text-muted-foreground"

  const formatInfoTimestamp = React.useCallback((value?: string | null) => {
    if (!value) return "—"
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return "—"
    return date.toLocaleString()
  }, [])

  const handleTouchStart = React.useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      if (!isTouchActions) return
      if (event.touches.length !== 1) return
      const touch = event.touches[0]
      swipeAxisRef.current = null
      setIsSwiping(false)
      setSwipeOffset(0)
      swipeStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
        target: event.target,
      }
    },
    [isTouchActions]
  )

  const handleTouchMove = React.useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      if (!isTouchActions) return
      const start = swipeStartRef.current
      if (!start) return
      if (event.cancelable) {
        event.preventDefault()
      }
      const touch = event.touches[0]
      if (!touch) return
      const dx = touch.clientX - start.x
      const dy = touch.clientY - start.y
      const absX = Math.abs(dx)
      const absY = Math.abs(dy)
      if (!swipeAxisRef.current) {
        if (absX < 6 && absY < 6) return
        swipeAxisRef.current = absX > absY + 8 ? "x" : "y"
      }
      if (swipeAxisRef.current === "y") {
        return
      }
      if (start.target instanceof HTMLElement) {
        if (
          start.target.closest(
            'a,button,input,textarea,select,label,[data-no-action-toggle="true"],[data-no-swipe="true"]'
          )
        ) {
          swipeAxisRef.current = null
          swipeStartRef.current = null
          setIsSwiping(false)
          setSwipeOffset(0)
          return
        }
      }
      if (event.cancelable) {
        event.preventDefault()
      }
      if (!isSwiping) {
        setIsSwiping(true)
      }
      const maxOffset = 120
      const linearOffset = maxOffset * 0.7
      const viewportWidth =
        typeof window !== "undefined" ? window.innerWidth : 360
      const slowdownStart = viewportWidth * 0.5
      const absDx = Math.abs(dx)
      const eased =
        absDx <= slowdownStart
          ? (absDx / slowdownStart) * linearOffset
          : linearOffset +
            (maxOffset - linearOffset) *
              (1 - Math.exp(-(absDx - slowdownStart) / (slowdownStart * 0.35)))
      const nextOffset = Math.sign(dx) * Math.min(maxOffset, eased)
      setSwipeOffset(nextOffset)
    },
    [isSwiping, isTouchActions]
  )

  const handleTouchEnd = React.useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      if (!isTouchActions) return
      const start = swipeStartRef.current
      swipeStartRef.current = null
      if (!start) return
      const swipeAxis = swipeAxisRef.current
      swipeAxisRef.current = null
      if (swipeAxis === "y") {
        setIsSwiping(false)
        setSwipeOffset(0)
        return
      }
      const touch = event.changedTouches[0]
      if (!touch) return
      const dx = touch.clientX - start.x
      const dy = touch.clientY - start.y
      const absX = Math.abs(dx)
      const absY = Math.abs(dy)
      const swipeThreshold = 72
      if (absX > 12 && absX > absY + 12) {
        lastSwipeAtRef.current = Date.now()
      }
      if (absX < swipeThreshold || absX < absY + 12) {
        setIsSwiping(false)
        setSwipeOffset(0)
        return
      }
      lastSwipeAtRef.current = Date.now()
      if (dx > 0) {
        onReply(message)
      } else {
        setIsInfoOpen(true)
      }
      setIsSwiping(false)
      setSwipeOffset(0)
    },
    [isTouchActions, message, onReply]
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
            onClick={(event) => {
              if (
                lastSwipeAtRef.current &&
                Date.now() - lastSwipeAtRef.current < 400
              ) {
                lastSwipeAtRef.current = null
                return
              }
              onMessageTap(event, message)
            }}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            style={{
              transform: swipeOffset ? `translateX(${swipeOffset}px)` : undefined,
              transition: isSwiping ? "none" : "transform 200ms ease",
              touchAction: isTouchActions ? "none" : undefined,
            }}
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
                  components={markdownComponents}
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
                "-mt-1 inline-flex min-h-8 flex-wrap items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] shadow-sm backdrop-blur",
                message.direction === "out"
                  ? "self-end border-emerald-200/80 bg-gradient-to-b from-emerald-50/90 to-emerald-100/80 text-emerald-700 shadow-emerald-200/40 dark:border-emerald-900/50 dark:from-emerald-900/40 dark:to-emerald-900/20 dark:text-emerald-200"
                  : "self-start border-border/70 bg-gradient-to-b from-card/95 to-card/70 text-muted-foreground shadow-black/5 dark:from-slate-900/70 dark:to-slate-900/40"
              )}
            >
              {message.reactions.map((reaction) => (
                <button
                  key={reaction.emoji}
                  type="button"
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 transition-colors",
                    reaction.reactedByMe
                      ? "bg-emerald-200/80 text-emerald-900 shadow-inner dark:bg-emerald-800/70 dark:text-emerald-100"
                      : "bg-background/60 text-muted-foreground hover:bg-background/80 dark:bg-background/20 dark:hover:bg-background/30"
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
                  <EmojiMartEmoji emoji={reaction.emoji} size={16} className="leading-none" />
                  <span className="text-[10px] leading-none">{reaction.count}</span>
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
          <Dialog open={isInfoOpen} onOpenChange={setIsInfoOpen}>
            <DialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-slate-400 hover:text-slate-600"
                aria-label="Message info"
              >
                <Info className="h-4 w-4" />
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[540px]">
              <DialogHeader>
                <DialogTitle>Message info</DialogTitle>
                <DialogDescription>
                  Delivery, security, and metadata for this message.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="rounded-lg border bg-muted/50 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">Delivery</span>
                    <span className={cn("text-xs font-semibold uppercase tracking-wide", statusTone)}>
                      {statusLabel}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">
                        {message.direction === "out" ? "Sent" : "Received"}
                      </span>
                      <span className="font-mono">{formatInfoTimestamp(message.timestamp)}</span>
                    </div>
                    {message.editedAt ? (
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Edited</span>
                        <span className="font-mono">{formatInfoTimestamp(message.editedAt)}</span>
                      </div>
                    ) : null}
                    {message.direction === "out" && deliveredAt ? (
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Delivered</span>
                        <span className="font-mono">{formatInfoTimestamp(deliveredAt)}</span>
                      </div>
                    ) : null}
                    {message.direction === "out" && processedAt ? (
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Processed</span>
                        <span className="font-mono">{formatInfoTimestamp(processedAt)}</span>
                      </div>
                    ) : null}
                    {message.direction === "out" && readAt ? (
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Read</span>
                        <span className="font-mono">{formatInfoTimestamp(readAt)}</span>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="rounded-lg border bg-muted/50 p-4">
                  <div className="text-sm font-semibold">Message</div>
                  <div className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Direction</span>
                      <span className="font-mono">
                        {message.direction === "out" ? "Outgoing" : "Incoming"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Sender</span>
                      <span className="font-mono">
                        {message.direction === "out"
                          ? "You"
                          : message.peerUsername ?? message.peerHandle}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Characters</span>
                      <span className="font-mono">{message.text?.length ?? 0}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Attachments</span>
                      <span className="font-mono">
                        {attachmentsCount > 0
                          ? `${attachmentsCount} (${(attachmentsSize / 1024).toFixed(1)} KB)`
                          : "None"}
                      </span>
                    </div>
                  </div>
                  {message.replyTo?.messageId ? (
                    <div className="mt-3 rounded-md border border-dashed border-border/70 bg-background/60 p-3 text-xs">
                      <div className="text-muted-foreground">Replying to</div>
                      <div className="mt-1 font-semibold">
                        {replyTarget ? replySender : "Message deleted"}
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        {replyTarget ? replyPreview : "Original message unavailable"}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="rounded-lg border bg-muted/50 p-4">
                  <div className="text-sm font-semibold">Security</div>
                  <div className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Signature</span>
                      <span
                        className={cn(
                          "font-semibold",
                          message.verified ? "text-emerald-600" : "text-amber-600"
                        )}
                      >
                        {message.verified ? "Verified" : "Unverified"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Peer handle</span>
                      <span className="font-mono">{message.peerHandle}</span>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border bg-muted/50 p-4">
                  <div className="text-sm font-semibold">Identifiers</div>
                  <div className="mt-2 text-[10px] text-muted-foreground">Local ID</div>
                  <div className="font-mono text-[10px] break-all">{message.id}</div>
                  {message.messageId ? (
                    <>
                      <div className="mt-3 text-[10px] text-muted-foreground">Server ID</div>
                      <div className="font-mono text-[10px] break-all">
                        {message.messageId}
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  )
}
