import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import EXPORTS_DIR
from app.pipeline.filter_graph import RenderError, render_export
from app.state.project_store import get_project

router = APIRouter(prefix="/api/render", tags=["render"])


class ExportRequest(BaseModel):
    project_id: str


class ExportResponse(BaseModel):
    export_url: str


@router.post("/export", response_model=ExportResponse)
async def export_project(req: ExportRequest) -> ExportResponse:
    project = get_project(req.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")

    output_path = EXPORTS_DIR / f"{project.id}.mp4"
    try:
        await asyncio.to_thread(render_export, project, output_path)
    except RenderError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    return ExportResponse(export_url=f"/media/exports/{output_path.name}")
