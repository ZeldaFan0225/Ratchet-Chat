import type { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";

import { getJwtSecret } from "../middleware/auth";

const registerSchema = z.object({
  username: z.string().min(3).max(64),
  auth_hash: z.string().min(1),
  auth_salt: z.string().min(1),
  auth_iterations: z.number().int().positive(),
  kdf_salt: z.string().min(1),
  kdf_iterations: z.number().int().positive(),
  public_identity_key: z.string().min(1),
  public_transport_key: z.string().min(1),
  encrypted_identity_key: z.string().min(1),
  encrypted_identity_iv: z.string().min(1),
  encrypted_transport_key: z.string().min(1),
  encrypted_transport_iv: z.string().min(1),
});

const loginSchema = z.object({
  username: z.string().min(3).max(64),
  auth_hash: z.string().min(1),
});

export const createAuthRouter = (prisma: PrismaClient) => {
  const router = Router();

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
        auth_salt: true,
        auth_iterations: true,
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
      auth_hash,
      auth_salt,
      auth_iterations,
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

    const user = await prisma.user.create({
      data: {
        username,
        auth_hash,
        auth_salt,
        auth_iterations,
        kdf_salt,
        kdf_iterations,
        public_identity_key,
        public_transport_key,
        encrypted_identity_key,
        encrypted_identity_iv,
        encrypted_transport_key,
        encrypted_transport_iv,
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

  router.post("/login", async (req: Request, res: Response) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const { username, auth_hash } = parsed.data;
    if (username.includes("@")) {
      return res.status(400).json({ error: "Username must be local" });
    }
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (user.auth_hash !== auth_hash) {
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
