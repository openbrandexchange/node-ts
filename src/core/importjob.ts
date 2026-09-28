// Import jobs: canonical CSV + images (upload, API, CLI, scheduled pull). Runs in checkpointed phases:
// fetch (scheduled sources) → prepare → images → mirror check → apply (per product) → orphan images → mirror.
import type { Ctx } from "./ctx";
import { CatalogSession, type IngestResult } from "./catalog";
import { enqueueJob, jobItemStmt, jobItems, registerJob, type JobRow, type StepOutcome } from "./jobs";
import { ObxError } from "../lib/problem";
import { getBlob, storeBlob, fileRef, blobKey } from "./blobs";
import { ignoredEntry, readZipDirectory, readZipEntry, unsafeEntryReason, ZipError, type ZipReadEntry } from "../lib/zip";
import { storeReader, readText, streamToStore } from "./storeio";
import { parseAssetsCsv, parseImageName, parseProductsCsv, IMAGE_EXT, type AssetOverride, type ProductGroup, type RowError } from "./importformat";
import { isPlainObject, safeJsonParse, slugify } from "../lib/util";
import { fetchSource, type SourceRow } from "./sources";
import type { Stmt } from "../platform";

export interface Loc {
  key: string;
  offset: number;
  length: number;
}

export interface ImportInputs {
  csv: (Loc & { name: string }) | null;
  assets: (Loc & { name: string }) | null;
  zips: (Loc & { name: string })[];
  files: (Loc & { name: string })[];
  manifest: Loc | null;
}

export interface ImportInput {
  trigger: "upload" | "api" | "schedule" | "manual_run" | "cli";
  mode: "upsert" | "mirror";
  dry_run: boolean;
  allow_mass_unpublish: boolean;
  default_language: string | null;
  allowed_brands: string[] | null;
  inputs?: ImportInputs;
  source_id?: string | null;
  force?: boolean;
  /** "admin" | "ingest:<token id>" – who started it (for webhooks). */
  started_by: string;
}

type ImgLoc =
  | { t: "raw"; key: string; offset: number; length: number }
  | { t: "zip"; key: string; base: number; e: ZipReadEntry }
  | { t: "manifest"; sha256: string; width?: number; height?: number; renditions?: Record<string, { sha256: string }> }
  | { t: "remote"; path: string; version: string; size: number };

interface ImgItem {
  name: string;
  loc: ImgLoc;
}

interface DoneImg {
  name: string;
  sha256: string;
  renditions: Record<string, string> | null;
  style: string;
  color: string | null;
  position: number;
  role: string | null;
  view: string | null;
  assetId: string | null;
  override: AssetOverride | null;
}

export interface Counts {
  rows: number;
  files: number;
  created: number;
  updated: number;
  unchanged: number;
  unpublished: number;
  errors: number;
  warnings: number;
}

interface State {
  phase: "fetch" | "prepare" | "images" | "mirrorcheck" | "apply" | "orphans" | "mirror" | "done";
  inputs?: ImportInputs;
  csvKey?: string | null;
  csvName?: string;
  assetsKey?: string | null;
  assetsName?: string;
  prepStep?: number;
  manifestDone?: number;
  imgCount: number;
  imgIdx: number;
  groupIdx: number;
  orphanIdx: number;
  orphanStyles?: string[];
  mirrorCount: number;
  mirrorIdx: number;
  errIdx: number;
  counts: Counts;
  files: { name: string; bytes: number; sha256: string | null }[];
  fingerprint?: string | null;
  skipped?: boolean;
  dryBrands?: string[];
}

const MAX_IMAGE = 200 * 1048576;

function newState(input: ImportInput): State {
  return {
    phase: input.source_id && !input.inputs ? "fetch" : "prepare",
    inputs: input.inputs,
    imgCount: 0,
    imgIdx: 0,
    groupIdx: 0,
    orphanIdx: 0,
    mirrorCount: 0,
    mirrorIdx: 0,
    errIdx: 0,
    counts: { rows: 0, files: 0, created: 0, updated: 0, unchanged: 0, unpublished: 0, errors: 0, warnings: 0 },
    files: [],
  };
}

export async function startImport(ctx: Ctx, input: ImportInput, opts: { owner: string; idempotencyKey?: string | null; id?: string } = { owner: "admin" }): Promise<JobRow> {
  return enqueueJob(ctx, { kind: "import", owner: opts.owner, input, sourceId: input.source_id ?? null, idempotencyKey: opts.idempotencyKey, id: opts.id, state: newState(input) });
}

class ErrSink {
  stmts: Stmt[] = [];
  constructor(
    private job: JobRow,
    private st: State,
  ) {}
  add(e: RowError) {
    this.stmts.push(jobItemStmt(this.job.id, "row", ++this.st.errIdx, e, e.severity === "error"));
    if (e.severity === "error") this.st.counts.errors++;
    else this.st.counts.warnings++;
  }
}

