// The single write path for catalog objects (Ingest API, admin catalog, imports).
// A CatalogSession loads the affected objects, applies operations in memory, then commits all row
// writes and change-feed entries in one atomic batch. Change entries follow docs/ingest.md §8.
import type { Ctx, SettingsData } from "./ctx";
import type { Stmt } from "../platform";
import { ObxError, fieldError, type ErrorCode } from "../lib/problem";
import { canonicalJson, isPlainObject, mergePatch, newId, safeJsonParse, slugify } from "../lib/util";
import { sha256Hex } from "../lib/crypto";
import { parseIngestGtin } from "../lib/gtin";
import { V, ROLES, VIEWS, CHANNELS, COUNTRY_RE, sortKeys, validExternalId, type RenditionName } from "./validate";
import {
  assetCore,
  brandRep,
  effectiveRights,
  productRep,
  repHashInput,
  renditionMeta,
  variantRep,
  PRODUCT_FIELDS,
  type FileRef,
  type Files,
} from "./reps";

export type Kind = "brand" | "product" | "variant" | "asset";
export type Op = "upsert" | "patch" | "delete" | "publish" | "unpublish";
export type Status = "published" | "unpublished";
export type Visibility = "visible" | "hidden" | "pending_files";

export interface IngestResult {
  index?: number | null;
  op: Op;
  kind: Kind;
  external_id: string;
  result: "created" | "updated" | "unchanged" | "deleted" | "error";
  id: string | null;
  visibility: Visibility | null;
  etag: string | null;
  error: Record<string, unknown> | null;
  warnings: string[];
}

interface Orig {
  inDb: boolean;
  status: Status;
  stored: string;
  parent: string | null;
  files: string;
}

export interface Obj {
  kind: Kind;
  id: string;
  ext: string;
  status: Status;
  stored: Record<string, unknown>;
  parent: string | null;
  files: Files;
  staged: Files | null;
  staged_at: string | null;
  created_at: string;
  updated_at: string;
  modified_at: string;
  content_updated_at?: string;
  inDb: boolean;
  deleted: boolean;
  dirty: boolean;
  loadSeq: number;
  o: Orig;
}

const PREFIX: Record<Kind, string> = { brand: "brd", product: "prd", variant: "var", asset: "ast" };
const TABLE: Record<Kind, string> = { brand: "brands", product: "products", variant: "variants", asset: "assets" };
const REND = ["web", "square", "thumb"] as const;

export interface SessionOptions {
  /** Ingest token brand restriction (external ids); null = all brands. */
  allowedBrands: string[] | null;
  canDelete: boolean;
}

function assetRowLike(o: Obj, stored: Record<string, unknown>, files: Files, brandId: string, productId: string) {
  return {
    id: o.id,
    external_id: o.ext,
    product_id: productId,
    brand_id: brandId,
    stored: JSON.stringify(stored),
    files: JSON.stringify(files),
    updated_at: o.updated_at,
  };
}

function filesEqual(a: Files, b: Files): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function hasAllRenditions(f: Files | null | undefined): boolean {
  return !!f && REND.every((n) => !!f[n]);
}

export class CatalogSession {
  private objs = new Map<string, Obj>();
  private byId = new Map<string, Obj>();
  private seq = 0;
  private childrenLoaded = new Set<string>();
  settings!: SettingsData;
  private brandCountCache: number | null = null;
  /** Assets being rewritten together (one import product colour): their current positions do not conflict. */
  positionIgnore: Set<string> | null = null;

  constructor(
    private ctx: Ctx,
    private opts: SessionOptions,
  ) {}

  async init(): Promise<this> {
    this.settings = await this.ctx.settings();
    return this;
  }

  // ------------------------------------------------------------------ loading

  private fromRow(kind: Kind, r: Record<string, unknown>): Obj {
    const parent = kind === "brand" ? null : kind === "product" ? (r.brand_id as string) : (r.product_id as string);
    const o: Obj = {
      kind,
      id: r.id as string,
      ext: r.external_id as string,
      status: r.status as Status,
      stored: safeJsonParse(r.stored as string, {}),
      parent,
      files: kind === "asset" ? safeJsonParse<Files>(r.files as string, {}) : {},
      staged: kind === "asset" ? safeJsonParse<Files | null>(r.staged as string, null) : null,
      staged_at: (r.staged_at as string) ?? null,
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
      modified_at: r.modified_at as string,
      content_updated_at: (r.content_updated_at as string) ?? undefined,
      inDb: true,
      deleted: false,
      dirty: false,
      loadSeq: this.seq++,
      o: {
        inDb: true,
        status: r.status as Status,
        stored: r.stored as string,
        parent,
        files: kind === "asset" ? ((r.files as string) ?? "{}") : "{}",
      },
    };
    return o;
  }

  private register(o: Obj) {
    this.objs.set(`${o.kind}:${o.ext}`, o);
    this.byId.set(o.id, o);
  }

  private async ensureParents(o: Obj) {
    if (o.kind === "brand") return;
    const parentKind: Kind = o.kind === "product" ? "brand" : "product";
    for (const pid of new Set([o.parent, o.o.parent])) {
      if (pid && !this.byId.has(pid)) await this.loadById(parentKind, pid);
    }
  }

  async load(kind: Kind, ext: string): Promise<Obj | null> {
    const key = `${kind}:${ext}`;
    if (this.objs.has(key)) {
      const o = this.objs.get(key)!;
      return o.deleted ? null : o;
    }
    const row = await this.ctx.db.first(`SELECT * FROM ${TABLE[kind]} WHERE external_id = ?`, [ext]);
    if (!row) return null;
    const o = this.fromRow(kind, row);
    this.register(o);
    await this.ensureParents(o);
    return o;
  }

  async loadById(kind: Kind, id: string): Promise<Obj | null> {
    if (this.byId.has(id)) return this.byId.get(id)!;
    const row = await this.ctx.db.first(`SELECT * FROM ${TABLE[kind]} WHERE id = ?`, [id]);
    if (!row) return null;
    const existing = this.objs.get(`${kind}:${row.external_id}`);
    if (existing) return existing;
    const o = this.fromRow(kind, row);
    this.register(o);
    await this.ensureParents(o);
    return o;
  }

  async loadChildren(productId: string) {
    if (this.childrenLoaded.has(productId)) return;
    this.childrenLoaded.add(productId);
    for (const kind of ["variant", "asset"] as const) {
      const rows = await this.ctx.db.all(`SELECT * FROM ${TABLE[kind]} WHERE product_id = ?`, [productId]);
      for (const r of rows) {
        if (this.byId.has(r.id as string) || this.objs.has(`${kind}:${r.external_id}`)) continue;
        this.register(this.fromRow(kind, r));
      }
    }
  }

  private children(productId: string, which: "o" | "c"): Obj[] {
    const out: Obj[] = [];
    for (const o of this.byId.values()) {
      if (o.kind !== "variant" && o.kind !== "asset") continue;
      if (which === "c" ? !o.deleted && o.parent === productId : o.o.inDb && o.o.parent === productId) out.push(o);
    }
    return out;
  }

  private async brandCount(): Promise<number> {
    if (this.brandCountCache === null) {
      const r = await this.ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM brands");
      this.brandCountCache = r?.n ?? 0;
    }
    return this.brandCountCache;
  }

  // ------------------------------------------------------------------ state helpers

