"use client"

import { AuthScreen } from "@/components/auth/AuthScreen"
import { DashboardLayout } from "@/components/DashboardLayout"
import { useAuth } from "@/context/AuthContext"
import { SocketProvider } from "@/context/SocketContext"

export default function Home() {
  const { status, token } = useAuth()

  if (status === "guest") {
    return <AuthScreen />
  }

  return (
    <SocketProvider token={token}>
      <DashboardLayout />
    </SocketProvider>
  )
}
