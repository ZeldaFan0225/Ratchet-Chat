import { encryptTransitEnvelope, decryptTransitBlob, decodeUtf8 } from "./crypto"

// ICE servers for WebRTC connection establishment (STUN only, peer-to-peer)
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
]

// Video quality presets
export const VIDEO_CONSTRAINTS_HD: MediaTrackConstraints = {
  width: { ideal: 1280, max: 1920 },
  height: { ideal: 720, max: 1080 },
  frameRate: { ideal: 30, max: 60 },
  facingMode: "user",
}

export const VIDEO_CONSTRAINTS_SD: MediaTrackConstraints = {
  width: { ideal: 640, max: 1280 },
  height: { ideal: 480, max: 720 },
  frameRate: { ideal: 24, max: 30 },
  facingMode: "user",
}

// Audio constraints for better quality
export const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  sampleRate: 48000,
}

export type SignalingPayload =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit }

export async function encryptSignaling(
  payload: SignalingPayload,
  recipientPublicKey: string
): Promise<string> {
  console.log("[WebRTC] Encrypting signaling", {
    payloadType: payload.type,
    publicKeyLength: recipientPublicKey?.length,
    publicKeyPrefix: recipientPublicKey?.substring(0, 50)
  })
  try {
    const result = await encryptTransitEnvelope(JSON.stringify(payload), recipientPublicKey)
    console.log("[WebRTC] Encryption successful", { resultLength: result.length })
    return result
  } catch (error) {
    console.error("[WebRTC] Encryption failed", { error: String(error), payloadType: payload.type })
    throw error
  }
}

export async function decryptSignaling(
  encryptedBlob: string,
  transportPrivateKey: Uint8Array
): Promise<SignalingPayload> {
  console.log("[WebRTC] Decrypting signaling", {
    blobLength: encryptedBlob?.length,
    hasPrivateKey: !!transportPrivateKey,
    keyLength: transportPrivateKey?.length
  })
  try {
    const decrypted = await decryptTransitBlob(encryptedBlob, transportPrivateKey)
    const result = JSON.parse(decodeUtf8(decrypted)) as SignalingPayload
    console.log("[WebRTC] Decryption successful", { payloadType: result.type })
    return result
  } catch (error) {
    console.error("[WebRTC] Decryption failed", {
      error: String(error),
      blobLength: encryptedBlob?.length,
      blobPreview: encryptedBlob?.substring(0, 100)
    })
    throw error
  }
}

export type MediaConstraints = {
  audio: boolean | MediaTrackConstraints
  video: boolean | MediaTrackConstraints
}

export async function getMediaStream(
  constraints: MediaConstraints
): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(constraints)
  } catch (error) {
    if (error instanceof DOMException) {
      if (error.name === "NotAllowedError") {
        throw new Error(
          "Camera/microphone access denied. Please allow access in your browser settings."
        )
      }
      if (error.name === "NotFoundError") {
        throw new Error("No camera or microphone found on this device.")
      }
      if (error.name === "NotReadableError") {
        throw new Error(
          "Camera or microphone is already in use by another application."
        )
      }
      if (error.name === "OverconstrainedError") {
        // Constraints too strict, will fallback
        throw error
      }
    }
    throw error
  }
}