  private state(o: Obj, w: "o" | "c") {
    if (w === "o") return { exists: o.o.inDb, status: o.o.status, parent: o.o.parent, stored: safeJsonParse<Record<string, unknown>>(o.o.stored, {}), files: safeJsonParse<Files>(o.o.files, {}) };
    return { exists: !o.deleted, status: o.status, parent: o.parent, stored: o.stored, files: o.files };
  }

  visible(o: Obj, w: "o" | "c"): boolean {
    const s = this.state(o, w);
    if (!s.exists || s.status !== "published") return false;
    if (o.kind === "brand") return true;
    const parent = s.parent ? this.byId.get(s.parent) : undefined;
    if (!parent) return false;
    if (o.kind === "asset") {
      if (!s.files.original) return false;
      const exp = effectiveRights(s.stored, this.settings).expires_at;
      if (exp && Date.parse(exp) <= this.ctx.now()) return false;
    }
    return this.visible(parent, w);
  }

  brandIdOf(o: Obj, w: "o" | "c"): string | null {
    if (o.kind === "brand") return o.id;
    const p = this.state(o, w).parent;
    if (!p) return null;
    if (o.kind === "product") return p;
    const prod = this.byId.get(p);
    return prod ? this.state(prod, w).parent : null;
  }

  private repHash(o: Obj, w: "o" | "c"): string {
    const s = this.state(o, w);
    const brandId = this.brandIdOf(o, w) ?? "";
    switch (o.kind) {
      case "brand":
        return repHashInput("brand", brandRep({ id: o.id, external_id: o.ext, stored: JSON.stringify(s.stored), updated_at: "" }));
      case "product":
        return repHashInput("product", productRep({ id: o.id, external_id: o.ext, brand_id: brandId, stored: JSON.stringify(s.stored), created_at: "", updated_at: "" }));
      case "variant": {
        const g = typeof s.stored.gtin_original === "string" ? parseIngestGtin(s.stored.gtin_original as string) : null;
        return repHashInput(
          "variant",
          variantRep({
            id: o.id,
            external_id: o.ext,
            product_id: s.parent ?? "",
            brand_id: brandId,
            gtin14: g && "gtin14" in g ? g.gtin14 : null,
            stored: JSON.stringify(s.stored),
            updated_at: "",
          }),
        );
      }
      case "asset": {
        const core = assetCore(assetRowLike(o, s.stored, s.files, brandId, s.parent ?? ""), this.settings, null);
        const meta = renditionMeta(s.files);
        return repHashInput("asset", core, { variant_external_ids: s.stored.variant_external_ids ?? null, renditions: meta });
      }
    }
  }

  private externalIdOf(id: string | null): string | null {
    if (!id) return null;
    return this.byId.get(id)?.ext ?? null;
  }

  /** The input form of a record (what a PUT with the same data would send). */
  recordData(o: Obj): Record<string, unknown> {
    const s = o.stored;
    switch (o.kind) {
      case "brand":
        return { ...s, status: o.status };
      case "product":
        return { brand_external_id: this.externalIdOf(o.parent), ...s, status: o.status };
      case "variant": {
        const { gtin_original, ...rest } = s;
        return { product_external_id: this.externalIdOf(o.parent), gtin: gtin_original ?? null, ...rest, status: o.status };
      }
      case "asset": {
        const files: Record<string, unknown> = {};
        for (const [k, f] of Object.entries(o.files)) if (f) files[k] = { sha256: f.sha256, width: f.width, height: f.height };
        return { product_external_id: this.externalIdOf(o.parent), ...s, files, status: o.status };
      }
    }
  }

  async etag(o: Obj): Promise<string> {
    return `"${(await sha256Hex(canonicalJson(this.recordData(o)))).slice(0, 32)}"`;
  }

  visibilityOf(o: Obj): Visibility {
    if (o.kind === "asset" && !o.files.original) return "pending_files";
    return this.visible(o, "c") ? "visible" : "hidden";
  }

  missingFiles(o: Obj): RenditionName[] | null {
    if (o.kind !== "asset") return null;
    return (["original", ...REND] as RenditionName[]).filter((n) => !o.files[n]);
  }

  async record(o: Obj): Promise<Record<string, unknown>> {
    const data = this.recordData(o);
    const rec: Record<string, unknown> = {
      kind: o.kind,
      id: o.id,
      external_id: o.ext,
      status: o.status,
      visibility: this.visibilityOf(o),
      etag: await this.etag(o),
      created_at: o.created_at,
      updated_at: o.modified_at,
      data,
    };
    if (o.kind === "asset") {
      // IngestRecord.data is the write model "with defaults applied": the
      // effective rights (node defaults + the asset's own fields), as every
      // node shows them. missing_files is for assets only.
      data.rights = effectiveRights(o.stored, this.settings);
      rec.missing_files = this.missingFiles(o);
    }
    return rec;
  }

  // ------------------------------------------------------------------ operations

  private checkBrandAllowed(brandExt: string | null) {
    if (!this.opts.allowedBrands || brandExt === null) return;
    if (!this.opts.allowedBrands.includes(brandExt)) throw new ObxError("forbidden", `This token may not write to brand "${brandExt}".`);
  }

  private brandExtOfProduct(p: Obj | null): string | null {
    if (!p) return null;
    return this.externalIdOf(p.parent);
  }

  private async resolveBrand(data: Record<string, unknown>, existing: Obj | null, v: V): Promise<Obj | null> {
    const ref = data.brand_external_id;
    if (ref === undefined || ref === null) {
      if (existing?.parent) return this.byId.get(existing.parent) ?? null;
      const n = await this.brandCount();
      if (n === 1) {
        const row = await this.ctx.db.first<{ external_id: string }>("SELECT external_id FROM brands LIMIT 1");
        if (row) return this.load("brand", row.external_id);
      }
      v.err("/brand_external_id", "Name the brand: this node has more than one brand.");
      return null;
    }
    if (typeof ref !== "string" || !validExternalId(ref)) {
      v.err("/brand_external_id", "Must be a brand id.");
      return null;
    }
    const b = await this.load("brand", ref.trim());
    if (!b) throw new ObxError("unknown_parent", `Brand "${ref}" does not exist. Create the brand first.`, [fieldError("/brand_external_id", "Unknown brand.", "unknown_parent")]);
    return b;
  }

  private async resolveProduct(ref: unknown, v: V): Promise<Obj | null> {
    if (typeof ref !== "string" || !validExternalId(ref)) {
      v.err("/product_external_id", "This field is required.");
      return null;
    }
    const p = await this.load("product", ref.trim());
    if (!p) throw new ObxError("unknown_parent", `Product "${ref}" does not exist. Create the product first.`, [fieldError("/product_external_id", "Unknown product.", "unknown_parent")]);
    return p;
  }

  private normStatus(v: V, raw: unknown): Status | null {
    return v.enumv(raw, "/status", ["published", "unpublished"] as const);
  }

