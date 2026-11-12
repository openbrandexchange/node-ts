// Protocol representations (Brand, Product, Variant, Asset) built from stored rows.
import type { SettingsData, Rights } from "./ctx";
import { canonicalJson, safeJsonParse } from "../lib/util";
import type { RenditionName } from "./validate";
import { normalizeStoredProduct } from "./article";

export interface FileRef {
  sha256: string;
  bytes: number;
  content_type: string;
  width: number | null;
  height: number | null;
  crc32: number;
}
export type Files = Partial<Record<RenditionName, FileRef>>;

export interface BrandRowLike {
  id: string;
  external_id: string;
  stored: string;
  updated_at: string;
}
export interface ProductRowLike {
  id: string;
  external_id: string;
  brand_id: string;
  stored: string;
  created_at: string;
  updated_at: string;
}
export interface VariantRowLike {
  id: string;
  external_id: string;
  product_id: string;
  brand_id: string;
  gtin14: string | null;
  stored: string;
  updated_at: string;
}
export interface AssetRowLike {
  id: string;
  external_id: string;
  product_id: string;
  brand_id: string;
  stored: string;
  files: string;
  updated_at: string;
}

function ext(stored: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stored)) if (k.startsWith("x-")) out[k] = v;
  return out;
}

export function brandRep(r: BrandRowLike): Record<string, unknown> {
  const s = safeJsonParse<Record<string, unknown>>(r.stored, {});
  return {
    id: r.id,
    external_id: r.external_id,
    name: s.name,
    logo_url: s.logo_url ?? null,
    website: s.website ?? null,
    description: s.description ?? null,
    updated_at: r.updated_at,
    ...ext(s),
  };
}

/** Product fields in Product.json order; every one is present in a response (null when not stated). */
export const PRODUCT_FIELDS = [
  "style_number",
  "name",
  "description",
  "item_type",
  "item_subtype",
  "gpc_brick",
  "target_group",
  "season",
  "collection",
  "materials",
  "contains_animal_origin",
  "footwear_materials",
  "care",
  "country_of_origin",
  "certifications",
  "dpp_url",
  "features",
  "attributes",
] as const;

export function productRep(r: ProductRowLike): Record<string, unknown> {
  const s = normalizeStoredProduct(safeJsonParse<Record<string, unknown>>(r.stored, {}));
  const out: Record<string, unknown> = { id: r.id, external_id: r.external_id, brand_id: r.brand_id };
  for (const f of PRODUCT_FIELDS) out[f] = s[f] ?? null;
  out.created_at = r.created_at;
  out.updated_at = r.updated_at;
  return { ...out, ...ext(s) };
}

export function variantRep(r: VariantRowLike): Record<string, unknown> {
  const s = safeJsonParse<Record<string, unknown>>(r.stored, {});
  return {
    id: r.id,
    external_id: r.external_id,
    product_id: r.product_id,
    brand_id: r.brand_id,
    gtin: r.gtin14 ?? null,
    gtin_original: s.gtin_original ?? null,
    sku: s.sku ?? null,
    color: colorRep(s.color),
    size: s.size ?? null,
    size_length: s.size_length ?? null,
    size_system: s.size_system ?? null,
    measurements: s.measurements ?? null,
    updated_at: r.updated_at,
    ...ext(s),
  };
}

/** Colour with every Color.json property (family added in 0.2: null when not stated). */
function colorRep(c: unknown): unknown {
  if (typeof c !== "object" || c === null || Array.isArray(c)) return c;
  const x = c as Record<string, unknown>;
  return { ...x, code: x.code, name: x.name ?? null, supplier_color: x.supplier_color ?? null, family: x.family ?? null };
}

export function effectiveRights(stored: Record<string, unknown>, settings: SettingsData): Rights {
  const partial = (stored.rights ?? {}) as Partial<Rights>;
  const d = settings.defaults.rights;
  const r = { ...d, ...partial } as Rights;
  return {
    license: r.license,
    license_text: r.license_text ?? null,
    channels: r.channels ?? [],
    territories: r.territories ?? null,
    embargo_until: r.embargo_until ?? null,
    expires_at: r.expires_at ?? null,
    credit: r.credit ?? null,
    model_release: r.model_release ?? null,
  };
}

export function renditionFilename(filename: string, name: RenditionName, fallback: boolean): string {
  if (name === "original" || fallback) return filename;
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return `${base}_${name}.jpg`;
}

export function assetFilename(externalId: string, stored: Record<string, unknown>, files: Files): string {
  if (typeof stored.filename === "string" && stored.filename) return stored.filename;
  const t = files.original?.content_type;
  const e = t === "image/png" ? "png" : t === "image/webp" ? "webp" : "jpg";
  return `${externalId}.${e}`;
}

/** Rendition metadata; missing web/square/thumb fall back to the original bytes (flagged). */
export function renditionMeta(files: Files): Partial<Record<RenditionName, FileRef & { fallback: boolean }>> {
  const out: Partial<Record<RenditionName, FileRef & { fallback: boolean }>> = {};
  if (!files.original) return out;
  out.original = { ...files.original, fallback: false };
  for (const n of ["web", "square", "thumb"] as const) {
    const f = files[n];
    out[n] = f ? { ...f, fallback: false } : { ...files.original, fallback: true };
  }
  return out;
}

/** Viewer-independent asset representation (no URLs). */
export function assetCore(r: AssetRowLike, settings: SettingsData, variantIds: string[] | null): Record<string, unknown> {
  const s = safeJsonParse<Record<string, unknown>>(r.stored, {});
  const files = safeJsonParse<Files>(r.files, {});
  const o = files.original;
  return {
    id: r.id,
    external_id: r.external_id,
    product_id: r.product_id,
    brand_id: r.brand_id,
    media_type: "image",
    color_code: s.color_code ?? null,
    variant_ids: variantIds,
    role: s.role,
    view: s.view ?? null,
    position: s.position,
    filename: assetFilename(r.external_id, s, files),
    alt_text: s.alt_text ?? null,
    content_type: o?.content_type ?? null,
    width: o?.width ?? null,
    height: o?.height ?? null,
    bytes: o?.bytes ?? null,
    sha256: o?.sha256 ?? null,
    rights: effectiveRights(s, settings),
    provenance: s.provenance,
    updated_at: r.updated_at,
    ...ext(s),
  };
}

/** Hash of the protocol representation, excluding ids of the viewer, URLs and timestamps. */
export function repHashInput(kind: string, rep: Record<string, unknown>, extra?: unknown): string {
  const copy: Record<string, unknown> = { ...rep };
  delete copy.updated_at;
  delete copy.created_at;
  delete copy.id;
  return canonicalJson({ kind, rep: copy, extra: extra ?? null });
}
