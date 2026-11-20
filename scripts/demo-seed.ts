// Builds the demo seed archive (docs/demo.md): the spec's MAISON NOOR fixtures plus client renditions
// (web, square, thumb as JPEG, the way the admin UI makes them), which demo mode imports on every reset,
// and the showroom (theme, login page, start page and their images, scripts/demo-showroom.ts).
//
//   bun scripts/demo-seed.ts [out.zip] [fixtures dir]        default: demo-seed.zip, test/fixtures/maison-noor
//
// With rsvg-convert and ImageMagick installed, the fixtures' flat colour squares are replaced by drawn
// product shots and the showroom images are drawn (scripts/demo-art.ts); the fixture files themselves
// are never changed. Renditions are drawn with macOS `sips` or ImageMagick (`magick`). Then
// upload the archive once to the portal's storage under demo/seed.zip, e.g. on Cloudflare:
//   bunx wrangler r2 object put <bucket>/demo/seed.zip --file demo-seed.zip --remote -c deploy/demo/wrangler.jsonc
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, sha256Hex } from "../src/lib/crypto";
import { zipBytes } from "../src/lib/zip";
import { imageSize, sniffType } from "../src/lib/image";
import type { DemoSeedManifest } from "../src/core/demo";
import { SHOWROOM_IMAGES, showroomBranding } from "./demo-showroom";

export type Rendition = "web" | "square" | "thumb";
/** Makes one JPEG rendition of a PNG/JPEG original (spec protocol.md §5.5 rules). */
export type Renderer = (original: Uint8Array, name: Rendition, sizes: Record<Rendition, { width: number; height: number }>) => Promise<Uint8Array>;

const WEB_MAX = 2000;
const THUMB_MAX = 600;

