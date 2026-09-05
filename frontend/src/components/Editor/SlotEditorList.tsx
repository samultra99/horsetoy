import { useProjectStore } from "../../state/projectStore";
import { SlotEditorCard } from "./SlotEditorCard";

export function SlotEditorList() {
  const status = useProjectStore((s) => s.status);
  const slots = useProjectStore((s) => s.slots);

  if (status !== "ready") return null;
  const readySlots = slots.filter((s) => s.clip.download_status === "ready");
  if (readySlots.length === 0) return null;

  return (
    <div style={{ marginTop: "1rem" }}>
      <h3 style={{ fontSize: 13, color: "#888", marginBottom: 0 }}>Edit clips</h3>
      {readySlots.map((slot) => (
        <SlotEditorCard key={slot.id} slot={slot} />
      ))}
    </div>
  );
}
