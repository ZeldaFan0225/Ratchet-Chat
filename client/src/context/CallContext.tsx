"use client"

import * as React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { apiFetch } from "@/lib/api"
import {
  encryptTransitEnvelope,
  buildMessageSignaturePayload,
  signMessage,
  generateSafetyNumber,
} from "@/lib/crypto"
import { ICE_SERVERS, type SignalingPayload } from "@/lib/webrtc"
import { useWebRTC, type ConnectionState } from "@/hooks/useWebRTC"
import { useAuth } from "@/context/AuthContext"
import { setInCall } from "@/lib/callState"

function logCall(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString()
  const prefix = `[CallContext ${timestamp}]`
  if (data) {
    console[level](prefix, message, data)
  } else {
    console[level](prefix, message)
  }
}

export type CallType = "AUDIO" | "VIDEO"
export type CallDirection = "outgoing" | "incoming"

export type CallStatus =
  | "idle"
  | "initiating"
  | "ringing"
  | "incoming"
  | "connecting"
  | "connected"
  | "ended"

export type CallState = {
  status: CallStatus
  callId: string | null
  callType: CallType
  peerHandle: string | null
  peerPublicKey: string | null
  peerIdentityKey: string | null
  direction: CallDirection | null
  error: string | null
  startedAt: Date | null
  safetyNumber: string | null
}

// Call signaling message payload (sent inside encrypted_blob)
export type CallMessagePayload = {
  type: "call"
  call_type: CallType
  call_id: string
  call_action:
    | "offer"
    | "answer"
    | "ice"
    | "busy"
    | "declined"
    | "end"
    | "ringing"
  sdp?: string
  candidate?: RTCIceCandidateInit
  sender_signature: string
  sender_identity_key: string
  timestamp: string
}

// Call notice payload (stored in vault, shown in chat)
export type CallNoticePayload = {
  type: "call"
  event_type: "CALL_MISSED" | "CALL_DECLINED" | "CALL_ENDED"
  call_type: CallType
  call_id: string
  direction: "incoming" | "outgoing"
  duration_seconds?: number
  text: string
  timestamp: string
  sender_signature: string
  sender_identity_key: string
}

type CallContextValue = {
  callState: CallState
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
  initiateCall: (peerHandle: string, peerPublicKey: string, peerIdentityKey: string, callType: CallType) => Promise<void>
  answerCall: () => Promise<void>
  rejectCall: (reason?: string) => void
  endCall: (reason?: string) => void
  toggleMute: () => void
  toggleCamera: () => void
  toggleScreenShare: () => void
  toggleReadabilityMode: () => void
  handleCallMessage: (senderHandle: string, senderIdentityKey: string, payload: CallMessagePayload) => void
}

const initialCallState: CallState = {
  status: "idle",
  callId: null,
  callType: "AUDIO",
  peerHandle: null,
  peerPublicKey: null,
  peerIdentityKey: null,
  direction: null,
  error: null,
  startedAt: null,
  safetyNumber: null,
}

const CALL_TIMEOUT_MS = 120_000 // 120 seconds

const CallContext = React.createContext<CallContextValue | undefined>(undefined)

