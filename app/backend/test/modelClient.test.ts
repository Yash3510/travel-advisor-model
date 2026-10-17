import { describe, expect, it } from 'vitest';
import { trimHistory, type Turn } from '../src/modelClient.js';

const t = (role: Turn['role'], content: string): Turn => ({ role, content });

describe('trimHistory', () => {
  it('keeps everything that fits', () => {
    const h = [t('assistant', 'hi'), t('user', 'Goa?'), t('assistant', 'Sure')];
    expect(trimHistory(h, 1000)).toEqual(h);
  });
  it('drops the oldest turns and never starts on a tool result or a reply', () => {
    const h = [t('user', 'a'.repeat(50)), t('assistant', 'b'.repeat(50)), t('user', 'find hotels'), t('tool', 'x'.repeat(20)), t('assistant', 'done'), t('user', 'book it')];
    expect(trimHistory(h, 60).map((m) => m.role)).toEqual(['user', 'tool', 'assistant', 'user']);
    expect(trimHistory(h, 30).map((m) => m.content)).toEqual(['book it']);
  });
});
