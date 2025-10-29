import { Hono } from "hono";
import { validate } from "../../../middlewares/validation.middleware";
import { uploadFiles } from "./file-upload.controller";
import { fileUploadSchema } from "./file-upload.validation";

const router = new Hono();

router.post("/upload", validate(fileUploadSchema, "json"), uploadFiles);

export default router;
