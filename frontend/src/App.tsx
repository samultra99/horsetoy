import { useEffect } from "react";
import { Inspector } from "./components/Inspector";
import { PreviewStage } from "./components/PreviewStage";
import { Timeline, usePlaybackShortcuts } from "./components/Timeline";
import { TopBar } from "./components/TopBar";
import { Transport } from "./components/Transport";
import { useProjectStore } from "./state/projectStore";

function App() {
  usePlaybackShortcuts();
  const restore = useProjectStore((s) => s.restore);

  useEffect(() => {
    void restore();
  }, [restore]);

  return (
    <div className="app">
      <TopBar />
      <main className="workspace">
        <div className="viewer">
          <PreviewStage />
          <Transport />
        </div>
        <Inspector />
      </main>
      <Timeline />
    </div>
  );
}

export default App;
