import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Slot } from "../api/client";
import { useProjectStore } from "../state/projectStore";
import {
  MIN_OVERLAY_DURATION,
  canStack,
  maxOverlayDuration,
  planGroups,
  timelineEnd,
  type Layer,
} from "../state/timeline";

const DRAG_SLOP_PX = 3;

function tickStep(span: number): number {
  for (const step of [0.5, 1, 2, 5, 10, 15, 30, 60]) {
    if (span / step <= 12) return step;
  }
  return 120;
}

function maxTrimFor(slot: Slot): number {
  const source = slot.clip.source_duration ?? slot.duration;
  return Math.max(0, source - slot.duration);
}

export function Timeline() {
  const slots = useProjectStore((s) => s.slots);
  const selectedSlotId = useProjectStore((s) => s.selectedSlotId);
  const select = useProjectStore((s) => s.select);
  const playhead = useProjectStore((s) => s.playhead);
  const setPlayhead = useProjectStore((s) => s.setPlayhead);
  const setPlaying = useProjectStore((s) => s.setPlaying);
  const patchSlotClip = useProjectStore((s) => s.patchSlotClip);
  const patchComposite = useProjectStore((s) => s.patchComposite);

  const trackRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const scrubbing = useRef(false);
  const drag = useRef<{ kind: "slip" | "length"; slot: Slot; startX: number; start: number; moved: number } | null>(
    null,
  );

  const groups = useMemo(() => planGroups(slots), [slots]);
  const end = timelineEnd(groups);
  const pps = end > 0 && width > 0 ? width / end : 0;
  const depth = Math.max(0, ...groups.flatMap((g) => g.layers.map((l) => l.depth)));

  // Re-runs when the first slots arrive: before that this component renders
  // its empty state instead, so there is no element to measure yet.
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [slots.length]);

  const timeAt = (clientX: number) => {
    const el = trackRef.current;
    if (!el || pps === 0) return 0;
    return Math.min(end, Math.max(0, (clientX - el.getBoundingClientRect().left) / pps));
  };

  const beginScrub = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubbing.current = true;
    setPlaying(false);
    setPlayhead(timeAt(e.clientX));
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (scrubbing.current) {
      setPlayhead(timeAt(e.clientX));
      return;
    }
    const state = drag.current;
    if (!state || pps === 0) return;
    const dx = e.clientX - state.startX;
    state.moved += Math.abs(e.movementX);
    if (state.moved < DRAG_SLOP_PX) return;

    if (state.kind === "slip") {
      // Drag the picture and the source window slides under it, the way a
      // slip edit does — the clip keeps its place and length on the timeline.
      const next = Math.min(maxTrimFor(state.slot), Math.max(0, state.start - dx / pps));
      patchSlotClip(state.slot.id, { trim_start: next });
    } else {
      const longest = maxOverlayDuration(groups, state.slot.id);
      const next = Math.min(longest, Math.max(MIN_OVERLAY_DURATION, state.start + dx / pps));
      patchComposite(state.slot.id, { duration: next });
    }
  };

  const endPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    scrubbing.current = false;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const beginDrag = (
    e: ReactPointerEvent<HTMLDivElement>,
    kind: "slip" | "length",
    layer: Layer,
    start: number,
  ) => {
    e.stopPropagation();
    (e.currentTarget.closest(".tl-body") as HTMLElement)?.setPointerCapture(e.pointerId);
    drag.current = { kind, slot: layer.slot, startX: e.clientX, start, moved: 0 };
    select(layer.slot.id);
    // Editing a clip you can't see is guesswork, so park the playhead inside
    // it first if it was somewhere else entirely.
    if (playhead < layer.start || playhead >= layer.end) {
      setPlaying(false);
      setPlayhead(layer.start + Math.min(0.2, (layer.end - layer.start) / 2));
    }
  };

  if (slots.length === 0) {
    return <div className="timeline timeline-empty">The timeline appears here once you build one.</div>;
  }

  const step = tickStep(end);
  const ticks: number[] = [];
  for (let t = 0; t <= end + 0.001; t += step) ticks.push(t);

  return (
    <div className="timeline">
      <div
        className="tl-body"
        ref={trackRef}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
      >
        <div className="tl-ruler" onPointerDown={beginScrub}>
          {ticks.map((t) => (
            <span key={t} className="tl-tick" style={{ left: `${t * pps}px` }}>
              {t.toFixed(step < 1 ? 1 : 0)}s
            </span>
          ))}
        </div>

        <div className="tl-junctions">
          {slots.slice(1).map((slot) => {
            const overlaid = slot.composite.mode === "overlay";
            const stackable = canStack(slots, slot.id);
            return (
              <button
                key={slot.id}
                className="tl-junction"
                data-on={overlaid || undefined}
                style={{ left: `${slot.start_time * pps}px` }}
                disabled={!overlaid && !stackable}
                title={
                  overlaid
                    ? `Cut hard into "${slot.noun}" instead of blending`
                    : stackable
                      ? `Blend "${slot.noun}" over the clip before it`
                      : "This stack is already three layers deep"
                }
                onClick={() => {
                  patchComposite(slot.id, { mode: overlaid ? "cut" : "overlay" });
                  select(slot.id);
                }}
              >
                {overlaid ? "×" : "+"}
              </button>
            );
          })}
        </div>

        <div
          className="tl-tracks"
          style={{ height: `${(depth + 1) * 46}px` }}
          onPointerDown={beginScrub}
        >
          {groups.flatMap((group) =>
            group.layers.map((layer) => (
              <ClipBlock
                key={layer.slot.id}
                layer={layer}
                pps={pps}
                selected={layer.slot.id === selectedSlotId}
                onSelect={() => select(layer.slot.id)}
                onSlipStart={(e) => beginDrag(e, "slip", layer, layer.slot.clip.trim_start)}
                onLengthStart={(e) => beginDrag(e, "length", layer, layer.end - layer.start)}
              />
            )),
          )}
        </div>

        <div className="tl-playhead" style={{ left: `${playhead * pps}px` }} />
      </div>
    </div>
  );
}