  private async resolveFiles(input: unknown, v: V): Promise<Files | undefined> {
    if (input === undefined || input === null) return undefined;
    if (!isPlainObject(input)) {
      v.err("/files", "Must be an object with original/web/square/thumb.");
      return undefined;
    }
    const out: Files = {};
    const shas: string[] = [];
    for (const [k, ref] of Object.entries(input)) {
      if (k.startsWith("x-")) continue;
      if (!["original", "web", "square", "thumb"].includes(k)) {
        v.warnings.push(`Unknown rendition /files/${k} was ignored.`);
        continue;
      }
      if (!isPlainObject(ref) || typeof ref.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(ref.sha256)) {
        v.err(`/files/${k}/sha256`, "Must be the lowercase hex sha256 of an uploaded file.");
        continue;
      }
      shas.push(ref.sha256);
    }
    if (!v.ok) return undefined;
    const rows = shas.length
      ? await this.ctx.db.all<FileRef & { crc32: number }>(`SELECT sha256, bytes, content_type, width, height, crc32 FROM blobs WHERE sha256 IN (${shas.map(() => "?").join(",")})`, shas)
      : [];
    const bySha = new Map(rows.map((r) => [r.sha256, r]));
    const missing: string[] = [];
    for (const [k, ref] of Object.entries(input as Record<string, { sha256: string }>)) {
      if (!["original", "web", "square", "thumb"].includes(k)) continue;
      const b = bySha.get(ref.sha256);
      if (!b) {
        missing.push(k);
        continue;
      }
      out[k as RenditionName] = { sha256: b.sha256, bytes: b.bytes, content_type: b.content_type, width: b.width, height: b.height, crc32: b.crc32 };
    }
    if (missing.length)
      throw new ObxError(
        "blob_missing",
        `Upload these files first: ${missing.join(", ")}.`,
        missing.map((k) => fieldError(`/files/${k}/sha256`, "No file with this sha256 was uploaded.", "blob_missing")),
      );
    this.checkRenditionRules(out, v, "/files");
    return out;
  }

  checkRenditionRules(files: Files, v: V, base: string) {
    const orig = files.original;
    const longest = (f: FileRef) => Math.max(f.width ?? 0, f.height ?? 0);
    for (const n of REND) {
      const f = files[n];
      if (!f) continue;
      if (f.content_type !== "image/jpeg") v.err(`${base}/${n}`, `The ${n} version must be a JPEG.`);
      const max = n === "thumb" ? 600 : 2000;
      if (longest(f) > max) v.err(`${base}/${n}`, `The ${n} version may be at most ${max} px on its longest side.`);
      if (n === "square" && f.width !== f.height) v.err(`${base}/${n}`, "The square version must be square.");
      if (orig && n !== "square" && longest(f) > longest(orig)) v.err(`${base}/${n}`, `The ${n} version may not be larger than the original.`);
    }
  }

  private normBrand(d: Record<string, unknown>, v: V) {
    v.known(d, ["name", "logo_url", "website", "description", "status"], "");
    const stored = sortKeys({
      name: v.str(d.name, "/name", { required: true, min: 1, max: 200 }),
      logo_url: v.url(d.logo_url, "/logo_url"),
      website: v.url(d.website, "/website"),
      description: v.localized(d.description, "/description"),
      ...v.extensions(d),
    });
    return { stored, status: this.normStatus(v, d.status) };
  }

  private normProduct(d: Record<string, unknown>, v: V) {
    v.known(d, ["brand_external_id", ...PRODUCT_FIELDS, "status"], "");
    const stored: Record<string, unknown> = {
      style_number: v.str(d.style_number, "/style_number", { required: true, min: 1, max: 200 }),
      name: v.localized(d.name, "/name", true),
      description: v.localized(d.description, "/description"),
      item_type: v.key(d.item_type, "/item_type"),
      gpc_brick: v.str(d.gpc_brick, "/gpc_brick", { pattern: /^[0-9]{8}$/, msg: "A GPC brick code has 8 digits." }),
      target_group: v.key(d.target_group, "/target_group"),
      season: v.str(d.season, "/season", { max: 64 }),
      collection: v.str(d.collection, "/collection", { max: 200 }),
      materials: v.materials(d.materials, "/materials"),
      care: v.care(d.care, "/care"),
      country_of_origin: v.country(d.country_of_origin, "/country_of_origin"),
      dpp_url: v.url(d.dpp_url, "/dpp_url"),
      attributes: v.attributes(d.attributes, "/attributes"),
      ...v.extensions(d),
    };
    return { stored: sortKeys(stored), status: this.normStatus(v, d.status) };
  }

  private normVariant(d: Record<string, unknown>, v: V) {
    v.known(d, ["product_external_id", "gtin", "sku", "color", "size", "size_system", "status"], "");
    let gtinOriginal: string | null = null;
    if (d.gtin !== undefined && d.gtin !== null) {
      if (typeof d.gtin !== "string") v.err("/gtin", "Must be text of digits.", "invalid_gtin");
      else {
        const g = parseIngestGtin(d.gtin);
        if ("error" in g) v.err("/gtin", g.error, "invalid_gtin");
        else gtinOriginal = g.original;
      }
    }
    let color: Record<string, unknown> | null = null;
    if (!isPlainObject(d.color)) v.err("/color", "This field is required (at least a colour code).");
    else {
      const c = d.color;
      color = sortKeys({
        code: v.str(c.code, "/color/code", { required: true, min: 1, max: 64 }),
        name: v.localized(c.name, "/color/name"),
        supplier_color: v.str(c.supplier_color, "/color/supplier_color", { max: 200 }),
        ...v.extensions(c),
      });
    }
    const stored = sortKeys({
      gtin_original: gtinOriginal,
      sku: v.str(d.sku, "/sku", { max: 200 }),
      color,
      size: v.str(d.size, "/size", { max: 64 }),
      size_system: v.str(d.size_system, "/size_system", { max: 16 }),
      ...v.extensions(d),
    });
    return { stored, status: this.normStatus(v, d.status) };
  }

