import { api } from "./ui";

type JobResp = { job: { status: string; error: string | null; step: string | null; progress: number } };

/** Poll a background job until it finishes. Resolves with the final job. */
export async function watchJob(jobId: string, onProgress?: (pct: number, step: string | null) => void, timeoutMs = 180000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { job } = await api<JobResp>(`/api/jobs/${jobId}`);
    onProgress?.(job.progress, job.step);
    if (job.status === "succeeded" || job.status === "failed") return job;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Job is still running – see Background Jobs");
}
