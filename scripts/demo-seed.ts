// Builds the demo seed archive (docs/demo.md): the spec's Kestrel fixtures plus client renditions
// (web, square, thumb as JPEG, the way the admin UI makes them), which demo mode imports on every reset.
//
//   bun scripts/demo-seed.ts [out.zip] [fixtures dir]        default: demo-seed.zip, test/fixtures/kestrel
//
// Renditions are drawn with macOS `sips` or ImageMagick (`magick`), whichever is installed. Then
// upload the archive once to the portal's storage under demo/seed.zip, e.g. on Cloudflare:
//   bunx wrangler r2 object put <bucket>/demo/seed.zip --file demo-seed.zip --remote -c deploy/demo/wrangler.jsonc
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, sha256Hex } from "../src/lib/crypto";
import { zipBytes } from "../src/lib/zip";
import { imageSize, sniffType } from "../src/lib/image";
import type { DemoSeedManifest } from "../src/core/demo";

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

export async function buildSeed(dir: string, render: Renderer): Promise<Uint8Array> {
  const files: { name: string; data: Uint8Array }[] = [];
  const manifest: DemoSeedManifest = { products_csv: "products.csv", assets_csv: null, images: [] };
  files.push({ name: "products.csv", data: new Uint8Array(readFileSync(join(dir, "products.csv"))) });
  try {
    files.push({ name: "assets.csv", data: new Uint8Array(readFileSync(join(dir, "assets.csv"))) });
    manifest.assets_csv = "assets.csv";
  } catch {
    /* optional */
  }
  for (const name of readdirSync(join(dir, "images")).sort()) {
    const bytes = new Uint8Array(readFileSync(join(dir, "images", name)));
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

if (import.meta.main) {
  const out = process.argv[2] ?? "demo-seed.zip";
  const dir = process.argv[3] ?? join(import.meta.dir, "..", "test", "fixtures", "kestrel");
  const zip = await buildSeed(dir, commandRenderer());
  writeFileSync(out, zip);
  console.log(`demo seed written to ${out} (${(zip.length / 1048576).toFixed(1)} MB)`);
}
