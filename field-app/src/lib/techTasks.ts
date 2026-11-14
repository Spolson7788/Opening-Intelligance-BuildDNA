/** Off unless the staging field build sets VITE_OI_TECH_TASKS=true. Production builds do not. */
export function techTasksEnabled(): boolean {
  const flag = (import.meta as ImportMeta & { env?: { VITE_OI_TECH_TASKS?: string } }).env?.VITE_OI_TECH_TASKS;
  return flag === "true";
}

export function techHome(): string {
  return techTasksEnabled() ? "/tasks/day" : "/scan";
}

/** After a site is chosen, the task path opens that site's doors. */
export function techSite(): string {
  return techTasksEnabled() ? "/tasks/site" : "/scan";
}
