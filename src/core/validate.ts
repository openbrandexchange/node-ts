// Hand-written validation for the OBX input schemas, reporting JSON-pointer field errors.
import { fieldError, type FieldError, type ErrorCode } from "../lib/problem";
import { isPlainObject, normDateTime } from "../lib/util";

export const LANG_RE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
export const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const COUNTRY_RE = /^[A-Z]{2}$/;
export const EXT_RE = /^x-[a-z0-9]+-[a-z0-9_-]+$/;
export const ROLES = ["packshot", "model", "detail", "ghost", "flatlay", "scene", "swatch", "size_chart", "other"];
export const VIEWS = ["front", "back", "side", "left", "right", "top", "bottom", "tilted_left", "tilted_right", "inside", "detail", "other"];
export const CHANNELS = ["webshop", "marketplace", "social", "print"];
export const RENDITIONS = ["original", "web", "square", "thumb"] as const;
export type RenditionName = (typeof RENDITIONS)[number];
export const PROTOCOL_SCOPES = ["catalog:read", "media:read", "media:original", "usage:write"];
export const INGEST_SCOPES = ["ingest:read", "ingest:write", "ingest:delete"];

export class V {
  errors: FieldError[] = [];
  warnings: string[] = [];

  err(pointer: string, detail: string, code: ErrorCode = "validation_failed") {
    this.errors.push(fieldError(pointer, detail, code));
  }
  get ok() {
    return this.errors.length === 0;
  }

  /** Warn about unknown members (forward compatibility: ignored, not rejected). */
  known(obj: Record<string, unknown>, keys: string[], base: string) {
    for (const k of Object.keys(obj)) {
      if (keys.includes(k) || EXT_RE.test(k)) continue;
      this.warnings.push(`Unknown field ${base}/${k} was ignored.`);
    }
  }

  str(v: unknown, p: string, opts: { required?: boolean; min?: number; max?: number; pattern?: RegExp; nullable?: boolean; msg?: string } = {}): string | null {
    if (v === undefined || v === null) {
      if (opts.required) this.err(p, "This field is required.");
      else if (v === null && opts.nullable === false) this.err(p, "May not be null.");
      return null;
    }
    if (typeof v !== "string") {
      this.err(p, "Must be text.");
      return null;
    }
    const s = v.trim();
    if ((opts.min ?? 0) > 0 && s.length < (opts.min ?? 0)) {
      this.err(p, opts.required ? "This field is required." : `At least ${opts.min} characters.`);
      return null;
    }
    if (opts.max !== undefined && s.length > opts.max) {
      this.err(p, `At most ${opts.max} characters.`);
      return null;
    }
    if (opts.pattern && !opts.pattern.test(s)) {
      this.err(p, opts.msg ?? "Invalid format.");
      return null;
    }
    return s === "" && !opts.required ? null : s;
  }

  enumv<T extends string>(v: unknown, p: string, values: readonly T[], required = false): T | null {
    if (v === undefined || v === null) {
      if (required) this.err(p, "This field is required.");
      return null;
    }
    if (typeof v !== "string" || !values.includes(v as T)) {
      this.err(p, `Must be one of: ${values.join(", ")}.`);
      return null;
    }
    return v as T;
  }

