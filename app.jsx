// app.jsx — Jazz Fest swipe scheduler
// Bands as a Tinder-style stack. Swipe right = add to schedule, left = skip.
// Conflicts (overlapping selected bands) are surfaced before & after acceptance.

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const STAGE_BY_ID = Object.fromEntries(window.STAGES.map(s => [s.id, s]));
const DAY_BY_ID   = Object.fromEntries(window.DAYS_FULL.map(d => [d.id, d]));

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const fmtTime = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${m.toString().padStart(2, '0')} ${ap}`;
};
const fmtTimeShort = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'p' : 'a';
  const h12 = ((h + 11) % 12) + 1;
  return m === 0 ? `${h12}${ap}` : `${h12}:${m.toString().padStart(2, '0')}${ap}`;
};
const overlap = (a, b) => {
  if (a.day !== b.day) return false;
  return toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end);
};
const conflictsWith = (band, scheduled) =>
  scheduled.filter(s => s.id !== band.id && overlap(band, s));

// ── Time / slot helpers ──────────────────────────────────────
const nowMinutes = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

const todayDate = () => new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

// Greedy lane algorithm: same-stage consecutive shows share a lane.
function computeLanes(dayBands) {
  const sorted = [...dayBands].sort((a, b) => toMin(a.start) - toMin(b.start));
  const laneEnd   = []; // end-minutes of last show in each lane
  const laneStage = []; // stage id of last show in each lane
  const lanes = new Map();

  for (const band of sorted) {
    const s = toMin(band.start), e = toMin(band.end);
    let best = -1;
    // Prefer same stage (consecutive)
    for (let i = 0; i < laneEnd.length; i++) {
      if (laneStage[i] === band.stage && laneEnd[i] <= s) { best = i; break; }
    }
    // Any open lane
    if (best === -1) {
      for (let i = 0; i < laneEnd.length; i++) {
        if (laneEnd[i] <= s) { best = i; break; }
      }
    }
    // New lane
    if (best === -1) { best = laneEnd.length; laneEnd.push(0); laneStage.push(null); }
    laneEnd[best] = e;
    laneStage[best] = band.stage;
    lanes.set(band.id, best);
  }
  return { lanes, numLanes: Math.max(laneEnd.length, 1) };
}

// Returns { slot: 'HH:MM' | null, label: 'NOW' | 'NEXT' | null }
function getTargetSlot(dayId, allDayBands, scheduledIds) {
  const day = DAY_BY_ID[dayId];
  if (!day || day.date !== todayDate()) return { slot: null, label: null };
  const now = nowMinutes();
  const sorted = [...allDayBands].sort((a, b) => toMin(a.start) - toMin(b.start));

  // Currently playing bands
  const playing = sorted.filter(b => toMin(b.start) <= now && now < toMin(b.end));
  if (playing.length > 0) {
    const slotStart = playing[0].start;
    const hasChosen = playing.some(b => scheduledIds.has(b.id));
    if (!hasChosen) return { slot: slotStart, label: 'NOW' };
    // Already chose one from this slot → find next distinct start time
    const nextStart = sorted.find(b => toMin(b.start) > now);
    return nextStart ? { slot: nextStart.start, label: 'NEXT' } : { slot: null, label: null };
  }
  // Between slots or before festival
  const next = sorted.find(b => toMin(b.start) > now);
  return next ? { slot: next.start, label: 'NEXT' } : { slot: null, label: null };
}

// Schedule local Notification API alerts (15-min warning) for today's shows.
function scheduleLocalNotifications(scheduledBands) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const today = todayDate();
  for (const band of scheduledBands) {
    const day = DAY_BY_ID[band.day];
    if (!day || day.date !== today) continue;
    const [h, m] = band.start.split(':').map(Number);
    const showMs = new Date(day.date + 'T00:00:00').getTime() + (h * 60 + m) * 60000;
    const alertMs = showMs - 15 * 60000;
    const delay = alertMs - Date.now();
    if (delay > 0 && delay < 6 * 3600000) { // only within 6 hours
      setTimeout(() => {
        new Notification(`Starting soon: ${band.name}`, {
          body: `${fmtTime(band.start)} · ${STAGE_BY_ID[band.stage]?.name}`,
          icon: 'icon-192.png',
          tag: `jf26-${band.id}`,
          silent: false,
        });
      }, delay);
    }
  }
}

// LocalStorage keys
const LS_KEY = 'jf26.schedule.v3';
const LS_REJECT = 'jf26.rejected.v3';
const LS_DAY = 'jf26.activeDay.v3';

const loadSet = (key) => {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); }
  catch { return new Set(); }
};
const saveSet = (key, set) =>
  localStorage.setItem(key, JSON.stringify([...set]));

// ─────────────────────────────────────────────────────────────
// Video preview
//   - Verified bands (yt is real): embed the YouTube player
//   - Unverified bands: tap-to-search tile (always works)
// ─────────────────────────────────────────────────────────────
function YouTubeEmbed({ id, band, stage, onFallback }) {
  const [failed, setFailed] = useState(false);
  // Detect embed failures: poll the iframe for "embed disabled" error which
  // shows in the iframe's body. Easiest signal: listen to YT IFrame API
  // postMessage. Simpler: catch onError on the iframe and use a timeout to
  // check if the iframe loaded a YouTube error page (we can't read it cross-
  // origin, so we rely on a "Switch to search" button overlay the user can tap).
  if (failed) return <YouTubeSearchTile band={band} stage={stage} />;
  // Note: YouTube embeds throw Error 153 when loaded from file:// — the player
  // can't validate the origin. Hosting over http(s) (PWA) makes them work.
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const originParam = origin && origin !== 'null' && !origin.startsWith('file') ? `&origin=${encodeURIComponent(origin)}` : '';
  const src = `https://www.youtube.com/embed/${id}?autoplay=0&controls=1&modestbranding=1&playsinline=1&rel=0&enablejsapi=1${originParam}`;
  return (
    <>
      <iframe
        src={src}
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          border: 0,
        }}
        allow="autoplay; encrypted-media; picture-in-picture"
        allowFullScreen
      />
      {/* Verified badge */}
      <div style={{
        position: 'absolute', top: 12, right: 12, zIndex: 5,
        background: 'rgba(0,0,0,0.6)', color: '#A7F3D0',
        fontSize: 10, fontWeight: 700, letterSpacing: 0.6,
        padding: '4px 8px', borderRadius: 4,
        textTransform: 'uppercase',
        backdropFilter: 'blur(8px)',
        pointerEvents: 'none',
      }}>● Live clip</div>
      {/* Always-visible "trouble? search instead" escape hatch in the corner */}
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); setFailed(true); }}
        style={{
          position: 'absolute', bottom: 8, left: 8, zIndex: 5,
          background: 'rgba(0,0,0,0.55)', color: '#fff',
          border: 0, fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
          padding: '4px 8px', borderRadius: 4, cursor: 'pointer',
          backdropFilter: 'blur(8px)',
        }}
      >Won't play? Search instead ↗</button>
    </>
  );
}

