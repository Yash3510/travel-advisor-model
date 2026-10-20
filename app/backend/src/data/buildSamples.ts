// Sample itineraries for the public /trips pages, built by the same engine and OpenStreetMap data the chat uses.
// No dates and no weather: a sample is a starting point, the chat makes it the customer's own.
// usage: npm run data:samples   (writes data/samples.json; commit it)
import fs from 'node:fs';
import { emptyProfile } from '../domain/profile.js';
import { emptyTrip } from '../domain/trip.js';
import type { TravelStyle } from '../domain/profile.js';
import { buildCheckedPlan } from '../services/planBuilder.js';
import { loadPlaces } from './poiStore.js';
import { guideEntry, guideList } from '../domain/guide.js';

interface Spec { slug: string; destination: string; days: number; who: 'solo' | 'couple' | 'family' | 'friends'; pace: TravelStyle; interests: string[]; title: string; blurb: string }

const SPECS: Spec[] = [
  { slug: '4-days-in-goa-for-a-couple', destination: 'Goa', days: 4, who: 'couple', pace: 'relaxed', interests: ['beach', 'food'], title: '4 days in Goa for a couple', blurb: 'Beaches and food at an easy pace.' },
  { slug: '3-days-in-jaipur', destination: 'Jaipur', days: 3, who: 'friends', pace: 'balanced', interests: ['history', 'culture', 'shopping'], title: '3 days in Jaipur', blurb: 'Forts, palaces and markets with friends.' },
  { slug: '3-days-in-udaipur', destination: 'Udaipur', days: 3, who: 'couple', pace: 'relaxed', interests: ['history', 'culture'], title: '3 days in Udaipur', blurb: 'Palaces and lakes, unhurried.' },
  { slug: '2-days-in-agra', destination: 'Agra', days: 2, who: 'family', pace: 'balanced', interests: ['history'], title: '2 days in Agra with family', blurb: 'The monuments, with time to rest.' },
  { slug: '3-days-in-varanasi', destination: 'Varanasi', days: 3, who: 'solo', pace: 'balanced', interests: ['spiritual', 'culture', 'history'], title: '3 days in Varanasi', blurb: 'Ghats, temples and old lanes, solo.' },
  { slug: '4-days-in-rishikesh', destination: 'Rishikesh', days: 4, who: 'friends', pace: 'packed', interests: ['adventure', 'spiritual', 'nature'], title: '4 days in Rishikesh', blurb: 'Adventure and ashrams by the Ganga.' },
  { slug: '5-days-in-manali', destination: 'Manali', days: 5, who: 'friends', pace: 'balanced', interests: ['mountains', 'nature', 'adventure'], title: '5 days in Manali', blurb: 'Mountains, valleys and a bit of adventure.' },
  { slug: '5-days-in-ladakh', destination: 'Leh', days: 5, who: 'friends', pace: 'relaxed', interests: ['mountains', 'spiritual', 'nature'], title: '5 days in Ladakh', blurb: 'Monasteries and high passes, with slow first days for the altitude.' },
  { slug: '3-days-in-munnar', destination: 'Munnar', days: 3, who: 'couple', pace: 'relaxed', interests: ['nature', 'mountains'], title: '3 days in Munnar', blurb: 'Tea hills and viewpoints for two.' },
  { slug: '3-days-in-kochi', destination: 'Kochi', days: 3, who: 'family', pace: 'balanced', interests: ['history', 'culture', 'food'], title: '3 days in Kochi', blurb: 'Old Fort Kochi, food and heritage with family.' },
  { slug: '3-days-in-darjeeling', destination: 'Darjeeling', days: 3, who: 'couple', pace: 'relaxed', interests: ['mountains', 'nature', 'culture'], title: '3 days in Darjeeling', blurb: 'Hill views, tea and monasteries.' },
  { slug: '3-days-in-hampi', destination: 'Hampi', days: 3, who: 'solo', pace: 'balanced', interests: ['history', 'culture'], title: '3 days in Hampi', blurb: 'Ruins and temples across the boulders.' },
  { slug: '3-days-in-pondicherry', destination: 'Pondicherry', days: 3, who: 'couple', pace: 'relaxed', interests: ['beach', 'food', 'culture'], title: '3 days in Pondicherry', blurb: 'The French quarter, cafés and the sea.' },
  { slug: '3-days-in-coorg', destination: 'Coorg', days: 3, who: 'family', pace: 'relaxed', interests: ['nature', 'mountains'], title: '3 days in Coorg', blurb: 'Coffee country, waterfalls and green hills.' },
  { slug: '3-days-in-mumbai', destination: 'Mumbai', days: 3, who: 'friends', pace: 'packed', interests: ['food', 'culture', 'history', 'nightlife'], title: '3 days in Mumbai', blurb: 'The city at full speed with friends.' },
  { slug: '3-days-in-amritsar', destination: 'Amritsar', days: 3, who: 'family', pace: 'balanced', interests: ['spiritual', 'history', 'food'], title: '3 days in Amritsar', blurb: 'The Golden Temple, history and Punjabi food.' },
];

const out = [];
for (const s of SPECS) {
  const places = loadPlaces(s.destination);
  if (!places) throw new Error(`no place data for ${s.destination}`);
  const trip = { ...emptyTrip(), destination: s.destination, durationDays: s.days, travelerTypes: [s.who], travelers: s.who === 'solo' ? 1 : s.who === 'couple' ? 2 : undefined };
  const profile = { ...emptyProfile(), travelStyle: s.pace, interests: s.interests };
  const { draft } = await buildCheckedPlan({ trip, profile, insights: [], pois: places.pois });
  const stops = draft.days.flatMap((d) => d.items).filter((i) => i.kind === 'activity').length;
  // a sample is a showcase: one where the map data is too thin to fill the days is left out, and said so
  if (draft.days.length !== s.days || stops < s.days * 2) { console.warn(`SKIPPED ${s.slug}: thin plan (${draft.days.length} days, ${stops} stops)`); continue; }
  // the destination guide page, when there is one (checked here so the site never links to a missing page)
  const name = guideEntry(s.destination)?.destination; // same alias rules as the chat (Pondicherry → Puducherry)
  const guide = guideList().find((g) => g.name === name)?.slug ?? null;
  out.push({ ...s, guide, itinerary: draft });
  console.log(`${s.slug.padEnd(30)} ${draft.days.length} days, ${stops} stops`);
}
fs.writeFileSync(new URL('../../data/samples.json', import.meta.url), JSON.stringify({ built: new Date().toISOString().slice(0, 10), samples: out }));
console.log(`wrote ${out.length} samples`);
