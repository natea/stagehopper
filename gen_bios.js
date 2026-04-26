#!/usr/bin/env bun
// gen_bios.js — Fetch artist bios from Last.fm (real bios), fall back to AI.
// Patches schedule.js with `blurb` and `members` fields.
// Usage: bun run gen_bios.js [--dry-run] [--parallel=N]

import fs from 'fs';

const DRY_RUN   = process.argv.includes('--dry-run');
const PARALLEL  = parseInt(process.argv.find(a => a.startsWith('--parallel='))?.split('=')[1] ?? '8');
const SCHEDULE  = './schedule.js';
const OR_KEY    = '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';
const LASTFM_KEY = '0299d17be2034ecc512a96eb0b698208';

// Load bands
const raw = fs.readFileSync(SCHEDULE, 'utf8');
const evalCtx = { window: {} };
new Function('window', raw)(evalCtx.window);
const bands  = evalCtx.window.BANDS_FULL;
const stages = evalCtx.window.STAGES;

// Unique artists (some appear on multiple days)
const seen   = new Set();
const unique = bands.filter(b => {
  if (seen.has(b.name)) return false;
  seen.add(b.name);
  return true;
});

console.log(`${unique.length} unique artists to describe`);

// Strip Last.fm's appended "Read more on Last.fm" link and HTML tags
function cleanLastfmBio(text) {
  return text
    .replace(/<a\b[^>]*>.*?<\/a>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s*Read more on Last\.fm\.?\s*/gi, '')
    .replace(/\n{2,}/g, ' ')
    .trim();
}

async function getLastfmBio(name) {
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=${encodeURIComponent(name)}&api_key=${LASTFM_KEY}&format=json&autocorrect=1`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const j = await resp.json();
    const artist = j?.artist;
    if (!artist) return null;

    const summary = cleanLastfmBio(artist?.bio?.summary ?? '');
    // Last.fm returns a stub like "There are no bios..." for unknowns — reject those
    // Also reject non-English bios (basic heuristic: non-ASCII > 15% of chars)
    if (!summary || summary.length < 60 || /there are \d+ artist/i.test(summary)) return null;
    const nonAscii = (summary.match(/[^\x00-\x7F]/g) || []).length;
    if (nonAscii / summary.length > 0.1) return null;

    // Truncate to ~300 chars at a sentence boundary
    let blurb = summary;
    if (blurb.length > 300) {
      const cut = blurb.lastIndexOf('.', 300);
      blurb = cut > 100 ? blurb.slice(0, cut + 1) : blurb.slice(0, 300).trimEnd() + '…';
    }

    // Extract member names from Last.fm's member list if available
    const members = artist?.members?.member?.map(m => m.name).slice(0, 5).join(', ') ?? null;
    return { blurb, members, source: 'lastfm' };
  } catch {
    return null;
  }
}

async function getAIBio(band) {
  const stageName = stages.find(s => s.id === band.stage)?.name ?? band.stage;
  const prompt = `You are writing short promotional copy for the New Orleans Jazz & Heritage Festival 2026 mobile app. Write 1-2 tight, confident sentences describing "${band.name}" who performs at the ${stageName}. Focus on their sound, genre, vibe, and why Jazz Fest fans will love them. If you don't have specific knowledge of this act, infer their style from their name, the stage they play (${stageName} is a strong signal), and their New Orleans context — then write confident, evocative copy anyway. Do NOT say you lack information or suggest checking other sources. Then on a NEW line starting with exactly "Members:" list up to 5 key musicians (first name + last name, comma-separated) — only include this line if you genuinely know the members. No markdown, no headers, no quotes around the description.`;

  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OR_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'anthropic/claude-haiku-4-5',
      max_tokens: 160,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const j = await resp.json();
  const text = j.choices?.[0]?.message?.content?.trim() ?? '';
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const membersLine = lines.find(l => /^members:/i.test(l));
  const blurbLines  = lines.filter(l => !/^members:/i.test(l) && !l.startsWith('#'));
  return {
    blurb:   blurbLines.join(' ').replace(/^"+|"+$/g, '').trim(),
    members: membersLine ? membersLine.replace(/^members:\s*/i, '').trim() : null,
    source:  'ai',
  };
}

async function getBio(band) {
  const lfm = await getLastfmBio(band.name);
  if (lfm) return lfm;
  return getAIBio(band);
}

// Parallel worker pool
async function runAll() {
  const results = new Map();
  let done = 0, fromLastfm = 0, fromAI = 0;
  const queue = [...unique];

  await new Promise((resolve) => {
    let active = 0;
    function next() {
      while (active < PARALLEL && queue.length > 0) {
        const band = queue.shift();
        active++;
        getBio(band)
          .then(bio => {
            results.set(band.name, bio);
            if (bio?.source === 'lastfm') fromLastfm++;
            else fromAI++;
          })
          .catch(_ => results.set(band.name, { blurb: null, members: null }))
          .finally(() => {
            done++;
            process.stdout.write(`\r${done}/${unique.length} done (${fromLastfm} Last.fm / ${fromAI} AI)...`);
            active--;
            next();
            if (active === 0 && queue.length === 0) resolve();
          });
      }
    }
    next();
  });

  console.log(`\nDone! ${fromLastfm} from Last.fm, ${fromAI} AI-generated.\n`);
  return results;
}

const bios = await runAll();

if (DRY_RUN) {
  let n = 0;
  for (const [name, bio] of bios) {
    if (n++ >= 10) break;
    console.log(`[${bio?.source ?? '?'}] ${name}:\n  ${bio?.blurb}\n  Members: ${bio?.members ?? '(none)'}\n`);
  }
  process.exit(0);
}

// Patch each band entry in schedule.js
let updated = raw;
let changes = 0;

for (const band of bands) {
  const bio = bios.get(band.name);
  if (!bio?.blurb) continue;

  const esc = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  const pat = new RegExp(
    `(\\{[^{}]*?id:\\s*'${band.id}'[^{}]*?)(\\})`,
    's'
  );

  const next = updated.replace(pat, (_, body, close) => {
    if (body.includes("blurb:")) return _;
    let extra = `, blurb: '${esc(bio.blurb)}'`;
    if (bio.members) extra += `, members: '${esc(bio.members)}'`;
    return `${body}${extra}${close}`;
  });

  if (next !== updated) { updated = next; changes++; }
}

fs.writeFileSync(SCHEDULE, updated);
console.log(`✓ Added bios to ${changes} band entries in schedule.js`);
