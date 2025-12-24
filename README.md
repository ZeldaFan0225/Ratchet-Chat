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

## Logs

- Server logs: `server/logs/server.log`
- Client logs: `client/logs/client.log`

## Federation Keys

Federation signing keys are stored in a `.cert` file (env format) and loaded
automatically on server startup.

## Configuration

See `.env.example`, `server/.env.example`, and `client/.env.example`.
