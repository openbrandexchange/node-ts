// Periodic work (Workers Cron Trigger every minute; Bun timer): scheduled imports, jobs, webhooks,
// rights expiry tombstones, staged originals, retention and blob garbage collection.
import type { Ctx } from "./ctx";
import { CatalogSession } from "./catalog";
import { registerJob, runJobs, pruneJobs, deletePrefix, type JobRow, type StepOutcome } from "./jobs";
import { deliverDue, notifyChanges } from "./notify";
import { pruneChanges } from "./changes";
import { gcBlobs } from "./blobs";
import { nextRunAt, type SourceRow } from "./sources";
import { startImport } from "./importjob";
import { safeJsonParse } from "../lib/util";

export async function runScheduledImports(ctx: Ctx) {
  const due = await ctx.db.all<SourceRow>("SELECT * FROM import_sources WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? LIMIT 20", [ctx.iso()]);
  for (const src of due) {
    const sched = safeJsonParse<{ frequency: string; time?: string; weekday?: number; timezone?: string }>(src.schedule, { frequency: "manual" });
    const next = nextRunAt(sched, ctx.now());
    const claimed = await ctx.db.run("UPDATE import_sources SET next_run_at = ? WHERE id = ? AND next_run_at = ?", [next ? new Date(next).toISOString().replace(/\.\d{3}Z$/, "Z") : null, src.id, src.next_run_at]);
    if (!claimed.changes) continue;
    const running = await ctx.db.first("SELECT 1 AS x FROM jobs WHERE source_id = ? AND status IN ('queued', 'running') LIMIT 1", [src.id]);
    if (running) continue;
    await startImport(
      ctx,
      {
        trigger: "schedule",
        mode: src.mode,
        dry_run: false,
        allow_mass_unpublish: !!src.allow_mass_unpublish,
        default_language: null,
        allowed_brands: null,
        source_id: src.id,
        started_by: "schedule",
      },
      { owner: "admin" },
    );
  }
}

/** Delete entries for assets whose rights expired (within the hour, protocol.md §5.6). */
export async function expireAssets(ctx: Ctx) {
  const now = ctx.iso();
  const rows = await ctx.db.all<{ id: string; external_id: string; product_id: string; brand_id: string; visible: number }>(
    `SELECT a.id, a.external_id, a.product_id, a.brand_id,
       (a.status = 'published' AND a.has_original = 1 AND p.status = 'published' AND b.status = 'published') AS visible
     FROM assets a JOIN products p ON p.id = a.product_id JOIN brands b ON b.id = p.brand_id
     WHERE a.expires_at IS NOT NULL AND a.expires_at <= ? AND a.expiry_tombstoned = 0 LIMIT 200`,
    [now],
  );
  if (!rows.length) return;
  const stmts = [];
  for (const r of rows) {
    if (r.visible)
      stmts.push({
        sql: "INSERT INTO changes (type, op, obj_id, external_id, brand_id, product_id, updated_at, created_at) VALUES ('asset', 'delete', ?, ?, ?, ?, ?, ?)",
        params: [r.id, r.external_id, r.brand_id, r.product_id, now, now],
      });
    stmts.push({ sql: "UPDATE assets SET expiry_tombstoned = 1 WHERE id = ?", params: [r.id] });
  }
  await ctx.db.batch(stmts);
}

/** Staged originals whose renditions never arrived: switch after 15 minutes (missing renditions fall back). */
export async function promoteStaged(ctx: Ctx) {
  const rows = await ctx.db.all<{ id: string }>("SELECT id FROM assets WHERE staged IS NOT NULL AND staged_at < ? LIMIT 50", [ctx.iso(-15 * 60_000)]);
  for (const r of rows) {
    const s = await new CatalogSession(ctx, { allowedBrands: null, canDelete: false }).init();
    if (await s.promoteStaged(r.id)) await s.commit();
  }
}