  private normAsset(d: Record<string, unknown>, v: V) {
    v.known(d, ["product_external_id", "color_code", "variant_external_ids", "media_type", "role", "view", "position", "filename", "alt_text", "rights", "provenance", "files", "status"], "");
    if (d.media_type !== undefined && d.media_type !== "image") v.err("/media_type", "Only image is supported.");
    let variantExts: string[] | null = null;
    if (Array.isArray(d.variant_external_ids)) {
      variantExts = [];
      d.variant_external_ids.forEach((x, i) => {
        if (typeof x === "string" && validExternalId(x)) variantExts!.push(x.trim());
        else v.err(`/variant_external_ids/${i}`, "Must be a variant id.");
      });
    } else if (d.variant_external_ids !== undefined && d.variant_external_ids !== null) v.err("/variant_external_ids", "Must be a list.");
    let rights: Record<string, unknown> | null = null;
    if (isPlainObject(d.rights)) {
      const r = d.rights;
      rights = {};
      if ("license" in r) rights.license = v.enumv(r.license, "/rights/license", ["retailer-use", "custom"] as const, true);
      if ("license_text" in r) rights.license_text = v.str(r.license_text, "/rights/license_text", { max: 20000 });
      if ("channels" in r) {
        if (!Array.isArray(r.channels)) v.err("/rights/channels", "Must be a list.");
        else {
          const ch = [...new Set(r.channels)].filter((c) => {
            if (typeof c === "string" && CHANNELS.includes(c)) return true;
            v.err("/rights/channels", `Channels are: ${CHANNELS.join(", ")}.`);
            return false;
          });
          rights.channels = ch;
        }
      }
      if ("territories" in r) {
        if (r.territories === null) rights.territories = null;
        else if (!Array.isArray(r.territories)) v.err("/rights/territories", "Must be a list of country codes or null.");
        else
          rights.territories = [...new Set(r.territories)].filter((t) => {
            if (typeof t === "string" && COUNTRY_RE.test(t)) return true;
            v.err("/rights/territories", "Use two-letter ISO country codes.");
            return false;
          });
      }
      if ("embargo_until" in r) rights.embargo_until = v.dateTime(r.embargo_until, "/rights/embargo_until");
      if ("expires_at" in r) rights.expires_at = v.dateTime(r.expires_at, "/rights/expires_at");
      if ("credit" in r) rights.credit = v.str(r.credit, "/rights/credit", { max: 500 });
      if ("model_release" in r) rights.model_release = v.bool(r.model_release, "/rights/model_release");
      Object.assign(rights, v.extensions(r));
      if (rights.license === "custom" && !rights.license_text) v.err("/rights/license_text", "A custom licence needs its text.");
      // Keep only what differs from the node's default rights, so a record
      // read with defaults applied and written back is unchanged, and the
      // asset keeps following the defaults.
      const defaults = effectiveRights({}, this.settings) as unknown as Record<string, unknown>;
      for (const k of Object.keys(rights)) if (k in defaults && canonicalJson(rights[k] ?? null) === canonicalJson(defaults[k] ?? null)) delete rights[k];
      rights = Object.keys(rights).length ? sortKeys(rights) : null;
    } else if (d.rights !== undefined && d.rights !== null) v.err("/rights", "Must be an object.");
    const p = isPlainObject(d.provenance) ? d.provenance : {};
    if (d.provenance !== undefined && d.provenance !== null && !isPlainObject(d.provenance)) v.err("/provenance", "Must be an object.");
    const aiGen = v.bool(p.ai_generated, "/provenance/ai_generated") ?? false;
    const provenance = sortKeys({
      ai_generated: aiGen,
      ai_edited: v.bool(p.ai_edited, "/provenance/ai_edited") ?? false,
      source: v.enumv(p.source, "/provenance/source", ["photo", "generated", "composite"] as const) ?? (aiGen ? "generated" : "photo"),
      c2pa: v.enumv(p.c2pa, "/provenance/c2pa", ["embedded", "sidecar", "none"] as const) ?? "none",
      c2pa_manifest_url: v.url(p.c2pa_manifest_url, "/provenance/c2pa_manifest_url"),
      generator: v.str(p.generator, "/provenance/generator", { max: 200 }),
      ...v.extensions(p),
    });
    const stored = sortKeys({
      color_code: v.str(d.color_code, "/color_code", { max: 64 }),
      variant_external_ids: variantExts,
      media_type: "image",
      role: v.enumv(d.role, "/role", ROLES, true),
      view: v.enumv(d.view, "/view", VIEWS),
      position: v.int(d.position, "/position", 1, 999, true),
      filename: v.str(d.filename, "/filename", { max: 255 }),
      alt_text: v.localized(d.alt_text, "/alt_text"),
      rights,
      provenance,
      ...v.extensions(d),
    });
    return { stored, status: this.normStatus(v, d.status) };
  }

  private async checkIfMatch(o: Obj | null, ifMatch: string | null | undefined) {
    if (!ifMatch) return;
    if (ifMatch === "*" && o) return;
    if (!o || (await this.etag(o)) !== ifMatch.trim()) throw new ObxError("precondition_failed", "The record changed since you read it (If-Match did not match).");
  }

  private newObj(kind: Kind, ext: string, now: string): Obj {
    const o: Obj = {
      kind,
      id: newId(PREFIX[kind]),
      ext,
      status: this.settings.defaults.ingest_status,
      stored: {},
      parent: null,
      files: {},
      staged: null,
      staged_at: null,
      created_at: now,
      updated_at: now,
      modified_at: now,
      content_updated_at: now,
      inDb: false,
      deleted: false,
      dirty: true,
      loadSeq: this.seq++,
      o: { inDb: false, status: "unpublished", stored: "{}", parent: null, files: "{}" },
    };
    return o;
  }

  private async result(op: Op, kind: Kind, ext: string, r: IngestResult["result"], o: Obj | null, warnings: string[]): Promise<IngestResult> {
    return {
      op,
      kind,
      external_id: ext,
      result: r,
      id: o?.id ?? null,
      visibility: o && r !== "deleted" ? this.visibilityOf(o) : null,
      etag: o && r !== "deleted" ? await this.etag(o) : null,
      error: null,
      warnings,
    };
  }

  /** Run one operation; errors become a result with result=error (never thrown). */
  async apply(op: Op, kind: Kind, extRaw: string, data: unknown, ifMatch?: string | null): Promise<IngestResult> {
    const ext = typeof extRaw === "string" ? validExternalId(extRaw) : null;
    try {
      if (!ext) throw new ObxError("validation_failed", "external_id must be 1-200 characters without control characters or '/'.", [fieldError("/external_id", "Invalid external id.")]);
      if (!["brand", "product", "variant", "asset"].includes(kind)) throw new ObxError("validation_failed", "kind must be brand, product, variant or asset.");
      switch (op) {
        case "upsert":
          if (!isPlainObject(data)) throw new ObxError("validation_failed", "data must be an object.", [fieldError("/data", "Must be an object.")]);
          return await this.upsert(op, kind, ext, data, ifMatch);
        case "patch":
        case "publish":
        case "unpublish": {
          const patch = op === "patch" ? data : { status: op === "publish" ? "published" : "unpublished" };
          if (!isPlainObject(patch)) throw new ObxError("validation_failed", "data must be a merge patch object.");
          return await this.patch(op, kind, ext, patch, ifMatch);
        }
        case "delete":
          return await this.remove(kind, ext, ifMatch);
        default:
          throw new ObxError("validation_failed", "op must be upsert, patch, delete, publish or unpublish.");
      }
    } catch (e) {
      if (e instanceof ObxError) return errorResult(op, kind, ext ?? String(extRaw), e);
      throw e;
    }
  }

  private async patch(op: Op, kind: Kind, ext: string, patch: Record<string, unknown>, ifMatch?: string | null): Promise<IngestResult> {
    const o = await this.load(kind, ext);
    if (!o) throw new ObxError("not_found", `No ${kind} with external id "${ext}".`);
    const merged = mergePatch(this.recordData(o), patch) as Record<string, unknown>;
    return this.upsert(op, kind, ext, merged, ifMatch, true);
  }

