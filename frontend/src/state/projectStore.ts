import { create } from "zustand";
import { api, type NounInfo, type Slot } from "../api/client";

type Status = "idle" | "building" | "ready" | "error";
type FetchStatus = "idle" | "fetching" | "done" | "error";

interface ProjectState {
  projectId: string | null;
  text: string;
  narrationAudioUrl: string | null;
  totalDuration: number;
  nouns: NounInfo[];
  slots: Slot[];
  status: Status;
  error: string | null;
  fetchStatus: FetchStatus;
  build: (text: string) => Promise<void>;
  fetchAllClips: () => Promise<void>;
}

const POLL_INTERVAL_MS = 1500;

function allSlotsSettled(slots: Slot[]): boolean {
  return slots.every((s) => s.clip.download_status === "ready" || s.clip.download_status === "failed");
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projectId: null,
  text: "",
  narrationAudioUrl: null,
  totalDuration: 0,
  nouns: [],
  slots: [],
  status: "idle",
  error: null,
  fetchStatus: "idle",
  build: async (text: string) => {
    set({ status: "building", error: null, text, fetchStatus: "idle", slots: [] });
    try {
      const res = await api.buildProject(text);
      set({
        projectId: res.project_id,
        narrationAudioUrl: res.narration_audio_url,
        totalDuration: res.total_duration,
        nouns: res.nouns,
        slots: res.slots,
        status: "ready",
      });
    } catch (err) {
      set({ status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  },
  fetchAllClips: async () => {
    const { projectId } = get();
    if (!projectId) return;
    set({ fetchStatus: "fetching" });
    try {
      await api.fetchAll(projectId);
      // Simple poll loop — good enough for the M2 debug panel; the real
      // WebSocket progress channel lands alongside the richer editor UI.
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        const project = await api.getProject(projectId);
        set({ slots: project.slots });
        if (allSlotsSettled(project.slots)) break;
      }
      set({ fetchStatus: "done" });
    } catch (err) {
      set({ fetchStatus: "error", error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
