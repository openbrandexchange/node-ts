import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseCsv, writeCsv, normHeader } from "../src/lib/csv";
import { parseIngestGtin, normaliseLookupGtin } from "../src/lib/gtin";
import { formatMaterials, parseImageName, parseMaterials, parseProductsCsv } from "../src/core/importformat";
import { isBlockedIp, assertSafeUrl, safeFetch, checkUrl, pinnedRequest } from "../src/lib/ssrf";
import { readZipDirectory, readZipEntry, zipBytes, unsafeEntryReason, zipStream, zipSize } from "../src/lib/zip";
import { bytesReader, scanMultipart } from "../src/lib/multipart";
import { crc32 } from "../src/lib/crypto";
import { imageSize, sniffType, fakeJpeg } from "../src/lib/image";
import { nextRunAt } from "../src/core/sources";
import { pickLanguage, PORTAL_WORD, UI_LANGUAGES } from "../src/core/mail";
import { formData } from "./helpers";

describe("image file names: the spec's shared vectors", () => {
  // fixtures/expected/image-filenames.json from the spec, copied by scripts/sync-fixtures.sh.
  const { cases } = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/expected/image-filenames.json"), "utf8")) as {
    cases: { name: string; error?: string; style?: string; color?: string | null; position?: number; role?: string; view?: string | null; external_id?: string }[];
  };
  test("at least 20 vectors", () => expect(cases.length).toBeGreaterThanOrEqual(20));
  for (const c of cases) {
    test(c.name, () => {
      const p = parseImageName(c.name);
      if (c.error) {
        expect("error" in p).toBe(true);
        return;
      }
      if ("error" in p) throw new Error(`${c.name}: ${p.error}`);
      expect({ style: p.style, color: p.color, position: p.position, role: p.role ?? "packshot", view: p.view, external_id: `${p.style}_${p.color ?? "ALL"}_${p.position}` }).toEqual({
        style: c.style!, color: c.color!, position: c.position!, role: c.role!, view: c.view!, external_id: c.external_id!,
      });
    });
  }
});

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
    expect(parseImageName("KO-1002_BLK_4_model_tilted_left.jpg")).toMatchObject({ style: "KO-1002", color: "BLK", position: 4, role: "model", view: "tilted_left" });
    expect(parseImageName("KO-1001_NVY_5_back_front.jpg")).toMatchObject({ position: 5, role: null, view: "front" });
    expect(parseImageName("KO-1005_all_4_size_chart.png")).toEqual({ style: "KO-1005", color: null, position: 4, role: "size_chart", view: null });
    expect(parseImageName("KO-1001_NVY_6_model_other.jpg")).toMatchObject({ role: "model", view: "other" });
    expect(parseImageName("KO-1001_NVY_6_other.jpg")).toMatchObject({ role: "other", view: null });
    expect(parseImageName("KO-1001_ALL_2_tilted_right.webp")).toMatchObject({ color: null, view: "tilted_right" });
    expect("error" in parseImageName("KO-1001_NVY_front.jpg")).toBe(true);
    expect("error" in parseImageName("KO-1001_NVY_01.jpg")).toBe(true);
  });
  test("materials grammar", () => {
    // 0.2: the 0.1 keys organic_* / recycled_* become the fibre with its flag, like the flag form.
    expect(parseMaterials("100% organic cotton")).toEqual({ value: [{ part: "main", fibers: [{ fiber: "cotton", percentage: 100, organic: true }] }] });
    expect(parseMaterials("100% Cotton (Organic)")).toEqual(parseMaterials("100% organic_cotton"));
    expect(parseMaterials("outer: 100% polyester (recycled); lining: 88% polyamide, 12% elastane")).toEqual({
      value: [
        { part: "outer", fibers: [{ fiber: "polyester", percentage: 100, recycled: true }] },
        { part: "lining", fibers: [{ fiber: "polyamide", percentage: 88 }, { fiber: "elastane", percentage: 12 }] },
      ],
    });
    expect(formatMaterials([{ part: "main", fibers: [{ fiber: "recycled_cotton", percentage: 100 }] }])).toBe("main: 100% cotton (recycled)");
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
  test("development mode allows private hosts but never link-local or cloud metadata", async () => {
    const pol = { allowPrivate: true, resolve: async (h: string) => (h === "meta.example" ? ["169.254.169.254"] : ["127.0.0.1"]) };
    expect((await assertSafeUrl("http://127.0.0.1:8080/feed.csv", pol)).port).toBe("8080");
    expect((await assertSafeUrl("https://files.local/x", pol)).host).toBe("files.local");
    for (const url of ["https://169.254.169.254/latest/meta-data", "https://[fe80::1]/hook", "https://[::ffff:169.254.169.254]/", "http://metadata.google.internal/", "https://meta.example/x"])
      await expect(assertSafeUrl(url, pol)).rejects.toMatchObject({ code: "unsafe_url" });
  });
});

