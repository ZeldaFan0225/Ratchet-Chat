-- AlterTable
ALTER TABLE "User" ADD COLUMN     "encrypted_totp_secret" TEXT,
ADD COLUMN     "encrypted_totp_secret_iv" TEXT,
ADD COLUMN     "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "totp_verified_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TotpRecoveryCode" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TotpRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TotpRecoveryCode_user_id_idx" ON "TotpRecoveryCode"("user_id");

-- CreateIndex
CREATE INDEX "TotpRecoveryCode_code_hash_idx" ON "TotpRecoveryCode"("code_hash");

-- AddForeignKey
ALTER TABLE "TotpRecoveryCode" ADD CONSTRAINT "TotpRecoveryCode_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
