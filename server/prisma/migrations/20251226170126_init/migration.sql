/*
  Warnings:

  - You are about to drop the column `client_sent_at` on the `MessageVault` table. All the data in the column will be lost.
  - You are about to drop the column `prev_hash` on the `MessageVault` table. All the data in the column will be lost.
  - You are about to drop the column `sender_device_id` on the `MessageVault` table. All the data in the column will be lost.
  - You are about to drop the column `vector_clock` on the `MessageVault` table. All the data in the column will be lost.
  - You are about to drop the `Device` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Receipt` table. If the table is not empty, all the data it contains will be lost.
  - Made the column `iv` on table `MessageVault` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE IF EXISTS "Device" DROP CONSTRAINT IF EXISTS "Device_user_id_fkey";

-- DropForeignKey
ALTER TABLE IF EXISTS "Receipt" DROP CONSTRAINT IF EXISTS "Receipt_recipient_id_fkey";

-- DropIndex
DROP INDEX IF EXISTS "MessageVault_owner_id_created_at_idx";

-- AlterTable
ALTER TABLE "MessageVault" DROP COLUMN "client_sent_at",
DROP COLUMN "prev_hash",
DROP COLUMN "sender_device_id",
DROP COLUMN "vector_clock",
ALTER COLUMN "iv" SET NOT NULL;

-- DropTable
DROP TABLE IF EXISTS "Device";

-- DropTable
DROP TABLE IF EXISTS "Receipt";

-- DropEnum
DROP TYPE IF EXISTS "ReceiptType";
