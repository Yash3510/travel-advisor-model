// Sample itineraries for the public /trips pages (data/samples.json, built by `npm run data:samples`).
import fs from 'node:fs';
import type { ItineraryDraft } from './itinerary.js';

export interface Sample { slug: string; title: string; blurb: string; destination: string; days: number; who: string; pace: string; interests: string[]; guide: string | null; itinerary: ItineraryDraft }

let samples: Sample[] | undefined;
const all = () => (samples ??= (JSON.parse(fs.readFileSync(new URL('../../data/samples.json', import.meta.url), 'utf8')) as { samples: Sample[] }).samples);

export const sampleList = () => all().map(({ itinerary: _plan, ...card }) => card);
export const sample = (slug: string) => all().find((s) => s.slug === slug) ?? null;
