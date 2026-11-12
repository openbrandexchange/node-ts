// The canonical import format (docs/import-format.md): products.csv, assets.csv and image file names.
import { normHeader, parseCsv } from "../lib/csv";
import { parseIngestGtin } from "../lib/gtin";
import { KEY_RE, LANG_RE, ROLES, VIEWS } from "./validate";
import { normDateTime } from "../lib/util";
import {
  FEATURE_REGISTRY,
  MEASUREMENT_KEYS,
  normalizeFiber,
  normalizeMaterials,
  normKey,
  parseCertificationsCell,
  parseColorFamilyCell,
  parseFeatureCell,
  parseFootwearCell,
  parseMeasurementCell,
  parseStrapCell,
  type FeatureValue,
  type Fiber,
  type Materials,
  type Measurements,
} from "./article";

export interface RowError {
  file: string;
  row: number | null;
  column: string | null;
  severity: "error" | "warning";
  obx_error: string;
  detail: string;
  value: string | null;
}

export const IMAGE_EXT = /\.(jpe?g|png|webp|tiff?)$/i;

export const CARE_CODES = new Set(
  (
    "wash_95 wash_70 wash_60 wash_60_mild wash_50 wash_50_mild wash_40 wash_40_mild wash_40_very_mild wash_30 wash_30_mild wash_30_very_mild hand_wash do_not_wash " +
    "bleach_any bleach_oxygen_only do_not_bleach tumble_dry_normal tumble_dry_low do_not_tumble_dry line_dry drip_line_dry dry_flat drip_dry_flat line_dry_shade " +
    "drip_line_dry_shade dry_flat_shade drip_dry_flat_shade iron_high iron_medium iron_low do_not_iron dry_clean_p dry_clean_p_mild dry_clean_p_very_mild dry_clean_f " +
    "dry_clean_f_mild dry_clean_f_very_mild do_not_dry_clean wet_clean_w wet_clean_w_mild wet_clean_w_very_mild do_not_wet_clean"
  ).split(" "),
);

// ------------------------------------------------------------------ image file names

export interface ParsedImageName {
  style: string;
  /** Colour code as written, or null for `ALL` (an image of every colour of the product). */
  color: string | null;
  position: number;
  role: string | null;
  view: string | null;
}

const QUALIFIERS = new Set([...ROLES, ...VIEWS]);

/**
 * {style}_{color}_{position}[_{qualifier}…].{ext}, parsed from the right (import-format.md §2.1):
 * two-part keys (size_chart, tilted_left, tilted_right) first, the rightmost role and view win,
 * `other` is the view when the name also has another role, and colour `ALL` means all colours.
 */
export function parseImageName(file: string): ParsedImageName | { error: string } {
  const base = file.split("/").pop()!;
  const m = base.match(/^(.*)\.([A-Za-z]+)$/);
  if (!m || !IMAGE_EXT.test(base)) return { error: "Not an image file name (jpg, jpeg, png, webp, tif, tiff)." };
  const parts = m[1].split("_");
  const qualifiers: string[] = [];
  for (;;) {
    const two = parts.length > 4 ? `${parts[parts.length - 2]}_${parts[parts.length - 1]}`.toLowerCase() : "";
    if (two && QUALIFIERS.has(two)) {
      qualifiers.push(two);
      parts.splice(-2, 2);
    } else if (parts.length > 3 && QUALIFIERS.has(parts[parts.length - 1].toLowerCase())) {
      qualifiers.push(parts.pop()!.toLowerCase());
    } else break;
  }
  const hasOtherRole = qualifiers.some((q) => q !== "other" && ROLES.includes(q));
  let role: string | null = null;
  let view: string | null = null;
  for (const q of qualifiers) {
    if (q === "detail") {
      role ??= "detail";
      view ??= "detail";
    } else if (q === "other") {
      if (hasOtherRole) view ??= "other";
      else role ??= "other";
    } else if (ROLES.includes(q)) role ??= q;
    else view ??= q;
  }
  if (parts.length < 3) return { error: "The name needs {style}_{colour}_{position}, e.g. KO-1001_NVY_1.jpg." };
  const pos = parts[parts.length - 1];
  if (!/^[1-9][0-9]{0,2}$/.test(pos)) return { error: "The part before the extension (or qualifiers) must be the position 1-999, e.g. KO-1001_NVY_1.jpg." };
  const color = parts[parts.length - 2];
  const style = parts.slice(0, -2).join("_");
  if (!color || !style) return { error: "The name needs {style}_{colour}_{position}." };
  return { style, color: color.toUpperCase() === "ALL" ? null : color, position: Number(pos), role, view };
}

