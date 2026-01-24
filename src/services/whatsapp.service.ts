import { logger } from "@/lib/logger";

export const WhatsAppService = {
  /**
   * Send a WhatsApp message to a recipient using WhatsApp Cloud API
   * @param to - Recipient phone number (with country code, no +)
   * @param message - Message content
   */
  sendMessage: async (to: string, message: string) => {
    const accessToken = process.env.WHATSAPP_CLOUD_API_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const version = "v21.0"; // Use the latest stable version

    if (!accessToken) {
      logger.error("WhatsApp Cloud API credentials missing: Token");
      return { success: false, error: "Credentials missing: Token" };
    }
    if (!phoneNumberId) {
      logger.error("WhatsApp Cloud API credentials missing: ID");
      return { success: false, error: "Credentials missing: ID" };
    }

    // Clean phone number: remove +, spaces, etc.
    const cleanNumber = to.replace(/\D/g, "");

    try {
      const response = await fetch(
        `https://graph.facebook.com/${version}/${phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: cleanNumber,
            type: "text",
            text: {
              preview_url: false,
              body: message,
            },
          }),
        }
      );

      const data = (await response.json()) as {
        messages?: Array<{ id: string }>;
        error?: Record<string, unknown>;
      };

      if (!response.ok) {
        logger.error("WhatsApp Cloud API error response", {
          data,
          to: cleanNumber,
        });
        return { success: false, error: data };
      }

      logger.info("WhatsApp message sent successfully", {
        messageId: data.messages?.[0]?.id,
        to: cleanNumber,
      });
      return { success: true, data };
    } catch (error) {
      logger.error("WhatsApp Cloud API request failed", {
        error,
        to: cleanNumber,
      });
      return { success: false, error };
    }
  },

  /**
   * Send a WhatsApp message using a pre-approved template.
   * Required for initiating conversations or messaging outside the 24h window.
   */
  sendTemplate: async (params: {
    to: string;
    templateName: string;
    languageCode?: string;
    components?: Record<string, unknown>[];
  }) => {
    const {
      to,
      templateName,
      languageCode = "en_US",
      components = [],
    } = params;
    const accessToken = process.env.WHATSAPP_CLOUD_API_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const version = "v21.0";

    if (!(accessToken && phoneNumberId)) {
      logger.error("WhatsApp Cloud API credentials missing");
      return { success: false, error: "Credentials missing" };
    }

    const cleanNumber = to.replace(/\D/g, "");

    try {
      const response = await fetch(
        `https://graph.facebook.com/${version}/${phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: cleanNumber,
            type: "template",
            template: {
              name: templateName,
              language: {
                code: languageCode,
              },
              components,
            },
          }),
        }
      );

      const data = (await response.json()) as {
        messages?: Array<{ id: string }>;
        error?: Record<string, unknown>;
      };

      if (!response.ok) {
        logger.error("WhatsApp Template API error response", {
          data,
          to: cleanNumber,
          template: templateName,
        });
        return { success: false, error: data };
      }

      logger.info("WhatsApp template sent successfully", {
        messageId: data.messages?.[0]?.id,
        to: cleanNumber,
        template: templateName,
      });
      return { success: true, data };
    } catch (error) {
      logger.error("WhatsApp Template API request failed", {
        error,
        to: cleanNumber,
      });
      return { success: false, error };
    }
  },
};
