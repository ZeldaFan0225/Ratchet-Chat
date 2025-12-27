"use client"

import * as React from "react"
import { useCallback, useEffect, useRef, useState } from "react"

import { apiFetch } from "@/lib/api"

function logCall(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString()
  const prefix = `[CallContext ${timestamp}]`
  if (data) {
    console[level](prefix, message, data)
  } else {
    console[level](prefix, message)
  }
}
import { encryptSignaling, decryptSignaling, type SignalingPayload } from "@/lib/webrtc"
import { generateSafetyNumber } from "@/lib/crypto"
import {
  useCallSocket,
  type CallSocketMessage,
  type CallSocketSendMessage,
} from "@/hooks/useCallSocket"
import { useWebRTC, type ConnectionState } from "@/hooks/useWebRTC"
import { useAuth } from "@/context/AuthContext"

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
  direction: CallDirection | null
  error: string | null
  startedAt: Date | null
  safetyNumber: string | null
}

type IceServer = {
  urls: string | string[]
  username?: string
  credential?: string
}

type IceConfigResponse = {
  iceServers: IceServer[]
}

type CallContextValue = {
  callState: CallState
  localStream: MediaStream | null
  remoteStream: MediaStream | null
  localAudioLevel: number | null
  remoteAudioLevel: number | null
  isMuted: boolean
  isCameraOn: boolean
  isConnected: boolean
  initiateCall: (peerHandle: string, peerPublicKey: string, callType: CallType) => Promise<void>
  answerCall: () => Promise<void>
  rejectCall: (reason?: string) => void
  endCall: (reason?: string) => void
  toggleMute: () => void
  toggleCamera: () => void
}

const initialCallState: CallState = {
  status: "idle",
  callId: null,
  callType: "AUDIO",
  peerHandle: null,
  peerPublicKey: null,
  direction: null,
  error: null,
  startedAt: null,
  safetyNumber: null,
}

