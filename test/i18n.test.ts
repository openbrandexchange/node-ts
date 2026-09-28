// The node's own texts (e-mails, the portal word) in all 25 languages: every e-mail string exists in
// every vendored admin-ui locale with the same placeholders, and the portal word follows the glossary.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_EN, PORTAL_WORD, UI_LANGUAGES } from "../src/core/mail";

const LANGS = ["bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "ga", "hr", "hu", "it", "lt", "lv", "mt", "nl", "nb", "pl", "pt", "ro", "sk", "sl", "sv"];

function flatten(obj: unknown, prefix = "", out: Record<string, string> = {}) {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  else if (typeof obj === "string") out[prefix] = obj;
  return out;
}
const placeholders = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
const locale = (lang: string) => flatten(JSON.parse(readFileSync(join(import.meta.dir, "..", "public", "locales", `${lang}.json`), "utf8")));

/** Portal words from the glossary table in the spec (copied by scripts/sync-fixtures.sh). */
function glossaryWords(): Record<string, string> {
  const md = readFileSync(join(import.meta.dir, "fixtures", "glossary.md"), "utf8");
  const out: Record<string, string> = {};
  // The first table with language rows is "Core terms per language"; its second column is the portal word.
  for (const m of md.matchAll(/^\| [^|]+\(`([a-z]{2})`\) \| ([^|]+) \|/gm)) out[m[1]] ??= m[2].trim();
  return out;
}

describe("languages", () => {
  test("the node supports exactly the 25 product languages", () => {
    expect([...UI_LANGUAGES].sort()).toEqual([...LANGS].sort());
  });

  test("every e-mail string exists in every language with the same placeholders", () => {
    const problems: string[] = [];
    for (const lang of LANGS) {
      const s = locale(lang);
      for (const [key, en] of Object.entries(BUILTIN_EN)) {
        const v = s[key];
        if (typeof v !== "string" || !v.trim()) problems.push(`${lang}: ${key} missing`);
        else if (placeholders(v).join() !== placeholders(en).join()) problems.push(`${lang}: ${key} has {{${placeholders(v).join("}}, {{")}}} instead of {{${placeholders(en).join("}}, {{")}}}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("the built-in English copy matches the vendored English file", () => {
    const en = locale("en");
    for (const [key, v] of Object.entries(BUILTIN_EN)) expect({ key, v: en[key] }).toEqual({ key, v });
  });

  test("the portal word follows the glossary in every language", () => {
    const g = glossaryWords();
    expect(Object.keys(g).sort()).toEqual([...LANGS].sort());
    for (const lang of LANGS) {
      expect({ lang, builtin: PORTAL_WORD[lang] }).toEqual({ lang, builtin: g[lang] });
      expect({ lang, vendored: locale(lang)["glossary.portal"] }).toEqual({ lang, vendored: g[lang] });
    }
  });
});
