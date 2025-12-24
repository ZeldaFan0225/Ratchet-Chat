"use client"

import * as React from "react"
import { io, type Socket } from "socket.io-client"

const SocketContext = React.createContext<Socket | null>(null)

export function SocketProvider({
  children,
  token: propToken,
}: {
  children: React.ReactNode
  token?: string | null
}) {
  const [socket, setSocket] = React.useState<Socket | null>(null)

  React.useEffect(() => {
    const url = process.env.NEXT_PUBLIC_API_URL
    if (!url) {
      return
    }
    const token =
      propToken ??
      (typeof window !== "undefined"
        ? window.localStorage.getItem("ratchet-chat:token")
        : null)

    const socketInstance = io(url, {
      withCredentials: true,
      auth: token ? { token: `Bearer ${token}` } : undefined,
    })
    setSocket(socketInstance)

    return () => {
      socketInstance.disconnect()
      setSocket(null)
    }
  }, [propToken])

  return (
    <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>
  )
}

export function useSocket(): Socket | null {
  return React.useContext(SocketContext)
}
