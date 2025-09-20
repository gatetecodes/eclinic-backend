import { z } from "zod";

export const fileUploadSchema = z.object({
  files: z.array(z.instanceof(File)).min(1, "At least one file is required"),
});
