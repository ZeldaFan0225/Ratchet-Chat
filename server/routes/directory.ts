import type { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import { Router } from "express";

import {
  buildHandle,
  getInstanceHost,
  parseHandle,
} from "../lib/handles";
import {
  federationRequestJson,
  resolveFederationProtocol,
  isFederationHostAllowed,
  resolveFederationEndpoint,
} from "../lib/federationAuth";
import { serverLogger } from "../lib/logger";

export const createDirectoryRouter = (prisma: PrismaClient) => {
  const router = Router();

  const instanceHost = getInstanceHost();
  const federationDirectoryPath =
    process.env.FEDERATION_DIRECTORY_PATH ?? "/directory";

  const handleDirectoryRequest = async (handle: string, res: Response) => {
    if (!handle) {
      return res.status(400).json({ error: "Invalid request" });
    }

    let parsed;
    try {
      parsed = parseHandle(handle, instanceHost);
    } catch {
      return res.status(400).json({ error: "Invalid handle" });
    }

    if (parsed.isLocal) {
      const user = await prisma.user.findUnique({
        where: { username: parsed.username },
        select: {
          id: true,
          public_identity_key: true,
          public_transport_key: true,
          display_name: true,
          display_name_visibility: true,
          avatar_filename: true,
          avatar_visibility: true,
        },
      });

      if (!user) {
        return res.status(404).json({ error: "Not found" });
      }

      serverLogger.info("directory.lookup.local", {
        handle: buildHandle(parsed.username, instanceHost),
        user_id: user.id,
      });

      return res.json({
        id: user.id,
        handle: buildHandle(parsed.username, instanceHost),
        host: instanceHost,
        public_identity_key: user.public_identity_key,
        public_transport_key: user.public_transport_key,
        display_name:
          user.display_name_visibility === "public" ? user.display_name : null,
        avatar_filename: user.avatar_visibility === "public" ? user.avatar_filename : null,
      });
    }

    if (!(await isFederationHostAllowed(parsed.host))) {
      return res.status(400).json({ error: "Invalid host" });
    }

    const resolvedDirectory =
      (await resolveFederationEndpoint(parsed.host, "directory")) ??
      (() => {
        const normalizedPath = federationDirectoryPath.replace(/\/$/, "");
        const protocol = resolveFederationProtocol(parsed.host);
        return `${protocol}://${parsed.host}${normalizedPath}`;
      })();
    const remoteUrl = `${resolvedDirectory.replace(/\/$/, "")}/${encodeURIComponent(
      parsed.username
    )}`;
    serverLogger.info("directory.lookup.remote", {
      handle: buildHandle(parsed.username, parsed.host),
      remote_url: remoteUrl,
    });
    try {
      const response = await federationRequestJson(remoteUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      serverLogger.info("directory.lookup.response", {
        remote_url: remoteUrl,
        ok: response.ok,
        status: response.status,
      });
      if (!response.ok) {
        const status = response.error ? 503 : response.status;
        return res
          .status(status)
          .json({ error: response.error ?? "Not found" });
      }
      const data = response.json as Record<string, unknown> | undefined;
      return res.json({
        id: data?.id ?? null,
        handle: buildHandle(parsed.username, parsed.host),
        host: parsed.host,
        public_identity_key: data?.public_identity_key,
        public_transport_key: data?.public_transport_key,
        display_name: data?.display_name ?? null,
        avatar_filename: data?.avatar_filename ?? null,
      });
    } catch (error) {
      return res.status(502).json({ error: "Unable to reach host" });
    }
  };

  router.get("/:handle", async (req: Request, res: Response) => {
    const { handle } = req.params;
    return handleDirectoryRequest(handle, res);
  });

  router.get("/", async (req: Request, res: Response) => {
    const handle = typeof req.query.handle === "string" ? req.query.handle : "";
    return handleDirectoryRequest(handle, res);
  });

  return router;
};
