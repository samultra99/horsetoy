import { useState } from "react";
import { API_BASE } from "../../api/client";
import { useProjectStore } from "../../state/projectStore";

export function TimelineTrack() {
  const status = useProjectStore((s) => s.status);
  const narrationAudioUrl = useProjectStore((s) => s.narrationAudioUrl);
  const totalDuration = useProjectStore((s) => s.totalDuration);
  const nouns = useProjectStore((s) => s.nouns);
  const [currentTime, setCurrentTime] = useState(0);

  if (status !== "ready" || !narrationAudioUrl) return null;

  const timedNouns = nouns
    .filter((n) => n.start_time !== null)
    .sort((a, b) => (a.start_time as number) - (b.start_time as number));

  let activeIndex = -1;
  timedNouns.forEach((n, i) => {
    if ((n.start_time as number) <= currentTime) activeIndex = i;
  });

  return (
    <div style={{ marginTop: "2rem" }}>
      <audio
        src={`${API_BASE}${narrationAudioUrl}`}
        controls
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        style={{ width: "100%" }}
      />
      <div
        style={{
          position: "relative",
          height: 60,
          background: "var(--timeline-bg, #eee)",
          marginTop: "2rem",
          borderRadius: 4,
        }}
      >
        {timedNouns.map((n, i) => {
          const pct = totalDuration > 0 ? ((n.start_time as number) / totalDuration) * 100 : 0;
          const isActive = i === activeIndex;
          return (
            <div
              key={n.id}
              title={`${n.noun_text} @ ${(n.start_time as number).toFixed(2)}s`}
              style={{
                position: "absolute",
                left: `${pct}%`,
                top: 0,
                bottom: 0,
                width: 2,
                background: isActive ? "crimson" : "#888",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: -22,
                  left: 4,
                  fontSize: 11,
                  whiteSpace: "nowrap",
                  fontWeight: isActive ? "bold" : "normal",
                  color: isActive ? "crimson" : "#333",
                }}
              >
                {n.noun_text}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
