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

const opaqueRegistrationSessions = new Map<string, OpaqueRegistrationSession>();
const opaqueLoginSessions = new Map<string, OpaqueLoginSession>();
const loginBackoff = new Map<string, BackoffEntry>();

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

  return router;
};
