// The canonical import format (docs/import-format.md): products.csv, assets.csv and image file names.
import { normHeader, parseCsv } from "../lib/csv";
import { parseIngestGtin } from "../lib/gtin";
import { KEY_RE, LANG_RE, ROLES, VIEWS } from "./validate";
import { normDateTime } from "../lib/util";

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
  color: string;
  position: number;
  role: string | null;
  view: string | null;
}

/** {style}_{color}_{position}[_{qualifier}…].{ext}, parsed from the right (§2.1). */
export function parseImageName(file: string): ParsedImageName | { error: string } {
  const base = file.split("/").pop()!;
  const m = base.match(/^(.*)\.([A-Za-z]+)$/);
  if (!m || !IMAGE_EXT.test(base)) return { error: "Not an image file name (jpg, jpeg, png, webp, tif, tiff)." };
  const parts = m[1].split("_");
  let role: string | null = null;
  let view: string | null = null;
  while (parts.length > 3) {
    const last = parts[parts.length - 1].toLowerCase();
    if (last === "detail") {
      role = role ?? "detail";
      view = view ?? "detail";
    } else if (ROLES.includes(last) && !VIEWS.includes(last)) role = role ?? last;
    else if (VIEWS.includes(last) && !ROLES.includes(last)) view = view ?? last;
    else if (ROLES.includes(last)) role = role ?? last;
    else break;
    parts.pop();
  }
  if (parts.length < 3) return { error: "The name needs {style}_{colour}_{position}, e.g. KO-1001_NVY_1.jpg." };
  const pos = parts[parts.length - 1];
  if (!/^[1-9][0-9]{0,2}$/.test(pos)) return { error: "The part before the extension (or qualifiers) must be the position 1-999, e.g. KO-1001_NVY_1.jpg." };
  const color = parts[parts.length - 2];
  const style = parts.slice(0, -2).join("_");
  if (!color || !style) return { error: "The name needs {style}_{colour}_{position}." };
  return { style, color, position: Number(pos), role: role ?? null, view };
}

// ------------------------------------------------------------------ materials & care

export function parseMaterials(s: string): { value: { part: string; fibers: { fiber: string; percentage: number }[] }[] } | { error: string; warnings?: string[] } {
  const out: { part: string; fibers: { fiber: string; percentage: number }[] }[] = [];
  const warnings: string[] = [];
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
    const fibers: { fiber: string; percentage: number }[] = [];
    for (const f of body.split(",")) {
      const t = f.trim();
      if (!t) continue;
      const m = t.match(/^(\d+(?:[.,]\d+)?)\s*%\s*(.+)$/);
      if (!m) return { error: `"${t}" should look like "95% cotton".` };
      const pct = Number(m[1].replace(",", "."));
      const key = m[2].trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (!KEY_RE.test(key)) return { error: `"${m[2]}" is not a valid fibre name.` };
      if (!(pct > 0) || pct > 100) return { error: `${m[1]}% is not a valid percentage.` };
      fibers.push({ fiber: key, percentage: pct });
    }
    if (!fibers.length) return { error: `Part "${name}" has no fibres.` };
    const sum = fibers.reduce((a, f) => a + f.percentage, 0);
    if (Math.abs(sum - 100) > 0.01) warnings.push(`The percentages of "${name}" add up to ${sum}, not 100.`);
    out.push({ part: name, fibers });
  }
  if (!out.length) return { error: "No materials found." };
  return warnings.length ? { value: out, ...{ warnings } } : { value: out };
}

export function formatMaterials(m: { part: string; fibers: { fiber: string; percentage: number }[] }[] | null | undefined): string {
  if (!m?.length) return "";
  return m.map((p) => `${p.part}: ${p.fibers.map((f) => `${f.percentage}% ${f.fiber}`).join(", ")}`).join("; ");
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
}

const PRODUCT_COLS = new Set([
  "brand",
  "product_id",
  "style_number",
  "style",
  "name",
  "description",
  "item_type",
  "target_group",
  "season",
  "collection",
  "gpc_brick",
  "materials",
  "care",
  "country_of_origin",
  "dpp_url",
  "status",
]);
const VARIANT_COLS = new Set(["variant_id", "gtin", "ean", "barcode", "sku", "color_code", "colour_code", "color_name", "colour_name", "supplier_color", "size", "size_system", "variant_status"]);

export interface ParsedProducts {
  groups: ProductGroup[];
  errors: RowError[];
  rows: number;
}

