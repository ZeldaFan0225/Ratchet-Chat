"use client"

import * as React from "react"
import { AuthProvider } from "@/context/AuthContext"
import { CallProvider } from "@/context/CallContext"
import { SettingsProvider } from "@/context/SettingsContext"
import { CallManager } from "@/components/call"

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <SettingsProvider>
        <CallProvider>
          {children}
          <CallManager />
        </CallProvider>
      </SettingsProvider>
    </AuthProvider>
  )
}