  private async upsert(op: Op, kind: Kind, ext: string, data: Record<string, unknown>, ifMatch?: string | null, fromPatch = false): Promise<IngestResult> {
    const v = new V();
    const existing = await this.load(kind, ext);
    await this.checkIfMatch(existing, ifMatch);
    const now = this.ctx.iso();
    let norm: { stored: Record<string, unknown>; status: Status | null };
    let parent: Obj | null = null;
    let files: Files | undefined;
    switch (kind) {
      case "brand":
        norm = this.normBrand(data, v);
        this.checkBrandAllowed(ext);
        break;
      case "product":
        norm = this.normProduct(data, v);
        parent = await this.resolveBrand(data, existing, v);
        this.checkBrandAllowed(parent?.ext ?? null);
        if (existing) this.checkBrandAllowed(this.brandExtOfProduct(existing));
        break;
      case "variant":
        norm = this.normVariant(data, v);
        parent = await this.resolveProduct(data.product_external_id, v);
        this.checkBrandAllowed(this.brandExtOfProduct(parent));
        if (existing) this.checkBrandAllowed(this.brandExtOfProduct(this.byId.get(existing.parent ?? "") ?? null));
        break;
      case "asset":
        norm = this.normAsset(data, v);
        parent = await this.resolveProduct(data.product_external_id, v);
        this.checkBrandAllowed(this.brandExtOfProduct(parent));
        if (existing) this.checkBrandAllowed(this.brandExtOfProduct(this.byId.get(existing.parent ?? "") ?? null));
        if (v.ok) files = await this.resolveFiles(data.files, v);
        break;
    }
    if (!v.ok) {
      const gt = v.errors.find((e) => e.obx_error === "invalid_gtin");
      throw new ObxError(gt ? "invalid_gtin" : "validation_failed", gt ? gt.detail : "Some fields are invalid.", v.errors);
    }
    const status: Status = norm.status ?? existing?.status ?? this.settings.defaults.ingest_status;

    // kind-specific uniqueness
    if (kind === "variant") await this.checkGtin(norm.stored.gtin_original as string | null, existing, ext);
    if (kind === "asset") await this.checkPosition(parent!, norm.stored.color_code as string | null, norm.stored.position as number, existing, ext);

    let newFiles: Files | undefined;
    if (kind === "asset") {
      const cur = existing?.files ?? {};
      if (files) {
        newFiles = { ...cur };
        const origChanged = files.original && cur.original?.sha256 !== files.original.sha256;
        if (origChanged) for (const n of REND) if (!files[n]) delete newFiles[n];
        Object.assign(newFiles, files);
        const v2 = new V();
        this.checkRenditionRules(newFiles, v2, "/files");
        if (!v2.ok) throw new ObxError("validation_failed", "The files do not follow the rendition rules.", v2.errors);
      } else newFiles = cur;
    }

    const parentId = parent?.id ?? null;
    if (existing) {
      const same =
        canonicalJson(existing.stored) === canonicalJson(norm.stored) &&
        existing.status === status &&
        existing.parent === parentId &&
        (kind !== "asset" || (filesEqual(existing.files, newFiles!) && !(files && existing.staged)));
      if (same) return this.result(op, kind, ext, "unchanged", existing, v.warnings);
      if (existing.parent !== parentId && kind === "product") await this.loadChildren(existing.id);
      if (kind === "product" && existing.status !== status) await this.loadChildren(existing.id);
      existing.stored = norm.stored;
      existing.status = status;
      existing.parent = parentId;
      if (kind === "asset") {
        existing.files = newFiles!;
        if (files) {
          existing.staged = null;
          existing.staged_at = null;
        }
      }
      existing.dirty = true;
      existing.modified_at = now;
      if (kind === "product" && existing.o.parent !== parentId) for (const ch of this.children(existing.id, "c")) ch.dirty = true;
      return this.result(op, kind, ext, "updated", existing, v.warnings);
    }
    if (fromPatch) throw new ObxError("not_found", `No ${kind} with external id "${ext}".`);
    const o = this.newObj(kind, ext, now);
    o.stored = norm.stored;
    o.status = status;
    o.parent = parentId;
    if (kind === "asset") o.files = newFiles ?? {};
    this.register(o);
    if (kind === "brand") this.brandCountCache = (this.brandCountCache ?? (await this.brandCount())) + 1;
    return this.result(op, kind, ext, "created", o, v.warnings);
  }

  private async checkGtin(gtinOriginal: string | null, existing: Obj | null, ext: string) {
    if (!gtinOriginal) return;
    const g = parseIngestGtin(gtinOriginal);
    if ("error" in g) return;
    // in-session holders
    for (const o of this.byId.values()) {
      if (o.kind !== "variant" || o.deleted || o === existing) continue;
      const og = o.stored.gtin_original as string | null;
      if (og) {
        const pg = parseIngestGtin(og);
        if (!("error" in pg) && pg.gtin14 === g.gtin14) throw gtinConflict(o.ext);
      }
    }
    const row = await this.ctx.db.first<{ id: string; external_id: string }>("SELECT id, external_id FROM variants WHERE gtin14 = ?", [g.gtin14]);
    if (row && row.external_id !== ext) {
      const inSession = this.byId.get(row.id);
      if (inSession && (inSession.deleted || inSession.stored.gtin_original !== gtinOriginal)) {
        const sg = inSession.stored.gtin_original as string | null;
        const same = sg ? (parseIngestGtin(sg) as { gtin14?: string }).gtin14 === g.gtin14 : false;
        if (inSession.deleted || !same) return;
      }
      throw gtinConflict(row.external_id);
    }
  }

  private async checkPosition(product: Obj, color: string | null, position: number, existing: Obj | null, ext: string) {
    const ignore = this.positionIgnore;
    for (const o of this.byId.values()) {
      if (o.kind !== "asset" || o.deleted || o === existing || o.parent !== product.id) continue;
      if (ignore?.has(o.ext) && o.stored.position === safeJsonParse<Record<string, unknown>>(o.o.stored, {}).position) continue;
      if ((o.stored.color_code ?? null) === color && o.stored.position === position) throw positionConflict(o.ext, position);
    }
    const row = await this.ctx.db.first<{ id: string; external_id: string }>(
      "SELECT id, external_id FROM assets WHERE product_id = ? AND IFNULL(color_code, '') = ? AND position = ?",
      [product.id, color ?? "", position],
    );
    if (row && row.external_id !== ext && !ignore?.has(row.external_id)) {
      const inSession = this.byId.get(row.id);
      if (inSession && (inSession.deleted || inSession.stored.position !== position || (inSession.stored.color_code ?? null) !== color || inSession.parent !== product.id)) return;
      throw positionConflict(row.external_id, position);
    }
  }

  private async remove(kind: Kind, ext: string, ifMatch?: string | null): Promise<IngestResult> {
    if (!this.opts.canDelete) throw new ObxError("insufficient_scope", "Deleting needs the ingest:delete scope.");
    const o = await this.load(kind, ext);
    if (!o) return this.result("delete", kind, ext, "unchanged", null, []);
    await this.checkIfMatch(o, ifMatch);
    if (kind === "brand") {
      this.checkBrandAllowed(ext);
      const inSessionProducts = [...this.byId.values()].filter((x) => x.kind === "product" && !x.deleted && x.parent === o.id).length;
      const n = await this.ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM products WHERE brand_id = ?", [o.id]);
      const deletedInSession = [...this.byId.values()].filter((x) => x.kind === "product" && x.deleted && x.o.parent === o.id).length;
      if ((n?.n ?? 0) - deletedInSession + inSessionProducts > 0 || inSessionProducts > 0)
        throw new ObxError("conflict", "This brand still has products. Delete or move them first.");
    } else if (kind === "product") {
      this.checkBrandAllowed(this.brandExtOfProduct(o));
      await this.loadChildren(o.id);
      for (const ch of this.children(o.id, "c")) {
        ch.deleted = true;
        ch.dirty = true;
      }
    } else {
      this.checkBrandAllowed(this.brandExtOfProduct(this.byId.get(o.parent ?? "") ?? null));
    }
    o.deleted = true;
    o.dirty = true;
    return { op: "delete", kind, external_id: ext, result: "deleted", id: o.id, visibility: null, etag: null, error: null, warnings: [] };
  }

