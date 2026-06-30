// Lightweight cookie-based i18n (no route restructuring). A `locale` cookie
// ("ar" | "en") drives <html lang/dir> and a small key→{ar,en} dictionary.
// Server components read the cookie via next/headers; client components get the
// locale passed down from the app shell.

export type Locale = "ar" | "en";
export const DEFAULT_LOCALE: Locale = "ar";
export const LOCALE_COOKIE = "locale";

export function parseLocale(v: string | undefined | null): Locale {
  return v === "en" ? "en" : "ar";
}
export function dirOf(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

// UI strings shared across the shell + common pages. Page-specific copy is
// translated in waves; missing keys fall back to Arabic then the key itself.
type Entry = { ar: string; en: string };
export const DICT: Record<string, Entry> = {
  "app.signOut": { ar: "تسجيل الخروج", en: "Sign out" },
  "app.openMenu": { ar: "فتح القائمة", en: "Open menu" },
  "app.language": { ar: "اللغة", en: "Language" },
  "lang.ar": { ar: "العربية", en: "Arabic" },
  "lang.en": { ar: "الإنجليزية", en: "English" },

  // Login
  "login.staffEntry": { ar: "دخول الموظفين · إدخال/إخراج المنتجات", en: "Employees · stock in / out" },
  "login.staffHint": { ar: "للموظفين — بدون حساب، بالرمز فقط", en: "For employees — no account, code only" },
  "login.internalNote": { ar: "أداة داخلية · الحسابات يُنشئها المالك في Supabase.", en: "Internal tool · accounts are created in Supabase by the owner." },
};

export function makeT(locale: Locale) {
  return (key: string, fallback?: string): string => {
    const e = DICT[key];
    if (e) return e[locale] ?? e.ar;
    return fallback ?? key;
  };
}