function ClipBlock({
  layer,
  pps,
  selected,
  onSelect,
  onSlipStart,
  onLengthStart,
}: {
  layer: Layer;
  pps: number;
  selected: boolean;
  onSelect: () => void;
  onSlipStart: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onLengthStart: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const { slot } = layer;
  const width = (layer.end - layer.start) * pps;
  const status = slot.clip.download_status;
  const composite = slot.composite;

  return (
    <div
      className="tl-clip"
      data-status={status}
      data-overlay={!layer.isBase || undefined}
      data-selected={selected || undefined}
      style={{
        left: `${layer.start * pps}px`,
        width: `${Math.max(width, 6)}px`,
        bottom: `${layer.depth * 46}px`,
        // Overlays are drawn at the opacity they will actually blend at, so
        // the strength of the effect is visible without opening anything.
        "--layer-alpha": layer.isBase ? 1 : Math.max(composite.opacity, 0.15),
      } as React.CSSProperties}
      onPointerDown={(e) => {
        onSelect();
        onSlipStart(e);
      }}
      title={
        layer.isBase
          ? `${slot.noun} — drag to slide the footage inside the clip`
          : `${slot.noun} blended over the clip below — drag the right edge to change how long`
      }
    >
      {!layer.isBase && composite.fade_in > 0 && (
        <div className="tl-fade tl-fade-in" style={{ width: `${composite.fade_in * pps}px` }} />
      )}
      {!layer.isBase && composite.fade_out > 0 && (
        <div className="tl-fade tl-fade-out" style={{ width: `${composite.fade_out * pps}px` }} />
      )}
      <span className="tl-clip-label">{slot.noun}</span>
      {status === "pending" && <span className="tl-clip-note">searching…</span>}
      {status === "failed" && <span className="tl-clip-note">no clip</span>}
      {slot.clip.trim_start > 0.05 && layer.isBase && (
        <span className="tl-clip-trim">+{slot.clip.trim_start.toFixed(1)}s</span>
      )}
      {!layer.isBase && (
        <div className="tl-length-handle" onPointerDown={onLengthStart} title="Drag to set how long the blend lasts" />
      )}
    </div>
  );
}

/** Space bar plays and pauses, like every other editor. */
export function usePlaybackShortcuts() {
  const setPlaying = useProjectStore((s) => s.setPlaying);
  const playing = useProjectStore((s) => s.playing);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying(!playing);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, setPlaying]);
}
