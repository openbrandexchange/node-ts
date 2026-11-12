// Article data (spec protocol.md §5.9, import-format.md §1.4–1.6 and rules 9 and 10): the feature
// registry, measurements, footwear materials, certifications, colour families, materials and care as
// terms with names (0.3, from the spec's vocabularies), the products.csv cell grammar for them, and the
// label completeness warnings. Shared by the write path (catalog.ts), imports (importformat.ts), the
// representations (reps.ts) and the article data CSV (csvexport.ts).
import careVocab from "../vocabularies/care.json";
import materialsVocab from "../vocabularies/materials.json";
import partsVocab from "../vocabularies/parts.json";
import qualifiersVocab from "../vocabularies/qualifiers.json";

/** The OBX protocol version (OBX-Version header, discovery, export manifests) and the spec version. */
export const OBX_VERSION = "0.3";
export const SPEC_VERSION = "0.3.0";

const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

// ------------------------------------------------------------------ vocabularies

export type FeatureType = "enum" | "integer" | "boolean" | "list";
export interface FeatureSpec {
  type: FeatureType;
  values?: readonly (string | number)[];
}

/** The feature registry (protocol.md §5.9.4), in registry order. */
export const FEATURE_REGISTRY: Record<string, FeatureSpec> = {
  shell: { type: "enum", values: ["hard", "soft", "hybrid"] },
  wheels: { type: "integer", values: [0, 2, 4, 8] },
  lock: { type: "enum", values: ["none", "combination", "tsa_combination", "tsa_key", "key"] },
  expandable: { type: "boolean" },
  closure: { type: "enum", values: ["zip", "magnet", "flap", "buckle", "drawstring", "button", "hook_and_loop", "laces", "slip_on", "open"] },
  laptop_compartment: { type: "boolean" },
  water_resistance: { type: "enum", values: ["none", "water_repellent", "waterproof"] },
  detachable_parts: { type: "list", values: ["shoulder_strap", "handle", "lining", "insole", "hood", "belt", "pouch", "wheels"] },
  adjustable_parts: { type: "list", values: ["shoulder_strap", "waist", "hem", "cuff"] },
  fit: { type: "enum", values: ["slim", "regular", "relaxed", "oversized"] },
  sleeve_length: { type: "enum", values: ["sleeveless", "short", "three_quarter", "long"] },
  neckline: { type: "enum", values: ["crew", "v_neck", "collar", "hood", "turtleneck", "boat", "scoop"] },
};
export const FEATURE_KEYS = Object.keys(FEATURE_REGISTRY);

/** Measurement keys (Measurements.json), in schema order = the products.csv column order. */
export const MEASUREMENT_KEYS = [
  "height_cm",
  "width_cm",
  "depth_cm",
  "weight_kg",
  "volume_l",
  "volume_expanded_l",
  "handle_drop_cm",
  "strap_length_cm",
  "laptop_max_inch",
  "heel_height_cm",
  "shaft_height_cm",
  "inseam_cm",
] as const;

export const COLOR_FAMILIES = ["black", "white", "grey", "beige", "brown", "red", "pink", "orange", "yellow", "green", "blue", "purple", "gold", "silver", "multicolour", "transparent"];
export const FOOTWEAR_PARTS = ["upper", "lining_and_sock", "outer_sole"] as const;
export const FOOTWEAR_VALUES = ["leather", "coated_leather", "textile", "other"];
export const CERTIFICATION_SCOPES = ["product", "material"];

export type LocalizedText = Record<string, string>;
/** A code with its name per language (Materials.json $defs/term). */
export type Term = { code: string; name?: LocalizedText | null };
export type Fiber = { material: Term; percentage: number; qualifier?: Term | null };
export type Materials = { part: Term; fibers: Fiber[] }[];
export type CareCategory = "washing" | "bleaching" | "drying" | "ironing" | "professional_care";
export type CareEntry = { code: string; category?: CareCategory | null; symbol?: string | null; name?: LocalizedText | null; text?: LocalizedText | null };
type CareVocabEntry = { code: string; category: CareCategory; symbol: string | null; name: LocalizedText };
export type Strap = { min: number; max: number };
export type Measurements = Partial<Record<(typeof MEASUREMENT_KEYS)[number], number | Strap>>;
export type FootwearMaterials = Record<(typeof FOOTWEAR_PARTS)[number], string | null>;
export type Certification = { scheme: string; licence_number: string | null; scope: string };
export type FeatureValue = string | number | boolean | (string | number | boolean)[];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Lowercase, spaces and "-" → "_", trimmed of "_" (the CSV key rule). */
export function normKey(s: string): string {
  return s.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/^_+|_+$/g, "");
}

