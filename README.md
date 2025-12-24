# Ratchet-Chat Monorepo

Ratchet-Chat is a federated, end-to-end encrypted messaging app with separate
client (Next.js) and server (Express + Prisma) applications.

## Repo Layout

- `client/`: Next.js app (UI + client-side crypto)
- `server/`: Express API + federation + Prisma (Postgres)
- `docker-compose.prod.yml`: production-ready compose setup

## Requirements

- Node.js 22
- Postgres (local dev) or Docker for the production compose stack

## Local Development

Server:
```bash
cd server
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

Client:
```bash
cd client
cp .env.example .env
npm install
npm run dev
```

## Production (Docker)

```bash
cp .env.example .env
docker compose -f docker-compose.prod.yml up --build -d
```

### Production Requirements

- DNS: only the client and server subdomain records (A/AAAA) are required.
- TLS termination: use a reverse proxy (nginx, caddy, etc.) for HTTPS.
- Environment variables (set in `.env` for compose):
  - `SERVER_HOST` (e.g. `ratchet.example.com`)
  - `NEXT_PUBLIC_API_URL` (e.g. `https://ratchet.example.com`)
  - `NEXT_PUBLIC_API_HOST` (e.g. `ratchet.example.com`)
  - `NEXT_PUBLIC_APP_URL` (e.g. `https://ratchet-client.example.com`)
  - `JWT_SECRET` (strong random value)
  - `CORS_ALLOWED_ORIGINS` (e.g. `https://ratchet-client.example.com`)
- Database defaults (override as needed):
  - `POSTGRES_USER`
  - `POSTGRES_PASSWORD`
  - `POSTGRES_DB`
- Federation trust defaults to TOFU; you may optionally set
  `FEDERATION_ALLOWED_HOSTS` for an allowlist.

## Logs

- Server logs: `server/logs/server.log`

## Federation Keys

Federation signing keys are stored in a `.cert` file (env format) and loaded
automatically on server startup.

## Configuration

See `.env.example` for all required settings.