function YouTubeSearchTile({ band, stage }) {
  const cleanName = band.name.replace(/["()]/g, '').replace(/\s+/g, '+').trim();
  const url = `https://www.youtube.com/results?search_query=${cleanName}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute', inset: 0, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        textDecoration: 'none',
        background: `linear-gradient(135deg, ${stage.tone} 0%, #0a0a0a 100%)`,
        cursor: 'pointer',
      }}
    >
      <div style={{
        position: 'absolute', inset: 0, opacity: 0.18,
        backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.1) 0 2px, transparent 2px 16px)',
        pointerEvents: 'none',
      }} />
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
        position: 'relative',
      }}>
        <div style={{
          width: 64, height: 64, borderRadius: 32,
          background: '#FF0000', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        }}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z"/>
          </svg>
        </div>
        <div style={{
          fontSize: 12, fontWeight: 600, letterSpacing: 0.4,
          color: '#fff', textTransform: 'uppercase',
          textShadow: '0 1px 2px rgba(0,0,0,0.5)',
        }}>Search YouTube ↗</div>
      </div>
    </a>
  );
}

function VideoPreview({ band, stage }) {
  if (band.verified && band.yt) {
    return <YouTubeEmbed id={band.yt} band={band} stage={stage} />;
  }
  return <YouTubeSearchTile band={band} stage={stage} />;
}

