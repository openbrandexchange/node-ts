// Excel import (spec import-format.md §5): the conversion against fixtures/imports/xlsx/expected.json
// (I-IMP-9, I-IMP-10), the number/date/format vectors, and the XML tokenizer's refusals.
import { describe, expect, test } from "bun:test";
import { fixtureBytes, fixtureText } from "./helpers";
import { convertWorkbook, csvText, dateKind, memoryReader, numberText, serialText, WorkbookError, XLSX_LIMITS, zeroPad, type WorkbookRole } from "../src/lib/xlsx";
import { XmlError, XmlParser, type XmlHandler } from "../src/lib/xml";
import { zipBytes } from "../src/lib/zip";
import { crc32 } from "../src/lib/crypto";

const expected = JSON.parse(fixtureText("imports/xlsx/expected.json"));

async function convert(bytes: Uint8Array, role: WorkbookRole) {
  return convertWorkbook(memoryReader(bytes), bytes.length, role);
}

/** Parses canonical CSV (§5.3) back into rows. */
function csvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (q) {
      if (c === '"' && csv[i + 1] === '"') {
        f += '"';
        i++;
      } else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(f);
      f = "";
    } else if (c === "\r" && csv[i + 1] === "\n") {
      row.push(f);
      rows.push(row);
      row = [];
      f = "";
      i++;
    } else f += c;
  }
  return rows;
}

const prefixOf = (d: string) => (d.indexOf("): ") >= 0 ? d.slice(0, d.indexOf("): ") + 3) : d.slice(0, d.indexOf(": ") + 2));
const strip = (e: { detail: string }) => {
  const { detail, ...rest } = e as Record<string, unknown> & { detail: string };
  void detail;
  return rest;
};

