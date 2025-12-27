import { encryptTransitEnvelope, decryptTransitBlob, decodeUtf8 } from "./crypto"

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
  transportPrivateKey: CryptoKey
): Promise<SignalingPayload> {
  console.log("[WebRTC] Decrypting signaling", {
    blobLength: encryptedBlob?.length,
    hasPrivateKey: !!transportPrivateKey,
    keyType: transportPrivateKey?.type,
    keyAlgorithm: (transportPrivateKey?.algorithm as RsaHashedKeyAlgorithm)?.name
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
  audio: boolean
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
    }
    throw error
  }
}

export function stopMediaStream(stream: MediaStream | null): void {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop())
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
