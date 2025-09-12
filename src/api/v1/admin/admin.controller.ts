import { type Context } from "hono";
import { db } from "../../../database/db";

export const getStats = async (c: Context) => {
  try {
    const [totalClinics, totalUsers, totalPatients, totalVisits, totalRevenue] =
      await Promise.all([
        db.clinic.count(),
        db.user.count(),
        db.patient.count(),
        db.visit.count(),
        db.payment.aggregate({ _sum: { amount: true } }),
      ]);

    return c.json({
      data: {
        totalClinics,
        totalUsers,
        totalPatients,
        totalVisits,
        totalRevenue: totalRevenue._sum.amount || 0,
      },
    });
  } catch (error) {
    console.error("Get admin stats error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};
