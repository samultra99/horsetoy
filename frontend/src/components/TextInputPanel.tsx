import { useState } from "react";
import { useProjectStore } from "../state/projectStore";

const SAMPLE_TEXT =
  "The old wizard carried a heavy wooden staff through the dark forest, searching for a hidden treasure.";

export function TextInputPanel() {
  const [text, setText] = useState(SAMPLE_TEXT);
  const build = useProjectStore((s) => s.build);
  const status = useProjectStore((s) => s.status);
  const error = useProjectStore((s) => s.error);

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        style={{ width: "100%", fontSize: 14, fontFamily: "inherit", boxSizing: "border-box" }}
        placeholder="Paste a paragraph..."
      />
      <div style={{ marginTop: "0.5rem" }}>
        <button onClick={() => build(text)} disabled={status === "building" || !text.trim()}>
          {status === "building" ? "Building…" : "Build timeline"}
        </button>
      </div>
      {status === "error" && <p style={{ color: "crimson" }}>{error}</p>}
    </div>
  );
}
