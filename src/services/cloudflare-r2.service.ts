import { randomUUID } from "crypto";
import { logger } from "../lib/logger";

const TRAILING_SLASH_REGEX = /\/$/;

/**
 * Uploads a file to a Cloudflare R2 worker using a PUT request,
 * mirroring the Express/Axios logic.
 *
 * @param file The file to upload.
 * @returns The full URL of the uploaded file.
 * @throws If the upload fails or the worker returns an error.
 */
export async function uploadToCloudflareR2(
  file: File,
  workerUrl: string,
  authSecret: string
): Promise<string> {
  if (!workerUrl) {
    throw new Error("Cloudflare worker URL must be provided.");
  }
  if (!authSecret) {
    throw new Error("Auth secret must be provided.");
  }
  if (!file) {
    throw new Error("File must be provided.");
  }

  // --- Filename Generation ---
  const originalname = file.name;
  // Basic extension extraction (consider edge cases if necessary)
  const extension = originalname.includes(".")
    ? `.${originalname.split(".").pop()}`
    : "";
  // Basic basename extraction
  const basename = extension
    ? originalname.slice(0, originalname.length - extension.length)
    : originalname;
  // Sanitize the base name: replace non-alphanumeric characters with hyphens
  const sanitizedName = basename.replace(/[^a-zA-Z0-9]/g, "-");
  // Create the final filename
  const filename = `${randomUUID()}-${sanitizedName}${extension}`;
  // --- End Filename Generation ---

  // Construct the full URL for the PUT request
  // Ensure workerUrl doesn't end with a slash, and filename doesn't start with one
  const uploadUrl = `${workerUrl.replace(TRAILING_SLASH_REGEX, "")}/${filename}`;

  try {
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${authSecret}`,
        // Set Content-Type based on the file's type
        "Content-Type": file.type || "application/octet-stream", // Provide a default fallback
      },
      // Send the file directly as the body
      // fetch handles File/Blob bodies correctly for PUT/POST
      body: file,
    });

    if (!response.ok) {
      // Attempt to get more detailed error info if available
      let errorDetails = "";
      try {
        errorDetails = await response.text();
      } catch (_) {
        // Ignore if reading the body fails
      }
      throw new Error(
        `Failed to upload file '${filename}': ${response.status} ${response.statusText}. ${errorDetails}`.trim()
      );
    }

    // If the PUT request is successful, return the constructed URL
    return uploadUrl;
  } catch (error) {
    logger.error(`Error uploading '${filename}' to Cloudflare R2:`, {
      error,
    });
    if (error instanceof Error) {
      throw error; // Re-throw the specific error
    }
    throw new Error("An unknown error occurred during file upload.");
  }
}
