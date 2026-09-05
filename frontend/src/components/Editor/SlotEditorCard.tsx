import { useEffect, useRef, useState } from "react";
import { API_BASE, type Slot } from "../../api/client";
import { useProjectStore } from "../../state/projectStore";

function clipVideoUrl(localPath: string): string {
  const filename = localPath.split("/").pop() ?? "";
  return `${API_BASE}/media/clips/${encodeURIComponent(filename)}`;
}

// Reconstructs UI-friendly zoom/pan from a stored crop_rect (assumes square
// effective width/height, which is all this editor ever writes back).
function cropRectToZoomPan(crop_rect: Slot["clip"]["crop_rect"]) {
  const zoom = crop_rect.w > 0 ? 1 / crop_rect.w : 1;
  const maxOffset = 1 - crop_rect.w;
  const panX = maxOffset > 0 ? crop_rect.x / maxOffset : 0.5;
  const panY = maxOffset > 0 ? crop_rect.y / maxOffset : 0.5;
  return { zoom, panX, panY };
}

function zoomPanToCropRect(zoom: number, panX: number, panY: number) {
  const size = 1 / zoom;
  const maxOffset = 1 - size;
  return { x: panX * maxOffset, y: panY * maxOffset, w: size, h: size };
}

const COMPOSITE_LABEL: Record<string, string> = {
  cut: "cut",
};

export function SlotEditorCard({ slot }: { slot: Slot }) {
  const patchSlotClip = useProjectStore((s) => s.patchSlotClip);
  const rerollComposite = useProjectStore((s) => s.rerollComposite);

  const initial = cropRectToZoomPan(slot.clip.crop_rect);
  const [zoom, setZoom] = useState(initial.zoom);
  const [panX, setPanX] = useState(initial.panX);
  const [panY, setPanY] = useState(initial.panY);
  const [trimStart, setTrimStart] = useState(slot.clip.trim_start);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const next = cropRectToZoomPan(slot.clip.crop_rect);
    setZoom(next.zoom);
    setPanX(next.panX);
    setPanY(next.panY);
    setTrimStart(slot.clip.trim_start);
    // Only re-sync from server state when the slot identity changes, not on
    // every render — local slider drags shouldn't get clobbered by the
    // debounced PATCH's own response echoing back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot.id]);

  const scheduleCropPatch = (nextZoom: number, nextPanX: number, nextPanY: number) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const crop_rect = zoomPanToCropRect(nextZoom, nextPanX, nextPanY);
      patchSlotClip(slot.id, { crop_rect, zoom: 1.0 });
    }, 250);
  };

  const scheduleTrimPatch = (nextTrimStart: number) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      patchSlotClip(slot.id, { trim_start: nextTrimStart });
    }, 250);
  };

  if (slot.clip.download_status !== "ready" || !slot.clip.local_path) return null;

  const sourceDuration = slot.clip.source_duration ?? slot.duration;
  const trimMax = Math.max(0, sourceDuration - slot.duration);
  const compositeLabel =
    slot.composite.mode === "overlay" ? `overlay ×${slot.composite.layer + 1}` : COMPOSITE_LABEL.cut;

  return (
    <div
      style={{
        border: "1px solid #444",
        borderRadius: 6,
        padding: "0.75rem",
        marginTop: "0.75rem",
        display: "flex",
        gap: "1rem",
      }}
    >
      <div
        style={{
          width: 101,
          aspectRatio: "9 / 16",
          overflow: "hidden",
          borderRadius: 4,
          background: "#000",
          flexShrink: 0,
        }}
      >
        <video
          src={clipVideoUrl(slot.clip.local_path)}
          muted
          loop
          autoPlay
          playsInline
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: `scale(${zoom})`,
            transformOrigin: `${panX * 100}% ${panY * 100}%`,
          }}
        />
      </div>

      <div style={{ flex: 1, fontSize: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
          <strong>{slot.noun}</strong>
          <span style={{ color: "#888" }}>{compositeLabel}</span>
          <button
            title="Re-roll cut/overlay"
            onClick={() => rerollComposite(slot.id)}
            style={{ fontSize: 11, padding: "1px 6px" }}
          >
            🎲
          </button>
        </div>

        <label style={{ display: "block", marginBottom: 4 }}>
          Zoom {zoom.toFixed(2)}×
          <input
            type="range"
            min={1}
            max={3}
            step={0.05}
            value={zoom}
            onChange={(e) => {
              const next = parseFloat(e.target.value);
              setZoom(next);
              scheduleCropPatch(next, panX, panY);
            }}
            style={{ width: "100%" }}
          />
        </label>
        <label style={{ display: "block", marginBottom: 4 }}>
          Pan X
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={panX}
            onChange={(e) => {
              const next = parseFloat(e.target.value);
              setPanX(next);
              scheduleCropPatch(zoom, next, panY);
            }}
            style={{ width: "100%" }}
          />
        </label>
        <label style={{ display: "block", marginBottom: 4 }}>
          Pan Y
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={panY}
            onChange={(e) => {
              const next = parseFloat(e.target.value);
              setPanY(next);
              scheduleCropPatch(zoom, panX, next);
            }}
            style={{ width: "100%" }}
          />
        </label>
        <label style={{ display: "block" }}>
          Trim start {trimStart.toFixed(1)}s (window {slot.duration.toFixed(1)}s)
          <input
            type="range"
            min={0}
            max={trimMax}
            step={0.1}
            value={trimStart}
            disabled={trimMax <= 0}
            onChange={(e) => {
              const next = parseFloat(e.target.value);
              setTrimStart(next);
              scheduleTrimPatch(next);
            }}
            style={{ width: "100%" }}
          />
        </label>
      </div>
    </div>
  );
}
