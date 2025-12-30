ALTER TABLE "User"
ADD COLUMN "display_name" TEXT,
ADD COLUMN "display_name_visibility" TEXT NOT NULL DEFAULT 'public';
