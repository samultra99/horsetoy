import { useState } from "react";
import type { Slot } from "../api/client";
import { useProjectStore } from "../state/projectStore";

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
      <div className="swap-clip-row">
        <button
          className="icon-btn"
          title="Try the next video for this search"
          aria-label="Next video"
          onClick={() => nextVideo(slot.id)}
          disabled={busy}
        >
          {busy ? "…" : "⏭"}
        </button>
        <button
          className="icon-btn"
          title="Start a fresh random search"
          aria-label="New search"
          onClick={() => newSearch(slot.id)}
          disabled={busy}
        >
          {busy ? "…" : "🔄"}
        </button>
        <form
          className="swap-clip-search"
          onSubmit={(e) => {
            e.preventDefault();
            const query = manualQuery.trim();
            if (query) {
              manualSearch(slot.id, query);
              setManualQuery("");
            }
          }}
        >
          <input
            type="text"
            className="text-input"
            value={manualQuery}
            onChange={(e) => setManualQuery(e.target.value)}
            placeholder="Type your own search…"
            disabled={busy}
          />
          <button
            type="submit"
            className="icon-btn"
            title="Search for this instead"
            aria-label="Search"
            disabled={busy || !manualQuery.trim()}
          >
            🔍
          </button>
        </form>
      </div>
      <div className="swap-clip-query">
        Searching: <em>{activeQuery || "…"}</em>
      </div>
      {actionStatus === "error" && actionError && <div className="error-text">{actionError}</div>}
    </div>
  );
}
