-- AlterTable
ALTER TABLE "User" ADD COLUMN "avatar_filename" TEXT,
ADD COLUMN "avatar_visibility" TEXT NOT NULL DEFAULT 'public';
