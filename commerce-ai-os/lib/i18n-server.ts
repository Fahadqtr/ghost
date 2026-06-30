import "server-only";
import { cookies } from "next/headers";
import { LOCALE_COOKIE, parseLocale, makeT, type Locale } from "@/lib/i18n";

// Server-side current locale (from the `locale` cookie) + a bound translator.
export async function getLocale(): Promise<Locale> {
  try {
    return parseLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  } catch {
    return "ar";
  }
}

export async function getT() {
  const locale = await getLocale();
  return { locale, t: makeT(locale) };
}
