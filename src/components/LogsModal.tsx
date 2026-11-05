"use client";

import { ErrorBox, Loading, Modal, usePoll } from "./ui";
import type { WorkerDTO } from "./types";

export function LogsModal({ worker, onClose }: { worker: WorkerDTO | null; onClose: () => void }) {
  const { data, loading } = usePoll<{ logs: string; available: boolean; error?: string }>(worker ? `/api/workers/${worker.id}/logs?lines=300` : null, 5000);
  return (
    <Modal open={!!worker} onClose={onClose} title={`Logs · #${worker?.id} ${worker?.name}`} wide>
      {loading && !data ? <Loading /> : !data?.available ? <ErrorBox error={data?.error || "Logs unavailable"} /> : (
        <pre className="mono max-h-[60vh] overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-200">{data.logs || "(no log lines)"}</pre>
      )}
    </Modal>
  );
}

