// A subset of OpenStreetMap's opening_hours syntax: day ranges and lists, several time ranges, off/closed,
// 24/7, overnight hours and sunrise-sunset. Anything else stays "unparsed" and is treated as unknown.

/** weekly[0] is Monday; each day is a list of [open, close] in minutes after midnight (close may pass 1440). */
export interface OpeningHours {
  basis: 'osm' | 'unparsed' | 'unknown';
  raw?: string;
  weekly?: [number, number][][];
  confidence: number;
}

const DAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];
const SUNRISE_SUNSET: [number, number] = [6 * 60, 18 * 60 + 30];
const unparsed = (raw: string): OpeningHours => ({ basis: 'unparsed', raw, confidence: 0.1 });

function parseDays(part: string): number[] | null {
  const out: number[] = [];
  for (const token of part.split(',').map((t) => t.trim().toLowerCase())) {
    const [from, to] = token.split(/\s*-\s*/);
    const a = DAYS.indexOf(from);
    const b = to === undefined ? a : DAYS.indexOf(to);
    if (a < 0 || b < 0) return null;
    for (let d = a; ; d = (d + 1) % 7) {
      if (!out.includes(d)) out.push(d);
      if (d === b) break;
    }
  }
  return out;
}

function parseTimes(part: string): { intervals: [number, number][]; approximate: boolean } | null {
  const intervals: [number, number][] = [];
  let approximate = false;
  for (const range of part.split(',').map((t) => t.trim())) {
    if (/^sunrise\s*-\s*sunset$/i.test(range)) { intervals.push(SUNRISE_SUNSET); approximate = true; continue; }
    const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(range);
    if (!m) return null;
    const open = Number(m[1]) * 60 + Number(m[2]);
    let close = Number(m[3]) * 60 + Number(m[4]);
    if (open > 1440 || close > 1440 || Number(m[2]) > 59 || Number(m[4]) > 59) return null;
    if (close <= open) close += 1440; // overnight
    intervals.push([open, close]);
  }
  return { intervals, approximate };
}

const all = (iv: [number, number][]) => Array.from({ length: 7 }, () => iv.map((x): [number, number] => [x[0], x[1]]));

export function parseOpeningHours(raw: string | undefined): OpeningHours {
  const text = raw?.trim();
  if (!text) return { basis: 'unknown', confidence: 0 };
  if (text === '24/7') return { basis: 'osm', raw: text, weekly: all([[0, 1440]]), confidence: 0.7 };

  // OSM: days that no rule mentions are closed; later rules override earlier ones for their days
  const weekly: [number, number][][] = all([]);
  let confidence = 0.7;
  for (const rule of text.split(';').map((r) => r.trim()).filter(Boolean)) {
    if (/^PH\b/i.test(rule)) { confidence = Math.min(confidence, 0.6); continue; } // no holiday calendar
    const m = /^(?:([A-Za-z]{2}(?:\s*-\s*[A-Za-z]{2})?(?:\s*,\s*[A-Za-z]{2}(?:\s*-\s*[A-Za-z]{2})?)*)\s+)?(.+)$/.exec(rule);
    const days = m?.[1] ? parseDays(m[1]) : [0, 1, 2, 3, 4, 5, 6];
    if (!m || !days) return unparsed(text);
    if (/^(?:off|closed)$/i.test(m[2].trim())) { for (const d of days) weekly[d] = []; continue; }
    const times = parseTimes(m[2]);
    if (!times) return unparsed(text);
    if (times.approximate) confidence = Math.min(confidence, 0.5);
    for (const d of days) weekly[d] = times.intervals.map((x): [number, number] => [x[0], x[1]]);
  }
  return { basis: 'osm', raw: text, weekly, confidence };
}

/** Monday = 0 */
export const weekday = (date: string) => (new Date(Date.parse(date)).getUTCDay() + 6) % 7;

/** Is the place open for the whole of [start, end] (minutes after midnight) on that date? */
export function isOpen(oh: OpeningHours, date: string, start: number, end: number): 'yes' | 'no' | 'unknown' {
  if (!oh.weekly) return 'unknown';
  const d = weekday(date);
  const spill = oh.weekly[(d + 6) % 7].filter(([, c]) => c > 1440).map(([, c]): [number, number] => [0, c - 1440]);
  return [...oh.weekly[d], ...spill].some(([o, c]) => o <= start && end <= c) ? 'yes' : 'no';
}
