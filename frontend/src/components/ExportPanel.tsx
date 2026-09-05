import { API_BASE } from "../api/client";
import { useProjectStore } from "../state/projectStore";

export function ExportPanel() {
  const status = useProjectStore((s) => s.status);
  const slots = useProjectStore((s) => s.slots);
  const exportStatus = useProjectStore((s) => s.exportStatus);
  const exportUrl = useProjectStore((s) => s.exportUrl);
  const error = useProjectStore((s) => s.error);
  const exportVideo = useProjectStore((s) => s.exportVideo);

  if (status !== "ready") return null;

  const allReady = slots.length > 0 && slots.every((s) => s.clip.download_status === "ready");

  return (
    <div style={{ marginTop: "2rem" }}>
      <button onClick={() => exportVideo()} disabled={!allReady || exportStatus === "exporting"}>
        {exportStatus === "exporting" ? "Exporting…" : "Export MP4"}
      </button>
      {!allReady && (
        <p style={{ fontSize: 12, color: "#888" }}>Fetch all clips before exporting.</p>
      )}
      {exportStatus === "error" && <p style={{ color: "crimson" }}>{error}</p>}
      {exportStatus === "done" && exportUrl && (
        <div style={{ marginTop: "1rem" }}>
          <video src={`${API_BASE}${exportUrl}`} controls style={{ maxWidth: 240 }} />
        </div>
      )}
    </div>
  );
}
