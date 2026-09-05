import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.models.project import (
    ClipState,
    CompositeState,
    NarrationState,
    Project,
    ResultsState,
    SearchState,
    Slot,
)
from app.pipeline.noun_extraction import extract_nouns
from app.pipeline.search_string_generator import generate_candidates
from app.pipeline.timing_model import synthesize_and_align
from app.state.project_store import save_project

router = APIRouter(prefix="/api/pipeline", tags=["pipeline"])

TAIL_DURATION = 2.0
MIN_SLOT_DURATION = 0.3


class BuildRequest(BaseModel):
    text: str


class NounInfo(BaseModel):
    id: str
    noun_text: str
    pos: str
    char_start: int
    char_end: int
    start_time: float | None
    search_candidates: list[dict]


class BuildResponse(BaseModel):
    project_id: str
    narration_audio_url: str
    total_duration: float
    nouns: list[NounInfo]
    slots: list[Slot]


@router.post("/build", response_model=BuildResponse)
async def build_project(req: BuildRequest) -> BuildResponse:
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text must not be empty")

    nouns = extract_nouns(text)
    if not nouns:
        raise HTTPException(status_code=422, detail="no nouns found in text")

    timing = await synthesize_and_align(text, nouns)

    noun_infos: list[NounInfo] = []
    timed_nouns: list[tuple] = []
    for noun in nouns:
        candidates = generate_candidates(noun)
        start_time = timing.noun_timings.get(noun.id)
        noun_infos.append(
            NounInfo(
                id=noun.id,
                noun_text=noun.noun_text,
                pos=noun.pos,
                char_start=noun.char_start,
                char_end=noun.char_end,
                start_time=start_time,
                search_candidates=candidates,
            )
        )
        if start_time is not None:
            timed_nouns.append((noun, start_time, candidates))

    timed_nouns.sort(key=lambda item: item[1])

    slots: list[Slot] = []
    for i, (noun, start_time, candidates) in enumerate(timed_nouns):
        next_start = (
            timed_nouns[i + 1][1] if i + 1 < len(timed_nouns) else timing.total_duration + TAIL_DURATION
        )
        duration = max(MIN_SLOT_DURATION, next_start - start_time)
        slots.append(
            Slot(
                id=noun.id,
                noun=noun.noun_text,
                start_time=start_time,
                duration=duration,
                search=SearchState(candidates=candidates, active_index=0, manual_override=None),
                results=ResultsState(),
                clip=ClipState(),
                composite=CompositeState(),
            )
        )

    project_id = str(uuid.uuid4())
    narration_filename = Path(timing.narration_audio_path).name
    project = Project(
        id=project_id,
        text=text,
        slots=slots,
        narration=NarrationState(audio_path=timing.narration_audio_path, muted=False),
        total_duration=timing.total_duration,
    )
    save_project(project)

    return BuildResponse(
        project_id=project_id,
        narration_audio_url=f"/media/narration/{narration_filename}",
        total_duration=timing.total_duration,
        nouns=noun_infos,
        slots=slots,
    )
