import { useEffect, useState } from "react";
import { api } from "./api/client";
import { ClipFetchPanel } from "./components/ClipFetchPanel";
import { SlotEditorList } from "./components/Editor/SlotEditorList";
import { ExportPanel } from "./components/ExportPanel";
import { TextInputPanel } from "./components/TextInputPanel";
import { TimelineTrack } from "./components/Timeline/TimelineTrack";

type BackendStatus = "checking" | "connected" | "disconnected";

function App() {
  const [backendStatus, setBackendStatus] = useState<BackendStatus>("checking");

  useEffect(() => {
    api
      .health()
      .then(() => setBackendStatus("connected"))
      .catch(() => setBackendStatus("disconnected"));
  }, []);

  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 720, margin: "0 auto" }}>
      <h1>HorseToy</h1>
      <p style={{ fontSize: 12, color: "#888" }}>
        Backend:{" "}
        <strong
          style={{
            color:
              backendStatus === "connected"
                ? "green"
                : backendStatus === "disconnected"
                  ? "crimson"
                  : "gray",
          }}
        >
          {backendStatus}
        </strong>
      </p>
      <TextInputPanel />
      <TimelineTrack />
      <ClipFetchPanel />
      <SlotEditorList />
      <ExportPanel />
    </main>
  );
}

export default App;
