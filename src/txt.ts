export function txt(v: unknown): string {
  return typeof v === "string" ? v : "";
}
