"use client"

import * as React from "react"
import { Download, MoreVertical, Phone, Search, Trash2, Video } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { SidebarTrigger } from "@/components/ui/sidebar"
import type { Contact } from "@/types/dashboard"

type ChatHeaderProps = {
  activeContact: Contact | null
  typingStatus: Record<string, boolean>
  isChatSearchOpen: boolean
  chatSearchQuery: string
  onChatSearchQueryChange: (query: string) => void
  onChatSearchOpen: () => void
  onChatSearchClose: () => void
  onShowRecipientInfo: () => void
  onExportChat: () => void
  onDeleteChat: () => void
  onStartCall?: (type: "AUDIO" | "VIDEO") => void
  isCallDisabled?: boolean
}

export function ChatHeader({
  activeContact,
  typingStatus,
  isChatSearchOpen,
  chatSearchQuery,
  onChatSearchQueryChange,
  onChatSearchOpen,
  onChatSearchClose,
  onShowRecipientInfo,
  onExportChat,
  onDeleteChat,
  onStartCall,
  isCallDisabled = false,
}: ChatHeaderProps) {
  return (
    <header className="flex flex-none items-center gap-3 border-b bg-background/85 px-5 py-4 backdrop-blur">
      <SidebarTrigger className="-ml-1" />
      <div
        className="flex flex-1 items-center gap-3 cursor-pointer transition-opacity hover:opacity-80 -ml-2 pl-2 rounded-md py-1 hover:bg-muted/50"
        onClick={() => activeContact && onShowRecipientInfo()}
      >
        {activeContact && (
          <Avatar className="h-10 w-10 bg-emerald-600 text-white">
            <AvatarFallback>
              {activeContact.username.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        )}
        <div className="flex-1">
          <p className="text-sm font-semibold">
            {activeContact?.username ?? "Select a chat"}
          </p>
          {activeContact ? (
            activeContact.handle && typingStatus[activeContact.handle] ? (
              <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 animate-pulse">
                Typing...
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">Encrypted session</p>
            )
          ) : (
            <p className="text-xs text-muted-foreground">
              Start by adding a username on the left.
            </p>
          )}
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {onStartCall && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground"
              onClick={() => onStartCall("AUDIO")}
              disabled={!activeContact || isCallDisabled}
              title="Start voice call"
            >
              <Phone className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground"
              onClick={() => onStartCall("VIDEO")}
              disabled={!activeContact || isCallDisabled}
              title="Start video call"
            >
              <Video className="h-4 w-4" />
            </Button>
          </>
        )}
        {isChatSearchOpen ? (
          <div className="relative w-40 md:w-60">
            <Input
              placeholder="Search in chat..."
              className="h-8 pr-8"
              value={chatSearchQuery}
              onChange={(e) => onChatSearchQueryChange(e.target.value)}
              autoFocus
            />
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-0 top-0 h-8 w-8 text-muted-foreground hover:bg-transparent"
              onClick={onChatSearchClose}
            >
              <Search className="h-4 w-4 rotate-45" />
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground"
            onClick={onChatSearchOpen}
            disabled={!activeContact}
          >
            <Search />
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="text-muted-foreground">
              <MoreVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onExportChat}>
              <Download className="mr-2 h-4 w-4" />
              <span>Export Chat</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onDeleteChat}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              <span>Delete Chat</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