  /** PUT /products/{ext}/asset-order */
  async assetOrder(productExt: string, colorCode: string | null, assetExts: string[]): Promise<IngestResult[]> {
    const p = await this.load("product", productExt);
    if (!p) throw new ObxError("not_found", `No product with external id "${productExt}".`);
    this.checkBrandAllowed(this.brandExtOfProduct(p));
    await this.loadChildren(p.id);
    const assets = this.children(p.id, "c").filter((a) => a.kind === "asset" && (a.stored.color_code ?? null) === colorCode);
    const have = new Set(assets.map((a) => a.ext));
    const want = new Set(assetExts);
    const missing = [...have].filter((x) => !want.has(x));
    const unknown = [...want].filter((x) => !have.has(x));
    if (missing.length || unknown.length || want.size !== assetExts.length) {
      const errs = [
        ...missing.map((m) => fieldError("/asset_external_ids", `Missing image "${m}": list every image of this colour.`)),
        ...unknown.map((m) => fieldError("/asset_external_ids", `Image "${m}" is not an image of this product and colour.`)),
      ];
      if (want.size !== assetExts.length) errs.push(fieldError("/asset_external_ids", "Each image may be listed once."));
      throw new ObxError("validation_failed", "The list must contain every image of this product colour exactly once.", errs);
    }
    const now = this.ctx.iso();
    const results: IngestResult[] = [];
    for (let i = 0; i < assetExts.length; i++) {
      const a = assets.find((x) => x.ext === assetExts[i])!;
      if (a.stored.position === i + 1) {
        results.push(await this.result("upsert", "asset", a.ext, "unchanged", a, []));
        continue;
      }
      a.stored = { ...a.stored, position: i + 1 };
      a.dirty = true;
      a.modified_at = now;
      results.push(await this.result("upsert", "asset", a.ext, "updated", a, []));
    }
    return results;
  }

  /** PUT /assets/{ext}/files/{rendition} after the bytes were stored as a blob. */
  async attachFile(assetExt: string, rendition: RenditionName, file: FileRef): Promise<IngestResult> {
    const a = await this.load("asset", assetExt);
    if (!a) throw new ObxError("not_found", `No asset with external id "${assetExt}". Create the asset metadata first.`);
    this.checkBrandAllowed(this.brandExtOfProduct(this.byId.get(a.parent ?? "") ?? null));
    const now = this.ctx.iso();
    const cur = a.files;
    if (rendition === "original") {
      if (cur.original?.sha256 === file.sha256 && !a.staged) return this.result("upsert", "asset", a.ext, "unchanged", a, []);
      if (cur.original && hasAllRenditions(cur) && cur.original.sha256 !== file.sha256) {
        // Keep serving the previous original + renditions until new renditions arrive (ingest.md §4.1).
        if (a.staged?.original?.sha256 === file.sha256) return this.result("upsert", "asset", a.ext, "unchanged", a, []);
        a.staged = { original: file };
        a.staged_at = now;
      } else {
        const next: Files = { ...cur, original: file };
        if (cur.original && cur.original.sha256 !== file.sha256) for (const n of REND) delete next[n];
        a.files = next;
        a.staged = null;
        a.staged_at = null;
      }
    } else {
      const v = new V();
      const target = a.staged ? { ...a.staged, [rendition]: file } : { ...cur, [rendition]: file };
      this.checkRenditionRules(target, v, "");
      if (!v.ok) throw new ObxError("validation_failed", v.errors.map((e) => e.detail).join(" "), v.errors);
      if (a.staged) {
        a.staged = target;
        if (hasAllRenditions(a.staged)) {
          a.files = a.staged;
          a.staged = null;
          a.staged_at = null;
        }
      } else {
        if (cur[rendition]?.sha256 === file.sha256) return this.result("upsert", "asset", a.ext, "unchanged", a, []);
        a.files = target;
      }
    }
    a.dirty = true;
    a.modified_at = now;
    return this.result("upsert", "asset", a.ext, "updated", a, []);
  }

  /** Promote a staged original whose renditions never arrived (missing ones fall back to the original). */
  async promoteStaged(assetId: string): Promise<boolean> {
    const a = await this.loadById("asset", assetId);
    if (!a?.staged?.original) return false;
    a.files = { ...a.staged };
    a.staged = null;
    a.staged_at = null;
    a.dirty = true;
    a.modified_at = this.ctx.iso();
    return true;
  }

  private forceUpsert = new Set<Obj>();

  /** Re-evaluates an asset whose effective representation may have changed outside this session
   * (node default rights changed). Returns true when an upsert entry will be written. */
  async refreshAsset(assetId: string, storedRepHash: string): Promise<boolean> {
    const a = await this.loadById("asset", assetId);
    if (!a) return false;
    const now = (await sha256Hex(this.repHash(a, "c"))).slice(0, 32);
    if (now === storedRepHash) return false;
    a.dirty = true;
    if (this.visible(a, "c")) this.forceUpsert.add(a);
    return true;
  }

  // ------------------------------------------------------------------ commit