const CallContext = React.createContext<CallContextValue | undefined>(undefined)

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { transportPrivateKey, previousTransportPrivateKey, publicTransportKey, token } = useAuth()
  const [callState, setCallState] = useState<CallState>(initialCallState)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [localAudioLevel, setLocalAudioLevel] = useState<number | null>(null)
  const [remoteAudioLevel, setRemoteAudioLevel] = useState<number | null>(null)
  const [isMuted, setIsMuted] = useState(false)
  const [isCameraOn, setIsCameraOn] = useState(true)
  const [iceServers, setIceServers] = useState<IceServer[]>([])

  const callStateRef = useRef(callState)
  callStateRef.current = callState

  const pendingOfferRef = useRef<{ offer: SignalingPayload; peerPublicKey: string } | null>(null)
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

  // Fetch ICE servers on mount
  useEffect(() => {
    if (!token) return

    apiFetch<IceConfigResponse>("/api/calls/ice-config")
      .then((response) => {
        setIceServers(response.iceServers)
      })
      .catch((error) => {
        console.error("Failed to fetch ICE config:", error)
        // Fallback to Google STUN servers
        setIceServers([
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ])
      })
  }, [token])

  const handleRemoteStream = useCallback((stream: MediaStream) => {
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
      // Connection lost
      if (callStateRef.current.status === "connected") {
        setCallState((prev) => ({
          ...prev,
          status: "ended",
          error: state === "failed" ? "Connection failed" : "Connection lost",
        }))
      }
    }
  }, [])

  // Queue for ICE candidates generated before we have callId
  const pendingIceCandidatesRef = useRef<RTCIceCandidate[]>([])
  // Ref to store send function to avoid circular dependency
  const sendRef = useRef<((message: CallSocketSendMessage) => boolean) | null>(null)

  const decryptWithFallback = useCallback(
    async (encrypted: string): Promise<SignalingPayload> => {
      if (transportPrivateKey) {
        try {
          return await decryptSignaling(encrypted, transportPrivateKey)
        } catch (error) {
          if (!previousTransportPrivateKey) {
            throw error
          }
          return decryptSignaling(encrypted, previousTransportPrivateKey)
        }
      }
      if (previousTransportPrivateKey) {
        return decryptSignaling(encrypted, previousTransportPrivateKey)
      }
      throw new Error("No transport key")
    },
    [transportPrivateKey, previousTransportPrivateKey]
  )

  const sendIceCandidate = useCallback(
    async (candidate: RTCIceCandidate, callId: string, peerPublicKey: string) => {
      try {
        const encryptedCandidate = await encryptSignaling(
          { type: "ice-candidate", candidate: candidate.toJSON() },
          peerPublicKey
        )

        if (sendRef.current) {
          sendRef.current({
            type: "call:ice-candidate",
            call_id: callId,
            encrypted_candidate: encryptedCandidate,
          })
          logCall("info", "ICE candidate sent", { candidateType: candidate.type })
        } else {
          logCall("warn", "Cannot send ICE candidate: send function not available")
        }
      } catch (error) {
        logCall("error", "Failed to send ICE candidate", { error: String(error) })
      }
    },
    []
  )

  const handleIceCandidate = useCallback(
    async (candidate: RTCIceCandidate) => {
      const { callId, peerPublicKey } = callStateRef.current

      if (!callId || !peerPublicKey) {
        // Queue the candidate for later
        logCall("info", "Queuing ICE candidate (no callId yet)", {
          queueSize: pendingIceCandidatesRef.current.length + 1,
          candidateType: candidate.type
        })
        pendingIceCandidatesRef.current.push(candidate)
        return
      }

      await sendIceCandidate(candidate, callId, peerPublicKey)
    },
    [sendIceCandidate]
  )

  const {
    getUserMedia,
    addLocalStream,
    createOffer,
    createAnswer,
    handleAnswer,
    addIceCandidate,
    setMuted: setWebRTCMuted,
    setCameraEnabled,
    getPeerConnection,
    close: closeWebRTC,
  } = useWebRTC({
    iceServers,
    onRemoteStream: handleRemoteStream,
    onConnectionStateChange: handleConnectionStateChange,
    onIceCandidate: handleIceCandidate,
  })

  useEffect(() => {
    if (callState.status === "idle" || callState.status === "ended") {
      setLocalAudioLevel(null)
      setRemoteAudioLevel(null)
      lastInboundAudioRef.current = null
      lastOutboundAudioRef.current = null
      return
    }

    const pc = getPeerConnection()
    if (!pc) {
      return
    }

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
        if (!previous) {
          return null
        }
        const energyDelta = typedReport.totalAudioEnergy - previous.energy
        const durationDelta = typedReport.totalSamplesDuration - previous.duration
        if (energyDelta <= 0 || durationDelta <= 0) {
          return 0
        }
        const rms = Math.sqrt(energyDelta / durationDelta)
        return clampLevel(rms * 2)
      }

      return null
    }

    const tick = async () => {
      if (!isActive || pc.connectionState === "closed") {
        return
      }

      try {
        const stats = await pc.getStats()
        let inboundLevel: number | null = null
        let outboundLevel: number | null = null

        stats.forEach((report) => {
          const typedReport = report as RTCInboundRtpStreamStats & { mediaType?: string }
          const kind = typedReport.kind ?? typedReport.mediaType
          if (report.type === "inbound-rtp" && kind === "audio") {
            const level = getLevelFromReport(report, lastInboundAudioRef)
            if (level !== null) {
              inboundLevel = level
            }
          }
          if (report.type === "outbound-rtp" && kind === "audio") {
            const level = getLevelFromReport(report, lastOutboundAudioRef)
            if (level !== null) {
              outboundLevel = level
            }
          }
        })

        if (!isActive) {
          return
        }

        setRemoteAudioLevel((prev) => (inboundLevel === null ? prev : inboundLevel))
        setLocalAudioLevel((prev) => (outboundLevel === null ? prev : outboundLevel))
      } catch {
        // Keep last known levels when stats aren't available.
      }
    }

    const interval = window.setInterval(() => {
      void tick()
    }, 250)

    void tick()

    return () => {
      isActive = false
      window.clearInterval(interval)
    }
  }, [callState.status, getPeerConnection])

  const handleSocketMessage = useCallback(
    async (message: CallSocketMessage) => {
      logCall("info", "Handling socket message", { type: message.type, currentStatus: callStateRef.current.status })

      switch (message.type) {
        case "call:initiated":
          // Server confirmed call creation, now we have the call_id
          if (callStateRef.current.status === "initiating") {
            const peerPublicKey = callStateRef.current.peerPublicKey
            setCallState((prev) => ({
              ...prev,
              callId: message.call_id,
            }))

            // Flush any queued ICE candidates
            if (pendingIceCandidatesRef.current.length > 0 && peerPublicKey) {
              logCall("info", "Flushing pending ICE candidates", {
                count: pendingIceCandidatesRef.current.length
              })
              const candidates = [...pendingIceCandidatesRef.current]
              pendingIceCandidatesRef.current = []
              for (const candidate of candidates) {
                void sendIceCandidate(candidate, message.call_id, peerPublicKey)
              }
            }
          }
          break

        case "call:incoming":
          logCall("info", "Incoming call - caller's public key from server", {
            callId: message.call_id,
            callerHandle: message.caller_handle,
            callerPublicKeyLength: message.caller_public_key?.length,
            // Show more of the key to help identify mismatches
            callerPublicKeyHash: message.caller_public_key?.substring(50, 100)
          })

          // Only handle if idle
          if (callStateRef.current.status !== "idle") {
            // Auto-reject if busy
            send({
              type: "call:reject",
              call_id: message.call_id,
              reason: "busy",
            })
            return
          }

          setCallState({
            status: "incoming",
            callId: message.call_id,
            callType: message.call_type,
            peerHandle: message.caller_handle,
            peerPublicKey: message.caller_public_key,
            direction: "incoming",
            error: null,
            startedAt: null,
            safetyNumber: null,
          })

          // Store the encrypted offer for when user accepts
          if (transportPrivateKey || previousTransportPrivateKey) {
            logCall("info", "Attempting to decrypt offer", {
              hasPrivateKey: !!transportPrivateKey,
              hasPreviousPrivateKey: !!previousTransportPrivateKey,
              privateKeyType: transportPrivateKey?.type,
              privateKeyAlgorithm: (transportPrivateKey?.algorithm as RsaHashedKeyAlgorithm)?.name
            })
            try {
              const offer = await decryptWithFallback(message.encrypted_offer)
              pendingOfferRef.current = {
                offer,
                peerPublicKey: message.caller_public_key,
              }
            } catch (error) {
              console.error("Failed to decrypt offer:", error)
              setCallState((prev) => ({
                ...prev,
                status: "ended",
                error: "Failed to decrypt call offer",
              }))
            }
          }

          // Notify caller we're ringing
          send({ type: "call:ringing", call_id: message.call_id })
          break

        case "call:answer":
          logCall("info", "Processing call:answer", {
            callId: message.call_id,
            currentCallId: callStateRef.current.callId,
            hasTransportKey: !!transportPrivateKey
          })
          if (callStateRef.current.callId !== message.call_id) {
            logCall("warn", "Ignoring call:answer - callId mismatch")
            return
          }

          try {
            const answer = await decryptWithFallback(message.encrypted_answer)
            logCall("info", "Answer decrypted successfully", { answerType: answer.type })
            if (answer.type === "answer") {
              await handleAnswer({ type: "answer", sdp: answer.sdp })
              logCall("info", "Answer applied to peer connection")
              setCallState((prev) =>
                prev.status === "connected" ? prev : { ...prev, status: "connecting" }
              )
            }
          } catch (error) {
            logCall("error", "Failed to handle answer", { error: String(error) })
            setCallState((prev) => ({
              ...prev,
              status: "ended",
              error: "Failed to establish connection",
            }))
          }
          break

        case "call:ice-candidate":
          if (callStateRef.current.callId !== message.call_id) return

          try {
            const candidatePayload = await decryptWithFallback(message.encrypted_candidate)
            if (candidatePayload.type === "ice-candidate") {
              await addIceCandidate(candidatePayload.candidate)
            }
          } catch (error) {
            console.error("Failed to add ICE candidate:", error)
          }
          break

        case "call:ringing":
          if (callStateRef.current.callId !== message.call_id) return
          setCallState((prev) => ({ ...prev, status: "ringing" }))
          break

        case "call:rejected":
          if (callStateRef.current.callId !== message.call_id) return
          closeWebRTC()
          setLocalStream(null)
          setRemoteStream(null)
          setCallState((prev) => ({
            ...initialCallState,
            status: "ended",
            peerHandle: prev.peerHandle,
            callType: prev.callType,
            error: message.reason === "busy" ? "User is busy" : "Call declined",
          }))
          break

        case "call:ended":
          if (callStateRef.current.callId !== message.call_id) return
          closeWebRTC()
          setLocalStream(null)
          setRemoteStream(null)
          setCallState((prev) => ({
            ...initialCallState,
            status: "ended",
            peerHandle: prev.peerHandle,
            callType: prev.callType,
            error: message.reason === "peer_disconnected" ? "Peer disconnected" : null,
          }))
          break

        case "call:failed":
          closeWebRTC()
          setLocalStream(null)
          setRemoteStream(null)

          let errorMessage = "Call failed"
          switch (message.reason) {
            case "user_not_found":
              errorMessage = "User not found"
              break
            case "user_offline":
              errorMessage = "User is offline"
              break
            case "already_in_call":
              errorMessage = "You are already in a call"
              break
            case "recipient_busy":
              errorMessage = "User is busy"
              break
            case "no_answer":
              errorMessage = "No answer"
              break
            case "federated_calls_not_supported":
              errorMessage = "Federated calls not yet supported"
              break
          }

          setCallState((prev) => ({
            ...initialCallState,
            status: "ended",
            peerHandle: prev.peerHandle,
            callType: prev.callType,
            error: errorMessage,
          }))
          break
      }
    },
    [transportPrivateKey, handleAnswer, addIceCandidate, closeWebRTC, sendIceCandidate]
  )

  const { connect, disconnect, send, isConnected } = useCallSocket({
    onMessage: handleSocketMessage,
  })

  // Store send in ref for use in callbacks that can't depend on it directly
  sendRef.current = send

  // Connect to call socket when authenticated
  useEffect(() => {
    if (token) {
      logCall("info", "Token available, connecting to call socket")
      connect()
    } else {
      logCall("info", "No token, disconnecting from call socket")
      disconnect()
    }

    return () => {
      logCall("info", "Cleanup: disconnecting from call socket")
      disconnect()
    }
  }, [token, connect, disconnect])

  const initiateCall = useCallback(
    async (peerHandle: string, peerPublicKey: string, callType: CallType) => {
      logCall("info", "Initiating call", { peerHandle, callType, currentStatus: callState.status, isConnected })

      if (callState.status !== "idle") {
        logCall("warn", "Cannot initiate: already in a call")
        throw new Error("Already in a call")
      }

      if (!isConnected) {
        logCall("warn", "Cannot initiate: not connected to call server")
        throw new Error("Not connected to call server")
      }

      try {
        logCall("info", "Call encryption keys", {
          peerHandle,
          peerPublicKeyLength: peerPublicKey?.length,
          peerPublicKeyPrefix: peerPublicKey?.substring(0, 50)
        })

        setCallState({
          status: "initiating",
          callId: null,
          callType,
          peerHandle,
          peerPublicKey,
          direction: "outgoing",
          error: null,
          startedAt: null,
          safetyNumber: null,
        })

        // Get user media
        const stream = await getUserMedia(true, callType === "VIDEO")
        setLocalStream(stream)
        addLocalStream(stream)

        // Create offer
        const offer = await createOffer()

        // Encrypt and send
        const encryptedOffer = await encryptSignaling(
          { type: "offer", sdp: offer.sdp! },
          peerPublicKey
        )

        logCall("info", "Sending call:initiate message")
        send({
          type: "call:initiate",
          recipient_handle: peerHandle,
          call_type: callType,
          encrypted_offer: encryptedOffer,
        })
      } catch (error) {
        logCall("error", "Failed to initiate call", { error: String(error) })
        closeWebRTC()
        setLocalStream(null)
        setCallState((prev) => ({
          ...initialCallState,
          status: "ended",
          peerHandle: prev.peerHandle,
          callType: prev.callType,
          error: error instanceof Error ? error.message : "Failed to start call",
        }))
      }
    },
    [callState.status, isConnected, getUserMedia, addLocalStream, createOffer, send, closeWebRTC]
  )

  const answerCall = useCallback(async () => {
    logCall("info", "Answering call", { callId: callState.callId, status: callState.status })

    if (callState.status !== "incoming" || !callState.callId || !callState.peerPublicKey) {
      logCall("warn", "Cannot answer: invalid state", { status: callState.status, hasCallId: !!callState.callId })
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

    try {
      setCallState((prev) =>
        prev.status === "connected" ? prev : { ...prev, status: "connecting" }
      )

      // Get user media
      const stream = await getUserMedia(true, callState.callType === "VIDEO")
      setLocalStream(stream)
      addLocalStream(stream)

      // Create answer
      const answer = await createAnswer({ type: "offer", sdp: pending.offer.sdp })

      // Encrypt and send
      logCall("info", "Encrypting answer with caller's public key", {
        peerPublicKeyLength: callState.peerPublicKey?.length,
        peerPublicKeyPrefix: callState.peerPublicKey?.substring(0, 50)
      })
      const encryptedAnswer = await encryptSignaling(
        { type: "answer", sdp: answer.sdp! },
        callState.peerPublicKey
      )

      send({
        type: "call:answer",
        call_id: callState.callId,
        encrypted_answer: encryptedAnswer,
      })

      pendingOfferRef.current = null
    } catch (error) {
      console.error("Failed to answer call:", error)
      closeWebRTC()
      setLocalStream(null)
      setCallState((prev) => ({
        ...prev,
        status: "ended",
        error: error instanceof Error ? error.message : "Failed to answer call",
      }))
    }
  }, [callState, getUserMedia, addLocalStream, createAnswer, send, closeWebRTC])

  const rejectCall = useCallback(
    (reason?: string) => {
      logCall("info", "Rejecting call", { callId: callState.callId, status: callState.status, reason })

      if (callState.status !== "incoming" || !callState.callId) {
        logCall("warn", "Cannot reject: invalid state")
        return
      }

      send({
        type: "call:reject",
        call_id: callState.callId,
        reason,
      })

      pendingOfferRef.current = null
      pendingIceCandidatesRef.current = []
      setCallState((prev) => ({
        ...initialCallState,
        status: "idle", // Going back to idle immediately for reject
        // We don't show "Call Ended" screen for rejecting an incoming call, we just close it
      }))
    },
    [callState, send]
  )

  const endCall = useCallback(
    (reason?: string) => {
      logCall("info", "Ending call", { callId: callState.callId, status: callState.status, reason })

      // If we have a callId, notify the server
      if (callState.callId) {
        send({
          type: "call:end",
          call_id: callState.callId,
          reason,
        })
      } else {
        logCall("warn", "No callId, cannot notify server")
      }

      // Always clean up locally
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
    [callState.callId, send, closeWebRTC]
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

  // Reset call state after showing ended status for a bit
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

  const value: CallContextValue = {
    callState,
    localStream,
    remoteStream,
    localAudioLevel,
    remoteAudioLevel,
    isMuted,
    isCameraOn,
    isConnected,
    initiateCall,
    answerCall,
    rejectCall,
    endCall,
    toggleMute,
    toggleCamera,
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
