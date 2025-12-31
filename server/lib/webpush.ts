import webpush from "web-push"
import { serverLogger, sanitizeLogPayload } from "./logger"

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com"

// Initialize VAPID if keys are configured
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
}

export interface PushSubscriptionData {
  endpoint: string
  p256dh_key: string
  auth_key: string
}

/**
 * Push envelope for E2EE notifications
 * The encrypted_preview is created by the client, server just forwards it
 */
export interface PushEnvelope {
  encrypted_preview: string // Client-encrypted TransitEnvelope JSON
  sender_handle: string // Unencrypted for fallback display
  timestamp: string
}

/**
 * Sends a push notification to a subscription
 * Returns true if successful, false if subscription expired (410 Gone)
 */
async function sendPushNotification(
  subscription: PushSubscriptionData,
  envelope: PushEnvelope
): Promise<{ success: boolean; expired: boolean }> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    serverLogger.warn("Push notification skipped: VAPID keys not configured")
    return { success: false, expired: false }
  }

  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.p256dh_key,
          auth: subscription.auth_key,
        },
      },
      JSON.stringify(envelope),
      {
        TTL: 60 * 60 * 24, // 24 hours
        urgency: "high",
      }
    )
    return { success: true, expired: false }
  } catch (error: unknown) {
    const webPushError = error as { statusCode?: number; message?: string }

    // 410 Gone means subscription expired
    // 403 Forbidden also implies invalid/expired subscription (common on iOS)
    if (webPushError.statusCode === 410 || webPushError.statusCode === 403) {
      serverLogger.info(`Push subscription expired (${webPushError.statusCode})`, {
        endpoint: subscription.endpoint.slice(0, 50) + "...",
      })
      return { success: false, expired: true }
    }

    // 404 Not Found also means subscription is invalid
    if (webPushError.statusCode === 404) {
      serverLogger.info("Push subscription not found (404)", {
        endpoint: subscription.endpoint.slice(0, 50) + "...",
      })
      return { success: false, expired: true }
    }

    serverLogger.error("Push notification failed", {
      error: sanitizeLogPayload(webPushError.message || webPushError),
      statusCode: webPushError.statusCode,
    })
    return { success: false, expired: false }
  }
}

/**
 * Sends E2EE push notifications to all subscriptions for a user
 * The preview is already encrypted by the client - server never sees the content
 * Returns list of expired subscription IDs for cleanup
 */
export async function sendPushToUserWithPreview(
  subscriptions: Array<{ id: string } & PushSubscriptionData>,
  encryptedPreview: string,
  senderHandle: string
): Promise<{ sent: number; expired: string[] }> {
  if (subscriptions.length === 0) {
    return { sent: 0, expired: [] }
  }

  const envelope: PushEnvelope = {
    encrypted_preview: encryptedPreview,
    sender_handle: senderHandle,
    timestamp: new Date().toISOString(),
  }

  const results = await Promise.allSettled(
    subscriptions.map(async (sub) => {
      const result = await sendPushNotification(sub, envelope)
      return { id: sub.id, ...result }
    })
  )

  let sent = 0
  const expired: string[] = []

  for (const result of results) {
    if (result.status === "fulfilled") {
      if (result.value.success) {
        sent++
      }
      if (result.value.expired) {
        expired.push(result.value.id)
      }
    }
  }

  return { sent, expired }
}

/**
 * Check if push notifications are properly configured
 */
export function isPushConfigured(): boolean {
  return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY)
}

/**
 * Get the public VAPID key for client registration
 */
export function getVapidPublicKey(): string | null {
  return VAPID_PUBLIC_KEY || null
}
