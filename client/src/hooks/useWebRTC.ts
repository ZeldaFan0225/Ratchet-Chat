import { useCallback, useRef, useState } from "react"
import { getMediaStream, stopMediaStream } from "@/lib/webrtc"

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
}

export function useWebRTC(config: UseWebRTCConfig) {
  const {
    iceServers,
    onRemoteStream,
    onConnectionStateChange,
    onIceCandidate,
    onIceGatheringComplete,
  } = config

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteStreamRef = useRef<MediaStream | null>(null)
  const pendingCandidatesRef = useRef<RTCIceCandidate[]>([])
  const [connectionState, setConnectionState] = useState<ConnectionState>("new")
  const lastConnectionStateRef = useRef<ConnectionState>("new")

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
      }
    }

    pc.ontrack = (event) => {
      logRTC("Remote track received", {
        kind: event.track.kind,
        streamCount: event.streams?.length
      })
      if (event.streams && event.streams[0]) {
        remoteStreamRef.current = event.streams[0]
        onRemoteStream?.(event.streams[0])
        if (lastConnectionStateRef.current !== "connected") {
          logRTC("Marking connection as connected from remote track")
          lastConnectionStateRef.current = "connected"
          setConnectionState("connected")
          onConnectionStateChange?.("connected")
        }
      }
    }

    peerConnectionRef.current = pc
    return pc
  }, [iceServers, onIceCandidate, onIceGatheringComplete, onConnectionStateChange, onRemoteStream])

  const getUserMedia = useCallback(
    async (audio: boolean, video: boolean): Promise<MediaStream> => {
      const stream = await getMediaStream({ audio, video })
      localStreamRef.current = stream
      return stream
    },
    []
  )

  const addLocalStream = useCallback((stream: MediaStream) => {
    // Ensure peer connection exists before adding tracks
    const pc = peerConnectionRef.current ?? createPeerConnection()

    logRTC("Adding local stream", { trackCount: stream.getTracks().length })
    stream.getTracks().forEach((track) => {
      logRTC("Adding track", { kind: track.kind, id: track.id })
      pc.addTrack(track, stream)
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
    const stream = localStreamRef.current
    if (stream) {
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !muted
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

  const getPeerConnection = useCallback(() => peerConnectionRef.current, [])

  const close = useCallback(() => {
    stopMediaStream(localStreamRef.current)
    stopMediaStream(remoteStreamRef.current)

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close()
      peerConnectionRef.current = null
    }

    localStreamRef.current = null
    remoteStreamRef.current = null
    pendingCandidatesRef.current = []
    lastConnectionStateRef.current = "closed"
    setConnectionState("closed")
  }, [])

  return {
    connectionState,
    localStream: localStreamRef.current,
    remoteStream: remoteStreamRef.current,
    createPeerConnection,
    getUserMedia,
    addLocalStream,
    createOffer,
    createAnswer,
    handleAnswer,
    addIceCandidate,
    setMuted,
    setCameraEnabled,
    getPeerConnection,
    close,
  }
}
