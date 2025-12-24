-- AlterTable
ALTER TABLE "User" ADD COLUMN     "send_read_receipts" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "show_typing_indicator" BOOLEAN NOT NULL DEFAULT true;