// Get media stream with optional video - falls back to audio-only if video fails
// Tries HD first, then SD, then basic video, then audio-only
export async function getMediaStreamWithOptionalVideo(
  audio: boolean,
  video: boolean
): Promise<{ stream: MediaStream; hasVideo: boolean }> {
  const audioConstraints = audio ? AUDIO_CONSTRAINTS : false

  if (!video) {
    // Audio only requested
    const stream = await getMediaStream({ audio: audioConstraints, video: false })
    return { stream, hasVideo: false }
  }

  // Try HD video first
  try {
    const stream = await getMediaStream({
      audio: audioConstraints,
      video: VIDEO_CONSTRAINTS_HD,
    })
    return { stream, hasVideo: true }
  } catch {
    // HD failed, try SD
  }

  // Try SD video
  try {
    const stream = await getMediaStream({
      audio: audioConstraints,
      video: VIDEO_CONSTRAINTS_SD,
    })
    return { stream, hasVideo: true }
  } catch {
    // SD failed, try basic
  }

  // Try basic video (no constraints)
  try {
    const stream = await getMediaStream({
      audio: audioConstraints,
      video: true,
    })
    return { stream, hasVideo: true }
  } catch (error) {
    // Video completely failed, try audio only
    console.log("[WebRTC] Video failed, falling back to audio only:", error)
    try {
      const stream = await getMediaStream({ audio: audioConstraints, video: false })
      return { stream, hasVideo: false }
    } catch {
      // Audio also failed - re-throw the original error
      throw error
    }
  }
}

// Configure video bitrate on a peer connection
// Call this after connection is established
export async function setVideoBitrate(
  peerConnection: RTCPeerConnection,
  maxBitrateKbps: number = 2500
): Promise<void> {
  const senders = peerConnection.getSenders()
  for (const sender of senders) {
    if (sender.track?.kind === "video") {
      const params = sender.getParameters()
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}]
      }
      params.encodings[0].maxBitrate = maxBitrateKbps * 1000
      // Prefer higher quality over lower latency for video calls
      params.encodings[0].networkPriority = "high"
      params.degradationPreference = "maintain-resolution"
      await sender.setParameters(params)
    }
    if (sender.track?.kind === "audio") {
      const params = sender.getParameters()
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}]
      }
      // Higher audio bitrate for better quality
      params.encodings[0].maxBitrate = 128000
      params.encodings[0].networkPriority = "high"
      await sender.setParameters(params)
    }
  }
}

export function stopMediaStream(stream: MediaStream | null): void {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop())
  }
}

export async function getDisplayMedia(readabilityMode: boolean = false): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: "always",
        // Readability mode: lower fps, higher resolution for text clarity
        frameRate: readabilityMode ? { ideal: 10, max: 15 } : { ideal: 30, max: 60 },
        // Request higher resolution in readability mode
        width: readabilityMode ? { ideal: 1920, max: 2560 } : { ideal: 1920, max: 1920 },
        height: readabilityMode ? { ideal: 1080, max: 1440 } : { ideal: 1080, max: 1080 },
      } as MediaTrackConstraints,
      audio: false,
    })
  } catch (error) {
    if (error instanceof DOMException) {
      if (error.name === "NotAllowedError") {
        throw new Error("Screen sharing was cancelled or denied.")
      }
    }
    throw error
  }
}

// Apply framerate constraint to an existing video track (for toggling readability mode)
export async function applyFramerateConstraint(
  track: MediaStreamTrack,
  readabilityMode: boolean
): Promise<void> {
  if (track.kind !== "video") return

  try {
    await track.applyConstraints({
      frameRate: readabilityMode ? { ideal: 10, max: 15 } : { ideal: 30, max: 60 },
    })
  } catch (error) {
    console.log("[WebRTC] Failed to apply framerate constraint:", error)
    // Best effort - some browsers may not support changing constraints on display media
  }
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`
}

export type RTCStats = {
  roundTripTime?: number
  packetsLost?: number
  jitter?: number
}

export async function getConnectionStats(
  peerConnection: RTCPeerConnection
): Promise<RTCStats> {
  const stats = await peerConnection.getStats()
  const result: RTCStats = {}

  stats.forEach((report) => {
    if (report.type === "candidate-pair" && report.state === "succeeded") {
      result.roundTripTime = report.currentRoundTripTime
    }
    if (report.type === "inbound-rtp" && report.kind === "audio") {
      result.packetsLost = report.packetsLost
      result.jitter = report.jitter
    }
  })

  return result
}
