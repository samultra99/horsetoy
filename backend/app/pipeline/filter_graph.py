"""Builds an ffmpeg filter_complex graph from a Project's ready slots and
renders a single MP4.

The export timeline starts at t=0 of the narration, not at the first noun's
spoken timestamp: the lead-in words before the first noun (e.g. "The old"
before "wizard") aren't associated with any noun/slot, so rather than leave
them as a black gap, the first slot's clip is simply extended backward to
also cover that lead-in — it starts playing at t=0 and runs through its
normal end point instead of only starting when its noun is spoken.

Compositing: consecutive slots sharing a "stack" (composite.mode=="overlay")
are rendered as layered video over the combined time span of the stack,
rather than each getting its own exclusive slice of the timeline. The base
layer's clip is extended to cover the whole stack's duration; each
additional layer is alpha-blended on top for composite.duration seconds
(defaulting to "until the stack ends"), with optional alpha fades at each
end. Stacks ("groups") are then concatenated like hard cuts.

Every layer is padded (video: last frame cloned, audio: silence) and then
hard-trimmed to *exactly* its planned duration. This matters more than it
looks: a source clip is often shorter than the span it has to cover — most
of all a base layer stretched over a whole stack — and without the padding
that segment just comes out short, which drags every later cut out of sync
with the narration and makes the overlays look like they never applied.

Audio mixes use normalize=0 throughout, so a clip's level in the export is
the level the editor's preview played it at, regardless of how many layers
happen to be stacked at that moment.

Crop/zoom: crop_rect (x/y/w/h, all fractions of the source frame) and zoom
are applied before the final "cover" scale+crop safety net that guarantees
exact output dimensions regardless of what the user's crop selection was.
"""

import subprocess
from dataclasses import dataclass
from pathlib import Path

from app.models.project import CropRect, Project, Slot

OUTPUT_WIDTH = 1920
OUTPUT_HEIGHT = 1080
# Sources come back from YouTube at whatever frame rate they like. Pinning
# one rate keeps concat happy across segments, and tpad needs a known rate
# in front of it or its padding silently becomes a no-op (see below).
OUTPUT_FPS = 30
MIN_OVERLAY_DURATION = 0.05


class RenderError(Exception):
    pass


@dataclass
class LayerPlan:
    slot: Slot
    offset: float  # seconds from the start of the group
    duration: float  # how long this layer is on screen
    is_base: bool


@dataclass
class GroupPlan:
    start: float  # in narration time
    end: float  # in narration time
    layers: list[LayerPlan]

    @property
    def duration(self) -> float:
        return self.end - self.start


def plan_groups(slots: list[Slot]) -> list[GroupPlan]:
    """Turns a flat slot list into the stacked groups that get concatenated.

    The one source of truth for "what ends up on screen when" — the renderer
    below builds directly from this, and the editor's live preview mirrors
    the same rules so what you scrub through is what you export.
    """
    if not slots:
        return []

    runs: list[list[Slot]] = []
    for slot in slots:
        if slot.composite.mode == "cut" or not runs:
            runs.append([slot])
        else:
            runs[-1].append(slot)

    # Everything spoken before the first noun still needs a picture over it,
    # so the first group reaches back to t=0.
    lead_in = slots[0].start_time

    plans: list[GroupPlan] = []
    for i, run in enumerate(runs):
        start = run[0].start_time - lead_in if i == 0 else run[0].start_time
        end = run[-1].start_time + run[-1].duration

        layers = [LayerPlan(slot=run[0], offset=0.0, duration=end - start, is_base=True)]
        for slot in run[1:]:
            offset = slot.start_time - start
            available = end - slot.start_time
            requested = slot.composite.duration
            duration = available if requested is None else min(max(requested, MIN_OVERLAY_DURATION), available)
            layers.append(LayerPlan(slot=slot, offset=offset, duration=duration, is_base=False))

        plans.append(GroupPlan(start=start, end=end, layers=layers))
    return plans


