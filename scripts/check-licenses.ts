// Licence check of everything this node ships: the production dependencies (dependencies and
// optionalDependencies of package.json, transitively). Fails on a licence that is not on the
// allowlist of AGPL-3.0-compatible licences, or on a package without licence information.
// Usage: bun scripts/check-licenses.ts [--list]
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ALLOWED = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "BlueOak-1.0.0", "CC0-1.0", "Unlicense", "MIT-0", "Zlib", "Python-2.0", "CC-BY-4.0", "AGPL-3.0-only", "AGPL-3.0-or-later", "LGPL-3.0-or-later", "MPL-2.0"]);
const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

interface Found {
  name: string;
  version: string;
  license: string;
  ok: boolean;
}

/** SPDX expressions: "(MIT OR Apache-2.0)" passes when one side passes; "AND" needs all. */
function allowed(expr: string): boolean {
  const e = expr.replace(/[()]/g, " ").trim();
  if (/\bOR\b/.test(e)) return e.split(/\bOR\b/).some((x) => allowed(x));
  if (/\bAND\b/.test(e)) return e.split(/\bAND\b/).every((x) => allowed(x));
  return ALLOWED.has(e.trim());
}

function findPackage(name: string, from: string): string | null {
  let dir = from;
  for (;;) {
    const p = join(dir, "node_modules", name, "package.json");
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const seen = new Map<string, Found>();
const missing: string[] = [];
function visit(name: string, from: string, optional: boolean) {
  const p = findPackage(name, from);
  if (!p) {
    if (!optional) missing.push(name);
    return;
  }
  const j = JSON.parse(readFileSync(p, "utf8"));
  const key = `${j.name}@${j.version}`;
  if (seen.has(key)) return;
  const raw = typeof j.license === "string" ? j.license : j.license?.type ?? (Array.isArray(j.licenses) ? j.licenses.map((l: { type: string }) => l.type).join(" OR ") : "");
  seen.set(key, { name: j.name, version: j.version, license: raw || "UNKNOWN", ok: !!raw && allowed(raw) });
  for (const d of Object.keys(j.dependencies ?? {})) visit(d, dirname(p), false);
  for (const d of Object.keys(j.optionalDependencies ?? {})) visit(d, dirname(p), true);
}
for (const d of Object.keys(pkg.dependencies ?? {})) visit(d, root, false);
for (const d of Object.keys(pkg.optionalDependencies ?? {})) visit(d, root, true);

const all = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
if (process.argv.includes("--list")) for (const f of all) console.log(`${f.ok ? "ok " : "BAD"} ${f.name}@${f.version} ${f.license}`);
const bad = all.filter((f) => !f.ok);
if (missing.length) console.error(`not installed (run bun install): ${missing.join(", ")}`);
if (bad.length) {
  console.error(`Licences not on the allowlist:\n${bad.map((f) => `  ${f.name}@${f.version}: ${f.license}`).join("\n")}`);
  process.exit(1);
}
if (missing.length) process.exit(1);
console.log(`${all.length} production packages, all licences allowed.`);
