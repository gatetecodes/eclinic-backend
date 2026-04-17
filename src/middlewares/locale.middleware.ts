import type { MiddlewareHandler } from "hono";
import { db } from "@/database/db";
import { createTranslator } from "@/lib/i18n";
import {
  DEFAULT_LOCALE,
  LOCALE_HEADER_NAME,
  normalizeLocale,
  parseAcceptLanguage,
  type SupportedLocale,
} from "@/lib/locale";
import type { AppEnv } from "./auth.middleware";

type LocaleSource =
  | "default"
  | "header"
  | "accept-language"
  | "user-preference"
  | "clinic-default";

function resolveRequestedLocale(c: Parameters<MiddlewareHandler<AppEnv>>[0]) {
  const explicitLocale = normalizeLocale(c.req.header(LOCALE_HEADER_NAME));
  if (explicitLocale) {
    return {
      locale: explicitLocale,
      source: "header" as const,
    };
  }

  const acceptLanguageLocale = parseAcceptLanguage(
    c.req.header("accept-language")
  );
  if (acceptLanguageLocale) {
    return {
      locale: acceptLanguageLocale,
      source: "accept-language" as const,
    };
  }

  return {
    locale: DEFAULT_LOCALE,
    source: "default" as const,
  };
}

function setLocaleContext(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  locale: SupportedLocale,
  source: LocaleSource
) {
  c.set("locale", locale);
  c.set("localeSource", source);
  c.set("t", createTranslator(locale));
  c.header("Content-Language", locale);
}

export const initializeLocaleContext: MiddlewareHandler<AppEnv> = async (
  c,
  next
) => {
  const resolved = resolveRequestedLocale(c);
  setLocaleContext(c, resolved.locale, resolved.source);
  await next();
};

export const finalizeLocaleContext: MiddlewareHandler<AppEnv> = async (
  c,
  next
) => {
  const currentLocale = c.get("locale") ?? DEFAULT_LOCALE;
  const localeSource = c.get("localeSource") ?? "default";

  if (localeSource === "header" || localeSource === "accept-language") {
    setLocaleContext(c, currentLocale, localeSource);
    await next();
    return;
  }

  const user = c.get("user");
  const userId = Number(user?.id);

  if (Number.isFinite(userId) && userId > 0) {
    const localeRow = await db.user.findUnique({
      where: { id: userId },
      select: {
        preferredLocale: true,
        clinicId: true,
      },
    });

    const preferredLocale = normalizeLocale(localeRow?.preferredLocale);
    if (preferredLocale) {
      setLocaleContext(c, preferredLocale, "user-preference");
      await next();
      return;
    }

    if (localeRow?.clinicId) {
      const clinic = await db.clinic.findUnique({
        where: { id: localeRow.clinicId },
        select: {
          defaultLocale: true,
        },
      });

      const clinicLocale = normalizeLocale(clinic?.defaultLocale);
      if (clinicLocale) {
        setLocaleContext(c, clinicLocale, "clinic-default");
        await next();
        return;
      }
    }
  }

  setLocaleContext(c, currentLocale, localeSource);
  await next();
};
