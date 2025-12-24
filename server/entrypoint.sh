#!/bin/sh
set -e

if [ -n "$DATABASE_URL" ]; then
  npx prisma migrate deploy
fi

node dist/server.js
