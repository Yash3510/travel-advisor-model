// OpenAI-compatible chat client (llama-server or a hosted provider), with an agent loop over tool results.
import { config } from './config.js';
import type { Offer, StoredMessage } from './db.js';
import { FALLBACK, payable, summary } from './harness.js';

export interface Turn { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: unknown[]; name?: string; tool_call_id?: string }
export interface ToolCall { id?: string; name: string; args: Record<string, unknown> }
export interface ToolBackend { call(n: string, args: Record<string, unknown>): Promise<unknown> }
export interface PendingBooking { offer_id: string; travelers: unknown; total_price_inr: number }

export class ModelError extends Error {}

interface ModelOpts { base: string; apiKey?: string; model: string; timeoutMs?: number; signal?: AbortSignal }

/** Keep the newest messages within a character budget, starting at a user message so no tool result is orphaned. */
export function trimHistory(turns: Turn[], maxChars: number): Turn[] {
  let total = 0;
  let start = turns.length;
  for (let i = turns.length - 1; i >= 0; i--) {
    total += turns[i].content.length + (turns[i].tool_calls ? JSON.stringify(turns[i].tool_calls).length : 0);
    if (total > maxChars) break;
    start = i;
  }
  if (start === 0) return turns;
  while (start < turns.length && turns[start].role !== 'user') start++;
  return turns.slice(start);
}

/**
 * One model call. With `onText`, the reply is streamed and `onText` gets the visible text so far after every chunk
 * (thinking tags removed); a provider that answers without streaming still works.
 */
export async function chatCompletion(opts: ModelOpts & { messages: Turn[]; tools?: unknown[]; onText?: (soFar: string) => void }): Promise<{ content: string; toolCalls: ToolCall[] }> {
  // Sampling the model was evaluated with (travel/harness.py OpenAIClient). Thinking stays off: trained without it.
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: 0.7,
    top_p: 0.8,
    max_tokens: 1024,
    stream: !!opts.onText,
    chat_template_kwargs: { enable_thinking: false },
  };
  if (config.modelTopK > 0) body.top_k = config.modelTopK;
  if (opts.tools?.length) body.tools = opts.tools;

  let res: Response;
  try {
    res = await fetch(`${opts.base.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 60000), ...(opts.signal ? [opts.signal] : [])]),
    });
  } catch (err) {
    throw new ModelError(`model unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new ModelError(`model ${res.status}: ${t.slice(0, 400)}`);
  }
  if (opts.onText && res.body && /text\/event-stream/.test(res.headers.get('content-type') ?? '')) return readStream(res.body, opts.onText);
  const json = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] } }[] };
  const msg = json.choices?.[0]?.message;
  if (!msg) throw new ModelError('model returned no choices');
  const toolCalls = (msg.tool_calls ?? [])
    .map((tc) => ({ id: tc.id, name: tc.function?.name ?? '', args: safeParse(tc.function?.arguments) }))
    .filter((tc) => !!tc.name);
  const rawContent = (typeof msg.content === 'string' && msg.content.trim())
    ? msg.content
    : (typeof (msg as { reasoning_content?: string })?.reasoning_content === 'string' ? (msg as { reasoning_content?: string }).reasoning_content! : '');
  const content = rawContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return { content, toolCalls };
}

const visible = (raw: string) => raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '');

/** OpenAI-style SSE: content arrives in pieces; tool calls arrive as pieces keyed by index (name, then argument text). */
async function readStream(body: ReadableStream<Uint8Array>, onText: (soFar: string) => void): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const decoder = new TextDecoder();
  let buf = '';
  let raw = '';
  const calls: { id?: string; name: string; args: string }[] = [];
  const handle = (data: string) => {
    if (data === '[DONE]') return;
    let chunk: { choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] };
    try { chunk = JSON.parse(data); } catch { return; }
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    for (const tc of delta.tool_calls ?? []) {
      const c = (calls[tc.index ?? calls.length] ??= { name: '', args: '' });
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
    }
    if (delta.content) {
      raw += delta.content;
      // text that comes with tool calls is not the reply: only report it while no tool call has started
      if (!calls.length) onText(visible(raw).trimStart());
    }
  };
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) handle(line.slice(5).trim());
      }
    }
  } catch (err) {
    throw new ModelError(`model stream broke: ${(err as Error).message}`);
  }
  if (buf.startsWith('data:')) handle(buf.slice(5).trim());
  const toolCalls = calls.filter((c) => c.name).map((c) => ({ id: c.id, name: c.name, args: safeParse(c.args) }));
  return { content: visible(raw).trim(), toolCalls };
}