/** Parses products.csv into product groups (file order), with row errors and warnings. */
export function parseProductsCsv(text: string, file: string, defaultLanguage: string): ParsedProducts {
  const errors: RowError[] = [];
  const err = (row: number | null, column: string | null, detail: string, value: string | null = null, code = "validation_failed", severity: "error" | "warning" = "error") =>
    errors.push({ file, row, column, severity, obx_error: code, detail, value: value === null ? null : value.slice(0, 500) });
  const csv = parseCsv(text);
  if (!csv.header.length || csv.header.every((h) => h === "")) {
    err(null, null, "The file has no header row.", null, "import_invalid");
    return { groups: [], errors, rows: 0 };
  }
  const cols = csv.header.map(normHeader);
  // Unknown columns: one warning each.
  cols.forEach((c, i) => {
    const [base, lang] = c.split(":");
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
    target_group: idx(["target_group"]),
    season: idx(["season"]),
    collection: idx(["collection"]),
    gpc_brick: idx(["gpc_brick"]),
    materials: idx(["materials"]),
    care: idx(["care"]),
    country: idx(["country_of_origin"]),
    dpp: idx(["dpp_url"]),
    status: idx(["status"]),
    variant_id: idx(["variant_id"]),
    gtin: idx(["gtin", "ean", "barcode"]),
    sku: idx(["sku"]),
    color: idx(["color_code", "colour_code"]),
    supplier_color: idx(["supplier_color"]),
    size: idx(["size"]),
    size_system: idx(["size_system"]),
    variant_status: idx(["variant_status"]),
  };
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
      ["target_group", "target_group"],
    ] as const) {
      const v = cell(cells, I[k]);
      if (!v) continue;
      const key2 = v.toLowerCase().replace(/[\s-]+/g, "_");
      if (!KEY_RE.test(key2)) {
        err(row, f, `"${v}" is not a valid ${f} key.`, v);
        rowOk = false;
      } else product[f] = key2;
    }
    const mat = cell(cells, I.materials);
    if (mat) {
      const m = parseMaterials(mat);
      if ("error" in m) {
        err(row, "materials", m.error, mat);
        rowOk = false;
      } else {
        product.materials = m.value;
        for (const w of (m as { warnings?: string[] }).warnings ?? []) err(row, "materials", w, mat, "validation_failed", "warning");
      }
    }
    const care = cell(cells, I.care);
    if (care) {
      const codes = care.split("|").map((c) => c.trim()).filter(Boolean);
      const list: { code: string; text: null }[] = [];
      for (const c of codes) {
        const k = c.toLowerCase();
        if (!KEY_RE.test(k)) {
          err(row, "care", `"${c}" is not a valid care code.`, care);
          rowOk = false;
        } else {
          if (!CARE_CODES.has(k)) err(row, "care", `Unknown care code "${c}" was kept.`, care, "validation_failed", "warning");
          list.push({ code: k, text: null });
        }
      }
      product.care = list;
    }
    const at: Record<string, string> = {};
    for (const a of attrs) if (cell(cells, a.i)) at[a.c.slice(5)] = cell(cells, a.i);
    if (Object.keys(at).length) product.attributes = at;
    const status = cell(cells, I.status).toLowerCase();
    if (status && status !== "published" && status !== "unpublished") {
      err(row, "status", 'status must be "published" or "unpublished".', status);
      rowOk = false;
    }
    let g = groups.get(key);
    if (!g) {
      if (!rowOk) continue;
      g = { key, firstRow: row, brandRef: cell(cells, I.brand) || null, product, status: status || null, variants: [], rows: [] };
      groups.set(key, g);
      order.push(key);
    } else {
      // Product columns repeated on each row: a different non-empty value is a warning; the first wins.
      for (const [f, v] of Object.entries(product)) {
        if (g.product[f] === undefined) g.product[f] = v;
        else if (JSON.stringify(g.product[f]) !== JSON.stringify(v)) err(row, f, `Differs from the first row of ${key}; the first value is used.`, typeof v === "string" ? v : JSON.stringify(v), "validation_failed", "warning");
      }
      if (!g.brandRef && cell(cells, I.brand)) g.brandRef = cell(cells, I.brand);
      if (!g.status && status) g.status = status;
    }
    g.rows.push(row);
    // variant columns
    const anyVariant = [I.variant_id, I.gtin, I.sku, I.color, I.size].some((i) => cell(cells, i) !== "");
    if (!anyVariant) continue;
    const color = cell(cells, I.color);
    if (!color) {
      err(row, "color_code", "color_code is required when a row has variant data.");
      continue;
    }
    const v: Record<string, unknown> = { product_external_id: key, color: { code: color } };
    const cn: Record<string, string> = {};
    for (const c of colorNames) if (cell(cells, c.i)) cn[c.lang] = cell(cells, c.i);
    if (Object.keys(cn).length) (v.color as Record<string, unknown>).name = cn;
    if (cell(cells, I.supplier_color)) (v.color as Record<string, unknown>).supplier_color = cell(cells, I.supplier_color);
    const gtinRaw = cell(cells, I.gtin);
    let gtinWritten: string | null = null;
    if (gtinRaw) {
      const g2 = parseIngestGtin(gtinRaw);
      if ("error" in g2) {
        err(row, "gtin", /e\+?\d/i.test(gtinRaw) ? "This looks like a number mangled by a spreadsheet (e.g. 2.00010010102E+12). Format the column as text and export again." : g2.error, gtinRaw, "invalid_gtin");
        continue;
      }
      v.gtin = g2.original;
      gtinWritten = gtinRaw.replace(/\s+/g, "");
    }
    for (const [k, f] of [
      ["sku", "sku"],
      ["size", "size"],
      ["size_system", "size_system"],
    ] as const)
      if (cell(cells, I[k])) v[f] = cell(cells, I[k]);
    const vs = cell(cells, I.variant_status).toLowerCase();
    if (vs) {
      if (vs !== "published" && vs !== "unpublished") {
        err(row, "variant_status", 'variant_status must be "published" or "unpublished".', vs);
        continue;
      }
      v.status = vs;
    }
    const vid = cell(cells, I.variant_id) || gtinWritten || `${style}-${color}-${cell(cells, I.size)}`;
    g.variants.push({ row, externalId: vid, data: v });
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

export function parseAssetsCsv(text: string, file: string, defaultLanguage: string): { rows: AssetOverride[]; errors: RowError[] } {
  const errors: RowError[] = [];
  const err = (row: number | null, column: string | null, detail: string, value: string | null = null, severity: "error" | "warning" = "error") =>
    errors.push({ file, row, column, severity, obx_error: "validation_failed", detail, value });
  const csv = parseCsv(text);
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
