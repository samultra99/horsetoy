import { create } from "zustand";
import { api, type ClipPatch, type NounInfo, type Slot } from "../api/client";

type Status = "idle" | "building" | "ready" | "error";
type FetchStatus = "idle" | "fetching" | "done" | "error";
type ExportStatus = "idle" | "exporting" | "done" | "error";

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
  exportStatus: ExportStatus;
  exportUrl: string | null;
  build: (text: string) => Promise<void>;
  fetchAllClips: () => Promise<void>;
  exportVideo: () => Promise<void>;
  patchSlotClip: (slotId: string, patch: ClipPatch) => Promise<void>;
  rerollComposite: (slotId: string) => Promise<void>;
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
  exportStatus: "idle",
  exportUrl: null,
  build: async (text: string) => {
    set({
      status: "building",
      error: null,
      text,
      fetchStatus: "idle",
      exportStatus: "idle",
      exportUrl: null,
      slots: [],
    });
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
  exportVideo: async () => {
    const { projectId } = get();
    if (!projectId) return;
    set({ exportStatus: "exporting", error: null });
    try {
      const res = await api.exportProject(projectId);
      set({ exportStatus: "done", exportUrl: res.export_url });
    } catch (err) {
      set({ exportStatus: "error", error: err instanceof Error ? err.message : String(err) });
    }
  },
  patchSlotClip: async (slotId: string, patch: ClipPatch) => {
    const { projectId } = get();
    if (!projectId) return;
    try {
      const updatedSlot = await api.patchSlotClip(projectId, slotId, patch);
      set((state) => ({
        slots: state.slots.map((s) => (s.id === slotId ? updatedSlot : s)),
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  rerollComposite: async (slotId: string) => {
    const { projectId } = get();
    if (!projectId) return;
    try {
      const res = await api.rerollComposite(projectId, slotId);
      set((state) => ({
        slots: state.slots.map((s) => (s.id === slotId ? { ...s, composite: res.composite } : s)),
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
