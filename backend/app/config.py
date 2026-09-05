from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = BACKEND_ROOT / "data"
CACHE_DIR = BACKEND_ROOT / ".cache"
CLIPS_CACHE_DIR = CACHE_DIR / "clips"
PROXY_CACHE_DIR = CACHE_DIR / "proxies"
NARRATION_CACHE_DIR = CACHE_DIR / "narration"
EXPORTS_DIR = CACHE_DIR / "exports"
PROJECTS_DIR = CACHE_DIR / "projects"

for d in (CLIPS_CACHE_DIR, PROXY_CACHE_DIR, NARRATION_CACHE_DIR, EXPORTS_DIR, PROJECTS_DIR):
    d.mkdir(parents=True, exist_ok=True)

DEFAULT_ASPECT_RATIO = (9, 16)
FRONTEND_DEV_ORIGIN = "http://localhost:5173"
