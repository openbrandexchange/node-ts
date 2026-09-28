import { describe, expect, test } from "bun:test";
import { TestNode, fixtureText, fixtureBytes, uploadBlob, renditionsFor } from "./helpers";

const script = fixtureText("ingest/script.ndjson").trim().split("\n").map((l) => JSON.parse(l));
const expectedResults = JSON.parse(fixtureText("ingest/expected-results.json"));
const expectedChanges = JSON.parse(fixtureText("ingest/expected-changes.json")).changes;
const files = JSON.parse(fixtureText("ingest/files/files.json")) as Record<string, { sha256: string }>;

async function prepare() {
  const node = new TestNode();
  const admin = await node.setup();
  const token = await node.ingestToken(admin);
  const cl = await node.retailerClient(admin);
  const at = await node.accessToken(cl.clientId, cl.secret);
  const snap = await node.feed(at);
  for (const name of Object.keys(files)) await uploadBlob(node, token, fixtureBytes(`ingest/files/${name}`));
  return { node, token, at, cursor: snap.cursor };
}

/** Our node has server_generated=false, so like the conformance runner we add client renditions to files. */
async function withRenditions(node: TestNode, token: string, op: any, suffix = "") {
  const data = op.data ? JSON.parse(JSON.stringify(op.data)) : undefined;
  if (data?.brand_external_id) data.brand_external_id += suffix;
  if (data?.product_external_id) data.product_external_id += suffix;
  if (op.kind === "asset" && op.op === "upsert" && data?.files?.original) {
    const sha = data.files.original.sha256;
    const blob = await node.platform.db.first<{ width: number; height: number }>("SELECT width, height FROM blobs WHERE sha256 = ?", [sha]);
    const r = renditionsFor(blob!.width, blob!.height, parseInt(sha.slice(0, 6), 16));
    for (const n of ["web", "square", "thumb"] as const) data.files[n] = { sha256: await uploadBlob(node, token, r[n].bytes), width: r[n].w, height: r[n].h };
  }
  return { ...op, external_id: op.external_id + suffix, ...(data ? { data } : {}) };
}

function endpoint(op: any): { method: string; path: string; body?: unknown; ct?: string } {
  const plural = { brand: "brands", product: "products", variant: "variants", asset: "assets" }[op.kind as string];
  const path = `/obx/v1/ingest/${plural}/${encodeURIComponent(op.external_id)}`;
  if (op.op === "upsert") return { method: "PUT", path, body: op.data };
  if (op.op === "delete") return { method: "DELETE", path };
  const patch = op.op === "patch" ? op.data : { status: op.op === "publish" ? "published" : "unpublished" };
  return { method: "PATCH", path, body: patch, ct: "application/merge-patch+json" };
}

const strip = (e: any) => ({ type: e.type, op: e.op, external_id: e.external_id });

describe("ingest replay (I-REPLAY-1, P-FEED-5)", () => {
  test("one operation at a time gives the expected results and change entries", async () => {
    const { node, token, at, cursor: c0 } = await prepare();
    let cursor = c0;
    for (let i = 0; i < script.length; i++) {
      const op = await withRenditions(node, token, script[i]);
      const e = endpoint(op);
      const r = await node.api(token, e.method, e.path, e.body !== undefined ? { json: e.body, headers: e.ct ? { "content-type": e.ct } : {} } : {});
      const exp = expectedResults[i];
      if (exp.result === "error") {
        expect({ i, code: r.json.obx_error }).toEqual({ i, code: exp.obx_error });
      } else {
        expect({ i, result: r.json.result }).toEqual({ i, result: exp.result });
        expect(r.status).toBe(exp.result === "created" ? 201 : 200);
      }
      const f = await node.feed(at, cursor);
      cursor = f.cursor;
      expect({ i, entries: f.entries.map(strip) }).toEqual({ i, entries: expectedChanges.filter((x: any) => x.after_op === i).map(strip) });
      for (const entry of f.entries) {
        expect(entry._phase).toBe("live");
        if (entry.op === "upsert") expect(entry.data).toBeTruthy();
        else expect(entry.data).toBeUndefined();
      }
    }
  });

  test("the same script as one JSON batch and as NDJSON gives the same results and entries (I-REPLAY-2)", async () => {
    const { node, token, at, cursor } = await prepare();
    for (const [suffix, ndjson] of [
      ["-b", false],
      ["-c", true],
    ] as const) {
      const ops = [];
      for (const op of script) ops.push(await withRenditions(node, token, op, suffix));
      const f0 = await node.feed(at, (await node.feed(at, cursor)).cursor);
      const body = ndjson ? ops.map((o) => JSON.stringify(o)).join("\n") : JSON.stringify(ops);
      const r = await node.api(token, "POST", "/obx/v1/ingest/batch", { body, headers: { "content-type": ndjson ? "application/x-ndjson" : "application/json" } });
      expect(r.status).toBe(200);
      expect(r.json.results.map((x: any) => (x.result === "error" ? `error:${x.error.obx_error}` : x.result))).toEqual(
        expectedResults.map((x: any) => (x.result === "error" ? `error:${x.obx_error}` : x.result)),
      );
      expect(r.json.results.map((x: any) => x.index)).toEqual(script.map((_: unknown, i: number) => i));
      const f = await node.feed(at, f0.cursor);
      // Read after the whole batch: upserts of objects that are no longer visible are omitted
      // (protocol.md §6.2); at the end only the brand is still visible, every delete stays.
      const visibleAtEnd = new Set([`kestrel-lab${suffix}`]);
      const expected = expectedChanges
        .map((x: any) => ({ ...strip(x), external_id: x.external_id + suffix }))
        .filter((x: any) => x.op === "delete" || visibleAtEnd.has(x.external_id));
      expect(f.entries.map(strip)).toEqual(expected);
    }
  });

  test("repeating an upsert is unchanged and writes nothing; Idempotency-Key returns the same job (I-IDEM-1)", async () => {
    const { node, token, at, cursor } = await prepare();
    const put = () => node.api(token, "PUT", "/obx/v1/ingest/brands/kestrel-lab", { json: { name: "Kestrel Lab" } });
    expect((await put()).json.result).toBe("created");
    const f1 = await node.feed(at, cursor);
    expect((await put()).json.result).toBe("unchanged");
    expect((await node.feed(at, f1.cursor)).entries).toEqual([]);
    const ops = JSON.stringify([{ op: "upsert", kind: "brand", external_id: "kestrel-lab", data: { name: "Kestrel Lab 2" } }]);
    const a = await node.api(token, "POST", "/obx/v1/ingest/batch", { body: ops, headers: { "content-type": "application/json", prefer: "respond-async", "idempotency-key": "k1" } });
    const b = await node.api(token, "POST", "/obx/v1/ingest/batch", { body: ops, headers: { "content-type": "application/json", prefer: "respond-async", "idempotency-key": "k1" } });
    expect(a.status).toBe(202);
    expect(b.json.id).toBe(a.json.id);
    await node.drain();
    const job = await node.api(token, "GET", `/obx/v1/ingest/jobs/${a.json.id}`);
    expect(job.json.status).toBe("succeeded");
    expect(job.json.summary.updated).toBe(1);
    const results = await node.api(token, "GET", `/obx/v1/ingest/jobs/${a.json.id}/results`);
    expect(results.json.items[0].result).toBe("updated");
  });
});
