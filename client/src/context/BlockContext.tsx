"use client"

import * as React from "react"
import { db } from "@/lib/db"
import { encryptString, decryptString, type EncryptedPayload } from "@/lib/crypto"
import { apiFetch } from "@/lib/api"
import { useAuth } from "./AuthContext"
import { useSocket } from "@/context/SocketContext"

type BlockList = {
  users: string[] // Full handles like "alice@server.com"
  servers: string[] // Server hostnames like "server.com"
}

type BlockContextValue = {
  blockedUsers: string[]
  blockedServers: string[]
  isBlocked: (handle: string) => boolean
  blockUser: (handle: string) => Promise<void>
  unblockUser: (handle: string) => Promise<void>
  blockServer: (server: string) => Promise<void>
  unblockServer: (server: string) => Promise<void>
  isLoading: boolean
}

const BLOCK_LIST_KEY = "encryptedBlockList"

const BlockContext = React.createContext<BlockContextValue | undefined>(undefined)

export function BlockProvider({ children }: { children: React.ReactNode }) {
  const { status, masterKey } = useAuth()
  const socket = useSocket()
  const [blockedUsers, setBlockedUsers] = React.useState<string[]>([])
  const [blockedServers, setBlockedServers] = React.useState<string[]>([])
  const [isLoading, setIsLoading] = React.useState(true)

  const applyEncryptedBlockList = React.useCallback(
    async (encrypted: EncryptedPayload | null) => {
      if (!encrypted) {
        setBlockedUsers([])
        setBlockedServers([])
        await db.syncState.delete(BLOCK_LIST_KEY)
        return
      }

      await db.syncState.put({ key: BLOCK_LIST_KEY, value: encrypted })

      if (!masterKey) {
        return
      }

      try {
        const decrypted = await decryptString(masterKey, encrypted)
        const blockList = JSON.parse(decrypted) as BlockList
        const users = (blockList.users ?? []).map((entry) => entry.toLowerCase())
        const servers = (blockList.servers ?? []).map((entry) => entry.toLowerCase())
        setBlockedUsers(users)
        setBlockedServers(servers)
      } catch (error) {
        console.error("Failed to decrypt block list:", error)
      }
    },
    [masterKey]
  )

  // Load block list: try server first, fall back to local cache
  React.useEffect(() => {
    if (status !== "authenticated" || !masterKey) {
      setBlockedUsers([])
      setBlockedServers([])
      setIsLoading(false)
      return
    }

    let active = true
    setIsLoading(true)
    async function loadBlockList() {
      try {
        // Try to load from server first
        const serverData = await apiFetch<{ ciphertext: string | null; iv: string | null }>(
          "/auth/block-list"
        ).catch(() => null)

        let encrypted: EncryptedPayload | null = null

        if (serverData?.ciphertext && serverData?.iv) {
          encrypted = { ciphertext: serverData.ciphertext, iv: serverData.iv }
        } else {
          const record = await db.syncState.get(BLOCK_LIST_KEY)
          if (record?.value) {
            encrypted = record.value as EncryptedPayload
          }
        }

        await applyEncryptedBlockList(encrypted)
      } catch (error) {
        console.error("Failed to load block list:", error)
      } finally {
        if (active) {
          setIsLoading(false)
        }
      }
    }

    void loadBlockList()
    return () => {
      active = false
    }
  }, [status, masterKey, applyEncryptedBlockList])

  React.useEffect(() => {
    if (!socket) return

    const handleBlockListUpdated = (payload?: { ciphertext?: string; iv?: string }) => {
      if (!payload?.ciphertext || !payload?.iv) {
        return
      }
      void applyEncryptedBlockList({
        ciphertext: payload.ciphertext,
        iv: payload.iv,
      })
    }

    socket.on("BLOCK_LIST_UPDATED", handleBlockListUpdated)

    return () => {
      socket.off("BLOCK_LIST_UPDATED", handleBlockListUpdated)
    }
  }, [socket, applyEncryptedBlockList])

  // Save encrypted block list to both local and server
  const saveBlockList = React.useCallback(
    async (users: string[], servers: string[]) => {
      if (!masterKey) return

      const blockList: BlockList = { users, servers }
      const encrypted = await encryptString(masterKey, JSON.stringify(blockList))

      // Save to local cache
      await db.syncState.put({
        key: BLOCK_LIST_KEY,
        value: encrypted,
      })

      // Sync to server (fire and forget, don't block UI)
      apiFetch("/auth/block-list", {
        method: "PUT",
        body: encrypted,
      }).catch((error) => {
        console.error("Failed to sync block list to server:", error)
      })
    },
    [masterKey]
  )

  // Check if a handle is blocked (either directly or via server)
  const isBlocked = React.useCallback(
    (handle: string): boolean => {
      if (blockedUsers.includes(handle.toLowerCase())) {
        return true
      }

      // Extract server from handle (e.g., "alice@server.com" -> "server.com")
      const atIndex = handle.lastIndexOf("@")
      if (atIndex !== -1) {
        const server = handle.slice(atIndex + 1).toLowerCase()
        if (blockedServers.includes(server)) {
          return true
        }
      }

      return false
    },
    [blockedUsers, blockedServers]
  )

  const blockUser = React.useCallback(
    async (handle: string) => {
      const normalizedHandle = handle.toLowerCase()
      if (blockedUsers.includes(normalizedHandle)) return

      const newUsers = [...blockedUsers, normalizedHandle]
      setBlockedUsers(newUsers)
      await saveBlockList(newUsers, blockedServers)
    },
    [blockedUsers, blockedServers, saveBlockList]
  )

  const unblockUser = React.useCallback(
    async (handle: string) => {
      const normalizedHandle = handle.toLowerCase()
      const newUsers = blockedUsers.filter((u) => u !== normalizedHandle)
      setBlockedUsers(newUsers)
      await saveBlockList(newUsers, blockedServers)
    },
    [blockedUsers, blockedServers, saveBlockList]
  )

  const blockServer = React.useCallback(
    async (server: string) => {
      const normalizedServer = server.toLowerCase()
      if (blockedServers.includes(normalizedServer)) return

      const newServers = [...blockedServers, normalizedServer]
      setBlockedServers(newServers)
      await saveBlockList(blockedUsers, newServers)
    },
    [blockedUsers, blockedServers, saveBlockList]
  )

  const unblockServer = React.useCallback(
    async (server: string) => {
      const normalizedServer = server.toLowerCase()
      const newServers = blockedServers.filter((s) => s !== normalizedServer)
      setBlockedServers(newServers)
      await saveBlockList(blockedUsers, newServers)
    },
    [blockedUsers, blockedServers, saveBlockList]
  )

  const value = React.useMemo(
    (): BlockContextValue => ({
      blockedUsers,
      blockedServers,
      isBlocked,
      blockUser,
      unblockUser,
      blockServer,
      unblockServer,
      isLoading,
    }),
    [
      blockedUsers,
      blockedServers,
      isBlocked,
      blockUser,
      unblockUser,
      blockServer,
      unblockServer,
      isLoading,
    ]
  )

  return <BlockContext.Provider value={value}>{children}</BlockContext.Provider>
}

export function useBlock(): BlockContextValue {
  const context = React.useContext(BlockContext)
  if (!context) {
    throw new Error("useBlock must be used within BlockProvider")
  }
  return context
}