// ------------------------------------------------------------------ terms (spec 0.3, protocol.md §5.9.1)
//
// Parts, materials, qualifiers and care entries are terms: a code and its name per language. The
// names (and for care the category and symbol) of known codes come from the spec's vocabularies
// (src/vocabularies, copied by scripts/sync-fixtures.sh). The stored document keeps codes only, plus
// what was written for codes outside the vocabularies; the representations add the rest when read, so
// a newer vocabulary needs no data migration and PUTting back a GET's data is `unchanged`.

const vocab = (v: { entries: { code: string; name: LocalizedText | null }[] }) => new Map(v.entries.map((e) => [e.code, e.name]));
export const PART_NAMES = vocab(partsVocab);
export const MATERIAL_NAMES = vocab(materialsVocab);
export const QUALIFIER_NAMES = vocab(qualifiersVocab);
export const CARE_VOCAB = new Map((careVocab.entries as CareVocabEntry[]).map((e) => [e.code, e]));
export const CARE_CATEGORIES = ["washing", "bleaching", "drying", "ironing", "professional_care"] as const;

/**
 * The 0.1 keys recycled_<material> / organic_<material> become the material with that qualifier
 * (protocol.md §5.9.1); the key wins over a qualifier that was also given (ingest.md §3.4).
 */
export function splitLegacyMaterial(code: string): { code: string; qualifier: string | null } {
  let qualifier: string | null = null;
  for (;;) {
    const m = code.match(/^(recycled|organic)_(.+)$/);
    if (!m) break;
    qualifier ??= m[1];
    code = m[2];
  }
  return { code, qualifier };
}

/** A term as stored: the code, and the name only for a code outside the vocabulary. */
export function storeTerm(t: Term, names: Map<string, LocalizedText | null>): Term {
  const out: Term = { code: t.code, ...extMembers(t) };
  if (!names.has(t.code) && t.name) out.name = t.name;
  return out;
}

/** A term as returned: the vocabulary's name for a known code, else the name it was given, or null. */
export function expandTerm(t: unknown, names: Map<string, LocalizedText | null>): unknown {
  if (!isObj(t) || typeof t.code !== "string") return t;
  return { code: t.code, name: names.has(t.code) ? (names.get(t.code) ?? null) : ((t.name as LocalizedText | undefined) ?? null), ...extMembers(t) };
}

/** Materials as stored (codes only for known codes, one qualifier per fibre, 0.1 keys normalised). */
export function storeMaterials(m: Materials): Materials {
  return m.map((p) => ({
    ...extMembers(p),
    part: storeTerm(p.part, PART_NAMES),
    fibers: p.fibers.map((f) => {
      const legacy = splitLegacyMaterial(f.material.code);
      const material = storeTerm({ ...f.material, code: legacy.code }, MATERIAL_NAMES);
      const qualifier = legacy.qualifier ? { code: legacy.qualifier } : (f.qualifier ?? null);
      const out: Fiber = { ...extMembers(f), material, percentage: f.percentage };
      if (qualifier) out.qualifier = storeTerm(qualifier, QUALIFIER_NAMES);
      return out;
    }),
  }));
}

/** Materials as the protocol returns them: every term with its name, `qualifier` null when none. */
export function expandMaterials(m: unknown): unknown {
  if (!Array.isArray(m)) return m;
  return m.map((p) =>
    isObj(p)
      ? {
          part: expandTerm(p.part, PART_NAMES),
          fibers: Array.isArray(p.fibers)
            ? p.fibers.map((f: unknown) =>
                isObj(f) ? { material: expandTerm(f.material, MATERIAL_NAMES), percentage: f.percentage, qualifier: f.qualifier ? expandTerm(f.qualifier, QUALIFIER_NAMES) : null, ...extMembers(f) } : f,
              )
            : p.fibers,
          ...extMembers(p),
        }
      : p,
  );
}

