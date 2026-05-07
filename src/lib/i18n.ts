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
  "auth.resetPasswordSubject": "Reset your password",
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
  "email.reset.previewTitle": "Reset your CareLogic password",
  "email.reset.logoAlt": "CareLogic logo",
  "email.reset.title": "Reset your password",
  "email.reset.intro":
    "We received a request to reset your password. Use the button below to set a new password.",
  "email.reset.button": "Reset password",
  "email.reset.fallback":
    "If the button does not work, copy and paste this link into your browser:",
  "email.reset.ignore":
    "If you did not request this change, you can safely ignore this email.",
  "email.reset.signature": "Thanks,",
  "email.reset.team": "The CareLogic Team",
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
  "common.unauthorized": "Non autorisé",
  "common.forbidden": "Interdit",
  "common.notFound": "Introuvable",
  "common.internalServerError": "Une erreur s'est produite",
  "common.validationFailed": "La validation a échoué",
  "common.invalidData": "Données invalides",
  "common.invalidId": "ID invalide",
  "common.invalidUserId": "ID utilisateur invalide",
  "common.localeUpdated": "La langue a été mise à jour avec succès.",
  "errors.uniqueConstraintViolation":
    "Un enregistrement avec la même valeur unique existe déjà",
  "errors.tenantNotFound": "Locataire introuvable",
  "errors.featureDisabled":
    "Cette fonctionnalité n'est pas activée pour votre clinique",
  "errors.quotaExceeded":
    "Votre clinique a atteint le quota pour cette fonctionnalité",
  "errors.rbacDenied":
    "Vous n'avez pas l'autorisation d'effectuer cette action",
  "validation.required": "Ce champ est obligatoire",
  "validation.invalidType": "Valeur invalide",
  "validation.invalidEmail": "Veuillez saisir une adresse email valide",
  "validation.invalidFormat": "Format invalide",
  "validation.tooSmall.string": "Doit contenir au moins {minimum} caractères",
  "validation.tooSmall.array":
    "Veuillez sélectionner au moins {minimum} élément(s)",
  "validation.tooSmall.number": "Doit être au moins égal à {minimum}",
  "validation.tooBig.string": "Doit contenir au maximum {maximum} caractères",
  "validation.tooBig.array":
    "Veuillez sélectionner au maximum {maximum} élément(s)",
  "validation.tooBig.number": "Doit être au maximum égal à {maximum}",
  "validation.timeFormat": "L'heure doit être au format HH:mm",
  "validation.startEndRequired":
    "Les heures de début et de fin doivent être toutes les deux renseignées ou toutes les deux vides.",
  "validation.endAfterStartSameDay":
    "L'heure de fin doit être postérieure à l'heure de début le même jour.",
  "validation.nurseEducationRequired":
    "Le niveau d'études est obligatoire pour les infirmiers",
  "validation.passwordMinOrEmpty":
    "Le mot de passe doit contenir au moins 8 caractères ou être vide",
  "validation.dayRequired": "Au moins un jour de la semaine doit être spécifié",
  "validation.endAfterStart":
    "L'heure de fin doit être postérieure à l'heure de début",
  "validation.workingExceptionTimes":
    "Les exceptions de travail doivent inclure une heure de début et de fin",
  "users.resendVerificationIfExists":
    "Si cet email existe, un nouveau lien de vérification a été envoyé.",
  "users.preferencesUpdated": "La langue a été mise à jour avec succès.",
  "users.userNotFound": "Utilisateur introuvable",
  "auth.verifyAccountSubject": "Vérifiez votre compte",
  "auth.resetPasswordSubject": "Réinitialisez votre mot de passe",
  "email.verification.previewTitle": "Vérifiez votre compte CareLogic",
  "email.verification.logoAlt": "Logo CareLogic",
  "email.verification.title": "Vérifiez votre adresse email",
  "email.verification.intro":
    "Merci d'avoir rejoint CareLogic. Veuillez confirmer votre adresse email pour activer votre compte.",
  "email.verification.button": "Vérifier l'email",
  "email.verification.fallback":
    "Si le bouton ne fonctionne pas, copiez et collez ce lien dans votre navigateur :",
  "email.verification.ignore":
    "Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet email en toute sécurité et votre compte ne sera pas activé.",
  "email.verification.signature": "Merci,",
  "email.verification.team": "L'équipe CareLogic",
  "email.reset.previewTitle": "Réinitialisez votre mot de passe CareLogic",
  "email.reset.logoAlt": "Logo CareLogic",
  "email.reset.title": "Réinitialisez votre mot de passe",
  "email.reset.intro":
    "Nous avons reçu une demande de réinitialisation de mot de passe. Utilisez le bouton ci-dessous pour définir un nouveau mot de passe.",
  "email.reset.button": "Réinitialiser le mot de passe",
  "email.reset.fallback":
    "Si le bouton ne fonctionne pas, copiez et collez ce lien dans votre navigateur :",
  "email.reset.ignore":
    "Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet email en toute sécurité.",
  "email.reset.signature": "Merci,",
  "email.reset.team": "L'équipe CareLogic",
  "demo.requestCreated":
    "La demande de démonstration a été créée avec succès. Nous vous recontacterons bientôt.",
  "demo.requestsFetched":
    "Les demandes de démonstration ont été récupérées avec succès",
  "demo.requestApproved":
    "La demande de démonstration a été approuvée avec succès",
  "demo.requestRejected":
    "La demande de démonstration a été rejetée avec succès",
  "demo.requestApprovedSubject": "Demande de démonstration approuvée",
  "email.demo.previewTitle": "Demande de démonstration approuvée !",
  "email.demo.title": "Demande de démonstration approuvée !",
  "email.demo.greeting": "Madame, Monsieur,",
  "email.demo.body":
    "Votre demande de démonstration CareLogic pour {clinicName} a été approuvée.",
  "email.demo.next":
    "Nous vous contacterons pour vous communiquer les prochaines étapes.",
  "email.demo.thanks": "Merci d'utiliser CareLogic.",
  "email.demo.questions":
    "Si vous avez des questions, n'hésitez pas à nous contacter directement :",
  "email.demo.phone": "Téléphone/WhatsApp",
  "email.demo.email": "Email",
  "email.demo.signature": "Cordialement,",
  "email.demo.team": "L'équipe CareLogic",
  "email.inventory.previewTitle": "Lots d'inventaire bientôt expirés",
  "email.inventory.logoAlt": "Logo CareLogic",
  "email.inventory.greeting": "Bonjour,",
  "email.inventory.title": "Lots d'inventaire bientôt expirés",
  "email.inventory.clinicLabel": "Clinique",
  "email.inventory.intro":
    "Les lots suivants arriveront à expiration dans moins d'un mois. Veuillez les vérifier et les éliminer si nécessaire.",
  "email.inventory.item": "Article",
  "email.inventory.batch": "Lot",
  "email.inventory.expiryDate": "Date d'expiration",
  "email.inventory.daysRemaining": "Jours restants",
  "email.inventory.quantity": "Qté",
  "email.inventory.footer":
    "Ce rappel continuera chaque semaine jusqu'à l'élimination du lot ou à la prolongation de sa date d'expiration.",
  "email.inventory.signature": "Merci,",
  "email.inventory.team": "L'équipe CareLogic",
  "email.inventory.subject": "Lots d'inventaire bientôt expirés",
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
