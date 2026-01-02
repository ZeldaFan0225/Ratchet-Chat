import type { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import { Router } from "express";
import jwt from "jsonwebtoken";
import type { Server as SocketIOServer } from "socket.io";
import { z } from "zod";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { fileTypeFromBuffer } from "file-type";
import { v4 as uuidv4 } from "uuid";

import { getJwtSecret, hashToken, createAuthenticateToken } from "../middleware/auth";
import { createRateLimiter } from "../middleware/rateLimit";
import {
  loginFinish,
  loginResponse,
  registerFinish,
  registerResponse,
  type ServerLoginState,
  type ServerRegistrationState,
} from "../lib/opaque";
import {
  generatePasskeyRegistrationOptions,
  verifyPasskeyRegistration,
  generatePasskeyLoginOptions,
  verifyPasskeyLogin,
  generatePasskeyRemovalOptions,
  verifyPasskeyRemoval,
  storeChallenge,
} from "../lib/webauthn";
import {
  generateTotpSecret,
  verifyTotpCode,
  getTotpUri,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
  isValidTotpCodeFormat,
  isValidRecoveryCodeFormat,
} from "../lib/totp";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";

const KDF_ITERATIONS_MIN = Number(process.env.KDF_ITERATIONS_MIN ?? 300000);
const KDF_ITERATIONS_MAX = Number(process.env.KDF_ITERATIONS_MAX ?? 1000000);
const OPAQUE_SESSION_TTL_MS = Number(
  process.env.OPAQUE_SESSION_TTL_MS ?? 5 * 60 * 1000
);
const LOGIN_BACKOFF_BASE_MS = Number(
  process.env.LOGIN_BACKOFF_BASE_MS ?? 1000
);
const LOGIN_BACKOFF_MAX_MS = Number(
  process.env.LOGIN_BACKOFF_MAX_MS ?? 10 * 60 * 1000
);

// Password + 2FA authentication toggle
// Set DISABLE_PASSWORD_2FA=true to force passkey-only authentication
const PASSWORD_2FA_ENABLED = process.env.DISABLE_PASSWORD_2FA !== "true";
const TOTP_SESSION_TTL_MS = Number(
  process.env.TOTP_SESSION_TTL_MS ?? 5 * 60 * 1000
);
const TOTP_MAX_ATTEMPTS = 5;

const updateSettingsSchema = z.object({
  showTypingIndicator: z.boolean().optional(),
  sendReadReceipts: z.boolean().optional(),
  displayName: z.union([z.string().max(64), z.null()]).optional(),
  displayNameVisibility: z.enum(["public", "hidden"]).optional(),
});

const rotateTransportKeySchema = z.object({
  public_transport_key: z.string().min(1),
  encrypted_transport_key: z.string().min(1),
  encrypted_transport_iv: z.string().min(1),
  rotated_at: z.number().int().optional(),
});

const encryptedContactsSchema = z.object({
  ciphertext: z.string().min(1),
  iv: z.string().min(1),
});

const opaqueRegisterStartSchema = z.object({
  username: z.string().min(3).max(64),
  request: z.string().min(1),
});

const opaqueRegisterFinishSchema = z.object({
  username: z.string().min(3).max(64),
  finish: z.string().min(1),
  kdf_salt: z.string().min(1),
  kdf_iterations: z
    .number()
    .int()
    .min(KDF_ITERATIONS_MIN)
    .max(KDF_ITERATIONS_MAX),
  public_identity_key: z.string().min(1),
  public_transport_key: z.string().min(1),
  encrypted_identity_key: z.string().min(1),
  encrypted_identity_iv: z.string().min(1),
  encrypted_transport_key: z.string().min(1),
  encrypted_transport_iv: z.string().min(1),
});

const opaqueLoginStartSchema = z.object({
  username: z.string().min(3).max(64),
  request: z.string().min(1),
});

const opaqueLoginFinishSchema = z.object({
  username: z.string().min(3).max(64),
  finish: z.string().min(1),
});

// Passkey schemas
const passkeyLoginOptionsSchema = z.object({
  username: z.string().min(3).max(64).optional(),
});

const passkeyLoginFinishSchema = z.object({
  response: z.any(), // AuthenticationResponseJSON
});

const passkeyRegisterStartSchema = z.object({
  username: z.string().min(3).max(64),
  opaque_request: z.string().min(1),
});

const passkeyRegisterFinishSchema = z.object({
  username: z.string().min(3).max(64),
  opaque_finish: z.string().min(1),
  passkey_response: z.any(), // RegistrationResponseJSON
  kdf_salt: z.string().min(1),
  kdf_iterations: z.number().int().min(KDF_ITERATIONS_MIN).max(KDF_ITERATIONS_MAX),
  public_identity_key: z.string().min(1),
  public_transport_key: z.string().min(1),
  encrypted_identity_key: z.string().min(1),
  encrypted_identity_iv: z.string().min(1),
  encrypted_transport_key: z.string().min(1),
  encrypted_transport_iv: z.string().min(1),
});

const passkeyAddFinishSchema = z.object({
  response: z.any(), // RegistrationResponseJSON
  name: z.string().max(64).optional(),
});

const passkeyRemoveStartSchema = z.object({
  credential_id: z.string().min(1),
});

const passkeyRemoveFinishSchema = z.object({
  target_credential_id: z.string().min(1),
  response: z.any(), // AuthenticationResponseJSON
});

const opaqueUnlockStartSchema = z.object({
  request: z.string().min(1),
});

const opaqueUnlockFinishSchema = z.object({
  finish: z.string().min(1),
});

// Password + 2FA schemas
const passwordRegisterStartSchema = z.object({
  username: z.string().min(3).max(64),
  opaque_request: z.string().min(1),
});

const passwordRegisterFinishSchema = z.object({
  username: z.string().min(3).max(64),
  opaque_finish: z.string().min(1),
  kdf_salt: z.string().min(1),
  kdf_iterations: z.number().int().min(KDF_ITERATIONS_MIN).max(KDF_ITERATIONS_MAX),
  public_identity_key: z.string().min(1),
  public_transport_key: z.string().min(1),
  encrypted_identity_key: z.string().min(1),
  encrypted_identity_iv: z.string().min(1),
  encrypted_transport_key: z.string().min(1),
  encrypted_transport_iv: z.string().min(1),
  totp_secret: z.string().min(16).max(64), // Base32 encoded TOTP secret
  encrypted_totp_secret: z.string().min(1),
  encrypted_totp_secret_iv: z.string().min(1),
  totp_code: z.string().length(6).regex(/^\d{6}$/),
});

const passwordLoginStartSchema = z.object({
  username: z.string().min(3).max(64),
  opaque_request: z.string().min(1),
});

const passwordLoginFinishSchema = z.object({
  username: z.string().min(3).max(64),
  opaque_finish: z.string().min(1),
});

const totpVerifySchema = z.object({
  session_ticket: z.string().min(1),
  totp_code: z.string().length(6).regex(/^\d{6}$/),
});

const recoveryCodeVerifySchema = z.object({
  session_ticket: z.string().min(1),
  recovery_code: z.string().min(1),
});

const totpSetupStartSchema = z.object({
  encrypted_totp_secret: z.string().min(1),
  encrypted_totp_secret_iv: z.string().min(1),
});

const totpSetupVerifySchema = z.object({
  totp_code: z.string().length(6).regex(/^\d{6}$/),
});

const totpRegenerateSchema = z.object({
  totp_secret: z.string().min(16).max(64),
  encrypted_totp_secret: z.string().min(1),
  encrypted_totp_secret_iv: z.string().min(1),
  totp_code: z.string().length(6).regex(/^\d{6}$/),
});

const totpDisableSchema = z.object({
  opaque_request: z.string().min(1),
  opaque_finish: z.string().min(1),
});

const passwordChangeSchema = z.object({
  current_opaque_request: z.string().min(1),
  current_opaque_finish: z.string().min(1),
  new_opaque_request: z.string().min(1),
  new_opaque_finish: z.string().min(1),
});

const masterPasswordChangeSchema = z.object({
  opaque_request: z.string().min(1),
  opaque_finish: z.string().min(1),
  new_kdf_salt: z.string().min(1),
  new_kdf_iterations: z.number().int().min(KDF_ITERATIONS_MIN).max(KDF_ITERATIONS_MAX),
  encrypted_identity_key: z.string().min(1),
  encrypted_identity_iv: z.string().min(1),
  encrypted_transport_key: z.string().min(1),
  encrypted_transport_iv: z.string().min(1),
  encrypted_totp_secret: z.string().optional(),
  encrypted_totp_secret_iv: z.string().optional(),
});

const password2faAddSchema = z.object({
  opaque_request: z.string().min(1),
  opaque_finish: z.string().min(1),
  totp_secret: z.string().min(16).max(64),
  encrypted_totp_secret: z.string().min(1),
  encrypted_totp_secret_iv: z.string().min(1),
  totp_code: z.string().length(6).regex(/^\d{6}$/),
});

const password2faRemoveSchema = z.object({
  opaque_request: z.string().min(1),
  opaque_finish: z.string().min(1),
});

type OpaqueRegistrationSession = {
  username: string;
  state: ServerRegistrationState;
  expiresAt: number;
};

type OpaqueLoginSession = {
  username: string;
  state: ServerLoginState;
  expiresAt: number;
};

type BackoffEntry = {
  failures: number;
  blockedUntil: number;
};

// TOTP session ticket - issued after OPAQUE password verification, before TOTP verification
type TotpSessionTicket = {
  username: string;
  userId: string;
  ipAddress: string;
  attempts: number;
  expiresAt: number;
};

const opaqueRegistrationSessions = new Map<string, OpaqueRegistrationSession>();
const opaqueLoginSessions = new Map<string, OpaqueLoginSession>();
const loginBackoff = new Map<string, BackoffEntry>();
const totpSessionTickets = new Map<string, TotpSessionTicket>();

const sessionKey = (username: string) => username;

const cleanupSessions = (now: number) => {
  for (const [key, session] of opaqueRegistrationSessions) {
    if (session.expiresAt <= now) {
      opaqueRegistrationSessions.delete(key);
    }
  }
  for (const [key, session] of opaqueLoginSessions) {
    if (session.expiresAt <= now) {
      opaqueLoginSessions.delete(key);
    }
  }
  for (const [key, ticket] of totpSessionTickets) {
    if (ticket.expiresAt <= now) {
      totpSessionTickets.delete(key);
    }
  }
};

const getBackoffKey = (req: Request, username: string) => {
  const ip = req.ip ?? "";
  return `${username}:${ip}`;
};

const isBlocked = (key: string) => {
  const entry = loginBackoff.get(key);
  if (!entry) {
    return { blocked: false, retryAfter: 0 };
  }
  const now = Date.now();
  if (entry.blockedUntil <= now) {
    return { blocked: false, retryAfter: 0 };
  }
  return {
    blocked: true,
    retryAfter: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)),
  };
};

