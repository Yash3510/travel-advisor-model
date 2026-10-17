// What /ready checks besides the model: the files the planner needs. A deployment that is missing its place data
// or guide pages must say so, not quietly plan without them.

import fs from 'node:fs';
import path from 'node:path';

export interface DataCheck { ok: boolean; regions: string[]; missing: string[] }

export function checkData(p: { catalogPath: string; regionsFile: string; poiDir: string; guideDir: string; dbPath: string }): DataCheck {
  const missing: string[] = [];
  const regions: string[] = [];
  if (!fs.existsSync(p.catalogPath)) missing.push(`catalog: ${p.catalogPath}`);
  let slugs: string[] = [];
  try {
    slugs = (JSON.parse(fs.readFileSync(p.regionsFile, 'utf8')) as { regions: { slug: string }[] }).regions.map((r) => r.slug);
  } catch {
    missing.push(`place regions: ${p.regionsFile}`);
  }
  for (const slug of slugs) {
    const file = path.join(p.poiDir, `${slug}.json`);
    if (fs.existsSync(file)) regions.push(slug); else missing.push(`place data for ${slug}: ${file}`);
  }
  let pages = 0;
  try { pages = fs.readdirSync(p.guideDir).filter((f) => f.endsWith('.json')).length; } catch { /* counted as missing */ }
  if (!pages) missing.push(`destination guide pages: ${p.guideDir}`);
  if (p.dbPath !== ':memory:') {
    const dir = path.dirname(p.dbPath);
    try { fs.accessSync(dir, fs.constants.W_OK); } catch { missing.push(`writable database directory: ${dir}`); }
  }
  return { ok: !missing.length, regions, missing };
}
