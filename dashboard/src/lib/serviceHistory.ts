// Copy of field-app/src/lib/serviceHistory.ts (the dashboard is built separately); tests check both are identical.
// Separates an opening's service history into opening-level events and one history per hardware
// component (for example each closer of a paired opening). An event belongs to a component only
// when its hardware_component_id names a component of this same opening; opening-level events
// (no component) are kept apart and never shown under a component.
export interface ServiceEventRow { id: string; hardware_component_id?: string | null; event_date: string; work_performed?: string | null; cost?: number | string | null }
export interface ComponentRow { id: string; component_type: string; door_leaf_id?: string | null; frame_id?: string | null; mounting_scope?: string | null; manufacturer?: string | null; model_number?: string | null }
export interface LeafRow { id: string; leaf_role: string }
export interface OpeningServiceView { service_events?: ServiceEventRow[]; hardware_components?: ComponentRow[]; door_leaves?: LeafRow[] }

export function componentLabel(component: ComponentRow, opening: OpeningServiceView): string {
  const type = component.component_type.replace(/_/g, " ");
  const leaf = component.door_leaf_id ? (opening.door_leaves || []).find((l) => l.id === component.door_leaf_id) : undefined;
  const place = leaf ? (leaf.leaf_role === "single" ? "door" : `${leaf.leaf_role} leaf`) : component.mounting_scope === "frame" || component.frame_id ? "frame" : "";
  const model = [component.manufacturer, component.model_number].filter(Boolean).join(" ");
  return [type.charAt(0).toUpperCase() + type.slice(1), place, model].filter(Boolean).join(" · ");
}

export function splitServiceHistory(opening: OpeningServiceView) {
  const components = opening.hardware_components || [];
  const known = new Set(components.map((c) => c.id));
  const openingLevel: ServiceEventRow[] = [];
  const unmatched: ServiceEventRow[] = [];
  const byComponent = new Map<string, ServiceEventRow[]>(components.map((c) => [c.id, []]));
  for (const event of opening.service_events || []) {
    if (!event.hardware_component_id) openingLevel.push(event);
    else if (known.has(event.hardware_component_id)) byComponent.get(event.hardware_component_id)!.push(event);
    else unmatched.push(event);
  }
  const newestFirst = (a: ServiceEventRow, b: ServiceEventRow) => String(b.event_date).localeCompare(String(a.event_date));
  openingLevel.sort(newestFirst); unmatched.sort(newestFirst);
  for (const list of byComponent.values()) list.sort(newestFirst);
  return { openingLevel, byComponent, unmatched };
}
