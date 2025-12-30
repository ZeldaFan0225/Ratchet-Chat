import type {
  SyncHandler,
  SyncContext,
  SettingsUpdatedEvent,
} from "../types"
import { validateSyncEvent } from "../validation"

export type Settings = {
  showTypingIndicator: boolean
  sendReadReceipts: boolean
  displayName: string | null
  displayNameVisibility: "public" | "hidden"
}

export type SettingsApplyFn = (updates: Partial<Settings>) => void

export class SettingsSyncHandler
  implements SyncHandler<"SETTINGS_UPDATED">
{
  eventTypes: ["SETTINGS_UPDATED"] = ["SETTINGS_UPDATED"]
  private applySettings: SettingsApplyFn

  constructor(applySettings: SettingsApplyFn) {
    this.applySettings = applySettings
  }

  validate(
    eventType: "SETTINGS_UPDATED",
    payload: unknown
  ): payload is SettingsUpdatedEvent {
    return validateSyncEvent(eventType, payload) !== null
  }

  shouldProcess(
    _event: SettingsUpdatedEvent,
    context: SyncContext
  ): boolean {
    // Only process if authenticated
    return context.userId !== null
  }

  async handle(
    event: SettingsUpdatedEvent,
    _context: SyncContext
  ): Promise<void> {
    const updates: Partial<Settings> = {}

    if (event.showTypingIndicator !== undefined) {
      updates.showTypingIndicator = event.showTypingIndicator
    }
    if (event.sendReadReceipts !== undefined) {
      updates.sendReadReceipts = event.sendReadReceipts
    }
    if (event.displayName !== undefined) {
      updates.displayName = event.displayName
    }
    if (event.displayNameVisibility !== undefined) {
      updates.displayNameVisibility = event.displayNameVisibility
    }

    if (Object.keys(updates).length > 0) {
      this.applySettings(updates)
    }
  }
}
