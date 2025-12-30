import type { Contact } from "@/types/dashboard"

type ContactNameSource = Pick<Contact, "handle" | "username" | "nickname">

export function normalizeNickname(
  nickname: string | null | undefined
): string | null | undefined {
  if (nickname === undefined || nickname === null) {
    return nickname
  }
  const trimmed = nickname.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function getContactDisplayName(contact: ContactNameSource): string {
  const nickname = normalizeNickname(contact.nickname)
  if (nickname) return nickname
  const username = contact.username?.trim()
  if (username) return username
  return contact.handle
}

export function getContactInitials(contact: ContactNameSource): string {
  return getContactDisplayName(contact).slice(0, 2).toUpperCase()
}