// ------------------------------------------------------------------ materials & care

/**
 * The materials grammar (import-format.md §1.4): `part: 95% cotton, 5% elastane; lining: 100%
 * polyester (recycled)`. A flag `(recycled)` / `(organic)` sets that flag on the fibre, and the 0.1
 * keys recycled_<fibre> / organic_<fibre> give the same result. Percentages that do not add up to
 * 100 are not an error: the label warning fibre_percentages_not_100 reports them (rule 10).
 */
export function parseMaterials(s: string): { value: Materials } | { error: string } {
  const out: Materials = [];
  for (const rawPart of s.split(";")) {
    const partStr = rawPart.trim();
    if (!partStr) continue;
    let name = "main";
    let body = partStr;
    const colon = partStr.indexOf(":");
    if (colon >= 0) {
      name = partStr.slice(0, colon).trim().toLowerCase().replace(/\s+/g, "_");
      body = partStr.slice(colon + 1);
    }
    if (!KEY_RE.test(name)) return { error: `"${name}" is not a valid part name (use e.g. main, outer, lining).` };
    const fibers: Fiber[] = [];
    for (const f of body.split(",")) {
      const t = f.trim();
      if (!t) continue;
      const m = t.match(/^(\d+(?:[.,]\d+)?)\s*%\s*(.+)$/);
      if (!m) return { error: `"${t}" should look like "95% cotton" or "100% polyester (recycled)".` };
      const pct = Number(m[1].replace(",", "."));
      let rest = m[2].trim();
      let recycled = false;
      let organic = false;
      for (;;) {
        const fl = rest.match(/\s*\((recycled|organic)\)\s*$/i);
        if (!fl) break;
        if (fl[1].toLowerCase() === "recycled") recycled = true;
        else organic = true;
        rest = rest.slice(0, rest.length - fl[0].length);
      }
      const key = rest.trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (!KEY_RE.test(key)) return { error: `"${rest.trim()}" is not a valid fibre name.` };
      if (!(pct > 0) || pct > 100) return { error: `${m[1]}% is not a valid percentage.` };
      fibers.push(normalizeFiber({ fiber: key, percentage: pct, recycled, organic }));
    }
    if (!fibers.length) return { error: `Part "${name}" has no fibres.` };
    out.push({ part: name, fibers });
  }
  if (!out.length) return { error: "No materials found." };
  return { value: out };
}

export function formatMaterials(m: Materials | null | undefined): string {
  if (!m?.length) return "";
  return normalizeMaterials(m)
    .map((p) => `${p.part}: ${p.fibers.map((f) => `${f.percentage}% ${f.fiber}${f.recycled ? " (recycled)" : ""}${f.organic ? " (organic)" : ""}`).join(", ")}`)
    .join("; ");
}

export function parseBool(s: string): boolean | null {
  const v = s.trim().toLowerCase();
  if (["true", "yes", "ja", "1", "y", "j", "oui", "si", "sí"].includes(v)) return true;
  if (["false", "no", "nee", "0", "n", "non"].includes(v)) return false;
  return null;
}

// ------------------------------------------------------------------ products.csv

export interface ProductGroup {
  key: string; // product external id
  firstRow: number;
  brandRef: string | null;
  product: Record<string, unknown>;
  status: string | null;
  variants: { row: number; externalId: string; data: Record<string, unknown> }[];
  rows: number[];
  /** The columns of the file this group came from (import rule 9). */
  present: PresentColumns;
}

/**
 * Which columns a products.csv has, by canonical name (aliases resolved): plain columns (the
 * measurement columns among them), the languages of each text column (the plain one is the
 * import's default language), the attr:<key> and the feature:<key> columns. A node keeps the
 * stored value of every field whose column is missing (rule 9; per key for attributes, features
 * and measurements).
 */
export interface PresentColumns {
  plain: Set<string>;
  langs: Record<"name" | "description" | "color_name", Set<string>>;
  attrs: Set<string>;
  features: Set<string>;
}

