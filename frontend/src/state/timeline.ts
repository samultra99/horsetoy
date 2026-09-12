import type { Slot } from "../api/client";

// Must match backend app/pipeline/composite_rng.py's MAX_LAYERS.
export const MAX_COMPOSITE_LAYERS = 3;
export const MIN_OVERLAY_DURATION = 0.05;

export interface Layer {
  slot: Slot;
  start: number; // absolute timeline seconds
  end: number;
  isBase: boolean;
  depth: number; // 0 = base, 1.. = stacked on top
}

export interface Group {
  start: number;
  end: number;
  layers: Layer[];
}

/**
 * Mirrors backend plan_groups() exactly. A run of consecutive slots forms one
 * composited group once a "cut" starts it, for as long as later slots keep
 * saying "overlay"; the base layer stretches over the whole group and each
 * overlay sits on top for its own window.
 *
 * This is deliberately the only place the layout is computed on the client —
 * the preview, the timeline and the export all have to agree about what is on
 * screen when, and the moment they disagree the preview stops being useful.
 */
export function planGroups(slots: Slot[]): Group[] {
  if (slots.length === 0) return [];

  const runs: Slot[][] = [];
  for (const slot of slots) {
    if (slot.composite.mode === "cut" || runs.length === 0) runs.push([slot]);
    else runs[runs.length - 1].push(slot);
  }

  // Whatever is spoken before the first noun still needs a picture over it.
  const leadIn = slots[0].start_time;

  return runs.map((run, i) => {
    const start = i === 0 ? run[0].start_time - leadIn : run[0].start_time;
    const end = run[run.length - 1].start_time + run[run.length - 1].duration;

    const layers: Layer[] = [
      { slot: run[0], start, end, isBase: true, depth: 0 },
    ];
    run.slice(1).forEach((slot, k) => {
      const available = end - slot.start_time;
      const requested = slot.composite.duration;
      const duration =
        requested === null || requested === undefined
          ? available
          : Math.min(Math.max(requested, MIN_OVERLAY_DURATION), available);
      layers.push({
        slot,
        start: slot.start_time,
        end: slot.start_time + duration,
        isBase: false,
        depth: k + 1,
      });
    });

    return { start, end, layers };
  });
}

export function timelineEnd(groups: Group[]): number {
  return groups.length === 0 ? 0 : groups[groups.length - 1].end;
}

/** Layers on screen at time t, bottom first, with the alpha each is drawn at. */
export function layersAt(groups: Group[], t: number): { layer: Layer; alpha: number }[] {
  if (groups.length === 0) return [];
  // Parked at the very end, hold the closing frame rather than cutting to
  // black — that's what the rendered file does too.
  const last = groups[groups.length - 1];
  const clamped = Math.min(Math.max(t, groups[0].start), last.end - 0.001);
  const group = groups.find((g) => clamped >= g.start && clamped < g.end) ?? last;

  const out: { layer: Layer; alpha: number }[] = [];
  for (const layer of group.layers) {
    if (clamped < layer.start || clamped >= layer.end) continue;
    out.push({ layer, alpha: layerAlpha(layer, clamped) });
  }
  return out;
}

/** Peak opacity scaled by wherever the fades are at time t. */
export function layerAlpha(layer: Layer, t: number): number {
  if (layer.isBase) return 1;
  const { opacity, fade_in, fade_out } = layer.slot.composite;
  const into = t - layer.start;
  const left = layer.end - t;
  let alpha = opacity;
  if (fade_in > 0 && into < fade_in) alpha *= Math.max(0, into / fade_in);
  if (fade_out > 0 && left < fade_out) alpha *= Math.max(0, left / fade_out);
  return Math.min(Math.max(alpha, 0), 1);
}

/** Whether `slot` could be stacked onto the clip before it right now. */
export function canStack(slots: Slot[], slotId: string): boolean {
  const i = slots.findIndex((s) => s.id === slotId);
  if (i <= 0) return false;
  const prev = slots[i - 1];
  const prevLayer = prev.composite.mode === "overlay" ? prev.composite.layer : 0;
  return prevLayer + 1 < MAX_COMPOSITE_LAYERS;
}

/** The longest overlay window this slot could occupy, given its group. */
export function maxOverlayDuration(groups: Group[], slotId: string): number {
  for (const group of groups) {
    const layer = group.layers.find((l) => l.slot.id === slotId);
    if (layer) return Math.max(group.end - layer.start, MIN_OVERLAY_DURATION);
  }
  return MIN_OVERLAY_DURATION;
}

/**
 * Where in the source file a layer is playing at timeline time t. Matches the
 * renderer's `-ss trim_start` plus elapsed-time-within-the-layer.
 */
export function sourceTimeFor(layer: Layer, t: number): number {
  return layer.slot.clip.trim_start + Math.max(0, t - layer.start);
}
