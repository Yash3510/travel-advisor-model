// Tool layer: deterministic mock inventory seeded from catalog.json + hashed prices.
// Mirrors the friend's tool contract (field names preserved) so the fine-tuned model reads them well.

import { randomUUID } from 'node:crypto';
import { regionForAlias } from './catalog.js';
import type { Offer } from './db.js';

export interface Backend {
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
}

function seedOf(...parts: (string | number)[]): number {
  const s = parts.join('|');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return fmtDate(d);
}

/** The model often writes "December 10"; reject anything but a real YYYY-MM-DD so it can retry. */
function isoDate(v: unknown): string | null {
  const s = String(v ?? '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) ? s : null;
}
const badDate = (field: string, why = 'must be a date in YYYY-MM-DD format') => ({ error: 'invalid_date', message: `${field} ${why}.` });

const AIRLINES = ['Air India Express', 'IndiGo', 'Akasa Air', 'Emirates', 'Thai Airways', 'Scoot'];
const DEFAULT_HOTELS = ['Riverside Boutique', 'Lakeshore Comfort', 'Heritage Escapes', 'The Serai Rooms', 'Meraki Hotels'];

export class MockBackend implements Backend {
  constructor(private catalogPath: string, private fixedToday?: string) {}

  private today(): string { return this.fixedToday ?? fmtDate(new Date()); }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'search_flights': return this.searchFlights(args);
      case 'search_hotels': return this.searchHotels(args);
      // Only reached from /api/confirm (the Confirm button); a model's create_booking call is intercepted in runTurn.
      case 'create_booking': return args.customer_confirmed_terms === true
        ? { status: 'PENDING_SUPPLIER_CONFIRMATION', request_id: String(args.request_id ?? ''), payment: 'NOT_TAKEN' }
        : { status: 'FAILED', reason: 'CONFIRMATION_REQUIRED', charged: false };
      case 'get_booking': return { status: 'NOT_FOUND', booking_ref: String(args.booking_ref ?? '') };
      case 'get_entry_requirements': return { source: 'mock_requirements', checked_at: this.today(), result: 'Visa on arrival or e-visa generally; confirm passport validity of 6 months.', also_required: ['Return flight tickets', 'Hotel booking proof'], note: 'Illustrative. Verify with the destination government site.' };
      case 'get_travel_advisory': return { source: 'mock_advisory', checked_at: this.today(), destination: String(args.destination ?? ''), advisory: 'Generally safe. Standard precautions.' };
      case 'handoff_to_human': return { status: 'TRANSFERRED', queue: args.urgency === 'urgent' ? 'urgent' : 'normal', expected_wait_minutes: args.urgency === 'urgent' ? 2 : 10 };
      // The travel guide (kb/destinations.json, built from Wikivoyage by the model repo) is not bundled yet.
      case 'get_destination_info': return { found: false, destination: String(args.destination ?? ''), message: 'No travel-guide entry for this place. It may not exist, or it may be too small to be covered.' };
      default:
        return { error: 'unknown_tool', message: `Tool ${name} is not available in this deployment.` };
    }
  }

  private searchFlights(args: Record<string, unknown>) {
    const origin = String(args.origin ?? 'Unknown');
    const destination = String(args.destination ?? 'Unknown');
    const date = args.date == null ? this.today() : isoDate(args.date);
    if (!date) return badDate('date');
    const pax = Math.max(1, Math.min(9, Number(args.passengers) || 1));
    const baseFares = [8200, 11500, 15800, 22400, 31900, 47500];
    const results: Offer[] = baseFares.map((bf, i) => {
      const h = seedOf(origin, destination, date, pax, i);
      const fare = bf + (h % 2500);
      return {
        offer_id: `OF-FL-${randomUUID()}`,
        airline: AIRLINES[h % AIRLINES.length],
        from: origin, to: destination, date,
        departs: `${String(5 + (h % 16)).padStart(2, '0')}:${h % 2 ? '15' : '55'}`,
        duration_min: 180 + (h % 300),
        stops: h % 3 === 0 ? 1 : 0,
        fare_per_person_inr: fare,
        passengers: pax,
        total_inr: fare * pax,
        baggage: pax > 1 ? '15kg checked per passenger' : '15kg checked',
        fare_rule: h % 4 === 0 ? 'NON_REFUNDABLE' : 'Refundable with 10% fee until 24h before departure',
      };
    });
    return { checked_at: this.today(), results };
  }

  private searchHotels(args: Record<string, unknown>) {
    const city = String(args.city ?? 'Unknown');
    const checkIn = isoDate(args.check_in);
    if (!checkIn) return badDate('check_in');
    let nights = Number(args.nights) || 4;
    if (args.check_out != null) {
      const checkOut = isoDate(args.check_out);
      if (!checkOut) return badDate('check_out');
      nights = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000);
      if (nights < 1) return badDate('check_out', 'must be after check_in');
    }
    nights = Math.min(30, nights);
    const guests = Math.max(1, Math.min(9, Number(args.guests) || 2));
    const maxPrice = args.max_price_per_night != null ? Number(args.max_price_per_night) : null;
    const catalogHotels = regionForAlias(city, this.catalogPath)?.deals.flatMap((d) => d.cityHotelStay.map((s) => s.hotelName));
    const names = catalogHotels?.length ? Array.from(new Set(catalogHotels)) : DEFAULT_HOTELS;

    const results: Offer[] = [];
    names.slice(0, 4).forEach((hotel, i) => {
      const h = seedOf(city, checkIn, guests, i);
      const price = 2800 + (h % 12) * 1750; // ₹2,800 – ₹22,050
      if (maxPrice != null && price > maxPrice) return;
      results.push({
        offer_id: `OF-HT-${randomUUID()}`,
        hotel, city, room: guests > 2 ? 'Family room' : 'Deluxe room',
        price_per_night_inr: price, nights, guests, check_in: checkIn, check_out: addDays(checkIn, nights),
        amenities: ['breakfast', 'wifi', 'pool'].slice(0, 1 + (h % 3)),
        rate_rule: h % 3 === 0 ? 'NON_REFUNDABLE' : `Free cancellation until ${addDays(checkIn, -2)} 23:59`,
        total_inr: price * nights,
        taxes_included: h % 2 === 0,
        taxes_estimate_inr: h % 2 === 0 ? undefined : Math.round(price * nights * 0.12),
      });
    });
    return { checked_at: this.today(), results, message: results.length ? undefined : 'No hotels matched that budget. Try widening the price range.' };
  }
}

