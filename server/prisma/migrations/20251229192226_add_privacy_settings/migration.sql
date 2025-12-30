-- AlterTable
ALTER TABLE "User" ADD COLUMN     "encrypted_privacy_settings" TEXT,
ADD COLUMN     "encrypted_privacy_settings_iv" TEXT;
