from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.models.project import CompositeState
from app.pipeline.composite_rng import reroll_slot
from app.state.project_store import get_project

router = APIRouter(prefix="/api/composite", tags=["composite"])


class RerollRequest(BaseModel):
    project_id: str
    slot_id: str


class RerollResponse(BaseModel):
    composite: CompositeState


@router.post("/reroll", response_model=RerollResponse)
def reroll(req: RerollRequest) -> RerollResponse:
    project = get_project(req.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    slot = next((s for s in project.slots if s.id == req.slot_id), None)
    if slot is None:
        raise HTTPException(status_code=404, detail="slot not found")

    reroll_slot(project.slots, req.slot_id)
    return RerollResponse(composite=slot.composite)
