// Searches use only what the customer said (D-023). The small model sometimes fills in dates, travellers or a
// departure city nobody gave; searching with those shows offers for a trip the customer never described.
import type { ToolBackend } from '../modelClient.js';
import type { TripContext } from '../domain/trip.js';
import { log } from '../log.js';

export interface Known { trip: Partial<TripContext>; homeCity?: string; /** everything the customer has written in this thread */ userText: string }

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The details a search needs that the customer hasn't given, or its arguments set to what they did give. */
export function groundSearch(name: string, args: Record<string, unknown>, k: Known): { missing: string[] } | { args: Record<string, unknown> } {
  const t = k.trip;
  const travellers = t.travelers ?? (t.travelerTypes?.includes('solo') ? 1 : t.travelerTypes?.includes('couple') ? 2 : undefined);
  const missing: string[] = [];
  if (name === 'search_hotels') {
    if (!t.startDate) missing.push('check-in date');
    if (!t.endDate && !t.durationDays) missing.push('check-out date or number of nights');
    if (!travellers) missing.push('number of guests');
    if (missing.length) return { missing };
    const checkOut = t.endDate ?? addDays(t.startDate!, t.durationDays!);
    return { args: { ...args, check_in: t.startDate, check_out: checkOut, guests: travellers } };
  }
  if (name === 'search_flights') {
    // the model's departure city counts only if the customer named it
    const said = typeof args.origin === 'string' && args.origin.length > 2 && k.userText.toLowerCase().includes(args.origin.toLowerCase());
    const origin = t.origin ?? (said ? String(args.origin) : k.homeCity);
    if (!origin) missing.push('departure city');
    if (!t.startDate) missing.push('travel date');
    if (!travellers) missing.push('number of passengers');
    if (missing.length) return { missing };
    // a return-leg search keeps the model's date if it is one of the trip's dates
    const date = t.endDate && args.date === t.endDate ? t.endDate : t.startDate;
    return { args: { ...args, ...(origin ? { origin } : {}), date, passengers: travellers } };
  }
  return { args };
}

/** Wrap the tools: searches with details the customer never gave are refused with what to ask for. */
export function groundedTools(inner: ToolBackend, known: () => Known): ToolBackend {
  return {
    call: async (name, args) => {
      const g = groundSearch(name, args, known());
      if ('missing' in g) {
        log('info', 'search held: details not given by the customer', { tool: name, missing: g.missing });
        return { status: 'NEEDS_CUSTOMER_DETAILS', missing: g.missing, note: 'Ask the customer for these. Never guess them.' };
      }
      return inner.call(name, g.args);
    },
  };
}