const COLUMN_ALIASES: Record<string, string> = {
  style: "style_number",
  ean: "gtin",
  barcode: "gtin",
  colour_code: "color_code",
  colour_name: "color_name",
  colour_family: "color_family",
};

export function presentColumns(cols: string[], defaultLanguage: string): PresentColumns {
  const p: PresentColumns = { plain: new Set(), langs: { name: new Set(), description: new Set(), color_name: new Set() }, attrs: new Set(), features: new Set() };
  for (const c of cols) {
    const [raw, tag] = c.split(":");
    const base = COLUMN_ALIASES[raw] ?? raw;
    if (base === "attr" && tag) p.attrs.add(tag);
    else if (base === "feature" && tag) p.features.add(normKey(tag));
    else if (tag) {
      if (base in p.langs) p.langs[base as keyof PresentColumns["langs"]].add(tag);
    } else if (base) {
      p.plain.add(base);
      if (base in p.langs) p.langs[base as keyof PresentColumns["langs"]].add(defaultLanguage);
    }
  }
  return p;
}

type ColumnField = { path: string; column: string; kind: "plain" | "text" | "attrs" | "features" | "measurements" };
export const PRODUCT_COLUMN_FIELDS: ColumnField[] = [
  { path: "name", column: "name", kind: "text" },
  { path: "description", column: "description", kind: "text" },
  ...[
    "item_type",
    "item_subtype",
    "target_group",
    "season",
    "collection",
    "gpc_brick",
    "materials",
    "contains_animal_origin",
    "footwear_materials",
    "care",
    "country_of_origin",
    "certifications",
    "dpp_url",
  ].map((c) => ({ path: c, column: c, kind: "plain" as const })),
  { path: "features", column: "feature", kind: "features" },
  { path: "attributes", column: "attr", kind: "attrs" },
];
export const VARIANT_COLUMN_FIELDS: ColumnField[] = [
  ...["gtin", "sku", "size", "size_length", "size_system"].map((c) => ({ path: c, column: c, kind: "plain" as const })),
  { path: "color.name", column: "color_name", kind: "text" },
  { path: "color.family", column: "color_family", kind: "plain" },
  { path: "color.supplier_color", column: "supplier_color", kind: "plain" },
  { path: "measurements", column: "measurements", kind: "measurements" },
];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Import rule 9 (spec import-format.md): for a product or variant the node already has, a field
 * whose column the file does not have keeps its stored value (texts per language; attributes,
 * features and measurements per key); an empty cell in a column the file has still removes the
 * value, and when the last feature or measurement is removed the object is null. Changes `data`
 * in place.
 */
export function keepAbsentColumns(data: Record<string, unknown>, stored: Record<string, unknown>, fields: ColumnField[], present: PresentColumns) {
  for (const f of fields) {
    const parts = f.path.split(".");
    const key = parts.pop()!;
    let parent: Record<string, unknown> | null = data;
    let oldParent: Record<string, unknown> | null = stored;
    for (const seg of parts) {
      parent = parent && isObj(parent[seg]) ? (parent[seg] as Record<string, unknown>) : null;
      oldParent = oldParent && isObj(oldParent[seg]) ? (oldParent[seg] as Record<string, unknown>) : null;
    }
    if (!parent || !oldParent) continue;
    const was = oldParent[key];
    if (was === undefined || was === null) continue;
    if (f.kind === "plain") {
      if (!(key in parent) && !present.plain.has(f.column)) parent[key] = was;
      continue;
    }
    if (!isObj(was)) continue;
    const now: Record<string, unknown> = isObj(parent[key]) ? { ...(parent[key] as Record<string, unknown>) } : {};
    for (const [k, v] of Object.entries(was)) {
      const absent =
        f.kind === "attrs"
          ? !present.attrs.has(k)
          : f.kind === "features"
            ? !present.features.has(k)
            : f.kind === "measurements"
              ? !present.plain.has(k)
              : !present.langs[f.column as keyof PresentColumns["langs"]].has(k);
      if (!(k in now) && absent) now[k] = v;
    }
    if (Object.keys(now).length) parent[key] = now;
  }
}

