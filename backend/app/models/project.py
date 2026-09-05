from typing import Literal

from pydantic import BaseModel, Field


class SearchState(BaseModel):
    candidates: list[dict] = Field(default_factory=list)  # [{"template_id", "text"}]
    active_index: int = 0
    manual_override: str | None = None


class ResultsState(BaseModel):
    seen_video_ids: list[str] = Field(default_factory=list)
    next_rank_to_try: int = 1


class CropRect(BaseModel):
    x: float = 0.0
    y: float = 0.0
    w: float = 1.0
    h: float = 1.0


class ClipState(BaseModel):
    video_id: str | None = None
    source_url: str | None = None
    quality: Literal["preview", "full"] = "preview"
    local_path: str | None = None
    source_duration: float | None = None
    download_status: Literal["empty", "pending", "ready", "failed"] = "empty"
    trim_start: float = 0.0
    trim_end: float = 0.0
    crop_rect: CropRect = Field(default_factory=CropRect)
    zoom: float = 1.0
    volume: float = 1.0
    muted: bool = False
    needs_attention: bool = False


class CompositeState(BaseModel):
    mode: Literal["cut", "overlay"] = "cut"
    layer: int = 0
    overlay_of: list[str] = Field(default_factory=list)
    locked: bool = False


class Slot(BaseModel):
    id: str
    noun: str
    start_time: float
    duration: float
    search: SearchState
    results: ResultsState = Field(default_factory=ResultsState)
    clip: ClipState = Field(default_factory=ClipState)
    composite: CompositeState = Field(default_factory=CompositeState)


class NarrationState(BaseModel):
    audio_path: str | None = None
    muted: bool = False


class Project(BaseModel):
    id: str
    text: str
    slots: list[Slot]
    narration: NarrationState = Field(default_factory=NarrationState)
    total_duration: float = 0.0
