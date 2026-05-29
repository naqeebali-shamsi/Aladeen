// Convert a millisecond epoch to ISO-8601. Returns undefined for falsy
// or non-finite inputs so callers don't have to guard.
export function msToIso(ms: number | undefined): string | undefined {
  if (!ms || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}
