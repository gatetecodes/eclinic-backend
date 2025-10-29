-- CreateTable
CREATE TABLE "public"."PartialPayment" (
    "id" SERIAL NOT NULL,
    "paymentId" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "paymentMethod" "public"."PaymentMethod" NOT NULL,
    "processedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartialPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartialPayment_paymentId_idx" ON "public"."PartialPayment"("paymentId");

-- CreateIndex
CREATE INDEX "PartialPayment_processedById_idx" ON "public"."PartialPayment"("processedById");

-- AddForeignKey
ALTER TABLE "public"."PartialPayment" ADD CONSTRAINT "PartialPayment_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "public"."Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PartialPayment" ADD CONSTRAINT "PartialPayment_processedById_fkey" FOREIGN KEY ("processedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
