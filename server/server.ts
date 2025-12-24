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
import { getFederationIdentity, getFederationTlsConfig } from "./lib/federationAuth";
import jwt from "jsonwebtoken";

const app = express();
const prisma = new PrismaClient();
const federationTlsConfig = getFederationTlsConfig();
// Ensure federation keys are generated and persisted on boot.
void getFederationIdentity();
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
    origin: true,
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
});

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json({ limit: "2mb" }));

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
