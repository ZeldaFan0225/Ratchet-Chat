import type { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";

import { getJwtSecret, authenticateToken } from "../middleware/auth";
import { createRateLimiter } from "../middleware/rateLimit";
import { computeServerSession, generateServerEphemeral, srp } from "../lib/srp";

const KDF_ITERATIONS_MIN = Number(process.env.KDF_ITERATIONS_MIN ?? 300000);
const KDF_ITERATIONS_MAX = Number(process.env.KDF_ITERATIONS_MAX ?? 1000000);
const SRP_SESSION_TTL_MS = Number(process.env.SRP_SESSION_TTL_MS ?? 5 * 60 * 1000);
const LOGIN_BACKOFF_BASE_MS = Number(
  process.env.LOGIN_BACKOFF_BASE_MS ?? 1000
);
const LOGIN_BACKOFF_MAX_MS = Number(
  process.env.LOGIN_BACKOFF_MAX_MS ?? 10 * 60 * 1000
);

const updateSettingsSchema = z.object({
  showTypingIndicator: z.boolean().optional(),
  sendReadReceipts: z.boolean().optional(),
});

const registerSchema = z.object({
  username: z.string().min(3).max(64),
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
  srp_salt: z.string().min(1),
  srp_verifier: z.string().min(1),
});

const srpStartSchema = z.object({
  username: z.string().min(3).max(64),
  A: z.string().min(1),
});

const srpVerifySchema = z.object({
  username: z.string().min(3).max(64),
  A: z.string().min(1),
  M1: z.string().min(1),
});

type SrpSession = {
  username: string;
  A: string;
  b: bigint;
  BBytes: Buffer;
  verifier: string;
  expiresAt: number;
};

type BackoffEntry = {
  failures: number;
  blockedUntil: number;
};

const srpSessions = new Map<string, SrpSession>();
const loginBackoff = new Map<string, BackoffEntry>();

const sessionKey = (username: string, A: string) => `${username}:${A}`;

const cleanupSessions = (now: number) => {
  for (const [key, session] of srpSessions) {
    if (session.expiresAt <= now) {
      srpSessions.delete(key);
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

export const createAuthRouter = (prisma: PrismaClient) => {
  const router = Router();
  const authLimiter = createRateLimiter({
    windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS ?? 60000),
    max: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 20),
    keyPrefix: "auth",
  });

  router.use(authLimiter);

  router.get("/settings", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { show_typing_indicator: true, send_read_receipts: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json({
      showTypingIndicator: user.show_typing_indicator,
      sendReadReceipts: user.send_read_receipts,
    });
  });

  router.patch("/settings", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const parsed = updateSettingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid request" });
    
    const { showTypingIndicator, sendReadReceipts } = parsed.data;
    const data: any = {};
    if (showTypingIndicator !== undefined) data.show_typing_indicator = showTypingIndicator;
    if (sendReadReceipts !== undefined) data.send_read_receipts = sendReadReceipts;
    
    if (Object.keys(data).length === 0) return res.json({});

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: { show_typing_indicator: true, send_read_receipts: true },
    });
    
    return res.json({
      showTypingIndicator: user.show_typing_indicator,
      sendReadReceipts: user.send_read_receipts,
    });
  });

  router.delete("/account", authenticateToken, async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const existing = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ error: "User not found" });

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

  router.post("/register", async (req: Request, res: Response) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const {
      username,
      kdf_salt,
      kdf_iterations,
      public_identity_key,
      public_transport_key,
      encrypted_identity_key,
      encrypted_identity_iv,
      encrypted_transport_key,
      encrypted_transport_iv,
      srp_salt,
      srp_verifier,
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
        srp_salt,
        srp_verifier,
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

  router.post("/login", async (_req: Request, res: Response) => {
    return res.status(410).json({ error: "Use SRP login endpoints" });
  });

  router.post("/srp/start", async (req: Request, res: Response) => {
    const parsed = srpStartSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { username, A } = parsed.data;
    if (username.includes("@")) {
      return res.status(400).json({ error: "Username must be local" });
    }
    const backoffKey = getBackoffKey(req, username);
    const blocked = isBlocked(backoffKey);
    if (blocked.blocked) {
      res.setHeader("Retry-After", blocked.retryAfter.toString());
      return res.status(429).json({ error: "Retry later" });
    }

    let AInt: bigint;
    try {
      AInt = srp.toBigInt(Buffer.from(A, "base64"));
    } catch {
      recordFailure(backoffKey);
      return res.status(400).json({ error: "Invalid SRP parameters" });
    }
    if (AInt % srp.N === 0n) {
      recordFailure(backoffKey);
      return res.status(400).json({ error: "Invalid SRP parameters" });
    }

    const user = await prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        srp_salt: true,
        srp_verifier: true,
      },
    });
    if (!user?.srp_salt || !user.srp_verifier) {
      recordFailure(backoffKey);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    cleanupSessions(Date.now());
    const { b, B, BBytes } = generateServerEphemeral(user.srp_verifier);
    const expiresAt = Date.now() + SRP_SESSION_TTL_MS;
    srpSessions.set(sessionKey(username, A), {
      username,
      A,
      b,
      BBytes,
      verifier: user.srp_verifier,
      expiresAt,
    });

    return res.json({
      salt: user.srp_salt,
      B,
    });
  });

  router.post("/srp/verify", async (req: Request, res: Response) => {
    const parsed = srpVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }
    const { username, A, M1 } = parsed.data;
    if (username.includes("@")) {
      return res.status(400).json({ error: "Username must be local" });
    }
    const backoffKey = getBackoffKey(req, username);
    const blocked = isBlocked(backoffKey);
    if (blocked.blocked) {
      res.setHeader("Retry-After", blocked.retryAfter.toString());
      return res.status(429).json({ error: "Retry later" });
    }

    const key = sessionKey(username, A);
    const session = srpSessions.get(key);
    if (!session || session.expiresAt <= Date.now()) {
      recordFailure(backoffKey);
      srpSessions.delete(key);
      return res.status(400).json({ error: "SRP session expired" });
    }

    const serverSession = computeServerSession(
      A,
      session.BBytes,
      session.b,
      session.verifier
    );
    if (!serverSession) {
      recordFailure(backoffKey);
      srpSessions.delete(key);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (serverSession.M1 !== M1) {
      recordFailure(backoffKey);
      srpSessions.delete(key);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    srpSessions.delete(key);
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
        { expiresIn: "12h" },
      );
    } catch (error) {
      return res.status(500).json({ error: "Server misconfigured" });
    }

    return res.json({
      token,
      M2: serverSession.M2,
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

  return router;
};
