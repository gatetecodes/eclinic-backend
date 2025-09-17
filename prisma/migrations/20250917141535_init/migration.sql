-- CreateEnum
CREATE TYPE "public"."ActivityType" AS ENUM ('PAYMENT', 'STATUS_UPDATE', 'TASK', 'HOSPITALIZATION', 'BILL_UPDATE', 'INSURANCE_CLAIM', 'INSURANCE_CLAIM_UPDATE', 'INSURANCE_CLAIM_ITEM', 'INSURANCE_CLAIM_DOCUMENT', 'INSURANCE_CLAIM_STATUS_UPDATE', 'VISIT_DISCHARGED', 'SPECTACLE_PRESCRIPTION_CREATED', 'HANDOFF');

-- CreateEnum
CREATE TYPE "public"."ApprovalType" AS ENUM ('DISCOUNT', 'REFUND', 'PRICE_OVERRIDE');

-- CreateEnum
CREATE TYPE "public"."ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."SubscriptionStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'TRIAL');

-- CreateEnum
CREATE TYPE "public"."SubscriptionPlan" AS ENUM ('CLINIC_STARTER', 'MEDICAL_PLUS', 'HOSPITAL_SUITE');

-- CreateEnum
CREATE TYPE "public"."BranchStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "public"."DemoRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."ExamStatus" AS ENUM ('PENDING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "public"."RoomClass" AS ENUM ('STANDARD', 'SEMI_PRIVATE', 'PRIVATE', 'SUITE');

-- CreateEnum
CREATE TYPE "public"."ClaimStatus" AS ENUM ('PENDING', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'RESUBMITTED');

-- CreateEnum
CREATE TYPE "public"."ClaimDocumentType" AS ENUM ('PRESCRIPTION', 'MEDICAL_REPORT', 'LAB_RESULT', 'INVOICE', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."ClaimItemStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PARTIALLY_APPROVED');

-- CreateEnum
CREATE TYPE "public"."ItemType" AS ENUM ('MEDICATION', 'SUPPLY', 'LAB_MATERIAL', 'CONSUMABLE', 'EQUIPMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."InventoryStatus" AS ENUM ('IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK');

-- CreateEnum
CREATE TYPE "public"."TransactionType" AS ENUM ('PURCHASE', 'SALE', 'ADJUSTMENT', 'TRANSFER', 'RETURN', 'DISPOSAL', 'CONSUMPTION');

-- CreateEnum
CREATE TYPE "public"."TransactionStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."SourceType" AS ENUM ('VISIT', 'PURCHASE_ORDER', 'MANUAL', 'TRANSFER', 'RETURN', 'DISPOSAL', 'STOCKTAKE');

-- CreateEnum
CREATE TYPE "public"."Unit" AS ENUM ('ML', 'MG', 'PIECE');

-- CreateEnum
CREATE TYPE "public"."InvoiceStatus" AS ENUM ('PENDING', 'PAID', 'OVERDUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."NotificationType" AS ENUM ('APPROVAL_REQUEST', 'APPOINTMENT_REMINDER', 'VISIT_UPDATE', 'PAYMENT_CONFIRMATION', 'SYSTEM_UPDATE', 'INVENTORY_ALERT', 'NEW_PAYMENT_BILL', 'LAB_EXAM_RESULTS', 'LAB_EXAM_REQUEST', 'HANDOFF_REQUEST');

-- CreateEnum
CREATE TYPE "public"."PatientAppointmentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "public"."PatientNotificationType" AS ENUM ('APPOINTMENT_CONFIRMED', 'APPOINTMENT_REMINDER', 'APPOINTMENT_CANCELLED', 'APPOINTMENT_RESCHEDULED', 'RESULTS_READY', 'PRESCRIPTION_READY', 'GENERAL');

-- CreateEnum
CREATE TYPE "public"."Gender" AS ENUM ('MALE', 'FEMALE');

-- CreateEnum
CREATE TYPE "public"."PaymentType" AS ENUM ('CONSULTATION', 'MEDICATION', 'ADDITIONAL_EXAM', 'HOSPITALIZATION', 'TREATMENT');

-- CreateEnum
CREATE TYPE "public"."PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FULLY_PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."DiscountStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."PaymentMethod" AS ENUM ('CASH', 'MOBILE_MONEY', 'CARD', 'BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "public"."PrescriptionStatus" AS ENUM ('ISSUED', 'PARTIALLY_SERVED', 'FULLY_SERVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."ProductCategory" AS ENUM ('TREATMENT', 'EXAM', 'MEDICATION', 'SUPPLY');

-- CreateEnum
CREATE TYPE "public"."PriceType" AS ENUM ('PRIVATE', 'GOV');

-- CreateEnum
CREATE TYPE "public"."EventType" AS ENUM ('APPOINTMENT', 'MEETING', 'TASK', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."AppointmentType" AS ENUM ('NEW_PATIENT', 'FOLLOW_UP');

-- CreateEnum
CREATE TYPE "public"."EventStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."Role" AS ENUM ('SUPER_ADMIN', 'CLINIC_ADMIN', 'BRANCH_ADMIN', 'DOCTOR', 'NURSE', 'LAB_TECHNICIAN', 'RECEPTIONIST', 'PHARMACIST', 'CASHIER', 'MARKETING', 'FLOW_MANAGER', 'STOCK_MANAGER');

-- CreateEnum
CREATE TYPE "public"."UserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "public"."EducationLevel" AS ENUM ('A0', 'A1', 'A2');

-- CreateEnum
CREATE TYPE "public"."VisitStatus" AS ENUM ('CHECKED_IN', 'TRIAGE_COMPLETED', 'IN_CONSULTATION', 'PENDING_TESTS', 'RESULTS_READY', 'FINALIZED', 'DISCHARGED', 'DISCHARGED_WITH_PRESCRIPTION', 'ADMITTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."PaymentMode" AS ENUM ('PRIVATE', 'INSURANCE');

-- CreateEnum
CREATE TYPE "public"."Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "public"."HandoffStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'COMPLETED');

-- CreateTable
CREATE TABLE "public"."ActivityLog" (
    "id" SERIAL NOT NULL,
    "visitId" INTEGER,
    "eventId" INTEGER,
    "action" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duration" INTEGER,
    "userId" INTEGER NOT NULL,
    "type" "public"."ActivityType" NOT NULL DEFAULT 'STATUS_UPDATE',

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Approval" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "branchId" INTEGER,
    "type" "public"."ApprovalType" NOT NULL,
    "status" "public"."ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" INTEGER NOT NULL,
    "approvedById" INTEGER,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "discountId" INTEGER,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Clinic" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "logo" TEXT,
    "subscriptionStatus" "public"."SubscriptionStatus" NOT NULL DEFAULT 'TRIAL',
    "subscriptionPlan" "public"."SubscriptionPlan" NOT NULL,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "subscriptionExpiryDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isPatientPortalEnabled" BOOLEAN NOT NULL DEFAULT false,
    "portalSettings" JSONB,

    CONSTRAINT "Clinic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Branch" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "address" TEXT,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "isHeadOffice" BOOLEAN NOT NULL DEFAULT false,
    "status" "public"."BranchStatus" NOT NULL DEFAULT 'ACTIVE',
    "isPatientPortalEnabled" BOOLEAN NOT NULL DEFAULT false,
    "clinicId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DemoRequest" (
    "id" SERIAL NOT NULL,
    "clinic_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "demo_date" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" "public"."DemoRequestStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "DemoRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Department" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ClinicalDepartment" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicalDepartment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Discount" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "paymentId" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "branchId" INTEGER,

    CONSTRAINT "Discount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Exam" (
    "id" SERIAL NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "visitId" INTEGER NOT NULL,
    "status" "public"."ExamStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Exam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ExamTest" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "normalRange" TEXT,
    "unit" TEXT,
    "consumables" JSONB,
    "productId" INTEGER NOT NULL,
    "examId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ExamResult" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "visitId" INTEGER NOT NULL,
    "examId" INTEGER NOT NULL,
    "examDate" TIMESTAMP(3) NOT NULL,
    "results" JSONB NOT NULL,
    "notes" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "branchId" INTEGER,

    CONSTRAINT "ExamResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Treatment" (
    "id" SERIAL NOT NULL,
    "name" TEXT,
    "visitId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Treatment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Expense" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RoomPrice" (
    "id" SERIAL NOT NULL,
    "class" "public"."RoomClass" NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "branchId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Room" (
    "id" SERIAL NOT NULL,
    "number" TEXT NOT NULL,
    "class" "public"."RoomClass" NOT NULL,
    "isOccupied" BOOLEAN NOT NULL DEFAULT false,
    "clinicId" INTEGER NOT NULL,
    "branchId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Hospitalization" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "branchId" INTEGER,
    "roomId" INTEGER NOT NULL,
    "patientId" INTEGER NOT NULL,
    "visitId" INTEGER NOT NULL,
    "admittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dischargedAt" TIMESTAMP(3),
    "roomCoveredByInsurance" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Hospitalization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."HospitalizationProduct" (
    "id" SERIAL NOT NULL,
    "visitId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HospitalizationProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InsuranceCompany" (
    "id" SERIAL NOT NULL,
    "companyName" TEXT NOT NULL,
    "contactPhone" TEXT,
    "contactEmail" TEXT,

    CONSTRAINT "InsuranceCompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Employer" (
    "id" SERIAL NOT NULL,
    "employerName" TEXT NOT NULL,
    "contactPhone" TEXT,
    "contactEmail" TEXT,

    CONSTRAINT "Employer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PatientInsurance" (
    "id" SERIAL NOT NULL,
    "patientId" INTEGER NOT NULL,
    "insuranceCompanyId" INTEGER NOT NULL,
    "insuranceNumber" TEXT NOT NULL,
    "employerId" INTEGER,
    "coveragePercentage" DECIMAL(10,2) NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientInsurance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InsuranceClaim" (
    "id" SERIAL NOT NULL,
    "claimNumber" TEXT NOT NULL,
    "visitId" INTEGER NOT NULL,
    "patientInsuranceId" INTEGER NOT NULL,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "claimStatus" "public"."ClaimStatus" NOT NULL DEFAULT 'PENDING',
    "submissionDate" TIMESTAMP(3),
    "processedDate" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "clinicId" INTEGER,
    "branchId" INTEGER,

    CONSTRAINT "InsuranceClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InsuranceClaimItem" (
    "id" SERIAL NOT NULL,
    "claimId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "insuranceAmount" DECIMAL(10,2) NOT NULL,
    "itemStatus" "public"."ClaimItemStatus" NOT NULL,
    "remarks" TEXT,

    CONSTRAINT "InsuranceClaimItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InsuranceClaimDocument" (
    "id" SERIAL NOT NULL,
    "claimId" INTEGER NOT NULL,
    "documentType" "public"."ClaimDocumentType" NOT NULL,
    "documentUrl" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InsuranceClaimDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InventoryItem" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "itemName" TEXT NOT NULL,
    "itemType" "public"."ItemType" NOT NULL,
    "reorderLevel" INTEGER NOT NULL,
    "manufacturer" TEXT,
    "unit" "public"."Unit" DEFAULT 'PIECE',
    "minOrderQuantity" INTEGER,
    "notes" TEXT,
    "unitPrice" DECIMAL(10,2),
    "status" "public"."InventoryStatus" NOT NULL DEFAULT 'IN_STOCK',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "branchId" INTEGER,

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InventoryStock" (
    "id" SERIAL NOT NULL,
    "itemId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InventoryBatch" (
    "id" SERIAL NOT NULL,
    "itemId" INTEGER NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "initialQuantity" INTEGER NOT NULL,
    "currentQuantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(10,2),
    "location" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Transaction" (
    "id" SERIAL NOT NULL,
    "itemId" INTEGER NOT NULL,
    "batchId" INTEGER,
    "type" "public"."TransactionType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(10,2),
    "totalAmount" DECIMAL(10,2),
    "status" "public"."TransactionStatus" NOT NULL DEFAULT 'COMPLETED',
    "sourceType" "public"."SourceType" NOT NULL,
    "visitId" INTEGER,
    "notes" TEXT,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Invoice" (
    "id" SERIAL NOT NULL,
    "dueDate" TIMESTAMP(3),
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "paidAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "status" "public"."InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "visitId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InvoiceItem" (
    "id" SERIAL NOT NULL,
    "invoiceId" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(65,30) NOT NULL,
    "totalPrice" DECIMAL(65,30) NOT NULL,
    "amountCoveredByInsurance" DECIMAL(65,30) NOT NULL,
    "patientResponsibility" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "InvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MedicalRecord" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "patientId" INTEGER NOT NULL,
    "visitDate" TIMESTAMP(3) NOT NULL,
    "symptoms" TEXT NOT NULL,
    "diagnosis" TEXT NOT NULL,
    "treatmentPlan" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "branchId" INTEGER,

    CONSTRAINT "MedicalRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Notification" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "type" "public"."NotificationType" NOT NULL,
    "visitId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PatientPortalAccount" (
    "id" SERIAL NOT NULL,
    "patientId" INTEGER NOT NULL,
    "password" TEXT NOT NULL,
    "verified" TIMESTAMP(3),
    "verificationToken" TEXT,
    "resetToken" TEXT,
    "resetTokenExpiry" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientPortalAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PatientAppointment" (
    "id" SERIAL NOT NULL,
    "patientId" INTEGER NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "branchId" INTEGER,
    "departmentId" INTEGER NOT NULL,
    "doctorId" INTEGER NOT NULL,
    "appointmentDate" TIMESTAMP(3) NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "status" "public"."PatientAppointmentStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "symptoms" TEXT,
    "isFollowUp" BOOLEAN NOT NULL DEFAULT false,
    "previousVisitId" INTEGER,
    "internalEventId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientAppointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PatientNotification" (
    "id" SERIAL NOT NULL,
    "patientId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" "public"."PatientNotificationType" NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "relatedAppointmentId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Patient" (
    "id" SERIAL NOT NULL,
    "patientId" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3) NOT NULL,
    "gender" "public"."Gender" NOT NULL,
    "phoneNumber" TEXT,
    "isChild" BOOLEAN DEFAULT false,
    "guardianPhoneNumber" TEXT,
    "email" TEXT,
    "medicalInfo" JSONB,
    "address" TEXT,
    "nationality" TEXT,
    "isAForeigner" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Payment" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "branchId" INTEGER,
    "visitId" INTEGER,
    "appointmentId" INTEGER,
    "amount" DECIMAL(10,2) NOT NULL,
    "insuranceAmount" DECIMAL(10,2),
    "patientAmount" DECIMAL(10,2) NOT NULL,
    "paymentDetails" JSONB,
    "paymentType" "public"."PaymentType" NOT NULL,
    "paymentMode" "public"."PaymentMode" NOT NULL,
    "paymentMethod" "public"."PaymentMethod" NOT NULL DEFAULT 'CASH',
    "paymentStatus" "public"."PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "processedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Prescription" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "visitId" INTEGER NOT NULL,
    "doctorId" INTEGER NOT NULL,
    "status" "public"."PrescriptionStatus" NOT NULL DEFAULT 'ISSUED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "branchId" INTEGER,

    CONSTRAINT "Prescription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PrescriptionItem" (
    "id" SERIAL NOT NULL,
    "prescriptionId" INTEGER NOT NULL,
    "medicationName" TEXT NOT NULL,
    "dosage" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "duration" TEXT NOT NULL,
    "instructions" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrescriptionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Product" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "basePrice" DECIMAL(10,2),
    "foreignersPrice" DECIMAL(10,2),
    "unit" TEXT,
    "normalRange" TEXT,
    "consumables" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "category" "public"."ProductCategory" DEFAULT 'TREATMENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InsurancePrice" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "priceWithCo" DECIMAL(65,30),
    "insuranceCompanyId" INTEGER NOT NULL,
    "priceType" "public"."PriceType",

    CONSTRAINT "InsurancePrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DoctorAvailability" (
    "id" SERIAL NOT NULL,
    "doctorId" INTEGER NOT NULL,
    "dayOfWeek" INTEGER,
    "startDayOfWeek" INTEGER,
    "startTime" TEXT,
    "endDayOfWeek" INTEGER,
    "endTime" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DoctorAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Event" (
    "id" SERIAL NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "doctorId" INTEGER NOT NULL,
    "patientId" INTEGER,
    "clinicId" INTEGER NOT NULL,
    "branchId" INTEGER,
    "type" "public"."EventType" NOT NULL,
    "status" "public"."EventStatus" NOT NULL DEFAULT 'SCHEDULED',
    "treatment" TEXT,
    "visitId" INTEGER,
    "appointmentType" "public"."AppointmentType" DEFAULT 'NEW_PATIENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."session" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SpectaclePrescription" (
    "id" SERIAL NOT NULL,
    "branchId" INTEGER NOT NULL,
    "visitId" INTEGER NOT NULL,
    "doctorId" INTEGER NOT NULL,
    "rightEye" JSONB NOT NULL,
    "leftEye" JSONB NOT NULL,
    "interpupillaryDistance" JSONB NOT NULL,
    "lensType" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpectaclePrescription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."User" (
    "id" SERIAL NOT NULL,
    "clinicId" INTEGER,
    "name" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "public"."Role" NOT NULL,
    "status" "public"."UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "phone_number" TEXT NOT NULL,
    "phone_number_verified" TIMESTAMP(3),
    "consultationFee" DOUBLE PRECISION,
    "licenseExpiration" TIMESTAMP(3),
    "licenseNumber" TEXT,
    "license_document" TEXT,
    "diploma_document" TEXT,
    "highestEducation" "public"."EducationLevel",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isTwoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "branchId" INTEGER,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."VerificationToken" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PasswordResetToken" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TwoFactorToken" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TwoFactorToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TwoFactorConfirmation" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,

    CONSTRAINT "TwoFactorConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Visit" (
    "id" SERIAL NOT NULL,
    "patientId" INTEGER NOT NULL,
    "clinicId" INTEGER NOT NULL,
    "branchId" INTEGER,
    "departmentId" INTEGER,
    "doctorId" INTEGER,
    "transferredToId" INTEGER,
    "status" "public"."VisitStatus" NOT NULL DEFAULT 'CHECKED_IN',
    "startTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endTime" TIMESTAMP(3),
    "notes" TEXT,
    "checkedInById" INTEGER,
    "paymentMode" "public"."PaymentMode",
    "patientInsuranceId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" INTEGER,
    "basicTriage" JSONB,
    "medicConsumables" JSONB,
    "isNewPatient" BOOLEAN NOT NULL DEFAULT false,
    "priority" "public"."Priority" NOT NULL,
    "consultationNote" TEXT,
    "transferReason" TEXT,
    "chiefComplaint" TEXT,
    "diagnosis" TEXT,
    "examConclusions" TEXT,
    "treatmentComments" TEXT,
    "followUpDate" TIMESTAMP(3),
    "isLabOnly" BOOLEAN NOT NULL DEFAULT false,
    "requiresConsultation" BOOLEAN NOT NULL DEFAULT true,
    "consultationId" INTEGER,

    CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Handoff" (
    "id" SERIAL NOT NULL,
    "visitId" INTEGER NOT NULL,
    "fromDoctorId" INTEGER NOT NULL,
    "toDoctorId" INTEGER NOT NULL,
    "handoffNotes" TEXT NOT NULL,
    "handoffStatus" "public"."HandoffStatus" NOT NULL DEFAULT 'ACCEPTED',
    "handoffTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Handoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."_ClinicToPatient" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_ClinicToPatient_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_ClinicToClinicalDepartment" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_ClinicToClinicalDepartment_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_ClinicToProduct" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_ClinicToProduct_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_BranchToPatient" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_BranchToPatient_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_BranchToClinicalDepartment" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_BranchToClinicalDepartment_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_DepartmentToProduct" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_DepartmentToProduct_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_ClinicalDepartmentToUser" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_ClinicalDepartmentToUser_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_ExamToProduct" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_ExamToProduct_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_InvoiceToProduct" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_InvoiceToProduct_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_PaymentToProduct" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_PaymentToProduct_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_ConsultationProducts" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_ConsultationProducts_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_ProductToTreatment" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_ProductToTreatment_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "ActivityLog_visitId_idx" ON "public"."ActivityLog"("visitId");

-- CreateIndex
CREATE INDEX "ActivityLog_userId_idx" ON "public"."ActivityLog"("userId");

-- CreateIndex
CREATE INDEX "ActivityLog_timestamp_idx" ON "public"."ActivityLog"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_discountId_key" ON "public"."Approval"("discountId");

-- CreateIndex
CREATE INDEX "Branch_clinicId_idx" ON "public"."Branch"("clinicId");

-- CreateIndex
CREATE INDEX "Branch_code_idx" ON "public"."Branch"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Department_name_key" ON "public"."Department"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicalDepartment_name_key" ON "public"."ClinicalDepartment"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Discount_paymentId_key" ON "public"."Discount"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "ExamTest_name_productId_key" ON "public"."ExamTest"("name", "productId");

-- CreateIndex
CREATE INDEX "ExamResult_branchId_idx" ON "public"."ExamResult"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomPrice_class_key" ON "public"."RoomPrice"("class");

-- CreateIndex
CREATE INDEX "RoomPrice_clinicId_idx" ON "public"."RoomPrice"("clinicId");

-- CreateIndex
CREATE INDEX "RoomPrice_branchId_idx" ON "public"."RoomPrice"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomPrice_clinicId_class_key" ON "public"."RoomPrice"("clinicId", "class");

-- CreateIndex
CREATE UNIQUE INDEX "RoomPrice_branchId_class_key" ON "public"."RoomPrice"("branchId", "class");

-- CreateIndex
CREATE UNIQUE INDEX "Room_number_key" ON "public"."Room"("number");

-- CreateIndex
CREATE INDEX "Room_clinicId_idx" ON "public"."Room"("clinicId");

-- CreateIndex
CREATE INDEX "Room_branchId_idx" ON "public"."Room"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "Hospitalization_visitId_key" ON "public"."Hospitalization"("visitId");

-- CreateIndex
CREATE INDEX "Hospitalization_roomId_idx" ON "public"."Hospitalization"("roomId");

-- CreateIndex
CREATE INDEX "Hospitalization_patientId_idx" ON "public"."Hospitalization"("patientId");

-- CreateIndex
CREATE INDEX "Hospitalization_visitId_idx" ON "public"."Hospitalization"("visitId");

-- CreateIndex
CREATE INDEX "Hospitalization_branchId_idx" ON "public"."Hospitalization"("branchId");

-- CreateIndex
CREATE INDEX "HospitalizationProduct_visitId_idx" ON "public"."HospitalizationProduct"("visitId");

-- CreateIndex
CREATE INDEX "HospitalizationProduct_productId_idx" ON "public"."HospitalizationProduct"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "InsuranceCompany_companyName_key" ON "public"."InsuranceCompany"("companyName");

-- CreateIndex
CREATE UNIQUE INDEX "Employer_employerName_key" ON "public"."Employer"("employerName");

-- CreateIndex
CREATE UNIQUE INDEX "PatientInsurance_insuranceNumber_key" ON "public"."PatientInsurance"("insuranceNumber");

-- CreateIndex
CREATE INDEX "PatientInsurance_patientId_idx" ON "public"."PatientInsurance"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientInsurance_insuranceNumber_patientId_key" ON "public"."PatientInsurance"("insuranceNumber", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "InsuranceClaim_claimNumber_key" ON "public"."InsuranceClaim"("claimNumber");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_clinicId_itemName_key" ON "public"."InventoryItem"("clinicId", "itemName");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryStock_itemId_key" ON "public"."InventoryStock"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryBatch_itemId_batchNumber_key" ON "public"."InventoryBatch"("itemId", "batchNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_visitId_key" ON "public"."Invoice"("visitId");

-- CreateIndex
CREATE INDEX "MedicalRecord_clinicId_idx" ON "public"."MedicalRecord"("clinicId");

-- CreateIndex
CREATE INDEX "MedicalRecord_patientId_idx" ON "public"."MedicalRecord"("patientId");

-- CreateIndex
CREATE INDEX "MedicalRecord_branchId_idx" ON "public"."MedicalRecord"("branchId");

-- CreateIndex
CREATE INDEX "Notification_userId_idx" ON "public"."Notification"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientPortalAccount_patientId_key" ON "public"."PatientPortalAccount"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientAppointment_internalEventId_key" ON "public"."PatientAppointment"("internalEventId");

-- CreateIndex
CREATE INDEX "PatientAppointment_patientId_idx" ON "public"."PatientAppointment"("patientId");

-- CreateIndex
CREATE INDEX "PatientAppointment_clinicId_idx" ON "public"."PatientAppointment"("clinicId");

-- CreateIndex
CREATE INDEX "PatientAppointment_branchId_idx" ON "public"."PatientAppointment"("branchId");

-- CreateIndex
CREATE INDEX "PatientAppointment_doctorId_idx" ON "public"."PatientAppointment"("doctorId");

-- CreateIndex
CREATE INDEX "PatientAppointment_appointmentDate_idx" ON "public"."PatientAppointment"("appointmentDate");

-- CreateIndex
CREATE INDEX "PatientAppointment_status_idx" ON "public"."PatientAppointment"("status");

-- CreateIndex
CREATE INDEX "PatientNotification_patientId_idx" ON "public"."PatientNotification"("patientId");

-- CreateIndex
CREATE INDEX "PatientNotification_isRead_idx" ON "public"."PatientNotification"("isRead");

-- CreateIndex
CREATE UNIQUE INDEX "Patient_patientId_key" ON "public"."Patient"("patientId");

-- CreateIndex
CREATE INDEX "Patient_phoneNumber_lastName_firstName_idx" ON "public"."Patient"("phoneNumber", "lastName", "firstName");

-- CreateIndex
CREATE INDEX "Patient_guardianPhoneNumber_idx" ON "public"."Patient"("guardianPhoneNumber");

-- CreateIndex
CREATE INDEX "Patient_phoneNumber_idx" ON "public"."Patient"("phoneNumber");

-- CreateIndex
CREATE INDEX "Payment_clinicId_idx" ON "public"."Payment"("clinicId");

-- CreateIndex
CREATE INDEX "Payment_visitId_idx" ON "public"."Payment"("visitId");

-- CreateIndex
CREATE INDEX "Payment_appointmentId_idx" ON "public"."Payment"("appointmentId");

-- CreateIndex
CREATE INDEX "Prescription_clinicId_idx" ON "public"."Prescription"("clinicId");

-- CreateIndex
CREATE INDEX "Prescription_visitId_idx" ON "public"."Prescription"("visitId");

-- CreateIndex
CREATE INDEX "Prescription_doctorId_idx" ON "public"."Prescription"("doctorId");

-- CreateIndex
CREATE INDEX "Prescription_branchId_idx" ON "public"."Prescription"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "Prescription_clinicId_visitId_doctorId_key" ON "public"."Prescription"("clinicId", "visitId", "doctorId");

-- CreateIndex
CREATE INDEX "PrescriptionItem_prescriptionId_idx" ON "public"."PrescriptionItem"("prescriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "PrescriptionItem_prescriptionId_medicationName_dosage_key" ON "public"."PrescriptionItem"("prescriptionId", "medicationName", "dosage");

-- CreateIndex
CREATE UNIQUE INDEX "Product_code_key" ON "public"."Product"("code");

-- CreateIndex
CREATE UNIQUE INDEX "InsurancePrice_productId_insuranceCompanyId_key" ON "public"."InsurancePrice"("productId", "insuranceCompanyId");

-- CreateIndex
CREATE INDEX "DoctorAvailability_doctorId_dayOfWeek_startDayOfWeek_endDay_idx" ON "public"."DoctorAvailability"("doctorId", "dayOfWeek", "startDayOfWeek", "endDayOfWeek");

-- CreateIndex
CREATE UNIQUE INDEX "Event_visitId_key" ON "public"."Event"("visitId");

-- CreateIndex
CREATE INDEX "Event_doctorId_startTime_endTime_idx" ON "public"."Event"("doctorId", "startTime", "endTime");

-- CreateIndex
CREATE INDEX "Event_patientId_idx" ON "public"."Event"("patientId");

-- CreateIndex
CREATE INDEX "Event_clinicId_idx" ON "public"."Event"("clinicId");

-- CreateIndex
CREATE UNIQUE INDEX "SpectaclePrescription_visitId_key" ON "public"."SpectaclePrescription"("visitId");

-- CreateIndex
CREATE INDEX "SpectaclePrescription_branchId_idx" ON "public"."SpectaclePrescription"("branchId");

-- CreateIndex
CREATE INDEX "SpectaclePrescription_visitId_idx" ON "public"."SpectaclePrescription"("visitId");

-- CreateIndex
CREATE INDEX "SpectaclePrescription_doctorId_idx" ON "public"."SpectaclePrescription"("doctorId");

-- CreateIndex
CREATE UNIQUE INDEX "SpectaclePrescription_branchId_visitId_doctorId_key" ON "public"."SpectaclePrescription"("branchId", "visitId", "doctorId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "public"."User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "public"."User"("role");

-- CreateIndex
CREATE UNIQUE INDEX "User_clinicId_email_key" ON "public"."User"("clinicId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "public"."VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_email_token_key" ON "public"."VerificationToken"("email", "token");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_token_key" ON "public"."PasswordResetToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_email_token_key" ON "public"."PasswordResetToken"("email", "token");

-- CreateIndex
CREATE UNIQUE INDEX "TwoFactorToken_token_key" ON "public"."TwoFactorToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "TwoFactorToken_email_token_key" ON "public"."TwoFactorToken"("email", "token");

-- CreateIndex
CREATE UNIQUE INDEX "TwoFactorConfirmation_userId_key" ON "public"."TwoFactorConfirmation"("userId");

-- CreateIndex
CREATE INDEX "Visit_patientId_idx" ON "public"."Visit"("patientId");

-- CreateIndex
CREATE INDEX "Visit_clinicId_idx" ON "public"."Visit"("clinicId");

-- CreateIndex
CREATE INDEX "Visit_departmentId_idx" ON "public"."Visit"("departmentId");

-- CreateIndex
CREATE INDEX "Visit_doctorId_idx" ON "public"."Visit"("doctorId");

-- CreateIndex
CREATE INDEX "Visit_status_idx" ON "public"."Visit"("status");

-- CreateIndex
CREATE INDEX "Visit_startTime_idx" ON "public"."Visit"("startTime");

-- CreateIndex
CREATE INDEX "Visit_createdAt_idx" ON "public"."Visit"("createdAt");

-- CreateIndex
CREATE INDEX "Visit_updatedAt_idx" ON "public"."Visit"("updatedAt");

-- CreateIndex
CREATE INDEX "Handoff_visitId_idx" ON "public"."Handoff"("visitId");

-- CreateIndex
CREATE INDEX "Handoff_fromDoctorId_idx" ON "public"."Handoff"("fromDoctorId");

-- CreateIndex
CREATE INDEX "Handoff_toDoctorId_idx" ON "public"."Handoff"("toDoctorId");

-- CreateIndex
CREATE INDEX "_ClinicToPatient_B_index" ON "public"."_ClinicToPatient"("B");

-- CreateIndex
CREATE INDEX "_ClinicToClinicalDepartment_B_index" ON "public"."_ClinicToClinicalDepartment"("B");

-- CreateIndex
CREATE INDEX "_ClinicToProduct_B_index" ON "public"."_ClinicToProduct"("B");

-- CreateIndex
CREATE INDEX "_BranchToPatient_B_index" ON "public"."_BranchToPatient"("B");

-- CreateIndex
CREATE INDEX "_BranchToClinicalDepartment_B_index" ON "public"."_BranchToClinicalDepartment"("B");

-- CreateIndex
CREATE INDEX "_DepartmentToProduct_B_index" ON "public"."_DepartmentToProduct"("B");

-- CreateIndex
CREATE INDEX "_ClinicalDepartmentToUser_B_index" ON "public"."_ClinicalDepartmentToUser"("B");

-- CreateIndex
CREATE INDEX "_ExamToProduct_B_index" ON "public"."_ExamToProduct"("B");

-- CreateIndex
CREATE INDEX "_InvoiceToProduct_B_index" ON "public"."_InvoiceToProduct"("B");

-- CreateIndex
CREATE INDEX "_PaymentToProduct_B_index" ON "public"."_PaymentToProduct"("B");

-- CreateIndex
CREATE INDEX "_ConsultationProducts_B_index" ON "public"."_ConsultationProducts"("B");

-- CreateIndex
CREATE INDEX "_ProductToTreatment_B_index" ON "public"."_ProductToTreatment"("B");

-- AddForeignKey
ALTER TABLE "public"."ActivityLog" ADD CONSTRAINT "ActivityLog_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "public"."Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ActivityLog" ADD CONSTRAINT "ActivityLog_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ActivityLog" ADD CONSTRAINT "ActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Approval" ADD CONSTRAINT "Approval_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Approval" ADD CONSTRAINT "Approval_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "public"."Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Approval" ADD CONSTRAINT "Approval_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Approval" ADD CONSTRAINT "Approval_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Approval" ADD CONSTRAINT "Approval_discountId_fkey" FOREIGN KEY ("discountId") REFERENCES "public"."Discount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Branch" ADD CONSTRAINT "Branch_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Discount" ADD CONSTRAINT "Discount_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Discount" ADD CONSTRAINT "Discount_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "public"."Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Discount" ADD CONSTRAINT "Discount_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Discount" ADD CONSTRAINT "Discount_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "public"."Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Exam" ADD CONSTRAINT "Exam_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "public"."Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExamTest" ADD CONSTRAINT "ExamTest_examId_fkey" FOREIGN KEY ("examId") REFERENCES "public"."Exam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExamTest" ADD CONSTRAINT "ExamTest_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExamResult" ADD CONSTRAINT "ExamResult_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExamResult" ADD CONSTRAINT "ExamResult_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "public"."Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExamResult" ADD CONSTRAINT "ExamResult_examId_fkey" FOREIGN KEY ("examId") REFERENCES "public"."Exam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExamResult" ADD CONSTRAINT "ExamResult_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExamResult" ADD CONSTRAINT "ExamResult_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "public"."Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Treatment" ADD CONSTRAINT "Treatment_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "public"."Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Expense" ADD CONSTRAINT "Expense_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RoomPrice" ADD CONSTRAINT "RoomPrice_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RoomPrice" ADD CONSTRAINT "RoomPrice_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "public"."Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Room" ADD CONSTRAINT "Room_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Room" ADD CONSTRAINT "Room_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "public"."Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Hospitalization" ADD CONSTRAINT "Hospitalization_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Hospitalization" ADD CONSTRAINT "Hospitalization_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "public"."Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Hospitalization" ADD CONSTRAINT "Hospitalization_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "public"."Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Hospitalization" ADD CONSTRAINT "Hospitalization_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "public"."Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Hospitalization" ADD CONSTRAINT "Hospitalization_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "public"."Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."HospitalizationProduct" ADD CONSTRAINT "HospitalizationProduct_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "public"."Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."HospitalizationProduct" ADD CONSTRAINT "HospitalizationProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PatientInsurance" ADD CONSTRAINT "PatientInsurance_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "public"."Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PatientInsurance" ADD CONSTRAINT "PatientInsurance_insuranceCompanyId_fkey" FOREIGN KEY ("insuranceCompanyId") REFERENCES "public"."InsuranceCompany"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PatientInsurance" ADD CONSTRAINT "PatientInsurance_employerId_fkey" FOREIGN KEY ("employerId") REFERENCES "public"."Employer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InsuranceClaim" ADD CONSTRAINT "InsuranceClaim_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "public"."Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InsuranceClaim" ADD CONSTRAINT "InsuranceClaim_patientInsuranceId_fkey" FOREIGN KEY ("patientInsuranceId") REFERENCES "public"."PatientInsurance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InsuranceClaim" ADD CONSTRAINT "InsuranceClaim_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InsuranceClaim" ADD CONSTRAINT "InsuranceClaim_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "public"."Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InsuranceClaimItem" ADD CONSTRAINT "InsuranceClaimItem_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "public"."InsuranceClaim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InsuranceClaimItem" ADD CONSTRAINT "InsuranceClaimItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InsuranceClaimDocument" ADD CONSTRAINT "InsuranceClaimDocument_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "public"."InsuranceClaim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InventoryItem" ADD CONSTRAINT "InventoryItem_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InventoryItem" ADD CONSTRAINT "InventoryItem_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "public"."Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InventoryStock" ADD CONSTRAINT "InventoryStock_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "public"."InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InventoryBatch" ADD CONSTRAINT "InventoryBatch_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "public"."InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Transaction" ADD CONSTRAINT "Transaction_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "public"."InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Transaction" ADD CONSTRAINT "Transaction_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "public"."InventoryBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Transaction" ADD CONSTRAINT "Transaction_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "public"."Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Transaction" ADD CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Invoice" ADD CONSTRAINT "Invoice_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "public"."Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "public"."Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MedicalRecord" ADD CONSTRAINT "MedicalRecord_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MedicalRecord" ADD CONSTRAINT "MedicalRecord_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "public"."Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MedicalRecord" ADD CONSTRAINT "MedicalRecord_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "public"."Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Notification" ADD CONSTRAINT "Notification_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "public"."Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PatientPortalAccount" ADD CONSTRAINT "PatientPortalAccount_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "public"."Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PatientAppointment" ADD CONSTRAINT "PatientAppointment_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "public"."Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PatientAppointment" ADD CONSTRAINT "PatientAppointment_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PatientAppointment" ADD CONSTRAINT "PatientAppointment_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "public"."Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PatientAppointment" ADD CONSTRAINT "PatientAppointment_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "public"."ClinicalDepartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PatientAppointment" ADD CONSTRAINT "PatientAppointment_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PatientAppointment" ADD CONSTRAINT "PatientAppointment_internalEventId_fkey" FOREIGN KEY ("internalEventId") REFERENCES "public"."Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PatientNotification" ADD CONSTRAINT "PatientNotification_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "public"."Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Payment" ADD CONSTRAINT "Payment_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Payment" ADD CONSTRAINT "Payment_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "public"."Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Payment" ADD CONSTRAINT "Payment_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "public"."Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Payment" ADD CONSTRAINT "Payment_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "public"."Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Payment" ADD CONSTRAINT "Payment_processedById_fkey" FOREIGN KEY ("processedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Prescription" ADD CONSTRAINT "Prescription_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Prescription" ADD CONSTRAINT "Prescription_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "public"."Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Prescription" ADD CONSTRAINT "Prescription_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Prescription" ADD CONSTRAINT "Prescription_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "public"."Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PrescriptionItem" ADD CONSTRAINT "PrescriptionItem_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "public"."Prescription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InsurancePrice" ADD CONSTRAINT "InsurancePrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InsurancePrice" ADD CONSTRAINT "InsurancePrice_insuranceCompanyId_fkey" FOREIGN KEY ("insuranceCompanyId") REFERENCES "public"."InsuranceCompany"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DoctorAvailability" ADD CONSTRAINT "DoctorAvailability_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "public"."Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "public"."Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "public"."Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SpectaclePrescription" ADD CONSTRAINT "SpectaclePrescription_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "public"."Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SpectaclePrescription" ADD CONSTRAINT "SpectaclePrescription_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "public"."Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SpectaclePrescription" ADD CONSTRAINT "SpectaclePrescription_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."User" ADD CONSTRAINT "User_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."User" ADD CONSTRAINT "User_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "public"."Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TwoFactorConfirmation" ADD CONSTRAINT "TwoFactorConfirmation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Visit" ADD CONSTRAINT "Visit_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "public"."Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Visit" ADD CONSTRAINT "Visit_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Visit" ADD CONSTRAINT "Visit_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "public"."Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Visit" ADD CONSTRAINT "Visit_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "public"."ClinicalDepartment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Visit" ADD CONSTRAINT "Visit_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Visit" ADD CONSTRAINT "Visit_transferredToId_fkey" FOREIGN KEY ("transferredToId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Visit" ADD CONSTRAINT "Visit_checkedInById_fkey" FOREIGN KEY ("checkedInById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Visit" ADD CONSTRAINT "Visit_patientInsuranceId_fkey" FOREIGN KEY ("patientInsuranceId") REFERENCES "public"."PatientInsurance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Visit" ADD CONSTRAINT "Visit_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "public"."Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Handoff" ADD CONSTRAINT "Handoff_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "public"."Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Handoff" ADD CONSTRAINT "Handoff_fromDoctorId_fkey" FOREIGN KEY ("fromDoctorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Handoff" ADD CONSTRAINT "Handoff_toDoctorId_fkey" FOREIGN KEY ("toDoctorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_ClinicToPatient" ADD CONSTRAINT "_ClinicToPatient_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_ClinicToPatient" ADD CONSTRAINT "_ClinicToPatient_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_ClinicToClinicalDepartment" ADD CONSTRAINT "_ClinicToClinicalDepartment_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_ClinicToClinicalDepartment" ADD CONSTRAINT "_ClinicToClinicalDepartment_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."ClinicalDepartment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_ClinicToProduct" ADD CONSTRAINT "_ClinicToProduct_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_ClinicToProduct" ADD CONSTRAINT "_ClinicToProduct_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_BranchToPatient" ADD CONSTRAINT "_BranchToPatient_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_BranchToPatient" ADD CONSTRAINT "_BranchToPatient_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_BranchToClinicalDepartment" ADD CONSTRAINT "_BranchToClinicalDepartment_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_BranchToClinicalDepartment" ADD CONSTRAINT "_BranchToClinicalDepartment_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."ClinicalDepartment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_DepartmentToProduct" ADD CONSTRAINT "_DepartmentToProduct_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_DepartmentToProduct" ADD CONSTRAINT "_DepartmentToProduct_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_ClinicalDepartmentToUser" ADD CONSTRAINT "_ClinicalDepartmentToUser_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."ClinicalDepartment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_ClinicalDepartmentToUser" ADD CONSTRAINT "_ClinicalDepartmentToUser_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_ExamToProduct" ADD CONSTRAINT "_ExamToProduct_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_ExamToProduct" ADD CONSTRAINT "_ExamToProduct_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_InvoiceToProduct" ADD CONSTRAINT "_InvoiceToProduct_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_InvoiceToProduct" ADD CONSTRAINT "_InvoiceToProduct_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_PaymentToProduct" ADD CONSTRAINT "_PaymentToProduct_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_PaymentToProduct" ADD CONSTRAINT "_PaymentToProduct_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_ConsultationProducts" ADD CONSTRAINT "_ConsultationProducts_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_ConsultationProducts" ADD CONSTRAINT "_ConsultationProducts_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_ProductToTreatment" ADD CONSTRAINT "_ProductToTreatment_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_ProductToTreatment" ADD CONSTRAINT "_ProductToTreatment_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."Treatment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
