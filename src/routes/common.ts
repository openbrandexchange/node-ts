import type { Context } from "hono";
import type { Ctx } from "../core/ctx";
import type { SessionInfo } from "../core/auth";
import { ObxError } from "../lib/problem";
import { isPlainObject } from "../lib/util";

export type AppEnv = {
  Variables: {
    ctx: Ctx;
    session: SessionInfo | null;
    rl: Record<string, string> | null;
    /** Set by sign-in handlers: who the audit entry is about when there was no session yet. */
    auditActor?: import("../core/audit").AuditActor;
    /** Extra facts for the audit entry (never secrets or passwords). */
    auditDetails?: Record<string, unknown>;
  };
};

export type C = Context<AppEnv>;

export function ctxOf(c: C): Ctx {
  return c.get("ctx");
}

export function json(c: C, body: unknown, status = 200, headers: Record<string, string> = {}) {
  const rl = c.get("rl");
  return c.body(JSON.stringify(body), status as never, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(rl ?? {}), ...headers });
}

export function noContent(c: C) {
  const rl = c.get("rl");
  return c.body(null, 204, { ...(rl ?? {}) });
}

export async function readJson(c: C, max = 4 * 1048576): Promise<unknown> {
  const len = Number(c.req.header("content-length") ?? "0");
  if (len > max) throw new ObxError("payload_too_large", "The request body is too large.");
  const text = await c.req.text();
  if (text.length > max) throw new ObxError("payload_too_large", "The request body is too large.");
  if (!text.trim()) throw new ObxError("invalid_request", "A JSON body is required.");
  try {
    return JSON.parse(text);
  } catch {
    throw new ObxError("invalid_request", "The body is not valid JSON.");
  }
}

export async function readObject(c: C, max?: number): Promise<Record<string, unknown>> {
  const v = await readJson(c, max);
  if (!isPlainObject(v)) throw new ObxError("invalid_request", "The body must be a JSON object.");
  return v;
}

export async function readOptionalObject(c: C): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (!isPlainObject(v)) throw new Error();
    return v;
  } catch {
    throw new ObxError("invalid_request", "The body must be a JSON object.");
  }
}

export function intQuery(c: C, name: string, def: number, lo: number, hi: number): number {
  const v = c.req.query(name);
  if (v === undefined || v === "") return def;
  if (!/^\d+$/.test(v) || Number(v) < lo || Number(v) > hi) throw new ObxError("invalid_request", `${name} must be a whole number from ${lo} to ${hi}.`);
  return Number(v);
}

export function listQuery(c: C, name: string): string[] | undefined {
  const all = c.req.queries(name);
  if (!all?.length) return undefined;
  const out = all.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

export function clientIp(c: C): string {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-obx-client-ip") ?? "unknown";
}

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

export function idParam(c: C, name = "id"): string {
  const v = c.req.param(name) ?? "";
  if (!ID_RE.test(v)) throw new ObxError("not_found", "Not found.");
  return v;
}

/** Keyset cursor for simple lists (opaque, signed). */
export async function encodeListCursor(ctx: Ctx, kind: string, value: unknown): Promise<string> {
  return ctx.keys.seal("list:" + kind, value);
}

export async function decodeListCursor<T>(ctx: Ctx, kind: string, raw: string | undefined): Promise<T | null> {
  if (!raw) return null;
  const v = await ctx.keys.unseal<T>("list:" + kind, raw);
  if (v === null) throw new ObxError("cursor_invalid", "This cursor is not valid.");
  return v;
}
