import { useCallback, useRef, useState } from "react"
import { getMediaStream, getMediaStreamWithOptionalVideo, getDisplayMedia, stopMediaStream, setVideoBitrate, applyFramerateConstraint } from "@/lib/webrtc"

function logRTC(message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString()
  const prefix = `[WebRTC ${timestamp}]`
  if (data) {
    console.log(prefix, message, data)
  } else {
    console.log(prefix, message)
  }
}

export type ConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed"

type IceServer = {
  urls: string | string[]
  username?: string
  credential?: string
}

type UseWebRTCConfig = {
  iceServers: IceServer[]
  onRemoteStream?: (stream: MediaStream) => void
  onConnectionStateChange?: (state: ConnectionState) => void
  onIceCandidate?: (candidate: RTCIceCandidate) => void
  onIceGatheringComplete?: () => void
  onNegotiationNeeded?: () => void
}

export function useWebRTC(config: UseWebRTCConfig) {
  const {
    iceServers,
    onRemoteStream,
    onConnectionStateChange,
    onIceCandidate,
    onIceGatheringComplete,
    onNegotiationNeeded,
  } = config

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteStreamRef = useRef<MediaStream | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const videoSenderRef = useRef<RTCRtpSender | null>(null)
  const screenSenderRef = useRef<RTCRtpSender | null>(null)
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null)
  const pendingCandidatesRef = useRef<RTCIceCandidate[]>([])
  const [connectionState, setConnectionState] = useState<ConnectionState>("new")
  const [isScreenSharing, setIsScreenSharing] = useState(false)
  const lastConnectionStateRef = useRef<ConnectionState>("new")
  // Track remote video tracks separately (camera vs screen share)
  const [remoteVideoTracks, setRemoteVideoTracks] = useState<MediaStreamTrack[]>([])

  const createPeerConnection = useCallback(() => {
    if (peerConnectionRef.current) {
      logRTC("Using existing peer connection")
      return peerConnectionRef.current
    }

    logRTC("Creating new peer connection", { iceServersCount: iceServers.length })
    const pc = new RTCPeerConnection({ iceServers })

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        logRTC("ICE candidate generated", {
          type: event.candidate.type,
          protocol: event.candidate.protocol,
          address: event.candidate.address
        })
        onIceCandidate?.(event.candidate)
      } else {
        logRTC("ICE candidate gathering complete (null candidate)")
      }
    }

    pc.onicegatheringstatechange = () => {
      logRTC("ICE gathering state changed", { state: pc.iceGatheringState })
      if (pc.iceGatheringState === "complete") {
        onIceGatheringComplete?.()
      }
    }

    pc.oniceconnectionstatechange = () => {
      logRTC("ICE connection state changed", { state: pc.iceConnectionState })
      const mappedState: ConnectionState | null =
        pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed"
          ? "connected"
          : pc.iceConnectionState === "checking"
            ? "connecting"
            : pc.iceConnectionState === "new"
              ? "new"
              : null

      if (mappedState && (pc.connectionState === "new" || pc.connectionState === "connecting")) {
        if (lastConnectionStateRef.current !== mappedState) {
          lastConnectionStateRef.current = mappedState
          setConnectionState(mappedState)
          onConnectionStateChange?.(mappedState)
        }
      }
    }

    pc.onsignalingstatechange = () => {
      logRTC("Signaling state changed", { state: pc.signalingState })
    }

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState as ConnectionState
      logRTC("Connection state changed", { state })
      if (lastConnectionStateRef.current !== state) {
        lastConnectionStateRef.current = state
        setConnectionState(state)
        onConnectionStateChange?.(state)
        // Apply bitrate settings when connected for better quality
        if (state === "connected") {
          void setVideoBitrate(pc, 2500).catch(() => {
            // Bitrate setting is best-effort
          })
        }
      }
    }

    pc.ontrack = (event) => {
      logRTC("Remote track received", {
        kind: event.track.kind,
        streamCount: event.streams?.length,
        trackLabel: event.track.label,
      })
      if (event.streams && event.streams[0]) {
        const stream = event.streams[0]
        remoteStreamRef.current = stream

        // Track video tracks for multi-video display (camera + screen share)
        if (event.track.kind === "video") {
          setRemoteVideoTracks(prev => {
            // Avoid duplicates
            if (prev.some(t => t.id === event.track.id)) return prev
            return [...prev, event.track]
          })
          // Clean up when track ends
          event.track.onended = () => {
            logRTC("Remote video track ended", { trackId: event.track.id })
            setRemoteVideoTracks(prev => prev.filter(t => t.id !== event.track.id))
          }
          // Also listen for mute/unmute (e.g., screen share stop or camera off)
          event.track.onmute = () => {
            logRTC("Remote video track muted", { trackId: event.track.id, readyState: event.track.readyState })
            setRemoteVideoTracks(prev => prev.filter(t => t.id !== event.track.id))
          }
          event.track.onunmute = () => {
            logRTC("Remote video track unmuted", { trackId: event.track.id })
            setRemoteVideoTracks(prev => {
              if (prev.some(t => t.id === event.track.id)) return prev
              return [...prev, event.track]
            })
          }
        }

        // Listen for track removal from stream (handles removeTrack on sender side)
        stream.onremovetrack = (e) => {
          logRTC("Track removed from remote stream", { kind: e.track.kind, trackId: e.track.id })
          if (e.track.kind === "video") {
            setRemoteVideoTracks(prev => prev.filter(t => t.id !== e.track.id))
          }
          onRemoteStream?.(stream)
        }

        onRemoteStream?.(stream)
        if (lastConnectionStateRef.current !== "connected") {
          logRTC("Marking connection as connected from remote track")
          lastConnectionStateRef.current = "connected"
          setConnectionState("connected")
          onConnectionStateChange?.("connected")
        }
      }
    }

    pc.onnegotiationneeded = () => {
      logRTC("Negotiation needed")
      onNegotiationNeeded?.()
    }

    peerConnectionRef.current = pc
    return pc
  }, [iceServers, onIceCandidate, onIceGatheringComplete, onConnectionStateChange, onRemoteStream, onNegotiationNeeded])

  const getUserMedia = useCallback(
    async (audio: boolean, video: boolean): Promise<MediaStream> => {
      const stream = await getMediaStream({ audio, video })
      localStreamRef.current = stream
      return stream
    },
    []
  )

  // Get media with optional video - falls back to audio-only if video fails
  const getUserMediaWithOptionalVideo = useCallback(
    async (audio: boolean, video: boolean): Promise<{ stream: MediaStream; hasVideo: boolean }> => {
      const result = await getMediaStreamWithOptionalVideo(audio, video)
      localStreamRef.current = result.stream
      return result
    },
    []
  )

  const addLocalStream = useCallback((stream: MediaStream) => {
    // Ensure peer connection exists before adding tracks
    const pc = peerConnectionRef.current ?? createPeerConnection()

    logRTC("Adding local stream", { trackCount: stream.getTracks().length })
    stream.getTracks().forEach((track) => {
      logRTC("Adding track", { kind: track.kind, id: track.id })
      const sender = pc.addTrack(track, stream)
      // Store video sender reference for screen sharing
      if (track.kind === "video") {
        videoSenderRef.current = sender
        cameraTrackRef.current = track
      }
    })
    localStreamRef.current = stream
  }, [createPeerConnection])

  const createOffer = useCallback(async (): Promise<RTCSessionDescriptionInit> => {
    logRTC("Creating offer")
    const pc = createPeerConnection()
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    logRTC("Offer created and set as local description")
    return offer
  }, [createPeerConnection])

  const createAnswer = useCallback(
    async (offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> => {
      logRTC("Creating answer")
      const pc = createPeerConnection()
      await pc.setRemoteDescription(new RTCSessionDescription(offer))
      logRTC("Remote description set (offer)")

      // Add any pending ICE candidates
      if (pendingCandidatesRef.current.length > 0) {
        logRTC("Adding pending ICE candidates", { count: pendingCandidatesRef.current.length })
        for (const candidate of pendingCandidatesRef.current) {
          await pc.addIceCandidate(candidate)
        }
        pendingCandidatesRef.current = []
      }

      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      logRTC("Answer created and set as local description")
      return answer
    },
    [createPeerConnection]
  )

  const handleAnswer = useCallback(async (answer: RTCSessionDescriptionInit) => {
    logRTC("Handling answer")
    const pc = peerConnectionRef.current
    if (!pc) {
      logRTC("Error: No peer connection when handling answer")
      throw new Error("No peer connection")
    }

    await pc.setRemoteDescription(new RTCSessionDescription(answer))
    logRTC("Remote description set (answer)")

    // Add any pending ICE candidates
    if (pendingCandidatesRef.current.length > 0) {
      logRTC("Adding pending ICE candidates after answer", { count: pendingCandidatesRef.current.length })
      for (const candidate of pendingCandidatesRef.current) {
        await pc.addIceCandidate(candidate)
      }
      pendingCandidatesRef.current = []
    }
  }, [])

  const addIceCandidate = useCallback(async (candidate: RTCIceCandidateInit) => {
    const pc = peerConnectionRef.current

    if (!pc || !pc.remoteDescription) {
      // Queue the candidate until remote description is set
      logRTC("Queuing ICE candidate (no remote description yet)", { pendingCount: pendingCandidatesRef.current.length + 1 })
      pendingCandidatesRef.current.push(new RTCIceCandidate(candidate))
      return
    }

    logRTC("Adding ICE candidate")
    await pc.addIceCandidate(new RTCIceCandidate(candidate))
  }, [])

  const setMuted = useCallback((muted: boolean) => {
    logRTC("Setting muted", { muted })

    // Mute via local stream
    const stream = localStreamRef.current
    if (stream) {
      const audioTracks = stream.getAudioTracks()
      logRTC("Muting local stream audio tracks", { count: audioTracks.length })
      audioTracks.forEach((track) => {
        track.enabled = !muted
        logRTC("Set track enabled", { trackId: track.id, enabled: track.enabled })
      })
    } else {
      logRTC("Warning: No local stream to mute")
    }

    // Also mute via peer connection senders (more reliable)
    const pc = peerConnectionRef.current
    if (pc) {
      const senders = pc.getSenders()
      senders.forEach((sender) => {
        if (sender.track?.kind === "audio") {
          sender.track.enabled = !muted
          logRTC("Set sender track enabled", { trackId: sender.track.id, enabled: sender.track.enabled })
        }
      })
    }
  }, [])

  const setCameraEnabled = useCallback((enabled: boolean) => {
    const stream = localStreamRef.current
    if (stream) {
      stream.getVideoTracks().forEach((track) => {
        track.enabled = enabled
      })
    }
  }, [])

  const startScreenShare = useCallback(async (readabilityMode: boolean = false): Promise<MediaStream> => {
    logRTC("Starting screen share", { readabilityMode })

    const screenStream = await getDisplayMedia(readabilityMode)
    const screenTrack = screenStream.getVideoTracks()[0]

    if (!screenTrack) {
      throw new Error("No video track in screen share stream")
    }

    // Handle user stopping share via browser chrome
    screenTrack.onended = () => {
      logRTC("Screen share ended by user (browser chrome)")
      void stopScreenShare()
    }

    const pc = peerConnectionRef.current
    if (pc && screenSenderRef.current) {
      await screenSenderRef.current.replaceTrack(screenTrack)
      logRTC("Replaced screen share track on existing sender")
    } else if (pc && localStreamRef.current) {
      // Add screen track as a NEW track (don't replace camera)
      // This allows remote to see both camera and screen share
      const sender = pc.addTrack(screenTrack, localStreamRef.current)
      screenSenderRef.current = sender
      logRTC("Added screen track alongside camera")
    }

    screenStreamRef.current = screenStream
    setIsScreenSharing(true)
    return screenStream
  }, [])

  const stopScreenShare = useCallback(async () => {
    logRTC("Stopping screen share")

    // Detach screen track but keep the sender to avoid m-section mismatch on renegotiation
    if (screenSenderRef.current) {
      await screenSenderRef.current.replaceTrack(null)
      logRTC("Detached screen track from peer connection")
    }

    // Stop screen stream tracks
    if (screenStreamRef.current) {
      stopMediaStream(screenStreamRef.current)
      screenStreamRef.current = null
    }

    setIsScreenSharing(false)
  }, [])

  const setScreenShareReadabilityMode = useCallback(async (readabilityMode: boolean) => {
    const screenTrack = screenStreamRef.current?.getVideoTracks()[0]
    if (!screenTrack) {
      logRTC("No screen track to apply readability mode to")
      return
    }

    logRTC("Setting screen share readability mode", { readabilityMode })
    await applyFramerateConstraint(screenTrack, readabilityMode)
  }, [])

  const getPeerConnection = useCallback(() => peerConnectionRef.current, [])

  const close = useCallback(() => {
    stopMediaStream(localStreamRef.current)
    stopMediaStream(remoteStreamRef.current)
    stopMediaStream(screenStreamRef.current)

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close()
      peerConnectionRef.current = null
    }

    localStreamRef.current = null
    remoteStreamRef.current = null
    screenStreamRef.current = null
    videoSenderRef.current = null
    screenSenderRef.current = null
    cameraTrackRef.current = null
    pendingCandidatesRef.current = []
    lastConnectionStateRef.current = "closed"
    setConnectionState("closed")
    setIsScreenSharing(false)
    setRemoteVideoTracks([])
  }, [])

  return {
    connectionState,
    localStream: localStreamRef.current,
    remoteStream: remoteStreamRef.current,
    screenStream: screenStreamRef.current,
    remoteVideoTracks,
    isScreenSharing,
    createPeerConnection,
    getUserMedia,
    getUserMediaWithOptionalVideo,
    addLocalStream,
    createOffer,
    createAnswer,
    handleAnswer,
    addIceCandidate,
    setMuted,
    setCameraEnabled,
    startScreenShare,
    stopScreenShare,
    setScreenShareReadabilityMode,
    getPeerConnection,
    close,
  }
}
