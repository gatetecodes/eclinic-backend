type RecaptchaApiResponse = {
  success: boolean;
  score?: number;
  action?: string;
  "error-codes"?: string[];
};

export type RecaptchaVerificationResult = {
  success: boolean;
  score?: number;
  action?: string;
  errors?: string[];
};

const RECAPTCHA_VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";

export const verifyRecaptchaToken = async (
  token: string,
  remoteIp?: string | null
): Promise<RecaptchaVerificationResult> => {
  if (!process.env.RECAPTCHA_ECLINIC_SECRET) {
    return {
      success: false,
      errors: ["missing_secret"],
    };
  }

  const params = new URLSearchParams();
  params.set("secret", process.env.RECAPTCHA_ECLINIC_SECRET);
  params.set("response", token);

  if (remoteIp) {
    params.set("remoteip", remoteIp);
  }

  try {
    const response = await fetch(RECAPTCHA_VERIFY_URL, {
      method: "POST",
      body: params,
    });

    if (!response.ok) {
      return {
        success: false,
        errors: ["recaptcha_unreachable"],
      };
    }

    const data = (await response.json()) as RecaptchaApiResponse;

    return {
      success: data.success,
      score: data.score,
      action: data.action,
      errors: data["error-codes"],
    };
  } catch {
    return {
      success: false,
      errors: ["recaptcha_error"],
    };
  }
};
