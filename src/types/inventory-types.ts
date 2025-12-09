import type {
  ItemType,
  TransactionType,
  Unit,
} from "../../generated/prisma/client";

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

export type StockTransactionFormData = {
  itemId: number;
  quantity: string; // Keep as string for form input
  batchNumber: string;
  expiryDate: string | undefined; // Keep as string for form input
  unitPrice: string; // Keep as string for form input
  location: string | undefined;
  notes: string | undefined;
};
export type SaleTransactionFormData = {
  itemId: number;
  visitId: number | undefined;
  quantity: string; // Keep as string for form input
  batchId: number;
  type: TransactionType;
  notes: string | null;
};
