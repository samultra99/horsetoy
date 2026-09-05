from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.routes_composite import router as composite_router
from app.api.routes_pipeline import router as pipeline_router
from app.api.routes_project import router as project_router
from app.api.routes_render import router as render_router
from app.api.routes_search import router as search_router
from app.api.ws import router as ws_router
from app.config import CLIPS_CACHE_DIR, EXPORTS_DIR, FRONTEND_DEV_ORIGIN, NARRATION_CACHE_DIR

app = FastAPI(title="HorseToy")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_DEV_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(pipeline_router)
app.include_router(project_router)
app.include_router(search_router)
app.include_router(render_router)
app.include_router(composite_router)
app.include_router(ws_router)
app.mount("/media/narration", StaticFiles(directory=NARRATION_CACHE_DIR), name="narration")
app.mount("/media/clips", StaticFiles(directory=CLIPS_CACHE_DIR), name="clips")
app.mount("/media/exports", StaticFiles(directory=EXPORTS_DIR), name="exports")


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}
