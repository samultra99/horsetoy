import { create } from "zustand";
import { api, type ClipPatch, type CompositePatch, type Slot } from "../api/client";

type Status = "idle" | "building" | "ready" | "error";
type FetchStatus = "idle" | "fetching" | "done" | "error";
type ExportStatus = "idle" | "exporting" | "done" | "error";
type SlotActionStatus = "idle" | "loading" | "error";

/**
 * Drags (slip-trim, transition length, the scrub fields) fire on every pointer
 * move. The UI updates optimistically off each one; only the last write of a
 * gesture actually needs to reach the server.
 */
const WRITE_DEBOUNCE_MS = 180;
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
const pendingPatches = new Map<string, Record<string, unknown>>();

/** Merges this change into whatever else is queued for the same key, and
 *  sends the combined patch once the gesture settles. */
function queuePatch<T extends object>(key: string, patch: T, send: (merged: T) => void) {
  pendingPatches.set(key, { ...(pendingPatches.get(key) ?? {}), ...patch });
  const existing = pendingWrites.get(key);
  if (existing) clearTimeout(existing);
  pendingWrites.set(
    key,
    setTimeout(() => {
      pendingWrites.delete(key);
      const merged = pendingPatches.get(key) as T | undefined;
      pendingPatches.delete(key);
      if (merged) send(merged);
    }, WRITE_DEBOUNCE_MS),
  );
}

interface ProjectState {
  projectId: string | null;
  text: string;
  narrationAudioUrl: string | null;
  narrationMuted: boolean;
  totalDuration: number;
  slots: Slot[];
  status: Status;
  error: string | null;
  fetchStatus: FetchStatus;
  exportStatus: ExportStatus;
  exportUrl: string | null;
  downloadUrl: string | null;
  /** Whether the stage is showing the finished export rather than the live edit. */
  showExport: boolean;
  selectedSlotId: string | null;
  playhead: number;
  playing: boolean;
  slotActionStatus: Record<string, SlotActionStatus>;
  slotActionError: Record<string, string>;

  build: (text: string) => Promise<void>;
  restore: () => Promise<void>;
  fetchAllClips: () => Promise<void>;
  exportVideo: () => Promise<void>;
  patchSlotClip: (slotId: string, patch: ClipPatch) => Promise<void>;
  patchComposite: (slotId: string, patch: CompositePatch) => Promise<void>;
  rerollComposite: (slotId: string) => Promise<void>;
  nextVideo: (slotId: string) => Promise<void>;
  newSearch: (slotId: string) => Promise<void>;
  manualSearch: (slotId: string, query: string) => Promise<void>;
  toggleNarrationMuted: () => Promise<void>;
  select: (slotId: string | null) => void;
  setPlayhead: (t: number) => void;
  setPlaying: (playing: boolean) => void;
  dismissExport: () => void;
}

const POLL_INTERVAL_MS = 1200;
const LAST_PROJECT_KEY = "horsetoy:last-project";

function allSlotsSettled(slots: Slot[]): boolean {
  return slots.every((s) => s.clip.download_status === "ready" || s.clip.download_status === "failed");
}

