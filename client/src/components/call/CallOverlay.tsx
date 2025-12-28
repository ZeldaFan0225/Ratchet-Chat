"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { PhoneOff, Minimize2, Maximize2, Shield, Lock, Mic, MicOff, Video, VideoOff, MonitorUp, MonitorOff, ScanText, GripVertical } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { CallControls } from "./CallControls"
import { AudioLevelIndicator } from "./AudioLevelIndicator"
import { formatDuration } from "@/lib/webrtc"
import { cn } from "@/lib/utils"
import { useDraggable } from "@/hooks/useDraggable"
import type { CallStatus, CallType } from "@/context/CallContext"

type CallOverlayProps = {
  status: CallStatus
  callType: CallType
  peerHandle: string | null
  startedAt: Date | null
  safetyNumber: string | null
  error: string | null
  localStream: MediaStream | null
  remoteStream: MediaStream | null
  remoteStreamVersion: number
  remoteVideoTracks: MediaStreamTrack[]
  localAudioLevel: number | null
  remoteAudioLevel: number | null
  isMuted: boolean
  isCameraOn: boolean
  isScreenSharing: boolean
  isReadabilityMode: boolean
  onToggleMute: () => void
  onToggleCamera: () => void
  onToggleScreenShare: () => void
  onToggleReadabilityMode: () => void
  onEndCall: () => void
}

type SnapAnchor = 
  | "TL" | "TC" | "TR" 
  | "ML" | "MR" 
  | "BL" | "BC" | "BR"

type ViewportMetrics = {
  width: number
  height: number
  offsetLeft: number
  offsetTop: number
}

const getAnchorPosition = (
  anchor: SnapAnchor,
  rect: DOMRect,
  viewport: ViewportMetrics,
  margin: number
) => {
  const { width: winW, height: winH, offsetLeft, offsetTop } = viewport
  let targetX = 0
  let targetY = 0

  switch (anchor) {
    case "TL": targetX = offsetLeft + margin; targetY = offsetTop + margin; break
    case "TC": targetX = offsetLeft + (winW - rect.width) / 2; targetY = offsetTop + margin; break
    case "TR": targetX = offsetLeft + winW - margin - rect.width; targetY = offsetTop + margin; break
    case "ML": targetX = offsetLeft + margin; targetY = offsetTop + (winH - rect.height) / 2; break
    case "MR": targetX = offsetLeft + winW - margin - rect.width; targetY = offsetTop + (winH - rect.height) / 2; break
    case "BL": targetX = offsetLeft + margin; targetY = offsetTop + winH - margin - rect.height; break
    case "BC": targetX = offsetLeft + (winW - rect.width) / 2; targetY = offsetTop + winH - margin - rect.height; break
    case "BR": targetX = offsetLeft + winW - margin - rect.width; targetY = offsetTop + winH - margin - rect.height; break
  }

  const minX = offsetLeft + margin
  const minY = offsetTop + margin
  const maxX = offsetLeft + Math.max(margin, winW - margin - rect.width)
  const maxY = offsetTop + Math.max(margin, winH - margin - rect.height)

  return {
    x: Math.max(minX, Math.min(targetX, maxX)),
    y: Math.max(minY, Math.min(targetY, maxY)),
  }
}