function pointerToColumn(pointer: string | null | undefined, kind: string): string | null {
  if (!pointer) return null;
  const p = pointer.replace(/^\//, "").split("/");
  if (kind === "variant" && p[0] === "color") return p[1] === "name" ? "color_name" : "color_code";
  if (kind === "product" && p[0] === "brand_external_id") return "brand";
  return p[0] || null;
}

function resultErrors(r: IngestResult, file: string, row: number | null, sink: ErrSink) {
  const e = r.error as { obx_error: string; detail: string | null; errors?: { pointer: string | null; obx_error: string; detail: string }[] } | null;
  if (!e) return;
  if (e.errors?.length)
    for (const fe of e.errors) sink.add({ file, row, column: pointerToColumn(fe.pointer, r.kind), severity: "error", obx_error: fe.obx_error, detail: fe.detail, value: null });
  else sink.add({ file, row, column: null, severity: "error", obx_error: e.obx_error, detail: e.detail ?? e.obx_error, value: null });
}

function countResult(st: State, r: IngestResult) {
  if (r.result === "created") st.counts.created++;
  else if (r.result === "updated") st.counts.updated++;
  else if (r.result === "unchanged") st.counts.unchanged++;
}

// ------------------------------------------------------------------ the job

async function step(ctx: Ctx, job: JobRow, deadline: number): Promise<StepOutcome> {
  const input = safeJsonParse<ImportInput>(job.input, {} as ImportInput);
  const st = safeJsonParse<State>(job.state, newState(input));
  if (!st.counts) Object.assign(st, newState(input));
  const sink = new ErrSink(job, st);
  const save = async (extra: Partial<StepOutcome> = {}): Promise<StepOutcome> => {
    if (sink.stmts.length) await ctx.db.batch(sink.stmts);
    sink.stmts = [];
    return { done: false, state: st, progressDone: st.phase === "images" ? st.imgIdx : st.groupIdx, progressTotal: null, summary: summaryOf(st), ...extra };
  };
  const fail = async (e: ObxError): Promise<StepOutcome> => {
    if (sink.stmts.length) await ctx.db.batch(sink.stmts);
    st.phase = "done";
    return { done: true, failed: true, state: st, summary: summaryOf(st), error: e.toProblem() };
  };
  try {
    while (ctx.now() < deadline) {
      switch (st.phase) {
        case "fetch": {
          const src = await ctx.db.first<SourceRow>("SELECT * FROM import_sources WHERE id = ?", [input.source_id ?? null]);
          if (!src) return fail(new ObxError("not_found", "The scheduled import was deleted."));
          const r = await fetchSource(ctx, src, job.id, !!input.force);
          st.files = r.files;
          if (r.unchanged) {
            st.skipped = true;
            st.phase = "done";
            break;
          }
          st.fingerprint = r.fingerprint;
          st.inputs = r.inputs;
          if (r.remoteImages.length) {
            const stmts = r.remoteImages.map((im) => jobItemStmt(job.id, "img", ++st.imgCount, { name: im.name, loc: { t: "remote", path: im.path, version: im.version, size: im.size } } satisfies ImgItem));
            for (let i = 0; i < stmts.length; i += 200) await ctx.db.batch(stmts.slice(i, i + 200));
          }
          st.phase = "prepare";
          break;
        }
        case "prepare": {
          const done = await prepare(ctx, job, st, input, sink, deadline);
          if (!done) return save();
          st.phase = "images";
          break;
        }
        case "images": {
          const items = await jobItems<ImgItem>(ctx, job.id, "img", st.imgIdx, 20);
          if (!items.length) {
            st.phase = input.mode === "mirror" ? "mirrorcheck" : "apply";
            break;
          }
          const overrides = await loadOverrides(ctx, st, input, sink);
          for (const it of items) {
            if (ctx.now() >= deadline) break;
            await processImage(ctx, job, st, input, it.item, overrides, sink);
            st.imgIdx = it.idx;
          }
          await save();
          break;
        }
        case "mirrorcheck": {
          const groups = await loadGroups(ctx, st, input);
          const brandIds = new Set<string>();
          for (const g of groups) {
            const b = await findBrand(ctx, g.brandRef);
            if (b) brandIds.add(b.id);
          }
          if (!brandIds.size) {
            st.phase = "apply";
            break;
          }
          const keys = new Set(groups.map((g) => g.key));
          const ids = [...brandIds];
          const cands = await ctx.db.all<{ id: string; external_id: string }>(
            `SELECT id, external_id FROM products WHERE status = 'published' AND brand_id IN (${ids.map(() => "?").join(",")}) ORDER BY external_id`,
            ids,
          );
          const gone = cands.filter((c) => !keys.has(c.external_id));
          if (cands.length && gone.length > cands.length / 2 && !input.allow_mass_unpublish) {
            return fail(
              new ObxError(
                "mass_unpublish_refused",
                `This mirror import would take ${gone.length} of ${cands.length} products offline. Nothing was changed. If that is really intended, run it again with "allow mass unpublish".`,
              ),
            );
          }
          const stmts = gone.map((g, i) => jobItemStmt(job.id, "mirror", i + 1, g.external_id));
          for (let i = 0; i < stmts.length; i += 200) await ctx.db.batch(stmts.slice(i, i + 200));
          st.mirrorCount = gone.length;
          st.phase = "apply";
          break;
        }
        case "apply": {
          const groups = await loadGroups(ctx, st, input);
          if (st.groupIdx >= groups.length) {
            st.phase = "orphans";
            break;
          }
          while (st.groupIdx < groups.length && ctx.now() < deadline) {
            await applyGroup(ctx, job, st, input, groups[st.groupIdx], sink);
            st.groupIdx++;
          }
          await save();
          break;
        }
        case "orphans": {
          if (!st.orphanStyles) {
            const groups = await loadGroups(ctx, st, input);
            const inCsv = new Set(groups.map((g) => String(g.product.style_number).toLowerCase()));
            const rows = await ctx.db.all<{ kind: string }>("SELECT DISTINCT kind FROM job_items WHERE job_id = ? AND kind LIKE 'img:%'", [job.id]);
            st.orphanStyles = rows.map((r) => r.kind.slice(4)).filter((s) => !inCsv.has(s)).sort();
          }
          while (st.orphanIdx < st.orphanStyles.length && ctx.now() < deadline) {
            await applyOrphans(ctx, job, st, input, st.orphanStyles[st.orphanIdx], sink);
            st.orphanIdx++;
          }
          if (st.orphanIdx >= st.orphanStyles.length) st.phase = input.mode === "mirror" ? "mirror" : "done";
          else await save();
          break;
        }
        case "mirror": {
          const items = await jobItems<string>(ctx, job.id, "mirror", st.mirrorIdx, 25);
          if (!items.length) {
            st.phase = "done";
            break;
          }
          for (const it of items) {
            if (ctx.now() >= deadline) break;
            if (!input.dry_run) {
              const s = await new CatalogSession(ctx, { allowedBrands: input.allowed_brands, canDelete: false }).init();
              const r = await s.apply("unpublish", "product", it.item, null);
              if (r.result === "updated") {
                await s.commit();
                st.counts.unpublished++;
              }
            } else st.counts.unpublished++;
            st.mirrorIdx = it.idx;
          }
          await save();
          break;
        }
        case "done": {
          if (sink.stmts.length) await ctx.db.batch(sink.stmts);
          if (input.source_id && !input.dry_run && st.fingerprint && !st.skipped) {
            await ctx.db.run("UPDATE import_sources SET fingerprint = ? WHERE id = ?", [st.fingerprint, input.source_id]);
          }
          return { done: true, state: st, progressDone: st.counts.rows + st.counts.files, progressTotal: st.counts.rows + st.counts.files, summary: summaryOf(st) };
        }
      }
    }
    return save();
  } catch (e) {
    if (e instanceof ObxError) return fail(e);
    if (e instanceof ZipError) return fail(new ObxError("import_invalid", `The zip file could not be read: ${e.message}`));
    throw e;
  }
}

function summaryOf(st: State) {
  return { created: st.counts.created, updated: st.counts.updated, unchanged: st.counts.unchanged, deleted: 0, errors: st.counts.errors, counts: st.counts, files: st.files, skipped: !!st.skipped };
}

// ------------------------------------------------------------------ prepare: find CSVs and image files

async function prepare(ctx: Ctx, job: JobRow, st: State, input: ImportInput, sink: ErrSink, deadline: number): Promise<boolean> {
  const inp = st.inputs ?? { csv: null, assets: null, zips: [], files: [], manifest: null };
  st.prepStep ??= 0;
  if (st.prepStep === 0) {
    // Zip directories: validate every entry first (zip-slip → nothing is written).
    let csvLoc: (Loc & { name: string }) | null = inp.csv;
    let assetsLoc: (Loc & { name: string }) | null = inp.assets;
    const zipImages: ImgItem[] = [];
    for (const z of inp.zips) {
      const read = storeReader(ctx, z.key, z.offset);
      const entries = await readZipDirectory(read, z.length);
      let total = 0;
      for (const e of entries) {
        const bad = unsafeEntryReason(e);
        if (bad) throw new ObxError("import_invalid", `Unsafe entry "${e.name}" in ${z.name}: ${bad}. Nothing was imported.`);
        total += e.size;
      }
      if (total > 10 * 2 * 1024 * 1048576) throw new ObxError("import_invalid", "The zip unpacks to more than 20 GB. Split it into smaller packages.");
      const csvs = entries.filter((e) => !e.isDir && !ignoredEntry(e.name) && /\.csv$/i.test(e.name));
      const base = (n: string) => n.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
      const prod = csvs.find((e) => base(e.name) === "products.csv") ?? (csvs.filter((e) => base(e.name) !== "assets.csv").length === 1 ? csvs.find((e) => base(e.name) !== "assets.csv") : undefined);
      const ass = csvs.find((e) => base(e.name) === "assets.csv");
      for (const [e, which] of [
        [prod, "csv"],
        [ass, "assets"],
      ] as const) {
        if (!e) continue;
        if ((which === "csv" && csvLoc) || (which === "assets" && assetsLoc)) continue;
        const bytes = await readZipEntry(read, e, 64 * 1048576);
        const key = `jobs/${job.id}/${which}.csv`;
        await ctx.blobs.put(key, bytes, "text/csv");
        const loc = { key, offset: 0, length: bytes.length, name: base(e.name) };
        if (which === "csv") csvLoc = loc;
        else assetsLoc = loc;
      }
      for (const e of entries) {
        if (e.isDir || ignoredEntry(e.name) || /\.csv$/i.test(e.name)) continue;
        const name = e.name.replace(/\\/g, "/").split("/").pop()!;
        if (/\.zip$/i.test(name)) {
          sink.add({ file: z.name, row: null, column: null, severity: "warning", obx_error: "import_invalid", detail: `Nested zip "${e.name}" was not opened.`, value: null });
          continue;
        }
        if (!IMAGE_EXT.test(name)) {
          sink.add({ file: z.name, row: null, column: null, severity: "warning", obx_error: "validation_failed", detail: `"${e.name}" is not an image and was ignored.`, value: null });
          continue;
        }
        zipImages.push({ name, loc: { t: "zip", key: z.key, base: z.offset, e } });
      }
    }
    for (const f of inp.files) {
      if (!IMAGE_EXT.test(f.name)) {
        sink.add({ file: f.name, row: null, column: null, severity: "error", obx_error: "validation_failed", detail: "Not an image file (jpg, png, webp).", value: null });
        continue;
      }
      zipImages.push({ name: f.name.split(/[\\/]/).pop()!, loc: { t: "raw", key: f.key, offset: f.offset, length: f.length } });
    }
    const stmts = zipImages.map((im) => jobItemStmt(job.id, "img", ++st.imgCount, im));
    for (let i = 0; i < stmts.length; i += 200) await ctx.db.batch(stmts.slice(i, i + 200));
    if (csvLoc) {
      st.csvKey = csvLoc.key;
      if (csvLoc.offset !== 0) {
        const txt = await readText(ctx, csvLoc.key, csvLoc.offset, csvLoc.length);
        const key = `jobs/${job.id}/csv.csv`;
        await ctx.blobs.put(key, new TextEncoder().encode(txt), "text/csv");
        st.csvKey = key;
      }
      st.csvName = csvLoc.name;
      if (!st.files.some((f) => f.name === csvLoc!.name)) st.files.push({ name: csvLoc.name, bytes: csvLoc.length, sha256: null });
    }
    if (assetsLoc) {
      st.assetsKey = assetsLoc.key;
      if (assetsLoc.offset !== 0) {
        const txt = await readText(ctx, assetsLoc.key, assetsLoc.offset, assetsLoc.length);
        const key = `jobs/${job.id}/assets.csv`;
        await ctx.blobs.put(key, new TextEncoder().encode(txt), "text/csv");
        st.assetsKey = key;
      }
      st.assetsName = assetsLoc.name;
      if (!st.files.some((f) => f.name === assetsLoc!.name)) st.files.push({ name: assetsLoc.name, bytes: assetsLoc.length, sha256: null });
    }
    for (const z of inp.zips) if (!st.files.some((f) => f.name === z.name)) st.files.push({ name: z.name, bytes: z.length, sha256: null });
    st.prepStep = 1;
    st.manifestDone = 0;
  }
  if (st.prepStep === 1) {
    if (inp.manifest) {
      const txt = await readText(ctx, inp.manifest.key, inp.manifest.offset, inp.manifest.length);
      const list = safeJsonParse<unknown>(txt, null);
      if (!Array.isArray(list)) throw new ObxError("invalid_request", "images_manifest must be a JSON array.");
      while ((st.manifestDone ?? 0) < list.length && ctx.now() < deadline) {
        const chunk = list.slice(st.manifestDone, (st.manifestDone ?? 0) + 200);
        const stmts: Stmt[] = [];
        for (const m of chunk) {
          if (!isPlainObject(m) || typeof m.file !== "string" || typeof m.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(m.sha256)) {
            sink.add({ file: "images_manifest", row: null, column: "file", severity: "error", obx_error: "validation_failed", detail: "Each entry needs file and sha256.", value: JSON.stringify(m).slice(0, 200) });
            continue;
          }
          const name = m.file.split(/[\\/]/).pop()!;
          const r = isPlainObject(m.renditions) ? (m.renditions as Record<string, { sha256: string }>) : undefined;
          stmts.push(jobItemStmt(job.id, "img", ++st.imgCount, { name, loc: { t: "manifest", sha256: m.sha256, renditions: r } } satisfies ImgItem));
        }
        if (stmts.length) await ctx.db.batch(stmts);
        st.manifestDone = (st.manifestDone ?? 0) + chunk.length;
      }
      if ((st.manifestDone ?? 0) < list.length) return false;
    }
    st.prepStep = 2;
  }
  // Nothing to import at all?
  if (!st.csvKey && !st.imgCount) throw new ObxError("import_invalid", "The import contains no products.csv and no images.");
  // Parse CSVs once to count rows and record their errors.
  if (st.csvKey) {
    const groups = await loadGroups(ctx, st, input, sink);
    void groups;
  }
  if (st.assetsKey) await loadOverrides(ctx, st, input, sink, true);
  return true;
}

const groupCache = new WeakMap<object, ProductGroup[]>();

async function loadGroups(ctx: Ctx, st: State, input: ImportInput, sink?: ErrSink): Promise<ProductGroup[]> {
  if (!st.csvKey) return [];
  const cached = groupCache.get(st);
  if (cached) return cached;
  const head = await ctx.blobs.head(st.csvKey);
  const txt = await readText(ctx, st.csvKey, 0, head?.size ?? 0);
  const lang = input.default_language ?? (await ctx.settings()).portal.default_language;
  const parsed = parseProductsCsv(txt, st.csvName ?? "products.csv", lang);
  if (sink) {
    st.counts.rows = parsed.rows;
    for (const e of parsed.errors) {
      if (e.obx_error === "import_invalid" && e.row === null) throw new ObxError("import_invalid", e.detail);
      sink.add(e);
    }
  }
  groupCache.set(st, parsed.groups);
  return parsed.groups;
}

const overrideCache = new WeakMap<object, Map<string, AssetOverride>>();

async function loadOverrides(ctx: Ctx, st: State, input: ImportInput, sink: ErrSink, report = false): Promise<Map<string, AssetOverride>> {
  if (!st.assetsKey) return new Map();
  const cached = overrideCache.get(st);
  if (cached && !report) return cached;
  const head = await ctx.blobs.head(st.assetsKey);
  const txt = await readText(ctx, st.assetsKey, 0, head?.size ?? 0);
  const lang = input.default_language ?? (await ctx.settings()).portal.default_language;
  const parsed = parseAssetsCsv(txt, st.assetsName ?? "assets.csv", lang);
  if (report) for (const e of parsed.errors) sink.add(e);
  const m = new Map<string, AssetOverride>();
  for (const r of parsed.rows) m.set(r.file.toLowerCase(), r);
  overrideCache.set(st, m);
  return m;
}

// ------------------------------------------------------------------ images

async function processImage(ctx: Ctx, job: JobRow, st: State, input: ImportInput, it: ImgItem, overrides: Map<string, AssetOverride>, sink: ErrSink) {
  st.counts.files++;
  const ov = overrides.get(it.name.toLowerCase()) ?? null;
  const parsed = parseImageName(it.name);
  let style: string | null = null;
  let color: string | null = null;
  let position: number | null = null;
  let role: string | null = null;
  let view: string | null = null;
  if (!("error" in parsed)) ({ style, color, position, role, view } = parsed);
  if (ov) {
    if (ov.product) style = ov.product;
    if (ov.color_code !== undefined) color = ov.color_code || null;
    if (ov.position) position = ov.position;
  }
  if (!style || !position) {
    sink.add({ file: it.name, row: null, column: null, severity: "error", obx_error: "validation_failed", detail: "error" in parsed ? parsed.error : "Missing style or position.", value: it.name });
    return;
  }
  let sha: string;
  let renditions: Record<string, string> | null = null;
  try {
    if (it.loc.t === "manifest") {
      const b = await getBlob(ctx, it.loc.sha256);
      if (!b) {
        sink.add({ file: it.name, row: null, column: null, severity: "error", obx_error: "blob_missing", detail: "This image was listed in the manifest but not uploaded.", value: it.loc.sha256 });
        return;
      }
      sha = b.sha256;
      if (it.loc.renditions) {
        renditions = {};
        for (const [k, r] of Object.entries(it.loc.renditions)) {
          if (!["web", "square", "thumb"].includes(k) || !r?.sha256) continue;
          if (!(await getBlob(ctx, r.sha256))) {
            sink.add({ file: it.name, row: null, column: k, severity: "error", obx_error: "blob_missing", detail: `The ${k} version was not uploaded.`, value: r.sha256 });
            return;
          }
          renditions[k] = r.sha256;
        }
      }
    } else {
      let bytes: Uint8Array;
      if (it.loc.t === "raw") {
        if (it.loc.length > MAX_IMAGE) throw new ObxError("payload_too_large", "Image too large.");
        bytes = (await ctx.blobs.getRange(it.loc.key, it.loc.offset, it.loc.length)) ?? new Uint8Array(0);
      } else if (it.loc.t === "zip") {
        bytes = await readZipEntry(storeReader(ctx, it.loc.key, it.loc.base), it.loc.e, MAX_IMAGE);
      } else {
        const cached = await ctx.db.first<{ sha256: string }>("SELECT sha256 FROM source_files WHERE source_id = ? AND path = ? AND version = ?", [input.source_id ?? null, it.loc.path, it.loc.version]);
        if (cached && (await getBlob(ctx, cached.sha256))) bytes = new Uint8Array(0);
        else {
          const { readRemoteFile } = await import("./sources");
          bytes = await readRemoteFile(ctx, input.source_id!, it.loc.path, MAX_IMAGE);
        }
        if (cached && !bytes.length) {
          sha = cached.sha256;
          await recordImage(ctx, job, st, it, { sha, renditions, style, color, position, role, view, ov });
          return;
        }
      }
      const stored = await storeBlob(ctx, bytes);
      sha = stored.row.sha256;
      if (it.loc.t === "remote")
        await ctx.db.run("INSERT INTO source_files (source_id, path, version, sha256) VALUES (?, ?, ?, ?) ON CONFLICT(source_id, path) DO UPDATE SET version = excluded.version, sha256 = excluded.sha256", [
          input.source_id ?? null,
          it.loc.path,
          it.loc.version,
          sha,
        ]);
    }
  } catch (e) {
    if (e instanceof ObxError || e instanceof ZipError) {
      const code = e instanceof ObxError ? e.code : "import_invalid";
      sink.add({ file: it.name, row: null, column: null, severity: "error", obx_error: code, detail: e.message, value: null });
      return;
    }
    throw e;
  }
  await recordImage(ctx, job, st, it, { sha, renditions, style, color, position, role, view, ov });
}

async function recordImage(
  ctx: Ctx,
  job: JobRow,
  st: State,
  it: ImgItem,
  d: { sha: string; renditions: Record<string, string> | null; style: string; color: string | null; position: number; role: string | null; view: string | null; ov: AssetOverride | null },
) {
  const done: DoneImg = {
    name: it.name,
    sha256: d.sha,
    renditions: d.renditions,
    style: d.style,
    color: d.color,
    position: d.position,
    role: d.role,
    view: d.view,
    assetId: d.ov?.asset_id ?? null,
    override: d.ov,
  };
  await ctx.db.run("INSERT OR REPLACE INTO job_items (job_id, idx, kind, is_error, item) VALUES (?, ?, ?, 0, ?)", [job.id, st.imgIdx + 1, `img:${d.style.toLowerCase()}`, JSON.stringify(done)]);
  const f = st.files.find((x) => x.name === it.name);
  if (!f && st.files.length < 200 && it.loc.t !== "zip") {
    const b = await getBlob(ctx, d.sha);
    st.files.push({ name: it.name, bytes: b?.bytes ?? 0, sha256: d.sha });
  }
}

// ------------------------------------------------------------------ apply

async function findBrand(ctx: Ctx, ref: string | null): Promise<{ id: string; external_id: string } | null> {
  if (!ref) {
    const all = await ctx.db.all<{ id: string; external_id: string }>("SELECT id, external_id FROM brands LIMIT 2");
    return all.length === 1 ? all[0] : null;
  }
  const rows = await ctx.db.all<{ id: string; external_id: string; stored: string }>("SELECT id, external_id, stored FROM brands");
  const l = ref.trim().toLowerCase();
  return (
    rows.find((r) => r.external_id.toLowerCase() === l) ??
    rows.find((r) => String(safeJsonParse<Record<string, unknown>>(r.stored, {}).name ?? "").toLowerCase() === l) ??
    null
  );
}

async function imagesForStyle(ctx: Ctx, jobId: string, style: string): Promise<DoneImg[]> {
  const rows = await ctx.db.all<{ item: string }>("SELECT item FROM job_items WHERE job_id = ? AND kind = ? ORDER BY idx", [jobId, `img:${style.toLowerCase()}`]);
  return rows.map((r) => JSON.parse(r.item) as DoneImg);
}

async function applyGroup(ctx: Ctx, job: JobRow, st: State, input: ImportInput, g: ProductGroup, sink: ErrSink) {
  const file = st.csvName ?? "products.csv";
  const s = await new CatalogSession(ctx, { allowedBrands: input.allowed_brands, canDelete: false }).init();
  const results: { r: IngestResult; row: number | null; file: string }[] = [];
  let brandExt: string | null = null;
  if (g.brandRef) {
    const b = await findBrand(ctx, g.brandRef);
    if (b) brandExt = b.external_id;
    else {
      brandExt = slugify(g.brandRef) || "brand";
      if (!s.get("brand", brandExt) && !(await s.load("brand", brandExt))) {
        const r = await s.apply("upsert", "brand", brandExt, { name: g.brandRef.trim() });
        if (input.dry_run) {
          st.dryBrands ??= [];
          if (!st.dryBrands.includes(brandExt)) {
            st.dryBrands.push(brandExt);
            results.push({ r, row: g.firstRow, file });
          }
        } else results.push({ r, row: g.firstRow, file });
        if (r.result === "error") {
          resultErrors(r, file, g.firstRow, sink);
          return;
        }
      }
    }
  }
  const pdata: Record<string, unknown> = { ...g.product };
  if (brandExt) pdata.brand_external_id = brandExt;
  if (g.status) pdata.status = g.status;
  const pr = await s.apply("upsert", "product", g.key, pdata);
  results.push({ r: pr, row: g.firstRow, file });
  if (pr.result === "error") {
    for (const x of results) if (x.r.result === "error") resultErrors(x.r, file, g.firstRow, sink);
    return;
  }
  for (const v of g.variants) {
    const r = await s.apply("upsert", "variant", v.externalId, v.data);
    results.push({ r, row: v.row, file });
  }
  const product = s.get("product", g.key)!;
  await applyAssets(ctx, job, st, input, s, product.ext, String(product.stored.style_number), sink, results, g);
  await finishSession(ctx, st, input, s, results, sink);
}

async function applyOrphans(ctx: Ctx, job: JobRow, st: State, input: ImportInput, styleLower: string, sink: ErrSink) {
  const imgs = await imagesForStyle(ctx, job.id, styleLower);
  const byOverride = imgs.find((i) => i.override?.product)?.override?.product;
  const row = await ctx.db.first<{ external_id: string; style_number: string }>(
    "SELECT external_id, style_number FROM products WHERE style_number = ? COLLATE NOCASE OR external_id = ? ORDER BY CASE WHEN style_number = ? THEN 0 ELSE 1 END LIMIT 1",
    [styleLower, byOverride ?? styleLower, styleLower],
  );
  if (!row) {
    for (const im of imgs)
      sink.add({ file: im.name, row: null, column: null, severity: "error", obx_error: "unknown_parent", detail: `No product with style number "${im.style}" in this import or on the node.`, value: im.style });
    return;
  }
  const s = await new CatalogSession(ctx, { allowedBrands: input.allowed_brands, canDelete: false }).init();
  const results: { r: IngestResult; row: number | null; file: string }[] = [];
  await applyAssets(ctx, job, st, input, s, row.external_id, row.style_number, sink, results, null);
  await finishSession(ctx, st, input, s, results, sink);
}

async function applyAssets(
  ctx: Ctx,
  job: JobRow,
  st: State,
  input: ImportInput,
  s: CatalogSession,
  productExt: string,
  styleNumber: string,
  sink: ErrSink,
  results: { r: IngestResult; row: number | null; file: string }[],
  g: ProductGroup | null,
) {
  const imgs = await imagesForStyle(ctx, job.id, styleNumber);
  if (!imgs.length) return;
  const product = await s.load("product", productExt);
  if (!product) return;
  // Colour codes known for this product (catalog spelling): CSV variants + stored variants.
  const colors = new Map<string, string>();
  for (const v of g?.variants ?? []) {
    const c = (v.data.color as { code: string }).code;
    colors.set(c.toLowerCase(), c);
  }
  const dbColors = await ctx.db.all<{ color_code: string }>("SELECT DISTINCT color_code FROM variants WHERE product_id = ? AND color_code IS NOT NULL", [product.id]);
  for (const r of dbColors) if (!colors.has(r.color_code.toLowerCase())) colors.set(r.color_code.toLowerCase(), r.color_code);
  const planned: { im: DoneImg; ext: string; color: string | null }[] = [];
  for (const im of imgs) {
    let color: string | null = null;
    if (im.color) {
      const c = colors.get(im.color.toLowerCase());
      if (!c) {
        sink.add({ file: im.name, row: im.override?.row ?? null, column: "color_code", severity: "error", obx_error: "unknown_parent", detail: `Colour "${im.color}" is not a colour of ${styleNumber}.`, value: im.color });
        continue;
      }
      color = c;
    }
    const ext = im.assetId ?? `${styleNumber}_${color ?? "ALL"}_${im.position}`;
    planned.push({ im, ext, color });
  }
  const counts = new Map<string, number>();
  for (const p of planned) counts.set(p.ext, (counts.get(p.ext) ?? 0) + 1);
  const ok = planned.filter((p) => {
    if ((counts.get(p.ext) ?? 0) > 1) {
      sink.add({ file: p.im.name, row: null, column: null, severity: "error", obx_error: "validation_failed", detail: `Several files in this import are image ${p.ext}; none of them was imported.`, value: p.ext });
      return false;
    }
    return true;
  });
  // Positions of one product colour are applied atomically: temporarily vacate the positions being rewritten.
  s.positionIgnore = new Set(ok.map((p) => p.ext));
  for (const p of ok) {
    const o = p.im.override;
    const files: Record<string, { sha256: string }> = { original: { sha256: p.im.sha256 } };
    for (const [k, v] of Object.entries(p.im.renditions ?? {})) files[k] = { sha256: v };
    const data: Record<string, unknown> = {
      product_external_id: productExt,
      color_code: p.color,
      role: o?.role ?? p.im.role ?? "packshot",
      view: o?.view ?? p.im.view ?? null,
      position: p.im.position,
      filename: p.im.name,
      alt_text: o?.alt_text ?? null,
      rights: o?.rights ?? null,
      provenance: o?.provenance ?? null,
      files,
    };
    if (o?.status) data.status = o.status;
    const r = await s.apply("upsert", "asset", p.ext, data);
    results.push({ r, row: o?.row ?? null, file: o ? (st.assetsName ?? "assets.csv") : p.im.name });
  }
  s.positionIgnore = null;
}

async function finishSession(ctx: Ctx, st: State, input: ImportInput, s: CatalogSession, results: { r: IngestResult; row: number | null; file: string }[], sink: ErrSink) {
  if (!input.dry_run && results.some((x) => x.r.result === "created" || x.r.result === "updated" || x.r.result === "deleted")) {
    try {
      await s.commit();
    } catch (e) {
      if (!(e instanceof ObxError)) throw e;
      for (const x of results) {
        if (x.r.result === "unchanged" || x.r.result === "error") continue;
        x.r = { ...x.r, result: "error", error: e.toProblem() };
      }
    }
  }
  for (const x of results) {
    if (x.r.result === "error") resultErrors(x.r, x.file, x.row, sink);
    else countResult(st, x.r);
    for (const w of x.r.warnings) sink.add({ file: x.file, row: x.row, column: null, severity: "warning", obx_error: "validation_failed", detail: w, value: null });
  }
}

// ------------------------------------------------------------------ representations

export function importRunOf(job: JobRow): Record<string, unknown> {
  const input = safeJsonParse<ImportInput>(job.input, {} as ImportInput);
  const st = safeJsonParse<State>(job.state, {} as State);
  const counts = st.counts ?? { rows: 0, files: 0, created: 0, updated: 0, unchanged: 0, unpublished: 0, errors: 0, warnings: 0 };
  return {
    id: job.id,
    source_id: job.source_id,
    trigger: input.trigger ?? "api",
    status: job.status === "expired" ? "failed" : job.status,
    mode: input.mode ?? "upsert",
    dry_run: !!input.dry_run,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    files: (st.files ?? []).slice(0, 200),
    counts,
    error: job.error ? JSON.parse(job.error) : null,
  };
}

export async function importRunWithPreview(ctx: Ctx, job: JobRow): Promise<Record<string, unknown>> {
  const run = importRunOf(job);
  const prev = await ctx.db.all<{ item: string }>("SELECT item FROM job_items WHERE job_id = ? AND kind = 'row' ORDER BY is_error DESC, idx LIMIT 50", [job.id]);
  return { ...run, errors_preview: prev.map((p) => JSON.parse(p.item)) };
}

export async function storeRequestBody(ctx: Ctx, key: string, req: Request, max: number): Promise<number> {
  const len = Number(req.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(len) && len > max) throw new ObxError("payload_too_large", `Imports may be at most ${Math.floor(max / 1048576)} MB.`);
  if (!req.body) throw new ObxError("invalid_request", "The request has no body.");
  const r = await streamToStore(ctx, key, req.body, max);
  return r.size;
}

export { blobKey, fileRef };

registerJob("import", step, async (ctx, job) => {
  const { onImportFinished } = await import("./notify");
  await onImportFinished(ctx, job);
});
