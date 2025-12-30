import type {
  SyncHandler,
  SyncContext,
  PrivacySettingsUpdatedEvent,
} from "../types"
import { validateSyncEvent } from "../validation"

export type PrivacySettingsApplyFn = (encrypted: {
  ciphertext: string
  iv: string
} | null) => Promise<void>

export class PrivacySettingsSyncHandler
  implements SyncHandler<"PRIVACY_SETTINGS_UPDATED">
{
  eventTypes: ["PRIVACY_SETTINGS_UPDATED"] = ["PRIVACY_SETTINGS_UPDATED"]
  private applyPrivacySettings: PrivacySettingsApplyFn

  constructor(applyPrivacySettings: PrivacySettingsApplyFn) {
    this.applyPrivacySettings = applyPrivacySettings
  }

  validate(
    eventType: "PRIVACY_SETTINGS_UPDATED",
    payload: unknown
  ): payload is PrivacySettingsUpdatedEvent {
    return validateSyncEvent(eventType, payload) !== null
  }

  shouldProcess(
    _event: PrivacySettingsUpdatedEvent,
    context: SyncContext
  ): boolean {
    // Only process if authenticated and have master key for decryption
    return context.userId !== null && context.masterKey !== null
  }

  async handle(
    event: PrivacySettingsUpdatedEvent,
    _context: SyncContext
  ): Promise<void> {
    await this.applyPrivacySettings({
      ciphertext: event.ciphertext,
      iv: event.iv,
    })
  }
}