// Exact schemas from the model's travel/tools.py: the model learned these names, fields and descriptions.
const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const S = { type: 'string' };
const I = { type: 'integer' };
const N = { type: 'number' };
const B = { type: 'boolean' };

export const toolSchemas = [
  fn('search_flights', 'Live flight search. Returns fares and availability at the time of the call.',
    { origin: S, destination: S, date: S, return_date: S, passengers: I }, ['origin', 'destination', 'date', 'passengers']),
  fn('search_hotels', 'Live hotel search across suppliers. Returns rates, rate rules and amenities.',
    { city: S, check_in: S, check_out: S, guests: I, max_price_per_night: N }, ['city', 'check_in', 'check_out', 'guests']),
  fn('create_booking', 'Create a reservation and charge the customer. Only call after the customer explicitly confirms the final summary.',
    { offer_id: S, travelers: I, total_price_inr: N, customer_confirmed_terms: B }, ['offer_id', 'travelers', 'total_price_inr', 'customer_confirmed_terms']),
  fn('get_booking', 'Look up an existing booking record by reference.', { booking_ref: S }, ['booking_ref']),
  fn('get_entry_requirements', 'Official entry/visa requirements for a passport country and destination.',
    { passport_country: S, destination_country: S, purpose: S, transit_countries: { type: 'array', items: S } }, ['passport_country', 'destination_country']),
  fn('get_travel_advisory', 'Current official travel advisories and alerts for a destination.', { destination: S }, ['destination']),
  fn('handoff_to_human', 'Transfer the conversation to a human travel agent with a case summary.',
    { summary: S, urgency: { type: 'string', enum: ['normal', 'urgent'] } }, ['summary', 'urgency']),
  fn('get_destination_info', 'Travel-guide facts about a place in India: best and worst months, how to get there (nearest airport, railway or no railway, road, sea), permits, seasonal closures and altitude. Use it for seasons, routes and whether a trip is possible. Returns found=false for places it does not know.',
    { destination: S }, ['destination']),
];
