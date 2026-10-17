import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkData } from '../src/readiness.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function layout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takeoff-ready-'));
  dirs.push(root);
  const p = (...x: string[]) => path.join(root, ...x);
  fs.mkdirSync(p('poi'));
  fs.mkdirSync(p('guide'));
  fs.mkdirSync(p('db'));
  fs.writeFileSync(p('catalog.json'), '{}');
  fs.writeFileSync(p('poi-regions.json'), JSON.stringify({ regions: [{ slug: 'goa', names: ['Goa'], bbox: [14.88, 73.67, 15.81, 74.34] }] }));
  fs.writeFileSync(p('poi', 'goa.json'), JSON.stringify({ pois: [] }));
  fs.writeFileSync(p('guide', 'Goa.json'), '{}');
  return { p, paths: { catalogPath: p('catalog.json'), regionsFile: p('poi-regions.json'), poiDir: p('poi'), guideDir: p('guide'), dbPath: p('db', 'threads.db') } };
}

describe('checkData', () => {
  it('is ready when the catalog, every region file, the guide and a writable database are there', () => {
    expect(checkData(layout().paths)).toEqual({ ok: true, regions: ['goa'], missing: [] });
  });

  it('names each missing file instead of quietly planning without it', () => {
    const { p, paths } = layout();
    fs.rmSync(p('poi', 'goa.json'));
    fs.rmSync(p('guide', 'Goa.json'));
    fs.rmSync(p('catalog.json'));
    expect(checkData(paths)).toEqual({
      ok: false, regions: [],
      missing: [`catalog: ${p('catalog.json')}`, `place data for goa: ${p('poi', 'goa.json')}`, `destination guide pages: ${p('guide')}`],
    });
    expect(checkData({ ...paths, regionsFile: p('nope.json') }).missing).toContain(`place regions: ${p('nope.json')}`);
    expect(checkData({ ...paths, dbPath: p('missing-dir', 'threads.db') }).missing).toContain(`writable database directory: ${p('missing-dir')}`);
  });
});
