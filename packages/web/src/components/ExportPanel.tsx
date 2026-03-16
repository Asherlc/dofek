import { useState } from "react";

type ExportState = "idle" | "processing" | "done" | "error";

interface ExportStatus {
  status: string;
  progress?: number;
  message?: string;
  downloadUrl?: string;
}

export function ExportPanel() {
  const [state, setState] = useState<ExportState>("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");

  async function startExport() {
    setState("processing");
    setProgress(0);
    setMessage("Starting export...");

    try {
      const triggerRes = await fetch("/api/export", {
        method: "POST",
        credentials: "include",
      });

      if (!triggerRes.ok) {
        setState("error");
        setMessage("Failed to start export");
        return;
      }

      const triggerData: { jobId: string } = await triggerRes.json();
      const { jobId } = triggerData;

      // Poll for status
      const deadline = Date.now() + 10 * 60 * 1000; // 10 minute timeout
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));

        const statusRes = await fetch(`/api/export/status/${jobId}`, {
          credentials: "include",
        });

        if (!statusRes.ok) {
          setState("error");
          setMessage("Failed to check export status");
          return;
        }

        const status: ExportStatus = await statusRes.json();
        setProgress(status.progress ?? 0);
        setMessage(status.message ?? "");

        if (status.status === "done" && status.downloadUrl) {
          setState("done");
          // Trigger download
          window.location.href = status.downloadUrl;
          return;
        }

        if (status.status === "error") {
          setState("error");
          setMessage(status.message ?? "Export failed");
          return;
        }
      }

      setState("error");
      setMessage("Export timed out");
    } catch {
      setState("error");
      setMessage("Network error during export");
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-400">
        Download all your health data as a ZIP file containing JSON files. This may take several
        minutes for large datasets.
      </p>

      {state === "processing" && (
        <div className="space-y-2">
          <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-zinc-500">{message}</p>
        </div>
      )}

      {state === "done" && (
        <p className="text-sm text-emerald-400">
          Export complete — download should start automatically.
        </p>
      )}

      {state === "error" && <p className="text-sm text-red-400">{message}</p>}

      <button
        type="button"
        onClick={startExport}
        disabled={state === "processing"}
        className="inline-flex items-center gap-2 text-sm border border-zinc-700 rounded px-4 py-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed hover:bg-zinc-800"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <title>Download</title>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        {state === "processing" ? "Exporting..." : "Download My Data"}
      </button>
    </div>
  );
}
