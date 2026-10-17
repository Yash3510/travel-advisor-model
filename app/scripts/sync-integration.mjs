// Copies the files the frontend's coding agent needs into integration.md, between their BEGIN FILE and END FILE
// markers. Run after changing any of them: `cd backend && npm run docs:sync` (backend/test/integration-doc.test.ts
// fails while a copy is out of date).
import fs from 'node:fs';

const app = new URL('../', import.meta.url);
const FILES = [
  ['takeoff-api.ts', 'client/takeoff-api.ts', 'ts'],
  ['takeoff-plan.ts', 'client/takeoff-plan.ts', 'ts'],
  ['check-backend.mjs', 'scripts/smoke.mjs', 'js'],
];

const docUrl = new URL('integration.md', app);
let doc = fs.readFileSync(docUrl, 'utf8');
for (const [name, source, lang] of FILES) {
  const body = fs.readFileSync(new URL(source, app), 'utf8');
  if (body.includes('```')) throw new Error(`${source} contains a code fence and can't be embedded`);
  const begin = `<!-- BEGIN FILE ${name} -->`;
  const end = `<!-- END FILE ${name} -->`;
  const from = doc.indexOf(begin);
  const to = doc.indexOf(end);
  if (from < 0 || to < from) throw new Error(`integration.md has no ${begin} … ${end} markers`);
  doc = `${doc.slice(0, from + begin.length)}\n\`\`\`${lang}\n${body.endsWith('\n') ? body : `${body}\n`}\`\`\`\n${doc.slice(to)}`;
}
fs.writeFileSync(docUrl, doc);
console.log('integration.md: embedded files up to date');
