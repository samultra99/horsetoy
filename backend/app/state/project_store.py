"""In-memory project store (single-process prototype; no multi-user concerns)."""

from app.models.project import Project

_projects: dict[str, Project] = {}


def save_project(project: Project) -> None:
    _projects[project.id] = project


def get_project(project_id: str) -> Project | None:
    return _projects.get(project_id)
