"use client"

import { Phone, PhoneOff, Video } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { resumeAudioContext } from "./AudioLevelIndicator"
import type { CallType } from "@/context/CallContext"

type IncomingCallDialogProps = {
  open: boolean
  callerHandle: string
  callType: CallType
  onAccept: () => void
  onReject: () => void
  onSilence?: () => void
}

export function IncomingCallDialog({
  open,
  callerHandle,
  callType,
  onAccept,
  onReject,
  onSilence,
}: IncomingCallDialogProps) {
  const username = callerHandle.split("@")[0]
  const initials = username.slice(0, 2).toUpperCase()
  const isVideo = callType === "VIDEO"

  const handleAccept = () => {
    // Resume AudioContext on user gesture for Safari
    resumeAudioContext()
    onAccept()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && onSilence) {
          onSilence()
        }
      }}
    >
      <DialogContent
        className="sm:max-w-sm !z-[10000]"
        overlayClassName="!z-[9999]"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader className="items-center text-center">
          <Avatar className="size-20 mb-4">
            <AvatarFallback className="text-2xl">{initials}</AvatarFallback>
          </Avatar>
          <DialogTitle className="text-xl">{username}</DialogTitle>
          <DialogDescription className="text-base">
            Incoming {isVideo ? "video" : "voice"} call
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-center gap-6 mt-6">
          <Button
            variant="nuclear"
            size="icon-lg"
            onClick={onReject}
            className="rounded-full size-14"
            title="Decline"
          >
            <PhoneOff className="size-6" />
          </Button>

          <Button
            variant="accept"
            size="icon-lg"
            onClick={handleAccept}
            className="rounded-full size-14"
            title="Accept"
          >
            {isVideo ? <Video className="size-6" /> : <Phone className="size-6" />}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
