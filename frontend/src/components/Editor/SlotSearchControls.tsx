import { useState } from "react";
import type { Slot } from "../../api/client";
import { useProjectStore } from "../../state/projectStore";

export function SlotSearchControls({ slot }: { slot: Slot }) {
  const nextVideo = useProjectStore((s) => s.nextVideo);
  const newSearch = useProjectStore((s) => s.newSearch);
  const manualSearch = useProjectStore((s) => s.manualSearch);
  const actionStatus = useProjectStore((s) => s.slotActionStatus[slot.id] ?? "idle");
  const actionError = useProjectStore((s) => s.slotActionError[slot.id]);
  const [manualQuery, setManualQuery] = useState("");

  const activeQuery =
    slot.search.manual_override ?? slot.search.candidates[slot.search.active_index]?.text ?? "";
  const busy = actionStatus === "loading";

  return (
    <div>
      <div style={{ color: "#888", marginBottom: 4 }}>
        Searching: <em>{activeQuery}</em>
      </div>
      <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.4rem" }}>
        <button onClick={() => nextVideo(slot.id)} disabled={busy}>
          {busy ? "…" : "Next video"}
        </button>
        <button onClick={() => newSearch(slot.id)} disabled={busy}>
          {busy ? "…" : "New search"}
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const query = manualQuery.trim();
          if (query) {
            manualSearch(slot.id, query);
            setManualQuery("");
          }
        }}
        style={{ display: "flex", gap: "0.4rem" }}
      >
        <input
          type="text"
          value={manualQuery}
          onChange={(e) => setManualQuery(e.target.value)}
          placeholder="Type your own search…"
          disabled={busy}
          style={{ flex: 1, fontSize: 12 }}
        />
        <button type="submit" disabled={busy || !manualQuery.trim()}>
          Search
        </button>
      </form>
      {actionStatus === "error" && actionError && (
        <div style={{ color: "crimson", marginTop: 4 }}>{actionError}</div>
      )}
    </div>
  );
}