// ─────────────────────────────────────────────────────────────
// Card
// ─────────────────────────────────────────────────────────────
function BandCard({ band, top, onSwipe, scheduled, soundOn, onToggleSound }) {
  const [drag, setDrag] = useState({ x: 0, y: 0, dragging: false });
  const startRef = useRef(null);
  const cardRef = useRef(null);

  const stage = STAGE_BY_ID[band.stage];
  const day = DAY_BY_ID[band.day];
  const conflicts = useMemo(() => conflictsWith(band, scheduled), [band, scheduled]);

  const onPointerDown = (e) => {
    if (!top) return;
    startRef.current = { x: e.clientX, y: e.clientY };
    setDrag({ x: 0, y: 0, dragging: true });
    cardRef.current?.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!startRef.current) return;
    setDrag({
      x: e.clientX - startRef.current.x,
      y: e.clientY - startRef.current.y,
      dragging: true,
    });
  };
  const onPointerUp = (e) => {
    if (!startRef.current) return;
    const dx = e.clientX - startRef.current.x;
    startRef.current = null;
    if (Math.abs(dx) > 90) {
      onSwipe(dx > 0 ? 'right' : 'left');
    } else {
      setDrag({ x: 0, y: 0, dragging: false });
    }
  };

  const rot = drag.x * 0.06;
  const overlayLikeOpacity = Math.min(Math.max(drag.x / 120, 0), 1);
  const overlayNopeOpacity = Math.min(Math.max(-drag.x / 120, 0), 1);

  // For non-top cards, slight scale + offset
  const z = top ? 3 : 2;
  const scale = top ? 1 : 0.96;
  const offsetY = top ? 0 : 10;

  return (
    <div
      ref={cardRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        position: 'absolute', left: 16, right: 16, top: 12, bottom: 12,
        background: '#0F0E0C',
        borderRadius: 22,
        boxShadow: top
          ? '0 10px 30px rgba(0,0,0,0.35), 0 2px 6px rgba(0,0,0,0.2)'
          : '0 6px 16px rgba(0,0,0,0.25)',
        overflow: 'hidden', zIndex: z,
        transform: `translate(${drag.x}px, ${drag.y * 0.3 + offsetY}px) rotate(${rot}deg) scale(${scale})`,
        transition: drag.dragging ? 'none' : 'transform 280ms cubic-bezier(.2,.8,.2,1)',
        touchAction: 'none', cursor: top ? 'grab' : 'default',
      }}
    >
      {/* Video — top half. For embeds, the iframe captures pointers, so we
          add a transparent "swipe handle" strip overlay above the iframe
          that the user can drag from. The play/pause area in the middle
          stays interactive. */}
      <div style={{ position: 'relative', width: '100%', height: '52%', background: '#000' }}>
        {top ? (
          <VideoPreview band={band} stage={stage} />
        ) : (
          <div style={{
            position: 'absolute', inset: 0,
            background: `linear-gradient(135deg, ${stage.tone}, #1a1a1a)`,
          }} />
        )}
        {/* (sound toggle removed — no embed playing) */}
        {/* fade to dark for text legibility */}
        <div style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, height: 60,
          background: 'linear-gradient(to bottom, transparent, #0F0E0C)',
          pointerEvents: 'none',
        }} />
      </div>

      {/* Info — bottom half */}
      <div style={{
        padding: '14px 18px 16px', color: '#F5F1EA',
        display: 'flex', flexDirection: 'column', gap: 8,
        height: '48%', boxSizing: 'border-box',
      }}>
        <div style={{
          fontFamily: 'Georgia, "Times New Roman", serif',
          fontSize: 26, fontWeight: 700, lineHeight: 1.1, letterSpacing: -0.5,
          textWrap: 'balance',
        }}>{band.name}</div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          fontSize: 13, color: 'rgba(245,241,234,0.7)',
        }}>
          <span style={{ fontWeight: 600 }}>{day.label}</span>
          <span>·</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {fmtTime(band.start)} – {fmtTime(band.end)}
          </span>
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          <div style={{
            display: 'inline-flex',
            fontSize: 11, fontWeight: 600, letterSpacing: 0.4,
            background: stage.tone, color: '#fff',
            padding: '3px 8px', borderRadius: 4, textTransform: 'uppercase',
          }}>{stage.name}</div>
          {band.genre && <div style={{
            display: 'inline-flex',
            fontSize: 11, fontWeight: 600, letterSpacing: 0.4,
            color: stage.tone, background: 'rgba(255,255,255,0.08)',
            padding: '3px 8px', borderRadius: 4, textTransform: 'uppercase',
          }}>{band.genre}</div>}
        </div>

        <p style={{
          margin: '4px 0 0', fontSize: 14, lineHeight: 1.45,
          color: 'rgba(245,241,234,0.85)', textWrap: 'pretty',
        }}>{band.blurb}</p>

        {/* Conflict warning */}
        {conflicts.length > 0 && (
          <div style={{
            marginTop: 'auto',
            background: 'rgba(220, 80, 70, 0.14)',
            border: '1px solid rgba(220, 80, 70, 0.4)',
            color: '#FFB4A8',
            borderRadius: 10, padding: '8px 10px',
            fontSize: 12, lineHeight: 1.35,
          }}>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>
              ⚠ Conflicts with {conflicts.length === 1 ? 'a band' : `${conflicts.length} bands`} on your schedule
            </div>
            {conflicts.slice(0, 2).map(c => (
              <div key={c.id} style={{ opacity: 0.9 }}>
                {c.name} — {fmtTimeShort(c.start)}–{fmtTimeShort(c.end)} @ {STAGE_BY_ID[c.stage].name}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Swipe overlays */}
      {top && (
        <>
          <div style={{
            position: 'absolute', top: 28, left: 22,
            border: '4px solid #4ADE80', color: '#4ADE80',
            padding: '6px 14px', borderRadius: 10,
            fontWeight: 800, fontSize: 28, letterSpacing: 2,
            transform: 'rotate(-18deg)',
            opacity: overlayLikeOpacity, pointerEvents: 'none',
          }}>GOING</div>
          <div style={{
            position: 'absolute', top: 28, right: 22,
            border: '4px solid #F87171', color: '#F87171',
            padding: '6px 14px', borderRadius: 10,
            fontWeight: 800, fontSize: 28, letterSpacing: 2,
            transform: 'rotate(18deg)',
            opacity: overlayNopeOpacity, pointerEvents: 'none',
          }}>SKIP</div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Action buttons
// ─────────────────────────────────────────────────────────────
function ActionBar({ onSkip, onAdd, onUndo, canUndo }) {
  const btn = (children, onClick, color, size = 56) => (
    <button onClick={onClick} style={{
      width: size, height: size, borderRadius: size / 2,
      border: 0, background: '#fff', color,
      boxShadow: '0 6px 16px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.12)',
      fontSize: size * 0.42, fontWeight: 700, cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>{children}</button>
  );
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      gap: 22, padding: '10px 0 14px',
    }}>
      {/* Undo — only rendered when there's something to undo */}
      {canUndo ? (
        <button onClick={onUndo} style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: 3, border: 0, background: 'none', cursor: 'pointer', padding: 0,
        }}>
          <div style={{
            width: 44, height: 44, borderRadius: 22, border: 0,
            background: '#fff', color: '#A1A1AA',
            boxShadow: '0 6px 16px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.12)',
            fontSize: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>↺</div>
          <span style={{ fontSize: 9, fontWeight: 600, color: 'rgba(245,241,234,0.45)', letterSpacing: 0.3, textTransform: 'uppercase' }}>Undo</span>
        </button>
      ) : (
        /* Invisible spacer keeps ✕ and ♥ centered */
        <div style={{ width: 44 }} />
      )}
      {btn('✕', onSkip, '#F87171', 56)}
      {btn('♥', onAdd, '#22C55E', 56)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Intro overlay — shown once on first visit, accessible later via menu
// ─────────────────────────────────────────────────────────────
const LS_INTRO = 'jf26.introSeen.v1';

function IntroOverlay({ onClose }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(10,9,8,0.92)',
      backdropFilter: 'blur(12px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '24px 24px',
      paddingTop: 'max(24px, env(safe-area-inset-top, 24px))',
      paddingBottom: 'max(24px, env(safe-area-inset-bottom, 24px))',
    }}>
      <div style={{
        maxWidth: 360, width: '100%',
        background: '#1C1A17', borderRadius: 20,
        padding: '32px 28px',
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}>
        <div style={{ fontSize: 36, textAlign: 'center', marginBottom: 12 }}>🎷</div>
        <h2 style={{
          margin: '0 0 6px', textAlign: 'center',
          fontFamily: 'Georgia, serif', fontSize: 22, fontWeight: 700,
          color: '#F5F1EA',
        }}>Welcome to StageHopper</h2>
        <p style={{
          margin: '0 0 24px', textAlign: 'center',
          fontSize: 13, color: 'rgba(245,241,234,0.55)', lineHeight: 1.5,
        }}>New Orleans Jazz &amp; Heritage Festival 2026</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 28 }}>
          {[
            ['👆', 'Swipe right to add a set to your schedule'],
            ['👈', 'Swipe left to skip'],
            ['↩️', 'Tap Undo to bring back the last swipe'],
            ['📅', 'Switch days with the tabs at the top'],
            ['☰', 'Tap the menu for maps and more'],
          ].map(([icon, text]) => (
            <div key={text} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <span style={{ fontSize: 20, lineHeight: '1.3', flexShrink: 0 }}>{icon}</span>
              <span style={{ fontSize: 14, color: 'rgba(245,241,234,0.8)', lineHeight: 1.5 }}>{text}</span>
            </div>
          ))}
        </div>

        <button
          onClick={onClose}
          style={{
            width: '100%', padding: '14px 0', border: 0,
            background: '#C2410C', color: '#fff',
            fontSize: 15, fontWeight: 700, borderRadius: 12,
            cursor: 'pointer', letterSpacing: 0.2,
          }}
        >Let's go →</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Map viewer — fullscreen image with native pinch/pan
// ─────────────────────────────────────────────────────────────
function MapViewer({ src, title, onClose }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 150,
      background: '#111',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Map fills all available space */}
      <div style={{
        flex: 1, overflow: 'auto', position: 'relative',
        WebkitOverflowScrolling: 'touch',
        touchAction: 'pinch-zoom pan-x pan-y',
        cursor: 'grab',
        paddingTop: 'env(safe-area-inset-top, 0px)',
      }}>
        <img
          src={src}
          alt={title}
          style={{
            display: 'block',
            width: '250%',
            maxWidth: 'none',
            height: 'auto',
          }}
        />
        {/* Floating title top-left */}
        <div style={{
          position: 'fixed',
          top: 'max(14px, env(safe-area-inset-top, 14px))',
          left: 16, zIndex: 10,
          background: 'rgba(15,14,12,0.85)',
          backdropFilter: 'blur(8px)',
          color: '#F5F1EA', fontSize: 14, fontWeight: 700,
          padding: '6px 12px', borderRadius: 8,
          pointerEvents: 'none',
        }}>{title}</div>
      </div>

      {/* Prominent close bar at bottom */}
      <div style={{
        flexShrink: 0,
        background: 'rgba(15,14,12,0.96)',
        backdropFilter: 'blur(12px)',
        borderTop: '1px solid rgba(255,255,255,0.1)',
        padding: '10px 16px',
        paddingBottom: 'max(10px, env(safe-area-inset-bottom, 10px))',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 11, color: 'rgba(245,241,234,0.4)' }}>Pinch to zoom · drag to pan</span>
        <button
          onClick={onClose}
          style={{
            border: 0,
            background: '#C2410C',
            color: '#fff',
            fontSize: 14, fontWeight: 700,
            padding: '10px 22px', borderRadius: 10,
            cursor: 'pointer', letterSpacing: 0.2,
          }}
        >✕ Close Map</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Hamburger slide-out menu
// ─────────────────────────────────────────────────────────────
function HamburgerMenu({ open, onClose, onShowIntro }) {
  if (!open) return null;
  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 90,
          background: 'rgba(0,0,0,0.55)',
          backdropFilter: 'blur(4px)',
        }}
      />
      {/* Drawer */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 100,
        width: 280,
        background: '#1C1A17',
        borderLeft: '1px solid rgba(255,255,255,0.08)',
        display: 'flex', flexDirection: 'column',
        paddingTop: 'max(16px, env(safe-area-inset-top, 16px))',
        paddingBottom: 'max(16px, env(safe-area-inset-bottom, 16px))',
        boxShadow: '-8px 0 32px rgba(0,0,0,0.5)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 20px 16px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}>
          <span style={{
            fontFamily: 'Georgia, serif', fontSize: 17, fontWeight: 700,
            color: '#F5F1EA',
          }}>Menu</span>
          <button onClick={onClose} style={{
            border: 0, background: 'none', color: 'rgba(245,241,234,0.5)',
            fontSize: 22, cursor: 'pointer', padding: 4, lineHeight: 1,
          }}>✕</button>
        </div>

        <MenuSection label="Maps" />
        <MenuRow icon="🗺️" label="Festival Map" onPress={() => { onClose(); window.__openMap('festival'); }} />
        <MenuRow icon="♿" label="Accessibility Map" onPress={() => { onClose(); window.__openMap('access'); }} />

        <MenuSection label="Help" />
        <MenuRow icon="❓" label="How to use this app" onPress={() => { onClose(); onShowIntro(); }} />

        <div style={{ flex: 1 }} />
        <p style={{
          padding: '0 20px', fontSize: 11,
          color: 'rgba(245,241,234,0.25)', lineHeight: 1.5,
        }}>
          New Orleans Jazz &amp; Heritage Festival<br />April 23 – May 3, 2026
        </p>
      </div>
    </>
  );
}

function MenuSection({ label }) {
  return (
    <div style={{
      padding: '16px 20px 4px',
      fontSize: 10, fontWeight: 700, letterSpacing: 1,
      color: 'rgba(245,241,234,0.35)', textTransform: 'uppercase',
    }}>{label}</div>
  );
}

function MenuRow({ icon, label, onPress }) {
  return (
    <button
      onClick={onPress}
      style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '13px 20px', border: 0, background: 'none',
        color: '#F5F1EA', fontSize: 15, fontWeight: 500,
        cursor: 'pointer', textAlign: 'left', width: '100%',
      }}
    >
      <span style={{ fontSize: 20, width: 24, textAlign: 'center' }}>{icon}</span>
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────
// Day tabs + view toggle
// ─────────────────────────────────────────────────────────────
function HamburgerBtn({ onClick }) {
  return (
    <button onClick={onClick} style={{
      border: 0, background: 'rgba(255,255,255,0.08)',
      color: '#F5F1EA', borderRadius: 8,
      width: 36, height: 36, cursor: 'pointer', flexShrink: 0,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5,
    }}>
      {[0,1,2].map(i => <span key={i} style={{ display: 'block', width: 18, height: 2, background: '#F5F1EA', borderRadius: 1 }} />)}
    </button>
  );
}

function ViewToggle({ view, setView, scheduledCount }) {
  return (
    <div style={{ display: 'flex', gap: 4, padding: 3, background: 'rgba(255,255,255,0.08)', borderRadius: 10 }}>
      {['discover', 'schedule'].map(v => (
        <button key={v} onClick={() => setView(v)} style={{
          border: 0, background: view === v ? '#F5F1EA' : 'transparent',
          color: view === v ? '#0F0E0C' : 'rgba(245,241,234,0.7)',
          fontSize: 12, fontWeight: 600, padding: '6px 12px',
          borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: 0.2,
        }}>
          {v === 'discover' ? 'Discover' : `Mine · ${scheduledCount}`}
        </button>
      ))}
    </div>
  );
}

function Header({ activeDay, setActiveDay, view, setView, scheduledCount, onMenuOpen }) {
  return (
    <div style={{
      padding: '0 16px',
      paddingTop: 'max(14px, env(safe-area-inset-top, 14px))',
      paddingBottom: 0,
      position: 'relative', zIndex: 5,
    }}>
      {/* Row 1: title + hamburger */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 8,
      }}>
        <h1 style={{
          margin: 0, color: '#F5F1EA',
          fontFamily: 'Georgia, "Times New Roman", serif',
          fontSize: 20, fontWeight: 700, letterSpacing: -0.5,
        }}>StageHopper</h1>
        <HamburgerBtn onClick={onMenuOpen} />
      </div>
      {/* Row 2: view toggle */}
      <div style={{ marginBottom: 10 }}>
        <ViewToggle view={view} setView={setView} scheduledCount={scheduledCount} />
      </div>

      {/* Day tabs */}
      <div style={{ display: 'flex', gap: 8 }}>
        {window.DAYS.map(d => {
          const active = d.id === activeDay;
          return (
            <button key={d.id} onClick={() => setActiveDay(d.id)} style={{
              flex: 1, border: 0, padding: '10px 0',
              background: active ? '#F5F1EA' : 'rgba(255,255,255,0.08)',
              color: active ? '#0F0E0C' : 'rgba(245,241,234,0.7)',
              borderRadius: 10, cursor: 'pointer',
              fontFamily: 'inherit',
            }}>
              <div style={{ fontSize: 11, fontWeight: 500, opacity: 0.7 }}>{d.short}</div>
              <div style={{ fontSize: 15, fontWeight: 700, marginTop: 1 }}>
                {d.label.split(' ').slice(-1)[0]}
                <span style={{ fontWeight: 500, opacity: 0.7, marginLeft: 4 }}>
                  {d.label.split(' ')[1]}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Mine: band detail sheet (tap a timeline block to preview)
// ─────────────────────────────────────────────────────────────
function MineBandSheet({ band, conflictingBands, onClose, onRemove, onRemoveConflict }) {
  if (!band) return null;
  const stage = STAGE_BY_ID[band.stage];
  const day = DAY_BY_ID[band.day];
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 110,
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'flex-end',
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#1A1816', borderRadius: '20px 20px 0 0',
        width: '100%', maxHeight: '88vh',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 -8px 40px rgba(0,0,0,0.6)',
        overflow: 'hidden',
      }}>
        {/* Drag handle */}
        <div style={{ padding: '14px 20px 0', flexShrink: 0 }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: 'rgba(245,241,234,0.2)', margin: '0 auto' }} />
        </div>

        {/* Video preview */}
        <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', background: '#000', flexShrink: 0 }}>
          <VideoPreview band={band} stage={stage} />
        </div>

        {/* Scrollable info + actions */}
        <div style={{ overflowY: 'auto', padding: '16px 20px 32px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Band info */}
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'Georgia, serif', color: '#F5F1EA', marginBottom: 4 }}>{band.name}</div>
            <div style={{ fontSize: 13, color: 'rgba(245,241,234,0.6)', marginBottom: 4 }}>{day?.label} · {fmtTime(band.start)}–{fmtTime(band.end)}</div>
            <div style={{
              display: 'inline-block', fontSize: 11, color: '#fff', fontWeight: 600,
              textTransform: 'uppercase', letterSpacing: 0.4,
              background: stage.tone, padding: '3px 8px', borderRadius: 4,
            }}>{stage.name}</div>
          </div>

          {/* Conflict warning */}
          {conflictingBands.length > 0 && (
            <div style={{
              background: 'rgba(220,80,70,0.12)', border: '1px solid rgba(220,80,70,0.3)',
              borderRadius: 10, padding: '10px 12px',
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#FFB4A8', marginBottom: 8 }}>
                ⚠ Conflicts with {conflictingBands.length === 1 ? 'another band' : `${conflictingBands.length} bands`}:
              </div>
              {conflictingBands.map(c => {
                const cs = STAGE_BY_ID[c.stage];
                return (
                  <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <div>
                      <span style={{ fontSize: 13, color: '#F5F1EA', fontWeight: 600 }}>{c.name}</span>
                      <span style={{ fontSize: 11, color: 'rgba(245,241,234,0.5)', marginLeft: 8 }}>{fmtTimeShort(c.start)}–{fmtTimeShort(c.end)} · {cs.name}</span>
                    </div>
                    <button onClick={() => { onRemoveConflict(c); onClose(); }} style={{
                      border: 0, background: 'rgba(220,80,70,0.25)', color: '#FFB4A8',
                      fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                    }}>Drop it</button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onClose} style={{
              flex: 1, padding: '13px 0', border: '1px solid rgba(245,241,234,0.15)',
              background: 'transparent', color: '#F5F1EA',
              fontSize: 14, fontWeight: 600, borderRadius: 12, cursor: 'pointer',
            }}>Close</button>
            <button onClick={() => { onRemove(band); onClose(); }} style={{
              flex: 1, padding: '13px 0', border: 0,
              background: 'rgba(220,80,70,0.2)', color: '#FFB4A8',
              fontSize: 14, fontWeight: 600, borderRadius: 12, cursor: 'pointer',
            }}>Remove</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Schedule timeline view
// ─────────────────────────────────────────────────────────────
function ScheduleView({ scheduled, activeDay, onRemove }) {
  const [previewBand, setPreviewBand] = useState(null);

  const dayBands = scheduled
    .filter(b => b.day === activeDay)
    .sort((a, b) => toMin(a.start) - toMin(b.start));

  // detect conflicts within the day
  const conflictIds = new Set();
  for (let i = 0; i < dayBands.length; i++) {
    for (let j = i + 1; j < dayBands.length; j++) {
      if (overlap(dayBands[i], dayBands[j])) {
        conflictIds.add(dayBands[i].id);
        conflictIds.add(dayBands[j].id);
      }
    }
  }

  if (dayBands.length === 0) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 32, textAlign: 'center', color: 'rgba(245,241,234,0.5)',
      }}>
        <div>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🎷</div>
          <div style={{ fontSize: 14 }}>
            No sets added for {DAY_BY_ID[activeDay].label} yet.<br/>
            Swipe right on Discover to add.
          </div>
        </div>
      </div>
    );
  }

  // Hour grid — dynamic range based on actual show times
  const startH = Math.max(11, Math.min(...dayBands.map(b => Math.floor(toMin(b.start) / 60))));
  const endH   = Math.min(22, Math.max(...dayBands.map(b => Math.ceil(toMin(b.end) / 60))));
  const pxPerHour = 80;
  const { lanes, numLanes } = computeLanes(dayBands);
  const conflictsOf = (b) => dayBands.filter(o => o.id !== b.id && overlap(o, b));

  return (
    <div style={{ flex: 1, overflowY: 'auto', position: 'relative', padding: '12px 16px 100px' }}>
      {/* conflict summary banner */}
      {conflictIds.size > 0 && (
        <div style={{
          background: 'rgba(220, 80, 70, 0.14)', border: '1px solid rgba(220, 80, 70, 0.4)',
          color: '#FFB4A8', borderRadius: 10, padding: '8px 12px', fontSize: 12, marginBottom: 12, lineHeight: 1.35,
        }}>
          <b>⚠ Conflicts detected.</b> Tap a set to review and resolve.
        </div>
      )}

      {conflictIds.size === 0 && dayBands.length > 0 && (
        <div style={{
          background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.2)',
          color: '#86EFAC', borderRadius: 10, padding: '8px 12px', fontSize: 12, marginBottom: 12,
        }}>
          ✓ {dayBands.length} set{dayBands.length !== 1 ? 's' : ''} — no conflicts. Tap any set to preview or remove.
        </div>
      )}

      <div style={{ position: 'relative', height: (endH - startH) * pxPerHour, marginLeft: 46 }}>
        {/* Hour lines */}
        {Array.from({ length: endH - startH + 1 }, (_, i) => {
          const h = startH + i;
          const h12 = ((h + 11) % 12) + 1;
          const ap = h >= 12 ? 'PM' : 'AM';
          return (
            <div key={h} style={{ position: 'absolute', left: 0, right: 0, top: i * pxPerHour }}>
              <div style={{
                position: 'absolute', left: -46, top: -7, width: 40, textAlign: 'right',
                fontSize: 10, fontWeight: 600, letterSpacing: 0.3,
                color: 'rgba(245,241,234,0.4)', fontVariantNumeric: 'tabular-nums',
              }}>{h12} {ap}</div>
              <div style={{ height: 1, background: 'rgba(245,241,234,0.08)' }} />
            </div>
          );
        })}

        {/* Events — lanes computed by computeLanes (same stage = same lane for back-to-back) */}
        {dayBands.map(b => {
          const stage = STAGE_BY_ID[b.stage];
          const topPx = (toMin(b.start) - startH * 60) / 60 * pxPerHour;
          const heightPx = (toMin(b.end) - toMin(b.start)) / 60 * pxPerHour;
          const isConflict = conflictIds.has(b.id);
          const laneIdx = lanes.get(b.id) ?? 0;
          const laneW = 100 / numLanes;
          return (
            <div key={b.id}
              onClick={() => setPreviewBand(b)}
              style={{
                position: 'absolute',
                top: topPx, height: Math.max(heightPx - 4, 36),
                left: `${laneIdx * laneW}%`,
                width: `calc(${laneW}% - 4px)`,
                background: isConflict ? `${stage.tone}cc` : stage.tone,
                border: isConflict ? '2px solid #FF6B6B' : '2px solid transparent',
                borderRadius: 8, padding: '5px 8px',
                color: '#fff', cursor: 'pointer',
                boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
                overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 1,
                boxSizing: 'border-box',
              }}>
              {isConflict && <div style={{ fontSize: 9, fontWeight: 800, color: '#FF6B6B', letterSpacing: 0.5 }}>⚠ CONFLICT</div>}
              <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.name}</div>
              <div style={{ fontSize: 9, opacity: 0.85, fontVariantNumeric: 'tabular-nums' }}>
                {fmtTimeShort(b.start)}–{fmtTimeShort(b.end)}
              </div>
            </div>
          );
        })}
      </div>

      {/* Preview sheet */}
      {previewBand && (
        <MineBandSheet
          band={previewBand}
          conflictingBands={conflictsOf(previewBand)}
          onClose={() => setPreviewBand(null)}
          onRemove={(b) => { onRemove(b); setPreviewBand(null); }}
          onRemoveConflict={(b) => { onRemove(b); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Discover (swipe stack) view
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// Stage picker sheet
// ─────────────────────────────────────────────────────────────
function StagePicker({ open, activeDay, onSelect, onClose }) {
  if (!open) return null;
  const dayBands = window.BANDS_FULL.filter(b => b.day === activeDay);
  const stagesWithCounts = window.STAGES.map(s => ({
    ...s,
    count: dayBands.filter(b => b.stage === s.id).length,
  })).filter(s => s.count > 0);

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 120,
      background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'flex-end',
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#1A1816', borderRadius: '20px 20px 0 0',
        width: '100%', maxHeight: '75vh', overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 -8px 40px rgba(0,0,0,0.6)',
      }}>
        <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: 'rgba(245,241,234,0.2)', margin: '0 auto 14px' }} />
          <div style={{ fontSize: 16, fontWeight: 700, color: '#F5F1EA' }}>Browse by Stage</div>
          <div style={{ fontSize: 12, color: 'rgba(245,241,234,0.45)', marginTop: 3 }}>See all acts at one stage, in time order</div>
        </div>
        <div style={{ overflowY: 'auto', padding: '8px 0 32px' }}>
          {stagesWithCounts.map(s => (
            <button key={s.id} onClick={() => { onSelect(s.id); onClose(); }} style={{
              display: 'flex', alignItems: 'center', gap: 14,
              width: '100%', padding: '12px 20px', border: 0,
              background: 'none', cursor: 'pointer', textAlign: 'left',
            }}>
              <div style={{ width: 12, height: 12, borderRadius: 6, background: s.tone, flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: '#F5F1EA' }}>{s.name}</span>
              <span style={{ fontSize: 12, color: 'rgba(245,241,234,0.4)' }}>{s.count} acts</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function SlotBanner({ ctx, onOpenStagePicker, onExitStage }) {
  if (!ctx) {
    // No slot active — just show the "Browse by stage" affordance
    return (
      <div style={{ padding: '6px 20px 4px', display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={onOpenStagePicker} style={{
          border: '1px solid rgba(245,241,234,0.15)', background: 'none',
          color: 'rgba(245,241,234,0.55)', fontSize: 11, fontWeight: 600,
          padding: '4px 10px', borderRadius: 6, cursor: 'pointer', letterSpacing: 0.2,
        }}>Browse a stage →</button>
      </div>
    );
  }

  if (ctx.isStageMode) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 16px 4px',
        background: 'rgba(255,255,255,0.04)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, color: '#FACC15', textTransform: 'uppercase' }}>Stage</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#F5F1EA' }}>{ctx.time}</span>
          {ctx.total > 0 && <span style={{ fontSize: 11, color: 'rgba(245,241,234,0.45)' }}>· {ctx.total} left</span>}
        </div>
        <button onClick={onExitStage} style={{
          border: '1px solid rgba(245,241,234,0.2)', background: 'none',
          color: 'rgba(245,241,234,0.7)', fontSize: 11, fontWeight: 600,
          padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
        }}>← Back to timeslots</button>
      </div>
    );
  }

  const labelColor = ctx.label === 'NOW' ? '#4ADE80' : ctx.label === 'NEXT' ? '#FACC15' : 'rgba(245,241,234,0.5)';
  const dots = Array.from({ length: ctx.totalSlots }, (_, i) => i);
  return (
    <div style={{ padding: '6px 16px 4px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {ctx.label && <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, color: labelColor, textTransform: 'uppercase' }}>{ctx.label}</span>}
          <span style={{ fontSize: 13, fontWeight: 600, color: '#F5F1EA' }}>{ctx.time}</span>
          <span style={{ fontSize: 11, color: 'rgba(245,241,234,0.45)' }}>· {ctx.total} sets</span>
        </div>
        <button onClick={onOpenStagePicker} style={{
          border: '1px solid rgba(245,241,234,0.15)', background: 'none',
          color: 'rgba(245,241,234,0.45)', fontSize: 10, fontWeight: 600,
          padding: '3px 8px', borderRadius: 6, cursor: 'pointer', letterSpacing: 0.2,
        }}>By stage</button>
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        {dots.map(i => (
          <div key={i} style={{
            width: i === ctx.slotIdx ? 14 : 5, height: 5, borderRadius: 3,
            background: i === ctx.slotIdx ? '#F5F1EA' : i < ctx.slotIdx ? 'rgba(245,241,234,0.35)' : 'rgba(245,241,234,0.12)',
            transition: 'all 0.2s',
          }} />
        ))}
      </div>
    </div>
  );
}

function DiscoverView({ deck, slotContext, allChosen, onSwipe, onUndo, undoStack, scheduled, soundOn, setSoundOn, browseStage, onBrowseStage, onOpenStagePicker, onResetDay }) {
  if (deck.length === 0) {
    if (allChosen) {
      // Every timeslot has a chosen band — genuinely done
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32, textAlign: 'center', color: 'rgba(245,241,234,0.6)' }}>
          <div>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🎉</div>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4, color: '#F5F1EA' }}>You're all set for this day!</div>
            <div style={{ fontSize: 13, marginBottom: 16 }}>Every timeslot has a pick. Tap "Mine" to see your schedule.</div>
            {undoStack.length > 0 && (
              <button onClick={onUndo} style={{ padding: '8px 20px', borderRadius: 8, border: '1px solid rgba(245,241,234,0.2)', background: 'transparent', color: '#F5F1EA', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>↺ Undo last swipe</button>
            )}
          </div>
        </div>
      );
    }
    // Some slots were skipped (all rejected) — offer reset
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32, textAlign: 'center', color: 'rgba(245,241,234,0.6)' }}>
        <div>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🎷</div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4, color: '#F5F1EA' }}>No more acts to review.</div>
          <div style={{ fontSize: 13, marginBottom: 20 }}>You've passed on all remaining acts for this day. Reset to start over, or check "Mine" for your picks.</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
            {undoStack.length > 0 && (
              <button onClick={onUndo} style={{ padding: '8px 20px', borderRadius: 8, border: '1px solid rgba(245,241,234,0.2)', background: 'transparent', color: '#F5F1EA', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>↺ Undo last swipe</button>
            )}
            <button onClick={onResetDay} style={{ padding: '10px 24px', borderRadius: 8, border: 0, background: 'rgba(245,241,234,0.12)', color: '#F5F1EA', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Reset this day's acts</button>
          </div>
        </div>
      </div>
    );
  }
  const top = deck[0];
  const below = deck[1];
  return (
    <div style={{
      flex: 1, position: 'relative', display: 'flex', flexDirection: 'column',
    }}>
      <SlotBanner
        ctx={slotContext}
        onOpenStagePicker={onOpenStagePicker}
        onExitStage={() => onBrowseStage(null)}
      />
      <div style={{ flex: 1, position: 'relative' }}>
        {below && (
          <BandCard
            key={below.id + '_b'}
            band={below}
            top={false}
            onSwipe={() => {}}
            scheduled={scheduled}
            soundOn={false}
            onToggleSound={() => {}}
          />
        )}
        <BandCard
          key={top.id + '_t'}
          band={top}
          top={true}
          onSwipe={(dir) => onSwipe(top, dir)}
          scheduled={scheduled}
          soundOn={soundOn}
          onToggleSound={() => setSoundOn(!soundOn)}
        />
      </div>
      <ActionBar
        onSkip={() => onSwipe(top, 'left')}
        onAdd={() => onSwipe(top, 'right')}
        onUndo={onUndo}
        canUndo={undoStack.length > 0}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "scheduleMode": "full",
  "soundOn": false
}/*EDITMODE-END*/;

function App() {
  const [t, setTweak] = (window.useTweaks || (() => [TWEAK_DEFAULTS, () => {}]))(TWEAK_DEFAULTS);

  // re-derive bands list when scheduleMode changes
  const bands = useMemo(() => {
    if (t.scheduleMode === 'full') return window.BANDS_FULL;
    return window.BANDS_FULL.filter(b => b.day === 'd3' || b.day === 'd4');
  }, [t.scheduleMode]);

  const days = useMemo(() => {
    if (t.scheduleMode === 'full') return window.DAYS_FULL;
    return window.DAYS_WEEKEND;
  }, [t.scheduleMode]);

  const [scheduledIds, setScheduledIds] = useState(() => loadSet(LS_KEY));
  const [rejectedIds, setRejectedIds] = useState(() => loadSet(LS_REJECT));
  const [activeDay, setActiveDay] = useState(() => localStorage.getItem(LS_DAY) || 'd3');
  const [view, setView] = useState('discover');
  const [soundOn, setSoundOn] = useState(t.soundOn);
  const [undoStack, setUndoStack] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showIntro, setShowIntro] = useState(() => !localStorage.getItem(LS_INTRO));
  const [mapView, setMapView] = useState(null); // 'festival' | 'access' | null
  const [browseStage, setBrowseStage] = useState(null); // null = timeslot mode; stageId = stage-browse mode
  const [stagePickerOpen, setStagePickerOpen] = useState(false);

  // Expose map opener for menu items
  window.__openMap = setMapView;

  useEffect(() => saveSet(LS_KEY, scheduledIds), [scheduledIds]);
  useEffect(() => saveSet(LS_REJECT, rejectedIds), [rejectedIds]);
  useEffect(() => localStorage.setItem(LS_DAY, activeDay), [activeDay]);

  // If we changed mode and activeDay is no longer in days, reset
  useEffect(() => {
    if (!days.find(d => d.id === activeDay)) setActiveDay(days[0].id);
  }, [days, activeDay]);

  const scheduledBands = useMemo(
    () => bands.filter(b => scheduledIds.has(b.id)),
    [bands, scheduledIds]
  );

  // ── Deck computation ─────────────────────────────────────────
  const { deck, slotContext, allChosen } = useMemo(() => {
    const allDay = bands.filter(b => b.day === activeDay);

    // ── Stage-browse mode ──────────────────────────────────────
    if (browseStage) {
      const stageBands = allDay
        .filter(b => b.stage === browseStage && !scheduledIds.has(b.id) && !rejectedIds.has(b.id))
        .sort((a, b) => toMin(a.start) - toMin(b.start));
      const stage = STAGE_BY_ID[browseStage];
      return {
        deck: stageBands,
        slotContext: { label: 'STAGE', time: stage?.name ?? '', total: stageBands.length, slotIdx: -1, totalSlots: 0, isStageMode: true },
      };
    }

    // ── Timeslot-gated mode (default) ─────────────────────────
    // Walk ALL slots in order. Skip only when user has chosen ≥1 band
    // from that slot (slot done) or all bands in it are rejected.
    // "You're all set" only appears when every slot is truly done.
    // Clock time (today only) adds a NOW/NEXT label — it never gates progress.
    const slots = [...new Set(allDay.map(b => b.start))].sort();
    const isToday = DAY_BY_ID[activeDay]?.date === todayDate();
    const now = isToday ? nowMinutes() : -1;

    const slotLabel = (slot) => {
      if (!isToday) return null;
      const sMin = toMin(slot);
      const maxEnd = Math.max(...allDay.filter(b => b.start === slot).map(b => toMin(b.end)));
      if (sMin <= now && now < maxEnd) return 'NOW';
      if (sMin > now) return 'NEXT';
      return null; // past slot
    };

    // A slot is "done" ONLY when the user has chosen ≥1 band from it.
    // Rejected-only slots are skipped for display but are NOT done —
    // they don't contribute to "you're all set."
    let allChosen = true; // flip to false if any slot lacks a choice

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const slotBands = allDay.filter(b => b.start === slot);
      const hasChosen = slotBands.some(b => scheduledIds.has(b.id));

      if (hasChosen) continue; // genuinely done — user picked something

      // No choice yet for this slot.
      allChosen = false;
      const pending = slotBands.filter(b => !scheduledIds.has(b.id) && !rejectedIds.has(b.id));
      if (pending.length === 0) continue; // all rejected, nothing to show — keep walking

      // Found a slot with cards to show.
      return {
        deck: pending,
        slotContext: { label: slotLabel(slot), time: fmtTime(slot), total: slotBands.length, slotIdx: i, totalSlots: slots.length },
        allChosen: false,
      };
    }
    // Deck exhausted — distinguish "truly all set" from "everything rejected"
    return { deck: [], slotContext: null, allChosen };
  }, [bands, activeDay, browseStage, scheduledIds, rejectedIds]);

  const handleSwipe = useCallback((band, dir) => {
    if (dir === 'left') {
      setRejectedIds(prev => new Set([...prev, band.id]));
    } else {
      setScheduledIds(prev => new Set([...prev, band.id]));
    }
    setUndoStack(prev => [...prev, { band, dir }]);
  }, []);

  const handleUndo = () => {
    setUndoStack(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.dir === 'left') {
        setRejectedIds(s => { const n = new Set(s); n.delete(last.band.id); return n; });
      } else {
        setScheduledIds(s => { const n = new Set(s); n.delete(last.band.id); return n; });
      }
      return prev.slice(0, -1);
    });
  };

  const handleRemove = (band) => {
    setScheduledIds(s => { const n = new Set(s); n.delete(band.id); return n; });
  };

  // ── Notifications ─────────────────────────────────────────────
  // Request permission when user opens Mine tab, then (re)schedule alerts.
  useEffect(() => {
    if (view !== 'schedule') return;
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      Notification.requestPermission().then(p => {
        if (p === 'granted') scheduleLocalNotifications(scheduledBands);
      });
    } else if (Notification.permission === 'granted') {
      scheduleLocalNotifications(scheduledBands);
    }
  }, [view, scheduledBands]);

  // Provide days/active-day to Header — hack: temporarily override window.DAYS for Header
  const headerDays = days;

  return (
    <div style={{
      width: '100%', height: '100%', position: 'relative',
      display: 'flex', flexDirection: 'column',
      background: '#0F0E0C',
      fontFamily: '-apple-system, system-ui, sans-serif',
    }}>
      <HeaderInner
        days={headerDays}
        activeDay={activeDay}
        setActiveDay={setActiveDay}
        view={view}
        setView={setView}
        scheduledCount={scheduledBands.length}
        onMenuOpen={() => setMenuOpen(true)}
      />

      {view === 'discover' ? (
        <DiscoverView
          deck={deck}
          slotContext={slotContext}
          allChosen={allChosen}
          onSwipe={handleSwipe}
          onUndo={handleUndo}
          undoStack={undoStack}
          scheduled={scheduledBands}
          soundOn={soundOn}
          setSoundOn={(v) => { setSoundOn(v); setTweak('soundOn', v); }}
          browseStage={browseStage}
          onBrowseStage={setBrowseStage}
          onOpenStagePicker={() => setStagePickerOpen(true)}
          onResetDay={() => {
            const dayBandIds = bands.filter(b => b.day === activeDay).map(b => b.id);
            setRejectedIds(prev => { const n = new Set(prev); dayBandIds.forEach(id => n.delete(id)); return n; });
            setScheduledIds(prev => { const n = new Set(prev); dayBandIds.forEach(id => n.delete(id)); return n; });
            setUndoStack([]);
          }}
        />
      ) : (
        <ScheduleView
          scheduled={scheduledBands}
          activeDay={activeDay}
          onRemove={handleRemove}
        />
      )}

      {/* Hamburger menu */}
      <HamburgerMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onShowIntro={() => setShowIntro(true)}
      />

      {/* First-run intro overlay */}
      {showIntro && (
        <IntroOverlay onClose={() => {
          localStorage.setItem(LS_INTRO, '1');
          setShowIntro(false);
        }} />
      )}

      {/* Stage picker */}
      <StagePicker
        open={stagePickerOpen}
        activeDay={activeDay}
        onSelect={(stageId) => { setBrowseStage(stageId); setStagePickerOpen(false); }}
        onClose={() => setStagePickerOpen(false)}
      />

      {/* Map viewer */}
      {mapView === 'festival' && (
        <MapViewer src="festival-map.jpg" title="Festival Map" onClose={() => setMapView(null)} />
      )}
      {mapView === 'access' && (
        <MapViewer src="access-map.jpg" title="Accessibility Map" onClose={() => setMapView(null)} />
      )}

      {/* Tweaks panel */}
      {window.TweaksPanel && (
        <window.TweaksPanel>
          <window.TweakSection label="Schedule scope" />
          <window.TweakRadio
            label="Days"
            value={t.scheduleMode}
            options={['weekend', 'full']}
            onChange={(v) => setTweak('scheduleMode', v)}
          />
          <window.TweakSection label="Reset" />
          <window.TweakButton
            label="Clear my schedule"
            onClick={() => {
              if (confirm('Remove all bands from your schedule?')) {
                setScheduledIds(new Set());
                setRejectedIds(new Set());
                setUndoStack([]);
              }
            }}
          />
        </window.TweaksPanel>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Day tab strip — scrollable, auto-scrolls active day into view
// ─────────────────────────────────────────────────────────────
function DayTabs({ days, activeDay, setActiveDay, compact }) {
  const scrollRef = useRef(null);
  const activeRef = useRef(null);

  useEffect(() => {
    if (activeRef.current && scrollRef.current) {
      activeRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [activeDay]);

  return (
    <div
      ref={scrollRef}
      style={{
        display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2,
        scrollbarWidth: 'none', msOverflowStyle: 'none',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      <style>{`.day-scroll::-webkit-scrollbar { display: none; }`}</style>
      {days.map(d => {
        const active = d.id === activeDay;
        const parts = d.label.split(' '); // e.g. ["Sat","Apr","25"] or ["Fri","May","1"]
        const weekday = parts[0];
        const monthDay = parts.slice(1).join(' ');
        return (
          <button
            key={d.id}
            ref={active ? activeRef : null}
            onClick={() => setActiveDay(d.id)}
            style={{
              flex: '0 0 auto', border: 0,
              padding: '8px 11px', minWidth: 58,
              background: active ? '#F5F1EA' : 'rgba(255,255,255,0.08)',
              color: active ? '#0F0E0C' : 'rgba(245,241,234,0.65)',
              borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            <div style={{ fontSize: 10, fontWeight: 600, opacity: active ? 0.6 : 0.6, textTransform: 'uppercase', letterSpacing: 0.3 }}>{weekday}</div>
            <div style={{ fontSize: 13, fontWeight: 700, marginTop: 2 }}>{monthDay}</div>
          </button>
        );
      })}
    </div>
  );
}

// Header pulled inline so we can pass days dynamically
function HeaderInner({ days, activeDay, setActiveDay, view, setView, scheduledCount, onMenuOpen }) {
  const compact = days.length > 4;
  return (
    <div style={{
      padding: '0 16px',
      paddingTop: 'max(14px, env(safe-area-inset-top, 14px))',
      paddingBottom: 0,
      position: 'relative', zIndex: 5,
    }}>
      {/* Row 1: title + hamburger */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 8,
      }}>
        <h1 style={{
          margin: 0, color: '#F5F1EA',
          fontFamily: 'Georgia, "Times New Roman", serif',
          fontSize: 20, fontWeight: 700, letterSpacing: -0.5,
        }}>StageHopper</h1>
        <HamburgerBtn onClick={onMenuOpen} />
      </div>
      {/* Row 2: view toggle */}
      <div style={{ marginBottom: 10 }}>
        <ViewToggle view={view} setView={setView} scheduledCount={scheduledCount} />
      </div>

      <DayTabs days={days} activeDay={activeDay} setActiveDay={setActiveDay} compact={compact} />
    </div>
  );
}

window.App = App;
