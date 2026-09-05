from fastapi import APIRouter, HTTPException

from app.models.project import Project
from app.state.project_store import get_project

router = APIRouter(prefix="/api/project", tags=["project"])


@router.get("/{project_id}", response_model=Project)
def read_project(project_id: str) -> Project:
    project = get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project