function fit(w: number, h: number, max: number) {
  const long = Math.max(w, h);
  if (long <= max) return { width: w, height: h };
  const s = max / long;
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Target size of each rendition for an original of w x h. */
export function renditionSizes(w: number, h: number): Record<Rendition, { width: number; height: number }> {
  const web = fit(w, h, WEB_MAX);
  const side = Math.max(web.width, web.height);
  return { web, square: { width: side, height: side }, thumb: fit(w, h, THUMB_MAX) };
}

export interface SeedArt {
  /** A product shot replacing a fixture image (JPEG), or null to keep the fixture file. */
  product?: (file: string, info: ProductInfo) => Promise<Uint8Array | null>;
  /** The showroom images by key of SHOWROOM_IMAGES (PNG, JPEG or WebP). */
  showroom?: (key: keyof typeof SHOWROOM_IMAGES) => Promise<Uint8Array>;
}

export interface ProductInfo {
  style: string;
  color: string;
  view: string;
  item_type: string;
  name: string;
}

/** Style number → item type and English name, from products.csv (first row of each style). */
function productInfo(csv: string): Map<string, { item_type: string; name: string }> {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(",");
  const col = (n: string) => head.indexOf(n);
  const out = new Map<string, { item_type: string; name: string }>();
  for (const line of lines.slice(1)) {
    const cells = line.split(","); // the columns used here never contain commas
    const style = cells[col("style_number")];
    if (style && !out.has(style)) out.set(style, { item_type: cells[col("item_type")] ?? "", name: cells[col("name:en")] ?? "" });
  }
  return out;
}

export async function buildSeed(dir: string, render: Renderer, art: SeedArt = {}): Promise<Uint8Array> {
  const files: { name: string; data: Uint8Array }[] = [];
  const manifest: DemoSeedManifest = { products_csv: "products.csv", assets_csv: null, images: [] };
  const productsCsv = readFileSync(join(dir, "products.csv"), "utf8");
  files.push({ name: "products.csv", data: new TextEncoder().encode(productsCsv) });
  let assetsCsv: string | null = null;
  try {
    assetsCsv = readFileSync(join(dir, "assets.csv"), "utf8");
  } catch {
    /* optional */
  }
  const info = productInfo(productsCsv);
  const renamed = new Map<string, string>();
  for (const original of readdirSync(join(dir, "images")).sort()) {
    let name = original;
    let bytes: Uint8Array = new Uint8Array(readFileSync(join(dir, "images", original)));
    const m = original.match(/^(.+?)_([A-Z0-9]+)_(\d+)_([a-z_]+)\.[a-z]+$/);
    if (art.product && m) {
      const p = info.get(m[1]);
      const shot = await art.product(original, { style: m[1], color: m[2], view: m[4], item_type: p?.item_type ?? "", name: p?.name ?? "" });
      if (shot) {
        bytes = shot;
        name = original.replace(/\.[a-z]+$/, ".jpg");
        renamed.set(original, name);
      }
    }
    const type = sniffType(bytes);
    const dims = type && imageSize(bytes, type);
    if (!dims) continue;
    const path = `images/${name}`;
    files.push({ name: path, data: bytes });
    const entry: DemoSeedManifest["images"][number] = { file: name, sha256: await sha256Hex(bytes), path, renditions: {} };
    const sizes = renditionSizes(dims.width, dims.height);
    for (const r of ["web", "square", "thumb"] as const) {
      const jpg = await render(bytes, r, sizes);
      const rpath = `renditions/${name.replace(/\.[^.]+$/, "")}.${r}.jpg`;
      files.push({ name: rpath, data: jpg });
      entry.renditions![r] = { sha256: await sha256Hex(jpg), path: rpath };
    }
    manifest.images.push(entry);
  }
  if (assetsCsv !== null) {
    for (const [from, to] of renamed) assetsCsv = assetsCsv.split(from).join(to);
    files.push({ name: "assets.csv", data: new TextEncoder().encode(assetsCsv) });
    manifest.assets_csv = "assets.csv";
  }
  if (art.showroom) {
    const images: NonNullable<DemoSeedManifest["branding"]>["images"] = [];
    for (const [key, id] of Object.entries(SHOWROOM_IMAGES) as [keyof typeof SHOWROOM_IMAGES, string][]) {
      const bytes = await art.showroom(key);
      const type = sniffType(bytes);
      const dims = type && imageSize(bytes, type);
      if (!type || !dims) throw new Error(`showroom image ${key} is not an image`);
      const path = `showroom/${key}.${type.split("/")[1]}`;
      files.push({ name: path, data: bytes });
      images.push({ id, path, sha256: await sha256Hex(bytes), content_type: type, width: dims.width, height: dims.height, bytes: bytes.length });
    }
    manifest.branding = { ...showroomBranding(), images };
  }
  files.unshift({ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
  return zipBytes(files, crc32);
}

/** sips (macOS) or ImageMagick: scale to fit, pad to a white square for "square", JPEG quality 85. */
export function commandRenderer(): Renderer {
  const has = (cmd: string) => Bun.spawnSync(["sh", "-c", `command -v ${cmd}`]).exitCode === 0;
  const tool = has("sips") ? "sips" : has("magick") ? "magick" : null;
  if (!tool) throw new Error("Install ImageMagick (magick) or run on macOS (sips) to draw the renditions.");
  return async (original, name, sizes) => {
    const size = sizes[name];
    const tmp = mkdtempSync(join(tmpdir(), "obx-demo-seed-"));
    try {
      const src = join(tmp, "in");
      const out = join(tmp, "out.jpg");
      writeFileSync(src, original);
      const run = (args: string[]) => {
        const p = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
        if (p.exitCode !== 0) throw new Error(`${args[0]} failed: ${p.stderr.toString()}`);
      };
      if (tool === "sips") {
        const inner = name === "square" ? sizes.web : size;
        run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "85", "-z", String(inner.height), String(inner.width), src, "--out", out]);
        if (name === "square") run(["sips", "-p", String(size.height), String(size.width), "--padColor", "FFFFFF", out, "--out", out]);
      } else {
        const geo = `${size.width}x${size.height}`;
        const sq = name === "square" ? ["-gravity", "center", "-background", "white", "-extent", geo] : [];
        run(["magick", src, "-background", "white", "-flatten", "-resize", `${geo}>`, ...sq, "-quality", "85", "-strip", out]);
      }
      return new Uint8Array(readFileSync(out));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}

/** The drawn art (scripts/demo-art.ts): product shots per item type, colour and view, and the showroom images. */
export async function drawnArt(): Promise<SeedArt> {
  const a = await import("./demo-art");
  const kind = (p: ProductInfo) => (/messenger/i.test(p.name) ? "messenger" : /rain|shell/i.test(p.name) ? "rain_jacket" : p.item_type);
  const views = ["front", "back", "side", "inside", "detail", "model"];
  let seed = 1;
  return {
    product: async (_file, p) => a.renderJpeg(a.productSvg(kind(p), p.color, (views.includes(p.view) ? p.view : "front") as never), { width: 1200, height: 1500, grain: 0.1, seed: seed++ }),
    showroom: async (key) => {
      if (key === "hero") return a.renderJpeg(a.heroSvg(), { width: 2400, height: 1200, seed: 11 });
      if (key === "login") return a.renderJpeg(a.loginSvg(), { width: 1600, height: 2000, seed: 12 });
      if (key === "materials") return a.renderJpeg(a.materialSvg(), { width: 1600, height: 1200, seed: 13 });
      return a.renderJpeg(a.tileSvg(key), { width: 1200, height: 1500, seed: 14 });
    },
  };
}

if (import.meta.main) {
  const out = process.argv[2] ?? "demo-seed.zip";
  const dir = process.argv[3] ?? join(import.meta.dir, "..", "test", "fixtures", "maison-noor");
  const { hasArtTools } = await import("./demo-art");
  if (!hasArtTools()) console.warn("rsvg-convert and ImageMagick not found: the seed keeps the fixture images and has no showroom.");
  const zip = await buildSeed(dir, commandRenderer(), hasArtTools() ? await drawnArt() : {});
  writeFileSync(out, zip);
  console.log(`demo seed written to ${out} (${(zip.length / 1048576).toFixed(1)} MB)`);
}
