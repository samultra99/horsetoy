import asyncio

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.config import EXPORTS_DIR
from app.models.project import Project
from app.pipeline.filter_graph import RenderError, render_export
from app.pipeline.video_fetch import VideoFetchError, YtDlpFetcher
from app.state.project_store import get_project

router = APIRouter(prefix="/api/render", tags=["render"])
_fetcher = YtDlpFetcher()


class ExportRequest(BaseModel):
    project_id: str


class ExportResponse(BaseModel):
    export_url: str
    download_url: str


async def _with_full_quality_clips(project: Project) -> Project:
    """Returns a working copy of the project where every ready slot's clip
    points at a freshly-sourced 1080p file instead of the 360p editing
    preview — the swap the export step needs but the editor never should,
    so it's done on a copy rather than saved back via save_project.
    """
    render_project = project.model_copy(deep=True)
    for slot in render_project.slots:
        if slot.clip.download_status != "ready" or not slot.clip.video_id or not slot.clip.source_url:
            continue
        try:
            result = await asyncio.to_thread(
                _fetcher.fetch_by_video_id, slot.clip.video_id, slot.clip.source_url, "full"
            )
        except VideoFetchError as e:
            raise RenderError(f"couldn't source a full-resolution clip for '{slot.noun}': {e}") from e
        slot.clip.local_path = result.local_path
    return render_project


@router.post("/export", response_model=ExportResponse)
async def export_project(req: ExportRequest) -> ExportResponse:
    project = get_project(req.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")

    render_project = await _with_full_quality_clips(project)

    output_path = EXPORTS_DIR / f"{project.id}.mp4"
    try:
        await asyncio.to_thread(render_export, render_project, output_path)
    except RenderError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    # Every export overwrites the same path, so both URLs carry the render's
    # mtime: without it the browser happily keeps showing (and downloading)
    # the first export you ever made, however much you edited since.
    version = output_path.stat().st_mtime_ns
    return ExportResponse(
        export_url=f"/media/exports/{output_path.name}?v={version}",
        download_url=f"/api/render/export/{project.id}/download?v={version}",
    )


@router.get("/export/{project_id}/download")
def download_export(project_id: str) -> FileResponse:
    output_path = EXPORTS_DIR / f"{project_id}.mp4"
    if not output_path.exists():
        raise HTTPException(status_code=404, detail="export not found — export the video first")
    return FileResponse(
        output_path,
        media_type="video/mp4",
        filename=f"horsetoy-{project_id}.mp4",
    )
