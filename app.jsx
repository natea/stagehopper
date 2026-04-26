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

const todayDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

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
const LS_KEY      = 'jf26.schedule.v3';
const LS_REJECT   = 'jf26.rejected.v3';
const LS_DAY      = 'jf26.activeDay.v3';
const LS_TOPPICKS = 'jf26.topPicks.v1';

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
function YouTubeEmbed({ id, band, stage, autoPlay, onFallback }) {
  const [failed, setFailed] = useState(false);
  const iframeRef = useRef(null);

  // YT IFrame API fires postMessage with error codes 100, 101, 150 when a
  // video is unavailable or embedding is disabled. Auto-fall back immediately.
  useEffect(() => {
    const handle = (e) => {
      if (!e.origin.includes('youtube.com')) return;
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (data?.event === 'infoDelivery' && data?.info?.error) setFailed(true);
        if (data?.event === 'onError' || (data?.info && [100, 101, 150].includes(data.info.error))) setFailed(true);
      } catch {}
    };
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  }, [id]);

  if (failed) return <YouTubeSearchTile band={band} stage={stage} />;

  // Note: YouTube embeds throw Error 153 when loaded from file:// — the player
  // can't validate the origin. Hosting over http(s) (PWA) makes them work.
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const originParam = origin && origin !== 'null' && !origin.startsWith('file') ? `&origin=${encodeURIComponent(origin)}` : '';
  // autoplay=1&mute=1: browsers allow muted autoplay without a user gesture (TikTok-style).
  // The user can unmute inside the player. When autoPlay is off, video waits for a tap.
  const autoParams = autoPlay ? '&autoplay=1&mute=1' : '&autoplay=0';
  const src = `https://www.youtube.com/embed/${id}?controls=1&modestbranding=1&playsinline=1&rel=0&enablejsapi=1${autoParams}${originParam}`;
  return (
    <>
      <iframe
        ref={iframeRef}
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
      {/* Escape hatch for embeds that fail silently (no postMessage error) */}
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

function VideoPreview({ band, stage, autoPlay }) {
  if (band.verified && band.yt) {
    return <YouTubeEmbed id={band.yt} band={band} stage={stage} autoPlay={autoPlay} />;
  }
  return <YouTubeSearchTile band={band} stage={stage} />;
}

// ─────────────────────────────────────────────────────────────
// Card
// ─────────────────────────────────────────────────────────────
function BandCard({ band, top, onSwipe, scheduled, autoPlay, onToggleAutoPlay }) {
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
          <VideoPreview band={band} stage={stage} autoPlay={autoPlay} />
        ) : (
          <div style={{
            position: 'absolute', inset: 0,
            background: `linear-gradient(135deg, ${stage.tone}, #1a1a1a)`,
          }} />
        )}
        {/* Autoplay toggle — top-left of video area */}
        {top && (
          <button
            onPointerDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onToggleAutoPlay(); }}
            title={autoPlay ? 'Turn off autoplay' : 'Turn on autoplay'}
            style={{
              position: 'absolute', top: 10, left: 10, zIndex: 10,
              background: 'rgba(0,0,0,0.55)', border: 0,
              color: autoPlay ? '#fff' : 'rgba(255,255,255,0.45)',
              fontSize: 16, width: 32, height: 32, borderRadius: 16,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', backdropFilter: 'blur(8px)',
            }}
          >{autoPlay ? '▶' : '⏸'}</button>
        )}
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
  const hasPicks = scheduledCount > 0;
  const mineIsActive = view === 'schedule';
  return (
    <>
      <style>{`
        @keyframes mine-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(251,191,36,0.55); }
          50%       { box-shadow: 0 0 0 6px rgba(251,191,36,0); }
        }
      `}</style>
      <div style={{ display: 'flex', gap: 4, padding: 3, background: 'rgba(255,255,255,0.08)', borderRadius: 10 }}>
        <button onClick={() => setView('discover')} style={{
          border: 0,
          background: view === 'discover' ? '#F5F1EA' : 'transparent',
          color: view === 'discover' ? '#0F0E0C' : 'rgba(245,241,234,0.7)',
          fontSize: 12, fontWeight: 600, padding: '6px 12px',
          borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: 0.2,
        }}>Discover</button>

        <button onClick={() => setView('schedule')} style={{
          border: 0,
          background: mineIsActive ? '#F5F1EA' : hasPicks ? '#FBBF24' : 'transparent',
          color: mineIsActive ? '#0F0E0C' : hasPicks ? '#0F0E0C' : 'rgba(245,241,234,0.7)',
          fontSize: 12, fontWeight: 700, padding: '6px 12px',
          borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: 0.2,
          animation: hasPicks && !mineIsActive ? 'mine-pulse 1.8s ease-in-out infinite' : 'none',
          transition: 'background 0.2s, color 0.2s',
        }}>
          Mine · {scheduledCount}
        </button>
      </div>
    </>
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
// Mine: band detail sheet — with conflict reordering + preview
// ─────────────────────────────────────────────────────────────
function DragHandle() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, opacity: 0.4 }}>
      <circle cx="5" cy="4" r="1.5" fill="currentColor"/>
      <circle cx="11" cy="4" r="1.5" fill="currentColor"/>
      <circle cx="5" cy="8" r="1.5" fill="currentColor"/>
      <circle cx="11" cy="8" r="1.5" fill="currentColor"/>
      <circle cx="5" cy="12" r="1.5" fill="currentColor"/>
      <circle cx="11" cy="12" r="1.5" fill="currentColor"/>
    </svg>
  );
}

