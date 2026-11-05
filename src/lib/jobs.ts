import crypto from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, pool } from "@/db";
import { jobs, type Job } from "@/db/schema";
import { logActivity } from "./settings";
import type { Progress } from "./workers";

type Handler = (payload: Record<string, unknown>, progress: Progress) => Promise<unknown>;
// Shared via globalThis: Next.js may load route handlers and the instrumentation hook
// as separate module instances, so module-local state would not be shared.
const gh = globalThis as typeof globalThis & { __mtpJobHandlers?: Map<string, Handler> };
const handlers: Map<string, Handler> = gh.__mtpJobHandlers ?? (gh.__mtpJobHandlers = new Map());

export function registerJob(type: string, h: Handler) {
  handlers.set(type, h);
}

/**
 * Enqueue a job. If an unfinished job with the same idempotency key exists,
 * that job is returned instead (safe double-submit / retry).
 */
export async function enqueue(type: string, payload: Record<string, unknown>, opts: { key?: string; maxAttempts?: number } = {}): Promise<Job> {
  if (opts.key) {
    const existing = await db.select().from(jobs)
      .where(and(eq(jobs.idempotencyKey, opts.key), inArray(jobs.status, ["queued", "running"]))).limit(1);
    if (existing[0]) return existing[0];
  }
  const r = await db.insert(jobs).values({
    id: crypto.randomUUID(),
    type,
    payload,
    maxAttempts: opts.maxAttempts ?? 1,
    idempotencyKey: opts.key ?? null,
  }).returning();
  kick();
  return r[0];
}

const g = globalThis as typeof globalThis & { __mtpJobs?: { running: boolean; timer: NodeJS.Timeout | null } };
const st = g.__mtpJobs ?? (g.__mtpJobs = { running: false, timer: null });

async function claim(): Promise<Job | null> {
  const r = await pool.query(
    `UPDATE jobs SET status='running', started_at=now(), attempts=attempts+1, error=NULL
     WHERE id = (SELECT id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id`,
  );
  if (!r.rows[0]) return null;
  const j = await db.select().from(jobs).where(eq(jobs.id, r.rows[0].id)).limit(1);
  return j[0] ?? null;
}

async function runOne(job: Job) {
  const h = handlers.get(job.type);
  const progress: Progress = async (pct, step) => {
    await db.update(jobs).set({ progress: Math.round(pct), step }).where(eq(jobs.id, job.id));
  };
  if (!h) {
    // handlers not registered yet (runtime still starting): put the job back
    await db.update(jobs).set({ status: "queued", attempts: Math.max(0, job.attempts - 1), step: "Waiting for job runner" }).where(eq(jobs.id, job.id));
    throw new Error("handlers not ready");
  }
  try {
    const result = await h(job.payload as Record<string, unknown>, progress);
    await db.update(jobs).set({ status: "succeeded", progress: 100, result: (result ?? null) as object, finishedAt: new Date() }).where(eq(jobs.id, job.id));
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const retry = job.attempts < job.maxAttempts;
    await db.update(jobs).set({
      status: retry ? "queued" : "failed",
      error: msg.slice(0, 4000),
      finishedAt: retry ? null : new Date(),
    }).where(eq(jobs.id, job.id));
    if (!retry) await logActivity("system", "job.failed", `job:${job.id}`, { type: job.type, error: msg.slice(0, 500) }, "error");
  }
}

export function kick() {
  if (st.running || handlers.size === 0) return;
  st.running = true;
  (async () => {
    try {
      for (;;) {
        const job = await claim();
        if (!job) break;
        try {
          await runOne(job);
        } catch {
          break; // handlers not ready – retry on next tick
        }
      }
    } catch (e) {
      console.error("[jobs] runner error", e);
    } finally {
      st.running = false;
    }
  })();
}

export async function startJobRunner() {
  // Jobs that were running when the process died: requeue if attempts remain.
  await db.update(jobs).set({ status: "queued", step: "Requeued after restart" })
    .where(and(eq(jobs.status, "running"), sql`${jobs.attempts} < ${jobs.maxAttempts}`));
  await db.update(jobs).set({ status: "failed", error: "Interrupted by panel restart", finishedAt: new Date() })
    .where(eq(jobs.status, "running"));
  if (!st.timer) st.timer = setInterval(kick, 2000);
  kick();
}
