"use client"

import { PhoneOff, Mic, MicOff, Video, VideoOff, Volume2, VolumeX, MonitorUp, MonitorOff, ScanText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type CallControlsProps = {
  isMuted: boolean
  isCameraOn: boolean
  isVideoCall: boolean
  isScreenSharing: boolean
  isReadabilityMode: boolean
  onToggleMute: () => void
  onToggleCamera: () => void
  onToggleScreenShare: () => void
  onToggleReadabilityMode: () => void
  onEndCall: () => void
  remoteVolume?: number
  onRemoteVolumeChange?: (value: number) => void
}

export function CallControls({
  isMuted,
  isCameraOn,
  isVideoCall,
  isScreenSharing,
  isReadabilityMode,
  onToggleMute,
  onToggleCamera,
  onToggleScreenShare,
  onToggleReadabilityMode,
  onEndCall,
  remoteVolume,
  onRemoteVolumeChange,
}: CallControlsProps) {
  const showVolume = typeof remoteVolume === "number" && !!onRemoteVolumeChange
  const volumePercent = showVolume ? Math.round(remoteVolume * 100) : 0

  return (
    <div className="flex flex-wrap items-center justify-center gap-4">
      <div className="flex items-center gap-4">
        <Button
          variant="outline"
          size="icon-lg"
          onClick={onToggleMute}
          className={cn(
            "rounded-full",
            isMuted && "bg-destructive/20 border-destructive text-destructive hover:bg-destructive/30"
          )}
          title={isMuted ? "Unmute" : "Mute"}
        >
          {isMuted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
        </Button>

        {isVideoCall && (
          <Button
            variant="outline"
            size="icon-lg"
            onClick={onToggleCamera}
            className={cn(
              "rounded-full",
              !isCameraOn && "bg-destructive/20 border-destructive text-destructive hover:bg-destructive/30"
            )}
            title={isCameraOn ? "Turn off camera" : "Turn on camera"}
          >
            {isCameraOn ? <Video className="size-5" /> : <VideoOff className="size-5" />}
          </Button>
        )}

        <Button
          variant="outline"
          size="icon-lg"
          onClick={onToggleScreenShare}
          className={cn(
            "rounded-full",
            isScreenSharing && "bg-primary/20 border-primary text-primary hover:bg-primary/30"
          )}
          title={isScreenSharing ? "Stop sharing screen" : "Share screen"}
        >
          {isScreenSharing ? <MonitorOff className="size-5" /> : <MonitorUp className="size-5" />}
        </Button>

        {isScreenSharing && (
          <Button
            variant="outline"
            size="icon-lg"
            onClick={onToggleReadabilityMode}
            className={cn(
              "rounded-full",
              isReadabilityMode && "bg-amber-500/20 border-amber-500 text-amber-600 hover:bg-amber-500/30"
            )}
            title={isReadabilityMode ? "Normal mode (30fps)" : "Readability mode (15fps, higher resolution)"}
          >
            <ScanText className="size-5" />
          </Button>
        )}

        <Button
          variant="destructive"
          size="icon-lg"
          onClick={onEndCall}
          className="rounded-full"
          title="End call"
        >
          <PhoneOff className="size-5" />
        </Button>
      </div>

      {showVolume && (
        <div className="flex items-center gap-2">
          {volumePercent === 0 ? (
            <VolumeX className="size-4 text-muted-foreground" />
          ) : (
            <Volume2 className="size-4 text-muted-foreground" />
          )}
          <input
            type="range"
            min={0}
            max={100}
            value={volumePercent}
            onChange={(event) =>
              onRemoteVolumeChange?.(Number(event.target.value) / 100)
            }
            className="h-2 w-32 cursor-pointer accent-emerald-500"
            aria-label="Call volume"
          />
        </div>
      )}
    </div>
  )
}