  /** Writes everything atomically. Returns the number of change entries written. */
  async commit(): Promise<number> {
    const now = this.ctx.iso();
    const nowMs = this.ctx.now();
    const all = [...this.byId.values()];
    const stmts: Stmt[] = [];
    const changeStmts: Stmt[] = [];
    const cascades: Stmt[] = [];

    type Entry = { o: Obj; op: "upsert" | "delete"; brandId: string | null; productId: string | null };
    const entries = new Map<Obj, Entry[]>();
    const repNow = new Map<Obj, string>();
    for (const o of all) {
      const beforeVis = o.o.inDb && this.visible(o, "o");
      const afterVis = !o.deleted && this.visible(o, "c");
      const beforeRep = o.o.inDb ? this.repHash(o, "o") : "";
      const afterRep = o.deleted ? "" : this.repHash(o, "c");
      repNow.set(o, afterRep);
      const bOld = this.brandIdOf(o, "o");
      const bNew = this.brandIdOf(o, "c");
      const pOld = o.kind === "variant" || o.kind === "asset" ? o.o.parent : null;
      const pNew = o.kind === "variant" || o.kind === "asset" ? o.parent : null;
      const list: Entry[] = [];
      if (beforeVis && (!afterVis || bOld !== bNew)) list.push({ o, op: "delete", brandId: bOld, productId: pOld });
      if (afterVis && (!beforeVis || beforeRep !== afterRep || bOld !== bNew || this.forceUpsert.has(o))) list.push({ o, op: "upsert", brandId: bNew, productId: pNew });
      if (list.length) entries.set(o, list);
      if (!o.deleted && (list.some((e) => e.op === "upsert") || (o.inDb && beforeRep !== afterRep) || !o.inDb)) {
        if (list.some((e) => e.op === "upsert") || beforeRep !== afterRep) {
          o.updated_at = now;
          o.dirty = true;
        }
      }
    }

    // Order: brands, then per product (first loaded first): product, variants by external_id, assets by colour/position.
    const ordered: Entry[] = [];
    for (const o of all.filter((x) => x.kind === "brand").sort((a, b) => a.loadSeq - b.loadSeq)) ordered.push(...(entries.get(o) ?? []));
    const products = all.filter((x) => x.kind === "product").sort((a, b) => a.loadSeq - b.loadSeq);
    const groupOf = (o: Obj) => (o.kind === "product" ? o.id : (o.deleted ? o.o.parent : o.parent) ?? o.o.parent);
    const touchedProducts = new Set<string>();
    for (const p of products) {
      const group = all.filter((x) => (x.kind === "variant" || x.kind === "asset") && (groupOf(x) === p.id || x.o.parent === p.id));
      const variants = group.filter((x) => x.kind === "variant").sort((a, b) => (a.ext < b.ext ? -1 : a.ext > b.ext ? 1 : 0));
      const assetKey = (a: Obj) => {
        const s = a.deleted ? safeJsonParse<Record<string, unknown>>(a.o.stored, a.stored) : a.stored;
        const c = (s.color_code as string | null) ?? null;
        return { c, pos: (s.position as number) ?? 0 };
      };
      const assets = group
        .filter((x) => x.kind === "asset")
        .sort((a, b) => {
          const ka = assetKey(a);
          const kb = assetKey(b);
          if (ka.c !== kb.c) {
            if (ka.c === null) return -1;
            if (kb.c === null) return 1;
            return ka.c < kb.c ? -1 : 1;
          }
          return ka.pos - kb.pos;
        });
      const seq = [p, ...variants, ...assets];
      let any = false;
      for (const o of seq) {
        const es = entries.get(o);
        if (es?.length) {
          ordered.push(...es);
          any = true;
          entries.delete(o);
        }
        if (o.dirty) any = true;
      }
      if (any) touchedProducts.add(p.id);
    }

    // Brand-level visibility cascades (set-based, children not loaded).
    for (const b of all.filter((x) => x.kind === "brand" && x.inDb && !x.deleted)) {
      const before = this.visible(b, "o");
      const after = this.visible(b, "c");
      if (before === after) continue;
      const loaded = all.filter((x) => x.kind === "product").map((x) => x.id);
      cascades.push(...brandCascade(b.id, after ? "upsert" : "delete", now, loaded));
    }

    // Row writes: deletes (children first), temporary moves, then inserts/updates (parents first).
    const kindsDel: Kind[] = ["asset", "variant", "product", "brand"];
    for (const k of kindsDel) for (const o of all) if (o.kind === k && o.deleted && o.inDb) stmts.push({ sql: `DELETE FROM ${TABLE[k]} WHERE id = ?`, params: [o.id] });
    for (const o of all) {
      if (o.deleted || !o.inDb || !o.dirty) continue;
      if (o.kind === "asset") {
        const os = safeJsonParse<Record<string, unknown>>(o.o.stored, {});
        if (os.position !== o.stored.position || (os.color_code ?? null) !== (o.stored.color_code ?? null) || o.o.parent !== o.parent)
          stmts.push({ sql: "UPDATE assets SET position = -1 - position WHERE id = ?", params: [o.id] });
      }
      if (o.kind === "variant") {
        const os = safeJsonParse<Record<string, unknown>>(o.o.stored, {});
        if (os.gtin_original !== o.stored.gtin_original) stmts.push({ sql: "UPDATE variants SET gtin14 = NULL WHERE id = ?", params: [o.id] });
      }
    }
    const searchProducts = new Set<string>();
    for (const k of ["brand", "product", "variant", "asset"] as Kind[]) {
      for (const o of all) {
        if (o.kind !== k || o.deleted || !o.dirty) continue;
        const etag = await this.etag(o);
        stmts.push(await this.rowStmt(o, repNow.get(o) ?? "", etag, nowMs));
        if (o.kind === "variant") {
          searchProducts.add(o.parent!);
          if (o.o.parent && o.o.parent !== o.parent) searchProducts.add(o.o.parent);
        }
        if (o.kind === "product") searchProducts.add(o.id);
      }
    }
    for (const o of all) if (o.kind === "variant" && o.deleted && o.o.parent) searchProducts.add(o.o.parent);
    for (const pid of searchProducts) {
      if (all.some((x) => x.id === pid && x.deleted)) continue;
      stmts.push({
        sql: "UPDATE products SET search_text = own_search || ' ' || IFNULL((SELECT group_concat(search_bits, ' ') FROM variants WHERE product_id = ?), '') WHERE id = ?",
        params: [pid, pid],
      });
    }
    for (const pid of touchedProducts) {
      if (all.some((x) => x.id === pid && x.deleted)) continue;
      stmts.push({ sql: "UPDATE products SET content_updated_at = ? WHERE id = ?", params: [now, pid] });
    }

    for (const e of ordered) {
      const o = e.o;
      changeStmts.push({
        sql: "INSERT INTO changes (type, op, obj_id, external_id, brand_id, product_id, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params: [o.kind, e.op, o.id, o.ext, e.brandId, o.kind === "variant" || o.kind === "asset" ? e.productId : null, now, now],
      });
      if (o.kind === "brand") {
        const idx = changeStmts.length;
        void idx;
      }
    }
    // Put brand cascades right after brand entries: brand entries come first in `ordered`.
    const brandEntryCount = ordered.filter((e) => e.o.kind === "brand").length;
    const finalChanges = [...changeStmts.slice(0, brandEntryCount), ...cascades, ...changeStmts.slice(brandEntryCount)];
    const batch = [...stmts, ...finalChanges];
    if (!batch.length) return 0;
    try {
      await this.ctx.db.batch(batch);
    } catch (e) {
      const mapped = mapDbError(e);
      if (mapped.code === "internal_error") this.ctx.log("error", "catalog commit failed", { error: e instanceof Error ? e.message : String(e) });
      throw mapped;
    }
    for (const o of all) {
      o.o = { inDb: !o.deleted, status: o.status, stored: JSON.stringify(o.stored), parent: o.parent, files: JSON.stringify(o.files) };
      o.inDb = !o.deleted;
      o.dirty = false;
    }
    for (const o of all) if (o.deleted) {
      this.byId.delete(o.id);
      this.objs.delete(`${o.kind}:${o.ext}`);
    }
    return ordered.length + (cascades.length ? 1 : 0);
  }

