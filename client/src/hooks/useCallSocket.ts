import { useCallback, useEffect, useRef, useState } from "react"
import { getAuthToken } from "@/lib/api"

function logCall(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString()
  const prefix = `[CallSocket ${timestamp}]`
  if (data) {
    console[level](prefix, message, data)
  } else {
    console[level](prefix, message)
  }
}

export type CallSocketStatus = "disconnected" | "connecting" | "connected" | "error"

export type IncomingCallMessage = {
  type: "call:incoming"
  call_id: string
  caller_handle: string
  caller_public_key: string
  call_type: "AUDIO" | "VIDEO"
  encrypted_offer: string
}

export type CallAnswerMessage = {
  type: "call:answer"
  call_id: string
  encrypted_answer: string
}

export type IceCandidateMessage = {
  type: "call:ice-candidate"
  call_id: string
  encrypted_candidate: string
}

export type CallRejectedMessage = {
  type: "call:rejected"
  call_id: string
  reason?: string
}

export type CallEndedMessage = {
  type: "call:ended"
  call_id: string
  reason?: string
}

export type CallRingingMessage = {
  type: "call:ringing"
  call_id: string
}

export type CallFailedMessage = {
  type: "call:failed"
  call_id?: string
  reason: string
}

export type CallInitiatedMessage = {
  type: "call:initiated"
  call_id: string
}

export type CallSocketMessage =
  | IncomingCallMessage
  | CallAnswerMessage
  | IceCandidateMessage
  | CallRejectedMessage
  | CallEndedMessage
  | CallRingingMessage
  | CallFailedMessage
  | CallInitiatedMessage

export type CallSocketSendMessage =
  | { type: "call:initiate"; recipient_handle: string; call_type: "AUDIO" | "VIDEO"; encrypted_offer: string }
  | { type: "call:answer"; call_id: string; encrypted_answer: string }
  | { type: "call:ice-candidate"; call_id: string; encrypted_candidate: string }
  | { type: "call:reject"; call_id: string; reason?: string }
  | { type: "call:end"; call_id: string; reason?: string }
  | { type: "call:ringing"; call_id: string }

type UseCallSocketOptions = {
  onMessage?: (message: CallSocketMessage) => void
  onConnect?: () => void
  onDisconnect?: () => void
  onError?: (error: Event) => void
}

function getCallWebSocketUrl(): string {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? ""
  if (!apiUrl) {
    throw new Error("NEXT_PUBLIC_API_URL is not set")
  }

  const url = new URL(apiUrl)
  const protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${url.host}/call`
}

export function useCallSocket(options: UseCallSocketOptions = {}) {
  const { onMessage, onConnect, onDisconnect, onError } = options
  const [status, setStatus] = useState<CallSocketStatus>("disconnected")
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttempts = useRef(0)
  const maxReconnectAttempts = 5

  const connect = useCallback(() => {
    const token = getAuthToken()
    if (!token) {
      logCall("warn", "Cannot connect: no auth token")
      setStatus("error")
      return
    }

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      logCall("info", "Already connected, skipping")
      return
    }

    try {
      const wsUrl = `${getCallWebSocketUrl()}?token=${encodeURIComponent(token)}`
      logCall("info", "Connecting to call socket", { url: wsUrl.replace(/token=[^&]+/, "token=[REDACTED]") })
      setStatus("connecting")

      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        logCall("info", "Connected to call socket")
        setStatus("connected")
        reconnectAttempts.current = 0
        onConnect?.()
      }

      ws.onclose = (event) => {
        logCall("info", "Disconnected from call socket", { code: event.code, reason: event.reason, wasClean: event.wasClean })
        setStatus("disconnected")
        wsRef.current = null
        onDisconnect?.()

        // Attempt reconnection
        if (reconnectAttempts.current < maxReconnectAttempts) {
          const delay = Math.min(1000 * 2 ** reconnectAttempts.current, 30000)
          logCall("info", "Scheduling reconnection", { attempt: reconnectAttempts.current + 1, delay })
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectAttempts.current += 1
            connect()
          }, delay)
        } else {
          logCall("warn", "Max reconnection attempts reached")
        }
      }

      ws.onerror = (event) => {
        logCall("error", "WebSocket error", { event })
        setStatus("error")
        onError?.(event)
      }

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as CallSocketMessage
          logCall("info", "Received message", { type: message.type })
          onMessage?.(message)
        } catch {
          logCall("error", "Failed to parse message", { data: event.data })
        }
      }
    } catch (error) {
      logCall("error", "Failed to connect", { error: String(error) })
      setStatus("error")
    }
  }, [onConnect, onDisconnect, onError, onMessage])

  const disconnect = useCallback(() => {
    logCall("info", "Disconnecting from call socket")
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
    reconnectAttempts.current = maxReconnectAttempts // Prevent reconnection
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    setStatus("disconnected")
  }, [])

  const send = useCallback((message: CallSocketSendMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      logCall("info", "Sending message", { type: message.type })
      wsRef.current.send(JSON.stringify(message))
      return true
    }
    logCall("warn", "Cannot send message: socket not open", { type: message.type, readyState: wsRef.current?.readyState })
    return false
  }, [])

  useEffect(() => {
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [])

  return {
    status,
    connect,
    disconnect,
    send,
    isConnected: status === "connected",
  }
}
