// Guardrail harness: a port of the model's own travel/harness.py, plus price grounding.
// 1. Emergencies get a fixed "call 112" reply before the model is consulted, plus an urgent handoff.
// 2. Card, CVV, OTP, Aadhaar, PAN and passport numbers are removed before the model or storage see them.
// 3. The model can never book: a create_booking call becomes a confirmation summary built from supplier data.
// 4. Booking outcomes are written by templates from the tool result, never by the model.
// 5. Rupee amounts the model was not given are replaced (gatePrices).

import { randomUUID } from 'node:crypto';
import type { Offer } from './db.js';

// Deliberately narrow so "missed my flight" or "booked by accident" don't trigger it. Includes Hinglish.
const EMERGENCY = new RegExp(
  "not breathing|can'?t breathe|unconscious|collapsed|not respond|unresponsive|bleeding|heart attack|chest pain|drown|" +
  '\\bfire\\b|\\bsmoke\\b|(had|in) an accident|(road|car|bike) accident|hit by a|fell and|has fallen and|fell off|' +
  'child (is )?missing|missing child|lost (my )?(child|son|daughter|kid)|attacked|assault|' +
  'behosh|saans nahi|jawab nahi de|khoon',
  'i',
);

export function emergencyText(handedOff: boolean): string {
  return "This sounds like an emergency. Please call 112 (India's emergency number) right now and follow the dispatcher's instructions. Stay with the person, and don't move anyone who is injured unless they are in danger where they are." +
    (handedOff ? " I've alerted our support team as urgent." : '') +
    " When everyone is safe, I'm here to help with your travel plans.";
}

// [pattern, label, shows PII_NOTICE]
const PII: [RegExp, string, boolean][] = [
  [/\b(?:cvv|cvc)\s*:?\s*\d{3,4}\b/gi, '[CVV removed]', true],
  [/\botp\s*:?\s*(?:is\s*)?\d{4,8}\b/gi, '[OTP removed]', true],
  [/\b(?:\d[ -]?){12,18}\d\b/g, '[card number removed]', true], // 13-19 digits
  [/\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, '[ID number removed]', true], // Aadhaar
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[PAN removed]', true],
  [/\b[A-Z]\d{7}\b/g, '[passport number removed]', true],
  // not in the model's harness: contact details are kept out of storage too
  [/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, '[email removed]', false],
  [/(?:\+91[-\s]?|\b91[-\s]?|\b)[6-9]\d{9}\b/g, '[phone number removed]', false],
];

export const PII_NOTICE = "For your safety I removed the card or ID details from your message. Please don't share them in chat; payment happens only in the secure booking step.\n\n";
export const FALLBACK = "Sorry, I couldn't complete that just now. Could you say that again in a different way?";

export function redact(text: string): { text: string; found: boolean } {
  let found = false;
  for (const [re, label, notice] of PII) {
    text = text.replace(re, () => { found ||= notice; return label; });
  }
  return { text, found };
}

export interface IncomingPolicy { emergency: boolean; redacted: string; hadPii: boolean }

export function ingestPolicy(userTextRaw: string): IncomingPolicy {
  const { text, found } = redact(userTextRaw);
  return { emergency: EMERGENCY.test(userTextRaw), redacted: text, hadPii: found };
}

/** Reply gating: block model text that self-verifies a booking or fabricates a total. */
export function gateAssistantOutput(text: string): { text: string; blocked: boolean; reason?: string } {
  const claimsBooking = /\b(confirm(?:ed)? booking|booking ref(?:erence)? is|charged your card|payment of ₹\s?[\d,]+ successful|successfully charged)\b/i.test(text);
  if (claimsBooking) {
    return {
      text: "I can't finalize bookings from here — our platform places the order once the confirm button is pressed. Let me instead summarize what you're buying so you can confirm it.",
      blocked: true,
      reason: 'self_verified_booking',
    };
  }
  return { text, blocked: false };
}

// ── Reply formatting ────────────────────────────────────────────────────────
// The frontend renders replies as plain text, and the product's design rules ban emojis.

export function toPlainText(text: string): string {
  return text
    .replace(/\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*|\uFE0F/gu, '')
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, '$1$2') // bold
    .replace(/^[ \t]*[*+-][ \t]+/gm, '• ') // bullets
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?![*\w])/g, '$1$2') // italics
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(\S)[ \t]{2,}/g, '$1 ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Price grounding ─────────────────────────────────────────────────────────
// Every rupee amount in a reply must match a number the model was actually given
// (tool results, the deals shown, the user's own words). Anything else is replaced.

const NUM = String.raw`\d+(?:,\d+)*(?:\.\d+)?`;
const UNIT = String.raw`(?:k|l|lakhs?|lacs?|crores?|cr)`;
const AMOUNT = String.raw`${NUM}(?:\s?${UNIT}\b)?`;
// "₹51,401", "₹5-10k", "₹6,300 to ₹8,050", "Rs 51.4k", "INR 5000", "50,000 rupees", "2 lakh"
const MONEY_RE = new RegExp(
  String.raw`(?:₹|\bRs\.?|\bINR)\s?${AMOUNT}(?:\s?(?:-|–|to)\s?(?:₹\s?)?${AMOUNT})?|\b${NUM}\s?(?:${UNIT}\s?)?(?:rupees|inr)\b|\b${NUM}\s?(?:lakhs?|lacs?|crores?)\b`,
  'gi',
);
const AMOUNT_RE = new RegExp(String.raw`(${NUM})(?:\s?(${UNIT})\b)?`, 'gi');
export const UNVERIFIED_PRICE = '(price to be confirmed)';

