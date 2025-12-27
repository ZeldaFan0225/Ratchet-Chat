-- AlterTable
ALTER TABLE "IncomingQueue" ADD COLUMN     "event_type" TEXT NOT NULL DEFAULT 'message',
ADD COLUMN     "iv" TEXT,
ADD COLUMN     "message_id" UUID,
ADD COLUMN     "reaction_emoji" TEXT;

-- AlterTable
ALTER TABLE "MessageVault" ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "peer_handle" TEXT,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "IncomingQueue_recipient_id_message_id_event_type_sender_han_idx" ON "IncomingQueue"("recipient_id", "message_id", "event_type", "sender_handle");

-- CreateIndex
CREATE INDEX "MessageVault_owner_id_updated_at_idx" ON "MessageVault"("owner_id", "updated_at");

-- CreateIndex
CREATE INDEX "MessageVault_owner_id_peer_handle_idx" ON "MessageVault"("owner_id", "peer_handle");