def _crop_zoom_filter(label_in: str, label_out: str, crop_rect: CropRect, zoom: float) -> str:
    zoom = max(zoom, 0.01)
    eff_w = min(max(crop_rect.w / zoom, 0.05), 1.0)
    eff_h = min(max(crop_rect.h / zoom, 0.05), 1.0)
    eff_x = min(max(crop_rect.x + (crop_rect.w - eff_w) / 2, 0.0), 1.0 - eff_w)
    eff_y = min(max(crop_rect.y + (crop_rect.h - eff_h) / 2, 0.0), 1.0 - eff_h)
    return (
        f"[{label_in}]crop=iw*{eff_w}:ih*{eff_h}:iw*{eff_x}:ih*{eff_y},"
        f"scale={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,"
        f"crop={OUTPUT_WIDTH}:{OUTPUT_HEIGHT},setsar=1[{label_out}]"
    )


def _video_layer_filters(input_index: int, label_out: str, layer: LayerPlan) -> list[str]:
    """Source -> exactly `layer.duration` of cropped, correctly-timed video."""
    clip = layer.slot.clip
    d = layer.duration
    raw = f"{label_out}_raw"
    cropped = f"{label_out}_crop"
    exact = f"{label_out}_exact"

    parts = [
        f"[{input_index}:v]trim=duration={d},setpts=PTS-STARTPTS[{raw}]",
        _crop_zoom_filter(raw, cropped, clip.crop_rect, clip.zoom),
        # Clone the last frame if the source ran dry, then clamp: the segment
        # is exactly d long whatever the source had to offer. The fps filter
        # is load-bearing — after setpts above the stream has no frame-rate
        # metadata left, and tpad quietly pads nothing at all without it.
        f"[{cropped}]fps={OUTPUT_FPS},tpad=stop_mode=clone:stop_duration={d},"
        f"trim=duration={d},setpts=PTS-STARTPTS[{exact}]",
    ]

    if layer.is_base:
        parts.append(f"[{exact}]null[{label_out}]")
        return parts

    composite = layer.slot.composite
    chain = [f"[{exact}]format=yuva420p"]
    # Fades are timed against the layer's own content, so they go on before
    # the shift below moves the whole layer to its place in the group.
    fade_in = min(max(composite.fade_in, 0.0), d)
    fade_out = min(max(composite.fade_out, 0.0), d)
    if fade_in > 0:
        chain.append(f"fade=t=in:st=0:d={fade_in}:alpha=1")
    if fade_out > 0:
        chain.append(f"fade=t=out:st={max(d - fade_out, 0.0)}:d={fade_out}:alpha=1")
    chain.append(f"colorchannelmixer=aa={min(max(composite.opacity, 0.0), 1.0)}")
    if layer.offset > 0:
        # Shifting the PTS is what actually works here. Padding the front of
        # the layer with transparent frames (tpad ... color=black@0) reads as
        # the more explicit way to say the same thing, but it silently drops
        # the blend entirely — verified against rendered pixels.
        chain.append(f"setpts=PTS+{layer.offset}/TB")
    parts.append(",".join(chain) + f"[{label_out}]")
    return parts


def _audio_layer_filters(input_index: int, label_out: str, layer: LayerPlan) -> str:
    clip = layer.slot.clip
    d = layer.duration
    volume = 0 if clip.muted else clip.volume
    chain = (
        f"[{input_index}:a]atrim=duration={d},asetpts=PTS-STARTPTS,volume={volume},"
        f"apad=whole_dur={d},atrim=duration={d},asetpts=PTS-STARTPTS"
    )
    if layer.offset > 0:
        delay_ms = int(layer.offset * 1000)
        chain += f",adelay={delay_ms}|{delay_ms}"
    return chain + f"[{label_out}]"


