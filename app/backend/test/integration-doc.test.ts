import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// integration.md carries the client files for the frontend's coding agent, which can't reach this repository;
// `npm run docs:sync` copies them in, and this fails when a copy is out of date
const doc = fs.readFileSync(new URL('../../integration.md', import.meta.url), 'utf8');
const EMBEDDED: Record<string, string> = {
  'takeoff-api.ts': '../../client/takeoff-api.ts',
  'takeoff-plan.ts': '../../client/takeoff-plan.ts',
  'check-backend.mjs': '../../scripts/smoke.mjs',
};

describe('integration.md', () => {
  for (const [name, source] of Object.entries(EMBEDDED)) {
    it(`embeds ${name} exactly as ${source.replace('../../', 'app/')}`, () => {
      const block = new RegExp(`<!-- BEGIN FILE ${name.replace('.', '\\.')} -->\\n\`\`\`\\w+\\n([\\s\\S]*?)\`\`\`\\n<!-- END FILE ${name.replace('.', '\\.')} -->`).exec(doc);
      expect(block, `the ${name} block (run npm run docs:sync)`).not.toBeNull();
      expect(block![1], `${name} is out of date (run npm run docs:sync)`).toBe(fs.readFileSync(new URL(source, import.meta.url), 'utf8'));
    });
  }
});