/** A care entry as stored: code and text, and category/symbol/name only for a code outside the vocabulary. */
export function storeCare(c: CareEntry): CareEntry {
  const out: CareEntry = { code: c.code, text: c.text ?? null, ...extMembers(c) };
  if (!CARE_VOCAB.has(c.code)) {
    if (c.category) out.category = c.category;
    if (c.symbol) out.symbol = c.symbol;
    if (c.name) out.name = c.name;
  }
  return out;
}

/** Care as the protocol returns it: code, category, symbol, name, text. */
export function expandCare(c: unknown): unknown {
  if (!Array.isArray(c)) return c;
  return c.map((e) => {
    if (!isObj(e) || typeof e.code !== "string") return e;
    const v = CARE_VOCAB.get(e.code);
    return {
      code: e.code,
      category: v ? v.category : (e.category ?? null),
      symbol: v ? v.symbol : (e.symbol ?? null),
      name: v ? v.name : (e.name ?? null),
      text: e.text ?? null,
      ...extMembers(e),
    };
  });
}

function extMembers(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (k.startsWith("x-")) out[k] = v;
  return out;
}

/**
 * Materials stored by a 0.2 node (part a string; fibre {fiber, percentage, recycled?, organic?}) in the
 * 0.3 stored form. Migration 0006 converts the database; this covers rows written by an older node
 * while the migration ran, and backups restored from 0.2.
 */
function upgradeMaterials(m: unknown[]): unknown[] {
  return m.map((p) => {
    if (!isObj(p)) return p;
    const part = typeof p.part === "string" ? { code: p.part } : p.part;
    const fibers = Array.isArray(p.fibers)
      ? p.fibers.map((f: unknown) => {
          if (!isObj(f) || typeof f.fiber !== "string") return f;
          const { fiber, recycled, organic, ...rest } = f;
          const q = recycled === true ? "recycled" : organic === true ? "organic" : null;
          return { ...rest, material: { code: fiber }, ...(q ? { qualifier: { code: q } } : {}) };
        })
      : p.fibers;
    return { ...p, part, fibers };
  });
}

/** A stored product in the 0.3 stored form (materials and care of data stored before 0.3 upgraded). */
export function normalizeStoredProduct(s: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(s.materials)) return s;
  const legacyFiber = (f: unknown) => isObj(f) && ("fiber" in f || (isObj(f.material) && typeof f.material.code === "string" && /^(recycled|organic)_./.test(f.material.code)));
  const legacy = s.materials.some((p) => isObj(p) && (typeof p.part === "string" || (Array.isArray(p.fibers) && p.fibers.some(legacyFiber))));
  if (!legacy) return s;
  return { ...s, materials: storeMaterials(upgradeMaterials(s.materials) as Materials) };
}

/** The product fields of the protocol representation that differ from the stored form. */
export function expandProductTerms(s: Record<string, unknown>): Record<string, unknown> {
  const out = { ...s };
  if (Array.isArray(s.materials)) out.materials = expandMaterials(s.materials);
  if (Array.isArray(s.care)) out.care = expandCare(s.care);
  return out;
}

// ------------------------------------------------------------------ features

/** A feature value with its registry type, or a description of what the key needs. */
export function checkFeature(key: string, v: unknown): { value: FeatureValue } | { error: string } {
  const spec = FEATURE_REGISTRY[key];
  if (!spec) {
    const scalar = (x: unknown) => typeof x === "string" || typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x));
    if (scalar(v)) return { value: v as FeatureValue };
    if (Array.isArray(v) && v.every(scalar)) return { value: v as FeatureValue };
    return { error: "Must be text, a number, true/false or a list of those." };
  }
  const values = spec.values ?? [];
  switch (spec.type) {
    case "enum":
      return typeof v === "string" && values.includes(v) ? { value: v } : { error: `Must be one of: ${values.join(", ")}.` };
    case "integer":
      return typeof v === "number" && Number.isInteger(v) && values.includes(v) ? { value: v } : { error: `Must be one of the numbers ${values.join(", ")}.` };
    case "boolean":
      return typeof v === "boolean" ? { value: v } : { error: "Must be true or false." };
    case "list": {
      if (!Array.isArray(v)) return { error: `Must be a list of: ${values.join(", ")}.` };
      for (const x of v) if (typeof x !== "string" || !values.includes(x)) return { error: `Must be a list of: ${values.join(", ")}.` };
      if (new Set(v).size !== v.length) return { error: "A value may appear only once." };
      return { value: v as string[] };
    }
  }
}