def render_export(project: Project, output_path: Path) -> None:
    slots = project.slots
    if not slots:
        raise RenderError("project has no slots")

    not_ready = [s for s in slots if s.clip.download_status != "ready" or not s.clip.local_path]
    if not_ready:
        names = ", ".join(s.noun for s in not_ready)
        raise RenderError(f"clips not ready for: {names}")

    groups = plan_groups(slots)

    inputs: list[str] = []
    filter_parts: list[str] = []
    input_index = 0
    group_video_labels: list[str] = []
    group_audio_labels: list[str] = []

    for g, group in enumerate(groups):
        layer_video_labels: list[str] = []
        layer_audio_labels: list[str] = []

        for k, layer in enumerate(group.layers):
            inputs += ["-ss", f"{layer.slot.clip.trim_start}", "-i", layer.slot.clip.local_path]
            i = input_index
            input_index += 1

            v_label = f"g{g}v{k}"
            filter_parts += _video_layer_filters(i, v_label, layer)
            layer_video_labels.append(v_label)

            a_label = f"g{g}a{k}"
            filter_parts.append(_audio_layer_filters(i, a_label, layer))
            layer_audio_labels.append(a_label)

        running = layer_video_labels[0]
        for v_label in layer_video_labels[1:]:
            out_label = f"{running}_ov"
            # eof_action=pass + repeatlast=0: once a layer's window is over it
            # disappears cleanly instead of freezing on its last frame.
            filter_parts.append(
                f"[{running}][{v_label}]overlay=x=0:y=0:eof_action=pass:repeatlast=0[{out_label}]"
            )
            running = out_label
        # The overlay chain can only ever shorten things if a layer misbehaves;
        # clamp the group to its planned length so concat stays in step.
        v_group = f"g{g}vout"
        filter_parts.append(
            f"[{running}]fps={OUTPUT_FPS},tpad=stop_mode=clone:stop_duration={group.duration},"
            f"trim=duration={group.duration},setpts=PTS-STARTPTS[{v_group}]"
        )
        group_video_labels.append(v_group)

        a_group = f"g{g}aout"
        n_audio = len(layer_audio_labels)
        if n_audio == 1:
            mixed = layer_audio_labels[0]
        else:
            mixed = f"g{g}amix"
            audio_inputs = "".join(f"[{label}]" for label in layer_audio_labels)
            filter_parts.append(
                f"{audio_inputs}amix=inputs={n_audio}:duration=longest:normalize=0[{mixed}]"
            )
        filter_parts.append(
            f"[{mixed}]apad=whole_dur={group.duration},atrim=duration={group.duration},"
            f"asetpts=PTS-STARTPTS[{a_group}]"
        )
        group_audio_labels.append(a_group)

    n_groups = len(groups)
    video_concat_inputs = "".join(f"[{label}]" for label in group_video_labels)
    audio_concat_inputs = "".join(f"[{label}]" for label in group_audio_labels)
    filter_parts.append(f"{video_concat_inputs}concat=n={n_groups}:v=1:a=0[vconcat]")
    filter_parts.append(f"{audio_concat_inputs}concat=n={n_groups}:v=0:a=1[aclips]")

    total_duration = sum(group.duration for group in groups)

    narration_label = None
    if project.narration.audio_path:
        # groups[0].start is already 0 (the lead-in is folded into the first
        # group), so the narration starts from the true top of the paragraph.
        inputs += ["-ss", f"{groups[0].start}", "-i", project.narration.audio_path]
        narration_input_index = input_index
        input_index += 1
        volume = 0 if project.narration.muted else 1
        filter_parts.append(
            f"[{narration_input_index}:a]atrim=duration={total_duration},"
            f"asetpts=PTS-STARTPTS,volume={volume},apad=whole_dur={total_duration},"
            f"atrim=duration={total_duration},asetpts=PTS-STARTPTS[anarr]"
        )
        narration_label = "[anarr]"

    if narration_label:
        filter_parts.append(
            f"[aclips]{narration_label}amix=inputs=2:duration=first:dropout_transition=0:"
            f"normalize=0[aout]"
        )
    else:
        filter_parts.append("[aclips]anull[aout]")

    filter_complex = ";".join(filter_parts)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        "ffmpeg",
        "-y",
        *inputs,
        "-filter_complex",
        filter_complex,
        "-map",
        "[vconcat]",
        "-map",
        "[aout]",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        str(output_path),
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RenderError(f"ffmpeg failed: {result.stderr[-2000:]}")
