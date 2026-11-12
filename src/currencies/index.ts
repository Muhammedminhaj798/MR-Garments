import { z } from "zod";

import { type CurrencyInfo, ISO_4217 } from "./iso4217";

// The currency master (docs/supplier-currency.md): the one list of codes a supplier, order or deposit may be in, served
// to the frontend by GET /currencies and checked by every route that takes a currency. The list itself is generated
// (scripts/generate-currencies.ts); nothing here is typed by hand.

export { type CurrencyInfo, ISO_4217 };

/** The currencies the business trades in most: first in every per-currency list, then the rest by code. */
export const PREFERRED_CURRENCIES = ["CNY", "USD", "INR"] as const;

const byCode = new Map(ISO_4217.map((currency) => [currency.code, currency]));

/** A code of the master, exactly as ISO writes it (upper-case). */
export const isCurrency = (code: unknown): code is string => typeof code === "string" && byCode.has(code);
export const currencyInfo = (code: string) => byCode.get(code);
/** The symbol amounts are shown with ("¥", "$", "₹", "A$"); the code itself for a currency without one ("AED"). */
export const currencySymbol = (code: string) => byCode.get(code)?.symbol ?? code;
/** A zod field for a currency code: `message` for anything that isn't one of the master. */
export const currencyCode = (message: string) => z.string({ error: message }).refine(isCurrency, message);

const rank = (code: string) => {
  const index = (PREFERRED_CURRENCIES as readonly string[]).indexOf(code);
  return index === -1 ? PREFERRED_CURRENCIES.length : index;
};
/** CNY, USD, INR, then the rest alphabetically: the order of every per-currency list and total. */
export const compareCurrencies = (a: string, b: string) => rank(a) - rank(b) || a.localeCompare(b);
/** The distinct codes of `codes` in compareCurrencies order. */
export const orderedCurrencies = <T extends string>(codes: Iterable<T>): T[] => [...new Set(codes)].sort(compareCurrencies);
