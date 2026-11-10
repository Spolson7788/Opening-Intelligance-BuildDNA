declare const __FIELD_BUILD_SHA__: string | undefined;

/** Commit baked into this JavaScript bundle when the field app was built. */
export function fieldBuildSha(): string {
  const sha = typeof __FIELD_BUILD_SHA__ === "string" ? __FIELD_BUILD_SHA__.trim() : "";
  return sha || "unknown";
}

export function fieldBuildLabel(full = false): string {
  const sha = fieldBuildSha();
  const shown = full || sha === "unknown" || sha.length <= 12 ? sha : sha.slice(0, 12);
  return `Build ${shown}`;
}
