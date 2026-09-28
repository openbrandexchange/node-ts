// POST /batch: operations in order, each atomic on its own (ingest.md §5).
import type { Ctx } from "./ctx";
import { applyOne, errorResult, type IngestResult, type Kind, type Op } from "./catalog";
import { registerJob, jobItemStmt, type JobRow, type StepOutcome } from "./jobs";
import { ObxError } from "../lib/problem";
import { isPlainObject, safeJsonParse } from "../lib/util";
import { onBatchFinished } from "./notify";

export interface BatchOptions {
  allowedBrands: string[] | null;
  canDelete: boolean;
  canWrite: boolean;
}

export function summarize(results: IngestResult[]) {
  const s = { created: 0, updated: 0, unchanged: 0, deleted: 0, errors: 0 };
  for (const r of results) {
    if (r.result === "error") s.errors++;
    else s[r.result]++;
  }
  return s;
}

export async function runOp(ctx: Ctx, o: BatchOptions, raw: unknown, index: number): Promise<IngestResult> {
  const op = (isPlainObject(raw) ? raw.op : undefined) as Op;
  const kind = (isPlainObject(raw) ? raw.kind : undefined) as Kind;
  const ext = isPlainObject(raw) && typeof raw.external_id === "string" ? raw.external_id : "";
  if (!isPlainObject(raw) || !["upsert", "patch", "delete", "publish", "unpublish"].includes(op) || !["brand", "product", "variant", "asset"].includes(kind) || !ext) {
    return { ...errorResult(op ?? "upsert", kind ?? "product", ext || "?", new ObxError("validation_failed", "Each operation needs op, kind and external_id.")), index };
  }
  if (op === "delete" && !o.canDelete) return { ...errorResult(op, kind, ext, new ObxError("insufficient_scope", "Deleting needs the ingest:delete scope.")), index };
  if (op !== "delete" && !o.canWrite) return { ...errorResult(op, kind, ext, new ObxError("insufficient_scope", "Writing needs the ingest:write scope.")), index };
  const r = await applyOne(ctx, { allowedBrands: o.allowedBrands, canDelete: o.canDelete }, op, kind, ext, raw.data ?? null, (raw.if_match as string | null) ?? null);
  return { ...r, index };
}

/** Parses a JSON array or NDJSON body into operations. */
export function parseOps(text: string, contentType: string | null): unknown[] {
  const t = text.trim();
  if (!t) throw new ObxError("invalid_request", "The body is empty.");
  if ((contentType ?? "").includes("ndjson") || !t.startsWith("[")) {
    const out: unknown[] = [];
    t.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      try {
        out.push(JSON.parse(line));
      } catch {
        throw new ObxError("invalid_request", `Line ${i + 1} is not valid JSON.`);
      }
    });
    return out;
  }
  try {
    const v = JSON.parse(t);
    if (!Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new ObxError("invalid_request", "The body must be a JSON array of operations or NDJSON.");
  }
}

async function step(ctx: Ctx, job: JobRow, deadline: number): Promise<StepOutcome> {
  const input = safeJsonParse<{ opts: BatchOptions; count: number }>(job.input, { opts: { allowedBrands: null, canDelete: false, canWrite: true }, count: 0 });
  const st = safeJsonParse<{ i: number; summary: ReturnType<typeof summarize> }>(job.state, { i: 0, summary: summarize([]) });
  st.i ??= 0;
  st.summary ??= summarize([]);
  const stream = await ctx.blobs.get(`jobs/${job.id}/ops.json`);
  const ops = stream ? (JSON.parse(await new Response(stream).text()) as unknown[]) : [];
  while (st.i < ops.length && ctx.now() < deadline) {
    const r = await runOp(ctx, input.opts, ops[st.i], st.i);
    await ctx.db.batch([jobItemStmt(job.id, "result", st.i + 1, r, r.result === "error")]);
    const s = summarize([r]);
    for (const k of Object.keys(s) as (keyof typeof s)[]) st.summary[k] += s[k];
    st.i++;
  }
  const done = st.i >= ops.length;
  return { done, state: st, progressDone: st.i, progressTotal: ops.length, summary: st.summary };
}

registerJob("batch", step, onBatchFinished);