/** Features in output order: registry keys in registry order, then the other keys sorted. */
export function orderFeatures(f: Record<string, FeatureValue>): Record<string, FeatureValue> {
  const out: Record<string, FeatureValue> = {};
  for (const k of FEATURE_KEYS) if (f[k] !== undefined) out[k] = f[k];
  for (const k of Object.keys(f).filter((k) => !(k in FEATURE_REGISTRY)).sort()) if (f[k] !== undefined) out[k] = f[k];
  return out;
}

/** Measurements in schema order. */
export function orderMeasurements(m: Measurements): Measurements {
  const out: Measurements = {};
  for (const k of MEASUREMENT_KEYS) if (m[k] !== undefined) out[k] = m[k];
  for (const k of Object.keys(m).filter((k) => k.startsWith("x-")).sort()) (out as Record<string, unknown>)[k] = (m as Record<string, unknown>)[k];
  return out;
}

// ------------------------------------------------------------------ products.csv cells (import-format.md §1.6)

export type Cell<T> = { value: T } | { error: string };

/** `upper: leather; lining_and_sock: textile; outer_sole: other`; a part not in the cell is null. */
export function parseFootwearCell(s: string): Cell<FootwearMaterials> {
  const out: FootwearMaterials = { upper: null, lining_and_sock: null, outer_sole: null };
  let n = 0;
  for (const raw of s.split(";")) {
    const t = raw.trim();
    if (!t) continue;
    const i = t.indexOf(":");
    if (i < 0) return { error: `"${t}" should look like "upper: leather" (parts upper, lining_and_sock, outer_sole).` };
    const part = normKey(t.slice(0, i));
    const value = normKey(t.slice(i + 1));
    if (!(FOOTWEAR_PARTS as readonly string[]).includes(part)) return { error: `"${t.slice(0, i).trim()}" is not a footwear part (upper, lining_and_sock, outer_sole).` };
    if (!FOOTWEAR_VALUES.includes(value)) return { error: `"${t.slice(i + 1).trim()}" is not a footwear material (leather, coated_leather, textile, other).` };
    if (out[part as keyof FootwearMaterials] !== null) return { error: `The part ${part} appears twice.` };
    out[part as keyof FootwearMaterials] = value;
    n++;
  }
  if (!n) return { error: "No footwear materials found." };
  return { value: out };
}

export function formatFootwear(f: unknown): string {
  if (!isObj(f)) return "";
  return FOOTWEAR_PARTS.filter((p) => typeof f[p] === "string").map((p) => `${p}: ${f[p]}`).join("; ");
}

/** `gots:CU 123456; rws:CU 200101 (material)`; entries keep their order. */
export function parseCertificationsCell(s: string): Cell<Certification[]> {
  const out: Certification[] = [];
  for (const raw of s.split(";")) {
    let t = raw.trim();
    if (!t) continue;
    let scope = "product";
    const m = t.match(/\s*\((material|product)\)\s*$/i);
    if (m) {
      scope = m[1].toLowerCase();
      t = t.slice(0, t.length - m[0].length).trim();
    }
    const i = t.indexOf(":");
    const scheme = normKey(i < 0 ? t : t.slice(0, i));
    if (!KEY_RE.test(scheme)) return { error: `"${(i < 0 ? t : t.slice(0, i)).trim()}" is not a certification scheme key such as gots or oeko_tex_standard_100.` };
    const licence = i < 0 ? "" : t.slice(i + 1).trim();
    if (licence.length > 200) return { error: `The licence number of ${scheme} is longer than 200 characters.` };
    out.push({ scheme, licence_number: licence || null, scope });
  }
  if (!out.length) return { error: "No certifications found." };
  return { value: out };
}