  bool(v: unknown, p: string): boolean | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== "boolean") {
      this.err(p, "Must be true or false.");
      return null;
    }
    return v;
  }

  int(v: unknown, p: string, min: number, max: number, required = false): number | null {
    if (v === undefined || v === null) {
      if (required) this.err(p, "This field is required.");
      return null;
    }
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      this.err(p, `Must be a whole number from ${min} to ${max}.`);
      return null;
    }
    return v;
  }

  url(v: unknown, p: string): string | null {
    const s = this.str(v, p, { max: 2048 });
    if (s === null) return null;
    if (!/^https?:\/\//i.test(s)) {
      this.err(p, "Must be an http(s) address.");
      return null;
    }
    try {
      new URL(s);
    } catch {
      this.err(p, "Must be a valid web address.");
      return null;
    }
    return s;
  }

  email(v: unknown, p: string, required = false): string | null {
    const s = this.str(v, p, { required, max: 254 });
    if (s === null) return null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
      this.err(p, "Must be a valid e-mail address.");
      return null;
    }
    return s.toLowerCase();
  }

  dateTime(v: unknown, p: string): string | null {
    if (v === undefined || v === null) return null;
    const d = normDateTime(v);
    if (!d) this.err(p, "Must be an RFC 3339 timestamp, e.g. 2026-09-28T10:00:00Z.");
    return d;
  }

  localized(v: unknown, p: string, required = false): Record<string, string> | null {
    if (v === undefined || v === null) {
      if (required) this.err(p, "This field is required.");
      return null;
    }
    if (!isPlainObject(v)) {
      this.err(p, 'Must be an object keyed by language, e.g. {"en": "…"}.');
      return null;
    }
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) {
      if (!LANG_RE.test(k)) {
        this.err(`${p}/${k}`, "Language keys are BCP 47 tags like en, nl or de-CH.");
        continue;
      }
      if (typeof val !== "string" || val.trim() === "") {
        this.err(`${p}/${k}`, "Must be non-empty text.");
        continue;
      }
      if (val.length > 20000) {
        this.err(`${p}/${k}`, "At most 20000 characters.");
        continue;
      }
      out[k] = val.trim();
    }
    if (!Object.keys(out).length && Object.keys(v).length === 0) {
      if (required) this.err(p, "At least one language is required.");
      return null;
    }
    return Object.keys(out).length ? sortKeys(out) : null;
  }

  country(v: unknown, p: string): string | null {
    return this.str(v, p, { pattern: COUNTRY_RE, msg: "Use a two-letter ISO country code such as NL." });
  }

  key(v: unknown, p: string): string | null {
    return this.str(v, p, { pattern: KEY_RE, msg: "Use lowercase letters, digits and _ (starting with a letter)." });
  }

  materials(v: unknown, p: string): { part: string; fibers: { fiber: string; percentage: number }[] }[] | null {
    if (v === undefined || v === null) return null;
    if (!Array.isArray(v)) {
      this.err(p, "Must be a list of parts.");
      return null;
    }
    const out: { part: string; fibers: { fiber: string; percentage: number }[] }[] = [];
    v.forEach((part, i) => {
      if (!isPlainObject(part)) return this.err(`${p}/${i}`, "Must be an object.");
      const name = this.key(part.part, `${p}/${i}/part`);
      if (!Array.isArray(part.fibers) || part.fibers.length === 0) return this.err(`${p}/${i}/fibers`, "At least one fibre is required.");
      const fibers: { fiber: string; percentage: number }[] = [];
      part.fibers.forEach((f: unknown, j: number) => {
        if (!isPlainObject(f)) return this.err(`${p}/${i}/fibers/${j}`, "Must be an object.");
        const fiber = this.key(f.fiber, `${p}/${i}/fibers/${j}/fiber`);
        const pct = f.percentage;
        if (typeof pct !== "number" || !(pct > 0) || pct > 100) return this.err(`${p}/${i}/fibers/${j}/percentage`, "Must be a number above 0 and at most 100.");
        if (fiber) fibers.push({ fiber, percentage: pct });
      });
      if (name) out.push({ part: name, fibers });
    });
    return out;
  }

  care(v: unknown, p: string): { code: string; text: Record<string, string> | null }[] | null {
    if (v === undefined || v === null) return null;
    if (!Array.isArray(v)) {
      this.err(p, "Must be a list of care codes.");
      return null;
    }
    const out: { code: string; text: Record<string, string> | null }[] = [];
    v.forEach((c, i) => {
      if (!isPlainObject(c)) return this.err(`${p}/${i}`, "Must be an object.");
      const code = this.key(c.code, `${p}/${i}/code`);
      const text = this.localized(c.text, `${p}/${i}/text`);
      if (code) out.push({ code, text });
    });
    return out;
  }

  attributes(v: unknown, p: string): Record<string, unknown> | null {
    if (v === undefined || v === null) return null;
    if (!isPlainObject(v)) {
      this.err(p, "Must be an object.");
      return null;
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (!KEY_RE.test(k)) {
        this.err(`${p}/${k}`, "Attribute keys use lowercase letters, digits and _.");
        continue;
      }
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") out[k] = val;
      else if (isPlainObject(val)) {
        const l = this.localized(val, `${p}/${k}`);
        if (l) out[k] = l;
      } else this.err(`${p}/${k}`, "Must be text, a number, true/false or localised text.");
    }
    return Object.keys(out).length ? sortKeys(out) : null;
  }

  /** Extension members (x-vendor-name) are kept as-is. */
  extensions(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) if (EXT_RE.test(k)) out[k] = v;
    return out;
  }
}

export function sortKeys<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k];
  return out as T;
}

export function validExternalId(raw: string): string | null {
  const s = raw.trim();
  if (s.length < 1 || s.length > 200) return null;
  if (/[\x00-\x1f\x7f/]/.test(s)) return null;
  return s;
}