export function CallProvider({ children }: { children: React.ReactNode }) {
  const {
    transportPrivateKey,
    publicTransportKey,
    identityPrivateKey,
    publicIdentityKey,
    user,
  } = useAuth()

  const [callState, setCallState] = useState<CallState>(initialCallState)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [remoteStreamVersion, setRemoteStreamVersion] = useState(0)
  const [localAudioLevel, setLocalAudioLevel] = useState<number | null>(null)
  const [remoteAudioLevel, setRemoteAudioLevel] = useState<number | null>(null)
  const [isMuted, setIsMuted] = useState(false)
  const [isCameraOn, setIsCameraOn] = useState(true)
  const [isReadabilityMode, setIsReadabilityMode] = useState(false)

  const callStateRef = useRef(callState)
  callStateRef.current = callState

  const pendingOfferRef = useRef<{ offer: SignalingPayload; peerPublicKey: string; peerIdentityKey: string } | null>(null)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)
  const lastInboundAudioRef = useRef<{ energy: number; duration: number } | null>(null)
  const lastOutboundAudioRef = useRef<{ energy: number; duration: number } | null>(null)

  // Calculate safety number when keys are available
  useEffect(() => {
    const calculateSafetyNumber = async () => {
      if (callState.peerPublicKey && publicTransportKey) {
        const number = await generateSafetyNumber(publicTransportKey, callState.peerPublicKey)
        setCallState(prev => prev.safetyNumber === number ? prev : { ...prev, safetyNumber: number })
      } else {
        setCallState(prev => prev.safetyNumber === null ? prev : { ...prev, safetyNumber: null })
      }
    }
    void calculateSafetyNumber()
  }, [callState.peerPublicKey, publicTransportKey])

  const handleRemoteStream = useCallback((stream: MediaStream) => {
    logCall("info", "Remote stream received/updated", {
      audioTracks: stream.getAudioTracks().length,
      videoTracks: stream.getVideoTracks().length,
    })
    // Always increment version to force components to re-evaluate stream tracks
    setRemoteStreamVersion((v) => v + 1)
    setRemoteStream(stream)
    setCallState((prev) =>
      prev.status === "connected"
        ? prev
        : {
            ...prev,
            status: "connected",
            startedAt: prev.startedAt || new Date(),
          }
    )
  }, [])

  const handleConnectionStateChange = useCallback((state: ConnectionState) => {
    if (state === "connected") {
      setCallState((prev) => ({
        ...prev,
        status: "connected",
        startedAt: prev.startedAt || new Date(),
      }))
    } else if (state === "failed" || state === "disconnected") {
      if (callStateRef.current.status === "connected") {
        setCallState((prev) => ({
          ...prev,
          status: "ended",
          error: state === "failed" ? "Connection failed" : "Connection lost",
        }))
      }
    }
  }, [])

  const pendingIceCandidatesRef = useRef<RTCIceCandidate[]>([])
  const isRenegotiatingRef = useRef(false)
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const sendCallMessageRef = useRef<typeof sendCallMessage | null>(null)

  // Handle renegotiation (e.g., when adding screen share to audio-only call)
  const handleNegotiationNeeded = useCallback(async () => {
    const state = callStateRef.current
    // Only handle renegotiation when already connected
    if (state.status !== "connected" || !state.peerHandle || !state.peerPublicKey) {
      logCall("info", "Skipping negotiation - not connected or missing peer info")
      return
    }

    // Prevent multiple simultaneous renegotiations
    if (isRenegotiatingRef.current) {
      logCall("info", "Skipping negotiation - already renegotiating")
      return
    }

    isRenegotiatingRef.current = true
    logCall("info", "Handling renegotiation - creating new offer")

    try {
      const pc = peerConnectionRef.current
      if (!pc) {
        logCall("warn", "No peer connection for renegotiation")
        return
      }

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      // Send the new offer to the peer
      if (sendCallMessageRef.current) {
        await sendCallMessageRef.current(
          state.peerHandle,
          state.peerPublicKey,
          "offer",
          state.callId!,
          state.callType,
          { sdp: offer.sdp }
        )
        logCall("info", "Renegotiation offer sent")
      }
    } catch (error) {
      logCall("warn", "Renegotiation failed", { error: String(error) })
    } finally {
      isRenegotiatingRef.current = false
    }
  }, [])

  const {
    getUserMedia,
    getUserMediaWithOptionalVideo,
    addLocalStream,
    createOffer,
    createAnswer,
    handleAnswer,
    addIceCandidate,
    setMuted: setWebRTCMuted,
    setCameraEnabled,
    isScreenSharing,
    remoteVideoTracks,
    startScreenShare,
    stopScreenShare,
    setScreenShareReadabilityMode,
    getPeerConnection,
    close: closeWebRTC,
  } = useWebRTC({
    iceServers: ICE_SERVERS,
    onRemoteStream: handleRemoteStream,
    onConnectionStateChange: handleConnectionStateChange,
    onIceCandidate: (candidate) => {
      pendingIceCandidatesRef.current.push(candidate)
      // ICE candidates will be sent after we have the call established
      void sendPendingIceCandidates()
    },
    onNegotiationNeeded: handleNegotiationNeeded,
  })

  // Keep refs updated for use in callbacks
  useEffect(() => {
    peerConnectionRef.current = getPeerConnection()
  })
  // Send a call signaling message via the messages API
  const sendCallMessage = useCallback(
    async (
      peerHandle: string,
      peerPublicKey: string,
      callAction: CallMessagePayload["call_action"],
      callId: string,
      callType: CallType,
      extra: { sdp?: string; candidate?: RTCIceCandidateInit } = {}
    ) => {
      if (!identityPrivateKey || !publicIdentityKey || !user?.handle) {
        throw new Error("Not authenticated")
      }

      const payload: Omit<CallMessagePayload, "sender_signature" | "sender_identity_key"> = {
        type: "call",
        call_type: callType,
        call_id: callId,
        call_action: callAction,
        timestamp: new Date().toISOString(),
        ...extra,
      }

      // Sign the payload
      const signaturePayload = buildMessageSignaturePayload(
        user.handle,
        JSON.stringify(payload),
        callId
      )
      const signature = signMessage(signaturePayload, identityPrivateKey)

      const signedPayload: CallMessagePayload = {
        ...payload,
        sender_signature: signature,
        sender_identity_key: publicIdentityKey,
      }

      // Encrypt with recipient's transport key
      const encryptedBlob = await encryptTransitEnvelope(
        JSON.stringify(signedPayload),
        peerPublicKey
      )

      logCall("info", `Sending call message: ${callAction}`, { callId, peerHandle })

      const response = await apiFetch<{ id?: string }>("/messages/send", {
        method: "POST",
        body: {
          recipient_handle: peerHandle,
          encrypted_blob: encryptedBlob,
          message_id: callId,
        },
      })

      return response
    },
    [identityPrivateKey, publicIdentityKey, user?.handle]
  )

  // Keep sendCallMessage ref updated for renegotiation callback
  useEffect(() => {
    sendCallMessageRef.current = sendCallMessage
  }, [sendCallMessage])

  // Send pending ICE candidates
  const sendPendingIceCandidates = useCallback(async () => {
    const { callId, peerHandle, peerPublicKey, callType } = callStateRef.current
    if (!callId || !peerHandle || !peerPublicKey) return

    const candidates = [...pendingIceCandidatesRef.current]
    pendingIceCandidatesRef.current = []

    for (const candidate of candidates) {
      try {
        await sendCallMessage(
          peerHandle,
          peerPublicKey,
          "ice",
          callId,
          callType,
          { candidate: candidate.toJSON() }
        )
      } catch (error) {
        logCall("warn", "Failed to send ICE candidate", { error: String(error) })
      }
    }
  }, [sendCallMessage])

  // Handle incoming call messages (called from useRatchetSync)
  const handleCallMessage = useCallback(
    (senderHandle: string, senderIdentityKey: string, payload: CallMessagePayload) => {
      logCall("info", "Handling call message", {
        action: payload.call_action,
        callId: payload.call_id,
        currentStatus: callStateRef.current.status,
      })

      // Verify the sender's identity key matches what we expect
      if (callStateRef.current.peerIdentityKey && senderIdentityKey !== callStateRef.current.peerIdentityKey) {
        logCall("error", "Identity key mismatch in call message")
        return
      }

      switch (payload.call_action) {
        case "offer":
          // Check if this is a renegotiation for the current call
          if (
            callStateRef.current.status === "connected" &&
            callStateRef.current.callId === payload.call_id &&
            callStateRef.current.peerHandle === senderHandle
          ) {
            // Renegotiation - peer added/removed tracks (e.g., screen share)
            logCall("info", "Received renegotiation offer")
            void (async () => {
              try {
                const pc = peerConnectionRef.current
                if (!pc) {
                  logCall("warn", "No peer connection for renegotiation answer")
                  return
                }

                await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp! })
                const answer = await pc.createAnswer()
                await pc.setLocalDescription(answer)

                const peerPublicKey = callStateRef.current.peerPublicKey
                if (peerPublicKey) {
                  await sendCallMessage(
                    senderHandle,
                    peerPublicKey,
                    "answer",
                    payload.call_id,
                    payload.call_type,
                    { sdp: answer.sdp }
                  )
                  logCall("info", "Sent renegotiation answer")
                }
              } catch (error) {
                logCall("warn", "Failed to handle renegotiation offer", { error: String(error) })
              }
            })()
            return
          }

          // New incoming call
          if (callStateRef.current.status !== "idle") {
            // Auto-respond busy - need to fetch transport key first
            void (async () => {
              try {
                const entry = await apiFetch<{ public_transport_key: string }>(
                  `/api/directory?handle=${encodeURIComponent(senderHandle)}`
                )
                if (entry.public_transport_key) {
                  await sendCallMessage(
                    senderHandle,
                    entry.public_transport_key,
                    "busy",
                    payload.call_id,
                    payload.call_type
                  )
                }
              } catch {
                // Best effort
              }
            })()
            return
          }

          setCallState({
            status: "incoming",
            callId: payload.call_id,
            callType: payload.call_type,
            peerHandle: senderHandle,
            peerPublicKey: null, // Will be fetched when answering/rejecting
            peerIdentityKey: senderIdentityKey,
            direction: "incoming",
            error: null,
            startedAt: null,
            safetyNumber: null,
          })

          // Store the offer for when user accepts
          pendingOfferRef.current = {
            offer: { type: "offer", sdp: payload.sdp! },
            peerPublicKey: "", // Will be fetched by answerCall
            peerIdentityKey: senderIdentityKey,
          }
          break

        case "answer":
          if (callStateRef.current.callId !== payload.call_id) return

          // Handle renegotiation answer (when already connected)
          if (callStateRef.current.status === "connected") {
            logCall("info", "Received renegotiation answer")
            void (async () => {
              try {
                const pc = peerConnectionRef.current
                if (pc) {
                  await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp! })
                  logCall("info", "Applied renegotiation answer")
                }
              } catch (error) {
                logCall("warn", "Failed to apply renegotiation answer", { error: String(error) })
              }
            })()
            return
          }

          // Initial call answer
          if (callStateRef.current.status !== "initiating" && callStateRef.current.status !== "ringing") return

          // Clear timeout
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current)
            timeoutRef.current = null
          }

          void (async () => {
            try {
              await handleAnswer({ type: "answer", sdp: payload.sdp! })
              setCallState((prev) =>
                prev.status === "connected" ? prev : { ...prev, status: "connecting" }
              )
            } catch (error) {
              logCall("warn", "Failed to handle answer", { error: String(error) })
              toast.error("Call failed", { description: "Failed to establish connection" })
              setCallState((prev) => ({
                ...prev,
                status: "ended",
                error: "Failed to establish connection",
              }))
            }
          })()
          break

        case "ice":
          if (callStateRef.current.callId !== payload.call_id) return
          if (payload.candidate) {
            void addIceCandidate(payload.candidate)
          }
          break

        case "ringing":
          if (callStateRef.current.callId !== payload.call_id) return
          setCallState((prev) => ({ ...prev, status: "ringing" }))
          break

        case "busy":
        case "declined":
          if (callStateRef.current.callId !== payload.call_id) return
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current)
            timeoutRef.current = null
          }
          closeWebRTC()
          setLocalStream(null)
          setRemoteStream(null)
          setCallState((prev) => ({
            ...initialCallState,
            status: "ended",
            peerHandle: prev.peerHandle,
            callType: prev.callType,
            error: payload.call_action === "busy" ? "User is busy" : "Call declined",
          }))
          break

        case "end":
          if (callStateRef.current.callId !== payload.call_id) return
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current)
            timeoutRef.current = null
          }
          closeWebRTC()
          setLocalStream(null)
          setRemoteStream(null)
          setCallState((prev) => ({
            ...initialCallState,
            status: "ended",
            peerHandle: prev.peerHandle,
            callType: prev.callType,
          }))
          break
      }
    },
    [handleAnswer, addIceCandidate, closeWebRTC, sendCallMessage]
  )

  // Audio level monitoring
  useEffect(() => {
    if (callState.status === "idle" || callState.status === "ended") {
      setLocalAudioLevel(null)
      setRemoteAudioLevel(null)
      lastInboundAudioRef.current = null
      lastOutboundAudioRef.current = null
      return
    }

    const pc = getPeerConnection()
    if (!pc) return

    let isActive = true
    const clampLevel = (value: number) => Math.max(0, Math.min(1, value))

    const getLevelFromReport = (
      report: RTCStats,
      lastRef: React.MutableRefObject<{ energy: number; duration: number } | null>
    ) => {
      const typedReport = report as RTCInboundRtpStreamStats & {
        mediaType?: string
        audioLevel?: number
        totalAudioEnergy?: number
        totalSamplesDuration?: number
      }
      if (typeof typedReport.audioLevel === "number" && !Number.isNaN(typedReport.audioLevel)) {
        return clampLevel(typedReport.audioLevel)
      }

      if (
        typeof typedReport.totalAudioEnergy === "number" &&
        typeof typedReport.totalSamplesDuration === "number"
      ) {
        const previous = lastRef.current
        lastRef.current = {
          energy: typedReport.totalAudioEnergy,
          duration: typedReport.totalSamplesDuration,
        }
        if (!previous) return null
        const energyDelta = typedReport.totalAudioEnergy - previous.energy
        const durationDelta = typedReport.totalSamplesDuration - previous.duration
        if (energyDelta <= 0 || durationDelta <= 0) return 0
        const rms = Math.sqrt(energyDelta / durationDelta)
        return clampLevel(rms * 2)
      }

      return null
    }

    const tick = async () => {
      if (!isActive || pc.connectionState === "closed") return

      try {
        const stats = await pc.getStats()
        let inboundLevel: number | null = null
        let outboundLevel: number | null = null

        stats.forEach((report) => {
          const typedReport = report as RTCInboundRtpStreamStats & { mediaType?: string }
          const kind = typedReport.kind ?? typedReport.mediaType
          if (report.type === "inbound-rtp" && kind === "audio") {
            const level = getLevelFromReport(report, lastInboundAudioRef)
            if (level !== null) inboundLevel = level
          }
          if (report.type === "outbound-rtp" && kind === "audio") {
            const level = getLevelFromReport(report, lastOutboundAudioRef)
            if (level !== null) outboundLevel = level
          }
        })

        if (!isActive) return
        setRemoteAudioLevel((prev) => (inboundLevel === null ? prev : inboundLevel))
        setLocalAudioLevel((prev) => (outboundLevel === null ? prev : outboundLevel))
      } catch {
        // Keep last known levels
      }
    }

    const interval = window.setInterval(() => void tick(), 250)
    void tick()

    return () => {
      isActive = false
      window.clearInterval(interval)
    }
  }, [callState.status, getPeerConnection])

  const initiateCall = useCallback(
    async (peerHandle: string, peerPublicKey: string, peerIdentityKey: string, callType: CallType) => {
      logCall("info", "Initiating call", { peerHandle, callType, currentStatus: callState.status })

      if (callState.status !== "idle") {
        throw new Error("Already in a call")
      }

      const callId = crypto.randomUUID()

      try {
        setCallState({
          status: "initiating",
          callId,
          callType,
          peerHandle,
          peerPublicKey,
          peerIdentityKey,
          direction: "outgoing",
          error: null,
          startedAt: null,
          safetyNumber: null,
        })

        // Get user media (video is optional - falls back to audio only)
        const { stream, hasVideo } = await getUserMediaWithOptionalVideo(true, callType === "VIDEO")
        setLocalStream(stream)
        setIsCameraOn(hasVideo)
        addLocalStream(stream)

        // Create offer
        const offer = await createOffer()

        // Send offer via messages
        await sendCallMessage(peerHandle, peerPublicKey, "offer", callId, callType, { sdp: offer.sdp! })

        // Start timeout
        timeoutRef.current = setTimeout(async () => {
          if (
            callStateRef.current.status === "initiating" ||
            callStateRef.current.status === "ringing"
          ) {
            logCall("info", "Call timeout - no answer")

            // Send missed call notice (queued)
            try {
              await sendCallMessage(peerHandle, peerPublicKey, "end", callId, callType)
            } catch {
              // Ignore errors sending end
            }

            closeWebRTC()
            setLocalStream(null)
            setRemoteStream(null)
            setCallState((prev) => ({
              ...initialCallState,
              status: "ended",
              peerHandle: prev.peerHandle,
              callType: prev.callType,
              error: "No answer",
            }))
          }
        }, CALL_TIMEOUT_MS)

        // Send any pending ICE candidates
        void sendPendingIceCandidates()
      } catch (error) {
        logCall("warn", "Failed to initiate call", { error: String(error) })
        const errorMessage = error instanceof Error ? error.message : "Failed to start call"
        toast.error("Call failed", { description: errorMessage })
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }
        closeWebRTC()
        setLocalStream(null)
        setCallState((prev) => ({
          ...initialCallState,
          status: "ended",
          peerHandle: prev.peerHandle,
          callType: prev.callType,
          error: errorMessage,
        }))
      }
    },
    [callState.status, getUserMediaWithOptionalVideo, addLocalStream, createOffer, sendCallMessage, closeWebRTC, sendPendingIceCandidates]
  )

  const answerCall = useCallback(async () => {
    logCall("info", "Answering call", { callId: callState.callId, status: callState.status })

    if (callState.status !== "incoming" || !callState.callId || !callState.peerHandle) {
      logCall("warn", "Cannot answer: invalid state")
      return
    }

    const pending = pendingOfferRef.current
    if (!pending || pending.offer.type !== "offer") {
      setCallState((prev) => ({
        ...prev,
        status: "ended",
        error: "No pending offer",
      }))
      return
    }

    // Look up peer's transport key from directory if not already set
    let peerTransportKey = callState.peerPublicKey
    if (!peerTransportKey) {
      try {
        const entry = await apiFetch<{ public_transport_key: string; public_identity_key: string }>(
          `/api/directory?handle=${encodeURIComponent(callState.peerHandle)}`
        )
        peerTransportKey = entry.public_transport_key
        setCallState((prev) => ({
          ...prev,
          peerPublicKey: entry.public_transport_key,
        }))
        logCall("info", "Fetched peer transport key from directory")
      } catch (error) {
        logCall("warn", "Failed to fetch peer transport key", { error: String(error) })
        toast.error("Failed to answer call", { description: "Could not find caller's key" })
        setCallState((prev) => ({
          ...prev,
          status: "ended",
          error: "Could not find caller's key",
        }))
        return
      }
    }

    if (!peerTransportKey) {
      setCallState((prev) => ({
        ...prev,
        status: "ended",
        error: "Missing peer transport key",
      }))
      return
    }

    try {
      setCallState((prev) =>
        prev.status === "connected" ? prev : { ...prev, status: "connecting" }
      )

      // Get user media (video is optional - falls back to audio only)
      const { stream, hasVideo } = await getUserMediaWithOptionalVideo(true, callState.callType === "VIDEO")
      setLocalStream(stream)
      setIsCameraOn(hasVideo)
      addLocalStream(stream)

      // Create answer
      const answer = await createAnswer({ type: "offer", sdp: pending.offer.sdp })

      // Send answer via messages
      await sendCallMessage(
        callState.peerHandle,
        peerTransportKey,
        "answer",
        callState.callId,
        callState.callType,
        { sdp: answer.sdp! }
      )

      // Send any pending ICE candidates
      void sendPendingIceCandidates()

      pendingOfferRef.current = null
    } catch (error) {
      logCall("warn", "Failed to answer call", { error: String(error) })
      const errorMessage = error instanceof Error ? error.message : "Failed to answer call"
      toast.error("Failed to answer call", { description: errorMessage })

      // Notify the caller that the call failed
      if (callState.callId && callState.peerHandle && peerTransportKey) {
        try {
          await sendCallMessage(
            callState.peerHandle,
            peerTransportKey,
            "end",
            callState.callId,
            callState.callType
          )
        } catch {
          // Best effort - ignore errors sending end message
        }
      }

      closeWebRTC()
      setLocalStream(null)
      setCallState((prev) => ({
        ...prev,
        status: "ended",
        error: errorMessage,
      }))
    }
  }, [callState, getUserMediaWithOptionalVideo, addLocalStream, createAnswer, sendCallMessage, closeWebRTC, sendPendingIceCandidates])

  const rejectCall = useCallback(
    async (reason?: string) => {
      logCall("info", "Rejecting call", { callId: callState.callId, status: callState.status, reason })

      if (callState.status !== "incoming" || !callState.callId || !callState.peerHandle) {
        logCall("warn", "Cannot reject: invalid state")
        return
      }

      // Look up peer's transport key from directory if not already set
      let peerTransportKey = callState.peerPublicKey
      if (!peerTransportKey) {
        try {
          const entry = await apiFetch<{ public_transport_key: string }>(
            `/api/directory?handle=${encodeURIComponent(callState.peerHandle)}`
          )
          peerTransportKey = entry.public_transport_key
        } catch (error) {
          logCall("warn", "Failed to fetch peer transport key for reject", { error: String(error) })
        }
      }

      if (peerTransportKey) {
        try {
          await sendCallMessage(
            callState.peerHandle,
            peerTransportKey,
            "declined",
            callState.callId,
            callState.callType
          )
        } catch {
          // Ignore errors
        }
      }

      pendingOfferRef.current = null
      pendingIceCandidatesRef.current = []
      setCallState(initialCallState)
    },
    [callState, sendCallMessage]
  )

  const endCall = useCallback(
    async (reason?: string) => {
      logCall("info", "Ending call", { callId: callState.callId, status: callState.status, reason })

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }

      // Send end message
      if (callState.callId && callState.peerHandle) {
        let peerTransportKey = callState.peerPublicKey

        // Fetch transport key if not set (e.g., ending incoming call before answering)
        if (!peerTransportKey) {
          try {
            const entry = await apiFetch<{ public_transport_key: string }>(
              `/api/directory?handle=${encodeURIComponent(callState.peerHandle)}`
            )
            peerTransportKey = entry.public_transport_key
          } catch {
            // Best effort
          }
        }

        if (peerTransportKey) {
          try {
            await sendCallMessage(
              callState.peerHandle,
              peerTransportKey,
              "end",
              callState.callId,
              callState.callType
            )
          } catch {
            // Ignore errors
          }
        }
      }

      pendingIceCandidatesRef.current = []
      closeWebRTC()
      setLocalStream(null)
      setRemoteStream(null)
      setCallState((prev) => ({
        ...initialCallState,
        status: "ended",
        peerHandle: prev.peerHandle,
        callType: prev.callType,
      }))
    },
    [callState, sendCallMessage, closeWebRTC]
  )

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const newValue = !prev
      setWebRTCMuted(newValue)
      return newValue
    })
  }, [setWebRTCMuted])

  const toggleCamera = useCallback(() => {
    setIsCameraOn((prev) => {
      const newValue = !prev
      setCameraEnabled(newValue)
      return newValue
    })
  }, [setCameraEnabled])

  const toggleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
      await stopScreenShare()
      setIsReadabilityMode(false)
    } else {
      try {
        await startScreenShare(isReadabilityMode)
      } catch (error) {
        logCall("warn", "Failed to start screen share", { error: String(error) })
        // Don't throw - user may have cancelled the picker
      }
    }
  }, [isScreenSharing, isReadabilityMode, startScreenShare, stopScreenShare])

  const toggleReadabilityMode = useCallback(async () => {
    const newMode = !isReadabilityMode
    setIsReadabilityMode(newMode)
    // Apply the new framerate constraint to the existing screen share
    if (isScreenSharing) {
      await setScreenShareReadabilityMode(newMode)
    }
  }, [isReadabilityMode, isScreenSharing, setScreenShareReadabilityMode])

  // Reset call state after showing ended status
  useEffect(() => {
    if (callState.status === "ended") {
      const timeout = setTimeout(() => {
        setCallState(initialCallState)
        setIsMuted(false)
        setIsCameraOn(true)
      }, 3000)
      return () => clearTimeout(timeout)
    }
  }, [callState.status])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  // Track active call status for other parts of the app (e.g., to pause key rotation)
  useEffect(() => {
    const isActive = callState.status !== "idle" && callState.status !== "ended"
    setInCall(isActive)
    return () => setInCall(false)
  }, [callState.status])

  const value: CallContextValue = {
    callState,
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
    initiateCall,
    answerCall,
    rejectCall,
    endCall,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    toggleReadabilityMode,
    handleCallMessage,
  }

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>
}

export function useCall() {
  const context = React.useContext(CallContext)
  if (context === undefined) {
    throw new Error("useCall must be used within a CallProvider")
  }
  return context
}
