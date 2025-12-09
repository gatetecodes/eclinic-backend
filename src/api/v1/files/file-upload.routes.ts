import { Hono } from "hono";
import { uploadFiles } from "./file-upload.controller";

const router = new Hono();

// File uploads use multipart/form-data, not JSON, so we skip validation middleware
// The controller validates files directly from formData
router.post("/upload", uploadFiles);

export default router;