function safeParse(v: unknown): Record<string, unknown> {
  if (typeof v === 'object' && v != null) return v as Record<string, unknown>;
  try { return JSON.parse(String(v)); } catch { return {}; }
}

const offersIn = (result: unknown): Offer[] => {
  const list = (result as { results?: unknown } | null)?.results;
  return Array.isArray(list) ? list.filter((o): o is Offer => typeof o?.offer_id === 'string') : [];
};

/**
 * One customer message: loop model-with-tools until a plain reply, at most `maxToolRounds` tool rounds.
 * A create_booking call never runs: it ends the turn with a confirmation summary built from the offer.
 * Returns the new messages to store (tool calls, tool results, final reply) in order.
 */
export async function runTurn(opts: ModelOpts & {
  messages: Turn[];
  backend: ToolBackend;
  tools: unknown[];
  findOffer: (offerId: string) => Offer | undefined;
  maxToolRounds?: number;
  /** progress: a tool is about to run ('thinking' before each model round) */
  onStep?: (step: string) => void;
  /** the reply being written in the current round, with the tool results so far (for checking it); '' = start over */
  onDraft?: (soFar: string, toolResults: string[]) => void;
}): Promise<{ reply: string; added: StoredMessage[]; offers: Offer[]; pendingBooking?: PendingBooking; toolTrace: { name: string; args: unknown; result: unknown }[] }> {
  const added: StoredMessage[] = [];
  const offers: Offer[] = [];
  const trace: { name: string; args: unknown; result: unknown }[] = [];
  const tools = new Set(opts.tools.map((t) => (t as { function: { name: string } }).function.name));
  const finish = (reply: string, pendingBooking?: PendingBooking) => {
    added.push({ role: 'assistant', content: reply });
    return { reply, added, offers, pendingBooking, toolTrace: trace };
  };

  for (let round = 0; round <= (opts.maxToolRounds ?? 4); round++) {
    opts.onStep?.(round === 0 ? 'thinking' : 'writing');
    const toolResults = added.filter((m) => m.role === 'tool').map((m) => m.content);
    const out = await chatCompletion({
      ...opts, messages: [...opts.messages, ...added], tools: opts.tools,
      ...(opts.onDraft ? { onText: (t: string) => opts.onDraft!(t, toolResults) } : {}),
    });
    if (!out.toolCalls.length) return finish(out.content || FALLBACK);
    opts.onDraft?.('', toolResults); // that text was a preamble to tool calls, not the reply

    // the id on the assistant's tool_call and on its tool result must be the same string
    const calls = out.toolCalls.map((tc, j) => ({ ...tc, id: tc.id || `call_${round}_${j}` }));
    added.push({ role: 'assistant', content: out.content, tool_calls: calls.map((c) => ({
      id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) },
    })) });
    for (const c of calls) {
      const reply = (result: unknown) => added.push({ role: 'tool', name: c.name, tool_call_id: c.id, content: JSON.stringify(result) });
      opts.onStep?.(c.name);
      if (c.name === 'create_booking') {
        const id = String(c.args.offer_id ?? '');
        const offer = offers.find((o) => o.offer_id === id) ?? opts.findOffer(id);
        if (!offer) { reply({ status: 'FAILED', reason: 'UNKNOWN_OFFER' }); continue; }
        const travelers = c.args.travelers || offer.guests || offer.passengers;
        reply({ status: 'AWAITING_CUSTOMER_CONFIRMATION' });
        return finish(summary(offer, travelers), { offer_id: offer.offer_id, travelers, total_price_inr: payable(offer) });
      }
      let result: unknown;
      try {
        result = tools.has(c.name) ? await opts.backend.call(c.name, c.args) : { error: 'UNKNOWN_TOOL' };
      } catch (err) {
        result = { error: 'tool_failed', message: (err as Error).message };
      }
      trace.push({ name: c.name, args: c.args, result });
      offers.push(...offersIn(result));
      reply(result);
    }
  }
  return finish(FALLBACK);
}