  private async rowStmt(o: Obj, rep: string, etag: string, nowMs: number): Promise<Stmt> {
    const stored = JSON.stringify(o.stored);
    const repHash = (await sha256Hex(rep)).slice(0, 32);
    switch (o.kind) {
      case "brand":
        return o.inDb
          ? { sql: "UPDATE brands SET status = ?, stored = ?, rep_hash = ?, etag = ?, updated_at = ?, modified_at = ? WHERE id = ?", params: [o.status, stored, repHash, etag, o.updated_at, o.modified_at, o.id] }
          : {
              sql: "INSERT INTO brands (id, external_id, status, stored, rep_hash, etag, created_at, updated_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
              params: [o.id, o.ext, o.status, stored, repHash, etag, o.created_at, o.updated_at, o.modified_at],
            };
      case "product": {
        const s = o.stored;
        const names = Object.values((s.name as Record<string, string>) ?? {}).join(" ");
        const own = `${s.style_number ?? ""} ${o.ext} ${names}`.toLowerCase();
        const cols = [o.parent, s.style_number as string, o.status, stored, repHash, etag, (s.item_type as string) ?? null, (s.target_group as string) ?? null, (s.season as string) ?? null, (s.collection as string) ?? null, own];
        return o.inDb
          ? {
              sql: "UPDATE products SET brand_id = ?, style_number = ?, status = ?, stored = ?, rep_hash = ?, etag = ?, item_type = ?, target_group = ?, season = ?, collection = ?, own_search = ?, updated_at = ?, modified_at = ? WHERE id = ?",
              params: [...cols, o.updated_at, o.modified_at, o.id],
            }
          : {
              sql: "INSERT INTO products (brand_id, style_number, status, stored, rep_hash, etag, item_type, target_group, season, collection, own_search, id, external_id, created_at, updated_at, content_updated_at, modified_at, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              params: [...cols, o.id, o.ext, o.created_at, o.updated_at, o.updated_at, o.modified_at, own],
            };
      }
      case "variant": {
        const s = o.stored;
        const g = s.gtin_original ? parseIngestGtin(s.gtin_original as string) : null;
        const gtin14 = g && "gtin14" in g ? g.gtin14 : null;
        const color = (s.color as Record<string, unknown>) ?? {};
        const bits = [s.gtin_original, gtin14, s.sku, color.code, ...Object.values((color.name as Record<string, string>) ?? {}), color.supplier_color].filter(Boolean).join(" ").toLowerCase();
        const brandId = this.brandIdOf(o, "c");
        const cols = [o.parent, brandId, o.status, gtin14, (color.code as string) ?? null, bits, stored, repHash, etag];
        void nowMs;
        return o.inDb
          ? {
              sql: "UPDATE variants SET product_id = ?, brand_id = ?, status = ?, gtin14 = ?, color_code = ?, search_bits = ?, stored = ?, rep_hash = ?, etag = ?, updated_at = ?, modified_at = ? WHERE id = ?",
              params: [...cols, o.updated_at, o.modified_at, o.id],
            }
          : {
              sql: "INSERT INTO variants (product_id, brand_id, status, gtin14, color_code, search_bits, stored, rep_hash, etag, id, external_id, created_at, updated_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              params: [...cols, o.id, o.ext, o.created_at, o.updated_at, o.modified_at],
            };
      }
      case "asset": {
        const s = o.stored;
        const brandId = this.brandIdOf(o, "c");
        const exp = effectiveRights(s, this.settings).expires_at;
        const missing = REND.filter((n) => !o.files[n]).length;
        const cols = [
          o.parent,
          brandId,
          o.status,
          (s.color_code as string) ?? null,
          s.position as number,
          stored,
          JSON.stringify(o.files),
          o.staged ? JSON.stringify(o.staged) : null,
          o.staged_at,
          o.files.original ? 1 : 0,
          missing,
          exp,
          exp && Date.parse(exp) <= this.ctx.now() ? 1 : 0,
          repHash,
          etag,
        ];
        return o.inDb
          ? {
              sql: "UPDATE assets SET product_id = ?, brand_id = ?, status = ?, color_code = ?, position = ?, stored = ?, files = ?, staged = ?, staged_at = ?, has_original = ?, missing_renditions = ?, expires_at = ?, expiry_tombstoned = ?, rep_hash = ?, etag = ?, updated_at = ?, modified_at = ? WHERE id = ?",
              params: [...cols, o.updated_at, o.modified_at, o.id],
            }
          : {
              sql: "INSERT INTO assets (product_id, brand_id, status, color_code, position, stored, files, staged, staged_at, has_original, missing_renditions, expires_at, expiry_tombstoned, rep_hash, etag, id, external_id, created_at, updated_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              params: [...cols, o.id, o.ext, o.created_at, o.updated_at, o.modified_at],
            };
      }
    }
  }

  get(kind: Kind, ext: string): Obj | null {
    const o = this.objs.get(`${kind}:${ext}`);
    return o && !o.deleted ? o : null;
  }
}

function gtinConflict(holder: string) {
  return new ObxError("gtin_conflict", `This GTIN already belongs to variant "${holder}".`, [fieldError("/gtin", "GTIN already in use.", "gtin_conflict")]);
}

function positionConflict(holder: string, position: number) {
  return new ObxError("position_conflict", `Image "${holder}" already has position ${position} for this product colour. Reuse its id to replace it, or reorder with asset-order.`, [
    fieldError("/position", "Position already taken.", "position_conflict"),
  ]);
}

export function errorResult(op: Op, kind: Kind, ext: string, e: ObxError): IngestResult {
  return { op, kind, external_id: ext, result: "error", id: null, visibility: null, etag: null, error: e.toProblem(), warnings: [] };
}

function mapDbError(e: unknown): ObxError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/variants\.gtin14|variants_gtin/.test(msg)) return new ObxError("gtin_conflict", "This GTIN was just taken by another write.");
  if (/assets\.product_id|assets_position/.test(msg)) return new ObxError("position_conflict", "This position was just taken by another write.");
  if (/UNIQUE constraint failed: \w+\.external_id/.test(msg)) return new ObxError("conflict", "Another write created this object at the same time. Retry.");
  return new ObxError("internal_error", "The write could not be saved.");
}

const ASSET_VISIBLE = "a.status = 'published' AND a.has_original = 1 AND (a.expires_at IS NULL OR a.expires_at > ?)";

/** Set-based change entries when a brand becomes (in)visible. `exclude` = products handled individually. */
function brandCascade(brandId: string, op: "upsert" | "delete", now: string, exclude: string[]): Stmt[] {
  const ex = exclude.length ? ` AND p.id NOT IN (${exclude.map(() => "?").join(",")})` : "";
  const ins = "INSERT INTO changes (type, op, obj_id, external_id, brand_id, product_id, updated_at, created_at) ";
  const out: Stmt[] = [
    {
      sql: `${ins}SELECT 'product', ?, p.id, p.external_id, p.brand_id, NULL, ?, ? FROM products p WHERE p.brand_id = ? AND p.status = 'published'${ex} ORDER BY p.external_id`,
      params: [op, now, now, brandId, ...exclude],
    },
    {
      sql: `${ins}SELECT 'variant', ?, v.id, v.external_id, p.brand_id, v.product_id, ?, ? FROM variants v JOIN products p ON p.id = v.product_id WHERE p.brand_id = ? AND p.status = 'published' AND v.status = 'published'${ex} ORDER BY p.external_id, v.external_id`,
      params: [op, now, now, brandId, ...exclude],
    },
    {
      sql: `${ins}SELECT 'asset', ?, a.id, a.external_id, p.brand_id, a.product_id, ?, ? FROM assets a JOIN products p ON p.id = a.product_id WHERE p.brand_id = ? AND p.status = 'published' AND ${ASSET_VISIBLE}${ex} ORDER BY p.external_id, CASE WHEN a.color_code IS NULL THEN 0 ELSE 1 END, a.color_code, a.position`,
      params: [op, now, now, brandId, now, ...exclude],
    },
  ];
  if (op === "upsert") {
    out.push(
      { sql: `UPDATE products SET updated_at = ?, content_updated_at = ? WHERE brand_id = ? AND status = 'published'`, params: [now, now, brandId] },
      { sql: `UPDATE variants SET updated_at = ? WHERE status = 'published' AND product_id IN (SELECT id FROM products WHERE brand_id = ? AND status = 'published')`, params: [now, brandId] },
      {
        sql: `UPDATE assets SET updated_at = ? WHERE status = 'published' AND has_original = 1 AND (expires_at IS NULL OR expires_at > ?) AND product_id IN (SELECT id FROM products WHERE brand_id = ? AND status = 'published')`,
        params: [now, now, brandId],
      },
    );
  }
  return out;
}

/** Convenience: run one operation in its own session. */
export async function applyOne(ctx: Ctx, opts: SessionOptions, op: Op, kind: Kind, ext: string, data: unknown, ifMatch?: string | null): Promise<IngestResult> {
  const s = await new CatalogSession(ctx, opts).init();
  const r = await s.apply(op, kind, ext, data, ifMatch);
  if (r.result === "error" || r.result === "unchanged") return r;
  try {
    await s.commit();
  } catch (e) {
    if (e instanceof ObxError) return errorResult(op, kind, ext, e);
    throw e;
  }
  return r;
}

export function resultStatus(r: IngestResult): number {
  if (r.result === "created") return 201;
  if (r.result !== "error") return 200;
  return (r.error?.status as number) ?? 422;
}

export function brandSlug(name: string): string {
  return slugify(name) || "brand";
}

export { type ErrorCode };
