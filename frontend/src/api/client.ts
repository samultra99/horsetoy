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

export interface ClipState {
  source_url: string | null;
  local_path: string | null;
  download_status: "empty" | "pending" | "ready" | "failed";
  trim_start: number;
  trim_end: number;
  crop_rect: { x: number; y: number; w: number; h: number };
  zoom: number;
  volume: number;
  muted: boolean;
  needs_attention: boolean;
}

export interface Slot {
  id: string;
  noun: string;
  start_time: number;
  duration: number;
  search: { candidates: SearchCandidate[]; active_index: number; manual_override: string | null };
  results: { seen_video_ids: string[]; next_rank_to_try: number };
  clip: ClipState;
  composite: { mode: "cut" | "overlay"; layer: number; overlay_of: string[]; locked: boolean };
}

export interface BuildResponse {
  project_id: string;
  narration_audio_url: string;
  total_duration: number;
  nouns: NounInfo[];
  slots: Slot[];
}

export interface Project {
  id: string;
  text: string;
  slots: Slot[];
  narration: { audio_path: string | null; muted: boolean };
  total_duration: number;
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
};
