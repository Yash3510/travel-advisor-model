import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { MockBackend } from '../src/tools.js';

const backend = new MockBackend(config.catalogPath, '2026-10-17');

describe('mock inventory tools', () => {
  it('derives hotel nights from the check-out date', async () => {
    const r = (await backend.call('search_hotels', { city: 'Ubud', check_in: '2026-12-10', check_out: '2026-12-13', guests: 2 })) as any;
    expect(r.results[0].nights).toBe(3);
    expect(r.results[0].total_inr).toBe(r.results[0].price_per_night_inr * 3);
  });
  it('returns an error instead of throwing on bad dates', async () => {
    const r = (await backend.call('search_hotels', { city: 'Ubud', check_in: 'December 10', check_out: 'soon', guests: 2 })) as any;
    expect(r.error).toBe('invalid_date');
  });
  it('books only with confirmed terms, and only as pending', async () => {
    expect(((await backend.call('create_booking', {})) as any).reason).toBe('CONFIRMATION_REQUIRED');
    expect(((await backend.call('create_booking', { customer_confirmed_terms: true })) as any).status).toBe('PENDING_SUPPLIER_CONFIRMATION');
  });
});
