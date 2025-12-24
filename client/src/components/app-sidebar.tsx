"use client"

import * as React from "react"
import { Search, Settings, ShieldCheck, UserPlus } from "lucide-react"

import { useAuth } from "@/context/AuthContext"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { NavUser } from "@/components/nav-user"
import { getInstanceHost } from "@/lib/handles"

export type ConversationPreview = {
  id: string
  uid: string
  name: string
  handle: string
  lastMessage: string
  lastTimestamp: string
  unread: number
  status: "online" | "offline" | "away"
  avatar?: string
  foundMessageId?: string
}

type AppSidebarProps = React.ComponentProps<typeof Sidebar> & {
  conversations: ConversationPreview[]
  activeId: string
  onSelectConversation: (id: string, messageId?: string) => void
  onStartChat: (handle: string) => void
  onLogout: () => void
  startError?: string | null
  isBusy?: boolean
  searchQuery: string
  onSearchChange: (query: string) => void
}

export function AppSidebar({
  conversations,
  activeId,
  onSelectConversation,
  onStartChat,
  onLogout,
  startError,
  isBusy,
  searchQuery,
  onSearchChange,
  ...props
}: AppSidebarProps) {
  const { user } = useAuth()
  const { isMobile, setOpenMobile } = useSidebar()
  const [newChat, setNewChat] = React.useState("")
  const instanceHost = getInstanceHost()
  const trimmedNewChat = newChat.trim()

  return (
    <Sidebar collapsible="offcanvas" className="border-r bg-sidebar" {...props}>
      <SidebarHeader className="gap-3 border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 text-white shadow-sm">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div className="leading-tight group-data-[collapsible=icon]:hidden">
              <p className="text-sm font-semibold">Ratchet-Chat</p>
              <p className="text-xs text-muted-foreground">E2EE Secure</p>
            </div>
          </div>
        </div>
        <div className="relative group-data-[collapsible=icon]:hidden">
          <Search className="text-muted-foreground absolute left-3 top-2.5 h-4 w-4" />
          <SidebarInput
            placeholder="Search chats"
            className="pl-9"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
        <form
          className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/50 px-2 py-1.5 group-data-[collapsible=icon]:hidden"
          onSubmit={(event) => {
            event.preventDefault()
            if (!newChat.trim()) {
              return
            }
            onStartChat(newChat.trim())
            setNewChat("")
          }}
        >
          <UserPlus className="h-4 w-4 text-emerald-600" />
          <SidebarInput
            placeholder="Recipient ID (user@host)"
            className="h-7 border-none bg-transparent p-0 text-xs shadow-none focus-visible:ring-0"
            value={newChat}
            onChange={(event) => setNewChat(event.target.value)}
          />
          <Button size="icon-sm" type="submit" disabled={isBusy}>
            <span className="text-xs">Go</span>
          </Button>
        </form>
        {instanceHost && trimmedNewChat && !trimmedNewChat.includes("@") ? (
          <p className="text-[11px] text-muted-foreground group-data-[collapsible=icon]:hidden">
            Recipient ID: {trimmedNewChat}@{instanceHost}
          </p>
        ) : null}
        {startError ? (
          <p className="text-xs text-destructive group-data-[collapsible=icon]:hidden">{startError}</p>
        ) : null}
      </SidebarHeader>
      <SidebarContent className="px-2">
        <SidebarGroup>
          <SidebarGroupContent>
            <ScrollArea className="h-[calc(100svh-220px)] pr-2">
              <SidebarMenu>
                {conversations.length === 0 ? (
                  <SidebarMenuItem>
                    <div className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                      {searchQuery
                        ? "No chats found."
                        : "No chats yet. Add a handle above to begin."}
                    </div>
                  </SidebarMenuItem>
                ) : (
                  conversations.map((conversation) => (
                    <SidebarMenuItem key={conversation.uid}>
                      <SidebarMenuButton
                        className="h-auto items-start gap-3 rounded-xl px-3 py-3 data-[active=true]:bg-emerald-100 dark:data-[active=true]:bg-emerald-900/20 data-[active=true]:text-emerald-900 dark:data-[active=true]:text-emerald-100"
                        isActive={activeId === conversation.id && !conversation.foundMessageId}
                        onClick={() => {
                          onSelectConversation(conversation.id, conversation.foundMessageId)
                          if (isMobile) {
                            setOpenMobile(false)
                          }
                        }}
                      >
                        <div className="relative mt-0.5">
                          <Avatar className="h-10 w-10">
                            <AvatarImage src={conversation.avatar ?? ""} />
                            <AvatarFallback>
                              {conversation.name.slice(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <span
                            className={cn(
                              "absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full",
                              conversation.status === "online" && "bg-emerald-500",
                              conversation.status === "away" && "bg-amber-400",
                              conversation.status === "offline" && "bg-slate-300"
                            )}
                          />
                        </div>
                        <div className="min-w-0 flex-1 space-y-1 group-data-[collapsible=icon]:hidden">
                          <div className="flex items-center justify-between gap-2">
                            <p className="truncate text-sm font-semibold">
                              {conversation.name}
                            </p>
                            <span className="text-[11px] text-muted-foreground">
                              {conversation.lastTimestamp}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <p className="truncate text-xs text-muted-foreground">
                              {conversation.foundMessageId && <span className="font-semibold text-emerald-600 dark:text-emerald-400 mr-1">Found:</span>}
                              {conversation.lastMessage}
                            </p>
                            {conversation.unread > 0 && !conversation.foundMessageId ? (
                              <span className="min-w-[20px] rounded-full bg-emerald-500 px-1.5 py-0.5 text-center text-[10px] font-semibold text-white">
                                {conversation.unread}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))
                )}
              </SidebarMenu>
            </ScrollArea>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t p-2">
        <NavUser
          user={{
            name: user?.username ?? "User",
            email: user?.handle ?? "user@ratchet",
            avatar: "",
          }}
          onLogout={onLogout}
        />
      </SidebarFooter>
    </Sidebar>
  )
}
