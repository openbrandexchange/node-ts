// Excel workbooks (.xlsx) as products.csv / assets.csv: the conversion of spec import-format.md §5
// (a node feature). The result is the canonical CSV text of the rows (§5.3) plus the conversion
// errors and warnings with Excel row numbers (§5.5); the caller imports that CSV like any other.
//
// Safety and limits (§5.6) in the specified order: size (the caller), signature, readable zip,
// zip bomb (declared sizes, then the bytes actually inflated), unsafe parts by name and content type
// (never inflated), structure, external relationships, sheet, cells. Only [Content_Types].xml,
// _rels/.rels, the workbook part and its relationships, styles, shared strings and worksheets are
// inflated, each into memory only (never to storage), and the chosen worksheet is parsed as a stream
// while it inflates. Nothing is calculated, run or fetched.

import { readZipDirectory, type RangeReader, type ZipReadEntry } from "./zip";
import { XmlError, XmlParser, attrOf, type XmlHandler } from "./xml";

const MiB = 1024 * 1024;
/** §5.6 limits (fixed, so every node gives the same answer). */
export const XLSX_LIMITS = { entries: 1000, totalBytes: 256 * MiB, ratio: 100, ratioFloor: 10 * MiB, maxRow: 100001, maxCol: 1000 };

export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type WorkbookCode = "workbook_invalid" | "workbook_unsafe" | "workbook_sheet_missing" | "workbook_too_large";

export class WorkbookError extends Error {
  constructor(
    public code: WorkbookCode,
    public detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

export type WorkbookRole = "products" | "assets";
export const WORKBOOK_ROLES: Record<WorkbookRole, { sheet: string; keys: string[]; file: string }> = {
  products: { sheet: "products", keys: ["style_number", "style"], file: "products.xlsx" },
  assets: { sheet: "assets", keys: ["file"], file: "assets.xlsx" },
};

/** An ImportRowError of the conversion (same shape as the CSV import's row errors). */
export interface WorkbookRowError {
  file: string;
  row: number | null;
  column: string | null;
  severity: "error" | "warning";
  obx_error: string;
  detail: string;
  value: string | null;
}

export interface WorkbookResult {
  /** Name of the sheet that was read. */
  sheet: string;
  /** Header texts of row 1, columns 1 to W, as written (not trimmed). */
  header: string[];
  /** Canonical CSV of rows 1 to R (§5.3) as UTF-8, in chunks of about 1 MiB (see csvBytes / csvText). */
  csv: Uint8Array[];
  /** Total length of `csv` in bytes. */
  csvSize: number;
  errors: WorkbookRowError[];
  warnings: WorkbookRowError[];
}

/**
 * Whether an uploaded file is a workbook (§5.1): the name decides (".xlsx", any case); a file without
 * a name is one when its content type is the xlsx type. "other" is another spreadsheet format
 * (answered with unsupported_media_type); null is anything else (a CSV).
 */
export function workbookKind(filename: string | null | undefined, contentType?: string | null): "xlsx" | "other" | null {
  if (filename) {
    if (/\.xlsx$/i.test(filename)) return "xlsx";
    if (/\.(xlsm|xls|xlsb|xltx|xltm|ods|numbers)$/i.test(filename)) return "other";
    return null;
  }
  return (contentType ?? "").split(";")[0].trim().toLowerCase() === XLSX_CONTENT_TYPE ? "xlsx" : null;
}

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_STRICT = "http://purl.oclc.org/ooxml/spreadsheetml/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_OFFICE_DOCUMENT = `${NS_REL}/officeDocument`;
const REL_WORKSHEET = `${NS_REL}/worksheet`;
const REL_STYLES = `${NS_REL}/styles`;
const REL_SHARED_STRINGS = `${NS_REL}/sharedStrings`;
const MAIN_TYPES = ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml"];

// ------------------------------------------------------------------ helpers

export function colLetter(n: number): string {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
function colNumber(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + letters.charCodeAt(i) - 64;
  return n;
}
/** White space around header names (§1.1): space, tab, CR, LF. */
export const trimHeader = (h: string) => h.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
/** CSV header normalisation used for the sheet choice (§5.2, §1.1): each run of white space and "-" is one "_". */
const normalizeHeader = (h: string) => trimHeader(h).toLowerCase().replace(/[ \t\r\n-]+/g, "_");

/** §5.4 ST_Xstring escapes: _xHHHH_ is the character U+HHHH, one left-to-right pass. */
export const unescapeXstring = (s: string) => (s.includes("_x") ? s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) : s);

/** §5.5 locator at the start of every detail about a cell: "row 12, column ean (C): ", or "row 12, column C: " without a header. */
export const cellLocator = (row: number, column: string | null, letter: string) => (column ? `row ${row}, column ${column} (${letter}): ` : `row ${row}, column ${letter}: `);

// ------------------------------------------------------------------ numbers (§5.4)

const NUMBER = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * The text of a numeric cell value as written in <v>: exact decimal expansion, rounded to 15
 * significant digits (half away from zero), no exponent, no trailing zeros, "." as separator.
 * Returns null when <v> is not a number or (not zero) outside Excel's range 1E-308 <= |x| < 1E+308.
 */
export function numberText(lex: string): string | null {
  const m = NUMBER.exec(lex.trim());
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return null;
  const neg = m[1] === "-";
  const all = m[2] + (m[3] ?? "");
  let z = 0;
  while (z < all.length && all[z] === "0") z++;
  let digits = all.slice(z);
  if (/^0*$/.test(digits)) return "0"; // zero, whatever its exponent
  // a non-zero number with an exponent of more than 9 digits is out of range (never expanded)
  if (m[4] !== undefined && m[4].replace(/^[+-]?0*/, "").length > 9) return null;
  let point = m[2].length + Number(m[4] ?? 0) - z;
  if (digits.length > 15) {
    const up = digits[15] >= "5";
    const kept = digits.slice(0, 15).split("").map(Number);
    if (up) {
      let i = 14;
      while (i >= 0) {
        if (kept[i] === 9) {
          kept[i] = 0;
          i--;
        } else {
          kept[i]++;
          break;
        }
      }
      if (i < 0) {
        kept.unshift(1);
        kept.pop();
        point++;
      }
    }
    digits = kept.join("");
  }
  digits = digits.replace(/0+$/, "");
  // Excel's range (§5.4, numbers, step 3); the leading digit stands for 10^(point - 1)
  if (point - 1 >= 308 || point - 1 < -308) return null;
  let int: string;
  let frac: string;
  if (point <= 0) {
    int = "0";
    frac = "0".repeat(-point) + digits;
  } else if (point >= digits.length) {
    int = digits + "0".repeat(point - digits.length);
    frac = "";
  } else {
    int = digits.slice(0, point);
    frac = digits.slice(point);
  }
  return (neg ? "-" : "") + int + (frac ? "." + frac : "");
}

// ------------------------------------------------------------------ number formats (§5.4)

const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58]);
const BUILTIN_TIME_IDS = new Set([18, 19, 20, 21, 22, 32, 33, 45, 46, 47, 55, 56]);

