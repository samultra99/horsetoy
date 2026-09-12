from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.models.project import CropRect, NarrationState, Project, Slot
from app.pipeline.composite_rng import CompositeEditError, set_slot_mode
from app.state.project_store import get_project, save_project

router = APIRouter(prefix="/api/project", tags=["project"])


@router.get("/{project_id}", response_model=Project)
def read_project(project_id: str) -> Project:
    project = get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    # Projects saved before narration carried its own URL still need to be
    # openable, and the URL is just the filename under the media mount.
    if project.narration.audio_url is None and project.narration.audio_path:
        project.narration.audio_url = f"/media/narration/{Path(project.narration.audio_path).name}"
    return project


class NarrationPatchRequest(BaseModel):
    muted: bool


@router.patch("/{project_id}/narration", response_model=NarrationState)
def patch_narration(project_id: str, req: NarrationPatchRequest) -> NarrationState:
    project = get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")

    project.narration.muted = req.muted
    save_project(project)
    return project.narration


class ClipPatchRequest(BaseModel):
    trim_start: float | None = None
    trim_end: float | None = None
    crop_rect: CropRect | None = None
    zoom: float | None = None
    volume: float | None = None
    muted: bool | None = None


@router.patch("/{project_id}/slots/{slot_id}/clip", response_model=Slot)
def patch_slot_clip(project_id: str, slot_id: str, req: ClipPatchRequest) -> Slot:
    project = get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    slot = next((s for s in project.slots if s.id == slot_id), None)
    if slot is None:
        raise HTTPException(status_code=404, detail="slot not found")

    if req.trim_start is not None and req.trim_end is None:
        # Slide the fixed-length trim window without changing its length.
        window_length = slot.clip.trim_end - slot.clip.trim_start
        if window_length <= 0:
            window_length = slot.duration
        slot.clip.trim_start = req.trim_start
        slot.clip.trim_end = req.trim_start + window_length
    else:
        if req.trim_start is not None:
            slot.clip.trim_start = req.trim_start
        if req.trim_end is not None:
            slot.clip.trim_end = req.trim_end
    if req.crop_rect is not None:
        slot.clip.crop_rect = req.crop_rect
    if req.zoom is not None:
        slot.clip.zoom = req.zoom
    if req.volume is not None:
        slot.clip.volume = req.volume
    if req.muted is not None:
        slot.clip.muted = req.muted

    save_project(project)
    return slot


class CompositePatchRequest(BaseModel):
    mode: Literal["cut", "overlay"] | None = None
    opacity: float | None = None
    duration: float | None = None
    fade_in: float | None = None
    fade_out: float | None = None


@router.patch("/{project_id}/slots/{slot_id}/composite", response_model=Slot)
def patch_slot_composite(project_id: str, slot_id: str, req: CompositePatchRequest) -> Slot:
    project = get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    slot = next((s for s in project.slots if s.id == slot_id), None)
    if slot is None:
        raise HTTPException(status_code=404, detail="slot not found")

    if req.mode is not None:
        try:
            set_slot_mode(project.slots, slot_id, req.mode)
        except CompositeEditError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e

    if req.opacity is not None:
        slot.composite.opacity = min(max(req.opacity, 0.0), 1.0)
    if req.duration is not None:
        slot.composite.duration = max(req.duration, 0.0)
    if req.fade_in is not None:
        slot.composite.fade_in = max(req.fade_in, 0.0)
    if req.fade_out is not None:
        slot.composite.fade_out = max(req.fade_out, 0.0)

    save_project(project)
    return slot
