import type { ZodIssue } from "zod";
import { DEFAULT_LOCALE, normalizeLocale } from "@/lib/locale";

const en = {
  "common.unauthorized": "Unauthorized",
  "common.forbidden": "Forbidden",
  "common.notFound": "Not Found",
  "common.internalServerError": "Something went wrong",
  "common.validationFailed": "Validation failed",
  "common.invalidData": "Invalid data",
  "common.invalidId": "Invalid ID",
  "common.invalidUserId": "Invalid user ID",
  "common.localeUpdated": "Language preference updated successfully.",
  "errors.uniqueConstraintViolation":
    "A record with the same unique value already exists",
  "errors.tenantNotFound": "Tenant not found",
  "errors.featureDisabled": "This feature is not enabled for your clinic",
  "errors.quotaExceeded": "Your clinic has reached its quota for this feature",
  "errors.rbacDenied": "You do not have permission to perform this action",
  "validation.required": "This field is required",
  "validation.invalidType": "Invalid value",
  "validation.invalidEmail": "Please enter a valid email address",
  "validation.invalidFormat": "Invalid format",
  "validation.tooSmall.string": "Must be at least {minimum} characters",
  "validation.tooSmall.array": "Select at least {minimum} item(s)",
  "validation.tooSmall.number": "Must be at least {minimum}",
  "validation.tooBig.string": "Must be at most {maximum} characters",
  "validation.tooBig.array": "Select at most {maximum} item(s)",
  "validation.tooBig.number": "Must be at most {maximum}",
  "validation.timeFormat": "Time must be in HH:mm format",
  "validation.startEndRequired":
    "Both start and end times must be provided, or both empty.",
  "validation.endAfterStartSameDay":
    "End time must be after start time on the same day.",
  "validation.nurseEducationRequired":
    "Highest education is required for nurses",
  "validation.passwordMinOrEmpty":
    "Password must be at least 8 characters or empty",
  "validation.dayRequired": "At least one day of week must be specified",
  "validation.endAfterStart": "End time must be after start time",
  "validation.workingExceptionTimes":
    "Working exceptions must include start and end times",
  "users.resendVerificationIfExists":
    "If this email exists, a new verification link has been sent.",
  "users.preferencesUpdated": "Language preference updated successfully.",
  "users.userNotFound": "User not found",
  "auth.verifyAccountSubject": "Verify your account",
  "email.verification.previewTitle": "Verify your CareLogic account",
  "email.verification.logoAlt": "CareLogic logo",
  "email.verification.title": "Verify your email address",
  "email.verification.intro":
    "Thanks for joining CareLogic. Please confirm your email address to activate your account.",
  "email.verification.button": "Verify email",
  "email.verification.fallback":
    "If the button does not work, copy and paste this link into your browser:",
  "email.verification.ignore":
    "If you did not request this, you can safely ignore this email and your account will not be activated.",
  "email.verification.signature": "Thanks,",
  "email.verification.team": "The CareLogic Team",
  "demo.requestCreated":
    "Demo request created successfully. We will get back to you soon.",
  "demo.requestsFetched": "Demo requests fetched successfully",
  "demo.requestApproved": "Demo request approved successfully",
  "demo.requestRejected": "Demo request rejected successfully",
  "demo.requestApprovedSubject": "Demo Request Approved",
  "email.demo.previewTitle": "Demo Request Approved!",
  "email.demo.title": "Demo Request Approved!",
  "email.demo.greeting": "Dear sir/madam,",
  "email.demo.body":
    "Your CareLogic demo request at {clinicName} has been approved.",
  "email.demo.next": "We will contact you for further details.",
  "email.demo.thanks": "Thank you for using CareLogic.",
  "email.demo.questions":
    "If you have any questions, please feel free to contact us directly at:",
  "email.demo.phone": "Phone/WhatsApp",
  "email.demo.email": "Email",
  "email.demo.signature": "Best regards,",
  "email.demo.team": "The CareLogic Team",
  "email.inventory.previewTitle": "Inventory batches expiring soon",
  "email.inventory.logoAlt": "CareLogic Logo",
  "email.inventory.greeting": "Hello,",
  "email.inventory.title": "Inventory batches expiring soon",
  "email.inventory.clinicLabel": "Clinic",
  "email.inventory.intro":
    "The following batches are within one month of their expiration date. Please review and dispose of them when appropriate.",
  "email.inventory.item": "Item",
  "email.inventory.batch": "Batch",
  "email.inventory.expiryDate": "Expiry Date",
  "email.inventory.daysRemaining": "Days Remaining",
  "email.inventory.quantity": "Qty",
  "email.inventory.footer":
    "This reminder will continue weekly until the batch is disposed of or the expiry date is extended.",
  "email.inventory.signature": "Thanks,",
  "email.inventory.team": "The CareLogic Team",
  "email.inventory.subject": "Inventory batches expiring soon",
  "dashboard.stats.trend.sameAsYesterday": "Same as yesterday",
  "dashboard.stats.trend.lessThanYesterday": "Less than yesterday",
  "dashboard.stats.trend.moreThanYesterday": "More than yesterday",
} as const;