export function formatCertifications(c: unknown): string {
  if (!Array.isArray(c)) return "";
  return c
    .filter(isObj)
    .map((x) => `${x.scheme}${typeof x.licence_number === "string" ? `:${x.licence_number}` : ""}${x.scope === "material" ? " (material)" : ""}`)
    .join("; ");
}

/** A positive number with "." or "," as decimal separator, no thousands separator, no unit. */
export function parseMeasurementCell(s: string): Cell<number> {
  const t = s.trim();
  if (!/^([0-9]+([.,][0-9]+)?|[.,][0-9]+)$/.test(t)) return { error: `"${t}" is not a number (write for example 2.6 or 2,6, without a unit).` };
  const v = Number(t.replace(",", "."));
  if (!(v > 0) || !Number.isFinite(v)) return { error: `"${t}" is not a positive number.` };
  return { value: v };
}

/** strap_length_cm: `min-max` (80-130) or one number for a strap that cannot be adjusted. */
export function parseStrapCell(s: string): Cell<Strap> {
  const t = s.trim();
  const i = t.indexOf("-");
  if (i < 0) {
    const v = parseMeasurementCell(t);
    return "error" in v ? v : { value: { min: v.value, max: v.value } };
  }
  const lo = parseMeasurementCell(t.slice(0, i));
  const hi = parseMeasurementCell(t.slice(i + 1));
  if ("error" in lo || "error" in hi) return { error: `"${t}" should be min-max in cm, for example 80-130.` };
  if (lo.value > hi.value) return { error: `"${t}": the shortest setting comes first (min-max, for example 80-130).` };
  return { value: { min: lo.value, max: hi.value } };
}

