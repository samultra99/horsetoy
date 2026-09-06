import asyncio

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from app.models.project import Project, Slot
from app.pipeline.video_fetch import FetchResult, VideoFetchError, YtDlpFetcher
from app.state.jobs import JobEvent, new_job_id, publish
from app.state.project_store import get_project, save_project

router = APIRouter(prefix="/api/search", tags=["search"])
_fetcher = YtDlpFetcher()

NEXT_VIDEO_MAX_ATTEMPTS = 5


class FetchAllRequest(BaseModel):
    project_id: str


class FetchAllResponse(BaseModel):
    job_id: str


class SlotActionRequest(BaseModel):
    project_id: str
    slot_id: str


class ManualSearchRequest(BaseModel):
    project_id: str
    slot_id: str
    query: str


class SlotActionResponse(BaseModel):
    slot: Slot


def _active_query(slot: Slot) -> str:
    if slot.search.manual_override:
        return slot.search.manual_override
    return slot.search.candidates[slot.search.active_index]["text"]


def _get_slot(project: Project, slot_id: str) -> Slot:
    slot = next((s for s in project.slots if s.id == slot_id), None)
    if slot is None:
        raise HTTPException(status_code=404, detail="slot not found")
    return slot


def _apply_fetch_result(slot: Slot, result: FetchResult) -> None:
    slot.clip.video_id = result.video_id
    slot.clip.source_url = result.source_url
    slot.clip.quality = result.quality
    slot.clip.local_path = result.local_path
    slot.clip.source_duration = result.duration
    slot.clip.error_message = None
    slot.clip.download_status = "ready"
    slot.clip.trim_start = 0.0
    slot.clip.trim_end = min(result.duration, slot.duration) if result.duration else slot.duration
    slot.clip.needs_attention = bool(result.duration) and result.duration < slot.duration


def _reason_for(e: VideoFetchError) -> str:
    return "blocked/rate-limited by YouTube" if e.blocked else str(e)


async def _run_fetch_all(job_id: str, project_id: str) -> None:
    project = get_project(project_id)
    if project is None:
        await publish(JobEvent(job_id, "failed", 100, "project not found"))
        return

    total = len(project.slots)
    for i, slot in enumerate(project.slots):
        slot.clip.download_status = "pending"
        await publish(JobEvent(job_id, "fetching", (i / total) * 100, f"fetching clip for '{slot.noun}'"))
        query = _active_query(slot)
        try:
            result = await asyncio.to_thread(_fetcher.fetch_by_rank, query, 1, "preview")
        except VideoFetchError as e:
            slot.clip.download_status = "failed"
            slot.clip.needs_attention = True
            reason = _reason_for(e)
            slot.clip.error_message = reason
            save_project(project)
            await publish(
                JobEvent(job_id, "error", ((i + 1) / total) * 100, f"failed for '{slot.noun}': {reason}")
            )
            continue

        _apply_fetch_result(slot, result)
        slot.results.seen_video_ids = [result.video_id]
        slot.results.next_rank_to_try = 2
        save_project(project)
        await publish(
            JobEvent(job_id, "fetching", ((i + 1) / total) * 100, f"fetched clip for '{slot.noun}'")
        )

    await publish(JobEvent(job_id, "done", 100, "all clips fetched"))


@router.post("/fetch-all", response_model=FetchAllResponse)
async def fetch_all(req: FetchAllRequest, background_tasks: BackgroundTasks) -> FetchAllResponse:
    project = get_project(req.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    job_id = new_job_id()
    background_tasks.add_task(_run_fetch_all, job_id, req.project_id)
    return FetchAllResponse(job_id=job_id)


@router.post("/next-video", response_model=SlotActionResponse)
async def next_video(req: SlotActionRequest) -> SlotActionResponse:
    project = get_project(req.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    slot = _get_slot(project, req.slot_id)
    query = _active_query(slot)

    rank = slot.results.next_rank_to_try
    result: FetchResult | None = None
    for _ in range(NEXT_VIDEO_MAX_ATTEMPTS):
        try:
            candidate = await asyncio.to_thread(_fetcher.fetch_by_rank, query, rank, "preview")
        except VideoFetchError as e:
            raise HTTPException(status_code=422, detail=_reason_for(e)) from e
        rank += 1
        if candidate.video_id not in slot.results.seen_video_ids:
            result = candidate
            break
    if result is None:
        raise HTTPException(status_code=422, detail="no new (unseen) result found for this search")

    _apply_fetch_result(slot, result)
    slot.results.seen_video_ids.append(result.video_id)
    slot.results.next_rank_to_try = rank
    save_project(project)
    return SlotActionResponse(slot=slot)


@router.post("/new-search", response_model=SlotActionResponse)
async def new_search(req: SlotActionRequest) -> SlotActionResponse:
    project = get_project(req.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    slot = _get_slot(project, req.slot_id)
    if not slot.search.candidates:
        raise HTTPException(status_code=422, detail="no candidate search strings available")

    slot.search.manual_override = None
    slot.search.active_index = (slot.search.active_index + 1) % len(slot.search.candidates)
    slot.results.seen_video_ids = []
    slot.results.next_rank_to_try = 1
    query = _active_query(slot)
    save_project(project)  # persist the search-string change even if the fetch below fails

    try:
        result = await asyncio.to_thread(_fetcher.fetch_by_rank, query, 1, "preview")
    except VideoFetchError as e:
        raise HTTPException(status_code=422, detail=_reason_for(e)) from e

    _apply_fetch_result(slot, result)
    slot.results.seen_video_ids = [result.video_id]
    slot.results.next_rank_to_try = 2
    save_project(project)
    return SlotActionResponse(slot=slot)


@router.post("/manual-search", response_model=SlotActionResponse)
async def manual_search(req: ManualSearchRequest) -> SlotActionResponse:
    project = get_project(req.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    slot = _get_slot(project, req.slot_id)

    query = req.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="query must not be empty")

    slot.search.manual_override = query
    slot.results.seen_video_ids = []
    slot.results.next_rank_to_try = 1
    save_project(project)  # persist the search-string change even if the fetch below fails

    try:
        result = await asyncio.to_thread(_fetcher.fetch_by_rank, query, 1, "preview")
    except VideoFetchError as e:
        raise HTTPException(status_code=422, detail=_reason_for(e)) from e

    _apply_fetch_result(slot, result)
    slot.results.seen_video_ids = [result.video_id]
    slot.results.next_rank_to_try = 2
    save_project(project)
    return SlotActionResponse(slot=slot)