const recordFailure = (key: string) => {
  const now = Date.now();
  const entry = loginBackoff.get(key) ?? { failures: 0, blockedUntil: 0 };
  const failures = entry.failures + 1;
  const delay = Math.min(
    LOGIN_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1),
    LOGIN_BACKOFF_MAX_MS
  );
  loginBackoff.set(key, {
    failures,
    blockedUntil: now + delay,
  });
};

const resetFailures = (key: string) => {
  loginBackoff.delete(key);
};

const SESSION_EXPIRY_DAYS = 7;

export const createAuthRouter = (prisma: PrismaClient, io?: SocketIOServer) => {
  const router = Router();
  const authenticateToken = createAuthenticateToken(prisma);
  const authLimiter = createRateLimiter({
    windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS ?? 60000),
    max: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 20),
    keyPrefix: "auth",
    skip: () => process.env.NODE_ENV !== "production",
  });

  router.use(authLimiter);

  // Server capabilities endpoint (public)
  router.get("/capabilities", (_req: Request, res: Response) => {
    res.json({
      passkey: true,
      password_2fa: PASSWORD_2FA_ENABLED,
    });
  });

  // Auth methods for current user (authenticated)
  router.get("/methods", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: {
          totp_enabled: true,
          opaque_password_file: true,
          passkeys: {
            select: { id: true },
          },
        },
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({
        has_passkey: user.passkeys.length > 0,
        has_password_2fa: user.totp_enabled && user.opaque_password_file !== null,
        passkey_count: user.passkeys.length,
      });
    } catch (error) {
      console.error("Error fetching auth methods:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  const AVATAR_DIR = path.join(process.cwd(), "uploads", "avatars");
  const MAX_AVATAR_SIZE = 200 * 1024; // 200KB

  const storage = multer.memoryStorage();
  const upload = multer({
    storage,
    limits: { fileSize: MAX_AVATAR_SIZE },
  });

  router.post("/avatar", authenticateToken, upload.single("avatar"), async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    try {
      // 1. Verify file type (Magic numbers)
      const type = await fileTypeFromBuffer(req.file.buffer);
      if (!type || !["image/jpeg", "image/png", "image/webp"].includes(type.mime)) {
        return res.status(400).json({ error: "Invalid file type. Only JPEG, PNG and WebP are allowed." });
      }

      // 2. Ensure directory exists
      await fs.mkdir(AVATAR_DIR, { recursive: true });

      // 3. Get existing avatar to delete
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { avatar_filename: true },
      });

      if (user?.avatar_filename) {
        const oldPath = path.join(AVATAR_DIR, user.avatar_filename);
        await fs.unlink(oldPath).catch(() => {}); // Ignore errors if file not found
      }

      // 4. Save new file with UUID
      const filename = `${uuidv4()}.${type.ext}`;
      const filePath = path.join(AVATAR_DIR, filename);
      await fs.writeFile(filePath, req.file.buffer);

      // 5. Update database
      await prisma.user.update({
        where: { id: req.user.id },
        data: { avatar_filename: filename },
      });

      return res.json({ filename });
    } catch (error) {
      console.error("Avatar upload error:", error);
      return res.status(500).json({ error: "Failed to upload avatar" });
    }
  });

  router.delete("/avatar", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { avatar_filename: true },
      });

      if (user?.avatar_filename) {
        const filePath = path.join(AVATAR_DIR, user.avatar_filename);
        await fs.unlink(filePath).catch(() => {});
      }

      await prisma.user.update({
        where: { id: req.user.id },
        data: { avatar_filename: null },
      });

      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: "Failed to delete avatar" });
    }
  });

  router.patch("/avatar/visibility", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    
    const { visibility } = req.body;
    if (visibility !== "public" && visibility !== "hidden") {
      return res.status(400).json({ error: "Invalid visibility" });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: { avatar_visibility: visibility },
    });

    return res.json({ visibility });
  });

  router.get("/settings", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { 
        show_typing_indicator: true, 
        send_read_receipts: true,
        display_name: true,
        display_name_visibility: true,
        avatar_filename: true,
        avatar_visibility: true
      },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json({
      showTypingIndicator: user.show_typing_indicator,
      sendReadReceipts: user.send_read_receipts,
      displayName: user.display_name,
      displayNameVisibility: user.display_name_visibility,
      avatarFilename: user.avatar_filename,
      avatarVisibility: user.avatar_visibility
    });
  });

  router.patch("/settings", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const parsed = updateSettingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid request" });
    
    const { showTypingIndicator, sendReadReceipts, displayName, displayNameVisibility } =
      parsed.data;
    const data: any = {};
    if (showTypingIndicator !== undefined) data.show_typing_indicator = showTypingIndicator;
    if (sendReadReceipts !== undefined) data.send_read_receipts = sendReadReceipts;
    if (displayName !== undefined) {
      const trimmed = displayName?.trim() ?? "";
      data.display_name = trimmed.length > 0 ? trimmed : null;
    }
    if (displayNameVisibility !== undefined) {
      data.display_name_visibility = displayNameVisibility;
    }
    
    if (Object.keys(data).length === 0) return res.json({});

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: {
        show_typing_indicator: true,
        send_read_receipts: true,
        display_name: true,
        display_name_visibility: true,
      },
    });

    // Notify other devices of settings change
    io?.to(req.user.id).emit("SETTINGS_UPDATED", {
      showTypingIndicator: user.show_typing_indicator,
      sendReadReceipts: user.send_read_receipts,
      displayName: user.display_name,
      displayNameVisibility: user.display_name_visibility,
    });

    return res.json({
      showTypingIndicator: user.show_typing_indicator,
      sendReadReceipts: user.send_read_receipts,
      displayName: user.display_name,
      displayNameVisibility: user.display_name_visibility,
    });
  });

  // Encrypted block list endpoints (minimal metadata - server only sees encrypted blob)
  router.get("/block-list", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { encrypted_block_list: true, encrypted_block_list_iv: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    // Return null if no block list exists
    if (!user.encrypted_block_list || !user.encrypted_block_list_iv) {
      return res.json({ ciphertext: null, iv: null });
    }

    return res.json({
      ciphertext: user.encrypted_block_list,
      iv: user.encrypted_block_list_iv,
    });
  });

  router.put("/block-list", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const { ciphertext, iv } = req.body;
    if (typeof ciphertext !== "string" || typeof iv !== "string") {
      return res.status(400).json({ error: "Invalid request: ciphertext and iv required" });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        encrypted_block_list: ciphertext,
        encrypted_block_list_iv: iv,
      },
    });

    io?.to(req.user.id).emit("BLOCK_LIST_UPDATED", { ciphertext, iv });

    return res.json({ success: true });
  });

  // Encrypted contacts endpoints (minimal metadata - server only sees encrypted blob)
  router.get("/contacts", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { encrypted_contacts: true, encrypted_contacts_iv: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    if (!user.encrypted_contacts || !user.encrypted_contacts_iv) {
      return res.json({ ciphertext: null, iv: null });
    }

    return res.json({
      ciphertext: user.encrypted_contacts,
      iv: user.encrypted_contacts_iv,
    });
  });

  router.put("/contacts", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const parsed = encryptedContactsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid request" });

    const { ciphertext, iv } = parsed.data;

    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        encrypted_contacts: ciphertext,
        encrypted_contacts_iv: iv,
      },
    });

    io?.to(req.user.id).emit("CONTACTS_UPDATED", { ciphertext, iv });

    return res.json({ success: true });
  });

  // Encrypted privacy settings endpoints (server only sees encrypted blob)
  router.get("/privacy-settings", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { encrypted_privacy_settings: true, encrypted_privacy_settings_iv: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    if (!user.encrypted_privacy_settings || !user.encrypted_privacy_settings_iv) {
      return res.json({ ciphertext: null, iv: null });
    }

    return res.json({
      ciphertext: user.encrypted_privacy_settings,
      iv: user.encrypted_privacy_settings_iv,
    });
  });

  router.put("/privacy-settings", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const { ciphertext, iv } = req.body;
    if (typeof ciphertext !== "string" || typeof iv !== "string") {
      return res.status(400).json({ error: "Invalid request: ciphertext and iv required" });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        encrypted_privacy_settings: ciphertext,
        encrypted_privacy_settings_iv: iv,
      },
    });

    io?.to(req.user.id).emit("PRIVACY_SETTINGS_UPDATED", { ciphertext, iv });

    return res.json({ success: true });
  });

  // Encrypted muted conversations endpoints (server only sees encrypted blob)
  router.get("/muted-conversations", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { encrypted_muted_conversations: true, encrypted_muted_conversations_iv: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    if (!user.encrypted_muted_conversations || !user.encrypted_muted_conversations_iv) {
      return res.json({ ciphertext: null, iv: null });
    }

    return res.json({
      ciphertext: user.encrypted_muted_conversations,
      iv: user.encrypted_muted_conversations_iv,
    });
  });

  router.put("/muted-conversations", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const { ciphertext, iv } = req.body;
    if (typeof ciphertext !== "string" || typeof iv !== "string") {
      return res.status(400).json({ error: "Invalid request: ciphertext and iv required" });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        encrypted_muted_conversations: ciphertext,
        encrypted_muted_conversations_iv: iv,
      },
    });

    io?.to(req.user.id).emit("MUTED_CONVERSATIONS_UPDATED", { ciphertext, iv });

    return res.json({ success: true });
  });

  router.patch("/keys/transport", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const parsed = rotateTransportKeySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid request" });

    const {
      public_transport_key,
      encrypted_transport_key,
      encrypted_transport_iv,
      rotated_at,
    } = parsed.data;
    const rotatedAt = typeof rotated_at === "number" ? rotated_at : Date.now();

    const existing = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true },
    });

    if (!existing) {
      return res.status(404).json({ error: "User not found" });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        public_transport_key,
        encrypted_transport_key,
        encrypted_transport_iv,
      },
    });

    io?.to(req.user.id).emit("TRANSPORT_KEY_ROTATED", {
      public_transport_key,
      encrypted_transport_key,
      encrypted_transport_iv,
      rotated_at: rotatedAt,
    });

    return res.json({ ok: true, rotated_at: rotatedAt });
  });

  router.delete("/account", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const existing = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, avatar_filename: true },
    });
    if (!existing) return res.status(404).json({ error: "User not found" });

    if (existing.avatar_filename) {
      const filePath = path.join(AVATAR_DIR, existing.avatar_filename);
      await fs.unlink(filePath).catch(() => {});
    }

    await prisma.user.delete({ where: { id: req.user.id } });
    return res.json({ ok: true });
  });

  router.get("/params/:username", async (req: Request, res: Response) => {
    const { username } = req.params;
    if (!username) {
      return res.status(400).json({ error: "Invalid request" });
    }
    if (username.includes("@")) {
      return res.status(400).json({ error: "Username must be local" });
    }

    const user = await prisma.user.findUnique({
      where: { username },
      select: {
        kdf_salt: true,
        kdf_iterations: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: "Not found" });
    }

    return res.json(user);
  });

  router.post("/register", async (_req: Request, res: Response) => {
    return res
      .status(410)
      .json({ error: "Use OPAQUE registration endpoints" });
  });

  router.post("/login", async (_req: Request, res: Response) => {
    return res.status(410).json({ error: "Use OPAQUE login endpoints" });
  });

  router.post("/opaque/register/start", async (req: Request, res: Response) => {
    const parsed = opaqueRegisterStartSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { username, request } = parsed.data;
    if (username.includes("@")) {
      return res.status(400).json({ error: "Username must be local" });
    }

    const existing = await prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    if (existing) {
      return res.status(409).json({ error: "Username already taken" });
    }

    cleanupSessions(Date.now());
    let responseState: { response: Uint8Array; state: ServerRegistrationState };
    try {
      responseState = await registerResponse(
        username,
        Buffer.from(request, "base64")
      );
    } catch {
      return res.status(400).json({ error: "Invalid OPAQUE parameters" });
    }
    const expiresAt = Date.now() + OPAQUE_SESSION_TTL_MS;
    opaqueRegistrationSessions.set(sessionKey(username), {
      username,
      state: responseState.state,
      expiresAt,
    });

    return res.json({
      response: Buffer.from(responseState.response).toString("base64"),
    });
  });

  router.post("/opaque/register/finish", async (req: Request, res: Response) => {
    const parsed = opaqueRegisterFinishSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const {
      username,
      finish,
      kdf_salt,
      kdf_iterations,
      public_identity_key,
      public_transport_key,
      encrypted_identity_key,
      encrypted_identity_iv,
      encrypted_transport_key,
      encrypted_transport_iv,
    } = parsed.data;
    if (username.includes("@")) {
      return res.status(400).json({ error: "Username must be local" });
    }

    const existing = await prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    if (existing) {
      return res.status(409).json({ error: "Username already taken" });
    }

    const session = opaqueRegistrationSessions.get(sessionKey(username));
    if (!session || session.expiresAt <= Date.now()) {
      opaqueRegistrationSessions.delete(sessionKey(username));
      return res.status(400).json({ error: "OPAQUE session expired" });
    }

    let passwordFile: Uint8Array;
    try {
      passwordFile = registerFinish(
        session.state,
        Buffer.from(finish, "base64")
      );
    } catch {
      opaqueRegistrationSessions.delete(sessionKey(username));
      return res.status(400).json({ error: "Invalid registration payload" });
    }

    opaqueRegistrationSessions.delete(sessionKey(username));

    const user = await prisma.user.create({
      data: {
        username,
        kdf_salt,
        kdf_iterations,
        public_identity_key,
        public_transport_key,
        encrypted_identity_key,
        encrypted_identity_iv,
        encrypted_transport_key,
        encrypted_transport_iv,
        opaque_password_file: Buffer.from(passwordFile),
      },
      select: {
        id: true,
        username: true,
        created_at: true,
        public_identity_key: true,
        public_transport_key: true,
      },
    });

    return res.status(201).json({ user });
  });

  router.post("/opaque/login/start", async (req: Request, res: Response) => {
    const parsed = opaqueLoginStartSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { username, request } = parsed.data;
    if (username.includes("@")) {
      return res.status(400).json({ error: "Username must be local" });
    }
    const backoffKey = getBackoffKey(req, username);
    const blocked = isBlocked(backoffKey);
    if (blocked.blocked) {
      res.setHeader("Retry-After", blocked.retryAfter.toString());
      return res.status(429).json({ error: "Retry later" });
    }

    const user = await prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        opaque_password_file: true,
      },
    });
    if (!user?.opaque_password_file) {
      recordFailure(backoffKey);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    cleanupSessions(Date.now());
    let responseState: { response: Uint8Array; state: ServerLoginState };
    try {
      responseState = await loginResponse(
        username,
        new Uint8Array(user.opaque_password_file),
        Buffer.from(request, "base64")
      );
    } catch {
      recordFailure(backoffKey);
      return res.status(400).json({ error: "Invalid OPAQUE parameters" });
    }

    const expiresAt = Date.now() + OPAQUE_SESSION_TTL_MS;
    opaqueLoginSessions.set(sessionKey(username), {
      username,
      state: responseState.state,
      expiresAt,
    });

    return res.json({
      response: Buffer.from(responseState.response).toString("base64"),
    });
  });

  router.post("/opaque/login/finish", async (req: Request, res: Response) => {
    const parsed = opaqueLoginFinishSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { username, finish } = parsed.data;
    if (username.includes("@")) {
      return res.status(400).json({ error: "Username must be local" });
    }
    const backoffKey = getBackoffKey(req, username);
    const blocked = isBlocked(backoffKey);
    if (blocked.blocked) {
      res.setHeader("Retry-After", blocked.retryAfter.toString());
      return res.status(429).json({ error: "Retry later" });
    }

    const session = opaqueLoginSessions.get(sessionKey(username));
    if (!session || session.expiresAt <= Date.now()) {
      recordFailure(backoffKey);
      opaqueLoginSessions.delete(sessionKey(username));
      return res.status(400).json({ error: "OPAQUE session expired" });
    }

    try {
      await loginFinish(session.state, Buffer.from(finish, "base64"));
    } catch {
      recordFailure(backoffKey);
      opaqueLoginSessions.delete(sessionKey(username));
      return res.status(401).json({ error: "Invalid credentials" });
    }

    opaqueLoginSessions.delete(sessionKey(username));
    resetFailures(backoffKey);

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    let token: string;
    try {
      token = jwt.sign(
        { sub: user.id, username: user.username },
        getJwtSecret(),
        { expiresIn: "30d" }
      );
    } catch {
      return res.status(500).json({ error: "Server misconfigured" });
    }

    const tokenHash = hashToken(token);
    const expiresAt = new Date(
      Date.now() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000
    );
    await prisma.session.create({
      data: {
        user_id: user.id,
        token_hash: tokenHash,
        device_info: req.headers["user-agent"] ?? null,
        ip_address: req.ip ?? null,
        expires_at: expiresAt,
      },
    });

    return res.json({
      token,
      keys: {
        encrypted_identity_key: user.encrypted_identity_key,
        encrypted_identity_iv: user.encrypted_identity_iv,
        encrypted_transport_key: user.encrypted_transport_key,
        encrypted_transport_iv: user.encrypted_transport_iv,
        kdf_salt: user.kdf_salt,
        kdf_iterations: user.kdf_iterations,
        public_identity_key: user.public_identity_key,
        public_transport_key: user.public_transport_key,
      },
    });
  });

  // Session management endpoints
  router.get("/sessions", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const currentTokenHash = req.headers.authorization
      ? hashToken(req.headers.authorization.slice("Bearer ".length))
      : null;

    const sessions = await prisma.session.findMany({
      where: {
        user_id: req.user.id,
        expires_at: { gt: new Date() },
      },
      select: {
        id: true,
        device_info: true,
        ip_address: true,
        created_at: true,
        last_active_at: true,
        expires_at: true,
        token_hash: true,
      },
      orderBy: { last_active_at: "desc" },
    });

    return res.json(
      sessions.map((s) => ({
        id: s.id,
        deviceInfo: s.device_info,
        ipAddress: s.ip_address,
        createdAt: s.created_at.toISOString(),
        lastActiveAt: s.last_active_at.toISOString(),
        expiresAt: s.expires_at.toISOString(),
        isCurrent: s.token_hash === currentTokenHash,
      }))
    );
  });

  router.delete("/sessions/current", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!req.sessionId) return res.status(400).json({ error: "Session not found" });

    await prisma.session.delete({
      where: { id: req.sessionId },
    });

    return res.json({ ok: true });
  });

  router.delete("/sessions/:id", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const { id } = req.params;
    const session = await prisma.session.findUnique({
      where: { id },
      select: { id: true, user_id: true },
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (session.user_id !== req.user.id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    await prisma.session.delete({ where: { id } });

    // Notify other devices of session deletion
    io?.to(req.user.id).emit("SESSION_DELETED", {
      sessionId: id,
      deletedAt: new Date().toISOString(),
    });

    return res.json({ ok: true });
  });

  router.delete("/sessions", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const currentTokenHash = req.headers.authorization
      ? hashToken(req.headers.authorization.slice("Bearer ".length))
      : null;

    const deleted = await prisma.session.deleteMany({
      where: {
        user_id: req.user.id,
        token_hash: { not: currentTokenHash ?? "" },
      },
    });

    return res.json({ count: deleted.count });
  });

  router.post("/logout", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const currentTokenHash = req.headers.authorization
      ? hashToken(req.headers.authorization.slice("Bearer ".length))
      : null;

    if (currentTokenHash) {
      await prisma.session.deleteMany({
        where: { token_hash: currentTokenHash },
      });
    }

    return res.json({ ok: true });
  });

  // ============== PASSKEY LOGIN ==============

  router.post("/passkey/login/options", async (req: Request, res: Response) => {
    const parsed = passkeyLoginOptionsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { username } = parsed.data;

    try {
      // If username provided, look up user's passkeys
      let allowedCredentials: Array<{ id: string; transports: string[] }> | undefined;
      if (username) {
        const user = await prisma.user.findUnique({
          where: { username },
          select: {
            id: true,
            passkeys: {
              select: { credential_id: true, transports: true },
            },
          },
        });

        if (user && user.passkeys.length > 0) {
          allowedCredentials = user.passkeys.map((p) => ({
            id: p.credential_id,
            transports: p.transports,
          }));
        }
      }

      const options = await generatePasskeyLoginOptions(username, allowedCredentials);
      // Store challenge with the challenge itself as key for discoverable credentials
      storeChallenge(`login:${options.challenge}`, options.challenge);
      return res.json(options);
    } catch (err) {
      return res.status(500).json({ error: "Failed to generate options" });
    }
  });

  router.post("/passkey/login/finish", async (req: Request, res: Response) => {
    const parsed = passkeyLoginFinishSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const response = parsed.data.response as AuthenticationResponseJSON;

    // Find the credential by credential_id
    const credential = await prisma.passkeyCredential.findUnique({
      where: { credential_id: response.id },
      include: { user: true },
    });

    if (!credential) {
      return res.status(401).json({ error: "Credential not found" });
    }

    // Extract challenge from clientDataJSON to look up stored challenge
    let challengeFromResponse: string;
    try {
      const clientData = JSON.parse(
        Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8")
      );
      challengeFromResponse = clientData.challenge;
    } catch {
      return res.status(400).json({ error: "Invalid client data" });
    }

    const challengeKey = `login:${challengeFromResponse}`;

    try {
      const verification = await verifyPasskeyLogin(
        challengeKey,
        response,
        credential.public_key,
        credential.sign_count
      );

      if (!verification.verified) {
        return res.status(401).json({ error: "Verification failed" });
      }

      // Update sign count
      await prisma.passkeyCredential.update({
        where: { id: credential.id },
        data: {
          sign_count: verification.authenticationInfo.newCounter,
          last_used_at: new Date(),
        },
      });

      // Create session token
      const user = credential.user;
      let token: string;
      try {
        token = jwt.sign(
          { sub: user.id, username: user.username },
          getJwtSecret(),
          { expiresIn: "30d" }
        );
      } catch {
        return res.status(500).json({ error: "Server misconfigured" });
      }

      const tokenHash = hashToken(token);
      const expiresAt = new Date(
        Date.now() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000
      );
      await prisma.session.create({
        data: {
          user_id: user.id,
          token_hash: tokenHash,
          device_info: req.headers["user-agent"] ?? null,
          ip_address: req.ip ?? null,
          expires_at: expiresAt,
        },
      });

      return res.json({
        token,
        user: {
          id: user.id,
          username: user.username,
        },
        keys: {
          encrypted_identity_key: user.encrypted_identity_key,
          encrypted_identity_iv: user.encrypted_identity_iv,
          encrypted_transport_key: user.encrypted_transport_key,
          encrypted_transport_iv: user.encrypted_transport_iv,
          kdf_salt: user.kdf_salt,
          kdf_iterations: user.kdf_iterations,
          public_identity_key: user.public_identity_key,
          public_transport_key: user.public_transport_key,
        },
      });
    } catch (err) {
      return res.status(401).json({ error: "Verification failed" });
    }
  });

  // ============== PASSKEY REGISTRATION (combined with OPAQUE) ==============

  router.post("/passkey/register/start", async (req: Request, res: Response) => {
    const parsed = passkeyRegisterStartSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { username, opaque_request } = parsed.data;
    if (username.includes("@")) {
      return res.status(400).json({ error: "Username must be local" });
    }

    const existing = await prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    if (existing) {
      return res.status(409).json({ error: "Username already taken" });
    }

    cleanupSessions(Date.now());

    // Start OPAQUE registration
    let opaqueResponseState: { response: Uint8Array; state: ServerRegistrationState };
    try {
      opaqueResponseState = await registerResponse(
        username,
        Buffer.from(opaque_request, "base64")
      );
    } catch {
      return res.status(400).json({ error: "Invalid OPAQUE parameters" });
    }

    const expiresAt = Date.now() + OPAQUE_SESSION_TTL_MS;
    opaqueRegistrationSessions.set(sessionKey(username), {
      username,
      state: opaqueResponseState.state,
      expiresAt,
    });

    // Generate temporary user ID for passkey registration
    const tempUserId = `pending:${username}`;

    // Generate passkey creation options
    let passkeyOptions;
    try {
      passkeyOptions = await generatePasskeyRegistrationOptions(tempUserId, username, []);
    } catch {
      return res.status(500).json({ error: "Failed to generate passkey options" });
    }

    return res.json({
      opaque_response: Buffer.from(opaqueResponseState.response).toString("base64"),
      passkey_options: passkeyOptions,
    });
  });

  router.post("/passkey/register/finish", async (req: Request, res: Response) => {
    const parsed = passkeyRegisterFinishSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const {
      username,
      opaque_finish,
      passkey_response,
      kdf_salt,
      kdf_iterations,
      public_identity_key,
      public_transport_key,
      encrypted_identity_key,
      encrypted_identity_iv,
      encrypted_transport_key,
      encrypted_transport_iv,
    } = parsed.data;
    if (username.includes("@")) {
      return res.status(400).json({ error: "Username must be local" });
    }

    const existing = await prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    if (existing) {
      return res.status(409).json({ error: "Username already taken" });
    }

    // Verify OPAQUE registration
    const session = opaqueRegistrationSessions.get(sessionKey(username));
    if (!session || session.expiresAt <= Date.now()) {
      opaqueRegistrationSessions.delete(sessionKey(username));
      return res.status(400).json({ error: "OPAQUE session expired" });
    }

    let passwordFile: Uint8Array;
    try {
      passwordFile = registerFinish(
        session.state,
        Buffer.from(opaque_finish, "base64")
      );
    } catch {
      opaqueRegistrationSessions.delete(sessionKey(username));
      return res.status(400).json({ error: "Invalid OPAQUE payload" });
    }

    opaqueRegistrationSessions.delete(sessionKey(username));

    // Verify passkey registration
    const tempUserId = `pending:${username}`;
    let passkeyVerification;
    try {
      passkeyVerification = await verifyPasskeyRegistration(
        tempUserId,
        passkey_response as RegistrationResponseJSON
      );
    } catch (err) {
      return res.status(400).json({ error: "Invalid passkey response" });
    }

    if (!passkeyVerification.verified || !passkeyVerification.registrationInfo) {
      return res.status(400).json({ error: "Passkey verification failed" });
    }

    // Create user with passkey in a transaction
    const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          username,
          kdf_salt,
          kdf_iterations,
          public_identity_key,
          public_transport_key,
          encrypted_identity_key,
          encrypted_identity_iv,
          encrypted_transport_key,
          encrypted_transport_iv,
          opaque_password_file: Buffer.from(passwordFile),
        },
      });

      const regInfo = passkeyVerification.registrationInfo!;
      await tx.passkeyCredential.create({
        data: {
          user_id: newUser.id,
          credential_id: regInfo.credential.id,
          public_key: Buffer.from(regInfo.credential.publicKey),
          sign_count: regInfo.credential.counter,
          transports: (passkey_response as RegistrationResponseJSON).response.transports ?? [],
          name: "Primary passkey",
        },
      });

      return newUser;
    });

    // Create session token
    let token: string;
    try {
      token = jwt.sign(
        { sub: user.id, username: user.username },
        getJwtSecret(),
        { expiresIn: "30d" }
      );
    } catch {
      return res.status(500).json({ error: "Server misconfigured" });
    }

    const tokenHash = hashToken(token);
    const expiresAt = new Date(
      Date.now() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000
    );
    await prisma.session.create({
      data: {
        user_id: user.id,
        token_hash: tokenHash,
        device_info: req.headers["user-agent"] ?? null,
        ip_address: req.ip ?? null,
        expires_at: expiresAt,
      },
    });

    return res.status(201).json({
      token,
      user: {
        id: user.id,
        username: user.username,
      },
      keys: {
        encrypted_identity_key: user.encrypted_identity_key,
        encrypted_identity_iv: user.encrypted_identity_iv,
        encrypted_transport_key: user.encrypted_transport_key,
        encrypted_transport_iv: user.encrypted_transport_iv,
        kdf_salt: user.kdf_salt,
        kdf_iterations: user.kdf_iterations,
        public_identity_key: user.public_identity_key,
        public_transport_key: user.public_transport_key,
      },
    });
  });

  // ============== PASSKEY MANAGEMENT (JWT required) ==============

  router.get("/passkeys", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const passkeys = await prisma.passkeyCredential.findMany({
      where: { user_id: req.user.id },
      select: {
        id: true,
        credential_id: true,
        name: true,
        created_at: true,
        last_used_at: true,
      },
      orderBy: { created_at: "desc" },
    });

    return res.json(
      passkeys.map((p) => ({
        id: p.id,
        credentialId: p.credential_id,
        name: p.name,
        createdAt: p.created_at.toISOString(),
        lastUsedAt: p.last_used_at.toISOString(),
      }))
    );
  });

  router.post("/passkeys/add/start", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const existingCredentials = await prisma.passkeyCredential.findMany({
      where: { user_id: req.user.id },
      select: { credential_id: true },
    });

    try {
      const options = await generatePasskeyRegistrationOptions(
        req.user.id,
        req.user.username,
        existingCredentials.map((c) => c.credential_id)
      );
      return res.json(options);
    } catch {
      return res.status(500).json({ error: "Failed to generate options" });
    }
  });

  router.post("/passkeys/add/finish", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const parsed = passkeyAddFinishSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { response, name } = parsed.data;

    try {
      const verification = await verifyPasskeyRegistration(
        req.user.id,
        response as RegistrationResponseJSON
      );

      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ error: "Verification failed" });
      }

      const regInfo = verification.registrationInfo;
      const credential = await prisma.passkeyCredential.create({
        data: {
          user_id: req.user.id,
          credential_id: regInfo.credential.id,
          public_key: Buffer.from(regInfo.credential.publicKey),
          sign_count: regInfo.credential.counter,
          transports: (response as RegistrationResponseJSON).response.transports ?? [],
          name: name ?? `Passkey ${new Date().toLocaleDateString()}`,
        },
      });

      // Notify other devices of new passkey
      io?.to(req.user.id).emit("PASSKEY_ADDED", {
        id: credential.id,
        credentialId: credential.credential_id,
        name: credential.name,
        createdAt: credential.created_at.toISOString(),
      });

      return res.status(201).json({
        id: credential.id,
        credentialId: credential.credential_id,
        name: credential.name,
        createdAt: credential.created_at.toISOString(),
        lastUsedAt: credential.last_used_at.toISOString(),
      });
    } catch {
      return res.status(400).json({ error: "Verification failed" });
    }
  });

  router.post("/passkeys/remove/start", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const parsed = passkeyRemoveStartSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { credential_id } = parsed.data;

    // Get all credentials except the one being removed
    const otherCredentials = await prisma.passkeyCredential.findMany({
      where: {
        user_id: req.user.id,
        credential_id: { not: credential_id },
      },
      select: { credential_id: true },
    });

    if (otherCredentials.length === 0) {
      return res.status(400).json({ error: "Cannot remove last passkey" });
    }

    try {
      const options = await generatePasskeyRemovalOptions(
        req.user.id,
        otherCredentials.map((c) => c.credential_id)
      );
      return res.json(options);
    } catch {
      return res.status(500).json({ error: "Failed to generate options" });
    }
  });

  router.post("/passkeys/remove/finish", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const parsed = passkeyRemoveFinishSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { target_credential_id, response } = parsed.data;

    // Ensure the response is from a different credential
    if ((response as AuthenticationResponseJSON).id === target_credential_id) {
      return res.status(400).json({ error: "Must use different passkey to remove" });
    }

    // Find the credential used for verification
    const verifyingCredential = await prisma.passkeyCredential.findFirst({
      where: {
        user_id: req.user.id,
        credential_id: (response as AuthenticationResponseJSON).id,
      },
    });

    if (!verifyingCredential) {
      return res.status(401).json({ error: "Credential not found" });
    }

    try {
      const verification = await verifyPasskeyRemoval(
        req.user.id,
        response as AuthenticationResponseJSON,
        verifyingCredential.public_key,
        verifyingCredential.sign_count
      );

      if (!verification.verified) {
        return res.status(401).json({ error: "Verification failed" });
      }

      // Update the verifying credential's counter
      await prisma.passkeyCredential.update({
        where: { id: verifyingCredential.id },
        data: {
          sign_count: verification.authenticationInfo.newCounter,
          last_used_at: new Date(),
        },
      });

      // Delete the target credential
      await prisma.passkeyCredential.deleteMany({
        where: {
          user_id: req.user.id,
          credential_id: target_credential_id,
        },
      });

      // Notify other devices of passkey removal
      io?.to(req.user.id).emit("PASSKEY_REMOVED", {
        credentialId: target_credential_id,
      });

      return res.json({ ok: true });
    } catch {
      return res.status(401).json({ error: "Verification failed" });
    }
  });

  // ============== OPAQUE UNLOCK (JWT required, no new token) ==============

  router.post("/opaque/unlock/start", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const parsed = opaqueUnlockStartSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { request } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { username: true, opaque_password_file: true },
    });

    if (!user?.opaque_password_file) {
      return res.status(400).json({ error: "No password configured" });
    }

    cleanupSessions(Date.now());

    let responseState: { response: Uint8Array; state: ServerLoginState };
    try {
      responseState = await loginResponse(
        user.username,
        new Uint8Array(user.opaque_password_file),
        Buffer.from(request, "base64")
      );
    } catch {
      return res.status(400).json({ error: "Invalid OPAQUE parameters" });
    }

    const expiresAt = Date.now() + OPAQUE_SESSION_TTL_MS;
    opaqueLoginSessions.set(`unlock:${req.user.id}`, {
      username: user.username,
      state: responseState.state,
      expiresAt,
    });

    return res.json({
      response: Buffer.from(responseState.response).toString("base64"),
    });
  });

  router.post("/opaque/unlock/finish", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const parsed = opaqueUnlockFinishSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { finish } = parsed.data;

    const session = opaqueLoginSessions.get(`unlock:${req.user.id}`);
    if (!session || session.expiresAt <= Date.now()) {
      opaqueLoginSessions.delete(`unlock:${req.user.id}`);
      return res.status(400).json({ error: "Session expired" });
    }

    try {
      await loginFinish(session.state, Buffer.from(finish, "base64"));
    } catch {
      opaqueLoginSessions.delete(`unlock:${req.user.id}`);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    opaqueLoginSessions.delete(`unlock:${req.user.id}`);

    return res.json({ ok: true });
  });

  // ============================================
  // Push Notification Endpoints
  // ============================================

  const pushSubscribeSchema = z.object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string().min(1),
      auth: z.string().min(1),
    }),
  });

  // Register a push subscription for the current session
  router.post("/push/subscribe", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!req.sessionId) return res.status(400).json({ error: "Session not found" });

    const parsed = pushSubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    }

    const { endpoint, keys } = parsed.data;

    // Check subscription limit per session (max 3 per session to prevent abuse)
    const existingCount = await prisma.pushSubscription.count({
      where: { session_id: req.sessionId },
    });

    if (existingCount >= 3) {
      return res.status(400).json({ error: "Maximum push subscriptions reached for this session" });
    }

    // Upsert subscription (update if endpoint exists, create otherwise)
    const subscription = await prisma.pushSubscription.upsert({
      where: { endpoint },
      update: {
        p256dh_key: keys.p256dh,
        auth_key: keys.auth,
        user_agent: req.headers["user-agent"] || null,
        last_used_at: new Date(),
      },
      create: {
        session_id: req.sessionId,
        endpoint,
        p256dh_key: keys.p256dh,
        auth_key: keys.auth,
        user_agent: req.headers["user-agent"] || null,
      },
    });

    return res.json({
      subscription_id: subscription.id,
      created_at: subscription.created_at.toISOString(),
    });
  });

  // Unsubscribe from push notifications for the current session
  router.delete("/push/subscribe", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!req.sessionId) return res.status(400).json({ error: "Session not found" });

    await prisma.pushSubscription.deleteMany({
      where: { session_id: req.sessionId },
    });

    return res.json({ ok: true });
  });

  // List all push subscriptions for the current user
  router.get("/push/subscriptions", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const subscriptions = await prisma.pushSubscription.findMany({
      where: {
        session: { user_id: req.user.id },
      },
      include: {
        session: {
          select: {
            id: true,
            device_info: true,
          },
        },
      },
      orderBy: { created_at: "desc" },
    });

    return res.json({
      subscriptions: subscriptions.map((sub) => ({
        id: sub.id,
        session_id: sub.session.id,
        endpoint: sub.endpoint.slice(0, 50) + "...", // Truncate for privacy
        device_info: sub.session.device_info,
        is_current: sub.session_id === req.sessionId,
        created_at: sub.created_at.toISOString(),
        last_used_at: sub.last_used_at.toISOString(),
      })),
    });
  });

  // Send a test push notification (tests connectivity only - shows fallback message)
  router.post("/push/test", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!req.sessionId) return res.status(400).json({ error: "Session not found" });

    const { isPushConfigured, sendPushToUserWithPreview } = await import("../lib/webpush");

    if (!isPushConfigured()) {
      return res.status(503).json({ error: "Push notifications not configured on server" });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { username: true },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const subscription = await prisma.pushSubscription.findFirst({
      where: { session_id: req.sessionId },
    });

    if (!subscription) {
      return res.status(404).json({ error: "No push subscription found for this session" });
    }

    // Send test notification without encrypted preview (will show fallback message)
    // This tests push connectivity without requiring E2EE encryption
    const result = await sendPushToUserWithPreview(
      [{ id: subscription.id, endpoint: subscription.endpoint, p256dh_key: subscription.p256dh_key, auth_key: subscription.auth_key }],
      "", // Empty preview - SW will show fallback
      `Test from @${user.username}`
    );

    if (result.sent > 0) {
      await prisma.pushSubscription.update({
        where: { id: subscription.id },
        data: { last_used_at: new Date() },
      });
      return res.json({ sent: true });
    }

    if (result.expired.length > 0) {
      await prisma.pushSubscription.delete({ where: { id: subscription.id } });
      return res.status(410).json({ error: "Push subscription expired" });
    }

    return res.status(500).json({ error: "Failed to send push notification" });
  });

  // Get VAPID public key for client registration
  router.get("/push/vapid-key", async (_req: Request, res: Response) => {
    const { getVapidPublicKey } = await import("../lib/webpush");
    const key = getVapidPublicKey();

    if (!key) {
      return res.status(503).json({ error: "Push notifications not configured" });
    }

    return res.json({ vapidPublicKey: key });
  });

  // ============== PASSWORD + 2FA REGISTRATION ==============

  router.post("/password/register/start", async (req: Request, res: Response) => {
    if (!PASSWORD_2FA_ENABLED) {
      return res.status(403).json({ error: "Password authentication is disabled" });
    }

    const parsed = passwordRegisterStartSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { username, opaque_request } = parsed.data;
    if (username.includes("@")) {
      return res.status(400).json({ error: "Username must be local" });
    }

    const existing = await prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    if (existing) {
      return res.status(409).json({ error: "Username already taken" });
    }

    cleanupSessions(Date.now());

    // Start OPAQUE registration
    let opaqueResponseState: { response: Uint8Array; state: ServerRegistrationState };
    try {
      opaqueResponseState = await registerResponse(
        username,
        Buffer.from(opaque_request, "base64")
      );
    } catch {
      return res.status(400).json({ error: "Invalid OPAQUE parameters" });
    }

    const expiresAt = Date.now() + OPAQUE_SESSION_TTL_MS;
    opaqueRegistrationSessions.set(sessionKey(username), {
      username,
      state: opaqueResponseState.state,
      expiresAt,
    });

    return res.json({
      opaque_response: Buffer.from(opaqueResponseState.response).toString("base64"),
    });
  });

  router.post("/password/register/finish", async (req: Request, res: Response) => {
    if (!PASSWORD_2FA_ENABLED) {
      return res.status(403).json({ error: "Password authentication is disabled" });
    }

    const parsed = passwordRegisterFinishSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const {
      username,
      opaque_finish,
      kdf_salt,
      kdf_iterations,
      public_identity_key,
      public_transport_key,
      encrypted_identity_key,
      encrypted_identity_iv,
      encrypted_transport_key,
      encrypted_transport_iv,
      totp_secret,
      encrypted_totp_secret,
      encrypted_totp_secret_iv,
      totp_code,
    } = parsed.data;
    if (username.includes("@")) {
      return res.status(400).json({ error: "Username must be local" });
    }

    const existing = await prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    if (existing) {
      return res.status(409).json({ error: "Username already taken" });
    }

    // Verify OPAQUE registration
    const session = opaqueRegistrationSessions.get(sessionKey(username));
    if (!session || session.expiresAt <= Date.now()) {
      opaqueRegistrationSessions.delete(sessionKey(username));
      return res.status(400).json({ error: "OPAQUE session expired" });
    }

    let passwordFile: Uint8Array;
    try {
      passwordFile = registerFinish(
        session.state,
        Buffer.from(opaque_finish, "base64")
      );
    } catch {
      opaqueRegistrationSessions.delete(sessionKey(username));
      return res.status(400).json({ error: "Invalid OPAQUE payload" });
    }

    opaqueRegistrationSessions.delete(sessionKey(username));

    // Verify TOTP code
    if (!isValidTotpCodeFormat(totp_code)) {
      return res.status(400).json({ error: "Invalid TOTP code format" });
    }

    // Verify TOTP code matches the secret
    if (!verifyTotpCode(totp_secret, totp_code)) {
      return res.status(400).json({ error: "Invalid TOTP code" });
    }

    // Generate recovery codes
    const recoveryCodes = generateRecoveryCodes();
    const recoveryCodeHashes = recoveryCodes.map(hashRecoveryCode);

    // Create user with password + 2FA in a transaction
    try {
      const user = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            username,
            kdf_salt,
            kdf_iterations,
            public_identity_key,
            public_transport_key,
            encrypted_identity_key,
            encrypted_identity_iv,
            encrypted_transport_key,
            encrypted_transport_iv,
            opaque_password_file: Buffer.from(passwordFile),
            totp_enabled: true,
            totp_secret,
            encrypted_totp_secret,
            encrypted_totp_secret_iv,
            totp_verified_at: new Date(),
          },
        });

        // Store recovery codes
        await tx.totpRecoveryCode.createMany({
          data: recoveryCodeHashes.map((code_hash) => ({
            user_id: newUser.id,
            code_hash,
          })),
        });

        return newUser;
      });

      return res.status(201).json({
        user: {
          id: user.id,
          username: user.username,
        },
        recovery_codes: recoveryCodes,
      });
    } catch (error) {
      console.error("Error creating user with password + 2FA:", error);
      return res.status(500).json({ error: "Failed to create user" });
    }
  });

  // ============== PASSWORD + 2FA LOGIN ==============

  router.post("/password/login/start", async (req: Request, res: Response) => {
    if (!PASSWORD_2FA_ENABLED) {
      return res.status(403).json({ error: "Password authentication is disabled" });
    }

    const parsed = passwordLoginStartSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { username, opaque_request } = parsed.data;

    // Check backoff
    const backoffKey = getBackoffKey(req, username);
    const { blocked, retryAfter } = isBlocked(backoffKey);
    if (blocked) {
      return res.status(429).json({
        error: "Too many attempts",
        retryAfter,
      });
    }

    const user = await prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        opaque_password_file: true,
        totp_enabled: true,
      },
    });

    if (!user || !user.opaque_password_file || !user.totp_enabled) {
      recordFailure(backoffKey);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    cleanupSessions(Date.now());

    let opaqueResponseState: { response: Uint8Array; state: ServerLoginState };
    try {
      opaqueResponseState = await loginResponse(
        username,
        new Uint8Array(user.opaque_password_file),
        Buffer.from(opaque_request, "base64")
      );
    } catch {
      recordFailure(backoffKey);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const expiresAt = Date.now() + OPAQUE_SESSION_TTL_MS;
    opaqueLoginSessions.set(sessionKey(username), {
      username,
      state: opaqueResponseState.state,
      expiresAt,
    });

    return res.json({
      opaque_response: Buffer.from(opaqueResponseState.response).toString("base64"),
    });
  });

  router.post("/password/login/finish", async (req: Request, res: Response) => {
    if (!PASSWORD_2FA_ENABLED) {
      return res.status(403).json({ error: "Password authentication is disabled" });
    }

    const parsed = passwordLoginFinishSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { username, opaque_finish } = parsed.data;

    const backoffKey = getBackoffKey(req, username);
    const { blocked, retryAfter } = isBlocked(backoffKey);
    if (blocked) {
      return res.status(429).json({
        error: "Too many attempts",
        retryAfter,
      });
    }

    const session = opaqueLoginSessions.get(sessionKey(username));
    if (!session || session.expiresAt <= Date.now()) {
      opaqueLoginSessions.delete(sessionKey(username));
      recordFailure(backoffKey);
      return res.status(401).json({ error: "Session expired" });
    }

    try {
      await loginFinish(
        session.state,
        Buffer.from(opaque_finish, "base64")
      );
    } catch {
      recordFailure(backoffKey);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    opaqueLoginSessions.delete(sessionKey(username));
    resetFailures(backoffKey);

    // Get user ID for session ticket
    const user = await prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });

    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    // Generate session ticket for TOTP verification
    const sessionTicket = uuidv4();
    const ticketExpiresAt = Date.now() + TOTP_SESSION_TTL_MS;
    const ipAddress = req.ip ?? "";

    totpSessionTickets.set(sessionTicket, {
      username,
      userId: user.id,
      ipAddress,
      attempts: 0,
      expiresAt: ticketExpiresAt,
    });

    return res.json({
      requires_2fa: true,
      session_ticket: sessionTicket,
    });
  });

  router.post("/password/login/totp", async (req: Request, res: Response) => {
    if (!PASSWORD_2FA_ENABLED) {
      return res.status(403).json({ error: "Password authentication is disabled" });
    }

    const parsed = totpVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { session_ticket, totp_code } = parsed.data;

    cleanupSessions(Date.now());

    const ticket = totpSessionTickets.get(session_ticket);
    if (!ticket) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    if (ticket.expiresAt <= Date.now()) {
      totpSessionTickets.delete(session_ticket);
      return res.status(401).json({ error: "Session expired" });
    }

    // Check IP address
    const currentIp = req.ip ?? "";
    if (ticket.ipAddress !== currentIp) {
      totpSessionTickets.delete(session_ticket);
      return res.status(401).json({ error: "Session invalid" });
    }

    // Check attempts
    if (ticket.attempts >= TOTP_MAX_ATTEMPTS) {
      totpSessionTickets.delete(session_ticket);
      return res.status(429).json({ error: "Too many attempts" });
    }

    // Get user and TOTP secret
    const user = await prisma.user.findUnique({
      where: { id: ticket.userId },
      select: {
        id: true,
        username: true,
        kdf_salt: true,
        kdf_iterations: true,
        public_identity_key: true,
        public_transport_key: true,
        encrypted_identity_key: true,
        encrypted_identity_iv: true,
        encrypted_transport_key: true,
        encrypted_transport_iv: true,
        totp_secret: true,
        totp_enabled: true,
      },
    });

    if (!user || !user.totp_enabled || !user.totp_secret) {
      totpSessionTickets.delete(session_ticket);
      return res.status(401).json({ error: "2FA not enabled" });
    }

    // Verify TOTP code format
    if (!isValidTotpCodeFormat(totp_code)) {
      ticket.attempts++;
      return res.status(401).json({ error: "Invalid TOTP code format" });
    }

    // Verify TOTP code
    if (!verifyTotpCode(user.totp_secret, totp_code)) {
      ticket.attempts++;
      if (ticket.attempts >= TOTP_MAX_ATTEMPTS) {
        totpSessionTickets.delete(session_ticket);
        return res.status(429).json({ error: "Too many attempts" });
      }
      return res.status(401).json({ error: "Invalid TOTP code" });
    }

    // Mark ticket as used
    totpSessionTickets.delete(session_ticket);

    // Create session
    const token = jwt.sign(
      { sub: user.id, username: user.username },
      getJwtSecret(),
      { expiresIn: "30d" }
    );
    const tokenHash = hashToken(token);
    const sessionExpiresAt = new Date();
    sessionExpiresAt.setDate(sessionExpiresAt.getDate() + SESSION_EXPIRY_DAYS);

    await prisma.session.create({
      data: {
        user_id: user.id,
        token_hash: tokenHash,
        device_info: req.get("user-agent") ?? null,
        ip_address: req.ip ?? null,
        expires_at: sessionExpiresAt,
      },
    });

    return res.json({
      token,
      keys: {
        encrypted_identity_key: user.encrypted_identity_key,
        encrypted_identity_iv: user.encrypted_identity_iv,
        encrypted_transport_key: user.encrypted_transport_key,
        encrypted_transport_iv: user.encrypted_transport_iv,
        kdf_salt: user.kdf_salt,
        kdf_iterations: user.kdf_iterations,
        public_identity_key: user.public_identity_key,
        public_transport_key: user.public_transport_key,
      },
    });
  });

  router.post("/password/login/recovery", async (req: Request, res: Response) => {
    if (!PASSWORD_2FA_ENABLED) {
      return res.status(403).json({ error: "Password authentication is disabled" });
    }

    const parsed = recoveryCodeVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { session_ticket, recovery_code } = parsed.data;

    cleanupSessions(Date.now());

    const ticket = totpSessionTickets.get(session_ticket);
    if (!ticket) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }

    if (ticket.expiresAt <= Date.now()) {
      totpSessionTickets.delete(session_ticket);
      return res.status(401).json({ error: "Session expired" });
    }

    // Check IP address
    const currentIp = req.ip ?? "";
    if (ticket.ipAddress !== currentIp) {
      totpSessionTickets.delete(session_ticket);
      return res.status(401).json({ error: "Session invalid" });
    }

    // Validate recovery code format
    if (!isValidRecoveryCodeFormat(recovery_code)) {
      ticket.attempts++;
      if (ticket.attempts >= TOTP_MAX_ATTEMPTS) {
        totpSessionTickets.delete(session_ticket);
        return res.status(429).json({ error: "Too many attempts" });
      }
      return res.status(401).json({ error: "Invalid recovery code format" });
    }

    const codeHash = hashRecoveryCode(recovery_code);

    // Find and verify recovery code
    const recoveryCodeRecord = await prisma.totpRecoveryCode.findFirst({
      where: {
        user_id: ticket.userId,
        code_hash: codeHash,
        used_at: null,
      },
    });

    if (!recoveryCodeRecord) {
      ticket.attempts++;
      if (ticket.attempts >= TOTP_MAX_ATTEMPTS) {
        totpSessionTickets.delete(session_ticket);
        return res.status(429).json({ error: "Too many attempts" });
      }
      return res.status(401).json({ error: "Invalid recovery code" });
    }

    // Mark recovery code as used
    await prisma.totpRecoveryCode.update({
      where: { id: recoveryCodeRecord.id },
      data: { used_at: new Date() },
    });

    // Mark ticket as used
    totpSessionTickets.delete(session_ticket);

    // Get user data
    const user = await prisma.user.findUnique({
      where: { id: ticket.userId },
      select: {
        id: true,
        username: true,
        kdf_salt: true,
        kdf_iterations: true,
        public_identity_key: true,
        public_transport_key: true,
        encrypted_identity_key: true,
        encrypted_identity_iv: true,
        encrypted_transport_key: true,
        encrypted_transport_iv: true,
      },
    });

    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    // Create session
    const token = jwt.sign(
      { sub: user.id, username: user.username },
      getJwtSecret(),
      { expiresIn: "30d" }
    );
    const tokenHash = hashToken(token);
    const sessionExpiresAt = new Date();
    sessionExpiresAt.setDate(sessionExpiresAt.getDate() + SESSION_EXPIRY_DAYS);

    await prisma.session.create({
      data: {
        user_id: user.id,
        token_hash: tokenHash,
        device_info: req.get("user-agent") ?? null,
        ip_address: req.ip ?? null,
        expires_at: sessionExpiresAt,
      },
    });

    // Count remaining recovery codes
    const remainingCodes = await prisma.totpRecoveryCode.count({
      where: {
        user_id: user.id,
        used_at: null,
      },
    });

    return res.json({
      token,
      keys: {
        encrypted_identity_key: user.encrypted_identity_key,
        encrypted_identity_iv: user.encrypted_identity_iv,
        encrypted_transport_key: user.encrypted_transport_key,
        encrypted_transport_iv: user.encrypted_transport_iv,
        kdf_salt: user.kdf_salt,
        kdf_iterations: user.kdf_iterations,
        public_identity_key: user.public_identity_key,
        public_transport_key: user.public_transport_key,
      },
      remaining_recovery_codes: remainingCodes,
    });
  });

  // ============== TOTP MANAGEMENT (authenticated) ==============

  // Regenerate recovery codes
  router.post("/totp/recovery-codes/regenerate", authenticateToken, async (req: Request, res: Response) => {
    if (!PASSWORD_2FA_ENABLED) {
      return res.status(403).json({ error: "Password authentication is disabled" });
    }

    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { totp_enabled: true },
      });

      if (!user || !user.totp_enabled) {
        return res.status(400).json({ error: "2FA not enabled" });
      }

      // Delete existing recovery codes
      await prisma.totpRecoveryCode.deleteMany({
        where: { user_id: req.user.id },
      });

      // Generate new recovery codes
      const recoveryCodes = generateRecoveryCodes();
      const recoveryCodeHashes = recoveryCodes.map(hashRecoveryCode);

      await prisma.totpRecoveryCode.createMany({
        data: recoveryCodeHashes.map((code_hash) => ({
          user_id: req.user!.id,
          code_hash,
        })),
      });

      return res.json({ recovery_codes: recoveryCodes });
    } catch (error) {
      console.error("Error regenerating recovery codes:", error);
      return res.status(500).json({ error: "Failed to regenerate recovery codes" });
    }
  });

  // Add password + 2FA to a passkey-only account
  router.post("/password-2fa/add", authenticateToken, async (req: Request, res: Response) => {
    if (!PASSWORD_2FA_ENABLED) {
      return res.status(403).json({ error: "Password authentication is disabled" });
    }

    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parsed = password2faAddSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const { opaque_request, opaque_finish, totp_secret, encrypted_totp_secret, encrypted_totp_secret_iv, totp_code } = parsed.data;

    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: {
          id: true,
          username: true,
          totp_enabled: true,
          opaque_password_file: true,
          passkeys: { select: { id: true } },
        },
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      if (user.totp_enabled && user.opaque_password_file) {
        return res.status(400).json({ error: "Password + 2FA already enabled" });
      }

      // Verify TOTP code
      if (!verifyTotpCode(totp_secret, totp_code)) {
        return res.status(400).json({ error: "Invalid TOTP code" });
      }

      // Process OPAQUE registration for password
      let opaqueResponseState: { response: Uint8Array; state: ServerRegistrationState };
      try {
        opaqueResponseState = await registerResponse(
          user.username,
          Buffer.from(opaque_request, "base64")
        );
      } catch {
        return res.status(400).json({ error: "Invalid OPAQUE parameters" });
      }

      let passwordFile: Uint8Array;
      try {
        passwordFile = registerFinish(
          opaqueResponseState.state,
          Buffer.from(opaque_finish, "base64")
        );
      } catch {
        return res.status(400).json({ error: "Invalid OPAQUE payload" });
      }

      // Generate recovery codes
      const recoveryCodes = generateRecoveryCodes();
      const recoveryCodeHashes = recoveryCodes.map(hashRecoveryCode);

      // Update user and create recovery codes
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: {
            opaque_password_file: Buffer.from(passwordFile),
            totp_enabled: true,
            totp_secret,
            encrypted_totp_secret,
            encrypted_totp_secret_iv,
            totp_verified_at: new Date(),
          },
        });

        await tx.totpRecoveryCode.createMany({
          data: recoveryCodeHashes.map((code_hash) => ({
            user_id: user.id,
            code_hash,
          })),
        });
      });

      return res.json({ recovery_codes: recoveryCodes });
    } catch (error) {
      console.error("Error adding password + 2FA:", error);
      return res.status(500).json({ error: "Failed to add password + 2FA" });
    }
  });

  // Remove password + 2FA (requires at least one passkey)
  router.delete("/password-2fa", authenticateToken, async (req: Request, res: Response) => {
    if (!PASSWORD_2FA_ENABLED) {
      return res.status(403).json({ error: "Password authentication is disabled" });
    }

    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: {
          id: true,
          totp_enabled: true,
          passkeys: { select: { id: true } },
        },
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      if (!user.totp_enabled) {
        return res.status(400).json({ error: "Password + 2FA not enabled" });
      }

      if (user.passkeys.length === 0) {
        return res.status(400).json({ error: "Cannot remove password login - you need at least one passkey" });
      }

      // Remove password + 2FA
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: {
            opaque_password_file: null,
            totp_enabled: false,
            totp_secret: null,
            encrypted_totp_secret: null,
            encrypted_totp_secret_iv: null,
            totp_verified_at: null,
          },
        });

        // Delete recovery codes
        await tx.totpRecoveryCode.deleteMany({
          where: { user_id: user.id },
        });
      });

      return res.json({ ok: true });
    } catch (error) {
      console.error("Error removing password + 2FA:", error);
      return res.status(500).json({ error: "Failed to remove password + 2FA" });
    }
  });

  // ============== CHANGE ACCOUNT PASSWORD ==============

  const passwordChangeStartSchema = z.object({
    opaque_request: z.string().min(1), // Current password OPAQUE login request
  });

  const passwordChangeVerifySchema = z.object({
    opaque_finish: z.string().min(1), // Current password OPAQUE login finish
  });

  const passwordChangeNewStartSchema = z.object({
    change_ticket: z.string().min(1),
    opaque_request: z.string().min(1), // New password OPAQUE registration request
  });

  const passwordChangeCompleteSchema = z.object({
    change_ticket: z.string().min(1),
    opaque_finish: z.string().min(1), // New password OPAQUE registration finish
  });

  type PasswordChangeSession = {
    userId: string;
    username: string;
    stage: "verify" | "register";
    opaqueState?: ServerLoginState;
    expiresAt: number;
  };

  const passwordChangeSessions = new Map<string, PasswordChangeSession>();
  const PASSWORD_CHANGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // Start password change - verify current password
  router.post("/password/change/start", authenticateToken, async (req: Request, res: Response) => {
    if (!PASSWORD_2FA_ENABLED) {
      return res.status(403).json({ error: "Password authentication is disabled" });
    }

    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parsed = passwordChangeStartSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { opaque_request } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        username: true,
        opaque_password_file: true,
        totp_enabled: true,
      },
    });

    if (!user || !user.opaque_password_file || !user.totp_enabled) {
      return res.status(400).json({ error: "Password + 2FA not enabled" });
    }

    try {
      const opaqueResponseState = await loginResponse(
        user.username,
        new Uint8Array(user.opaque_password_file),
        Buffer.from(opaque_request, "base64")
      );

      const changeTicket = uuidv4();
      passwordChangeSessions.set(changeTicket, {
        userId: user.id,
        username: user.username,
        stage: "verify",
        opaqueState: opaqueResponseState.state,
        expiresAt: Date.now() + PASSWORD_CHANGE_TTL_MS,
      });

      return res.json({
        opaque_response: Buffer.from(opaqueResponseState.response).toString("base64"),
        change_ticket: changeTicket,
      });
    } catch (error) {
      console.error("Error starting password change:", error);
      return res.status(400).json({ error: "Invalid credentials" });
    }
  });

  // Verify current password
  router.post("/password/change/verify", authenticateToken, async (req: Request, res: Response) => {
    if (!PASSWORD_2FA_ENABLED) {
      return res.status(403).json({ error: "Password authentication is disabled" });
    }

    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parsed = passwordChangeVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { opaque_finish } = parsed.data;

    const changeTicket = req.headers["x-change-ticket"] as string;
    if (!changeTicket) {
      return res.status(400).json({ error: "Missing change ticket" });
    }

    const session = passwordChangeSessions.get(changeTicket);
    if (!session || session.expiresAt <= Date.now() || session.stage !== "verify") {
      passwordChangeSessions.delete(changeTicket);
      return res.status(400).json({ error: "Invalid or expired session" });
    }

    if (session.userId !== req.user.id) {
      passwordChangeSessions.delete(changeTicket);
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!session.opaqueState) {
      passwordChangeSessions.delete(changeTicket);
      return res.status(400).json({ error: "Invalid session state" });
    }

    try {
      await loginFinish(session.opaqueState, Buffer.from(opaque_finish, "base64"));

      // Update session to registration stage
      session.stage = "register";
      session.opaqueState = undefined;
      session.expiresAt = Date.now() + PASSWORD_CHANGE_TTL_MS;

      return res.json({ ok: true });
    } catch (error) {
      console.error("Error verifying current password:", error);
      passwordChangeSessions.delete(changeTicket);
      return res.status(401).json({ error: "Invalid credentials" });
    }
  });

  // Start new password registration
  router.post("/password/change/new/start", authenticateToken, async (req: Request, res: Response) => {
    if (!PASSWORD_2FA_ENABLED) {
      return res.status(403).json({ error: "Password authentication is disabled" });
    }

    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parsed = passwordChangeNewStartSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { change_ticket, opaque_request } = parsed.data;

    const session = passwordChangeSessions.get(change_ticket);
    if (!session || session.expiresAt <= Date.now() || session.stage !== "register") {
      passwordChangeSessions.delete(change_ticket);
      return res.status(400).json({ error: "Invalid or expired session" });
    }

    if (session.userId !== req.user.id) {
      passwordChangeSessions.delete(change_ticket);
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      const opaqueResponseState = await registerResponse(
        session.username,
        Buffer.from(opaque_request, "base64")
      );

      return res.json({
        opaque_response: Buffer.from(opaqueResponseState.response).toString("base64"),
      });
    } catch (error) {
      console.error("Error starting new password registration:", error);
      return res.status(400).json({ error: "Invalid request" });
    }
  });

  // Complete password change
  router.post("/password/change/complete", authenticateToken, async (req: Request, res: Response) => {
    if (!PASSWORD_2FA_ENABLED) {
      return res.status(403).json({ error: "Password authentication is disabled" });
    }

    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parsed = passwordChangeCompleteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { change_ticket, opaque_finish } = parsed.data;

    const session = passwordChangeSessions.get(change_ticket);
    if (!session || session.expiresAt <= Date.now() || session.stage !== "register") {
      passwordChangeSessions.delete(change_ticket);
      return res.status(400).json({ error: "Invalid or expired session" });
    }

    if (session.userId !== req.user.id) {
      passwordChangeSessions.delete(change_ticket);
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      const newPasswordFile = registerFinish(null, Buffer.from(opaque_finish, "base64"));

      await prisma.user.update({
        where: { id: req.user.id },
        data: {
          opaque_password_file: Buffer.from(newPasswordFile),
        },
      });

      passwordChangeSessions.delete(change_ticket);

      return res.json({ ok: true });
    } catch (error) {
      console.error("Error completing password change:", error);
      return res.status(500).json({ error: "Failed to change password" });
    }
  });

  // Regenerate TOTP secret (change authenticator app)
  router.post("/totp/regenerate", authenticateToken, async (req: Request, res: Response) => {
    if (!PASSWORD_2FA_ENABLED) {
      return res.status(403).json({ error: "Password authentication is disabled" });
    }

    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const parsed = totpRegenerateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const { totp_secret: new_totp_secret, encrypted_totp_secret, encrypted_totp_secret_iv, totp_code } = parsed.data;

    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: {
          id: true,
          totp_enabled: true,
          opaque_password_file: true,
        },
      });

      if (!user || !user.totp_enabled || !user.opaque_password_file) {
        return res.status(400).json({ error: "Password + 2FA not enabled" });
      }

      // Verify new TOTP code
      if (!verifyTotpCode(new_totp_secret, totp_code)) {
        return res.status(400).json({ error: "Invalid TOTP code" });
      }

      // Delete existing recovery codes and generate new ones
      const recoveryCodes = generateRecoveryCodes();
      const recoveryCodeHashes = recoveryCodes.map(hashRecoveryCode);

      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: {
            totp_secret: new_totp_secret,
            encrypted_totp_secret,
            encrypted_totp_secret_iv,
            totp_verified_at: new Date(),
          },
        });

        await tx.totpRecoveryCode.deleteMany({
          where: { user_id: user.id },
        });

        await tx.totpRecoveryCode.createMany({
          data: recoveryCodeHashes.map((code_hash) => ({
            user_id: user.id,
            code_hash,
          })),
        });
      });

      return res.json({ recovery_codes: recoveryCodes });
    } catch (error) {
      console.error("Error regenerating TOTP:", error);
      return res.status(500).json({ error: "Failed to regenerate TOTP" });
    }
  });

  return router;
};
