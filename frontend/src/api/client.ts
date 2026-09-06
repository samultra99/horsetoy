export const API_BASE = "http://localhost:8000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.detail ?? "";
    } catch {
      // ignore — response wasn't JSON
    }
    throw new Error(detail || `${init?.method ?? "GET"} ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface SearchCandidate {
  template_id: string;
  text: string;
}

export interface NounInfo {
  id: string;
  noun_text: string;
  pos: string;
  char_start: number;
  char_end: number;
  start_time: number | null;
  search_candidates: SearchCandidate[];
}

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ClipState {
  video_id: string | null;
  source_url: string | null;
  quality: "preview" | "full";
  local_path: string | null;
  source_duration: number | null;
  download_status: "empty" | "pending" | "ready" | "failed";
  error_message: string | null;
  trim_start: number;
  trim_end: number;
  crop_rect: CropRect;
  zoom: number;
  volume: number;
  muted: boolean;
  needs_attention: boolean;
}

export interface CompositeState {
  mode: "cut" | "overlay";
  layer: number;
  overlay_of: string[];
  locked: boolean;
}

export interface Slot {
  id: string;
  noun: string;
  start_time: number;
  duration: number;
  search: { candidates: SearchCandidate[]; active_index: number; manual_override: string | null };
  results: { seen_video_ids: string[]; next_rank_to_try: number };
  clip: ClipState;
  composite: CompositeState;
}

export interface BuildResponse {
  project_id: string;
  narration_audio_url: string;
  total_duration: number;
  nouns: NounInfo[];
  slots: Slot[];
}

export interface NarrationState {
  audio_path: string | null;
  muted: boolean;
}

export interface Project {
  id: string;
  text: string;
  slots: Slot[];
  narration: NarrationState;
  total_duration: number;
}

export interface ClipPatch {
  trim_start?: number;
  trim_end?: number;
  crop_rect?: CropRect;
  zoom?: number;
  volume?: number;
  muted?: boolean;
}

export const api = {
  health: () => request<{ status: string }>("/api/health"),
  buildProject: (text: string) =>
    request<BuildResponse>("/api/pipeline/build", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  fetchAll: (projectId: string) =>
    request<{ job_id: string }>("/api/search/fetch-all", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId }),
    }),
  getProject: (projectId: string) => request<Project>(`/api/project/${projectId}`),
  exportProject: (projectId: string) =>
    request<{ export_url: string }>("/api/render/export", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId }),
    }),
  patchSlotClip: (projectId: string, slotId: string, patch: ClipPatch) =>
    request<Slot>(`/api/project/${projectId}/slots/${slotId}/clip`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  rerollComposite: (projectId: string, slotId: string) =>
    request<{ composite: CompositeState }>("/api/composite/reroll", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId, slot_id: slotId }),
    }),
  nextVideo: (projectId: string, slotId: string) =>
    request<{ slot: Slot }>("/api/search/next-video", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId, slot_id: slotId }),
    }),
  newSearch: (projectId: string, slotId: string) =>
    request<{ slot: Slot }>("/api/search/new-search", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId, slot_id: slotId }),
    }),
  manualSearch: (projectId: string, slotId: string, query: string) =>
    request<{ slot: Slot }>("/api/search/manual-search", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId, slot_id: slotId, query }),
    }),
  patchNarration: (projectId: string, muted: boolean) =>
    request<NarrationState>(`/api/project/${projectId}/narration`, {
      method: "PATCH",
      body: JSON.stringify({ muted }),
    }),
};