function MineBandSheet({ band, conflictingBands, onClose, onRemove, onRemoveConflict, userTopPicks, onTopPickChange }) {
  if (!band) return null;

  const hasConflicts = conflictingBands.length > 0;
  // All bands in the conflict group
  const allBands = useMemo(() => [band, ...conflictingBands], [band, conflictingBands]);

  // Initial order: put computeTopPicks winner (respecting user overrides) first
  const [order, setOrder] = useState(() => {
    const topIds = computeTopPicks(allBands, userTopPicks);
    const topId = allBands.find(b => topIds.has(b.id))?.id ?? allBands[0].id;
    return [topId, ...allBands.filter(b => b.id !== topId).map(b => b.id)];
  });
  const [previewId, setPreviewId] = useState(() => {
    const topIds = computeTopPicks(allBands, userTopPicks);
    return allBands.find(b => topIds.has(b.id))?.id ?? band.id;
  });

  // Keep order in sync if bands change (e.g. after a remove)
  useEffect(() => {
    setOrder(prev => {
      const ids = allBands.map(b => b.id);
      const kept = prev.filter(id => ids.includes(id));
      const added = ids.filter(id => !prev.includes(id));
      return [...kept, ...added];
    });
  }, [allBands]);

  const orderedBands = order.map(id => allBands.find(b => b.id === id)).filter(Boolean);
  const previewBand = allBands.find(b => b.id === previewId) || band;
  const previewStage = STAGE_BY_ID[previewBand.stage];
  const day = DAY_BY_ID[previewBand.day];

  // ── Drag-to-reorder ───────────────────────────────────────
  const dragState = useRef(null);
  const rowRefs = useRef({});

  const onDragStart = (e, id) => {
    e.stopPropagation();
    dragState.current = { id, startY: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onDragMove = (e) => {
    if (!dragState.current) return;
    const { id, startY } = dragState.current;
    const dy = e.clientY - startY;
    const ROW_H = 52;
    const steps = Math.round(dy / ROW_H);
    if (steps === 0) return;
    setOrder(prev => {
      const idx = prev.indexOf(id);
      const next = [...prev];
      const target = Math.max(0, Math.min(next.length - 1, idx + steps));
      if (target === idx) return prev;
      next.splice(idx, 1);
      next.splice(target, 0, id);
      dragState.current = { id, startY: e.clientY };
      return next;
    });
  };

  const onDragEnd = () => { dragState.current = null; };

  const handleClose = () => {
    if (onTopPickChange && order[0]) onTopPickChange(order[0]);
    onClose();
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 110,
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'flex-end',
    }} onClick={handleClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#1A1816', borderRadius: '20px 20px 0 0',
        width: '100%', maxHeight: '88vh',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 -8px 40px rgba(0,0,0,0.6)',
        overflow: 'hidden',
      }}>
        {/* Sheet handle + close */}
        <div style={{ position: 'relative', padding: '14px 20px 0', flexShrink: 0 }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: 'rgba(245,241,234,0.2)', margin: '0 auto' }} />
          <button
            onClick={e => { e.stopPropagation(); handleClose(); }}
            style={{
              position: 'absolute', top: 8, right: 16,
              width: 30, height: 30, borderRadius: 15,
              border: 0, background: 'rgba(245,241,234,0.12)', color: 'rgba(245,241,234,0.7)',
              fontSize: 18, lineHeight: '30px', textAlign: 'center',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >×</button>
        </div>

        {/* Video — switches when tapping a row */}
        <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', background: '#000', flexShrink: 0 }}>
          <VideoPreview band={previewBand} stage={previewStage} />
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY: 'auto', padding: '14px 16px 32px', display: 'flex', flexDirection: 'column', gap: 10 }}>

          {hasConflicts ? (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: 'rgba(245,241,234,0.4)', textTransform: 'uppercase', marginBottom: 2 }}>
                ⚠ Conflict — drag to rank, tap to preview, × to remove
              </div>

              {orderedBands.map((b, idx) => {
                const s = STAGE_BY_ID[b.stage];
                const isTop = idx === 0;
                const isPreview = b.id === previewId;
                const isOriginalBand = b.id === band.id;
                return (
                  <div key={b.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 10px 10px 6px',
                    borderRadius: 12,
                    background: isTop
                      ? 'rgba(74,222,128,0.12)'
                      : isPreview
                        ? 'rgba(255,255,255,0.06)'
                        : 'rgba(255,255,255,0.03)',
                    border: isTop ? '1px solid rgba(74,222,128,0.3)' : '1px solid transparent',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                    minHeight: 52,
                    boxSizing: 'border-box',
                  }}>
                    {/* Drag handle */}
                    <div
                      onPointerDown={e => onDragStart(e, b.id)}
                      onPointerMove={onDragMove}
                      onPointerUp={onDragEnd}
                      onPointerCancel={onDragEnd}
                      style={{ color: '#F5F1EA', cursor: 'grab', padding: '4px 2px', touchAction: 'none' }}
                    >
                      <DragHandle />
                    </div>

                    {/* Stage color dot */}
                    <div style={{ width: 10, height: 10, borderRadius: 5, background: s.tone, flexShrink: 0 }} />

                    {/* Band info — tap to preview */}
                    <div style={{ flex: 1, minWidth: 0 }} onClick={() => setPreviewId(b.id)}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {isTop && <span style={{ fontSize: 9, fontWeight: 800, color: '#4ADE80', letterSpacing: 0.8, textTransform: 'uppercase' }}>Top pick</span>}
                        <span style={{ fontSize: 14, fontWeight: 700, color: '#F5F1EA', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.name}</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'rgba(245,241,234,0.5)', marginTop: 2 }}>
                        {fmtTimeShort(b.start)}–{fmtTimeShort(b.end)} · {s.name}
                      </div>
                    </div>

                    {/* Remove button */}
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        if (isOriginalBand) { onRemove(b); handleClose(); }
                        else onRemoveConflict(b);
                      }}
                      style={{
                        flexShrink: 0, width: 30, height: 30, borderRadius: 15,
                        border: 0, background: 'rgba(220,80,70,0.2)', color: '#FFB4A8',
                        fontSize: 16, fontWeight: 700, cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >×</button>
                  </div>
                );
              })}
            </>
          ) : (
            /* No conflict — simple band info */
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'Georgia, serif', color: '#F5F1EA', marginBottom: 4 }}>{band.name}</div>
              <div style={{ fontSize: 13, color: 'rgba(245,241,234,0.6)', marginBottom: 6 }}>{day?.label} · {fmtTime(band.start)}–{fmtTime(band.end)}</div>
              <div style={{ display: 'inline-block', fontSize: 11, color: '#fff', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, background: previewStage.tone, padding: '3px 8px', borderRadius: 4 }}>{previewStage.name}</div>
            </div>
          )}

          {/* Close / Remove row */}
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button onClick={handleClose} style={{
              flex: 1, padding: '13px 0', border: '1px solid rgba(245,241,234,0.15)',
              background: 'transparent', color: '#F5F1EA',
              fontSize: 14, fontWeight: 600, borderRadius: 12, cursor: 'pointer',
            }}>Close</button>
            {!hasConflicts && (
              <button onClick={() => { onRemove(band); handleClose(); }} style={{
                flex: 1, padding: '13px 0', border: 0,
                background: 'rgba(220,80,70,0.2)', color: '#FFB4A8',
                fontSize: 14, fontWeight: 600, borderRadius: 12, cursor: 'pointer',
              }}>Remove</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Schedule timeline view — stage columns
// ─────────────────────────────────────────────────────────────

// Abbreviated stage names for column headers
const STAGE_ABBREV = {
  festival: 'Festival', shell: 'Gentilly', congo: 'Congo Sq', jazz: 'Jazz',
  blues: 'Blues', economy: 'Economy', fais: 'Fais Do-Do', heritage: 'Heritage',
  gospel: 'Gospel', lagniappe: 'Lagniappe', jamaica: 'Jamaica', rhythm: 'Rhythm',
  children: "Children's", miner: 'A. Miner',
};

// For each conflict cluster, pick the "top pick".
// userOverrides: Set of band IDs the user has manually dragged to #1 — takes priority.
function computeTopPicks(dayBands, userOverrides = null) {
  const stageOrder = Object.fromEntries(window.STAGES.map((s, i) => [s.id, i]));
  const topPicks = new Set();
  const visited = new Set();

  for (const band of dayBands) {
    if (visited.has(band.id)) continue;
    const cluster = [];
    const queue = [band];
    while (queue.length) {
      const b = queue.shift();
      if (visited.has(b.id)) continue;
      visited.add(b.id);
      cluster.push(b);
      for (const other of dayBands) {
        if (!visited.has(other.id) && overlap(b, other)) queue.push(other);
      }
    }
    if (cluster.length === 1) {
      topPicks.add(cluster[0].id);
    } else {
      // User-manual pick wins if one exists in this cluster
      const userPick = userOverrides && cluster.find(b => userOverrides.has(b.id));
      if (userPick) {
        topPicks.add(userPick.id);
      } else {
        const sorted = [...cluster].sort((a, b) => {
          const aC = cluster.filter(o => o.id !== a.id && overlap(o, a)).length;
          const bC = cluster.filter(o => o.id !== b.id && overlap(o, b)).length;
          return aC !== bC ? aC - bC : stageOrder[a.stage] - stageOrder[b.stage];
        });
        topPicks.add(sorted[0].id);
      }
    }
  }
  return topPicks;
}

function ScheduleView({ scheduled, activeDay, onRemove, userTopPicks, onTopPickChange }) {
  const [previewBand, setPreviewBand] = useState(null);
  const headerRef  = useRef(null); // stage name row — syncs scrollLeft with body
  const timeRef    = useRef(null); // frozen time axis — syncs scrollTop with body
  const bodyRef    = useRef(null); // main scroll area

  const dayBands = scheduled
    .filter(b => b.day === activeDay)
    .sort((a, b) => toMin(a.start) - toMin(b.start));

  const topPicks = useMemo(() => computeTopPicks(dayBands, userTopPicks), [dayBands, userTopPicks]);

  const conflictIds = useMemo(() => {
    const ids = new Set();
    for (let i = 0; i < dayBands.length; i++)
      for (let j = i + 1; j < dayBands.length; j++)
        if (overlap(dayBands[i], dayBands[j])) { ids.add(dayBands[i].id); ids.add(dayBands[j].id); }
    return ids;
  }, [dayBands]);

  const startH = dayBands.length ? Math.max(11, Math.min(...dayBands.map(b => Math.floor(toMin(b.start) / 60)))) : 11;
  const endH   = dayBands.length ? Math.min(22, Math.max(...dayBands.map(b => Math.ceil(toMin(b.end) / 60)))) : 19;
  const pxPerHour = 80;
  const totalH = (endH - startH) * pxPerHour;

  const activeStages = window.STAGES.filter(s => dayBands.some(b => b.stage === s.id));
  const stageColIdx  = Object.fromEntries(activeStages.map((s, i) => [s.id, i]));
  const colW = 120;
  const timeAxisW = 48;

  // Sync all panels on body scroll
  const onBodyScroll = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (headerRef.current) headerRef.current.scrollLeft = body.scrollLeft;
    if (timeRef.current)   timeRef.current.scrollTop   = body.scrollTop;
  }, []);

  // Auto-scroll to current time (or first upcoming show) when day loads
  useEffect(() => {
    const body = bodyRef.current;
    const time = timeRef.current;
    if (!body) return;

    const day = DAY_BY_ID[activeDay];
    let targetMin;
    if (day && day.date === todayDate()) {
      targetMin = nowMinutes();
    } else {
      // Non-today: jump to first show
      targetMin = dayBands.length ? toMin(dayBands[0].start) : startH * 60;
    }
    // Scroll so target time appears ~25% from top
    const rawTop = (targetMin - startH * 60) / 60 * pxPerHour;
    const scrollTop = Math.max(0, rawTop - body.clientHeight * 0.25);
    body.scrollTop = scrollTop;
    if (time) time.scrollTop = scrollTop;
  }, [activeDay]);

  const conflictsOf = (b) => dayBands.filter(o => o.id !== b.id && overlap(o, b));

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

  // Now-line position (only for today)
  const day = DAY_BY_ID[activeDay];
  const isToday = day && day.date === todayDate();
  const nowPx = isToday ? (nowMinutes() - startH * 60) / 60 * pxPerHour : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>

      {/* Status banner */}
      <div style={{ flexShrink: 0, padding: '6px 10px 0' }}>
        {conflictIds.size > 0 ? (
          <div style={{
            background: 'rgba(220,80,70,0.12)', border: '1px solid rgba(220,80,70,0.35)',
            color: '#FFB4A8', borderRadius: 8, padding: '6px 10px', fontSize: 11, lineHeight: 1.4,
          }}>
            <b>⚠ Conflicts.</b> Bright = top pick. Tap any show to preview or resolve.
          </div>
        ) : (
          <div style={{
            background: 'rgba(74,222,128,0.07)', border: '1px solid rgba(74,222,128,0.18)',
            color: '#86EFAC', borderRadius: 8, padding: '6px 10px', fontSize: 11,
          }}>
            ✓ {dayBands.length} set{dayBands.length !== 1 ? 's' : ''} — no conflicts
          </div>
        )}
      </div>

      {/* Stage header row — fixed, synced horizontally with body */}
      <div style={{ flexShrink: 0, display: 'flex', marginTop: 8, background: '#181614', borderBottom: '2px solid rgba(255,255,255,0.1)' }}>
        {/* Corner cell aligns with frozen time axis */}
        <div style={{ width: timeAxisW, flexShrink: 0, borderRight: '1px solid rgba(255,255,255,0.08)' }} />
        {/* Stage names scroll with body via JS */}
        <div ref={headerRef} style={{ flex: 1, overflowX: 'hidden', display: 'flex' }}>
          {activeStages.map(s => (
            <div key={s.id} style={{
              width: colW, flexShrink: 0,
              padding: '7px 6px',
              fontSize: 11, fontWeight: 800, textAlign: 'center',
              color: s.tone, textTransform: 'uppercase', letterSpacing: 0.5,
              borderLeft: '1px solid rgba(255,255,255,0.07)',
              lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {STAGE_ABBREV[s.id] || s.name}
            </div>
          ))}
        </div>
      </div>

      {/* Main content row: frozen time axis + scrollable grid */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* Frozen time axis — scrolls Y only (hidden overflow, driven by body) */}
        <div ref={timeRef} style={{
          width: timeAxisW, flexShrink: 0,
          overflowY: 'hidden', overflowX: 'hidden',
          background: '#0F0E0C',
          borderRight: '1px solid rgba(255,255,255,0.08)',
        }}>
          <div style={{ height: totalH + 80, position: 'relative' }}>
            {Array.from({ length: endH - startH + 1 }, (_, i) => {
              const h = startH + i;
              const h12 = ((h + 11) % 12) + 1;
              const ap = h >= 12 ? 'PM' : 'AM';
              return (
                <div key={h} style={{
                  position: 'absolute', top: i * pxPerHour - 8,
                  right: 6, fontSize: 10, fontWeight: 600,
                  color: 'rgba(245,241,234,0.45)', fontVariantNumeric: 'tabular-nums',
                  whiteSpace: 'nowrap',
                }}>{h12} {ap}</div>
              );
            })}
            {/* Now indicator in time axis */}
            {nowPx !== null && (
              <div style={{
                position: 'absolute', top: nowPx, right: 0, left: 0,
                height: 2, background: '#F87171',
              }} />
            )}
          </div>
        </div>

        {/* Scrollable events grid */}
        <div ref={bodyRef} onScroll={onBodyScroll}
          style={{ flex: 1, overflowX: 'auto', overflowY: 'auto' }}>
          <div style={{ minWidth: activeStages.length * colW, height: totalH + 80, position: 'relative' }}>

            {/* Hour lines */}
            {Array.from({ length: endH - startH + 1 }, (_, i) => (
              <div key={i} style={{
                position: 'absolute', left: 0, right: 0,
                top: i * pxPerHour, height: 1,
                background: 'rgba(245,241,234,0.07)',
              }} />
            ))}

            {/* Column backgrounds */}
            {activeStages.map((s, i) => (
              <div key={s.id} style={{
                position: 'absolute', top: 0, height: totalH,
                left: i * colW, width: colW,
                background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.018)',
                borderLeft: i > 0 ? '1px solid rgba(255,255,255,0.05)' : 'none',
              }} />
            ))}

            {/* Now indicator line */}
            {nowPx !== null && (
              <div style={{
                position: 'absolute', left: 0, right: 0, top: nowPx,
                height: 2, background: '#F87171', zIndex: 5,
                boxShadow: '0 0 6px rgba(248,113,113,0.6)',
              }} />
            )}

            {/* Event blocks */}
            {dayBands.map(b => {
              const stage = STAGE_BY_ID[b.stage];
              const colIdx = stageColIdx[b.stage] ?? 0;
              const topPx = (toMin(b.start) - startH * 60) / 60 * pxPerHour;
              const heightPx = Math.max((toMin(b.end) - toMin(b.start)) / 60 * pxPerHour - 4, 36);
              const isTop = topPicks.has(b.id);
              const isConflict = conflictIds.has(b.id);

              return (
                <div key={b.id}
                  onClick={() => setPreviewBand(b)}
                  style={{
                    position: 'absolute',
                    top: topPx, height: heightPx,
                    left: colIdx * colW + 3,
                    width: colW - 7,
                    background: isTop ? `${stage.tone}d8` : `${stage.tone}22`,
                    border: isTop ? `1.5px solid ${stage.tone}` : `1.5px dashed ${stage.tone}55`,
                    borderRadius: 8, padding: '5px 8px',
                    color: isTop ? '#fff' : 'rgba(255,255,255,0.38)',
                    cursor: 'pointer', overflow: 'hidden',
                    display: 'flex', flexDirection: 'column', gap: 2,
                    boxSizing: 'border-box',
                  }}>
                  {isTop && isConflict && (
                    <div style={{ fontSize: 8, fontWeight: 900, color: '#FCD34D', letterSpacing: 0.6, lineHeight: 1 }}>★ TOP PICK</div>
                  )}
                  <div style={{
                    fontSize: 13, fontWeight: 700, lineHeight: 1.25,
                    display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                  }}>
                    {b.name}
                  </div>
                  <div style={{ fontSize: 10, opacity: 0.8, fontVariantNumeric: 'tabular-nums', marginTop: 'auto' }}>
                    {fmtTimeShort(b.start)}–{fmtTimeShort(b.end)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Preview sheet */}
      {previewBand && (
        <MineBandSheet
          band={previewBand}
          conflictingBands={conflictsOf(previewBand)}
          userTopPicks={userTopPicks}
          onClose={() => setPreviewBand(null)}
          onTopPickChange={onTopPickChange}
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

function DiscoverView({ deck, slotContext, allChosen, onSwipe, onUndo, undoStack, scheduled, autoPlay, setAutoPlay, browseStage, onBrowseStage, onOpenStagePicker, onResetDay }) {
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
            autoPlay={false}
            onToggleAutoPlay={() => {}}
          />
        )}
        <BandCard
          key={top.id + '_t'}
          band={top}
          top={true}
          onSwipe={(dir) => onSwipe(top, dir)}
          scheduled={scheduled}
          autoPlay={autoPlay}
          onToggleAutoPlay={() => setAutoPlay(!autoPlay)}
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
  "autoPlay": true
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
  const [userTopPicks, setUserTopPicks] = useState(() => loadSet(LS_TOPPICKS));
  const [view, setView] = useState('discover');
  const [autoPlay, setAutoPlay] = useState(t.autoPlay ?? true);
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
  useEffect(() => saveSet(LS_TOPPICKS, userTopPicks), [userTopPicks]);

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
    // Past slots (today only) are silently skipped and don't affect allChosen.
    // Rejected-only slots are skipped but NOT counted as done.
    let allChosen = true; // flip to false if any current/future slot lacks a choice

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const slotBands = allDay.filter(b => b.start === slot);
      const hasChosen = slotBands.some(b => scheduledIds.has(b.id));

      if (hasChosen) continue; // genuinely done — user picked something

      // Skip slots that have entirely passed (today only) — don't penalize allChosen
      if (isToday) {
        const maxEnd = Math.max(...slotBands.map(b => toMin(b.end)));
        if (maxEnd <= now) continue;
      }

      // This slot is current or future and has no pick yet.
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
          autoPlay={autoPlay}
          setAutoPlay={(v) => { setAutoPlay(v); setTweak('autoPlay', v); }}
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
          userTopPicks={userTopPicks}
          onTopPickChange={(bandId) => setUserTopPicks(prev => {
            const n = new Set(prev);
            n.add(bandId);
            return n;
          })}
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
