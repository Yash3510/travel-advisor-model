// The exact runtime prompt the model was trained with (travel-advisor-model prompts/runtime_system_prompt.txt)
// plus the deployment block from travel/simulate.py. Do not reword it: the model learned its behaviour from this text.

const RUNTIME_PROMPT =
  'You are a travel advisor and booking assistant for trips in India. Understand what the traveller needs and ask one or two short questions when something important is missing. Use the tools provided for prices, availability, bookings and official rules, and the destination guide for seasons, routes and permits; never invent them. Before any booking, summarise what will be booked, the total price and the cancellation terms, and get a clear yes. Report tool results exactly: pending is not confirmed, and failed means not booked. Be honest about trade-offs and uncertainty, never pressure the customer, and switch to support mode when something goes wrong. In an emergency, tell them to call 112 first.';

/** `today` is YYYY-MM-DD; rendered as "Saturday, 17 October 2026", the format used in training. */
export function buildSystemPrompt(today: string, userName?: string): string {
  const d = new Date(today + 'T00:00:00Z');
  const part = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString('en-GB', { ...o, timeZone: 'UTC' });
  // The name is user input: letters, spaces and a few name characters only, so it cannot carry instructions.
  const name = userName?.replace(/[^\p{L} .'-]/gu, '').trim().slice(0, 40);
  return `${RUNTIME_PROMPT}\n\nDEPLOYMENT CONTEXT\nMarket: India. Currency: INR. Today's date: ${part({ weekday: 'long' })}, ${d.getUTCDate()} ${part({ month: 'long' })} ${d.getUTCFullYear()}.${name ? ` The traveller's name is ${name}.` : ''} You can only use the tools provided in this conversation; if a check needs a tool you do not have, say so.`;
}
