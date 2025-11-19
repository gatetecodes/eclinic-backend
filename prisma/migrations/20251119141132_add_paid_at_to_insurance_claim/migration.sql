-- AlterTable
ALTER TABLE "InsuranceClaim" ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "paymentMethod" "PaymentMethod";
