export interface LatLon { lat: number; lon: number }

/** Great-circle distance in kilometres. */
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export const validLatLon = (p: Partial<LatLon> | undefined): p is LatLon =>
  !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat!) <= 90 && Math.abs(p.lon!) <= 180 && !(p.lat === 0 && p.lon === 0);
