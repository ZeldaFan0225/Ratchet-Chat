-- CreateEnum
CREATE TYPE "ReceiptType" AS ENUM ('DELIVERED_TO_SERVER', 'PROCESSED_BY_CLIENT', 'READ_BY_USER');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "auth_hash" TEXT NOT NULL,
    "auth_salt" TEXT NOT NULL,
    "auth_iterations" INTEGER NOT NULL,
    "kdf_salt" TEXT NOT NULL,
    "kdf_iterations" INTEGER NOT NULL,
    "public_identity_key" TEXT NOT NULL,
    "public_transport_key" TEXT NOT NULL,
    "encrypted_identity_key" TEXT NOT NULL,
    "encrypted_identity_iv" TEXT NOT NULL,
    "encrypted_transport_key" TEXT NOT NULL,
    "encrypted_transport_iv" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncomingQueue" (
    "id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "sender_handle" TEXT NOT NULL,
    "encrypted_blob" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncomingQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageVault" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "original_sender_handle" TEXT NOT NULL,
    "encrypted_blob" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "sender_signature_verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageVault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receipt" (
    "id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "type" "ReceiptType" NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "IncomingQueue_recipient_id_idx" ON "IncomingQueue"("recipient_id");

-- AddForeignKey
ALTER TABLE "IncomingQueue" ADD CONSTRAINT "IncomingQueue_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageVault" ADD CONSTRAINT "MessageVault_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
