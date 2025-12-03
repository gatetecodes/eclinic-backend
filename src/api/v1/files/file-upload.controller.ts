import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { httpCodes } from "../../../lib/constants";
import { logger } from "../../../lib/logger";
import { uploadToCloudflareR2 } from "../../../services/cloudflare-r2.service";

export const uploadFiles = async (c: Context) => {
  const formData = await c.req.formData();
  const files = formData.getAll("files") as File[];
  if (!files || files.length === 0) {
    return c.json(
      { error: "No files provided" },
      httpCodes.BAD_REQUEST as ContentfulStatusCode
    );
  }
  const workerUrl = process.env.CLOUDFLARE_WORKER_URL;
  const authSecret = process.env.CLOUDFLARE_AUTH_SECRET;
  if (!workerUrl) {
    logger.error("Cloudflare worker URL not found");
    return c.json(
      { error: "Cloudflare worker URL  not found" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
  if (!authSecret) {
    logger.error("Cloudflare auth secret not found");
    return c.json(
      { error: "Cloudflare auth secret not found" },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
  const uploadPromises = files.map((file) => {
    return uploadToCloudflareR2(file, workerUrl, authSecret);
  });
  try {
    const uploadedUrls = await Promise.all(uploadPromises);
    return c.json(
      {
        success: true,
        message: "Files uploaded successfully",
        data: uploadedUrls,
      },
      httpCodes.OK as ContentfulStatusCode
    );
  } catch (error) {
    logger.error("Failed to upload files", {
      error: error instanceof Error ? error.message : "Failed to upload files",
    });
    return c.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to upload files",
      },
      httpCodes.INTERNAL_SERVER_ERROR as ContentfulStatusCode
    );
  }
};