/** First section of a format code with literals removed: quoted text, \x, _x, *x, […] (except [h], [mm], [ss]). */
export function formatSkeleton(code: string): string {
  let out = "";
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"') {
      const j = code.indexOf('"', i + 1);
      i = j < 0 ? code.length : j;
      continue;
    }
    if (c === "\\" || c === "_" || c === "*") {
      i++;
      continue;
    }
    if (c === "[") {
      const j = code.indexOf("]", i + 1);
      const inner = j < 0 ? "" : code.slice(i + 1, j);
      if (/^(h+|m+|s+)$/i.test(inner)) out += inner;
      i = j < 0 ? code.length : j;
      continue;
    }
    if (c === ";") break;
    out += c;
  }
  return out;
}

/** "date", "datetime" or null for a number format (id and, for custom formats, the code). */
export function dateKind(id: number, code: string | undefined): "date" | "datetime" | null {
  if (BUILTIN_DATE_IDS.has(id)) return "date";
  if (BUILTIN_TIME_IDS.has(id)) return "datetime";
  if (code === undefined) return null;
  const sk = formatSkeleton(code);
  if (!/[dmyhs]/i.test(sk)) return null;
  return /[hs]/i.test(sk) ? "datetime" : "date";
}

/** Zero padding: a format code of only "0"s (at least two) pads a non-negative integer to that many digits. */
export const zeroPad = (code: string | undefined) => (code && /^0{2,}$/.test(code) ? code.length : 0);

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Serial number to ISO text (§5.4); null for serials the rule does not accept. */
export function serialText(lex: string, kind: "date" | "datetime", date1904: boolean): string | null {
  const v = Number(lex);
  if (!Number.isFinite(v)) return null;
  if (date1904 ? v < 0 : v < 61) return null;
  let days = Math.floor(v);
  let secs = Math.round((v - days) * 86400);
  if (secs >= 86400) {
    days++;
    secs -= 86400;
  }
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + days * 86400000);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() > 9999) return null; // after 9999-12-31
  const ymd = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (kind === "date") return ymd;
  return `${ymd}T${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}Z`;
}

/** t="d" cells (ISO 8601 text). */
export function isoCellText(lex: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]00:00)?)?$/.exec(lex.trim());
  if (!m) return null;
  if (!m[2] || (m[2] === "00" && m[3] === "00" && (m[4] ?? "00") === "00")) return m[1];
  return `${m[1]}T${m[2]}:${m[3]}:${m[4] ?? "00"}Z`;
}

// ------------------------------------------------------------------ XML parts

const STOP = Symbol("stop");

function xmlFail(e: unknown, part: string): never {
  if (e instanceof XmlError) throw new WorkbookError("workbook_invalid", e.doctype ? `${part} has a DOCTYPE` : `${part} is not well-formed XML (${e.message})`);
  throw e;
}

/** Parses a complete part. */
function parseXml(bytes: Uint8Array, part: string, h: XmlHandler, bind?: (p: XmlParser) => void): void {
  const p = new XmlParser(h);
  bind?.(p);
  try {
    p.feed(bytes);
    p.end();
  } catch (e) {
    xmlFail(e, part);
  }
}

/** A handler for parts whose text is not needed. */
function tags(open: (local: string, attrs: string[], prefix: string) => void, close: (local: string) => void = () => {}): XmlHandler {
  return { open: (l, pfx, a) => open(l, a, pfx), close, text() {}, wantText: false };
}

interface ContentTypes {
  all: string[];
  typeOf(part: string): string | undefined;
}
function parseContentTypes(bytes: Uint8Array): ContentTypes {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  parseXml(
    bytes,
    "[Content_Types].xml",
    tags((l, a) => {
      if (l === "Default") defaults.set((attrOf(a, "Extension") ?? "").toLowerCase(), attrOf(a, "ContentType") ?? "");
      if (l === "Override") overrides.set((attrOf(a, "PartName") ?? "").toLowerCase(), attrOf(a, "ContentType") ?? "");
    }),
  );
  return {
    all: [...defaults.values(), ...overrides.values()],
    typeOf: (part) => overrides.get(part.toLowerCase()) ?? defaults.get(part.split(".").pop()!.toLowerCase()),
  };
}

