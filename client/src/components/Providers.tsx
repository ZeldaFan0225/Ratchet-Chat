"use client"

import * as React from "react"
import { AuthProvider, useAuth } from "@/context/AuthContext"
import { BlockProvider } from "@/context/BlockContext"
import { SocketProvider } from "@/context/SocketContext"
import { CallProvider } from "@/context/CallContext"
import { SettingsProvider } from "@/context/SettingsContext"
import { CallManager } from "@/components/call"

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <ProvidersWithAuth>{children}</ProvidersWithAuth>
    </AuthProvider>
  )
}

function ProvidersWithAuth({ children }: { children: React.ReactNode }) {
  const { status, token, logout } = useAuth()

  const content = (
    <CallProvider>
      {children}
      <CallManager />
    </CallProvider>
  )

  return (
    <SettingsProvider>
      {status === "authenticated" ? (
        <SocketProvider token={token} onSessionInvalidated={logout}>
          <BlockProvider>{content}</BlockProvider>
        </SocketProvider>
      ) : (
        <BlockProvider>{content}</BlockProvider>
      )}
    </SettingsProvider>
  )
}
