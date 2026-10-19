import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { emptyProfile, type TravelerProfile } from '../src/domain/profile.js';
import { emptyTrip } from '../src/domain/trip.js';
import { planTurn } from '../src/services/promptRouter.js';

const TODAY = '2026-10-18';
const NOW = '2026-10-18T10:00:00.000Z';

function route(message: string, profile: TravelerProfile = emptyProfile()) {
  const trip = emptyTrip();
  return planTurn({
    trip,
    profile,
    message,
    today: TODAY,
    catalogPath: config.catalogPath,
    firstTurnOfThread: true,
    now: NOW,
  });
}

describe('Conversational Robustness & Natural Language Openers', () => {
  it('extracts and remembers traveler name from introductions', () => {
    const res = route('My name is Pranay. What is your name?');
    expect(res.profile.name).toBe('Pranay');
    expect(res.route.action).toBe('converse');
  });

  it('handles varied personal introductions without dumping trip questions', () => {
    for (const msg of ['Call me Alex', 'I am Sarah', 'My name is Maya', 'myself Rahul']) {
      const res = route(msg);
      expect(res.route.action).toBe('converse');
      expect(res.profile.name).toBeDefined();
    }
  });

  it('routes casual slang and greetings directly to conversational model', () => {
    for (const msg of ['sup', 'yo', 'wassup', 'whatup', 'hey there kodi', 'good morning', 'namaste']) {
      const res = route(msg);
      expect(res.route.action).toBe('converse');
      expect(res.route.text).toBeUndefined(); // handled by model, not static ask
    }
  });

  it('routes open-ended human expressions on turn 0 to model rather than static destination question', () => {
    const humanOpeners = [
      'I had a super stressful week at work',
      'Surprise me with something unexpected',
      'Tell me a fun travel story',
      'What are you capable of doing?',
      'Are you an AI or a real human?',
      'Bored at home',
    ];
    for (const msg of humanOpeners) {
      const res = route(msg);
      expect(res.route.action).toBe('converse');
    }
  });

  it('still routes explicit planning messages to the structured trip planner', () => {
    const planningMessages = [
      'Plan a trip to Goa',
      'I want to plan a vacation for 4 days',
      'Taking a trip to Manali with family in December',
      'Goa for 2 in December',
    ];
    for (const msg of planningMessages) {
      const res = route(msg);
      expect(['ask', 'draft']).toContain(res.route.action);
    }
  });
});
