import fs from "node:fs";
import path from "node:path";
import handlebars from "handlebars";
import { Resend } from "resend";
import { logger } from "../lib/logger";

if (!process.env.RESEND_API_KEY) {
  throw new Error("RESEND_API_KEY is not set");
}

const resend = new Resend(process.env.RESEND_API_KEY);

type ResendEmailOptions = {
  to: string | string[];
  subject: string;
  template: string;
  context: Record<string, unknown>;
  cc?: string[];
  bcc?: string[];
  attachments?: Array<{
    filename: string;
    content: Buffer;
  }>;
  tags?: Array<{
    name: string;
    value: string;
  }>;
};

/**
 * Compile Handlebars template
 */
const compileTemplate = async (
  templateName: string,
  context: Record<string, unknown>
): Promise<string> => {
  try {
    const candidates = [
      process.env.EMAIL_TEMPLATES_DIR,
      path.resolve(process.cwd(), "dist/templates"),
      path.resolve(process.cwd(), "src/templates"),
      path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        "../templates"
      ),
    ].filter(Boolean) as string[];

    for (const dir of candidates) {
      const fp = path.join(dir, `${templateName}.hbs`);

      if (fs.existsSync(fp)) {
        const source = await fs.promises.readFile(fp, "utf-8");

        const template = handlebars.compile(source);

        return template(context);
      }
    }

    throw new Error("Template not found in any known directory");
  } catch (error) {
    logger.error("Failed to compile email template", {
      error,
      data: { templateName, context },
    });

    throw new Error("Failed to compile email template");
  }
};

/**
 * Send email using Resend API with enhanced features
 */
export const sendEmail = async ({
  to,
  subject,
  template,
  context,
  cc,
  bcc,
  attachments,
  tags,
}: ResendEmailOptions): Promise<void> => {
  try {
    const html = await compileTemplate(template, context);

    if (!(process.env.EMAIL_FROM_NAME && process.env.EMAIL_FROM_ADDRESS)) {
      throw new Error("EMAIL_FROM_NAME/EMAIL_FROM_ADDRESS not set");
    }

    const emailData = {
      from: `${process.env.EMAIL_FROM_NAME} <${process.env.EMAIL_FROM_ADDRESS}>`,
      to: Array.isArray(to) ? to : [to],
      cc,
      bcc,
      subject,
      html,
      attachments,
      tags,
    };

    const result = await resend.emails.send(emailData);

    if (result.error) {
      throw new Error(`Resend API error: ${result.error.message}`);
    }

    logger.info("Email sent", {
      event: "EMAIL_SENT",
      data: { to, subject, template },
    });
  } catch (error) {
    logger.error("Failed to send email with Resend", {
      error,
      data: { to, subject, template },
    });
    throw new Error("Failed to send email with Resend");
  }
};

/**
 * Send batch emails efficiently
 */
export const sendBatchEmails = async (
  emails: ResendEmailOptions[]
): Promise<void> => {
  try {
    const emailPromises = emails.map((email) => sendEmail(email));
    await Promise.all(emailPromises);

    logger.info("Batch emails sent", {
      event: "EMAIL_SENT",
      data: { batchSize: emails.length },
    });
  } catch (error) {
    logger.error("Failed to send batch emails", {
      error,
      data: { batchSize: emails.length },
    });
    throw new Error("Failed to send batch emails");
  }
};
