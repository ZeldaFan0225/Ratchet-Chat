-- CreateTable
CREATE TABLE "Call" (
    "id" UUID NOT NULL,
    "caller_id" UUID NOT NULL,
    "callee_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INITIATED',
    "call_type" TEXT NOT NULL DEFAULT 'AUDIO',
    "end_reason" TEXT,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Call_caller_id_idx" ON "Call"("caller_id");

-- CreateIndex
CREATE INDEX "Call_callee_id_idx" ON "Call"("callee_id");

-- CreateIndex
CREATE INDEX "Call_status_idx" ON "Call"("status");

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_caller_id_fkey" FOREIGN KEY ("caller_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_callee_id_fkey" FOREIGN KEY ("callee_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
