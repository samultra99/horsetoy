import { useProjectStore } from "../state/projectStore";

const STATUS_COLOR: Record<string, string> = {
  empty: "#888",
  pending: "#c58a00",
  ready: "green",
  failed: "crimson",
};

export function ClipFetchPanel() {
  const status = useProjectStore((s) => s.status);
  const slots = useProjectStore((s) => s.slots);
  const fetchStatus = useProjectStore((s) => s.fetchStatus);
  const fetchAllClips = useProjectStore((s) => s.fetchAllClips);

  if (status !== "ready") return null;

  return (
    <div style={{ marginTop: "2rem" }}>
      <button onClick={() => fetchAllClips()} disabled={fetchStatus === "fetching"}>
        {fetchStatus === "fetching" ? "Fetching clips…" : "Fetch clips"}
      </button>
      <table style={{ marginTop: "1rem", fontSize: 12, borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <th>Noun</th>
            <th>Status</th>
            <th>Quality</th>
            <th>Local file</th>
          </tr>
        </thead>
        <tbody>
          {slots.map((slot) => (
            <tr key={slot.id}>
              <td>{slot.noun}</td>
              <td style={{ color: STATUS_COLOR[slot.clip.download_status] }}>
                {slot.clip.download_status}
                {slot.clip.needs_attention ? " ⚠" : ""}
              </td>
              <td>{slot.clip.download_status === "ready" ? slot.clip.quality : "—"}</td>
              <td style={{ fontFamily: "monospace", fontSize: 10 }}>
                {slot.clip.download_status === "failed" && slot.clip.error_message ? (
                  <span style={{ color: "crimson", fontFamily: "inherit" }}>
                    {slot.clip.error_message}
                  </span>
                ) : slot.clip.local_path ? (
                  slot.clip.local_path.split("/").pop()
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
