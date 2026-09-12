import { useMemo } from "react";
import { cropRectToZoomPan, zoomPanToCropRect } from "../state/crop";
import { useProjectStore } from "../state/projectStore";
import { canStack, maxOverlayDuration, planGroups } from "../state/timeline";
import { NumberField } from "./NumberField";
import { SlotSearchControls } from "./SlotSearchControls";

export function Inspector() {
  const slots = useProjectStore((s) => s.slots);
  const selectedSlotId = useProjectStore((s) => s.selectedSlotId);
  const patchSlotClip = useProjectStore((s) => s.patchSlotClip);
  const patchComposite = useProjectStore((s) => s.patchComposite);
  const rerollComposite = useProjectStore((s) => s.rerollComposite);

  const groups = useMemo(() => planGroups(slots), [slots]);
  const slot = slots.find((s) => s.id === selectedSlotId);

  if (!slot) {
    return (
      <aside className="inspector">
        <p className="inspector-hint">
          {slots.length === 0
            ? "Build a timeline and the clips land here."
            : "Pick a clip on the timeline to trim, reframe or blend it."}
        </p>
      </aside>
    );
  }

  const { zoom, panX, panY } = cropRectToZoomPan(slot.clip.crop_rect);
  const setFraming = (z: number, x: number, y: number) =>
    patchSlotClip(slot.id, { crop_rect: zoomPanToCropRect(z, x, y), zoom: 1 });

  const source = slot.clip.source_duration ?? slot.duration;
  const maxTrim = Math.max(0, source - slot.duration);
  const isOverlay = slot.composite.mode === "overlay";
  const longestBlend = maxOverlayDuration(groups, slot.id);
  const blendLength = slot.composite.duration ?? longestBlend;

  return (
    <aside className="inspector">
      <header className="inspector-head">
        <span className="inspector-noun">{slot.noun}</span>
        <span className="inspector-status" data-status={slot.clip.download_status}>
          {slot.clip.download_status === "ready" ? "clip loaded" : slot.clip.download_status}
        </span>
        <button
          className="icon-btn inspector-dice"
          onClick={() => rerollComposite(slot.id)}
          title="Let the dice decide this cut again"
          aria-label="Randomise this cut"
        >
          🎲
        </button>
      </header>

      {slot.clip.error_message && <p className="error-text">{slot.clip.error_message}</p>}

      <section className="inspector-section">
        <h3>Footage</h3>
        <SlotSearchControls slot={slot} />
      </section>

      <section className="inspector-section">
        <h3>Framing</h3>
        <div className="field-row">
          <NumberField
            label="Zoom"
            value={zoom}
            min={1}
            max={4}
            perPixel={0.01}
            suffix="×"
            title="Drag sideways to zoom; pan appears once you're past 1×"
            onChange={(z) => setFraming(z, z <= 1 ? 0.5 : panX, z <= 1 ? 0.5 : panY)}
          />
          {zoom > 1 && (
            <>
              <NumberField
                label="Pan X"
                value={panX}
                min={0}
                max={1}
                perPixel={0.005}
                onChange={(x) => setFraming(zoom, x, panY)}
              />
              <NumberField
                label="Pan Y"
                value={panY}
                min={0}
                max={1}
                perPixel={0.005}
                onChange={(y) => setFraming(zoom, panX, y)}
              />
            </>
          )}
        </div>
      </section>

      <section className="inspector-section">
        <h3>Timing</h3>
        <div className="field-row">
          <NumberField
            label="Start in source"
            value={slot.clip.trim_start}
            min={0}
            max={maxTrim}
            perPixel={0.02}
            decimals={1}
            suffix="s"
            disabled={maxTrim <= 0}
            onChange={(t) => patchSlotClip(slot.id, { trim_start: t })}
            title="Or drag the clip on the timeline"
          />
        </div>
        <p className="inspector-note">
          {maxTrim > 0
            ? `Plays ${slot.clip.trim_start.toFixed(1)}s–${(slot.clip.trim_start + slot.duration).toFixed(1)}s of ${source.toFixed(0)}s available.`
            : `Plays all ${slot.duration.toFixed(1)}s there is.`}
        </p>
      </section>

      <section className="inspector-section">
        <h3>Sound</h3>
        <div className="field-row">
          <NumberField
            label="Clip volume"
            value={slot.clip.volume * 100}
            min={0}
            max={100}
            perPixel={0.7}
            decimals={0}
            suffix="%"
            disabled={slot.clip.muted}
            onChange={(v) => patchSlotClip(slot.id, { volume: v / 100 })}
          />
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={slot.clip.muted}
            onChange={(e) => patchSlotClip(slot.id, { muted: e.target.checked })}
          />
          Silence this clip
        </label>
      </section>

      <section className="inspector-section">
        <h3>Blend</h3>
        {isOverlay ? (
          <>
            <div className="field-row">
              <NumberField
                label="Strength"
                value={slot.composite.opacity * 100}
                min={5}
                max={100}
                perPixel={0.7}
                decimals={0}
                suffix="%"
                onChange={(v) => patchComposite(slot.id, { opacity: v / 100 })}
              />
              <NumberField
                label="Length"
                value={blendLength}
                min={0.05}
                max={longestBlend}
                perPixel={0.02}
                decimals={2}
                suffix="s"
                onChange={(v) => patchComposite(slot.id, { duration: v })}
              />
            </div>
            <div className="field-row">
              <NumberField
                label="Fade in"
                value={slot.composite.fade_in}
                min={0}
                max={blendLength}
                perPixel={0.02}
                decimals={2}
                suffix="s"
                onChange={(v) => patchComposite(slot.id, { fade_in: v })}
              />
              <NumberField
                label="Fade out"
                value={slot.composite.fade_out}
                min={0}
                max={blendLength}
                perPixel={0.02}
                decimals={2}
                suffix="s"
                onChange={(v) => patchComposite(slot.id, { fade_out: v })}
              />
            </div>
            <button className="btn btn-sm" onClick={() => patchComposite(slot.id, { mode: "cut" })}>
              Cut hard instead
            </button>
          </>
        ) : (
          <>
            <p className="inspector-note">
              This clip cuts straight in. Blending lays it over the clip before it.
            </p>
            <button
              className="btn btn-sm"
              disabled={!canStack(slots, slot.id)}
              title={
                canStack(slots, slot.id)
                  ? undefined
                  : slots[0]?.id === slot.id
                    ? "Nothing runs before the first clip"
                    : "That stack is already three layers deep"
              }
              onClick={() => patchComposite(slot.id, { mode: "overlay" })}
            >
              Blend over previous
            </button>
          </>
        )}
      </section>
    </aside>
  );
}
