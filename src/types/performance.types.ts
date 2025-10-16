import type { Role } from "../../generated/prisma";

export type PerformanceDateRange =
  | "today"
  | "week"
  | "month"
  | "quarter"
  | "year"
  | "custom";

export type PerformanceFilters = {
  doctorId?: string;
  departmentId?: string;
  role?: Role;
  startDate?: string;
  endDate?: string;
  minVisits?: number;
};

export type MetricData = {
  count: number;
  trend: number;
  trendText: string;
};

export type PerformanceMetrics = {
  totalVisits: MetricData;
  totalRevenue: MetricData;
  completedVisits: MetricData;
  activeStaff: MetricData;
};

export type DoctorDetails = {
  id: number;
  name: string;
  consultationFee: number | null;
  departments: {
    id: number;
    name: string;
  }[];
};

export type DoctorMetrics = {
  totalVisits: MetricData;
  completedVisits: MetricData;
  totalRevenue: MetricData;
  avgRevenuePerVisit: MetricData;
  examOrders: MetricData;
  treatmentOrders: MetricData;
};

export type DoctorPerformanceData = {
  doctor: DoctorDetails;
  metrics: DoctorMetrics;
};

export type StaffDetails = {
  id: number;
  name: string;
  role: Role;
  departments: {
    id: number;
    name: string;
  }[];
};

export type StaffMetric = {
  name: string;
  count: number;
  type: "service" | "revenue";
  trend: number;
  trendText: string;
};

export type StaffPerformanceData = {
  staff: StaffDetails;
  metrics: StaffMetric[];
};

export type PerformanceOverviewResponse = {
  totalVisits: MetricData;
  totalRevenue: MetricData;
  completedVisits: MetricData;
  activeStaff: MetricData;
};

export type DoctorPerformanceResponse = {
  data: DoctorPerformanceData[];
};

export type StaffPerformanceResponse = {
  data: StaffPerformanceData[];
};

// Performance comparison interfaces
export type PerformanceComparison = {
  current: number;
  previous: number;
  change: number;
  changePercent: number;
  isPositive: boolean;
};

export type PerformanceRanking = {
  rank: number;
  staffId: number;
  staffName: string;
  value: number;
  category: string;
};

// Chart data interfaces
export type PerformanceChartData = {
  date: string;
  visits: number;
  revenue: number;
  completions: number;
};

// Top performers interfaces
export type TopPerformerData = {
  id: number;
  name: string;
  count?: number;
  revenue?: number;
};

export type TopPerformersResponse = {
  success: boolean;
  data: {
    topByVisits: TopPerformerData[];
    topByRevenue: TopPerformerData[];
  };
  error?: string;
};

// Chart data response
export type ChartDataResponse = {
  success: boolean;
  data: PerformanceChartData[];
  error?: string;
};

// Export data interface
export type ExportDataItem = {
  visitId: number;
  date: string;
  patientName: string;
  doctorName: string;
  department: string;
  status: string;
  totalAmount: number;
  isPaid: boolean;
};

export type ExportDataResponse = {
  success: boolean;
  data: ExportDataItem[];
  error?: string;
};

export type DepartmentPerformanceData = {
  departmentId: number;
  departmentName: string;
  visits: number;
  revenue: number;
  staff: number;
};

// Export interfaces
export type PerformanceExportData = {
  staffName: string;
  role: string;
  department: string;
  totalVisits: number;
  completedVisits: number;
  revenue: number;
  period: string;
  dateRange: string;
};

// Performance alert interfaces
export type PerformanceAlert = {
  id: string;
  staffId: number;
  staffName: string;
  alertType: "low_performance" | "high_performance" | "target_missed";
  message: string;
  value: number;
  threshold: number;
  severity: "low" | "medium" | "high";
  createdAt: Date;
};

// Performance target interfaces
export type PerformanceTarget = {
  id: number;
  staffId: number;
  role: Role;
  targetType: "visits" | "revenue" | "completion_rate";
  targetValue: number;
  period: PerformanceDateRange;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

// Add detailed data interfaces for clickable numbers
export type DetailedVisitData = {
  id: number;
  patientName: string;
  patientPhone?: string;
  date: string;
  status: string;
  department: string;
  doctor: string;
  amount: number;
  examType?: string;
  treatmentType?: string;
};

export type DetailedPaymentData = {
  id: number;
  patientName: string;
  visitId: number;
  date: string;
  amount: number;
  type: string;
  status: string;
  method: string;
};

export type DetailedDataResponse<T> = {
  success: boolean;
  data: T[];
  total: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
  error?: string;
};
