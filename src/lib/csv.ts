// RFC 4180 CSV with delimiter detection (import-format.md §1.1) and formula-safe writing (security.md §6).

export interface ParsedCsv {
  delimiter: string;
  header: string[];
  /** Data rows with their 1-based row number (header = row 0, empty rows skipped). */
  rows: { row: number; cells: string[] }[];
}

/** Picks "," or ";" (or tab) by counting occurrences outside quotes in the header line; tie → ",". */
export function detectDelimiter(text: string): string {
  let inQ = false;
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQ = !inQ;
    else if (!inQ && (ch === "\n" || ch === "\r")) break;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  if (counts[";"] > counts[","] && counts[";"] >= counts["\t"]) return ";";
  if (counts["\t"] > counts[","] && counts["\t"] > counts[";"]) return "\t";
  return ",";
}

/** `delimiter` skips the detection (the canonical CSV of a converted workbook is always ","). */
export function parseCsv(input: string, delimiter?: string): ParsedCsv {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  delimiter ??= detectDelimiter(text);
  const records: string[][] = [];
  let field = "";
  let rec: string[] = [];
  let inQ = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQ = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field.trim() === "") {
      field = "";
      inQ = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      rec.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      rec.push(field);
      records.push(rec);
      rec = [];
      field = "";
      if (ch === "\r" && text[i + 1] === "\n") i++;
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || rec.length) {
    rec.push(field);
    records.push(rec);
  }
  const header = (records.shift() ?? []).map((h) => h.trim());
  const rows: ParsedCsv["rows"] = [];
  records.forEach((cells, idx) => {
    const trimmed = cells.map((c) => c.trim());
    if (trimmed.every((c) => c === "")) return;
    rows.push({ row: idx + 1, cells: trimmed });
  });
  return { delimiter, header, rows };
}

/** Header normalisation: case-insensitive, trimmed, spaces and "-" count as "_" (language suffix kept). */
export function normHeader(h: string): string {
  const [base, ...rest] = h.trim().split(":");
  const b = base.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!rest.length) return b;
  return `${b}:${rest.join(":").trim()}`;
}

function escapeFormula(v: string): string {
  if (v === "") return v;
  if (/^[+-]?\d+(\.\d+)?$/.test(v)) return v;
  if (/^[=+\-@\t\r]/.test(v)) return "'" + v;
  return v;
}

export function csvCell(v: unknown, delimiter: string): string {
  let s = v === null || v === undefined ? "" : String(v);
  s = escapeFormula(s);
  if (s.includes(delimiter) || s.includes('"') || s.includes("\n") || s.includes("\r")) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function writeCsv(rows: unknown[][], delimiter = ",", bom = true): string {
  const body = rows.map((r) => r.map((c) => csvCell(c, delimiter)).join(delimiter)).join("\r\n") + "\r\n";
  return (bom ? "﻿" : "") + body;
}
