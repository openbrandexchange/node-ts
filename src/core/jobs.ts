// Durable background jobs with leases and checkpoints. Each step runs within a time budget and
// saves its state, so work continues after a Worker's CPU limit, a deploy or a crash.
import type { Ctx } from "./ctx";
import { newId, safeJsonParse } from "../lib/util";
import type { Stmt } from "../platform";

export type JobKind = "batch" | "import" | "export" | "download" | "maintenance";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "expired";

export interface JobRow {
  id: string;
  kind: JobKind;
  owner: string;
  status: JobStatus;
  input: string;
  state: string;
  progress_done: number;
  progress_total: number | null;
  summary: string | null;
  result: string | null;
  error: string | null;
  source_id: string | null;
  idempotency_key: string | null;
  lease_until: string | null;
  run_after: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  expires_at: string | null;
}

export interface StepOutcome {
  done: boolean;
  failed?: boolean;
  state?: unknown;
  progressDone?: number;
  progressTotal?: number | null;
  summary?: unknown;
  result?: unknown;
  error?: unknown;
  expiresAt?: string | null;
  /** Wait at least this long before the next step (ms). */
  delayMs?: number;
}

export type JobHandler = (ctx: Ctx, job: JobRow, deadline: number) => Promise<StepOutcome>;
export type JobFinished = (ctx: Ctx, job: JobRow) => Promise<void>;

const handlers = new Map<JobKind, JobHandler>();
const finishers = new Map<JobKind, JobFinished>();

export function registerJob(kind: JobKind, handler: JobHandler, onFinished?: JobFinished) {
  handlers.set(kind, handler);
  if (onFinished) finishers.set(kind, onFinished);
}

export async function enqueueJob(
  ctx: Ctx,
  o: { kind: JobKind; owner: string; input: unknown; sourceId?: string | null; idempotencyKey?: string | null; total?: number | null; id?: string; state?: unknown },
): Promise<JobRow> {
  const id = o.id ?? newId("job");
  const now = ctx.iso();
  await ctx.db.run(
    "INSERT INTO jobs (id, kind, owner, status, input, state, progress_total, source_id, idempotency_key, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)",
    [id, o.kind, o.owner, JSON.stringify(o.input ?? {}), JSON.stringify(o.state ?? {}), o.total ?? null, o.sourceId ?? null, o.idempotencyKey ?? null, now],
  );
  ctx.p.kickJobs();
  return (await getJob(ctx, id))!;
}

export async function getJob(ctx: Ctx, id: string): Promise<JobRow | null> {
  return ctx.db.first<JobRow>("SELECT * FROM jobs WHERE id = ?", [id]);
}

export function jobItemStmt(jobId: string, kind: string, idx: number, item: unknown, isError = false): Stmt {
  return {
    sql: "INSERT OR REPLACE INTO job_items (job_id, idx, kind, is_error, item) VALUES (?, ?, ?, ?, ?)",
    params: [jobId, idx, kind, isError ? 1 : 0, JSON.stringify(item)],
  };
}

export async function jobItems<T = unknown>(ctx: Ctx, jobId: string, kind: string, afterIdx: number, limit: number, errorsOnly = false): Promise<{ idx: number; item: T }[]> {
  const rows = await ctx.db.all<{ idx: number; item: string }>(
    `SELECT idx, item FROM job_items WHERE job_id = ? AND kind = ? AND idx > ?${errorsOnly ? " AND is_error = 1" : ""} ORDER BY idx LIMIT ?`,
    [jobId, kind, afterIdx, limit],
  );
  return rows.map((r) => ({ idx: r.idx, item: JSON.parse(r.item) as T }));
}

/** Claim one runnable job (queued, or running with an expired lease). */
async function claim(ctx: Ctx, leaseMs: number, kinds?: JobKind[]): Promise<JobRow | null> {
  const now = ctx.iso();
  const kindSql = kinds?.length ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
  return ctx.db.first<JobRow>(
    `UPDATE jobs SET status = 'running', lease_until = ?, started_at = COALESCE(started_at, ?) WHERE id = (
       SELECT id FROM jobs WHERE status IN ('queued', 'running') AND (lease_until IS NULL OR lease_until < ?) AND (run_after IS NULL OR run_after <= ?)${kindSql}
       ORDER BY created_at LIMIT 1
     ) AND (lease_until IS NULL OR lease_until < ?) RETURNING *`,
    [ctx.iso(leaseMs), now, now, now, ...(kinds ?? []), now],
  );
}

