import { describe, expect, it } from 'vitest';
import { redact, ingestPolicy, gateAssistantOutput, gatePrices, emergencyText, summary, toPlainText } from '../src/harness.js';
import { detectRegion } from '../src/catalog.js';
import { buildSystemPrompt } from '../src/prompts.js';

describe('harness guardrails', () => {
  it('redacts card, ID, CVV, OTP, PAN and contact details', () => {
    expect(redact('charge 4111 1111 1111 1111').text).toBe('charge [card number removed]');
    expect(redact('aadhaar 2345 6789 0123').text).toBe('aadhaar [ID number removed]');
    expect(redact('cvv 123, otp is 456789, PAN ABCDE1234F').text).toBe('[CVV removed], [OTP removed], PAN [PAN removed]');
    expect(redact('mail ravi.k@example.com or call +91 9876543210').text).toBe('mail [email removed] or call [phone number removed]');
    expect(redact('5 nights in Goa').found).toBe(false);
    // the notice talks about card or ID details, so contact details alone don't trigger it
    expect(redact('mail ravi.k@example.com').found).toBe(false);
  });
  it('routes real emergencies to 112 but not ordinary travel trouble', () => {
    expect(ingestPolicy('my father collapsed and is not breathing').emergency).toBe(true);
    expect(ingestPolicy('I booked the wrong date by accident').emergency).toBe(false);
    expect(ingestPolicy('I missed my flight, what now?').emergency).toBe(false);
    expect(emergencyText(true)).toContain('112');
  });
  it('blocks self-confirmed bookings', () => {
    expect(gateAssistantOutput('Your booking reference is BK-123. Payment of ₹14,000 successful.').blocked).toBe(true);
    expect(gateAssistantOutput('Best time to visit is October.').blocked).toBe(false);
  });
  it('summarises a booking with taxes and cancellation terms from the offer', () => {
    const offer = { offer_id: 'OF-HT-1', hotel: 'Lake View', room: 'Deluxe room', check_in: '2026-12-12', check_out: '2026-12-15', nights: 3,
      total_inr: 15000, taxes_included: false, taxes_estimate_inr: 1800, rate_rule: 'NON_REFUNDABLE' };
    const text = summary(offer, 2);
    expect(text).toContain('Total: ₹16,800 (includes about ₹1,800 estimated taxes)');
    expect(text).toContain('Cancellation: Non-refundable');
  });
});

describe('catalog', () => {
  it('detects Bali', () => {
    const r = detectRegion('I want to go to Bali in December', 'data/catalog.json');
    expect(r?.name).toBe('Bali');
    expect(r?.code).toBe('idn');
  });
  it('detects Japan', () => {
    const r = detectRegion('trip to tokyo', 'data/catalog.json');
    expect(r?.code).toBe('jpn');
  });
  it('returns null for unknown', () => {
    expect(detectRegion('plan something', 'data/catalog.json')).toBeNull();
  });
});

describe('system prompt', () => {
  it('is the trained prompt with the deployment date in the trained format', () => {
    const p = buildSystemPrompt('2026-10-17');
    expect(p).toContain("Today's date: Saturday, 17 October 2026.");
    expect(p).toMatch(/^You are a travel advisor and booking assistant for trips in India\./);
  });
});

describe('reply formatting', () => {
  it('turns model markdown into clean plain text without emojis', () => {
    const md = '## Options 🌴\n\n*   **Riverside** – ₹60,900 ✈️\n- Lakeshore 🇮🇳 *quiet*\n\n\n\nEnjoy! 😊';
    expect(toPlainText(md)).toBe('Options\n\n• Riverside – ₹60,900\n• Lakeshore quiet\n\nEnjoy!');
  });
  it('keeps the © of licence credits', () => {
    expect(toPlainText('Map data © OpenStreetMap contributors 🌍')).toBe('Map data © OpenStreetMap contributors');
  });
  it('leaves plain text and numbered lists alone', () => {
    expect(toPlainText('1. Day one\n2. Day two')).toBe('1. Day one\n2. Day two');
  });
});

describe('price gate', () => {
  it('replaces amounts that no tool or user message supplied', () => {
    expect(gatePrices('Flights cost ₹23,456 each.', { facts: '', user: '' })).toBe('Flights cost (price to be confirmed) each.');
  });
  it('keeps amounts backed by tool results, user text or rounding', () => {
    const text = 'The deal is ₹51,401, within your ₹1,00,000 budget (about Rs 51.4k).';
    expect(gatePrices(text, { facts: '{"total_inr":51401}', user: 'budget 1 lakh' })).toBe(text);
  });
  it('understands lakh shorthand', () => {
    expect(gatePrices('Expect around 2 lakh.', { facts: '', user: 'budget 1 lakh' })).toBe('Expect around (price to be confirmed).');
  });
  it('checks both ends of a range and ignores small numbers like trip length', () => {
    const user = '5 day trip for 2 people, budget around 1 lakh';
    expect(gatePrices('Most trips cost ₹5-10k.', { facts: '{"nights":5}', user })).toBe('Most trips cost (price to be confirmed).');
    expect(gatePrices('Hotels run ₹6,300 to ₹8,050 a night.', { facts: '[6300, 8050]', user })).toBe('Hotels run ₹6,300 to ₹8,050 a night.');
  });
});
