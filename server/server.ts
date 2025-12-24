import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import { createServer as createHttpServer } from "http";
import { createServer as createHttpsServer } from "https";
import { Server as SocketIOServer } from "socket.io";

import { createAuthRouter } from "./routes/auth";
import { createDirectoryRouter } from "./routes/directory";
import { createMessagesRouter } from "./routes/messages";
import { getJwtSecret, type AuthenticatedUser } from "./middleware/auth";
import {
  getFederationDiscoveryDocument,
  getFederationIdentity,
  getFederationTlsConfig,
  getServerHost,
} from "./lib/federationAuth";
import jwt from "jsonwebtoken";

const app = express();
const prisma = new PrismaClient();
const federationTlsConfig = getFederationTlsConfig();
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

io.use((socket, next) => {
  const rawToken = socket.handshake.auth?.token ?? socket.handshake.query?.token;
  const tokenValue = Array.isArray(rawToken) ? rawToken[0] : rawToken;
  if (!tokenValue || typeof tokenValue !== "string") {
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
    const username =
      typeof payload.username === "string" ? payload.username : "";
    socket.data.user = { id: payload.sub, username } as AuthenticatedUser;
    return next();
  } catch (error) {
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

  socket.on("disconnect", () => {
    // Cleanup if needed
  });
});

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none';");
  if ((process.env.NODE_ENV ?? "development") === "production") {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload"
    );
  }
  next();
});

app.use(
  cors({
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
  })
);
app.use(express.json({ limit: "2mb" }));

app.get("/.well-known/ratchet-chat/federation.json", (req, res) => {
  const doc = getFederationDiscoveryDocument();
  res.json(doc);
});

app.use("/auth", createAuthRouter(prisma));
app.use("/directory", createDirectoryRouter(prisma));
app.use("/api/directory", createDirectoryRouter(prisma));
app.use("/", createMessagesRouter(prisma, io));

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
