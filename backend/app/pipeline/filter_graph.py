"""Builds an ffmpeg filter_complex graph from a Project's ready slots and
renders a single MP4.

v1 simplification: the export timeline starts at the *first* noun's spoken
timestamp, not at t=0 of the narration — the lead-in words before the first
noun aren't covered by any clip, so rather than show a black gap we simply
don't render that lead-in. (A future milestone could instead hold the first
clip for that span; noted as a known v1 limitation, not a bug.)

Compositing: consecutive slots sharing a "stack" (composite.mode=="overlay")
are rendered as layered video over the combined time span of the stack,
rather than each getting its own exclusive slice of the timeline. The base
layer's clip is extended to cover the whole stack's duration; each
additional layer is time-shifted to start at its own moment and alpha-
blended on top via ffmpeg's overlay filter, which naturally holds the layer
below unchanged until the layer above's first shifted frame arrives — so no
explicit "enable" gating is needed. Stacks ("groups") are then concatenated
like the hard-cut segments were in M3.

Crop/zoom: crop_rect (x/y/w/h, all fractions of the source frame) and zoom
are applied before the final "cover" scale+crop safety net that guarantees
exact output dimensions regardless of what the user's crop selection was.
"""

import subprocess
from pathlib import Path

from app.models.project import CropRect, Project, Slot

OUTPUT_WIDTH = 1080
OUTPUT_HEIGHT = 1920
OVERLAY_OPACITY = 0.5


class RenderError(Exception):
    pass


def _group_slots(slots: list[Slot]) -> list[list[Slot]]:
    groups: list[list[Slot]] = []
    for slot in slots:
        if slot.composite.mode == "cut" or not groups:
            groups.append([slot])
        else:
            groups[-1].append(slot)
    return groups


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


def render_export(project: Project, output_path: Path) -> None:
    slots = project.slots
    if not slots:
        raise RenderError("project has no slots")

    not_ready = [s for s in slots if s.clip.download_status != "ready" or not s.clip.local_path]
    if not_ready:
        names = ", ".join(s.noun for s in not_ready)
        raise RenderError(f"clips not ready for: {names}")

    groups = _group_slots(slots)

    inputs: list[str] = []
    filter_parts: list[str] = []
    input_index = 0
    group_video_labels: list[str] = []
    group_audio_labels: list[str] = []

    for g, group in enumerate(groups):
        group_start = group[0].start_time
        group_end = group[-1].start_time + group[-1].duration
        layer_video_labels: list[str] = []
        layer_audio_labels: list[str] = []

        for layer_idx, slot in enumerate(group):
            offset = slot.start_time - group_start
            render_duration = group_end - slot.start_time

            inputs += ["-ss", f"{slot.clip.trim_start}", "-i", slot.clip.local_path]
            i = input_index
            input_index += 1

            v_trimmed = f"g{g}v{layer_idx}t"
            v_cropped = f"g{g}v{layer_idx}c"
            v_final = f"g{g}v{layer_idx}"
            filter_parts.append(f"[{i}:v]trim=duration={render_duration},setpts=PTS-STARTPTS[{v_trimmed}]")
            filter_parts.append(_crop_zoom_filter(v_trimmed, v_cropped, slot.clip.crop_rect, slot.clip.zoom))
            if layer_idx == 0:
                filter_parts.append(f"[{v_cropped}]setpts=PTS+{offset}/TB[{v_final}]")
            else:
                filter_parts.append(
                    f"[{v_cropped}]format=yuva420p,colorchannelmixer=aa={OVERLAY_OPACITY},"
                    f"setpts=PTS+{offset}/TB[{v_final}]"
                )
            layer_video_labels.append(v_final)

            a_final = f"g{g}a{layer_idx}"
            volume = 0 if slot.clip.muted else slot.clip.volume
            delay_ms = int(offset * 1000)
            filter_parts.append(
                f"[{i}:a]atrim=duration={render_duration},asetpts=PTS-STARTPTS,volume={volume},"
                f"adelay={delay_ms}|{delay_ms}[{a_final}]"
            )
            layer_audio_labels.append(a_final)

        running = layer_video_labels[0]
        for v_label in layer_video_labels[1:]:
            out_label = f"{running}_ov"
            filter_parts.append(f"[{running}][{v_label}]overlay=x=0:y=0[{out_label}]")
            running = out_label
        group_video_labels.append(running)

        n_audio = len(layer_audio_labels)
        if n_audio == 1:
            group_audio_labels.append(layer_audio_labels[0])
        else:
            audio_out = f"g{g}amix"
            audio_inputs = "".join(f"[{label}]" for label in layer_audio_labels)
            filter_parts.append(f"{audio_inputs}amix=inputs={n_audio}:duration=longest[{audio_out}]")
            group_audio_labels.append(audio_out)

    n_groups = len(groups)
    video_concat_inputs = "".join(f"[{label}]" for label in group_video_labels)
    audio_concat_inputs = "".join(f"[{label}]" for label in group_audio_labels)
    filter_parts.append(f"{video_concat_inputs}concat=n={n_groups}:v=1:a=0[vconcat]")
    filter_parts.append(f"{audio_concat_inputs}concat=n={n_groups}:v=0:a=1[aclips]")

    total_duration = sum(g[-1].start_time + g[-1].duration - g[0].start_time for g in groups)

    narration_label = None
    if project.narration.audio_path:
        inputs += ["-ss", f"{slots[0].start_time}", "-i", project.narration.audio_path]
        narration_input_index = input_index
        input_index += 1
        volume = 0 if project.narration.muted else 1
        filter_parts.append(
            f"[{narration_input_index}:a]atrim=duration={total_duration},"
            f"asetpts=PTS-STARTPTS,volume={volume}[anarr]"
        )
        narration_label = "[anarr]"

    if narration_label:
        filter_parts.append(
            f"[aclips]{narration_label}amix=inputs=2:duration=first:dropout_transition=0[aout]"
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