describe("SSRF: connections go to the checked address", () => {
  test("the request connects to the resolved address and keeps the name in the Host header", async () => {
    const seen: string[] = [];
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (seen.push(req.headers.get("host") ?? ""), new Response("pinned")) });
    try {
      // "rebind.test" does not exist in any DNS: the request can only succeed by using the checked address.
      const pol = { allowPrivate: true, resolve: async () => ["127.0.0.1"], pin: true };
      const res = await safeFetch(`http://rebind.test:${srv.port}/feed.csv`, { timeoutMs: 5000 }, pol);
      expect(await res.text()).toBe("pinned");
      expect(seen).toEqual([`rebind.test:${srv.port}`]);
    } finally {
      srv.stop(true);
    }
  });
  test("a name that resolves to a metadata address is refused before connecting, also with pinning", async () => {
    const pol = { allowPrivate: true, resolve: async () => ["169.254.169.254"], pin: true };
    await expect(safeFetch("http://rebind.test/latest/meta-data", { timeoutMs: 2000 }, pol)).rejects.toMatchObject({ code: "unsafe_url" });
  });
  test("https keeps the original name for certificate checks; IPv4 is preferred; IPv6 is bracketed", async () => {
    const both = await checkUrl("https://files.example.com/a.csv", { allowPrivate: false, resolve: async () => ["2606:4700::1111", "93.184.216.34"] });
    expect(pinnedRequest(both, true)).toEqual({ url: "https://93.184.216.34/a.csv", host: "files.example.com", serverName: "files.example.com" });
    const v6 = await checkUrl("https://files.example.com:8443/a.csv", { allowPrivate: false, resolve: async () => ["2606:4700::1111"] });
    expect(pinnedRequest(v6, true)).toEqual({ url: "https://[2606:4700::1111]:8443/a.csv", host: "files.example.com:8443", serverName: "files.example.com" });
    expect(pinnedRequest(v6, false).url).toBe("https://files.example.com:8443/a.csv");
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

describe("e-mail delivery", () => {
  test("a temporary provider failure is retried; a refused message is not", async () => {
    const { httpMailer } = await import("../src/adapters/shared/mailer");
    const seen: number[] = [];
    let answers = [503, 429, 200];
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("", { status: (seen.push(1), answers.shift() ?? 200) }) });
    try {
      const m = httpMailer({ provider: "webhook", from: "portal@kestrel.example", webhookUrl: `http://127.0.0.1:${srv.port}/mail`, retryDelaysMs: [5, 5] });
      await m.send({ to: "a@b.example", subject: "s", text: "t", html: "h" });
      expect(seen.length).toBe(3);
      answers = [422];
      seen.length = 0;
      await expect(m.send({ to: "a@b.example", subject: "s", text: "t", html: "h" })).rejects.toThrow("422");
      expect(seen.length).toBe(1);
      answers = [500, 500, 500];
      seen.length = 0;
      await expect(m.send({ to: "a@b.example", subject: "s", text: "t", html: "h" })).rejects.toThrow("after 3 attempts");
    } finally {
      srv.stop(true);
    }
  });
});
