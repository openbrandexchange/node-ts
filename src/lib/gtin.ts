// GTIN rules: strict on ingest (check digit), lenient on lookup (protocol.md §7).

export function gtinCheckDigitValid(digits: string): boolean {
  if (!/^\d+$/.test(digits) || digits.length < 2) return false;
  let sum = 0;
  // Weights 3,1,3,1… from the right, excluding the check digit.
  for (let i = digits.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(digits[i]) * w;
  const check = (10 - (sum % 10)) % 10;
  return check === Number(digits[digits.length - 1]);
}

export function expectedCheckDigit(digits: string): number {
  let sum = 0;
  for (let i = digits.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(digits[i]) * w;
  return (10 - (sum % 10)) % 10;
}

export const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

/** Ingest: returns { gtin14, original } or an error message. */
export function parseIngestGtin(raw: string): { gtin14: string; original: string } | { error: string } {
  const s = raw.replace(/\s+/g, "");
  if (!/^\d+$/.test(s)) return { error: "A GTIN contains digits only." };
  if (!GTIN_LENGTHS.has(s.length)) return { error: "A GTIN has 8, 12, 13 or 14 digits." };
  if (!gtinCheckDigitValid(s)) return { error: `Check digit should be ${expectedCheckDigit(s)}.` };
  return { gtin14: s.padStart(14, "0"), original: s };
}

/** Lookup: trim, remove inner spaces, pad to 14; check digit not validated. */
export function normaliseLookupGtin(input: string): string | null {
  const s = input.replace(/\s+/g, "");
  if (!/^\d+$/.test(s) || !GTIN_LENGTHS.has(s.length)) return null;
  return s.padStart(14, "0");
}
