#!/usr/bin/env node
// rerank_yt.js — re-search every band for their most-viewed YouTube video
// and update schedule.js in place.
//
// Usage:
//   chmod +x best_yt.sh
//   node rerank_yt.js [--parallel N] [--dry-run]
//
// Options:
//   --parallel N   Number of concurrent yt-dlp workers (default 6)
//   --dry-run      Print changes without writing schedule.js
//   --only-bad     Only re-search bands whose current yt ID has <1000 views
//                  (requires a prior run of best_yt.sh to have view counts)

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCHEDULE = path.join(__dirname, 'schedule.js');
const PARALLEL = (() => { const i = process.argv.indexOf('--parallel'); return i >= 0 ? parseInt(process.argv[i+1]) : 6; })();
const DRY_RUN = process.argv.includes('--dry-run');

const window = {};
eval(fs.readFileSync(SCHEDULE, 'utf8'));
const bands = window.BANDS_FULL;

// Deduplicate by name (same artist may appear on multiple days)
const seen = new Map(); // name -> first band entry
for (const b of bands) {
  if (!seen.has(b.name)) seen.set(b.name, b);
}
const unique = [...seen.values()];
console.log(`${unique.length} unique artists to re-search (${bands.length} total entries)`);

function searchBest(name) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['best_yt.sh', name], { cwd: __dirname });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', () => {}); // suppress yt-dlp noise
    child.on('close', () => {
      const [, vid, views, title] = out.trim().split('\t');
      resolve({ name, vid: vid || null, views: parseInt(views) || 0, title: title || '' });
    });
  });
}

async function runQueue() {
  const results = [];
  const queue = [...unique];
  let active = 0;
  let done = 0;

  await new Promise((resolve) => {
    function next() {
      while (active < PARALLEL && queue.length > 0) {
        const band = queue.shift();
        active++;
        searchBest(band.name).then(r => {
          results.push(r);
          active--;
          done++;
          process.stdout.write(`\r${done}/${unique.length} searched...`);
          next();
          if (active === 0 && queue.length === 0) resolve();
        });
      }
    }
    next();
  });

  console.log('\nDone searching.\n');
  return results;
}

(async () => {
  const results = await runQueue();

  // Build lookup: name -> best vid
  const bestById = new Map(results.map(r => [r.name, r]));

  let scheduleCode = fs.readFileSync(SCHEDULE, 'utf8');
  let changes = 0;

  for (const b of bands) {
    const best = bestById.get(b.name);
    if (!best || !best.vid || best.vid === 'NOTFOUND') continue;
    if (best.vid === b.yt) continue; // already correct

    const oldLine = `yt: '${b.yt}'`;
    const newLine = `yt: '${best.vid}'`;
    if (!scheduleCode.includes(oldLine)) continue;

    // Replace only the FIRST occurrence matching this band's id
    const idPattern = new RegExp(`(id: '${b.id}'[^}]+?)yt: '${b.yt}'`);
    if (idPattern.test(scheduleCode)) {
      scheduleCode = scheduleCode.replace(idPattern, `$1yt: '${best.vid}'`);
      console.log(`${DRY_RUN ? '[DRY] ' : ''}${b.name}: ${b.yt} → ${best.vid} (${best.views.toLocaleString()} views) — ${best.title}`);
      changes++;
    }
  }

  if (!DRY_RUN && changes > 0) {
    fs.writeFileSync(SCHEDULE, scheduleCode);
    console.log(`\n✓ Updated ${changes} video IDs in schedule.js`);
  } else if (DRY_RUN) {
    console.log(`\n[DRY RUN] Would update ${changes} video IDs`);
  } else {
    console.log('No changes needed.');
  }
})();