const fr: Record<keyof typeof en, string> = {
  "common.unauthorized": "Non autorise",
  "common.forbidden": "Interdit",
  "common.notFound": "Introuvable",
  "common.internalServerError": "Une erreur s'est produite",
  "common.validationFailed": "La validation a echoue",
  "common.invalidData": "Donnees invalides",
  "common.invalidId": "ID invalide",
  "common.invalidUserId": "ID utilisateur invalide",
  "common.localeUpdated": "La langue a ete mise a jour avec succes.",
  "errors.uniqueConstraintViolation":
    "Un enregistrement avec la meme valeur unique existe deja",
  "errors.tenantNotFound": "Locataire introuvable",
  "errors.featureDisabled":
    "Cette fonctionnalite n'est pas activee pour votre clinique",
  "errors.quotaExceeded":
    "Votre clinique a atteint le quota pour cette fonctionnalite",
  "errors.rbacDenied":
    "Vous n'avez pas l'autorisation d'effectuer cette action",
  "validation.required": "Ce champ est obligatoire",
  "validation.invalidType": "Valeur invalide",
  "validation.invalidEmail": "Veuillez saisir une adresse email valide",
  "validation.invalidFormat": "Format invalide",
  "validation.tooSmall.string": "Doit contenir au moins {minimum} caracteres",
  "validation.tooSmall.array":
    "Veuillez selectionner au moins {minimum} element(s)",
  "validation.tooSmall.number": "Doit etre au moins egal a {minimum}",
  "validation.tooBig.string": "Doit contenir au maximum {maximum} caracteres",
  "validation.tooBig.array":
    "Veuillez selectionner au maximum {maximum} element(s)",
  "validation.tooBig.number": "Doit etre au maximum egal a {maximum}",
  "validation.timeFormat": "L'heure doit etre au format HH:mm",
  "validation.startEndRequired":
    "Les heures de debut et de fin doivent etre toutes les deux renseignees ou toutes les deux vides.",
  "validation.endAfterStartSameDay":
    "L'heure de fin doit etre posterieure a l'heure de debut le meme jour.",
  "validation.nurseEducationRequired":
    "Le niveau d'etudes est obligatoire pour les infirmiers",
  "validation.passwordMinOrEmpty":
    "Le mot de passe doit contenir au moins 8 caracteres ou etre vide",
  "validation.dayRequired": "Au moins un jour de la semaine doit etre specifie",
  "validation.endAfterStart":
    "L'heure de fin doit etre posterieure a l'heure de debut",
  "validation.workingExceptionTimes":
    "Les exceptions de travail doivent inclure une heure de debut et de fin",
  "users.resendVerificationIfExists":
    "Si cet email existe, un nouveau lien de verification a ete envoye.",
  "users.preferencesUpdated": "La langue a ete mise a jour avec succes.",
  "users.userNotFound": "Utilisateur introuvable",
  "auth.verifyAccountSubject": "Verifiez votre compte",
  "email.verification.previewTitle": "Verifiez votre compte CareLogic",
  "email.verification.logoAlt": "Logo CareLogic",
  "email.verification.title": "Verifiez votre adresse email",
  "email.verification.intro":
    "Merci d'avoir rejoint CareLogic. Veuillez confirmer votre adresse email pour activer votre compte.",
  "email.verification.button": "Verifier l'email",
  "email.verification.fallback":
    "Si le bouton ne fonctionne pas, copiez et collez ce lien dans votre navigateur :",
  "email.verification.ignore":
    "Si vous n'etes pas a l'origine de cette demande, vous pouvez ignorer cet email en toute securite et votre compte ne sera pas active.",
  "email.verification.signature": "Merci,",
  "email.verification.team": "L'equipe CareLogic",
  "demo.requestCreated":
    "La demande de demonstration a ete creee avec succes. Nous vous recontacterons bientot.",
  "demo.requestsFetched":
    "Les demandes de demonstration ont ete recuperees avec succes",
  "demo.requestApproved":
    "La demande de demonstration a ete approuvee avec succes",
  "demo.requestRejected":
    "La demande de demonstration a ete rejetee avec succes",
  "demo.requestApprovedSubject": "Demande de demonstration approuvee",
  "email.demo.previewTitle": "Demande de demonstration approuvee !",
  "email.demo.title": "Demande de demonstration approuvee !",
  "email.demo.greeting": "Madame, Monsieur,",
  "email.demo.body":
    "Votre demande de demonstration CareLogic pour {clinicName} a ete approuvee.",
  "email.demo.next":
    "Nous vous contacterons pour vous communiquer les prochaines etapes.",
  "email.demo.thanks": "Merci d'utiliser CareLogic.",
  "email.demo.questions":
    "Si vous avez des questions, n'hesitez pas a nous contacter directement :",
  "email.demo.phone": "Telephone/WhatsApp",
  "email.demo.email": "Email",
  "email.demo.signature": "Cordialement,",
  "email.demo.team": "L'equipe CareLogic",
  "email.inventory.previewTitle": "Lots d'inventaire bientot expires",
  "email.inventory.logoAlt": "Logo CareLogic",
  "email.inventory.greeting": "Bonjour,",
  "email.inventory.title": "Lots d'inventaire bientot expires",
  "email.inventory.clinicLabel": "Clinique",
  "email.inventory.intro":
    "Les lots suivants arriveront a expiration dans moins d'un mois. Veuillez les verifier et les eliminer si necessaire.",
  "email.inventory.item": "Article",
  "email.inventory.batch": "Lot",
  "email.inventory.expiryDate": "Date d'expiration",
  "email.inventory.daysRemaining": "Jours restants",
  "email.inventory.quantity": "Qt",
  "email.inventory.footer":
    "Ce rappel continuera chaque semaine jusqu'a l'elimination du lot ou a la prolongation de sa date d'expiration.",
  "email.inventory.signature": "Merci,",
  "email.inventory.team": "L'equipe CareLogic",
  "email.inventory.subject": "Lots d'inventaire bientot expires",
  "dashboard.stats.trend.sameAsYesterday": "Pareil que hier",
  "dashboard.stats.trend.lessThanYesterday": "Moins que hier",
  "dashboard.stats.trend.moreThanYesterday": "Plus que hier",
};

