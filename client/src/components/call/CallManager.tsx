"use client"

import { useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { useCall } from "@/context/CallContext"
import { IncomingCallDialog } from "./IncomingCallDialog"
import { CallOverlay } from "./CallOverlay"

export function CallManager() {
  const {
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
    answerCall,
    rejectCall,
    endCall,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    toggleReadabilityMode,
  } = useCall()
  const incomingAudioRef = useRef<HTMLAudioElement>(null)
  const outgoingAudioRef = useRef<HTMLAudioElement>(null)
  const portalRoot = typeof document !== "undefined" ? document.body : null

  useEffect(() => {
    const incomingAudio = incomingAudioRef.current
    const outgoingAudio = outgoingAudioRef.current
    if (!incomingAudio || !outgoingAudio) {
      return
    }

    const stop = (audio: HTMLAudioElement) => {
      audio.pause()
      audio.currentTime = 0
    }

    const playLoop = async (audio: HTMLAudioElement) => {
      audio.loop = true
      audio.currentTime = 0
      try {
        await audio.play()
      } catch {
        // Autoplay can be blocked; ignore and retry on next state change.
      }
    }

    const isIncomingRinging = callState.status === "incoming"
    const isOutgoingRinging =
      callState.direction === "outgoing" &&
      (callState.status === "initiating" || callState.status === "ringing")

    if (isIncomingRinging) {
      stop(outgoingAudio)
      void playLoop(incomingAudio)
      return
    }

    if (isOutgoingRinging) {
      stop(incomingAudio)
      void playLoop(outgoingAudio)
      return
    }

    stop(incomingAudio)
    stop(outgoingAudio)
  }, [callState.status, callState.direction])

  return (
    <>
      <audio ref={incomingAudioRef} src="/incoming.ogg" preload="auto" playsInline />
      <audio ref={outgoingAudioRef} src="/outgoing.ogg" preload="auto" playsInline />

      {/* Incoming call dialog */}
      <IncomingCallDialog
        open={callState.status === "incoming"}
        callerHandle={callState.peerHandle ?? ""}
        callType={callState.callType}
        onAccept={answerCall}
        onReject={() => rejectCall()}
      />

      {/* Active call overlay */}
      {callState.status !== "idle" && callState.status !== "incoming"
        ? portalRoot
          ? createPortal(
              <CallOverlay
                status={callState.status}
                callType={callState.callType}
                peerHandle={callState.peerHandle}
                startedAt={callState.startedAt}
                safetyNumber={callState.safetyNumber}
                error={callState.error}
                localStream={localStream}
                remoteStream={remoteStream}
                remoteStreamVersion={remoteStreamVersion}
                remoteVideoTracks={remoteVideoTracks}
                localAudioLevel={localAudioLevel}
                remoteAudioLevel={remoteAudioLevel}
                isMuted={isMuted}
                isCameraOn={isCameraOn}
                isScreenSharing={isScreenSharing}
                isReadabilityMode={isReadabilityMode}
                onToggleMute={toggleMute}
                onToggleCamera={toggleCamera}
                onToggleScreenShare={toggleScreenShare}
                onToggleReadabilityMode={toggleReadabilityMode}
                onEndCall={() => endCall()}
              />,
              portalRoot
            )
          : (
              <CallOverlay
                status={callState.status}
                callType={callState.callType}
                peerHandle={callState.peerHandle}
                startedAt={callState.startedAt}
                safetyNumber={callState.safetyNumber}
                error={callState.error}
                localStream={localStream}
                remoteStream={remoteStream}
                remoteStreamVersion={remoteStreamVersion}
                remoteVideoTracks={remoteVideoTracks}
                localAudioLevel={localAudioLevel}
                remoteAudioLevel={remoteAudioLevel}
                isMuted={isMuted}
                isCameraOn={isCameraOn}
                isScreenSharing={isScreenSharing}
                isReadabilityMode={isReadabilityMode}
                onToggleMute={toggleMute}
                onToggleCamera={toggleCamera}
                onToggleScreenShare={toggleScreenShare}
                onToggleReadabilityMode={toggleReadabilityMode}
                onEndCall={() => endCall()}
              />
            )
        : null}
    </>
  )
}
