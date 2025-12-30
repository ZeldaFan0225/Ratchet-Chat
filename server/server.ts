import express, { type Request } from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import { createServer as createHttpServer } from "http";
import { createServer as createHttpsServer } from "https";
import { Server as SocketIOServer } from "socket.io";
import path from "path";
import fs from "fs";

import { createAuthRouter } from "./routes/auth";
import { createDirectoryRouter } from "./routes/directory";
import { createMessagesRouter } from "./routes/messages";
import { getJwtSecret, hashToken, type AuthenticatedUser } from "./middleware/auth";
import {
  getFederationDiscoveryDocument,
  getFederationIdentity,
  getFederationTlsConfig,
  getServerHost,
} from "./lib/federationAuth";
import { startSessionCleanup } from "./lib/sessionCleanup";
import { getGitCommit } from "./lib/version";
import jwt from "jsonwebtoken";

const app = express();
const prisma = new PrismaClient();
const federationTlsConfig = getFederationTlsConfig();
const serverCommit =
  process.env.SERVER_COMMIT_SHA ??
  process.env.GIT_COMMIT_SHA ??
  process.env.RENDER_GIT_COMMIT ??
  getGitCommit(process.cwd()) ??
  "unknown";
// Ensure federation keys are generated and persisted on boot.
void getFederationIdentity();
app.disable("x-powered-by");
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1));
const rawCorsOrigins =
  process.env.CORS_ALLOWED_ORIGINS ??
  process.env.CLIENT_ORIGIN ??
  process.env.NEXT_PUBLIC_APP_URL ??
  "";
const corsOrigins = new Set(
  rawCorsOrigins
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try {
        return new URL(entry).origin;
      } catch {
        return entry;
      }
    })
);
const allowAnyCorsOrigin =
  corsOrigins.size === 0 && (process.env.NODE_ENV ?? "development") !== "production";
const shouldBypassCors = (req: Request) => {
  const path = req.path;
  return (
    path.startsWith("/api/federation/") ||
    path.startsWith("/federation/") ||
    path.startsWith("/directory") ||
    path === "/.well-known/ratchet-chat/federation.json"
  );
};
const server = federationTlsConfig
  ? createHttpsServer(
      {
        key: federationTlsConfig.key,
        cert: federationTlsConfig.cert,
        ca: federationTlsConfig.ca,
        requestCert: true,
        rejectUnauthorized: false,
      },
      app,
    )
  : createHttpServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: allowAnyCorsOrigin ? true : Array.from(corsOrigins),
    credentials: true,
  },
});

const SESSION_EXPIRY_DAYS = 7;

