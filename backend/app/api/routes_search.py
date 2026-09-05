import asyncio

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from app.models.project import Slot
from app.pipeline.video_fetch import VideoFetchError, YtDlpFetcher
from app.state.jobs import JobEvent, new_job_id, publish
from app.state.project_store import get_project

router = APIRouter(prefix="/api/search", tags=["search"])
_fetcher = YtDlpFetcher()


class FetchAllRequest(BaseModel):
    project_id: str


class FetchAllResponse(BaseModel):
    job_id: str


def _active_query(slot: Slot) -> str:
    if slot.search.manual_override:
        return slot.search.manual_override
    return slot.search.candidates[slot.search.active_index]["text"]


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
            await publish(
                JobEvent(job_id, "error", ((i + 1) / total) * 100, f"failed for '{slot.noun}': {e}")
            )
            continue

        slot.clip.video_id = result.video_id
        slot.clip.source_url = result.source_url
        slot.clip.quality = result.quality
        slot.clip.local_path = result.local_path
        slot.clip.source_duration = result.duration
        slot.clip.download_status = "ready"
        slot.clip.trim_start = 0.0
        slot.clip.trim_end = min(result.duration, slot.duration) if result.duration else slot.duration
        slot.clip.needs_attention = bool(result.duration) and result.duration < slot.duration
        slot.results.seen_video_ids = [result.video_id]
        slot.results.next_rank_to_try = 2
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
