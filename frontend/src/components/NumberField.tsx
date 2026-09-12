import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

interface Props {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** Units changed per pixel dragged. */
  perPixel?: number;
  decimals?: number;
  suffix?: string;
  disabled?: boolean;
  title?: string;
}

const DRAG_SLOP_PX = 3;

/**
 * A number you drag sideways to change, or click to type into — the compact
 * stand-in for a slider, which is the only reason the old editor needed so
 * much vertical space per control.
 */
export function NumberField({
  label,
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  perPixel = 0.01,
  decimals = 2,
  suffix = "",
  disabled = false,
  title,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const drag = useRef<{ moved: number; value: number } | null>(null);

  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || editing) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { moved: 0, value };
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    state.moved += Math.abs(e.movementX);
    if (state.moved < DRAG_SLOP_PX) return;
    state.value = clamp(state.value + e.movementX * perPixel);
    onChange(Number(state.value.toFixed(decimals + 1)));
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    // A press that never really moved was a click: let them type instead.
    if (state && state.moved < DRAG_SLOP_PX) {
      setDraft(value.toFixed(decimals));
      setEditing(true);
    }
  };

  const commit = () => {
    const parsed = Number.parseFloat(draft);
    if (Number.isFinite(parsed)) onChange(clamp(parsed));
    setEditing(false);
  };

  return (
    <label className="numfield" data-disabled={disabled || undefined} title={title}>
      <span className="numfield-label">{label}</span>
      {editing ? (
        <input
          className="numfield-input"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <div
          className="numfield-value"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          {value.toFixed(decimals)}
          {suffix}
        </div>
      )}
    </label>
  );
}