export function CallOverlay({
  status,
  callType,
  peerHandle,
  startedAt,
  safetyNumber,
  error,
  localStream,
  remoteStream,
  remoteStreamVersion,
  remoteVideoTracks,
  localAudioLevel,
  remoteAudioLevel,
  isMuted,
  isCameraOn,
  isScreenSharing,
  isReadabilityMode,
  onToggleMute,
  onToggleCamera,
  onToggleScreenShare,
  onToggleReadabilityMode,
  onEndCall,
}: CallOverlayProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const remoteCameraRef = useRef<HTMLVideoElement>(null)
  const remoteAudioRef = useRef<HTMLAudioElement>(null)
  const [duration, setDuration] = useState(0)
  const [isMinimized, setIsMinimized] = useState(false)
  const [remoteVolume, setRemoteVolume] = useState(1)
  const [showSafetyNumber, setShowSafetyNumber] = useState(false)

  // Dragging & Positioning state
  const minimizedRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [anchor, setAnchor] = useState<SnapAnchor>("BR")
  const [canAnimate, setCanAnimate] = useState(false)
  const [viewport, setViewport] = useState<ViewportMetrics>({
    width: 0,
    height: 0,
    offsetLeft: 0,
    offsetTop: 0,
  })

  const username = peerHandle?.split("@")[0] ?? "Unknown"
  const initials = username.slice(0, 2).toUpperCase()
  const isVideoCall = callType === "VIDEO"

  // Determine remote video tracks: camera vs screen share
  // Screen share tracks typically have labels like "screen:..." or "window:..."
  const remoteMainTrack = remoteVideoTracks.length > 0 ? (
    // If there are 2+ tracks, second one is likely screen share (added later)
    remoteVideoTracks.length > 1 ? remoteVideoTracks[1] : remoteVideoTracks[0]
  ) : null
  const remoteCameraTrack = remoteVideoTracks.length > 1 ? remoteVideoTracks[0] : null

  const hasRemoteVideo = remoteVideoTracks.length > 0
  const hasRemoteCameraPip = remoteVideoTracks.length > 1
  const showVideoUI = isVideoCall || isScreenSharing || hasRemoteVideo

  // Vertical layout is determined by side anchors
  const isVertical = anchor === "ML" || anchor === "MR"

  // Draggable PiP for maximized view - only when showing video UI and has content
  const hasPipContent = hasRemoteCameraPip || (isVideoCall && !!localStream)
  const pip = useDraggable({
    initialAnchor: "BR",
    margin: 16,
    hideThreshold: 40,
    enabled: !isMinimized && showVideoUI && hasPipContent,
  })

  // Track viewport size (visual viewport when available) for responsive snapping
  useEffect(() => {
    if (typeof window === "undefined") return
    const handleResize = () => {
      const vv = window.visualViewport
      setViewport({
        width: vv?.width ?? window.innerWidth,
        height: vv?.height ?? window.innerHeight,
        offsetLeft: vv?.offsetLeft ?? 0,
        offsetTop: vv?.offsetTop ?? 0,
      })
    }
    handleResize() // Initial measurement
    window.addEventListener("resize", handleResize)
    window.visualViewport?.addEventListener("resize", handleResize)
    window.visualViewport?.addEventListener("scroll", handleResize)
    return () => {
      window.removeEventListener("resize", handleResize)
      window.visualViewport?.removeEventListener("resize", handleResize)
      window.visualViewport?.removeEventListener("scroll", handleResize)
    }
  }, [])

  // Initialize anchor on first minimize (position is calculated after layout)
  useEffect(() => {
    if (isMinimized && !position && viewport.width > 0) {
       // We rely on the anchor effect to set the initial pixel position
       setAnchor("BC")
    }
  }, [isMinimized, position, viewport])

  useEffect(() => {
    if (!isMinimized) {
      setCanAnimate(false)
    }
  }, [isMinimized])

  const syncPosition = useCallback(() => {
    if (!minimizedRef.current || typeof window === "undefined") return false

    const rect = minimizedRef.current.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return false

    const fallbackViewport: ViewportMetrics = {
      width: window.innerWidth,
      height: window.innerHeight,
      offsetLeft: 0,
      offsetTop: 0,
    }
    const currentViewport =
      viewport.width > 0 ? viewport : (window.visualViewport
        ? {
            width: window.visualViewport.width,
            height: window.visualViewport.height,
            offsetLeft: window.visualViewport.offsetLeft,
            offsetTop: window.visualViewport.offsetTop,
          }
        : fallbackViewport)
    const margin = 16

    setPosition(getAnchorPosition(anchor, rect, currentViewport, margin))
    return true
  }, [anchor, viewport])

  // Recalculate position when anchor or window changes
  useLayoutEffect(() => {
    if (isDragging || !isMinimized) return

    let frameId = 0
    const handleSnap = () => {
      const didSync = syncPosition()
      if (didSync && !canAnimate) {
        setCanAnimate(true)
      }
      if (!didSync) {
        frameId = requestAnimationFrame(handleSnap)
      }
    }

    handleSnap()
    return () => cancelAnimationFrame(frameId)
  }, [isDragging, isMinimized, syncPosition, canAnimate])

  // Keep position synced when the minimized card resizes itself
  useEffect(() => {
    if (!isMinimized || !minimizedRef.current) return
    const element = minimizedRef.current
    const observer = new ResizeObserver(() => {
      if (isDragging) return
      syncPosition()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [isMinimized, isDragging, syncPosition])


  // Debug: log stream info
  useEffect(() => {
    console.log("[CallOverlay] Streams updated:", {
      hasLocalStream: !!localStream,
      localAudioTracks: localStream?.getAudioTracks().length ?? 0,
      hasRemoteStream: !!remoteStream,
      remoteAudioTracks: remoteStream?.getAudioTracks().length ?? 0,
      remoteVideoTracks: remoteStream?.getVideoTracks().length ?? 0,
      remoteStreamVersion,
    })
  }, [localStream, remoteStream, remoteStreamVersion])

  // Attach local stream to video element
  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream
    }
  }, [localStream, isMinimized])

  // Attach remote video tracks to video elements
  // Main video shows screen share (or camera if no screen share)
  // Camera PiP shows camera when screen sharing
  useEffect(() => {
    console.log("[CallOverlay] Attaching remote tracks:", {
      trackCount: remoteVideoTracks.length,
      mainTrack: remoteMainTrack?.label,
      cameraTrack: remoteCameraTrack?.label,
      hasVideoRef: !!remoteVideoRef.current,
      hasCameraRef: !!remoteCameraRef.current,
    })

    if (remoteVideoRef.current && remoteMainTrack) {
      const stream = new MediaStream([remoteMainTrack])
      remoteVideoRef.current.srcObject = stream
      remoteVideoRef.current.play().catch((err) => {
        console.log("[CallOverlay] Main video play failed:", err)
      })
    } else if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null
    }

    if (remoteCameraRef.current && remoteCameraTrack) {
      const stream = new MediaStream([remoteCameraTrack])
      remoteCameraRef.current.srcObject = stream
      remoteCameraRef.current.play().catch((err) => {
        console.log("[CallOverlay] Camera PiP play failed:", err)
      })
    } else if (remoteCameraRef.current) {
      remoteCameraRef.current.srcObject = null
    }
  }, [remoteVideoTracks, remoteMainTrack, remoteCameraTrack, isMinimized])

  // Attach remote audio stream
  useEffect(() => {
    if (!remoteStream) return
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStream
      remoteAudioRef.current.play().catch((err) => {
        console.log("[CallOverlay] Audio play failed:", err)
      })
    }
  }, [remoteStream, remoteStreamVersion, isMinimized])

  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.volume = remoteVolume
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.volume = remoteVolume
    }
  }, [remoteVolume, remoteStream, isMinimized])

  // Update duration every second
  useEffect(() => {
    if (status !== "connected" || !startedAt) {
      setDuration(0)
      return
    }

    const interval = setInterval(() => {
      setDuration(Math.floor((Date.now() - startedAt.getTime()) / 1000))
    }, 1000)

    return () => clearInterval(interval)
  }, [status, startedAt])

  // Drag handlers
  const handlePointerDown = (e: React.PointerEvent) => {
    if (!minimizedRef.current) return
    e.preventDefault() 
    
    const rect = minimizedRef.current.getBoundingClientRect()
    setPosition({ x: rect.left, y: rect.top })
    setDragOffset({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    })
    setIsDragging(true)
    try {
      minimizedRef.current.setPointerCapture(e.pointerId)
    } catch {
      // Pointer capture can fail on some mobile browsers
    }
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging) return
    setPosition({
      x: e.clientX - dragOffset.x,
      y: e.clientY - dragOffset.y,
    })
  }

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isDragging || !minimizedRef.current) return
    setIsDragging(false)
    try {
      minimizedRef.current.releasePointerCapture(e.pointerId)
    } catch {
      // Pointer capture release can fail
    }
    findNearestAnchor()
  }

  const handlePointerCancel = (e: React.PointerEvent) => {
    if (!isDragging) return
    handlePointerUp(e)
  }

  const findNearestAnchor = () => {
    if (!minimizedRef.current || typeof window === "undefined") return

    const rect = minimizedRef.current.getBoundingClientRect()
    const currentViewport = viewport.width > 0 ? viewport : {
      width: window.innerWidth,
      height: window.innerHeight,
      offsetLeft: 0,
      offsetTop: 0,
    }
    const { width: winW, height: winH, offsetLeft, offsetTop } = currentViewport
    const margin = 16

    // Current center
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2

    // Define snap targets (zone centers)
    const targets: { id: SnapAnchor; x: number; y: number }[] = [
      { id: "TL", x: offsetLeft + margin + rect.width / 2, y: offsetTop + margin + rect.height / 2 },
      { id: "TC", x: offsetLeft + winW / 2, y: offsetTop + margin + rect.height / 2 },
      { id: "TR", x: offsetLeft + winW - margin - rect.width / 2, y: offsetTop + margin + rect.height / 2 },
      { id: "ML", x: offsetLeft + margin + rect.width / 2, y: offsetTop + winH / 2 },
      { id: "MR", x: offsetLeft + winW - margin - rect.width / 2, y: offsetTop + winH / 2 },
      { id: "BL", x: offsetLeft + margin + rect.width / 2, y: offsetTop + winH - margin - rect.height / 2 },
      { id: "BC", x: offsetLeft + winW / 2, y: offsetTop + winH - margin - rect.height / 2 },
      { id: "BR", x: offsetLeft + winW - margin - rect.width / 2, y: offsetTop + winH - margin - rect.height / 2 },
    ]

    let best = targets[0]
    let minDist = Number.MAX_VALUE

    for (const t of targets) {
      const dist = (cx - t.x) ** 2 + (cy - t.y) ** 2
      if (dist < minDist) {
        minDist = dist
        best = t
      }
    }

    setAnchor(best.id)
    // The useEffect [anchor] will trigger and handle the actual snapping animation
  }

  // Don't show if idle
  if (status === "idle") {
    return null
  }

  const getStatusText = () => {
    switch (status) {
      case "initiating":
        return "Starting..."
      case "ringing":
        return "Ringing..."
      case "connecting":
        return "Connecting..."
      case "connected":
        return formatDuration(duration)
      case "ended":
        return error || "Ended"
      default:
        return ""
    }
  }

  if (isMinimized) {
    return (
      <div
        ref={minimizedRef}
        style={{
            position: "fixed",
            left: position?.x ?? 0,
            top: position?.y ?? 0,
            zIndex: 10000,
            opacity: position ? 1 : 0,
            pointerEvents: position ? "auto" : "none",
            // Apply bounce timing function
            transitionTimingFunction: "cubic-bezier(0.34, 1.56, 0.64, 1)", 
        }}
        className={cn(
          "bg-background/95 border rounded-xl shadow-xl overflow-hidden backdrop-blur-sm touch-none select-none",
          // Only animate when NOT dragging. 
          // 500ms duration for visible bounce.
          !isDragging && canAnimate && "transition-all duration-500",
          isDragging ? "cursor-grabbing scale-105 shadow-2xl" : "cursor-grab",
          isVertical ? "flex flex-col w-[5.25rem] p-2 gap-2 items-center" : "flex flex-row items-center p-2 gap-3 w-auto max-w-sm"
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={() => {
          if (isDragging) {
            setIsDragging(false)
            findNearestAnchor()
          }
        }}
      >
        {/* Hidden audio element for minimized playback */}
        <audio ref={remoteAudioRef} autoPlay playsInline />

        {showVideoUI && hasRemoteVideo ? (
          <div className={cn(
            "relative bg-black rounded overflow-hidden shadow-sm shrink-0 pointer-events-none",
            isVertical ? "w-16 h-20" : "w-20 h-14"
          )}>
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="w-full h-full object-contain"
            />
            <span className="absolute bottom-0.5 left-1 text-[8px] text-white bg-black/50 px-1 rounded truncate max-w-[calc(100%-8px)]">
              {username}
            </span>
          </div>
        ) : (
          <Avatar className={isVertical ? "size-10" : "size-10"}>
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
        )}
        
        <div className={cn("flex flex-col overflow-hidden", isVertical ? "items-center text-center w-full" : "items-start")}>
          <span className="font-medium text-xs truncate w-full">{username}</span>
          <span className="text-[10px] text-muted-foreground truncate w-full">{getStatusText()}</span>
        </div>

        {/* Audio level indicator */}
        {status === "connected" && !isVertical && (
           <AudioLevelIndicator stream={remoteStream} level={remoteAudioLevel} className="scale-75 origin-left" />
        )}

        <div
          className={cn(
            "flex shrink-0",
            isVertical ? "flex-wrap justify-center w-full gap-1" : "ml-auto flex-col items-end gap-1"
          )}
        >
          {isVertical ? (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn(
                  "h-7 w-7",
                  isMuted && "text-destructive hover:text-destructive"
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleMute()
                }}
                title={isMuted ? "Unmute" : "Mute"}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {isMuted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
              </Button>
              {isVideoCall && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    "h-7 w-7",
                    !isCameraOn && "text-destructive hover:text-destructive"
                  )}
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggleCamera()
                  }}
                  title={isCameraOn ? "Hide video" : "Show video"}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {isCameraOn ? <VideoOff className="size-4" /> : <Video className="size-4" />}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn(
                  "h-7 w-7",
                  isScreenSharing && "text-primary hover:text-primary"
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleScreenShare()
                }}
                title={isScreenSharing ? "Stop sharing" : "Share screen"}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {isScreenSharing ? <MonitorOff className="size-4" /> : <MonitorUp className="size-4" />}
              </Button>
              {status !== "ended" && (
                <Button
                  variant="destructive"
                  size="icon-sm"
                  className="h-7 w-7"
                  onClick={(e) => {
                      e.stopPropagation();
                      onEndCall();
                  }}
                  title="End call"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <PhoneOff className="size-4" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7"
                onClick={(e) => {
                     e.stopPropagation(); // Prevent drag start
                     setIsMinimized(false);
                     setAnchor("BR");
                     setPosition(null); // Reset position
                }}
                title="Maximize"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <Maximize2 className="size-4" />
              </Button>
            </>
          ) : (
            <>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    "h-7 w-7",
                    isMuted && "text-destructive hover:text-destructive"
                  )}
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggleMute()
                  }}
                  title={isMuted ? "Unmute" : "Mute"}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {isMuted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
                </Button>
                {isVideoCall && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={cn(
                      "h-7 w-7",
                      !isCameraOn && "text-destructive hover:text-destructive"
                    )}
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggleCamera()
                    }}
                    title={isCameraOn ? "Hide video" : "Show video"}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    {isCameraOn ? <VideoOff className="size-4" /> : <Video className="size-4" />}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    "h-7 w-7",
                    isScreenSharing && "text-primary hover:text-primary"
                  )}
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggleScreenShare()
                  }}
                  title={isScreenSharing ? "Stop sharing" : "Share screen"}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {isScreenSharing ? <MonitorOff className="size-4" /> : <MonitorUp className="size-4" />}
                </Button>
              </div>
              <div className="flex gap-1">
                {status !== "ended" && (
                  <Button
                    variant="destructive"
                    size="icon-sm"
                    className="h-7 w-7"
                    onClick={(e) => {
                        e.stopPropagation();
                        onEndCall();
                    }}
                    title="End call"
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <PhoneOff className="size-4" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-7 w-7"
                  onClick={(e) => {
                       e.stopPropagation(); // Prevent drag start
                       setIsMinimized(false);
                       setAnchor("BR"); 
                       setPosition(null); // Reset position
                  }}
                  title="Maximize"
                  onPointerDown={(e) => e.stopPropagation()} 
                >
                  <Maximize2 className="size-4" />
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[10000] bg-background/95 backdrop-blur-sm flex flex-col">
      <audio ref={remoteAudioRef} autoPlay playsInline />
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <div className="flex items-center gap-3">
          <Avatar>
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-medium">{username}</h2>
              {status === "connected" && safetyNumber && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-5 w-5 text-muted-foreground hover:text-primary"
                  onClick={() => setShowSafetyNumber(!showSafetyNumber)}
                  title="Verify Safety Number"
                >
                  <Shield className="size-3.5" />
                </Button>
              )}
            </div>
            {showSafetyNumber && safetyNumber ? (
              <p className="text-xs font-mono text-primary animate-in fade-in slide-in-from-top-1">
                Safety Number: {safetyNumber}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                {status === "connected" && <Lock className="size-3" />}
                {getStatusText()}
              </p>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
              setIsMinimized(true);
              setAnchor("BC");
              // Position will be calculated by effect
          }}
          title="Minimize"
        >
          <Minimize2 className="size-5" />
        </Button>
      </div>

      {/* Hidden PiP drag handle - show when PiP is hidden at edge (placed outside video area to avoid clipping) */}
      {pip.isHidden && pip.hiddenEdge && (
        <div
          className={cn(
            "fixed bg-background/90 backdrop-blur-sm cursor-pointer shadow-lg border flex items-center justify-center hover:bg-background z-[60]",
            pip.hiddenEdge === "right" && "right-0 top-1/2 -translate-y-1/2 w-3 h-16 rounded-l-full border-r-0",
            pip.hiddenEdge === "left" && "left-0 top-1/2 -translate-y-1/2 w-3 h-16 rounded-r-full border-l-0",
            pip.hiddenEdge === "top" && "top-0 left-1/2 -translate-x-1/2 h-3 w-16 rounded-b-full border-t-0",
            pip.hiddenEdge === "bottom" && "bottom-0 left-1/2 -translate-x-1/2 h-3 w-16 rounded-t-full border-b-0"
          )}
          onClick={() => {
            pip.show(true)
          }}
        >
          <GripVertical className={cn(
            "size-3 text-muted-foreground",
            (pip.hiddenEdge === "top" || pip.hiddenEdge === "bottom") && "rotate-90"
          )} />
        </div>
      )}

      {/* Video/Audio area */}
      <div className="flex-1 flex items-center justify-center relative overflow-hidden bg-black">
        {showVideoUI ? (
          <>
            {/* Remote video (main) or placeholder - show avatar if no video tracks */}
            {hasRemoteVideo ? (
              <>
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="w-full h-full object-contain"
                />
                <span className="absolute bottom-3 left-3 text-sm text-white bg-black/50 px-2 py-0.5 rounded">
                  {username}{hasRemoteCameraPip ? " (Screen)" : ""}
                </span>
              </>
            ) : (
              <div className="flex flex-col items-center gap-4">
                <Avatar className="size-32">
                  <AvatarFallback className="text-4xl">{initials}</AvatarFallback>
                </Avatar>
                <p className="text-muted-foreground">{getStatusText()}</p>
              </div>
            )}

            {/* Audio level indicators for video call */}
            {status === "connected" && (
              <div className="absolute top-4 left-4 flex items-center gap-4 bg-background/80 backdrop-blur-sm rounded-lg px-3 py-2">
                <AudioLevelIndicator stream={remoteStream} level={remoteAudioLevel} label="In" />
                <AudioLevelIndicator stream={localStream} level={localAudioLevel} label="Out" />
              </div>
            )}

            {/* PiP stack: remote camera (when screen sharing) + local video */}
            {hasPipContent && (
              <div
                ref={pip.ref}
                style={{
                  position: pip.position ? "fixed" : "absolute",
                  left: pip.position?.x ?? undefined,
                  top: pip.position?.y ?? undefined,
                  right: pip.position ? undefined : 16,
                  bottom: pip.position ? undefined : 16,
                  zIndex: 50,
                  transitionTimingFunction: "cubic-bezier(0.34, 1.56, 0.64, 1)",
                  // Keep in DOM but visually hidden when isHidden
                  visibility: pip.isHidden ? "hidden" : "visible",
                }}
                className={cn(
                  "flex gap-2 touch-none select-none",
                  // Vertical layout for ML/MR, horizontal for others
                  (pip.anchor === "ML" || pip.anchor === "MR") ? "flex-col" : "flex-row",
                  !pip.isDragging && pip.canAnimate && "transition-all duration-500",
                  pip.isDragging ? "cursor-grabbing scale-105" : "cursor-grab"
                )}
                {...pip.handlers}
              >
                {/* Remote camera PiP - shown when peer is screen sharing and has camera */}
                {hasRemoteCameraPip && (
                  <div className="relative w-32 h-24 md:w-48 md:h-36 rounded-lg overflow-hidden border-2 border-background shadow-lg bg-black pointer-events-none">
                    <video
                      ref={remoteCameraRef}
                      autoPlay
                      playsInline
                      muted
                      className="absolute inset-0 w-full h-full object-cover"
                    />
                    <span className="absolute bottom-1 left-1.5 text-[10px] text-white bg-black/50 px-1 rounded">
                      {username}
                    </span>
                  </div>
                )}

                {/* Local video (picture-in-picture) - only show for video calls with camera */}
                {isVideoCall && localStream && (
                  <div className="relative w-32 h-24 md:w-48 md:h-36 rounded-lg overflow-hidden border-2 border-background shadow-lg bg-black pointer-events-none">
                    <video
                      ref={localVideoRef}
                      autoPlay
                      playsInline
                      muted
                      className={cn(
                        "absolute inset-0 w-full h-full object-cover",
                        !isCameraOn && "hidden"
                      )}
                    />
                    {!isCameraOn && (
                      <div className="absolute inset-0 bg-muted flex items-center justify-center">
                        <Avatar>
                          <AvatarFallback>You</AvatarFallback>
                        </Avatar>
                      </div>
                    )}
                    <span className="absolute bottom-1 left-1.5 text-[10px] text-white bg-black/50 px-1 rounded">
                      You
                    </span>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          /* Audio call or waiting for video */
          <div className="flex flex-col items-center gap-6">
            <Avatar className="size-32">
              <AvatarFallback className="text-4xl">{initials}</AvatarFallback>
            </Avatar>
            <div className="text-center">
              <h2 className="text-2xl font-medium">{username}</h2>
              <p className="text-muted-foreground mt-1">{getStatusText()}</p>
            </div>

            {/* Audio level indicators */}
            {status === "connected" && (
              <div className="flex items-center gap-8 mt-4">
                <AudioLevelIndicator
                  stream={remoteStream}
                  level={remoteAudioLevel}
                  label="Incoming"
                />
                <AudioLevelIndicator
                  stream={localStream}
                  level={localAudioLevel}
                  label="Outgoing"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Controls */}
      {status !== "ended" && (
        <div className="p-6 border-t bg-background">
          <CallControls
            isMuted={isMuted}
            isCameraOn={isCameraOn}
            isVideoCall={isVideoCall}
            isScreenSharing={isScreenSharing}
            isReadabilityMode={isReadabilityMode}
            onToggleMute={onToggleMute}
            onToggleCamera={onToggleCamera}
            onToggleScreenShare={onToggleScreenShare}
            onToggleReadabilityMode={onToggleReadabilityMode}
            onEndCall={onEndCall}
            remoteVolume={remoteVolume}
            onRemoteVolumeChange={setRemoteVolume}
          />
        </div>
      )}

      {/* Error/ended state */}
      {status === "ended" && (
        <div className="p-6 border-t bg-background flex justify-center">
          <Button variant="outline" onClick={() => window.location.reload()}>
            Close
          </Button>
        </div>
      )}
    </div>
  )
}
