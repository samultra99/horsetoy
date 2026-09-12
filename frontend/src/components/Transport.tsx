import { useMemo } from "react";
import { useProjectStore } from "../state/projectStore";
import { planGroups, timelineEnd } from "../state/timeline";
import { formatTime } from "./PreviewStage";

export function Transport() {
  const slots = useProjectStore((s) => s.slots);
  const playing = useProjectStore((s) => s.playing);
  const setPlaying = useProjectStore((s) => s.setPlaying);
  const playhead = useProjectStore((s) => s.playhead);
  const setPlayhead = useProjectStore((s) => s.setPlayhead);
  const narrationMuted = useProjectStore((s) => s.narrationMuted);
  const toggleNarrationMuted = useProjectStore((s) => s.toggleNarrationMuted);

  const end = useMemo(() => timelineEnd(planGroups(slots)), [slots]);
  if (slots.length === 0) return null;

  return (
    <div className="transport">
      <button
        className="icon-btn"
        onClick={() => setPlayhead(0)}
        title="Back to the start"
        aria-label="Back to the start"
      >
        ⏮
      </button>
      <button
        className="icon-btn icon-btn-play"
        onClick={() => setPlaying(!playing)}
        title={playing ? "Pause (space)" : "Play (space)"}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? "⏸" : "▶"}
      </button>
      <span className="transport-time">
        {formatTime(playhead)} <span className="transport-sep">/</span> {formatTime(end)}
      </span>
      <label className="checkbox-row transport-mute">
        <input type="checkbox" checked={narrationMuted} onChange={() => toggleNarrationMuted()} />
        Mute narration
      </label>
    </div>
  );
}
