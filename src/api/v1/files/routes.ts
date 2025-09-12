import { Hono } from "hono";

const router = new Hono();

router.post("/upload", async (c) => {
  try {
    return c.json({ message: "File upload endpoint - to be implemented" });
  } catch (error) {
    console.error("File upload error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

export default router;