export async function housekeeping(ctx: Ctx) {
  const now = ctx.iso();
  await ctx.db.batch([
    { sql: "DELETE FROM sessions WHERE expires_at < ?", params: [now] },
    { sql: "DELETE FROM password_resets WHERE expires_at < ?", params: [ctx.iso(-24 * 3600 * 1000)] },
    { sql: "DELETE FROM idempotency WHERE created_at < ?", params: [ctx.iso(-24 * 3600 * 1000)] },
    { sql: "DELETE FROM rate_limits WHERE window_start < ?", params: [Math.floor(ctx.now() / 1000) - 7200] },
    { sql: "DELETE FROM webhook_deliveries WHERE created_at < ? AND state != 'pending'", params: [ctx.iso(-7 * 24 * 3600 * 1000)] },
    { sql: "UPDATE download_events SET actor_name = NULL WHERE at < ? AND actor_name IS NOT NULL AND actor_type = 'user'", params: [ctx.iso(-400 * 24 * 3600 * 1000)] },
  ]);
  // Expired upload sessions.
  const ups = await ctx.db.all<{ id: string; parts_total: number }>("SELECT id, parts_total FROM uploads WHERE status = 'open' AND expires_at < ? LIMIT 20", [now]);
  for (const u of ups) {
    await deletePrefix(ctx, `uploads/${u.id}/`);
    await ctx.db.run("UPDATE uploads SET status = 'expired' WHERE id = ?", [u.id]);
  }
  // Expired exports and download jobs: delete files, keep the row as "expired".
  const exp = await ctx.db.all<JobRow>("SELECT * FROM jobs WHERE kind IN ('export', 'download') AND status = 'succeeded' AND expires_at < ? LIMIT 20", [now]);
  for (const j of exp) {
    await deletePrefix(ctx, `jobs/${j.id}/`);
    await ctx.db.run("UPDATE jobs SET status = 'expired' WHERE id = ?", [j.id]);
  }
  // Import scratch files of finished imports.
  const imp = await ctx.db.all<{ id: string }>("SELECT id FROM jobs WHERE kind = 'import' AND status IN ('succeeded', 'failed') AND finished_at < ? AND expires_at IS NULL LIMIT 20", [ctx.iso(-3600_000)]);
  for (const j of imp) {
    await deletePrefix(ctx, `jobs/${j.id}/`);
    await deletePrefix(ctx, `imports/${j.id}/`);
    await ctx.db.run("UPDATE jobs SET expires_at = ? WHERE id = ?", [now, j.id]);
  }
  await pruneJobs(ctx);
  await pruneChanges(ctx);
  await gcBlobs(ctx);
}

/** Everything the minute tick does, bounded by `budgetMs`. */
export async function tick(ctx: Ctx, budgetMs: number) {
  if (!(await ctx.isSetUp())) return;
  const start = ctx.now();
  const safe = async (name: string, f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      ctx.log("error", `cron: ${name} failed`, { error: e instanceof Error ? e.message : String(e) });
    }
  };
  await safe("scheduled imports", () => runScheduledImports(ctx));
  await safe("expiry", () => expireAssets(ctx));
  await safe("staged originals", () => promoteStaged(ctx));
  await safe("changes.available", () => notifyChanges(ctx));
  await safe("webhooks", () => deliverDue(ctx, Math.min(8000, budgetMs / 4)));
  const minute = Math.floor(ctx.now() / 60_000);
  if (minute % 10 === 0) await safe("housekeeping", () => housekeeping(ctx));
  const left = budgetMs - (ctx.now() - start);
  if (left > 1000) await safe("jobs", () => runJobs(ctx, left));
}

// ------------------------------------------------------------------ maintenance jobs

interface MaintInput {
  task: "rights";
}

async function maintenanceStep(ctx: Ctx, job: JobRow, deadline: number): Promise<StepOutcome> {
  const input = safeJsonParse<MaintInput>(job.input, { task: "rights" });
  const st = safeJsonParse<{ after: string; done: number }>(job.state, { after: "", done: 0 });
  st.after ??= "";
  st.done ??= 0;
  if (input.task === "rights") {
    while (ctx.now() < deadline) {
      const rows = await ctx.db.all<{ id: string; rep_hash: string }>("SELECT id, rep_hash FROM assets WHERE id > ? ORDER BY id LIMIT 50", [st.after]);
      if (!rows.length) return { done: true, state: st, progressDone: st.done };
      const s = await new CatalogSession(ctx, { allowedBrands: null, canDelete: false }).init();
      let any = false;
      for (const r of rows) if (await s.refreshAsset(r.id, r.rep_hash)) any = true;
      if (any) await s.commit();
      st.after = rows[rows.length - 1].id;
      st.done += rows.length;
    }
  }
  return { done: false, state: st, progressDone: st.done };
}

registerJob("maintenance", maintenanceStep);