const PRODUCT_COLS = new Set([
  "brand",
  "product_id",
  "style_number",
  "style",
  "name",
  "description",
  "item_type",
  "item_subtype",
  "target_group",
  "season",
  "collection",
  "gpc_brick",
  "materials",
  "contains_animal_origin",
  "footwear_materials",
  "care",
  "country_of_origin",
  "certifications",
  "dpp_url",
  "status",
]);
const VARIANT_COLS = new Set([
  "variant_id",
  "gtin",
  "ean",
  "barcode",
  "sku",
  "color_code",
  "colour_code",
  "color_name",
  "colour_name",
  "color_family",
  "colour_family",
  "supplier_color",
  "size",
  "size_length",
  "size_system",
  ...MEASUREMENT_KEYS,
  "variant_status",
]);

export interface ParsedProducts {
  groups: ProductGroup[];
  errors: RowError[];
  rows: number;
}

/**
 * Parses products.csv into product groups (file order), with row errors and warnings. A row with
 * an error is skipped as a whole (its product and its variant), so a value outside the rules never
 * reaches the catalog.
 */
export function parseProductsCsv(text: string, file: string, defaultLanguage: string, delimiter?: string): ParsedProducts {
  const errors: RowError[] = [];
  const err = (row: number | null, column: string | null, detail: string, value: string | null = null, code = "validation_failed", severity: "error" | "warning" = "error") =>
    errors.push({ file, row, column, severity, obx_error: code, detail, value: value === null ? null : value.slice(0, 500) });
  const csv = parseCsv(text, delimiter);
  if (!csv.header.length || csv.header.every((h) => h === "")) {
    err(null, null, "The file has no header row.", null, "import_invalid");
    return { groups: [], errors, rows: 0 };
  }
  const cols = csv.header.map(normHeader);
  // Unknown columns: one warning each. feature:<key> outside the registry: one warning each.
  const featureCols: { key: string; i: number }[] = [];
  cols.forEach((c, i) => {
    if (c === "") return; // an empty header name is no column: ignored without a warning (§1.1)
    const [base, lang] = c.split(":");
    if (base === "feature" && lang !== undefined) {
      const key = normKey(lang);
      if (!KEY_RE.test(key)) err(null, csv.header[i], `"${lang}" is not a feature key (lowercase letters, digits and _); the column was ignored.`, null, "validation_failed", "warning");
      else if (featureCols.some((f) => f.key === key)) err(null, csv.header[i], `The column feature:${key} appears twice; the first one is used.`, null, "validation_failed", "warning");
      else {
        featureCols.push({ key, i });
        if (!(key in FEATURE_REGISTRY)) err(null, `feature:${key}`, `The feature "${key}" is not in the feature registry; its cells are stored as text.`, null, "validation_failed", "warning");
      }
      return;
    }
    const ok =
      (PRODUCT_COLS.has(base) && (!lang || ["name", "description"].includes(base))) ||
      (VARIANT_COLS.has(base) && (!lang || ["color_name", "colour_name"].includes(base))) ||
      (base === "attr" && lang && KEY_RE.test(lang)) ||
      base === "image_files";
    if (lang && base !== "attr" && !LANG_RE.test(lang)) err(null, csv.header[i], `"${lang}" is not a language tag like nl or en.`, null, "validation_failed", "warning");
    else if (!ok) err(null, csv.header[i], `Unknown column "${csv.header[i]}" was ignored.`, null, "validation_failed", "warning");
  });
  if (!cols.some((c) => c === "style_number" || c === "style")) {
    err(null, "style_number", "The required column style_number is missing.", null, "import_invalid");
    return { groups: [], errors, rows: csv.rows.length };
  }
  const idx = (names: string[]) => {
    for (const n of names) {
      const i = cols.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const langCols = (base: string[]) => {
    const out: { lang: string; i: number }[] = [];
    cols.forEach((c, i) => {
      const [b, l] = c.split(":");
      if (base.includes(b)) out.push({ lang: l ?? defaultLanguage, i });
    });
    // tagged wins over plain for the default language
    const tagged = new Set(out.filter((x) => cols[x.i].includes(":")).map((x) => x.lang));
    return out.filter((x) => cols[x.i].includes(":") || !tagged.has(x.lang));
  };
  const I = {
    brand: idx(["brand"]),
    product_id: idx(["product_id"]),
    style: idx(["style_number", "style"]),
    item_type: idx(["item_type"]),
    item_subtype: idx(["item_subtype"]),
    target_group: idx(["target_group"]),
    season: idx(["season"]),
    collection: idx(["collection"]),
    gpc_brick: idx(["gpc_brick"]),
    materials: idx(["materials"]),
    contains_animal_origin: idx(["contains_animal_origin"]),
    footwear_materials: idx(["footwear_materials"]),
    care: idx(["care"]),
    country: idx(["country_of_origin"]),
    certifications: idx(["certifications"]),
    dpp: idx(["dpp_url"]),
    status: idx(["status"]),
    variant_id: idx(["variant_id"]),
    gtin: idx(["gtin", "ean", "barcode"]),
    sku: idx(["sku"]),
    color: idx(["color_code", "colour_code"]),
    color_family: idx(["color_family", "colour_family"]),
    supplier_color: idx(["supplier_color"]),
    size: idx(["size"]),
    size_length: idx(["size_length"]),
    size_system: idx(["size_system"]),
    variant_status: idx(["variant_status"]),
  };
  const measurementCols = MEASUREMENT_KEYS.map((k) => ({ key: k, i: idx([k]) })).filter((m) => m.i >= 0);
  const present = presentColumns(cols, defaultLanguage);
  const names = langCols(["name"]);
  const descs = langCols(["description"]);
  const colorNames = langCols(["color_name", "colour_name"]);
  const attrs = cols.map((c, i) => ({ c, i })).filter((x) => x.c.startsWith("attr:"));
  if (!names.length) {
    err(null, "name", "At least one name column (name or name:<lang>) is required.", null, "import_invalid");
    return { groups: [], errors, rows: csv.rows.length };
  }
  const groups = new Map<string, ProductGroup>();
  const order: string[] = [];
  const families = new Map<string, string>(); // product key + colour code → colour family
  const cell = (cells: string[], i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");
  for (const { row, cells } of csv.rows) {
    const style = cell(cells, I.style);
    if (!style) {
      err(row, "style_number", "style_number is empty.");
      continue;
    }
    const key = cell(cells, I.product_id) || style;
    const product: Record<string, unknown> = { style_number: style };
    let rowOk = true;
    const fail = (column: string, detail: string, value: string | null, code = "validation_failed") => {
      err(row, column, detail, value, code);
      rowOk = false;
    };
    const warn = (column: string, detail: string, value: string | null) => err(row, column, detail, value, "validation_failed", "warning");
    const nm: Record<string, string> = {};
    for (const n of names) if (cell(cells, n.i)) nm[n.lang] = cell(cells, n.i);
    if (Object.keys(nm).length) product.name = nm;
    const ds: Record<string, string> = {};
    for (const d of descs) if (cell(cells, d.i)) ds[d.lang] = cell(cells, d.i);
    if (Object.keys(ds).length) product.description = ds;
    const simple: [keyof typeof I, string][] = [
      ["season", "season"],
      ["collection", "collection"],
      ["gpc_brick", "gpc_brick"],
      ["country", "country_of_origin"],
      ["dpp", "dpp_url"],
    ];
    for (const [k, f] of simple) if (cell(cells, I[k])) product[f] = f === "country_of_origin" ? cell(cells, I[k]).toUpperCase() : cell(cells, I[k]);
    for (const [k, f] of [
      ["item_type", "item_type"],
      ["item_subtype", "item_subtype"],
      ["target_group", "target_group"],
    ] as const) {
      const v = cell(cells, I[k]);
      if (!v) continue;
      const key2 = v.toLowerCase().replace(/[\s-]+/g, "_");
      if (!KEY_RE.test(key2)) fail(f, `"${v}" is not a valid ${f} key.`, v);
      else product[f] = key2;
    }
    const mat = cell(cells, I.materials);
    if (mat) {
      const m = parseMaterials(mat);
      if ("error" in m) fail("materials", m.error, mat);
      else product.materials = m.value;
    }
    const animal = cell(cells, I.contains_animal_origin);
    if (animal) {
      const b = parseBool(animal);
      if (b === null) fail("contains_animal_origin", "contains_animal_origin must be yes or no.", animal);
      else product.contains_animal_origin = b;
    }
    const fw = cell(cells, I.footwear_materials);
    if (fw) {
      const r = parseFootwearCell(fw);
      if ("error" in r) fail("footwear_materials", r.error, fw);
      else product.footwear_materials = r.value;
    }
    const care = cell(cells, I.care);
    if (care) {
      const codes = care.split("|").map((c) => c.trim()).filter(Boolean);
      const list: { code: string; text: null }[] = [];
      for (const c of codes) {
        const k = c.toLowerCase();
        if (!KEY_RE.test(k)) fail("care", `"${c}" is not a valid care code.`, care);
        else {
          if (!CARE_CODES.has(k)) warn("care", `Unknown care code "${c}" was kept.`, care);
          list.push({ code: k, text: null });
        }
      }
      product.care = list;
    }
    const certs = cell(cells, I.certifications);
    if (certs) {
      const r = parseCertificationsCell(certs);
      if ("error" in r) fail("certifications", r.error, certs);
      else product.certifications = r.value;
    }
    const features: Record<string, FeatureValue> = {};
    for (const f of featureCols) {
      const v = cell(cells, f.i);
      if (!v) continue;
      const r = parseFeatureCell(f.key, v, parseBool);
      if ("error" in r) fail(`feature:${f.key}`, `feature ${f.key}: ${r.error}`, v);
      else features[f.key] = r.value;
    }
    if (Object.keys(features).length) product.features = features;
    const at: Record<string, string> = {};
    for (const a of attrs) if (cell(cells, a.i)) at[a.c.slice(5)] = cell(cells, a.i);
    if (Object.keys(at).length) product.attributes = at;
    const status = cell(cells, I.status).toLowerCase();
    if (status && status !== "published" && status !== "unpublished") fail("status", 'status must be "published" or "unpublished".', status);

    // variant columns
    const anyVariant = [I.variant_id, I.gtin, I.sku, I.color, I.size].some((i) => cell(cells, i) !== "");
    let variant: { row: number; externalId: string; data: Record<string, unknown> } | null = null;
    if (!anyVariant) {
      for (const [column, i] of [["color_family", I.color_family], ["size_length", I.size_length], ...measurementCols.map((m) => [m.key, m.i] as const)] as const)
        if (cell(cells, i)) warn(column, `${column} is ignored on a row without variant columns (gtin, variant_id, sku, color_code or size).`, cell(cells, i));
    } else {
      const color = cell(cells, I.color);
      if (!color) fail("color_code", "color_code is required when a row has variant data.", null);
      const v: Record<string, unknown> = { product_external_id: key, color: { code: color } };
      const vc = v.color as Record<string, unknown>;
      const cn: Record<string, string> = {};
      for (const c of colorNames) if (cell(cells, c.i)) cn[c.lang] = cell(cells, c.i);
      if (Object.keys(cn).length) vc.name = cn;
      if (cell(cells, I.supplier_color)) vc.supplier_color = cell(cells, I.supplier_color);
      const fam = cell(cells, I.color_family);
      if (fam) {
        const r = parseColorFamilyCell(fam);
        if ("error" in r) fail("color_family", r.error, fam);
        else {
          vc.family = r.value;
          const fk = `${key}\u0000${color}`;
          const prev = families.get(fk);
          if (prev === undefined) families.set(fk, r.value);
          else if (prev !== r.value) warn("color_family", `Differs from an earlier row of colour ${color} (${prev}); every variant of one colour should have the same family.`, fam);
        }
      }
      const gtinRaw = cell(cells, I.gtin);
      let gtinWritten: string | null = null;
      if (gtinRaw) {
        const g2 = parseIngestGtin(gtinRaw);
        if ("error" in g2)
          fail("gtin", /e\+?\d/i.test(gtinRaw) ? "This looks like a number mangled by a spreadsheet (e.g. 2.00010010102E+12). Format the column as text and export again." : g2.error, gtinRaw, "invalid_gtin");
        else {
          v.gtin = g2.original;
          gtinWritten = gtinRaw.replace(/\s+/g, "");
        }
      }
      for (const [k, f] of [
        ["sku", "sku"],
        ["size", "size"],
        ["size_length", "size_length"],
        ["size_system", "size_system"],
      ] as const)
        if (cell(cells, I[k])) v[f] = cell(cells, I[k]);
      if (typeof v.size_length === "string" && v.size_length.length > 64) fail("size_length", "size_length may be at most 64 characters.", v.size_length);
      const ms: Measurements = {};
      for (const m of measurementCols) {
        const raw = cell(cells, m.i);
        if (!raw) continue;
        const r = m.key === "strap_length_cm" ? parseStrapCell(raw) : parseMeasurementCell(raw);
        if ("error" in r) fail(m.key, r.error, raw);
        else (ms as Record<string, unknown>)[m.key] = r.value;
      }
      if (Object.keys(ms).length) v.measurements = ms;
      const vs = cell(cells, I.variant_status).toLowerCase();
      if (vs) {
        if (vs !== "published" && vs !== "unpublished") fail("variant_status", 'variant_status must be "published" or "unpublished".', vs);
        else v.status = vs;
      }
      const vid = cell(cells, I.variant_id) || gtinWritten || `${style}-${color}-${cell(cells, I.size)}`;
      variant = { row, externalId: vid, data: v };
    }
    if (!rowOk) continue;

    let g = groups.get(key);
    if (!g) {
      g = { key, firstRow: row, brandRef: cell(cells, I.brand) || null, product, status: status || null, variants: [], rows: [], present };
      groups.set(key, g);
      order.push(key);
    } else {
      // Product columns repeated on each row: a different non-empty value is a warning; the first wins.
      for (const [f, v] of Object.entries(product)) {
        if (f === "features" && isObj(v)) {
          const cur = (g.product.features ??= {}) as Record<string, unknown>;
          for (const [fk, fv] of Object.entries(v)) {
            if (cur[fk] === undefined) cur[fk] = fv;
            else if (JSON.stringify(cur[fk]) !== JSON.stringify(fv)) warn(`feature:${fk}`, `Differs from the first row of ${key}; the first value is used.`, typeof fv === "string" ? fv : JSON.stringify(fv));
          }
          continue;
        }
        if (g.product[f] === undefined) g.product[f] = v;
        else if (JSON.stringify(g.product[f]) !== JSON.stringify(v)) warn(f, `Differs from the first row of ${key}; the first value is used.`, typeof v === "string" ? v : JSON.stringify(v));
      }
      if (!g.brandRef && cell(cells, I.brand)) g.brandRef = cell(cells, I.brand);
      if (!g.status && status) g.status = status;
    }
    g.rows.push(row);
    if (variant) g.variants.push(variant);
  }
  for (const k of order) {
    const g = groups.get(k)!;
    if (!g.product.name) {
      err(g.firstRow, "name", "The product needs a name.");
      groups.delete(k);
    }
  }
  return { groups: order.filter((k) => groups.has(k)).map((k) => groups.get(k)!), errors, rows: csv.rows.length };
}

// ------------------------------------------------------------------ assets.csv

export interface AssetOverride {
  row: number;
  file: string;
  asset_id?: string;
  product?: string;
  color_code?: string | null;
  position?: number;
  role?: string;
  view?: string;
  alt_text?: Record<string, string>;
  rights?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  status?: string;
}

export function parseAssetsCsv(text: string, file: string, defaultLanguage: string, delimiter?: string): { rows: AssetOverride[]; errors: RowError[] } {
  const errors: RowError[] = [];
  const err = (row: number | null, column: string | null, detail: string, value: string | null = null, severity: "error" | "warning" = "error") =>
    errors.push({ file, row, column, severity, obx_error: "validation_failed", detail, value });
  const csv = parseCsv(text, delimiter);
  const cols = csv.header.map(normHeader);
  const fi = cols.indexOf("file");
  if (fi < 0) {
    err(null, "file", "The required column file is missing.");
    return { rows: [], errors };
  }
  const out: AssetOverride[] = [];
  for (const { row, cells } of csv.rows) {
    const get = (name: string) => {
      const i = cols.indexOf(name);
      return i >= 0 ? (cells[i] ?? "").trim() : "";
    };
    const o: AssetOverride = { row, file: get("file").split(/[\\/]/).pop() ?? "" };
    if (!o.file) {
      err(row, "file", "file is empty.");
      continue;
    }
    if (get("asset_id")) o.asset_id = get("asset_id");
    const prod = get("product_id") || get("style_number");
    if (prod) o.product = prod;
    if (cols.includes("color_code") && get("color_code") !== "") o.color_code = get("color_code");
    if (get("position")) {
      if (!/^[1-9][0-9]{0,2}$/.test(get("position"))) err(row, "position", "position must be 1-999.", get("position"));
      else o.position = Number(get("position"));
    }
    if (get("role")) {
      if (!ROLES.includes(get("role").toLowerCase())) err(row, "role", `role must be one of ${ROLES.join(", ")}.`, get("role"));
      else o.role = get("role").toLowerCase();
    }
    if (get("view")) {
      if (!VIEWS.includes(get("view").toLowerCase())) err(row, "view", `view must be one of ${VIEWS.join(", ")}.`, get("view"));
      else o.view = get("view").toLowerCase();
    }
    const alt: Record<string, string> = {};
    cols.forEach((c, i) => {
      const [b, l] = c.split(":");
      if (b === "alt_text" && (cells[i] ?? "").trim()) alt[l ?? defaultLanguage] = cells[i].trim();
    });
    if (Object.keys(alt).length) o.alt_text = alt;
    const rights: Record<string, unknown> = {};
    if (get("license")) rights.license = get("license").toLowerCase();
    if (get("license_text")) rights.license_text = get("license_text");
    if (get("channels")) rights.channels = get("channels").split("|").map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (get("territories")) rights.territories = get("territories").split("|").map((x) => x.trim().toUpperCase()).filter(Boolean);
    for (const f of ["embargo_until", "expires_at"]) {
      if (!get(f)) continue;
      const d = normDateTime(get(f));
      if (!d) err(row, f, "Use a date like 2026-09-28 or 2026-09-28T10:00:00Z.", get(f));
      else rights[f] = d;
    }
    if (get("credit")) rights.credit = get("credit");
    if (get("model_release")) {
      const b = parseBool(get("model_release"));
      if (b === null) err(row, "model_release", "Use true or false.", get("model_release"));
      else rights.model_release = b;
    }
    if (Object.keys(rights).length) o.rights = rights;
    const prov: Record<string, unknown> = {};
    for (const f of ["ai_generated", "ai_edited"]) {
      if (!get(f)) continue;
      const b = parseBool(get(f));
      if (b === null) err(row, f, "Use true or false.", get(f));
      else prov[f] = b;
    }
    if (get("source")) prov.source = get("source").toLowerCase();
    if (get("c2pa")) prov.c2pa = get("c2pa").toLowerCase();
    if (get("c2pa_manifest_url")) prov.c2pa_manifest_url = get("c2pa_manifest_url");
    if (get("generator")) prov.generator = get("generator");
    if (Object.keys(prov).length) o.provenance = prov;
    if (get("status")) {
      const s = get("status").toLowerCase();
      if (s !== "published" && s !== "unpublished") err(row, "status", 'status must be "published" or "unpublished".', s);
      else o.status = s;
    }
    out.push(o);
  }
  return { rows: out, errors };
}

/** Header + two example rows for GET /admin/api/import-template.csv. */
export function importTemplate(languages: string[]): string[][] {
  const langs = languages.length ? languages : ["en"];
  const header = [
    "brand",
    "style_number",
    ...langs.map((l) => `name:${l}`),
    ...langs.map((l) => `description:${l}`),
    "item_type",
    "target_group",
    "season",
    "collection",
    "materials",
    "care",
    "country_of_origin",
    "gtin",
    "sku",
    "color_code",
    ...langs.map((l) => `color_name:${l}`),
    "size",
    "size_system",
  ];
  const ex = (size: string, gtin: string) => [
    "Kestrel",
    "KO-1001",
    ...langs.map((l) => (l === "nl" ? "Merino trui met ronde hals" : l === "de" ? "Merino-Pullover mit Rundhalsausschnitt" : l === "fr" ? "Pull col rond en mérinos" : "Merino Crew Sweater")),
    ...langs.map(() => ""),
    "sweater",
    "unisex",
    "AW26",
    "Highland",
    "main: 100% merino_wool",
    "wash_30_very_mild|do_not_tumble_dry|dry_flat",
    "PT",
    gtin,
    `KO-1001-NVY-${size}`,
    "NVY",
    ...langs.map((l) => (l === "nl" ? "Marineblauw" : l === "de" ? "Marineblau" : l === "fr" ? "Bleu marine" : "Navy")),
    size,
    "INT",
  ];
  return [header, ex("S", "2000100101018"), ex("M", "2000100101025")];
}
