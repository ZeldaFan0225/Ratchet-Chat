-- AlterTable
ALTER TABLE "MessageVault" ADD COLUMN     "client_sent_at" BIGINT,
ADD COLUMN     "prev_hash" TEXT,
ADD COLUMN     "sender_device_id" TEXT,
ADD COLUMN     "vector_clock" JSONB,
ALTER COLUMN "iv" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Device" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" TEXT NOT NULL,
    "last_seen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vector_clock" JSONB,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_user_id_device_id_key" ON "Device"("user_id", "device_id");

-- CreateIndex
CREATE INDEX "MessageVault_owner_id_created_at_idx" ON "MessageVault"("owner_id", "created_at");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