let running = false;

/** Runs job steps until the budget is spent or nothing is runnable. Returns the number of steps run. */
export async function runJobs(ctx: Ctx, budgetMs: number, opts: { kinds?: JobKind[] } = {}): Promise<number> {
  if (running && ctx.config.runtime === "bun") return 0;
  running = true;
  const start = ctx.now();
  let steps = 0;
  try {
    while (ctx.now() - start < budgetMs) {
      const stepBudget = Math.min(ctx.config.jobStepBudgetMs, budgetMs - (ctx.now() - start));
      if (stepBudget < 500) break;
      const job = await claim(ctx, stepBudget + 60_000, opts.kinds);
      if (!job) break;
      steps++;
      await runStep(ctx, job, ctx.now() + stepBudget);
    }
  } finally {
    running = false;
  }
  return steps;
}

async function runStep(ctx: Ctx, job: JobRow, deadline: number) {
  const h = handlers.get(job.kind);
  let out: StepOutcome;
  try {
    if (!h) throw new Error(`no handler for job kind ${job.kind}`);
    out = await h(ctx, job, deadline);
  } catch (e) {
    ctx.log("error", "job step failed", { job: job.id, kind: job.kind, error: e instanceof Error ? e.message : String(e) });
    const attempts = (safeJsonParse<{ _attempts?: number }>(job.state, {})._attempts ?? 0) + 1;
    if (attempts < 5) {
      const st = { ...safeJsonParse<Record<string, unknown>>(job.state, {}), _attempts: attempts };
      await ctx.db.run("UPDATE jobs SET state = ?, lease_until = NULL, run_after = ? WHERE id = ?", [JSON.stringify(st), ctx.iso(attempts * 15_000), job.id]);
      return;
    }
    out = { done: true, failed: true, error: { obx_error: "internal_error", detail: "The job failed repeatedly and was stopped." } };
  }
  const now = ctx.iso();
  const status: JobStatus | null = out.done ? (out.failed ? "failed" : "succeeded") : null;
  await ctx.db.run(
    `UPDATE jobs SET state = COALESCE(?, state), progress_done = COALESCE(?, progress_done), progress_total = COALESCE(?, progress_total),
       summary = COALESCE(?, summary), result = COALESCE(?, result), error = COALESCE(?, error), lease_until = NULL,
       run_after = ?, status = COALESCE(?, status), finished_at = CASE WHEN ? IS NOT NULL THEN ? ELSE finished_at END,
       expires_at = COALESCE(?, expires_at) WHERE id = ?`,
    [
      out.state === undefined ? null : JSON.stringify(out.state),
      out.progressDone ?? null,
      out.progressTotal ?? null,
      out.summary === undefined ? null : JSON.stringify(out.summary),
      out.result === undefined ? null : JSON.stringify(out.result),
      out.error === undefined ? null : JSON.stringify(out.error),
      out.delayMs ? ctx.iso(out.delayMs) : null,
      status,
      status,
      now,
      out.expiresAt ?? null,
      job.id,
    ],
  );
  if (status) {
    const fin = finishers.get(job.kind);
    const fresh = await getJob(ctx, job.id);
    if (fin && fresh) await fin(ctx, fresh).catch((e) => ctx.log("error", "job finisher failed", { job: job.id, error: String(e) }));
  } else ctx.p.kickJobs();
}

/** Deletes old jobs and their items (kept at least 7 days, per ingest.md §7). */
export async function pruneJobs(ctx: Ctx) {
  const cutoff = ctx.iso(-14 * 24 * 3600 * 1000);
  const old = await ctx.db.all<{ id: string }>("SELECT id FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ? AND kind IN ('batch', 'import', 'maintenance') LIMIT 200", [cutoff]);
  for (const j of old) {
    await ctx.db.batch([
      { sql: "DELETE FROM job_items WHERE job_id = ?", params: [j.id] },
      { sql: "DELETE FROM jobs WHERE id = ?", params: [j.id] },
    ]);
    await deletePrefix(ctx, `jobs/${j.id}/`);
  }
}

export async function deletePrefix(ctx: Ctx, prefix: string) {
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await ctx.blobs.list(prefix, cursor);
    if (r.keys.length) await ctx.blobs.delete(r.keys);
    if (!r.cursor) break;
    cursor = r.cursor;
  }
}