const catalogs = {
  en,
  fr,
} as const;

export type TranslationKey = keyof typeof en;
export type TranslationValues = Record<
  string,
  string | number | boolean | null | undefined
>;
export type Translator = (
  key: TranslationKey,
  values?: TranslationValues
) => string;

const literalMessageMap: Record<string, TranslationKey> = {
  "Time must be in HH:mm format": "validation.timeFormat",
  "Both start and end times must be provided, or both empty.":
    "validation.startEndRequired",
  "End time must be after start time on the same day.":
    "validation.endAfterStartSameDay",
  "Highest education is required for nurses":
    "validation.nurseEducationRequired",
  "Password must be at least 8 characters or empty":
    "validation.passwordMinOrEmpty",
  "At least one day of week must be specified": "validation.dayRequired",
  "End time must be after start time": "validation.endAfterStart",
  "Working exceptions must include start and end times":
    "validation.workingExceptionTimes",
};

function formatMessage(template: string, values?: TranslationValues): string {
  if (!values) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (_match, key) => {
    const value = values[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

export function getCatalog(locale?: string | null) {
  const normalized = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  return catalogs[normalized];
}

export function translate(
  locale: string | null | undefined,
  key: TranslationKey,
  values?: TranslationValues
): string {
  const catalog = getCatalog(locale);
  const template = catalog[key] ?? catalogs[DEFAULT_LOCALE][key];
  return formatMessage(template, values);
}

export function createTranslator(locale?: string | null): Translator {
  const resolvedLocale = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  return (key, values) => translate(resolvedLocale, key, values);
}

export function translateLiteralMessage(
  locale: string | null | undefined,
  message?: string
): string | undefined {
  if (!message) {
    return;
  }

  const key = literalMessageMap[message];
  if (!key) {
    return message;
  }

  return translate(locale, key);
}

//biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <>
export function translateZodIssue(
  locale: string | null | undefined,
  issue: ZodIssue
): string {
  const issueMeta = issue as ZodIssue & {
    minimum?: number;
    maximum?: number;
    received?: string;
    expected?: string;
    origin?: string;
    type?: string;
    format?: string;
  };

  if (issue.code === "invalid_type" && issueMeta.received === "undefined") {
    return translate(locale, "validation.required");
  }

  if (issue.code === "invalid_format" && issueMeta.format === "email") {
    return translate(locale, "validation.invalidEmail");
  }

  if (issue.code === "too_small") {
    const origin = issueMeta.origin ?? issueMeta.type;
    if (origin === "string") {
      return translate(locale, "validation.tooSmall.string", {
        minimum: issueMeta.minimum ?? "",
      });
    }
    if (origin === "array") {
      return translate(locale, "validation.tooSmall.array", {
        minimum: issueMeta.minimum ?? "",
      });
    }
    if (origin === "number") {
      return translate(locale, "validation.tooSmall.number", {
        minimum: issueMeta.minimum ?? "",
      });
    }
  }

  if (issue.code === "too_big") {
    const origin = issueMeta.origin ?? issueMeta.type;
    if (origin === "string") {
      return translate(locale, "validation.tooBig.string", {
        maximum: issueMeta.maximum ?? "",
      });
    }
    if (origin === "array") {
      return translate(locale, "validation.tooBig.array", {
        maximum: issueMeta.maximum ?? "",
      });
    }
    if (origin === "number") {
      return translate(locale, "validation.tooBig.number", {
        maximum: issueMeta.maximum ?? "",
      });
    }
  }

  return (
    translateLiteralMessage(locale, issue.message) ??
    translate(locale, "validation.invalidType")
  );
}