export function formatNumber(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

export function formatMeasurement(m: unknown, key: string): string {
  if (!isObj(m)) return "";
  const v = m[key];
  if (key === "strap_length_cm") {
    if (!isObj(v)) return "";
    return v.min === v.max ? formatNumber(v.min) : `${formatNumber(v.min)}-${formatNumber(v.max)}`;
  }
  return formatNumber(v);
}

/** A colour family, lowercased; gray = grey, multicolor = multicolour. */
export function parseColorFamilyCell(s: string): Cell<string> {
  let v = s.trim().toLowerCase();
  if (v === "gray") v = "grey";
  if (v === "multicolor") v = "multicolour";
  return COLOR_FAMILIES.includes(v) ? { value: v } : { error: `"${s.trim()}" is not a colour family (${COLOR_FAMILIES.join(", ")}).` };
}

/**
 * The cell of a feature:<key> column. Registry keys get their type (enums lowercased with spaces →
 * "_", integers as digits, booleans as yes/no, lists separated by "|" with duplicates dropped); a
 * key outside the registry keeps the text of the cell.
 */
export function parseFeatureCell(key: string, s: string, parseBool: (s: string) => boolean | null): Cell<FeatureValue> {
  const t = s.trim();
  const spec = FEATURE_REGISTRY[key];
  if (!spec) return { value: t };
  const values = spec.values ?? [];
  switch (spec.type) {
    case "enum": {
      const v = normKey(t);
      return values.includes(v) ? { value: v } : { error: `"${t}" is not one of ${values.join(", ")}.` };
    }
    case "integer": {
      const n = /^[0-9]+$/.test(t) ? Number(t) : NaN;
      return values.includes(n) ? { value: n } : { error: `"${t}" is not one of ${values.join(", ")}.` };
    }
    case "boolean": {
      const b = parseBool(t);
      return b === null ? { error: `"${t}" is not yes or no.` } : { value: b };
    }
    case "list": {
      const list: string[] = [];
      for (const raw of t.split("|")) {
        const v = normKey(raw);
        if (!v) continue;
        if (!values.includes(v)) return { error: `"${raw.trim()}" is not one of ${values.join(", ")}.` };
        if (!list.includes(v)) list.push(v);
      }
      return list.length ? { value: list } : { error: `"${t}" is not a list of ${values.join(", ")}.` };
    }
  }
}

export function formatFeature(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return v.map(formatFeature).join("|");
  if (typeof v === "number") return formatNumber(v);
  return String(v);
}

// ------------------------------------------------------------------ label completeness (import-format.md rule 10)

export const LABEL_WARNING_CODES = ["fibre_composition_missing", "animal_origin_unknown", "footwear_materials_missing", "fibre_percentages_not_100"] as const;
export type LabelWarningCode = (typeof LABEL_WARNING_CODES)[number];

export interface LabelWarning {
  code: LabelWarningCode;
  /** The products.csv column the warning names. */
  column: string;
  /** JSON Pointer into the product write model. */
  pointer: string;
  detail: string;
}

/** Recommended apparel keys (t_shirt … socks, hat, cap, scarf, gloves, tie), bag, backpack, luggage. */
export const TEXTILE_ITEM_TYPES = [
  "t_shirt", "top", "shirt", "blouse", "polo", "sweater", "cardigan", "hoodie", "sweatshirt", "vest", "jacket", "coat", "blazer", "suit", "dress", "skirt",
  "trousers", "jeans", "shorts", "jumpsuit", "leggings", "underwear", "lingerie", "nightwear", "swimwear", "socks", "hat", "cap", "scarf", "gloves", "tie",
  "bag", "backpack", "luggage",
];
export const FOOTWEAR_ITEM_TYPES = ["shoes", "sneakers", "boots", "sandals"];
const ANIMAL_FIBRES = ["leather", "suede", "fur", "down", "feather", "wool", "merino_wool", "lambswool", "cashmere", "alpaca", "mohair", "silk"];

export function isAnimalFibre(key: string): boolean {
  return ANIMAL_FIBRES.includes(key) || key.endsWith("_wool");
}

/**
 * What a consumer label of the product as stored would miss: fibre_composition_missing,
 * animal_origin_unknown, fibre_percentages_not_100 (one per part) for textile item types, and
 * footwear_materials_missing for footwear item types. Other and unknown item types get none.
 * Warnings never block a write or publishing.
 */
export function labelWarnings(p: Record<string, unknown>): LabelWarning[] {
  const itemType = typeof p.item_type === "string" ? p.item_type : "";
  const materials = (Array.isArray(p.materials) ? p.materials : []) as Materials;
  const out: LabelWarning[] = [];
  if (TEXTILE_ITEM_TYPES.includes(itemType)) {
    if (!materials.length)
      out.push({
        code: "fibre_composition_missing",
        column: "materials",
        pointer: "/materials",
        detail: "The fibre composition is missing; it must be on the label of a textile product and shown before purchase, also online (Regulation (EU) No 1007/2011).",
      });
    if (p.contains_animal_origin === null || p.contains_animal_origin === undefined) {
      const animal = materials
        .flatMap((m) => m.fibers ?? [])
        .map((f) => (isObj(f.material) && typeof f.material.code === "string" ? splitLegacyMaterial(f.material.code).code : ""))
        .find(isAnimalFibre);
      if (animal)
        out.push({
          code: "animal_origin_unknown",
          column: "contains_animal_origin",
          pointer: "/contains_animal_origin",
          detail: `The materials contain ${animal}; state whether the product contains non-textile parts of animal origin (Regulation (EU) No 1007/2011 Art. 12).`,
        });
    }
    materials.forEach((m, i) => {
      const sum = (m.fibers ?? []).reduce((a, f) => a + (typeof f.percentage === "number" ? f.percentage : 0), 0);
      if (Math.abs(sum - 100) > 0.01)
        out.push({
          code: "fibre_percentages_not_100",
          column: "materials",
          pointer: `/materials/${i}`,
          detail: `The percentages of ${isObj(m.part) ? m.part.code : "a part"} add up to ${Math.round(sum * 100) / 100}, not 100 (Regulation (EU) No 1007/2011 Art. 9).`,
        });
    });
  } else if (FOOTWEAR_ITEM_TYPES.includes(itemType)) {
    const f = isObj(p.footwear_materials) ? p.footwear_materials : {};
    const missing = FOOTWEAR_PARTS.filter((k) => typeof f[k] !== "string");
    if (missing.length)
      out.push({
        code: "footwear_materials_missing",
        column: "footwear_materials",
        pointer: "/footwear_materials",
        detail: `The footwear materials of ${missing.join(", ")} are missing; they must be on the label of footwear (Directive 94/11/EC).`,
      });
  }
  return out;
}

/** The text form of a label warning in IngestResult.warnings. */
export function labelWarningText(w: LabelWarning): string {
  return `${w.code}: ${w.detail}`;
}
