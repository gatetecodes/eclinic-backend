import type { ItemType, Unit } from "../../generated/prisma";

export type InventoryItem = {
  id: number;
  itemName: string;
  itemType: string;
  reorderLevel: number;
  manufacturer: string | null;
  minOrderQuantity: number | null;
  notes: string | null;
  unit: Unit;
  currentStock: {
    id: number;
    quantity: number;
  };
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

export type Batch = {
  id: number;
  batchNumber: string;
  currentQuantity: number;
  expiryDate: Date | null;
  unitPrice: number | string | { toString: () => string } | null; // Handle Decimal type
  location?: string | null; // Make location optional and nullable
};

export type ConsumableCSVRow = {
  ID: string;
  NAME: string;
  CATEGORY: string;
  PRICE: string;
  UNIT?: string;
  REORDER_LEVEL?: string;
};

export type IExistingInventoryItem = {
  id: number;
  itemName: string;
  itemType: ItemType;
  reorderLevel: number;
  unit: Unit | null;
};

export type ITreatment = {
  id: string;
  quantity: number;
};

export type IPaymentDetail = {
  productName: string;
  amount: number;
  patientAmount: number;
  insuranceAmount: number;
  productId: number;
  quantity: number;
  batchId: number;
};
