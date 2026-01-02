"use client"

import { Suspense } from "react"
import { AuthScreen } from "@/components/auth/AuthScreen"
import { LockScreen } from "@/components/auth/LockScreen"
import { DashboardLayout } from "@/components/DashboardLayout"
import { useAuth } from "@/context/AuthContext"

export default function Home() {
  const { status } = useAuth()

  if (status === "loading") {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-background">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  if (status === "guest" || status === "awaiting_2fa" || status === "awaiting_master_password") {
    return <AuthScreen />
  }

  if (status === "locked") {
    return <LockScreen />
  }

  return (
    <Suspense fallback={null}>
      <DashboardLayout />
    </Suspense>
  )
}
