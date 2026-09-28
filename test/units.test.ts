import { describe, expect, test } from "bun:test";
import { parseCsv, writeCsv, normHeader } from "../src/lib/csv";
import { parseIngestGtin, normaliseLookupGtin } from "../src/lib/gtin";
import { parseImageName, parseMaterials, parseProductsCsv } from "../src/core/importformat";
import { isBlockedIp, assertSafeUrl } from "../src/lib/ssrf";
import { readZipDirectory, readZipEntry, zipBytes, unsafeEntryReason, zipStream, zipSize } from "../src/lib/zip";
import { bytesReader, scanMultipart } from "../src/lib/multipart";
import { crc32 } from "../src/lib/crypto";
import { imageSize, sniffType, fakeJpeg } from "../src/lib/image";
import { nextRunAt } from "../src/core/sources";
import { pickLanguage, PORTAL_WORD, UI_LANGUAGES } from "../src/core/mail";
import { formData } from "./helpers";

describe("CSV", () => {
  test("delimiter detection, quoting, BOM, CRLF, empty rows", () => {
    const p = parseCsv('\ufeffStyle Number;Name:en;note\r\n"KO-1";"Crew ""neck""; knit";x\r\n\r\n;;\nKO-2;Tee;"multi\nline"\n');
    expect(p.delimiter).toBe(";");
    expect(p.header.map(normHeader)).toEqual(["style_number", "name:en", "note"]);
    expect(p.rows.map((r) => r.row)).toEqual([1, 4]);
    expect(p.rows[0].cells[1]).toBe('Crew "neck"; knit');
    expect(p.rows[1].cells[2]).toBe("multi\nline");
  });
  test("writer escapes formulas but keeps numbers", () => {
    const out = writeCsv([["=cmd", "+1", "-x", "@a", "2000100101025", "-12.5", "plain"]], ",", false);
    expect(out.trim()).toBe("'=cmd,+1,'-x,'@a,2000100101025,-12.5,plain");
  });
});

describe("GTIN", () => {
  test("strict on ingest, lenient on lookup", () => {
    expect(parseIngestGtin("2000100101025")).toEqual({ gtin14: "02000100101025", original: "2000100101025" });
    expect("error" in parseIngestGtin("2000100101026")).toBe(true);
    expect("error" in parseIngestGtin("123")).toBe(true);
    expect(normaliseLookupGtin(" 2000 100101026 ")).toBe("02000100101026");
    expect(normaliseLookupGtin("12345")).toBeNull();
  });
});

describe("import format", () => {
  test("image file names are parsed from the right", () => {
    expect(parseImageName("KO-1001_NVY_1.jpg")).toEqual({ style: "KO-1001", color: "NVY", position: 1, role: null, view: null });
    expect(parseImageName("KO-1001_NVY_2_back.jpg")).toMatchObject({ position: 2, role: null, view: "back" });
    expect(parseImageName("KO-1003_RST_3_model.png")).toMatchObject({ style: "KO-1003", role: "model", view: null });
    expect(parseImageName("AB_12_34_BLK_2_packshot_back.JPG")).toMatchObject({ style: "AB_12_34", color: "BLK", position: 2, role: "packshot", view: "back" });
    expect(parseImageName("KO-1004_IND_3_detail.jpg")).toMatchObject({ role: "detail", view: "detail" });
    expect("error" in parseImageName("KO-1001_NVY_front.jpg")).toBe(true);
    expect("error" in parseImageName("KO-1001_NVY_01.jpg")).toBe(true);
  });
  test("materials grammar", () => {
    expect(parseMaterials("100% organic cotton")).toEqual({ value: [{ part: "main", fibers: [{ fiber: "organic_cotton", percentage: 100 }] }] });
    const m = parseMaterials("outer: 65% cotton, 35% polyamide; lining: 100% polyester");
    expect("value" in m && m.value.map((x) => x.part)).toEqual(["outer", "lining"]);
    expect("error" in parseMaterials("cotton")).toBe(true);
  });
  test("products.csv: aliases, language columns, first value wins with a warning", () => {
    const csv = "Style,name,name:de,EAN,Colour Code,size\nKO-1,Trui,Pullover,2000100101018,NVY,S\nKO-1,Other,,2000100101025,NVY,M\n";
    const r = parseProductsCsv(csv, "products.csv", "nl");
    expect(r.groups.length).toBe(1);
    expect(r.groups[0].product.name).toEqual({ nl: "Trui", de: "Pullover" });
    expect(r.groups[0].variants.map((v) => v.externalId)).toEqual(["2000100101018", "2000100101025"]);
    expect(r.errors.some((e) => e.severity === "warning" && e.column === "name")).toBe(true);
  });
});