export const useProjectStore = create<ProjectState>((set, get) => {
  /**
   * Any edit drops the stage back to the live preview. Leaving the finished
   * export on screen after a change is how you end up staring at a stale
   * render wondering why your edit "didn't apply".
   */
  const applySlot = (slot: Slot) =>
    set((state) => ({
      slots: state.slots.map((s) => (s.id === slot.id ? slot : s)),
      showExport: false,
    }));

  return {
    projectId: null,
    text: "",
    narrationAudioUrl: null,
    narrationMuted: false,
    totalDuration: 0,
    slots: [],
    status: "idle",
    error: null,
    fetchStatus: "idle",
    exportStatus: "idle",
    exportUrl: null,
    downloadUrl: null,
    showExport: false,
    selectedSlotId: null,
    playhead: 0,
    playing: false,
    slotActionStatus: {},
    slotActionError: {},

    build: async (text: string) => {
      set({
        status: "building",
        error: null,
        text,
        fetchStatus: "idle",
        exportStatus: "idle",
        exportUrl: null,
        downloadUrl: null,
        showExport: false,
        selectedSlotId: null,
        playhead: 0,
        playing: false,
        slots: [],
        slotActionStatus: {},
        slotActionError: {},
        narrationMuted: false,
      });
      try {
        const res = await api.buildProject(text);
        localStorage.setItem(LAST_PROJECT_KEY, res.project_id);
        set({
          projectId: res.project_id,
          narrationAudioUrl: res.narration_audio_url,
          totalDuration: res.total_duration,
          slots: res.slots,
          status: "ready",
        });
      } catch (err) {
        set({ status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    },

    /** Picks the last project back up on load — the edit lives on the server,
     *  so a refresh shouldn't cost you the whole session. */
    restore: async () => {
      const id = localStorage.getItem(LAST_PROJECT_KEY);
      if (!id || get().projectId) return;
      try {
        const project = await api.getProject(id);
        set({
          projectId: project.id,
          text: project.text,
          slots: project.slots,
          narrationAudioUrl: project.narration.audio_url,
          narrationMuted: project.narration.muted,
          totalDuration: project.total_duration,
          status: "ready",
        });
      } catch {
        localStorage.removeItem(LAST_PROJECT_KEY);
      }
    },

    fetchAllClips: async () => {
      const { projectId } = get();
      if (!projectId) return;
      set({ fetchStatus: "fetching", showExport: false });
      try {
        await api.fetchAll(projectId);
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
      set({ exportStatus: "exporting", error: null, playing: false });
      try {
        const res = await api.exportProject(projectId);
        set({
          exportStatus: "done",
          exportUrl: res.export_url,
          downloadUrl: res.download_url,
          showExport: true,
        });
      } catch (err) {
        set({ exportStatus: "error", error: err instanceof Error ? err.message : String(err) });
      }
    },

    patchSlotClip: async (slotId: string, patch: ClipPatch) => {
      const { projectId, slots } = get();
      if (!projectId) return;
      // Optimistic: these come from drags, and waiting on a round trip before
      // the preview moves makes the controls feel broken.
      set({
        slots: slots.map((s) => (s.id === slotId ? { ...s, clip: { ...s.clip, ...patch } } : s)),
        showExport: false,
      });
      queuePatch<ClipPatch>(`clip:${slotId}`, patch, async (merged) => {
        try {
          applySlot(await api.patchSlotClip(projectId, slotId, merged));
        } catch (err) {
          set({ error: err instanceof Error ? err.message : String(err) });
        }
      });
    },

    patchComposite: async (slotId: string, patch: CompositePatch) => {
      const { projectId, slots } = get();
      if (!projectId) return;
      set({
        slots: slots.map((s) =>
          s.id === slotId ? { ...s, composite: { ...s.composite, ...patch } } : s,
        ),
        showExport: false,
      });
      queuePatch<CompositePatch>(`composite:${slotId}`, patch, async (merged) => {
        try {
          applySlot(await api.patchSlotComposite(projectId, slotId, merged));
        } catch (err) {
          // The server refused (e.g. the stack is already at its layer limit);
          // pull the real state back so the timeline stops showing a lie.
          const project = await api.getProject(projectId).catch(() => null);
          set({
            error: err instanceof Error ? err.message : String(err),
            ...(project ? { slots: project.slots } : {}),
          });
        }
      });
    },

    rerollComposite: async (slotId: string) => {
      const { projectId } = get();
      if (!projectId) return;
      try {
        const res = await api.rerollComposite(projectId, slotId);
        set((state) => ({
          slots: state.slots.map((s) => (s.id === slotId ? { ...s, composite: res.composite } : s)),
          showExport: false,
        }));
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    nextVideo: async (slotId: string) => {
      const { projectId } = get();
      if (!projectId) return;
      set((state) => ({ slotActionStatus: { ...state.slotActionStatus, [slotId]: "loading" } }));
      try {
        const res = await api.nextVideo(projectId, slotId);
        applySlot(res.slot);
        set((state) => ({ slotActionStatus: { ...state.slotActionStatus, [slotId]: "idle" } }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set((state) => ({
          slotActionStatus: { ...state.slotActionStatus, [slotId]: "error" },
          slotActionError: { ...state.slotActionError, [slotId]: message },
        }));
      }
    },

    newSearch: async (slotId: string) => {
      const { projectId } = get();
      if (!projectId) return;
      set((state) => ({ slotActionStatus: { ...state.slotActionStatus, [slotId]: "loading" } }));
      try {
        const res = await api.newSearch(projectId, slotId);
        applySlot(res.slot);
        set((state) => ({ slotActionStatus: { ...state.slotActionStatus, [slotId]: "idle" } }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set((state) => ({
          slotActionStatus: { ...state.slotActionStatus, [slotId]: "error" },
          slotActionError: { ...state.slotActionError, [slotId]: message },
        }));
      }
    },

    manualSearch: async (slotId: string, query: string) => {
      const { projectId } = get();
      if (!projectId) return;
      set((state) => ({ slotActionStatus: { ...state.slotActionStatus, [slotId]: "loading" } }));
      try {
        const res = await api.manualSearch(projectId, slotId, query);
        applySlot(res.slot);
        set((state) => ({ slotActionStatus: { ...state.slotActionStatus, [slotId]: "idle" } }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set((state) => ({
          slotActionStatus: { ...state.slotActionStatus, [slotId]: "error" },
          slotActionError: { ...state.slotActionError, [slotId]: message },
        }));
      }
    },

    toggleNarrationMuted: async () => {
      const { projectId, narrationMuted } = get();
      if (!projectId) return;
      const next = !narrationMuted;
      set({ narrationMuted: next, showExport: false });
      try {
        await api.patchNarration(projectId, next);
      } catch (err) {
        set({ narrationMuted: !next, error: err instanceof Error ? err.message : String(err) });
      }
    },

    // Touching the timeline at all means you're editing again, so the
    // finished render gets out of the way of the live preview.
    select: (slotId: string | null) => set({ selectedSlotId: slotId, showExport: false }),
    setPlayhead: (t: number) => set({ playhead: Math.max(0, t), showExport: false }),
    setPlaying: (playing: boolean) => set({ playing }),
    dismissExport: () => set({ showExport: false }),
  };
});
