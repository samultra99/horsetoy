import { useEffect, useRef, useState, type CSSProperties } from "react";
import { API_BASE, type Slot } from "../../api/client";
import { useProjectStore } from "../../state/projectStore";
import { SlotSearchControls } from "./SlotSearchControls";

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

const CARD_STYLE: CSSProperties = {
  border: "1px solid #444",
  borderRadius: 6,
  padding: "0.75rem",
  marginTop: "0.75rem",
  display: "flex",
  gap: "1rem",
  flexWrap: "wrap",
};

export function SlotEditorCard({ slot }: { slot: Slot }) {
  const patchSlotClip = useProjectStore((s) => s.patchSlotClip);
  const rerollComposite = useProjectStore((s) => s.rerollComposite);

  const initial = cropRectToZoomPan(slot.clip.crop_rect);
  const [zoom, setZoom] = useState(initial.zoom);
  const [panX, setPanX] = useState(initial.panX);
  const [panY, setPanY] = useState(initial.panY);
  const [trimStart, setTrimStart] = useState(slot.clip.trim_start);
  const [volume, setVolume] = useState(slot.clip.volume);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const volumeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const next = cropRectToZoomPan(slot.clip.crop_rect);
    setZoom(next.zoom);
    setPanX(next.panX);
    setPanY(next.panY);
    setTrimStart(slot.clip.trim_start);
    setVolume(slot.clip.volume);
    // Only re-sync from server state when the slot identity changes, not on
    // every render — local slider drags shouldn't get clobbered by the
    // debounced PATCH's own response echoing back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot.id]);

  // Preview should only ever show the window that will actually end up in
  // the export: seek to trim_start immediately when it changes (so dragging
  // the slider gives instant visual feedback), and loop back to trim_start
  // once playback reaches the end of the slot's fixed-length window rather
  // than looping the whole source file.
  useEffect(() => {
    const v = videoRef.current;
    if (v && Math.abs(v.currentTime - trimStart) > 0.05) {
      v.currentTime = trimStart;
    }
  }, [trimStart]);

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

  const scheduleVolumePatch = (nextVolume: number) => {
    if (volumeDebounceRef.current) clearTimeout(volumeDebounceRef.current);
    volumeDebounceRef.current = setTimeout(() => {
      patchSlotClip(slot.id, { volume: nextVolume });
    }, 250);
  };

  const compositeLabel =
    slot.composite.mode === "overlay" ? `overlay ×${slot.composite.layer + 1}` : COMPOSITE_LABEL.cut;

  // A failed fetch still gets a card — without the video/crop/trim/volume
  // controls, which need an actual downloaded clip — so the user has a way
  // to retry (next-video/new-search/manual-search) instead of being stuck.
  if (slot.clip.download_status === "failed") {
    return (
      <div style={CARD_STYLE}>
        <div style={{ flex: "1 1 200px", fontSize: 12, minWidth: 200 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
            <strong>{slot.noun}</strong>
            <span style={{ color: "crimson" }}>fetch failed</span>
          </div>
          {slot.clip.error_message && (
            <div style={{ color: "crimson", marginBottom: "0.5rem" }}>{slot.clip.error_message}</div>
          )}
          <SlotSearchControls slot={slot} />
        </div>
      </div>
    );
  }

  if (slot.clip.download_status !== "ready" || !slot.clip.local_path) return null;

  const sourceDuration = slot.clip.source_duration ?? slot.duration;
  const trimMax = Math.max(0, sourceDuration - slot.duration);

  // Mirrors the backend's crop math exactly: the video is rendered at
  // zoom×100% of the frame, then shifted by pan × the room left over after
  // zooming (so pan has no effect at zoom=1, same as the backend's
  // maxOffset = 1 - eff_size going to 0).
  const videoStyle = {
    position: "absolute" as const,
    width: `${zoom * 100}%`,
    height: `${zoom * 100}%`,
    left: `${-(zoom - 1) * panX * 100}%`,
    top: `${-(zoom - 1) * panY * 100}%`,
    objectFit: "cover" as const,
  };

  return (
    <div style={CARD_STYLE}>
      <div
        style={{
          width: 220,
          aspectRatio: "16 / 9",
          overflow: "hidden",
          borderRadius: 4,
          background: "#000",
          position: "relative",
          flexShrink: 0,
          alignSelf: "flex-start",
        }}
      >
        <video
          ref={videoRef}
          src={clipVideoUrl(slot.clip.local_path)}
          muted
          autoPlay
          playsInline
          onLoadedMetadata={(e) => {
            e.currentTarget.currentTime = trimStart;
          }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            if (v.currentTime >= trimStart + slot.duration) {
              v.currentTime = trimStart;
            }
          }}
          style={videoStyle}
        />
      </div>

      <div style={{ flex: "1 1 200px", fontSize: 12, minWidth: 200 }}>
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

        <div
          style={{
            marginBottom: "0.75rem",
            paddingBottom: "0.5rem",
            borderBottom: "1px solid #333",
          }}
        >
          <SlotSearchControls slot={slot} />
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
              // Panning has no effect until zoomed in — reset it to center
              // so a later zoom-in starts from a predictable position.
              if (next <= 1 && zoom > 1) {
                setPanX(0.5);
                setPanY(0.5);
              }
              scheduleCropPatch(next, panX, panY);
            }}
            style={{ width: "100%" }}
          />
        </label>
        <label style={{ display: "block", marginBottom: 4, opacity: zoom > 1 ? 1 : 0.4 }}>
          Pan X {zoom <= 1 ? "(zoom in to pan)" : ""}
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={panX}
            disabled={zoom <= 1}
            onChange={(e) => {
              const next = parseFloat(e.target.value);
              setPanX(next);
              scheduleCropPatch(zoom, next, panY);
            }}
            style={{ width: "100%" }}
          />
        </label>
        <label style={{ display: "block", marginBottom: 4, opacity: zoom > 1 ? 1 : 0.4 }}>
          Pan Y {zoom <= 1 ? "(zoom in to pan)" : ""}
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={panY}
            disabled={zoom <= 1}
            onChange={(e) => {
              const next = parseFloat(e.target.value);
              setPanY(next);
              scheduleCropPatch(zoom, panX, next);
            }}
            style={{ width: "100%" }}
          />
        </label>
        <label style={{ display: "block" }}>
          {trimMax > 0
            ? `Which ${slot.duration.toFixed(1)}s of the source clip plays: ${trimStart.toFixed(1)}s–${(trimStart + slot.duration).toFixed(1)}s (of ${sourceDuration.toFixed(0)}s available)`
            : `This clip plays in full (${slot.duration.toFixed(1)}s) — no extra source footage to slide within`}
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
        <label style={{ display: "block", marginTop: 8, opacity: slot.clip.muted ? 0.4 : 1 }}>
          Clip volume in export: {slot.clip.muted ? "muted" : `${Math.round(volume * 100)}%`}
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            disabled={slot.clip.muted}
            onChange={(e) => {
              const next = parseFloat(e.target.value);
              setVolume(next);
              scheduleVolumePatch(next);
            }}
            style={{ width: "100%" }}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4 }}>
          <input
            type="checkbox"
            checked={slot.clip.muted}
            onChange={(e) => patchSlotClip(slot.id, { muted: e.target.checked })}
          />
          Mute this clip's audio in export
        </label>
      </div>
    </div>
  );
}