describe("SSRF protection", () => {
  test("private, loopback, link-local, CGNAT, mapped addresses are blocked", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "224.0.0.1"]) expect({ ip, b: isBlockedIp(ip) }).toEqual({ ip, b: true });
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) expect({ ip, b: isBlockedIp(ip) }).toEqual({ ip, b: false });
  });
  test("https only; resolved private hosts refused", async () => {
    const pol = { allowPrivate: false, resolve: async (h: string) => (h === "evil.example" ? ["10.0.0.5"] : ["93.184.216.34"]) };
    await expect(assertSafeUrl("http://example.com/x", pol)).rejects.toMatchObject({ code: "unsafe_url" });
    await expect(assertSafeUrl("https://evil.example/x", pol)).rejects.toMatchObject({ code: "unsafe_url" });
    await expect(assertSafeUrl("https://localhost/x", pol)).rejects.toMatchObject({ code: "unsafe_url" });
    expect((await assertSafeUrl("https://example.com/x", pol)).host).toBe("example.com");
  });
});

describe("zip", () => {
  test("round trip, sizes known in advance, deflate entries, zip-slip detection", async () => {
    const files = [
      { name: "a/one.txt", data: new TextEncoder().encode("hello") },
      { name: "b/twee.txt", data: new TextEncoder().encode("wereld".repeat(100)) },
    ];
    const z = await zipBytes(files, crc32);
    const entries = files.map((f) => ({ name: f.name, size: f.data.length, crc: crc32(f.data), open: async () => f.data }));
    expect(zipSize(entries)).toBe(z.length);
    const dir = await readZipDirectory(bytesReader(z), z.length);
    expect(dir.map((d) => d.name)).toEqual(["a/one.txt", "b/twee.txt"]);
    expect(new TextDecoder().decode(await readZipEntry(bytesReader(z), dir[1], 1e6))).toBe("wereld".repeat(100));
    // a deflated entry made by the platform compressor
    const raw = new TextEncoder().encode("abc".repeat(1000));
    const deflated = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
    const got = await readZipEntry(bytesReader(new Uint8Array([...new Uint8Array(30).map((_, i) => [0x50, 0x4b, 0x03, 0x04][i] ?? 0), ...deflated])), { name: "x", method: 8, compressedSize: deflated.length, size: raw.length, crc: 0, localOffset: 0, isDir: false, isSymlink: false, encrypted: false }, 1e6);
    expect([...got]).toEqual([...raw]);
    expect(unsafeEntryReason({ name: "../evil.jpg", isSymlink: false } as never)).toBeTruthy();
    expect(unsafeEntryReason({ name: "C:/x.jpg", isSymlink: false } as never)).toBeTruthy();
    expect(unsafeEntryReason({ name: "/etc/passwd", isSymlink: false } as never)).toBeTruthy();
    expect(unsafeEntryReason({ name: "ok/x.jpg", isSymlink: true } as never)).toBeTruthy();
    expect(unsafeEntryReason({ name: "ok/x.jpg", isSymlink: false } as never)).toBeNull();
    const streamed = new Uint8Array(await new Response(zipStream(entries)).arrayBuffer());
    expect([...streamed]).toEqual([...z]);
  });
});

describe("multipart scanning by offsets", () => {
  test("finds fields and files", async () => {
    const f = formData([
      { name: "options", data: '{"mode":"upsert"}' },
      { name: "images", filename: "KO-1_A_1.jpg", type: "image/jpeg", data: new Uint8Array([1, 2, 3, 13, 10, 45, 45]) },
    ]);
    const boundary = f.contentType.split("boundary=")[1];
    const parts = await scanMultipart(bytesReader(f.body), f.body.length, boundary);
    expect(parts.map((p) => [p.name, p.filename, p.length])).toEqual([
      ["options", null, 17],
      ["images", "KO-1_A_1.jpg", 7],
    ]);
    expect([...f.body.slice(parts[1].offset, parts[1].offset + parts[1].length)]).toEqual([1, 2, 3, 13, 10, 45, 45]);
  });
});

describe("images and schedules", () => {
  test("header-only dimensions", () => {
    const j = fakeJpeg(1600, 2000);
    expect(sniffType(j)).toBe("image/jpeg");
    expect(imageSize(j, "image/jpeg")).toEqual({ width: 1600, height: 2000 });
  });
  test("daily and weekly schedules in a time zone", () => {
    const from = Date.parse("2026-09-28T10:00:00Z"); // a Monday
    expect(new Date(nextRunAt({ frequency: "daily", time: "02:30", timezone: "Europe/Amsterdam" }, from)!).toISOString()).toBe("2026-09-29T00:30:00.000Z");
    expect(new Date(nextRunAt({ frequency: "weekly", time: "06:00", weekday: 5, timezone: "UTC" }, from)!).toISOString()).toBe("2026-10-02T06:00:00.000Z");
    expect(nextRunAt({ frequency: "manual" }, from)).toBeNull();
    expect(new Date(nextRunAt({ frequency: "hourly" }, from)!).toISOString()).toBe("2026-09-28T11:00:00.000Z");
  });
  test("languages: 25 UI languages, Accept-Language detection, portal word", () => {
    expect(UI_LANGUAGES.length).toBe(25);
    expect(Object.keys(PORTAL_WORD).sort()).toEqual([...UI_LANGUAGES].sort());
    expect(pickLanguage("de-CH,de;q=0.9,en;q=0.8")).toBe("de");
    expect(pickLanguage("zh-CN,no;q=0.5")).toBe("nb");
    expect(pickLanguage("zh-CN")).toBe("en");
  });
});
