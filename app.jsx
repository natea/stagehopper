// app.jsx — Jazz Fest swipe scheduler
// Bands as a Tinder-style stack. Swipe right = add to schedule, left = skip.
// Conflicts (overlapping selected bands) are surfaced before & after acceptance.

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const STAGE_BY_ID = Object.fromEntries(window.STAGES.map(s => [s.id, s]));
const DAY_BY_ID   = Object.fromEntries(window.DAYS.map(d => [d.id, d]));

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
        {/* Stage tag */}
        <div style={{
          position: 'absolute', top: 12, left: 12, zIndex: 7,
          background: stage.tone, color: '#fff',
          fontSize: 11, fontWeight: 600, letterSpacing: 0.4,
          padding: '5px 9px', borderRadius: 6, textTransform: 'uppercase',
          pointerEvents: 'none',
        }}>{stage.name}</div>
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
          display: 'inline-flex', alignSelf: 'flex-start',
          fontSize: 11, fontWeight: 600, letterSpacing: 0.4,
          color: stage.tone, background: 'rgba(255,255,255,0.08)',
          padding: '3px 8px', borderRadius: 4, textTransform: 'uppercase',
        }}>{band.genre}</div>

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
      {btn('↺', onUndo, canUndo ? '#A1A1AA' : '#E5E5E5', 44)}
      {btn('✕', onSkip, '#F87171', 56)}
      {btn('♥', onAdd, '#22C55E', 56)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Day tabs + view toggle
// ─────────────────────────────────────────────────────────────
function Header({ activeDay, setActiveDay, view, setView, scheduledCount }) {
  return (
    <div style={{
      padding: '54px 16px 0', position: 'relative', zIndex: 5,
      background: 'rgba(15,14,12,0.0)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginBottom: 12,
      }}>
        <h1 style={{
          margin: 0, color: '#F5F1EA',
          fontFamily: 'Georgia, "Times New Roman", serif',
          fontSize: 26, fontWeight: 700, letterSpacing: -0.5,
        }}>NOLA JazzFest</h1>
        <div style={{
          display: 'flex', gap: 4, padding: 3,
          background: 'rgba(255,255,255,0.08)', borderRadius: 10,
        }}>
          {['discover', 'schedule'].map(v => (
            <button key={v} onClick={() => setView(v)} style={{
              border: 0, background: view === v ? '#F5F1EA' : 'transparent',
              color: view === v ? '#0F0E0C' : 'rgba(245,241,234,0.7)',
              fontSize: 12, fontWeight: 600, padding: '6px 12px',
              borderRadius: 7, cursor: 'pointer',
              fontFamily: 'inherit', letterSpacing: 0.2,
            }}>
              {v === 'discover' ? 'Discover' : `Mine · ${scheduledCount}`}
            </button>
          ))}
        </div>
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
// Schedule timeline view
// ─────────────────────────────────────────────────────────────
function ScheduleView({ scheduled, activeDay, onRemove }) {
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

  // Hour grid 11 AM – 8 PM
  const startH = 11, endH = 20;
  const pxPerHour = 76;

  return (
    <div style={{
      flex: 1, overflowY: 'auto', position: 'relative',
      padding: '12px 16px 100px',
    }}>
      {/* conflict summary */}
      {conflictIds.size > 0 && (
        <div style={{
          background: 'rgba(220, 80, 70, 0.14)',
          border: '1px solid rgba(220, 80, 70, 0.4)',
          color: '#FFB4A8',
          borderRadius: 10, padding: '8px 12px',
          fontSize: 12, marginBottom: 12, lineHeight: 1.35,
        }}>
          <b>⚠ {conflictIds.size / 2 | 0 || 1} conflict{conflictIds.size > 2 ? 's' : ''} on this day.</b> Tap a set to drop it.
        </div>
      )}

      <div style={{
        position: 'relative',
        height: (endH - startH) * pxPerHour,
        marginLeft: 42,
      }}>
        {/* hour lines */}
        {Array.from({ length: endH - startH + 1 }, (_, i) => {
          const h = startH + i;
          const ap = h >= 12 ? 'PM' : 'AM';
          const h12 = ((h + 11) % 12) + 1;
          return (
            <div key={h} style={{
              position: 'absolute', left: 0, right: 0,
              top: i * pxPerHour,
            }}>
              <div style={{
                position: 'absolute', left: -42, top: -7, width: 38, textAlign: 'right',
                fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
                color: 'rgba(245,241,234,0.4)', fontVariantNumeric: 'tabular-nums',
              }}>{h12} {ap}</div>
              <div style={{ height: 1, background: 'rgba(245,241,234,0.08)' }} />
            </div>
          );
        })}

        {/* events */}
        {dayBands.map(b => {
          const stage = STAGE_BY_ID[b.stage];
          const top = (toMin(b.start) - startH * 60) / 60 * pxPerHour;
          const height = (toMin(b.end) - toMin(b.start)) / 60 * pxPerHour;
          const isConflict = conflictIds.has(b.id);
          // figure out lateral offset for stacking conflicts
          const laneIdx = dayBands
            .filter(o => o.id !== b.id && overlap(o, b) && toMin(o.start) <= toMin(b.start))
            .length;
          return (
            <div key={b.id}
              onClick={() => onRemove(b)}
              style={{
                position: 'absolute',
                top, height: Math.max(height - 3, 38),
                left: `${laneIdx * 8}px`,
                right: `${4 - laneIdx * 4}px`,
                background: stage.tone,
                borderLeft: isConflict ? '4px solid #FF6B6B' : `4px solid ${stage.tone}`,
                borderRadius: 8, padding: '6px 10px',
                color: '#fff', cursor: 'pointer',
                boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
                overflow: 'hidden', display: 'flex', flexDirection: 'column',
                gap: 1,
              }}>
              <div style={{
                fontSize: 13, fontWeight: 700, lineHeight: 1.15,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{b.name}</div>
              <div style={{
                fontSize: 10, opacity: 0.85, fontVariantNumeric: 'tabular-nums',
              }}>
                {fmtTimeShort(b.start)}–{fmtTimeShort(b.end)} · {stage.name}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Discover (swipe stack) view
// ─────────────────────────────────────────────────────────────
function DiscoverView({ deck, onSwipe, onUndo, undoStack, scheduled, soundOn, setSoundOn }) {
  if (deck.length === 0) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 32, textAlign: 'center', color: 'rgba(245,241,234,0.6)',
      }}>
        <div>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🎺</div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4, color: '#F5F1EA' }}>
            That's everyone for this day.
          </div>
          <div style={{ fontSize: 13 }}>
            Tap "Mine" to see your schedule, or pick another day.
          </div>
          {undoStack.length > 0 && (
            <button onClick={onUndo} style={{
              marginTop: 16, padding: '8px 16px', borderRadius: 8,
              border: '1px solid rgba(245,241,234,0.2)',
              background: 'transparent', color: '#F5F1EA',
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}>↺ Undo last</button>
          )}
        </div>
      </div>
    );
  }
  // stack: render top + 1 below
  const top = deck[0];
  const below = deck[1];
  return (
    <div style={{
      flex: 1, position: 'relative', display: 'flex', flexDirection: 'column',
    }}>
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
// Conflict prompt modal
// ─────────────────────────────────────────────────────────────
function ConflictModal({ band, conflicts, onCancel, onReplace, onAddBoth }) {
  if (!band) return null;
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'flex-end',
      animation: 'fade 200ms ease',
    }}
    onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: '#1A1816', color: '#F5F1EA',
        borderRadius: '20px 20px 0 0',
        padding: '20px 20px 32px',
        width: '100%', boxSizing: 'border-box',
      }}>
        <div style={{
          width: 36, height: 4, borderRadius: 2,
          background: 'rgba(245,241,234,0.25)',
          margin: '0 auto 14px',
        }} />
        <div style={{
          fontFamily: 'Georgia, serif', fontSize: 19, fontWeight: 700,
          marginBottom: 4, lineHeight: 1.2,
        }}>Conflict on your schedule</div>
        <div style={{ fontSize: 13, color: 'rgba(245,241,234,0.7)', marginBottom: 14 }}>
          <b>{band.name}</b> overlaps with:
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {conflicts.map(c => (
            <div key={c.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 12px', borderRadius: 10,
              background: 'rgba(255,255,255,0.06)',
            }}>
              <div style={{
                width: 4, height: 32, borderRadius: 2,
                background: STAGE_BY_ID[c.stage].tone,
              }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{c.name}</div>
                <div style={{ fontSize: 11, color: 'rgba(245,241,234,0.6)', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtTimeShort(c.start)}–{fmtTimeShort(c.end)} · {STAGE_BY_ID[c.stage].name}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button onClick={onReplace} style={{
            border: 0, background: '#F5F1EA', color: '#0F0E0C',
            padding: '13px', borderRadius: 12, fontWeight: 700, fontSize: 14,
            cursor: 'pointer', fontFamily: 'inherit',
          }}>Replace conflicting set{conflicts.length > 1 ? 's' : ''}</button>
          <button onClick={onAddBoth} style={{
            border: '1px solid rgba(245,241,234,0.2)', background: 'transparent',
            color: '#F5F1EA',
            padding: '13px', borderRadius: 12, fontWeight: 600, fontSize: 14,
            cursor: 'pointer', fontFamily: 'inherit',
          }}>Add anyway (stage-hop)</button>
          <button onClick={onCancel} style={{
            border: 0, background: 'transparent',
            color: 'rgba(245,241,234,0.6)',
            padding: '8px', fontWeight: 500, fontSize: 13,
            cursor: 'pointer', fontFamily: 'inherit',
          }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "scheduleMode": "weekend",
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
  const [pendingConflict, setPendingConflict] = useState(null); // { band, conflicts }

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

  const deck = useMemo(() => {
    return bands.filter(b =>
      b.day === activeDay &&
      !scheduledIds.has(b.id) &&
      !rejectedIds.has(b.id)
    );
  }, [bands, activeDay, scheduledIds, rejectedIds]);

  const handleSwipe = useCallback((band, dir) => {
    if (dir === 'left') {
      setRejectedIds(prev => new Set([...prev, band.id]));
      setUndoStack(prev => [...prev, { band, dir }]);
      return;
    }
    // dir === 'right' → check conflicts first
    const cf = conflictsWith(band, scheduledBands);
    if (cf.length > 0) {
      setPendingConflict({ band, conflicts: cf });
      return;
    }
    setScheduledIds(prev => new Set([...prev, band.id]));
    setUndoStack(prev => [...prev, { band, dir }]);
  }, [scheduledBands]);

  const handleReplace = () => {
    const { band, conflicts } = pendingConflict;
    setScheduledIds(prev => {
      const next = new Set(prev);
      conflicts.forEach(c => next.delete(c.id));
      next.add(band.id);
      return next;
    });
    setUndoStack(prev => [...prev, { band, dir: 'right', replaced: conflicts.map(c => c.id) }]);
    setPendingConflict(null);
  };
  const handleAddBoth = () => {
    const { band } = pendingConflict;
    setScheduledIds(prev => new Set([...prev, band.id]));
    setUndoStack(prev => [...prev, { band, dir: 'right' }]);
    setPendingConflict(null);
  };
  const handleCancelConflict = () => setPendingConflict(null);

  const handleUndo = () => {
    setUndoStack(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.dir === 'left') {
        setRejectedIds(s => { const n = new Set(s); n.delete(last.band.id); return n; });
      } else {
        setScheduledIds(s => { const n = new Set(s); n.delete(last.band.id); return n; });
        if (last.replaced) {
          setScheduledIds(s => new Set([...s, ...last.replaced]));
        }
      }
      return prev.slice(0, -1);
    });
  };

  const handleRemove = (band) => {
    if (confirm(`Drop ${band.name} from your schedule?`)) {
      setScheduledIds(s => { const n = new Set(s); n.delete(band.id); return n; });
    }
  };

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
      />

      {view === 'discover' ? (
        <DiscoverView
          deck={deck}
          onSwipe={handleSwipe}
          onUndo={handleUndo}
          undoStack={undoStack}
          scheduled={scheduledBands}
          soundOn={soundOn}
          setSoundOn={(v) => { setSoundOn(v); setTweak('soundOn', v); }}
        />
      ) : (
        <ScheduleView
          scheduled={scheduledBands}
          activeDay={activeDay}
          onRemove={handleRemove}
        />
      )}

      <ConflictModal
        band={pendingConflict?.band}
        conflicts={pendingConflict?.conflicts || []}
        onCancel={handleCancelConflict}
        onReplace={handleReplace}
        onAddBoth={handleAddBoth}
      />

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

// Header pulled inline so we can pass days dynamically
function HeaderInner({ days, activeDay, setActiveDay, view, setView, scheduledCount }) {
  const compact = days.length > 4;
  return (
    <div style={{
      padding: '54px 16px 0', position: 'relative', zIndex: 5,
    }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginBottom: 12,
      }}>
        <h1 style={{
          margin: 0, color: '#F5F1EA',
          fontFamily: 'Georgia, "Times New Roman", serif',
          fontSize: 26, fontWeight: 700, letterSpacing: -0.5,
        }}>NOLA JazzFest</h1>
        <div style={{
          display: 'flex', gap: 4, padding: 3,
          background: 'rgba(255,255,255,0.08)', borderRadius: 10,
        }}>
          {[['discover','Discover'], ['schedule', `Mine · ${scheduledCount}`]].map(([v, label]) => (
            <button key={v} onClick={() => setView(v)} style={{
              border: 0, background: view === v ? '#F5F1EA' : 'transparent',
              color: view === v ? '#0F0E0C' : 'rgba(245,241,234,0.7)',
              fontSize: 12, fontWeight: 600, padding: '6px 12px',
              borderRadius: 7, cursor: 'pointer',
              fontFamily: 'inherit', letterSpacing: 0.2,
            }}>{label}</button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: compact ? 4 : 8, overflowX: 'auto' }}>
        {days.map(d => {
          const active = d.id === activeDay;
          const dayNum = d.label.split(' ').slice(-1)[0];
          const monAbbrev = d.label.split(' ')[1];
          return (
            <button key={d.id} onClick={() => setActiveDay(d.id)} style={{
              flex: compact ? '0 0 auto' : 1, border: 0,
              padding: compact ? '8px 10px' : '10px 0',
              minWidth: compact ? 56 : 'auto',
              background: active ? '#F5F1EA' : 'rgba(255,255,255,0.08)',
              color: active ? '#0F0E0C' : 'rgba(245,241,234,0.7)',
              borderRadius: 10, cursor: 'pointer',
              fontFamily: 'inherit',
            }}>
              <div style={{ fontSize: 11, fontWeight: 500, opacity: 0.7 }}>{d.short}</div>
              <div style={{ fontSize: compact ? 13 : 15, fontWeight: 700, marginTop: 1 }}>
                {monAbbrev} {dayNum}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

window.App = App;