interface Rel {
  id: string | undefined;
  type: string | undefined;
  target: string;
  external: boolean;
}
function parseRels(bytes: Uint8Array, part: string): Rel[] {
  const rels: Rel[] = [];
  parseXml(
    bytes,
    part,
    tags((l, a) => {
      if (l === "Relationship") rels.push({ id: attrOf(a, "Id"), type: attrOf(a, "Type"), target: attrOf(a, "Target") ?? "", external: attrOf(a, "TargetMode") === "External" });
    }),
  );
  return rels;
}

/** Resolves a relationship target against the source part (absolute when it starts with "/"). */
function resolvePart(source: string, target: string): string {
  const base = target.startsWith("/") ? [] : source.split("/").slice(0, -1).filter((x) => x !== "");
  for (const seg of target.replace(/^\//, "").split("/")) {
    if (seg === "..") base.pop();
    else if (seg !== "." && seg !== "") base.push(seg);
  }
  return "/" + base.join("/");
}
const relsOf = (part: string) => {
  const s = part.split("/");
  const f = s.pop();
  return `${s.join("/")}/_rels/${f}.rels`;
};

interface SheetRef {
  name: string;
  state: string;
  rid: string | undefined;
}
function parseWorkbook(bytes: Uint8Array, part: string): { sheets: SheetRef[]; date1904: boolean } {
  const sheets: SheetRef[] = [];
  let date1904 = false;
  let root = true;
  let parser: XmlParser;
  parseXml(
    bytes,
    part,
    tags((l, a, prefix) => {
      if (root) {
        root = false;
        const uri = parser.uriOf(prefix);
        if (l !== "workbook" || uri !== NS_MAIN)
          throw new WorkbookError("workbook_invalid", uri === NS_STRICT ? "the workbook is saved as Strict Open XML; save it as an Excel Workbook (.xlsx)" : `${part} is not a SpreadsheetML workbook`);
      }
      if (l === "workbookPr") {
        const v = attrOf(a, "date1904");
        date1904 = v === "1" || v === "true";
      }
      if (l === "sheet") {
        let rid: string | undefined;
        for (let i = 0; i < a.length; i += 2) {
          const c = a[i].indexOf(":");
          if (c > 0 && a[i].slice(c + 1) === "id" && parser.uriOf(a[i].slice(0, c)) === NS_REL) rid = a[i + 1];
        }
        sheets.push({ name: attrOf(a, "name") ?? "", state: attrOf(a, "state") ?? "visible", rid });
      }
    }),
    (p) => (parser = p),
  );
  return { sheets, date1904 };
}

type Fmt = (s: number) => { id: number; code: string | undefined };
function parseStyles(bytes: Uint8Array | null): Fmt {
  const numFmts = new Map<number, string>();
  const xfs: number[] = [];
  let inXfs = false;
  if (bytes)
    parseXml(
      bytes,
      "styles",
      tags(
        (l, a) => {
          if (l === "numFmt") numFmts.set(Number(attrOf(a, "numFmtId")), attrOf(a, "formatCode") ?? "");
          if (l === "cellXfs") inXfs = true;
          if (l === "xf" && inXfs) xfs.push(Number(attrOf(a, "numFmtId") ?? 0));
        },
        (l) => {
          if (l === "cellXfs") inXfs = false;
        },
      ),
    );
  return (s) => {
    const id = xfs[s] ?? 0;
    return { id, code: numFmts.get(id) };
  };
}

/** Text of <si>/<is>: <t> directly inside, and <t> inside <r>; <rPh> (phonetic) is ignored. */
class RichText {
  inPh = 0;
  inT = false;
  buf = "";
  open(l: string) {
    if (l === "rPh") this.inPh++;
    if (l === "t" && !this.inPh) this.inT = true;
  }
  close(l: string) {
    if (l === "rPh") this.inPh--;
    if (l === "t") this.inT = false;
  }
  take(): string {
    const s = this.buf;
    this.buf = "";
    return unescapeXstring(s);
  }
}

function parseSharedStrings(bytes: Uint8Array | null): string[] {
  const out: string[] = [];
  if (!bytes) return out;
  const rt = new RichText();
  let inSi = false;
  parseXml(bytes, "sharedStrings", {
    open(l) {
      if (l === "si") inSi = true;
      else if (inSi) rt.open(l);
    },
    close(l) {
      if (l === "si") {
        inSi = false;
        out.push(rt.take());
      } else if (inSi) rt.close(l);
    },
    text(t) {
      rt.buf += t;
    },
    get wantText() {
      return inSi && rt.inT;
    },
  });
  return out;
}

// ------------------------------------------------------------------ the package (zip)

class ReadFailure {
  constructor(public cause: unknown) {}
}

const CHUNK = 4 * MiB;

class Package {
  private byName = new Map<string, ZipReadEntry>();
  /** Bytes inflated per part (a part read twice counts once) and in total. */
  private counted = new Map<string, number>();
  private inflated = 0;

  constructor(
    private read: RangeReader,
    public entries: ZipReadEntry[],
  ) {
    for (const e of entries) this.byName.set(e.name.toLowerCase(), e);
  }

  find(name: string): ZipReadEntry | undefined {
    return this.byName.get(name.replace(/^\//, "").toLowerCase());
  }

  /** Inflates an entry chunk by chunk; `onChunk` returning false stops early. */
  async stream(e: ZipReadEntry, onChunk: (c: Uint8Array) => boolean | void): Promise<void> {
    try {
      await this.inflate(e, onChunk);
    } catch (err) {
      if (err instanceof ReadFailure) throw err.cause;
      throw err;
    }
  }

  private async inflate(e: ZipReadEntry, onChunk: (c: Uint8Array) => boolean | void): Promise<void> {
    const key = e.name.toLowerCase();
    let got = 0;
    const count = (len: number) => {
      got += len;
      const before = this.counted.get(key) ?? 0;
      if (got > before) {
        this.inflated += got - before;
        this.counted.set(key, got);
      }
      if (got > e.size) throw new WorkbookError("workbook_too_large", `${e.name} expands beyond its declared size`);
      if (this.inflated > XLSX_LIMITS.totalBytes) throw new WorkbookError("workbook_too_large", `the parts expand to more than ${XLSX_LIMITS.totalBytes} bytes (at ${e.name})`);
    };
    const read = async (off: number, len: number) => {
      try {
        return await this.read(off, len);
      } catch (err) {
        throw new ReadFailure(err);
      }
    };
    const lh = await read(e.localOffset, 30);
    const v = new DataView(lh.buffer, lh.byteOffset, lh.byteLength);
    if (lh.length < 30 || v.getUint32(0, true) !== 0x04034b50) throw new WorkbookError("workbook_invalid", `the zip cannot be read (broken local header of ${e.name})`);
    const start = e.localOffset + 30 + v.getUint16(26, true) + v.getUint16(28, true);
    if (e.method === 0) {
      for (let off = 0; off < e.compressedSize; off += CHUNK) {
        const c = await read(start + off, Math.min(CHUNK, e.compressedSize - off));
        count(c.length);
        if (onChunk(c) === false) return;
      }
      return;
    }
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    let stopped = false;
    let feedError: unknown = null;
    let consumerError: unknown = null;
    const feed = (async () => {
      try {
        for (let off = 0; off < e.compressedSize && !stopped; off += CHUNK) {
          const raw = await read(start + off, Math.min(CHUNK, e.compressedSize - off));
          await writer.write(raw as Uint8Array<ArrayBuffer>);
        }
        if (!stopped) await writer.close();
      } catch (err) {
        if (!stopped) {
          feedError = err;
          stopped = true;
          await reader.cancel().catch(() => {});
        }
      }
    })();
    try {
      for (;;) {
        let chunk: { done: boolean; value?: Uint8Array };
        try {
          chunk = await reader.read();
        } catch (err) {
          if (!feedError) feedError = err;
          stopped = true;
          break;
        }
        if (chunk.done || !chunk.value) break;
        const value = chunk.value;
        try {
          count(value.length);
          if (onChunk(value) === false) {
            stopped = true;
            break;
          }
        } catch (err) {
          consumerError = err;
          stopped = true;
          break;
        }
      }
    } finally {
      if (stopped) {
        await reader.cancel().catch(() => {});
        await writer.abort().catch(() => {});
      }
      await feed;
    }
    if (consumerError !== null) throw consumerError;
    if (feedError !== null) {
      if (feedError instanceof ReadFailure) throw feedError;
      throw new WorkbookError("workbook_invalid", `the zip cannot be read (${e.name} cannot be inflated)`);
    }
  }

  /** A whole (small) part, or null when the package does not have it. */
  async bytes(name: string): Promise<Uint8Array | null> {
    const e = this.find(name);
    if (!e) return null;
    const parts: Uint8Array[] = [];
    let len = 0;
    await this.stream(e, (c) => {
      parts.push(c);
      len += c.length;
    });
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

async function openPackage(read: RangeReader, size: number): Promise<Package> {
  // §5.6 step 2: signature
  const head = size >= 4 ? await read(0, Math.min(8, size)) : new Uint8Array(0);
  const u32 = (o: number) => ((head[o] << 24) | (head[o + 1] << 16) | (head[o + 2] << 8) | head[o + 3]) >>> 0;
  if (head.length >= 8 && u32(0) === 0xd0cf11e0 && u32(4) === 0xa1b11ae1) throw new WorkbookError("workbook_invalid", "the file is an encrypted workbook or a legacy .xls file (OLE compound file)");
  if (head.length < 4 || u32(0) !== 0x504b0304) throw new WorkbookError("workbook_invalid", "the file is not an .xlsx workbook (not a zip file)");
  // step 3: a readable zip without encrypted entries
  let all: ZipReadEntry[];
  try {
    all = await readZipDirectory(
      async (o, l) => {
        try {
          return await read(o, l);
        } catch (err) {
          throw new ReadFailure(err);
        }
      },
      size,
      Number.MAX_SAFE_INTEGER,
    );
  } catch (err) {
    if (err instanceof ReadFailure) throw err.cause;
    throw new WorkbookError("workbook_invalid", `the zip cannot be read (${err instanceof Error ? err.message : "broken"})`);
  }
  const entries = all.filter((e) => !e.isDir);
  for (const e of entries) {
    if (e.encrypted) throw new WorkbookError("workbook_invalid", `the zip cannot be read (${e.name} is encrypted)`);
    if (e.method !== 0 && e.method !== 8) throw new WorkbookError("workbook_invalid", `the zip cannot be read (${e.name} uses compression method ${e.method})`);
  }
  // step 4: zip bomb, from the declared sizes
  if (entries.length > XLSX_LIMITS.entries) throw new WorkbookError("workbook_too_large", `${entries.length} zip entries (limit ${XLSX_LIMITS.entries})`);
  let total = 0;
  for (const e of entries) {
    total += e.size;
    if (e.size > XLSX_LIMITS.ratioFloor && e.size > XLSX_LIMITS.ratio * Math.max(e.compressedSize, 1))
      throw new WorkbookError("workbook_too_large", `${e.name} expands from ${e.compressedSize} to ${e.size} bytes (more than ${XLSX_LIMITS.ratio} times)`);
  }
  if (total > XLSX_LIMITS.totalBytes) throw new WorkbookError("workbook_too_large", `the parts expand to ${total} bytes (limit ${XLSX_LIMITS.totalBytes})`);
  return new Package(read, entries);
}

/** §5.6 step 5: macros, ActiveX, external links, data connections (by name; never inflated). */
function checkUnsafeNames(entries: ZipReadEntry[]) {
  for (const e of entries) {
    const n = e.name.toLowerCase();
    if (n.split("/").pop() === "vbaproject.bin") throw new WorkbookError("workbook_unsafe", `the workbook contains macros (${e.name})`);
    for (const [pre, what] of [
      ["xl/macrosheets/", "macro sheets"],
      ["xl/activex/", "ActiveX controls"],
      ["xl/externallinks/", "externalLinks (links to other workbooks)"],
    ])
      if (n.startsWith(pre)) throw new WorkbookError("workbook_unsafe", `the workbook contains ${what} (${e.name})`);
    if (n === "xl/connections.xml") throw new WorkbookError("workbook_unsafe", "the workbook contains data connections (xl/connections.xml)");
  }
}

// ------------------------------------------------------------------ cells

interface RawCell {
  t: string;
  s: number;
  v: string | null;
  f: string | null;
  is: string | null;
}
type Val = { text: string; error?: undefined; reason?: undefined } | { text?: undefined; error: string; reason: string };

/** Converts one raw cell (§5.4). Throws workbook_invalid for a missing shared string or a <v> that is not a number. */
function cellValue(c: RawCell, fmt: Fmt, date1904: boolean, shared: string[]): Val {
  if (c.f !== null && c.v === null && c.t !== "inlineStr") return { error: `=${c.f}`, reason: "a formula without a saved result" };
  switch (c.t) {
    case "s": {
      if (c.v === null || c.v.trim() === "") return { text: "" };
      const i = Number(c.v);
      if (!Number.isInteger(i) || i < 0 || i >= shared.length) throw new WorkbookError("workbook_invalid", `shared string ${c.v} does not exist`);
      return { text: shared[i] };
    }
    case "inlineStr":
      return { text: c.is ?? "" };
    case "str":
      return { text: unescapeXstring(c.v ?? "") };
    case "b":
      return { text: c.v === "1" ? "true" : c.v === "0" ? "false" : "" };
    case "e":
      return { error: c.v ?? "", reason: "an error value" };
    case "d": {
      if (c.v === null || c.v === "") return { text: "" };
      const t = isoCellText(c.v);
      return t === null ? { error: c.v, reason: "a date that cannot be read" } : { text: t };
    }
    default: {
      if (c.v === null || c.v.trim() === "") return { text: "" };
      // a date cell holds a number too: not a number, or out of Excel's range, is workbook_invalid
      let t = numberText(c.v);
      if (t === null) throw new WorkbookError("workbook_invalid", `a number cell holds "${c.v.slice(0, 50)}", which is not a number Excel can store`);
      const f = fmt(c.s);
      const kind = dateKind(f.id, f.code);
      if (kind) {
        const d = serialText(c.v, kind, date1904);
        return d === null ? { error: c.v, reason: `a date outside ${date1904 ? "1904-01-01" : "1900-03-01"} to 9999-12-31` } : { text: d };
      }
      const w = zeroPad(f.code);
      if (w && /^\d+$/.test(t) && t.length < w) t = t.padStart(w, "0");
      return { text: t };
    }
  }
}

const csvField = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Turns converted, non-empty cells (in ascending row, then column order) into canonical CSV lines (§5.3, §5.5). */
/** UTF-8 output in chunks, so a large sheet never needs one big string (or a second copy of it). */
class ByteSink {
  chunks: Uint8Array[] = [];
  size = 0;
  private buf = new Uint8Array(1 << 20);
  private fill = 0;
  private enc = new TextEncoder();
  write(s: string) {
    for (;;) {
      const r = this.enc.encodeInto(s, this.buf.subarray(this.fill));
      this.fill += r.written;
      if (r.read === s.length) return;
      s = s.slice(r.read);
      this.cut(Math.max(1 << 20, s.length * 3));
    }
  }
  private cut(next: number) {
    if (this.fill) {
      this.chunks.push(this.buf.subarray(0, this.fill));
      this.size += this.fill;
    }
    this.buf = new Uint8Array(next);
    this.fill = 0;
  }
  finish(): Uint8Array[] {
    this.cut(0);
    return this.chunks;
  }
}

class Emitter {
  header: string[] | null = null;
  /** Columns 1 to W whose header name is empty after trimming. */
  private noHeader: boolean[] = [];
  width = 0;
  private out = new ByteSink();
  private lastOut = 1;
  private curRow = Number.NEGATIVE_INFINITY;
  private cur: [number, Val][] = [];
  private preCols = new Set<number>();
  private stray = new Set<number>();
  errors: WorkbookRowError[] = [];

  constructor(private file: string) {}

  cell(row: number, col: number, v: Val) {
    if (row !== this.curRow) {
      this.flush();
      this.curRow = row;
    }
    this.cur.push([col, v]);
  }

  private error(row: number, col: number, column: string, v: Val) {
    const c = column || null;
    this.errors.push({ file: this.file, row, column: c, severity: "error", obx_error: "validation_failed", detail: `${cellLocator(row, c, colLetter(col))}the cell holds ${v.reason}`, value: v.error ?? null });
  }

  private buildHeader(cells: [number, Val][]) {
    let w = 0;
    for (const [c, v] of cells) if (v.text !== undefined && v.text !== "" && c > w) w = c;
    this.width = w;
    const header: string[] = Array.from({ length: w }, () => "");
    for (const [c, v] of cells) {
      if (c > w) this.stray.add(c);
      else if (v.text !== undefined) header[c - 1] = v.text;
    }
    for (const [c, v] of cells) if (v.error !== undefined && c <= w) this.error(1, c, "", v);
    for (const c of this.preCols) if (c > w) this.stray.add(c);
    this.header = header;
    this.noHeader = header.map((h) => trimHeader(h) === "");
    this.out.write(header.map(csvField).join(",") + "\r\n");
  }

  private flush() {
    const cells = this.cur;
    if (!cells.length) return;
    this.cur = [];
    const rn = this.curRow;
    if (rn < 1) {
      for (const [c] of cells) this.preCols.add(c);
      return;
    }
    if (rn === 1) {
      this.buildHeader(cells);
      return;
    }
    if (!this.header) this.buildHeader([]);
    const w = this.width;
    let inside = 0;
    let bad = false;
    for (const [c, v] of cells) {
      if (c > w) this.stray.add(c);
      else {
        inside++;
        if (v.error !== undefined) bad = true;
      }
    }
    if (!inside) return;
    // values under an empty header name are ignored with a warning (§5.3)
    for (const [c] of cells) if (c <= w && this.noHeader[c - 1]) this.stray.add(c);
    const empty = ",".repeat(w - 1) + "\r\n";
    for (let r = this.lastOut + 1; r < rn; r++) this.out.write(empty);
    this.lastOut = rn;
    if (bad) {
      for (const [c, v] of cells) if (c <= w && v.error !== undefined) this.error(rn, c, trimHeader(this.header![c - 1]), v);
      this.out.write(empty);
      return;
    }
    const fields: string[] = Array.from({ length: w }, () => "");
    for (const [c, v] of cells) if (c <= w) fields[c - 1] = csvField(v.text!);
    this.out.write(fields.join(",") + "\r\n");
  }

  finish(): { header: string[]; csv: Uint8Array[]; csvSize: number; warnings: WorkbookRowError[] } {
    this.flush();
    if (!this.header) this.buildHeader([]);
    const warnings = [...this.stray]
      .sort((a, b) => a - b)
      .map((c): WorkbookRowError => ({ file: this.file, row: null, column: null, severity: "warning", obx_error: "validation_failed", detail: `column ${colLetter(c)}: has values but no header in row 1; ignored`, value: null }));
    const csv = this.out.finish();
    return { header: this.header!, csv, csvSize: this.out.size, warnings };
  }
}

interface Merge {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}
function parseMerges(refs: (string | undefined)[]): Merge[] {
  const out: Merge[] = [];
  for (const ref of refs) {
    const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(ref ?? "");
    if (!m || !m[3]) continue;
    const g = { c1: colNumber(m[1]), r1: Number(m[2]), c2: colNumber(m[3]), r2: Number(m[4]) };
    if (g.r1 <= g.r2 && g.c1 <= g.c2 && (g.r1 !== g.r2 || g.c1 !== g.c2)) out.push(g);
  }
  return out.sort((a, b) => a.r1 - b.r1);
}

const OUT_OF_ORDER = Symbol("out of order");

/**
 * The cells of a worksheet as XML events (mirrors the reference conversion): <row r>, <c r t s>,
 * <v>, <f>, <is> with rich text, and <mergeCell ref>. `done` gets every cell with its row and column.
 */
class SheetHandler implements XmlHandler {
  row = 0;
  col = 0;
  cell: RawCell | null = null;
  field: "v" | "f" | null = null;
  rt: RichText | null = null;
  merges: (string | undefined)[] = [];

  constructor(
    private done: (row: number, col: number, c: RawCell) => void,
    private onRow?: (row: number) => void,
  ) {}

  get wantText() {
    return this.rt ? this.rt.inT : this.field !== null && this.cell !== null;
  }

  open(l: string, _p: string, a: string[]) {
    if (l === "row") {
      const r = attrOf(a, "r");
      this.row = r ? Number(r) : this.row + 1;
      this.col = 0;
      this.onRow?.(this.row);
    } else if (l === "c") {
      const ref = attrOf(a, "r");
      const m = ref ? /^([A-Z]+)(\d+)$/.exec(ref) : null;
      this.col = m ? colNumber(m[1]) : this.col + 1;
      if (m) this.row = Number(m[2]);
      this.cell = { t: attrOf(a, "t") ?? "n", s: Number(attrOf(a, "s") ?? 0), v: null, f: null, is: null };
    } else if (this.cell && l === "v") {
      this.field = "v";
      this.cell.v = "";
    } else if (this.cell && l === "f") {
      this.field = "f";
      this.cell.f = "";
    } else if (this.cell && l === "is") this.rt = new RichText();
    else if (this.rt) this.rt.open(l);
    else if (l === "mergeCell") this.merges.push(attrOf(a, "ref"));
  }

  close(l: string) {
    if (l === "c" && this.cell) {
      const c = this.cell;
      this.cell = null;
      this.done(this.row, this.col, c);
    } else if (l === "is" && this.rt) {
      if (this.cell) this.cell.is = this.rt.take();
      this.rt = null;
    } else if (this.rt) this.rt.close(l);
    else if (l === "v" || l === "f") this.field = null;
  }

  text(t: string) {
    if (this.rt) this.rt.buf += t;
    else if (this.cell && this.field) this.cell[this.field] += t;
  }
}

interface SheetCtx {
  pkg: Package;
  entry: ZipReadEntry;
  part: string;
  fmt: Fmt;
  date1904: boolean;
  shared: string[];
  file: string;
}

/** Streams a worksheet part through a handler. */
async function streamSheet(x: SheetCtx, h: XmlHandler): Promise<void> {
  const p = new XmlParser(h);
  let stopped = false;
  try {
    await x.pkg.stream(x.entry, (chunk) => {
      try {
        p.feed(chunk);
      } catch (e) {
        if (e === STOP) {
          stopped = true;
          return false;
        }
        throw e;
      }
    });
    if (!stopped) p.end();
  } catch (e) {
    if (e === STOP) return;
    xmlFail(e, x.part);
  }
}

/** Row 1 of a sheet, converted and normalised (for the sheet choice by key column, §5.2 step 2). */
async function row1Names(x: SheetCtx): Promise<string[]> {
  const row1 = new Map<number, RawCell>();
  const h = new SheetHandler(
    (r, c, cell) => {
      if (r === 1) row1.set(c, cell);
    },
    (r) => {
      if (r > 1) throw STOP;
    },
  );
  await streamSheet(x, h);
  return [...row1.values()].map((c) => normalizeHeader(cellValue(c, x.fmt, x.date1904, x.shared).text ?? ""));
}

const tooLarge = (row: number, col: number) =>
  row > XLSX_LIMITS.maxRow
    ? new WorkbookError("workbook_too_large", `the sheet has values below row ${XLSX_LIMITS.maxRow} (cell ${colLetter(col)}${row})`)
    : col > XLSX_LIMITS.maxCol
      ? new WorkbookError("workbook_too_large", `the sheet has values right of column ${colLetter(XLSX_LIMITS.maxCol)} (cell ${colLetter(col)}${row})`)
      : null;

/**
 * One streaming pass over the chosen sheet. With `merges` null the merged ranges are not known yet
 * (they come after the cells): the pass collects them, and a fatal cell problem is kept until the end
 * (a merge may hide that cell). Throws OUT_OF_ORDER when rows or cells are not ascending.
 */
async function streamPass(x: SheetCtx, merges: Merge[] | null): Promise<{ emitter: Emitter; merges: Merge[]; fatal: WorkbookError | null }> {
  const em = new Emitter(x.file);
  let fatal: WorkbookError | null = null;
  let lastRow = Number.NEGATIVE_INFINITY;
  let lastCol = 0;
  const pending = merges ?? [];
  let next = 0;
  let active: Merge[] = [];
  let activeRow = Number.NEGATIVE_INFINITY;
  const h = new SheetHandler((row, col, c) => {
    if (!Number.isInteger(row) || row < lastRow || (row === lastRow && col <= lastCol)) throw OUT_OF_ORDER;
    lastRow = row;
    lastCol = col;
    if (fatal) return;
    if (pending.length) {
      if (row !== activeRow) {
        activeRow = row;
        while (next < pending.length && pending[next].r1 <= row) active.push(pending[next++]);
        active = active.filter((g) => g.r2 >= row);
      }
      for (const g of active) if (col >= g.c1 && col <= g.c2 && (row !== g.r1 || col !== g.c1)) return;
    }
    let v: Val;
    try {
      v = cellValue(c, x.fmt, x.date1904, x.shared);
      if (v.text === "") return;
      const big = tooLarge(row, col);
      if (big) throw big;
    } catch (e) {
      if (merges === null && e instanceof WorkbookError) {
        fatal = e;
        return;
      }
      throw e;
    }
    em.cell(row, col, v);
  });
  await streamSheet(x, h);
  return { emitter: em, merges: parseMerges(h.merges), fatal };
}

/** The reference algorithm on a sheet held in memory (only for sheets whose rows or cells are out of order). */
async function collectPass(x: SheetCtx): Promise<Emitter> {
  const rows = new Map<number, Map<number, RawCell>>();
  const h = new SheetHandler((row, col, c) => {
    let r = rows.get(row);
    if (!r) rows.set(row, (r = new Map()));
    r.set(col, c);
  });
  await streamSheet(x, h);
  for (const g of parseMerges(h.merges))
    for (let rr = g.r1; rr <= g.r2; rr++) for (let cc = g.c1; cc <= g.c2; cc++) if (rr !== g.r1 || cc !== g.c1) rows.get(rr)?.delete(cc);
  const em = new Emitter(x.file);
  for (const [rn, cells] of [...rows].sort((a, b) => a[0] - b[0])) {
    for (const [cn, c] of [...cells].sort((a, b) => a[0] - b[0])) {
      const v = cellValue(c, x.fmt, x.date1904, x.shared);
      if (v.text === "") continue;
      const big = tooLarge(rn, cn);
      if (big) throw big;
      em.cell(rn, cn, v);
    }
  }
  return em;
}

async function convertSheet(x: SheetCtx): Promise<Emitter> {
  try {
    const first = await streamPass(x, null);
    if (first.merges.length) return (await streamPass(x, first.merges)).emitter;
    if (first.fatal) throw first.fatal;
    return first.emitter;
  } catch (e) {
    if (e === OUT_OF_ORDER) return collectPass(x);
    throw e;
  }
}

// ------------------------------------------------------------------ the conversion

/**
 * Converts a workbook to the canonical CSV of products.csv or assets.csv (§5). `read` reads byte
 * ranges of the file (from storage or memory); `size` is its length. The caller has checked the size
 * against its CSV upload limit (§5.6 step 1). Throws WorkbookError for a workbook that cannot be imported.
 */
export async function convertWorkbook(read: RangeReader, size: number, role: WorkbookRole): Promise<WorkbookResult> {
  const r = WORKBOOK_ROLES[role];
  const pkg = await openPackage(read, size);
  checkUnsafeNames(pkg.entries);
  const ctBytes = await pkg.bytes("[Content_Types].xml");
  if (!ctBytes) throw new WorkbookError("workbook_invalid", "[Content_Types].xml is missing");
  const ct = parseContentTypes(ctBytes);
  for (const t of ct.all) if (/macroenabled|vbaproject/i.test(t)) throw new WorkbookError("workbook_unsafe", `the workbook is macro-enabled (${t})`);
  // step 6: structure
  const rootRels = await pkg.bytes("_rels/.rels");
  if (!rootRels) throw new WorkbookError("workbook_invalid", "_rels/.rels is missing");
  const main = parseRels(rootRels, "_rels/.rels").find((x) => x.type === REL_OFFICE_DOCUMENT && !x.external);
  if (!main) throw new WorkbookError("workbook_invalid", "the package has no main document");
  const wbPart = resolvePart("/", main.target);
  const wbType = ct.typeOf(wbPart);
  if (!wbType || !MAIN_TYPES.includes(wbType)) throw new WorkbookError("workbook_invalid", `the main document is ${wbType ?? "missing"}, not an Excel workbook`);
  const wbBytes = await pkg.bytes(wbPart);
  if (!wbBytes) throw new WorkbookError("workbook_invalid", `${wbPart} is missing`);
  const wb = parseWorkbook(wbBytes, wbPart);
  const relsBytes = await pkg.bytes(relsOf(wbPart));
  const rels = relsBytes ? parseRels(relsBytes, relsOf(wbPart)) : [];
  // step 7: external relationships of the workbook
  const ext = rels.find((x) => x.external);
  if (ext) throw new WorkbookError("workbook_unsafe", `the workbook refers to an external resource (${(ext.type ?? "").split("/").pop()})`);
  const relById = new Map(rels.map((x) => [x.id, x]));
  const stylesRel = rels.find((x) => x.type === REL_STYLES);
  const ssRel = rels.find((x) => x.type === REL_SHARED_STRINGS);
  const fmt = parseStyles(stylesRel ? await pkg.bytes(resolvePart(wbPart, stylesRel.target)) : null);
  const shared = parseSharedStrings(ssRel ? await pkg.bytes(resolvePart(wbPart, ssRel.target)) : null);

  // step 8: the sheet
  const visible: { name: string; part: string }[] = [];
  for (const s of wb.sheets) {
    const rel = relById.get(s.rid);
    if (s.state !== "visible" || !rel || rel.type !== REL_WORKSHEET) continue;
    visible.push({ name: s.name, part: resolvePart(wbPart, rel.target) });
  }
  const ctxOf = (s: { part: string }): SheetCtx => {
    const entry = pkg.find(s.part);
    if (!entry) throw new WorkbookError("workbook_invalid", `${s.part} is missing`);
    return { pkg, entry, part: s.part, fmt, date1904: wb.date1904, shared, file: r.file };
  };
  let chosen = visible.find((s) => s.name.trim().toLowerCase() === r.sheet);
  if (!chosen)
    for (const s of visible) {
      const names = await row1Names(ctxOf(s));
      if (names.some((n) => r.keys.includes(n))) {
        chosen = s;
        break;
      }
    }
  if (!chosen) throw new WorkbookError("workbook_sheet_missing", `no visible sheet is named ${role === "products" ? "Products" : "Assets"} or has a ${r.keys[0]} column in row 1`);

  // steps 9 and 10: cells and conversion
  const em = await convertSheet(ctxOf(chosen));
  const errors = em.errors;
  const out = em.finish();
  return { sheet: chosen.name, header: out.header, csv: out.csv, csvSize: out.csvSize, errors, warnings: out.warnings };
}

/** The canonical CSV as one byte array. */
export function csvBytes(r: WorkbookResult): Uint8Array {
  if (r.csv.length === 1) return r.csv[0];
  const out = new Uint8Array(r.csvSize);
  let o = 0;
  for (const c of r.csv) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** The canonical CSV as text. */
export const csvText = (r: WorkbookResult) => new TextDecoder().decode(csvBytes(r));

/** A RangeReader over bytes in memory. */
export function memoryReader(b: Uint8Array): RangeReader {
  return async (offset, length) => b.subarray(offset, Math.min(b.length, offset + length));
}

// ------------------------------------------------------------------ Excel row numbers in the CSV import's errors (§5.5)

const ALIASES = [
  ["style_number", "style"],
  ["gtin", "ean", "barcode"],
  ["color_code", "colour_code"],
  ["color_name", "colour_name"],
  ["color_family", "colour_family"],
];

/**
 * Rewrites an ImportRowError of the CSV import of converted rows for the workbook: the row becomes
 * Excel's (CSV data row + 1) and the detail starts with the locator of §5.5.
 */
export function excelRowError<E extends { row: number | null; column: string | null; detail: string }>(e: E, header: string[], norm: (h: string) => string): E {
  const row = e.row === null ? null : e.row + 1;
  let idx = -1;
  if (e.column !== null) {
    const c = e.column.trim();
    idx = header.findIndex((h) => trimHeader(h) === c);
    if (idx < 0) {
      const n = norm(c);
      idx = header.findIndex((h) => norm(h) === n);
      if (idx < 0) {
        const alias = ALIASES.find((g) => g.includes(n.split(":")[0]));
        const want = alias ? alias : [n];
        idx = header.findIndex((h) => want.includes(norm(h).split(":")[0]) && (alias || !n.includes(":")));
      }
    }
  }
  const head = idx >= 0 ? trimHeader(header[idx]) : "";
  const letter = idx >= 0 ? colLetter(idx + 1) : "";
  let prefix = "";
  if (row !== null && idx >= 0) prefix = cellLocator(row, head, letter);
  else if (row !== null) prefix = `row ${row}: `;
  else if (idx >= 0) prefix = head ? `column ${head} (${letter}): ` : `column ${letter}: `;
  return { ...e, row, detail: prefix + e.detail };
}