const scale = (unit: string) => (/^(crores?|cr)$/.test(unit) ? 1e7 : /^(l|lakhs?|lacs?)$/.test(unit) ? 1e5 : unit === 'k' ? 1e3 : 1);

/** Values in one money expression; in a range the last unit applies to bare numbers ("₹5-10k" is 5,000 to 10,000). */
function moneyValues(expr: string): number[] {
  const parts = [...expr.replace(/^(?:₹|Rs\.?|INR)\s?/i, '').matchAll(AMOUNT_RE)]
    .map((m) => ({ n: Number(m[1].replace(/,/g, '')), unit: (m[2] ?? '').toLowerCase() }));
  const lastUnit = parts.at(-1)?.unit ?? '';
  return parts.map((p) => p.n * scale(p.unit || lastUnit));
}

/**
 * `facts`: tool results and deals on screen (any number ≥ 100 counts).
 * `user`: the customer's own words (their money amounts, or bare numbers ≥ 100 like "budget 80000").
 * Small bare numbers (5 days, 2 people) never back a price.
 */
export function gatePrices(text: string, sources: { facts: string; user: string }): string {
  const all = sources.facts + '\n' + sources.user;
  const allowed = [
    ...[...all.matchAll(new RegExp(NUM, 'g'))].map((m) => Number(m[0].replace(/,/g, ''))).filter((n) => n >= 100),
    ...[...sources.user.matchAll(MONEY_RE)].flatMap((m) => moneyValues(m[0])),
  ];
  // within 1% covers the model rounding a real figure ("about ₹51.4k")
  const backed = (x: number) => allowed.some((v) => Math.abs(x - v) <= Math.max(1, v * 0.01));
  return text.replace(MONEY_RE, (m) => (moneyValues(m).every(backed) ? m : UNVERIFIED_PRICE));
}

// ── Booking summary and status templates ────────────────────────────────────

const inr = (n: unknown) => `₹${Math.round(Number(n)).toLocaleString('en-IN')}`;

function rule(o: Offer): string {
  const r = String(o.rate_rule ?? o.fare_rule ?? 'Cancellation terms not provided by the supplier');
  return r.toUpperCase().replace(/-/g, '_') === 'NON_REFUNDABLE' ? 'Non-refundable (no refund if you cancel)' : r;
}

/** What the customer pays: the total plus estimated taxes when they are not included. */
export function payable(o: Offer): number {
  return Number(o.total_inr ?? 0) + (o.taxes_included === false ? Number(o.taxes_estimate_inr ?? 0) : 0);
}

export function summary(o: Offer, travellers: unknown): string {
  const [product, when] = 'hotel' in o
    ? [`${o.hotel}, ${o.room ?? 'room'}`, o.check_in ? `${o.check_in} to ${o.check_out} (${o.nights} nights)` : `${o.nights} nights`]
    : [`${o.airline ?? 'Flight'} ${o.from ?? ''} to ${o.to ?? ''}`, `${o.date ?? ''} departing ${o.departs ?? ''}`.trim()];
  const taxes = o.taxes_included === false ? `includes about ${inr(o.taxes_estimate_inr)} estimated taxes` : 'taxes included';
  return `Please confirm this booking:\n- ${product}\n- ${when}\n- Travellers: ${travellers}\n- Total: ${inr(payable(o))} (${taxes})\n- Cancellation: ${rule(o)}\n\nPress Confirm to book, or tell me what you'd like to change.`;
}

export function statusText(result: Record<string, unknown>, o: Offer): string {
  const status = String(result.status ?? '').toUpperCase();
  if (status === 'CONFIRMED') {
    return `Booked and confirmed. Reference ${result.booking_ref}. Charged ${inr(result.charged_inr ?? payable(o))}. Cancellation: ${rule(o)}.`;
  }
  if (status.startsWith('PENDING')) {
    const payment = result.payment === 'AUTHORISED_NOT_CAPTURED' ? 'Payment is authorised but not taken.' : 'Nothing has been charged.';
    return `Your booking request is submitted but not confirmed yet: the supplier still has to accept it (request ${result.request_id}). ${payment} Please don't treat it as booked until I confirm it.`;
  }
  const reason = String(result.reason ?? '').toUpperCase();
  if (reason === 'PAYMENT_DECLINED') return 'The payment was declined, so you are not booked and nothing was charged. You can try another payment method or pick another option.';
  if (reason === 'NO_LONGER_AVAILABLE' || reason === 'SOLD_OUT') return 'That option is no longer available, so you are not booked and nothing was charged. Shall I look for alternatives?';
  if (reason === 'PRICE_MISMATCH') return `The price changed to ${inr(result.current_total_inr ?? 0)}, so nothing was booked. Would you like to see the updated offer?`;
  return 'The booking did not go through, so you are not booked and nothing was charged.';
}

export function newBookingRef(): string {
  return `BK-${randomUUID().slice(0, 8).toUpperCase()}`;
}
