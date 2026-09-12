import { useEffect, useState } from "react";
import { API_BASE, api } from "../api/client";
import { useProjectStore } from "../state/projectStore";

const SAMPLE_TEXT =
  "The old wizard carried a heavy wooden staff through the dark forest, searching for a hidden treasure.";

type BackendStatus = "checking" | "connected" | "disconnected";

export function TopBar() {
  const [text, setText] = useState(SAMPLE_TEXT);
  const [backend, setBackend] = useState<BackendStatus>("checking");
  const build = useProjectStore((s) => s.build);
  const storedText = useProjectStore((s) => s.text);
  const status = useProjectStore((s) => s.status);
  const slots = useProjectStore((s) => s.slots);
  const fetchStatus = useProjectStore((s) => s.fetchStatus);
  const fetchAllClips = useProjectStore((s) => s.fetchAllClips);
  const exportStatus = useProjectStore((s) => s.exportStatus);
  const exportVideo = useProjectStore((s) => s.exportVideo);
  const downloadUrl = useProjectStore((s) => s.downloadUrl);
  const error = useProjectStore((s) => s.error);

  useEffect(() => {
    api
      .health()
      .then(() => setBackend("connected"))
      .catch(() => setBackend("disconnected"));
  }, []);

  // A reopened project brings its own script back with it.
  useEffect(() => {
    if (storedText) setText(storedText);
  }, [storedText]);

  const built = status === "ready";
  const ready = slots.filter((s) => s.clip.download_status === "ready").length;
  const unfetched = slots.some((s) => s.clip.download_status === "empty");
  const allReady = slots.length > 0 && ready === slots.length;

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <h1 className="wordmark">HorseToy</h1>
        <span className="status-dot" data-state={backend} title={`backend ${backend}`} />
      </div>

      <div className="topbar-script">
        <textarea
          className="script"
          data-compact={built || undefined}
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste a paragraph…"
        />
        <button
          className="btn btn-primary"
          onClick={() => build(text)}
          disabled={status === "building" || !text.trim()}
        >
          {status === "building" ? "Building…" : built ? "Rebuild" : "Build timeline"}
        </button>
      </div>

      <div className="topbar-actions">
        {built && (
          <button
            className="btn"
            onClick={() => fetchAllClips()}
            disabled={fetchStatus === "fetching" || !unfetched}
            title="Pull a 360p clip for every noun"
          >
            {fetchStatus === "fetching" ? `Fetching… ${ready}/${slots.length}` : `Fetch clips ${ready}/${slots.length}`}
          </button>
        )}
        {built && (
          <button
            className="btn btn-primary"
            onClick={() => exportVideo()}
            disabled={!allReady || exportStatus === "exporting"}
            title={
              allReady
                ? "Re-fetch every clip at 1080p and render the finished cut"
                : "Every clip needs footage before this can render"
            }
          >
            {exportStatus === "exporting" ? "Rendering 1080p…" : "Export"}
          </button>
        )}
        {downloadUrl && exportStatus === "done" && (
          <a className="btn btn-sm" href={`${API_BASE}${downloadUrl}`} download>
            Download
          </a>
        )}
      </div>

      {error && <p className="topbar-error">{error}</p>}
    </header>
  );
}