describe("xlsx conversion: fixtures/imports/xlsx/expected.json", () => {
  test("limits are the spec's", () => {
    expect(XLSX_LIMITS).toEqual(expected.limits);
  });
  for (const c of expected.cases) {
    test(`${c.file} (${c.role})`, async () => {
      const bytes = fixtureBytes(`imports/xlsx/${c.file}`);
      if (c.error) {
        let err: unknown = null;
        try {
          await convert(bytes, c.role);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(WorkbookError);
        expect((err as WorkbookError).code).toBe(c.error.obx_error);
        expect((err as WorkbookError).detail).toContain(c.error.detail_contains);
        return;
      }
      const out = await convert(bytes, c.role);
      expect(out.sheet).toBe(c.sheet);
      if (c.csv_file) expect(csvText(out)).toBe(fixtureText(c.csv_file.replace(/^fixtures\//, "")));
      if (c.csv !== undefined) expect(csvText(out)).toBe(c.csv);
      if (c.rows) expect(csvRows(csvText(out))).toEqual(c.rows);
      const pick = (list: { detail: string }[]) => list.map((e) => ({ ...strip(e), detail_prefix: prefixOf(e.detail) }));
      expect(pick(out.errors)).toEqual(c.errors);
      expect(pick(out.warnings)).toEqual(c.warnings);
      for (const [i, e] of out.errors.entries()) expect(e.detail.startsWith(c.errors[i].detail_prefix)).toBe(true);
    });
  }
});

describe("xlsx cell values (§5.4 vectors)", () => {
  test("numbers", () => {
    for (const v of expected.number_vectors) {
      // text null: not a number, or out of Excel's range (workbook_invalid)
      let t = numberText(v.v);
      const w = zeroPad(v.format === "General" ? undefined : v.format);
      if (t !== null && w && /^\d+$/.test(t) && t.length < w) t = t.padStart(w, "0");
      expect({ v: v.v, format: v.format, text: t }).toEqual(v);
    }
    expect(numberText("abc")).toBeNull();
    expect(numberText("")).toBeNull();
    expect(numberText(".")).toBeNull();
    // huge exponents are refused without building the number
    expect(numberText(`1E+${"9".repeat(12)}`)).toBeNull();
    expect(numberText(`-0.000E-${"9".repeat(12)}`)).toBe("0");
  });
  test("dates", () => {
    for (const v of expected.date_vectors) expect({ ...v, text: serialText(v.v, v.kind, v.date1904) }).toEqual(v);
  });
  test("formats", () => {
    for (const v of expected.format_vectors) expect({ ...v, kind: dateKind(v.id, v.id >= 164 ? v.code : undefined) }).toEqual(v);
  });
});

// ------------------------------------------------------------------ hand-made workbooks

const enc = (s: string) => new TextEncoder().encode(s);
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function workbookFiles(sheetXml: string, opts: { styles?: string; shared?: string[]; extra?: Record<string, string> } = {}) {
  const files: Record<string, string> = {
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": `<?xml version="1.0"?><workbook ${NS}><sheets><sheet name="Products" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>${opts.styles ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' : ""}${opts.shared ? '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' : ""}</Relationships>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet ${NS}>${sheetXml}</worksheet>`,
  };
  if (opts.styles) files["xl/styles.xml"] = `<styleSheet ${NS}>${opts.styles}</styleSheet>`;
  if (opts.shared) files["xl/sharedStrings.xml"] = `<sst ${NS}>${opts.shared.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`;
  Object.assign(files, opts.extra ?? {});
  return files;
}

async function workbook(sheetXml: string, opts: Parameters<typeof workbookFiles>[1] = {}) {
  const files = workbookFiles(sheetXml, opts);
  return zipBytes(
    Object.entries(files).map(([name, data]) => ({ name, data: enc(data) })),
    crc32,
  );
}

const is = (ref: string, s: string) => `<c r="${ref}" t="inlineStr"><is><t>${s}</t></is></c>`;

describe("xlsx conversion: rules", () => {
  test("rows out of order are read like the reference (sorted), merges hide cells, trailing empty rows go", async () => {
    const sheet = `<sheetData><row r="3">${is("A3", "B")}<c r="B3"><v>2</v></c></row><row r="1">${is("A1", "style_number")}${is("B1", "size")}</row><row r="2">${is("A2", "A")}${is("B2", "x")}</row><row r="9"><c r="A9" s="0"/></row></sheetData><mergeCells><mergeCell ref="B2:B3"/></mergeCells>`;
    const out = await convert(await workbook(sheet), "products");
    expect(csvText(out)).toBe("style_number,size\r\nA,x\r\nB,\r\n");
  });

  test("a merged range in order and an error cell hidden by it", async () => {
    const sheet = `<sheetData><row r="1">${is("A1", "style")}${is("B1", "weight_kg")}</row><row r="2">${is("A2", "A")}<c r="B2"><v>1.50</v></c></row><row r="3">${is("A3", "B")}<c r="B3" t="e"><v>#N/A</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="B2:B3"/></mergeCells>`;
    const out = await convert(await workbook(sheet), "products");
    expect(csvText(out)).toBe("style,weight_kg\r\nA,1.5\r\nB,\r\n");
    expect(out.errors).toEqual([]);
  });

  test("a value right of column ALL or below row 100 001 is too large, unless a merge hides it", async () => {
    const right = `<sheetData><row r="1">${is("A1", "style")}${is("ALM1", "x")}</row></sheetData>`;
    await expect(convert(await workbook(right), "products")).rejects.toMatchObject({ code: "workbook_too_large" });
    const hidden = `<sheetData><row r="1">${is("A1", "style")}</row><row r="100002">${is("A100002", "")}<c r="B100002"><v>1</v></c></row></sheetData><mergeCells><mergeCell ref="A100002:B100002"/></mergeCells>`;
    expect(csvText(await convert(await workbook(hidden), "products"))).toBe("style\r\n");
  });

  test("shared strings, rich text, phonetic runs, escapes, booleans, inline strings, dates and zero padding", async () => {
    const styles = '<numFmts count="2"><numFmt numFmtId="164" formatCode="00000000000000"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="14"/></cellXfs>';
    const sst = `<sst ${NS}><si><t>style_number</t></si><si><r><t>Ri</t></r><r><rPr><b/></rPr><t xml:space="preserve">ch &amp; </t></r><rPh><t>PH</t></rPh><r><t>text</t></r></si><si><t>a_x000D__x000A_b_x005F_x0031_</t></si></sst>`;
    const sheet = `<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c>${is("B1", "gtin")}${is("C1", "attr:x")}${is("D1", "attr:y")}${is("E1", "attr:z")}${is("F1", "attr:w")}</row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" s="1"><v>2000901000022</v></c><c r="C2" t="s"><v>2</v></c><c r="D2" t="b"><v>1</v></c><c r="E2" s="2"><v>46082.5</v></c><c r="F2" s="3"><v>46082</v></c></row></sheetData>`;
    const files = workbookFiles(sheet, { styles, shared: [] });
    files["xl/sharedStrings.xml"] = sst;
    const bytes = await zipBytes(Object.entries(files).map(([name, data]) => ({ name, data: enc(data) })), crc32);
    const out = await convert(bytes, "products");
    expect(csvRows(csvText(out))).toEqual([
      ["style_number", "gtin", "attr:x", "attr:y", "attr:z", "attr:w"],
      ["Rich & text", "02000901000022", "a\r\nb_x0031_", "true", "2026-03-01T12:00:00Z", "2026-03-01"],
    ]);
  });

  test("a missing shared string and a number that is not a number are workbook_invalid", async () => {
    const a = `<sheetData><row r="1">${is("A1", "style")}</row><row r="2"><c r="A2" t="s"><v>7</v></c></row></sheetData>`;
    await expect(convert(await workbook(a, { shared: ["x"] }), "products")).rejects.toMatchObject({ code: "workbook_invalid" });
    const b = `<sheetData><row r="1">${is("A1", "style")}</row><row r="2"><c r="A2"><v>12,5</v></c></row></sheetData>`;
    await expect(convert(await workbook(b), "products")).rejects.toMatchObject({ code: "workbook_invalid" });
  });

  test("row 1 conversion error, empty header names and the header width", async () => {
    const sheet = `<sheetData><row r="1">${is("A1", "style")}<c r="B1" t="e"><v>#REF!</v></c>${is("C1", "size")}<c r="D1" t="e"><v>#N/A</v></c>${is("E1", " ")}${is("F1", "x")}</row><row r="2">${is("A2", "A")}${is("B2", "b")}${is("C2", "M")}${is("D2", "d")}</row><row r="3">${is("A3", "B")}<c r="E3" t="e"><v>#N/A</v></c></row></sheetData>`;
    const out = await convert(await workbook(sheet), "products");
    expect(csvText(out)).toBe("style,,size,, ,x\r\nA,b,M,d,,\r\n,,,,,\r\n");
    expect(out.errors.map((e) => [e.row, e.column, e.value, e.detail.slice(0, 17)])).toEqual([
      [1, null, "#REF!", "row 1, column B: "],
      [1, null, "#N/A", "row 1, column D: "],
      [3, null, "#N/A", "row 3, column E: "],
    ]);
    // columns without a header name that hold values (B, D) or an error (E, " " trims to empty)
    expect(out.warnings.map((w) => w.detail)).toEqual(["B", "D", "E"].map((l) => `column ${l}: has values but no header in row 1; ignored`));
  });

  test("no row 1: an empty file, every value is right of the header", async () => {
    const sheet = `<sheetData><row r="2">${is("A2", "x")}</row></sheetData>`;
    const files = workbookFiles(sheet);
    files["xl/workbook.xml"] = files["xl/workbook.xml"].replace('name="Products"', 'name="Products "');
    const out = await convert(await zipBytes(Object.entries(files).map(([name, data]) => ({ name, data: enc(data) })), crc32), "products");
    expect(csvText(out)).toBe("\r\n");
    expect(out.warnings.length).toBe(1);
  });

  test("hidden sheets are never read; the key column chooses a visible sheet; assets look for file", async () => {
    const files = workbookFiles(`<sheetData><row r="1">${is("A1", "File")}</row><row r="2">${is("A2", "a.jpg")}</row></sheetData>`);
    files["xl/workbook.xml"] = `<workbook ${NS}><sheets><sheet name="Assets" state="hidden" sheetId="2" r:id="rId1"/><sheet name="Images" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    const bytes = await zipBytes(Object.entries(files).map(([name, data]) => ({ name, data: enc(data) })), crc32);
    expect((await convert(bytes, "assets")).sheet).toBe("Images");
    await expect(convert(bytes, "products")).rejects.toMatchObject({ code: "workbook_sheet_missing" });
  });

  test("unsafe and invalid packages", async () => {
    const extra = async (name: string, data = "x") => workbook(`<sheetData/>`, { extra: { [name]: data } });
    await expect(convert(await extra("xl/activeX/activeX1.xml"), "products")).rejects.toMatchObject({ code: "workbook_unsafe" });
    await expect(convert(await extra("xl/connections.xml"), "products")).rejects.toMatchObject({ code: "workbook_unsafe" });
    await expect(convert(await extra("xl/macrosheets/sheet1.xml"), "products")).rejects.toMatchObject({ code: "workbook_unsafe" });
    const ext = workbookFiles(`<sheetData/>`);
    ext["xl/_rels/workbook.xml.rels"] = ext["xl/_rels/workbook.xml.rels"].replace("</Relationships>", '<Relationship Id="rId9" Type="http://x/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>');
    await expect(convert(await zipBytes(Object.entries(ext).map(([name, data]) => ({ name, data: enc(data) })), crc32), "products")).rejects.toMatchObject({ code: "workbook_unsafe" });
    const strict = workbookFiles(`<sheetData/>`);
    strict["xl/workbook.xml"] = '<workbook xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main"/>';
    await expect(convert(await zipBytes(Object.entries(strict).map(([name, data]) => ({ name, data: enc(data) })), crc32), "products")).rejects.toMatchObject({ code: "workbook_invalid", detail: expect.stringContaining("Strict") });
    const broken = await workbook(`<sheetData><row r="1">${is("A1", "style")}</row></sheetData`);
    await expect(convert(broken, "products")).rejects.toMatchObject({ code: "workbook_invalid" });
    const noCt = workbookFiles(`<sheetData/>`);
    delete (noCt as Record<string, string>)["[Content_Types].xml"];
    await expect(convert(await zipBytes(Object.entries(noCt).map(([name, data]) => ({ name, data: enc(data) })), crc32), "products")).rejects.toMatchObject({ code: "workbook_invalid" });
    await expect(convert(enc("style_number,name\r\nA,B\r\n"), "products")).rejects.toMatchObject({ code: "workbook_invalid" });
  });

  test("an entry that inflates beyond its declared size is too large", async () => {
    const bytes = await workbook(`<sheetData><row r="1">${is("A1", "style")}</row></sheetData>`);
    // Lower the declared size of the sheet in the central directory.
    const copy = bytes.slice();
    const dv = new DataView(copy.buffer);
    for (let i = copy.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) !== 0x02014b50) continue;
      const nameLen = dv.getUint16(i + 28, true);
      const name = new TextDecoder().decode(copy.subarray(i + 46, i + 46 + nameLen));
      if (name === "xl/worksheets/sheet1.xml") dv.setUint32(i + 24, 10, true);
    }
    await expect(convert(copy, "products")).rejects.toMatchObject({ code: "workbook_too_large", detail: expect.stringContaining("sheet1.xml") });
  });
});

describe("xml tokenizer", () => {
  const run = (xml: string, chunk = 3) => {
    const seen: string[] = [];
    const h: XmlHandler = { open: (l) => seen.push(`<${l}`), close: (l) => seen.push(`>${l}`), text: (t) => seen.push(JSON.stringify(t)), wantText: true };
    const p = new XmlParser(h);
    const b = enc(xml);
    for (let i = 0; i < b.length; i += chunk) p.feed(b.subarray(i, i + chunk));
    p.end();
    return seen.join(" ");
  };
  test("chunk boundaries, entities, CDATA, comments, line endings, multi-byte text", () => {
    const xml = '﻿<?xml version="1.0"?><!-- c --><a x="1&#10;2"><b>&lt;é&#x20AC;&amp;</b><![CDATA[x<y]]>p\r\nq<c/></a>';
    for (const n of [1, 2, 5, 64]) expect(run(xml, n)).toBe('<a <b "<é€&" >b "x<y" "p\\nq" <c >c >a');
  });
  for (const [what, xml] of [
    ["DOCTYPE", '<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'],
    ["unknown entity", "<a>&x;</a>"],
    ["mismatched tags", "<a><b></a></b>"],
    ["two roots", "<a/><b/>"],
    ["text outside the root", "<a/>x"],
    ["unclosed", "<a><b>"],
    ["unbound prefix", "<x:a/>"],
    ["duplicate attribute", '<a b="1" b="2"/>'],
    ["unquoted attribute", "<a b=1/>"],
    ["bare ampersand", "<a>&</a>"],
  ])
    test(`refuses: ${what}`, () => {
      expect(() => run(xml)).toThrow(XmlError);
    });
});

// ------------------------------------------------------------------ the import (Ingest API, admin, packages)

import { TestNode, formData, importKestrel, kestrelImages } from "./helpers";
import { sha256Hex } from "../src/lib/crypto";

async function kestrelNode(withData = true) {
  const node = new TestNode();
  const admin = await node.setup();
  const token = await node.ingestToken(admin);
  const cl = await node.retailerClient(admin);
  const at = await node.accessToken(cl.clientId, cl.secret);
  if (withData) {
    const job = await importKestrel(node, token);
    if (job.status !== "succeeded" || job.import_run.counts.errors) throw new Error("kestrel import failed");
  }
  return { node, admin, token, at };
}

type Part = { name: string; filename?: string; type?: string; data: Uint8Array | string };
async function runImport(node: TestNode, token: string, parts: Part[], options?: Record<string, unknown>) {
  const f = formData([...parts, ...(options ? [{ name: "options", type: "application/json", data: JSON.stringify(options) }] : [])]);
  const r = await node.api(token, "POST", "/obx/v1/ingest/imports", { body: f.body, headers: { "content-type": f.contentType } });
  if (r.status !== 202) return { status: r.status, body: r.json, job: null as any, rows: [] as any[] };
  await node.drain();
  const job = (await node.api(token, "GET", `/obx/v1/ingest/jobs/${r.json.id}`)).json;
  const rows: any[] = [];
  let cursor = "";
  for (;;) {
    const p = (await node.api(token, "GET", `/obx/v1/ingest/jobs/${r.json.id}/results?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json;
    rows.push(...p.items);
    if (!p.next_cursor) break;
    cursor = p.next_cursor;
  }
  return { status: r.status, body: r.json, job, rows };
}

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const book = (file: string, filename = "products.xlsx", name = "csv"): Part => ({ name, filename, type: XLSX_TYPE, data: fixtureBytes(`imports/xlsx/${file}`) });

/** The parts a case of expected.json is sent with (§5 fixtures: send.images_manifest names Kestrel images). */
async function caseParts(c: any): Promise<Part[]> {
  const parts = [c.role === "assets" ? book(c.file, "assets.xlsx", "assets_csv") : book(c.file)];
  if (c.send?.images_manifest) {
    const manifest = [];
    for (const f of c.send.images_manifest) manifest.push({ file: f, sha256: await sha256Hex(fixtureBytes(`kestrel/images/${f}`)) });
    parts.push({ name: "images_manifest", type: "application/json", data: JSON.stringify(manifest) });
  }
  return parts;
}

/** Catalog content without volatile fields (timestamps, versions), for comparing two nodes. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!/(_at|^etag|^version|^cursor|^seq|^_phase|^id|^brand_id|^product_id)$/.test(k)) out[k] = stable(x);
    return out;
  }
  return v;
}

describe("xlsx import end to end", () => {
  test("products-template.xlsx imports exactly like fixtures/kestrel/products.csv (fresh nodes, same objects)", async () => {
    const a = await kestrelNode(false);
    const b = await kestrelNode(false);
    const ra = await runImport(a.node, a.token, [{ name: "csv", filename: "products.csv", type: "text/csv", data: fixtureText("kestrel/products.csv") }]);
    const rb = await runImport(b.node, b.token, [book("products-template.xlsx")]);
    expect(rb.job.status).toBe("succeeded");
    expect(rb.job.import_run.counts).toEqual(ra.job.import_run.counts);
    expect(rb.rows.filter((e) => e.severity === "error")).toEqual([]);
    // Warnings: the same as the CSV's, with Excel row numbers and the locator.
    const wa = ra.rows.filter((e) => e.severity === "warning");
    const wb = rb.rows.filter((e) => e.severity === "warning");
    expect(wb.map((e) => [e.file, e.row, e.column, e.obx_error])).toEqual(wa.map((e) => ["products.xlsx", e.row === null ? null : e.row + 1, e.column, e.obx_error]));
    const fa = (await a.node.feed(a.at)).entries;
    const fb = (await b.node.feed(b.at)).entries;
    const key = (e: any) => `${e.type}|${e.external_id}`;
    const sorted = (l: any[]) => [...l].sort((x, y) => key(x).localeCompare(key(y)));
    expect(stable(sorted(fb))).toEqual(stable(sorted(fa)));
    expect(fb.some((e) => e.type === "product")).toBe(true);
  });

  test("on a node that holds the fixtures it is all unchanged with no change entries (I-IMP-9); assets-template.xlsx too", async () => {
    const { node, token, at } = await kestrelNode();
    const before = await node.feed(at);
    const assets = expected.cases.find((x: any) => x.file === "assets-template.xlsx");
    const r = await runImport(node, token, [book("products-template.xlsx"), ...(await caseParts(assets))]);
    expect(r.job.status).toBe("succeeded");
    const c = r.job.import_run.counts;
    expect({ created: c.created, updated: c.updated, errors: c.errors }).toEqual({ created: 0, updated: 0, errors: 0 });
    expect(c.unchanged).toBeGreaterThan(50);
    expect(c.rows).toBe(46);
    expect((await node.feed(at, before.cursor)).entries).toEqual([]);
    expect(r.job.import_run.files.map((f: any) => f.name)).toEqual(["products.xlsx", "assets.xlsx", ...assets.send.images_manifest]);
  });

  for (const c of expected.cases.filter((x: any) => !x.error))
  test(`${c.file} (dry run, I-IMP-9): exactly import_errors of expected.json, its warnings, nothing written`, async () => {
    const { node, token, at } = await kestrelNode();
    const before = await node.feed(at);
    const parts = await caseParts(c);
    if (c.file === "edge-cases.xlsx") parts[0].filename = "Edge Cases.XLSX";
    const r = await runImport(node, token, parts, { dry_run: true });
    expect(r.job.status).toBe("succeeded");
    const errs = r.rows
      .filter((e) => e.severity === "error")
      .sort((x, y) => x.row - y.row || String(x.column).localeCompare(String(y.column)))
      .map((e) => ({ ...strip(e), detail_prefix: e.detail.slice(0, prefixOf(e.detail).length) }));
    expect(errs).toEqual(c.import_errors);
    for (const e of r.rows.filter((x) => x.severity === "error")) expect(c.import_errors.some((x: any) => e.detail.startsWith(x.detail_prefix))).toBe(true);
    for (const w of c.warnings) expect(r.rows.some((e) => e.severity === "warning" && e.row === null && e.detail.startsWith(w.detail_prefix))).toBe(true);
    // an empty header name is no column: no unknown-column warning from the CSV import (§1.1)
    expect(r.rows.filter((e) => /Unknown column/.test(e.detail))).toEqual([]);
    // every warning about a cell of the workbook carries the locator
    for (const e of r.rows.filter((x) => x.file === "products.xlsx" && x.row !== null)) expect(e.detail).toMatch(/^row \d+(, column (.* \([A-Z]+\)|[A-Z]+))?: /);
    expect((await node.feed(at, before.cursor)).entries).toEqual([]);
  });

  test("an xlsx-imported product appears in /obx/v1/changes", async () => {
    const { node, token, at } = await kestrelNode();
    const before = await node.feed(at);
    const r = await runImport(node, token, [book("edge-cases.xlsx")]);
    expect(r.job.status).toBe("succeeded");
    expect(r.job.import_run.counts.created).toBeGreaterThan(0);
    const changes = (await node.feed(at, before.cursor)).entries;
    const p = changes.find((e) => e.type === "product" && e.external_id === "KX-9001");
    expect(p).toBeTruthy();
    const v = changes.filter((e) => e.type === "variant").map((e) => e.data?.gtin_original ?? e.external_id);
    expect(v).toEqual(expect.arrayContaining(["2000901000015", "02000901000022"]));
    const prod = (await node.api(token, "GET", "/obx/v1/ingest/products/KX-9001")).json.data;
    expect(prod.description.en).toBe("=SUM(1,2) is text, not a formula");
  });

  for (const c of expected.cases.filter((x: any) => x.error))
    test(`refusal ${c.file}: the run fails with ${c.error.obx_error} and one ImportRowError, nothing written (I-IMP-10)`, async () => {
      const { node, admin, token, at } = await kestrelNode();
      const before = await node.feed(at);
      // with images, which must not be written either
      const img = kestrelImages()[0];
      for (const dry_run of [false, true]) {
        const r = await runImport(node, token, [book(c.file), { name: "images", filename: img.name, type: "image/png", data: img.bytes }], { dry_run });
        expect(r.job.status).toBe("failed");
        expect(r.job.import_run.error.obx_error).toBe(c.error.obx_error);
        expect(r.job.import_run.error.status).toBe(422);
        const { detail_contains: _hint, ...want } = c.error;
        expect(r.rows.map(strip)).toEqual([{ ...want, value: null }]);
        expect(r.rows[0].detail).toContain(c.error.detail_contains);
        const run = (await admin.req("GET", `/admin/api/imports/${r.job.id}`)).json;
        expect(run.errors_preview.map(strip)).toEqual([{ ...want, value: null }]);
        const n = r.job.import_run.counts;
        expect([n.errors, n.created, n.updated, n.unchanged]).toEqual([1, 0, 0, 0]);
      }
      expect((await node.feed(at, before.cursor)).entries).toEqual([]);
    });

  test("a workbook above the CSV limit: the run fails with payload_too_large and one ImportRowError (§5.6 step 1)", async () => {
    const { node, token } = await kestrelNode(false);
    const big = new Uint8Array(64 * 1048576 + 1);
    big.set(fixtureBytes("imports/xlsx/products-template.xlsx"));
    const r = await runImport(node, token, [{ name: "csv", filename: "products.xlsx", type: XLSX_TYPE, data: big }], { dry_run: true });
    expect(r.job.status).toBe("failed");
    expect(r.job.import_run.error.obx_error).toBe("payload_too_large");
    expect(r.rows.map((e) => [e.file, e.row, e.column, e.severity, e.obx_error])).toEqual([["products.xlsx", null, null, "error", "payload_too_large"]]);
  });

  test("an assets row whose image is neither sent nor in the manifest is files_missing (§2.2)", async () => {
    const { node, token } = await kestrelNode();
    const r = await runImport(node, token, [book("products-template.xlsx"), book("assets-template.xlsx", "assets.xlsx", "assets_csv")], { dry_run: true });
    expect(r.job.status).toBe("succeeded");
    expect(r.rows.filter((e) => e.severity === "error").map((e) => [e.file, e.row, e.column, e.obx_error, e.value, e.detail.slice(0, 24)])).toEqual([
      ["assets.xlsx", 2, "file", "files_missing", "KO-1002_BLK_2_back.png", "row 2, column file (A): "],
      ["assets.xlsx", 3, "file", "files_missing", "KO-1003_RST_3_model.png", "row 3, column file (A): "],
    ]);
  });

  test("a package with products.xlsx is imported; with products.csv as well it is import_invalid; .xlsm is 415", async () => {
    const { node, token, at } = await kestrelNode(false);
    const zip = async (files: { name: string; data: Uint8Array }[]) => zipBytes(files, crc32);
    const pkg = await zip([{ name: "export/products.xlsx", data: fixtureBytes("imports/xlsx/products-template.xlsx") }]);
    const r = await runImport(node, token, [{ name: "package", filename: "kestrel.zip", type: "application/zip", data: pkg }]);
    expect(r.job.status).toBe("succeeded");
    expect(r.job.import_run.counts.errors).toBe(0);
    expect(r.job.import_run.counts.rows).toBe(46);
    expect((await node.feed(at)).entries.some((e) => e.type === "product" && e.external_id === "KO-1001")).toBe(true);
    const both = await zip([
      { name: "products.xlsx", data: fixtureBytes("imports/xlsx/products-template.xlsx") },
      { name: "products.csv", data: enc(fixtureText("kestrel/products.csv")) },
    ]);
    const r2 = await runImport(node, token, [{ name: "package", filename: "both.zip", type: "application/zip", data: both }]);
    expect(r2.job.status).toBe("failed");
    expect(r2.job.import_run.error.obx_error).toBe("import_invalid");
    const r3 = await runImport(node, token, [{ name: "csv", filename: "products.xlsm", data: fixtureBytes("imports/xlsx/macro-enabled.xlsx") }]);
    expect(r3.status).toBe(415);
    expect(r3.body.obx_error).toBe("unsupported_media_type");
    // A part without a file name is a workbook by its content type; a CSV renamed to .xlsx is not read as CSV.
    const r4 = await runImport(node, token, [{ name: "csv", type: XLSX_TYPE, data: fixtureBytes("imports/xlsx/products-template.xlsx") }], { dry_run: true });
    expect(r4.job.import_run.counts.errors).toBe(0);
    expect(r4.job.import_run.counts.rows).toBe(46);
    const r5 = await runImport(node, token, [{ name: "csv", filename: "products.xlsx", data: fixtureText("kestrel/products.csv") }], { dry_run: true });
    expect(r5.job.status).toBe("failed");
    expect(r5.rows.map((e) => e.obx_error)).toEqual(["workbook_invalid"]);
  });

  test("the admin upload takes a workbook too", async () => {
    const { node, admin } = await kestrelNode(false);
    const f = formData([book("products-template.xlsx", "Producten export.xlsx")]);
    const r = await admin.req("POST", "/admin/api/imports", { body: f.body, headers: { "content-type": f.contentType } });
    expect(r.status).toBe(202);
    await node.drain();
    const run = (await admin.req("GET", `/admin/api/imports/${r.json.id}`)).json;
    expect(run.status).toBe("succeeded");
    expect(run.counts.errors).toBe(0);
    expect(run.counts.created).toBeGreaterThan(40);
    expect(run.files[0].name).toBe("Producten export.xlsx");
  });
});