io.use(async (socket, next) => {
  const rawToken = socket.handshake.auth?.token ?? socket.handshake.query?.token;
  const tokenValue = Array.isArray(rawToken) ? rawToken[0] : rawToken;
  if (!tokenValue || typeof tokenValue !== "string") {
    console.log(`[SocketIO] Auth failed: no token`, { socketId: socket.id });
    return next(new Error("Unauthorized"));
  }
  const token = tokenValue.startsWith("Bearer ")
    ? tokenValue.slice("Bearer ".length)
    : tokenValue;
  try {
    const secret = getJwtSecret();
    const payload = jwt.verify(token, secret) as jwt.JwtPayload;
    if (!payload.sub || typeof payload.sub !== "string") {
      return next(new Error("Unauthorized"));
    }

    // Validate session exists in database
    const tokenHash = hashToken(token);
    const session = await prisma.session.findUnique({
      where: { token_hash: tokenHash },
      select: { id: true, expires_at: true },
    });

    if (!session) {
      console.log(`[SocketIO] Auth failed: session not found`, { socketId: socket.id });
      return next(new Error("Session invalidated"));
    }

    if (session.expires_at < new Date()) {
      // Clean up expired session
      console.log(`[SocketIO] Auth failed: session expired`, { socketId: socket.id });
      await prisma.session.delete({ where: { id: session.id } });
      return next(new Error("Session expired"));
    }

    // Refresh session expiry on WebSocket connect (rolling 7-day expiry)
    const newExpiresAt = new Date(Date.now() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await prisma.session.update({
      where: { id: session.id },
      data: {
        last_active_at: new Date(),
        expires_at: newExpiresAt,
      },
    });

    const username =
      typeof payload.username === "string" ? payload.username : "";
    socket.data.user = { id: payload.sub, username } as AuthenticatedUser;
    socket.data.sessionId = session.id;
    socket.data.tokenHash = tokenHash;
    return next();
  } catch (error) {
    console.error(`[SocketIO] Auth error`, { socketId: socket.id, error: String(error) });
    return next(new Error("Unauthorized"));
  }
});

io.on("connection", (socket) => {
  const user = socket.data.user as AuthenticatedUser | undefined;
  if (!user?.id) {
    socket.disconnect(true);
    return;
  }
  socket.join(user.id);

  socket.on("signal", async (data) => {
    const user = socket.data.user as AuthenticatedUser | undefined;
    if (!user?.id) return;

    try {
      if (
        !data ||
        typeof data !== "object" ||
        typeof data.recipient_handle !== "string" ||
        typeof data.encrypted_blob !== "string"
      ) {
        return;
      }

      const { recipient_handle, encrypted_blob } = data;
      // Simple parsing - in a real app use the handle library
      // We assume local handles for socket optimization first
      // or we accept full handles but only relay to local user IDs.
      const parts = recipient_handle.split("@");
      const username = parts[0];

      // Optimistic relay: find connected user by username lookup?
      // Better: DB lookup to get ID (sockets are joined by User ID)
      const recipient = await prisma.user.findUnique({
        where: { username },
        select: { id: true },
      });

      if (recipient) {
        io.to(recipient.id).emit("signal", {
          sender_handle: `${user.username}@${getServerHost()}`,
          encrypted_blob,
        });
      }
    } catch (error) {
      // Ignore signal errors
    }
  });

  socket.on("CALL_SESSION_UPDATE", (data) => {
    const user = socket.data.user as AuthenticatedUser | undefined;
    if (!user?.id) return;
    if (!data || typeof data !== "object") return;

    const status = (data as { status?: string }).status;
    if (status !== "active" && status !== "idle") return;

    io.to(user.id).emit("CALL_SESSION_UPDATE", {
      status,
      call_id: (data as { call_id?: string | null }).call_id ?? null,
      peer_handle: (data as { peer_handle?: string | null }).peer_handle ?? null,
      origin: socket.id,
    });
  });

  socket.on("CALL_SESSION_CLAIMED", (data) => {
    const user = socket.data.user as AuthenticatedUser | undefined;
    if (!user?.id) return;
    if (!data || typeof data !== "object") return;

    const action = (data as { action?: string }).action;
    if (action !== "accepted" && action !== "declined") return;

    io.to(user.id).emit("CALL_SESSION_CLAIMED", {
      action,
      call_id: (data as { call_id?: string | null }).call_id ?? null,
      peer_handle: (data as { peer_handle?: string | null }).peer_handle ?? null,
      origin: socket.id,
    });
  });

  socket.on("error", (error) => {
    console.error(`[SocketIO] Socket error`, { userId: user.id, socketId: socket.id, error: String(error) });
  });
});

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none';");
  if ((process.env.NODE_ENV ?? "development") === "production") {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload"
    );
  }
  next();
});

const corsMiddleware = cors({
  origin: (origin, callback) => {
    if (!origin || allowAnyCorsOrigin) {
      return callback(null, true);
    }
    if (corsOrigins.has(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
});

// Permissive CORS for federation/directory endpoints (any origin can query)
const federationCorsMiddleware = cors({
  origin: true,
  credentials: false,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

app.use((req, res, next) => {
  if (shouldBypassCors(req)) {
    // Federation endpoints need CORS headers but allow any origin
    return federationCorsMiddleware(req, res, next);
  }
  return corsMiddleware(req, res, next);
});
app.use(express.json({ limit: "20mb" }));

const AVATAR_DIR = path.join(process.cwd(), "uploads", "avatars");
if (!fs.existsSync(AVATAR_DIR)) {
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
}
app.use("/uploads/avatars", express.static(AVATAR_DIR));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    commit: serverCommit,
    timestamp: new Date().toISOString(),
  });
});

app.get("/.well-known/ratchet-chat/federation.json", (req, res) => {
  const doc = getFederationDiscoveryDocument();
  res.json(doc);
});

app.use("/auth", createAuthRouter(prisma, io));
app.use("/directory", createDirectoryRouter(prisma));
app.use("/api/directory", createDirectoryRouter(prisma));
app.use("/", createMessagesRouter(prisma, io));

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  startSessionCleanup(prisma);
});
