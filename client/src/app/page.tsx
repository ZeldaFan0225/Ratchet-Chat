"use client"

import { AuthScreen } from "@/components/auth/AuthScreen"
import { DashboardLayout } from "@/components/DashboardLayout"
import { useAuth } from "@/context/AuthContext"

export default function Home() {
  const { status } = useAuth()

  if (status === "guest") {
    return <AuthScreen />
  }

  return <DashboardLayout />
}
