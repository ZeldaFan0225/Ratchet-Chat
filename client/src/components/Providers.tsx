"use client"

import * as React from "react"
import { AuthProvider, useAuth } from "@/context/AuthContext"
import { BlockProvider } from "@/context/BlockContext"
import { ContactsProvider } from "@/context/ContactsContext"
import { SocketProvider } from "@/context/SocketContext"
import { SyncProvider } from "@/context/SyncContext"
import { CallProvider } from "@/context/CallContext"
import { SettingsProvider, useSettings } from "@/context/SettingsContext"
import { CallManager } from "@/components/call"

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <ProvidersWithAuth>{children}</ProvidersWithAuth>
    </AuthProvider>
  )
}

function ProvidersWithAuth({ children }: { children: React.ReactNode }) {
  const { status, token } = useAuth()

  const content = (
    <CallProvider>
      {children}
      <CallManager />
    </CallProvider>
  )

  return (
    <SettingsProvider>
      {status === "authenticated" ? (
        <SocketProvider token={token}>
          <BlockProvider>
            <ContactsProvider>
              <SyncProviderWithSettings>{content}</SyncProviderWithSettings>
            </ContactsProvider>
          </BlockProvider>
        </SocketProvider>
      ) : (
        <BlockProvider>
          <ContactsProvider>{content}</ContactsProvider>
        </BlockProvider>
      )}
    </SettingsProvider>
  )
}

function SyncProviderWithSettings({ children }: { children: React.ReactNode }) {
  const { applyRemoteSettings, applyEncryptedPrivacySettings } = useSettings()

  return (
    <SyncProvider
      onSettingsUpdated={applyRemoteSettings}
      onPrivacySettingsUpdated={applyEncryptedPrivacySettings}
    >
      {children}
    </SyncProvider>
  )
}
