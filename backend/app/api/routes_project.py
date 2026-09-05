from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.models.project import CropRect, Project, Slot
from app.state.project_store import get_project

router = APIRouter(prefix="/api/project", tags=["project"])


@router.get("/{project_id}", response_model=Project)
def read_project(project_id: str) -> Project:
    project = get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


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

    return slot
