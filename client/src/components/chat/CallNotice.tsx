"use client"

import { Phone, PhoneIncoming, PhoneOutgoing, PhoneMissed, PhoneOff } from "lucide-react"
import { formatDuration } from "@/lib/webrtc"
import { cn } from "@/lib/utils"

export type CallEventType =
  | "CALL_STARTED"
  | "CALL_ENDED"
  | "CALL_MISSED"
  | "CALL_DECLINED"

type CallNoticeProps = {
  eventType: CallEventType
  callType: "AUDIO" | "VIDEO"
  direction: "incoming" | "outgoing"
  durationSeconds?: number
  timestamp: Date
}

export function CallNotice({
  eventType,
  callType,
  direction,
  durationSeconds,
  timestamp,
}: CallNoticeProps) {
  const isVideo = callType === "VIDEO"
  const callTypeLabel = isVideo ? "video" : "voice"

  const getIcon = () => {
    switch (eventType) {
      case "CALL_STARTED":
        return direction === "incoming" ? (
          <PhoneIncoming className="size-4" />
        ) : (
          <PhoneOutgoing className="size-4" />
        )
      case "CALL_ENDED":
        return <Phone className="size-4" />
      case "CALL_MISSED":
        return <PhoneMissed className="size-4" />
      case "CALL_DECLINED":
        return <PhoneOff className="size-4" />
    }
  }

  const getMessage = () => {
    switch (eventType) {
      case "CALL_STARTED":
        return direction === "incoming"
          ? `Incoming ${callTypeLabel} call`
          : `Outgoing ${callTypeLabel} call`
      case "CALL_ENDED":
        const durationStr = durationSeconds ? ` - ${formatDuration(durationSeconds)}` : ""
        return `${direction === "incoming" ? "Incoming" : "Outgoing"} ${callTypeLabel} call ended${durationStr}`
      case "CALL_MISSED":
        return direction === "outgoing"
          ? `Outgoing ${callTypeLabel} call (no answer)`
          : `Missed ${callTypeLabel} call`
      case "CALL_DECLINED":
        return direction === "incoming"
          ? `Declined ${callTypeLabel} call`
          : `${callTypeLabel.charAt(0).toUpperCase() + callTypeLabel.slice(1)} call declined`
    }
  }

  const timeString = timestamp.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })

  return (
    <div className="flex justify-center my-4">
      <div
        className={cn(
          "flex items-center gap-2 px-4 py-2 rounded-full text-sm",
          "bg-muted/50 text-muted-foreground",
          eventType === "CALL_MISSED" && "text-destructive bg-destructive/10",
          eventType === "CALL_DECLINED" && "text-orange-600 dark:text-orange-400 bg-orange-100/50 dark:bg-orange-900/20"
        )}
      >
        {getIcon()}
        <span>{getMessage()}</span>
        <span className="text-xs opacity-70">{timeString}</span>
      </div>
    </div>
  )
}
