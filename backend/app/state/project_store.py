"""Project store: in-memory cache backed by a JSON file per project on disk.

A pure in-memory store loses every in-progress project whenever the backend
process restarts (a dev-server reload, a crash, or just being killed and
restarted between sessions) — the frontend keeps holding a project_id that
no longer resolves to anything, surfacing as a confusing "Project not
found" on export. Persisting to disk on every mutation means a restart can
still recover whatever was last saved.
"""

import json

from app.config import PROJECTS_DIR
from app.models.project import Project

_projects: dict[str, Project] = {}


def _path_for(project_id: str):
    return PROJECTS_DIR / f"{project_id}.json"


def save_project(project: Project) -> None:
    _projects[project.id] = project
    _path_for(project.id).write_text(project.model_dump_json())


def get_project(project_id: str) -> Project | None:
    cached = _projects.get(project_id)
    if cached is not None:
        return cached

    path = _path_for(project_id)
    if not path.exists():
        return None
    try:
        project = Project.model_validate_json(path.read_text())
    except (json.JSONDecodeError, ValueError):
        return None
    _projects[project_id] = project
    return project
