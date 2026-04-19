export const SUPPORTED_LOCALES = ["en", "fr"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = "en";
export const LOCALE_COOKIE_NAME = "eclinic_locale";
export const LOCALE_HEADER_NAME = "x-locale";

export function isSupportedLocale(value: string): value is SupportedLocale {
  return SUPPORTED_LOCALES.includes(value as SupportedLocale);
}

export function normalizeLocale(
  value?: string | null
): SupportedLocale | undefined {
  if (!value) {
    return;
  }

  const normalized = value.trim().toLowerCase().replace("_", "-");
  if (!normalized) {
    return;
  }

  const [language] = normalized.split("-");
  if (language && isSupportedLocale(language)) {
    return language;
  }

  return;
}

export function parseAcceptLanguage(
  header?: string | null
): SupportedLocale | undefined {
  if (!header) {
    return;
  }

  const candidates = header
    .split(",")
    .map((part) => {
      const [tag, qValue] = part.trim().split(";q=");
      const quality = qValue ? Number.parseFloat(qValue) : 1;
      return {
        locale: normalizeLocale(tag),
        quality: Number.isFinite(quality) ? quality : 0,
      };
    })
    .filter(
      (candidate): candidate is { locale: SupportedLocale; quality: number } =>
        Boolean(candidate.locale) && candidate.quality > 0
    )
    .sort((left, right) => right.quality - left.quality);

  return candidates[0]?.locale;
}

export function prefixLocalePath(
  locale: SupportedLocale,
  pathname: string
): string {
  if (pathname === "/") {
    return `/${locale}`;
  }

  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `/${locale}${normalizedPath}`;
}
