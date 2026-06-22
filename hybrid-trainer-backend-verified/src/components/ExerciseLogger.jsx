// components/ExerciseLogger.jsx
// Full-screen modal for logging individual exercises
// Searches wger's 10,000+ exercise database, shows XP breakdown
//
// Usage:
//   const [showLogger, setShowLogger] = useState(false);
//   <button onClick={() => setShowLogger(true)}>Log Exercise</button>
//   {showLogger && <ExerciseLogger userId={currentUser.id} onClose={() => setShowLogger(false)} onLogged={handleLogged} />}

import { useState, useEffect, useRef, useCallback } from 'react';

const API_BASE = process.env.REACT_APP_API_URL || 'https://your-api.onrender.com';

const CATEGORY_COLORS = {
  compound_full:  '#F59E0B',
  compound_upper: '#3B82F6',
  compound_lower: '#8B5CF6',
  core:           '#10B981',
  cardio:         '#EF4444',
  hiit:           '#F97316',
  isolation:      '#6B7280',
  mobility:       '#06B6D4',
  general:        '#6B7280',
};

const CATEGORY_ICONS = {
  compound_full:  '🏋️',
  compound_upper: '💪',
  compound_lower: '🦵',
  core:           '🔥',
  cardio:         '🏃',
  hiit:           '⚡',
  isolation:      '🎯',
  mobility:       '🧘',
  general:        '✅',
};

export default function ExerciseLogger({ userId, onClose, onLogged }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(null);

  // Form state
  const [sets, setSets] = useState(3);
  const [reps, setReps] = useState(10);
  const [duration, setDuration] = useState('');
  const [weight, setWeight] = useState('');
  const [isCardio, setIsCardio] = useState(false);

  // Submission
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // { xp_breakdown, achievements }

  // Today's log
  const [todayLog, setTodayLog] = useState([]);

  const debounceRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    fetchTodayLog();
  }, []);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.length < 2) { setResults([]); return; }
    debounceRef.current = setTimeout(() => searchExercises(query), 300);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  async function searchExercises(q) {
    setSearching(true);
    try {
      const res = await fetch(`${API_BASE}/api/exercises/search?q=${encodeURIComponent(q)}&limit=8`);
      const data = await res.json();
      setResults(data.results || []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  function selectExercise(ex) {
    setSelected(ex);
    setQuery(ex.name);
    setResults([]);
    // Auto-detect if cardio
    setIsCardio(['cardio', 'hiit'].includes(ex.category));
  }

  async function fetchTodayLog() {
    try {
      const today = new Date().toISOString().split('T')[0];
      const res = await fetch(`${API_BASE}/api/exercises/history/${userId}?date=${today}&limit=20`);
      const data = await res.json();
      setTodayLog(data.exercises || []);
    } catch { }
  }

  // Live XP preview
  const previewXP = useCallback(() => {
    if (!selected) return null;
    const base = selected.base_xp || 8;
    const repXP = isCardio ? 0 : Math.round(reps * sets * 0.5);
    const setBonus = sets > 1 ? Math.round(base * 0.3 * (sets - 1)) : 0;
    const durXP = isCardio && duration ? Math.min(60, Math.floor(Number(duration) / 30)) : 0;
    const subtotal = base + repXP + setBonus + durXP;
    return { base, repXP, setBonus, durXP, subtotal };
  }, [selected, sets, reps, duration, isCardio]);

  async function handleSubmit() {
    if (!selected || submitting) return;
    setSubmitting(true);

    try {
      const body = {
        user_id: userId,
        exercise_name: selected.name,
        exercise_id_external: selected.id,
        wger_category: selected.wger_category,
        sets: Number(sets),
        reps: isCardio ? null : Number(reps),
        duration_seconds: isCardio && duration ? Number(duration) * 60 : null,
        weight_kg: weight ? Number(weight) : null,
      };

      const res = await fetch(`${API_BASE}/api/exercises/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();

      if (data.success) {
        setResult(data);
        fetchTodayLog();
        if (onLogged) onLogged(data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSubmitting(false);
    }
  }

  function resetForm() {
    setSelected(null);
    setQuery('');
    setResult(null);
    setSets(3);
    setReps(10);
    setDuration('');
    setWeight('');
    inputRef.current?.focus();
  }

  const preview = previewXP();
  const catColor = selected ? (CATEGORY_COLORS[selected.category] || '#888') : '#888';
  const catIcon = selected ? (CATEGORY_ICONS[selected.category] || '✅') : null;

  return (
    <div style={s.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={s.modal}>

        {/* Header */}
        <div style={s.header}>
          <div>
            <h2 style={s.title}>Log Exercise</h2>
            <p style={s.subtitle}>Search 10,000+ exercises. Earn XP toward your program.</p>
          </div>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* ── SUCCESS STATE ── */}
        {result && (
          <div style={s.successPanel}>
            <div style={s.successIcon}>⚡</div>
            <div style={s.successTitle}>Exercise Logged!</div>

            {/* XP breakdown */}
            <div style={s.xpCard}>
              <div style={s.xpRow}>
                <span style={s.xpLabel}>Exercise type</span>
                <span style={s.xpVal}>+{result.xp_breakdown?.base_xp} XP</span>
              </div>
              {result.xp_breakdown?.rep_xp > 0 && (
                <div style={s.xpRow}>
                  <span style={s.xpLabel}>Reps ({reps} × {sets} sets × 0.5)</span>
                  <span style={s.xpVal}>+{result.xp_breakdown?.rep_xp} XP</span>
                </div>
              )}
              {result.xp_breakdown?.set_bonus > 0 && (
                <div style={s.xpRow}>
                  <span style={s.xpLabel}>Multi-set bonus</span>
                  <span style={s.xpVal}>+{result.xp_breakdown?.set_bonus} XP</span>
                </div>
              )}
              {result.xp_breakdown?.streak_multiplier > 1 && (
                <div style={s.xpRow}>
                  <span style={s.xpLabel}>Streak multiplier ×{result.xp_breakdown?.streak_multiplier}</span>
                  <span style={{ ...s.xpVal, color: '#F59E0B' }}>🔥</span>
                </div>
              )}
              <div style={s.xpTotal}>
                <span>Total</span>
                <span style={{ color: '#F59E0B', fontWeight: 800, fontSize: 18 }}>+{result.xp_breakdown?.total_xp} XP</span>
              </div>
            </div>

            {/* Achievements */}
            {result.achievements?.length > 0 && (
              <div style={s.achievementsPanel}>
                <div style={s.achievementsTitle}>🏆 Achievement Unlocked!</div>
                {result.achievements.map(a => (
                  <div key={a.key} style={s.achievementRow}>
                    <span style={s.achievementIcon}>{a.icon}</span>
                    <div>
                      <div style={s.achievementName}>{a.name}</div>
                      <div style={s.achievementXP}>+{a.xp} bonus XP</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={s.successActions}>
              <button style={s.logAnotherBtn} onClick={resetForm}>Log Another</button>
              <button style={s.doneBtn} onClick={onClose}>Done</button>
            </div>
          </div>
        )}

        {/* ── FORM STATE ── */}
        {!result && (
          <>
            {/* Search */}
            <div style={s.searchWrapper}>
              <div style={s.searchBox}>
                <span style={s.searchIcon}>🔍</span>
                <input
                  ref={inputRef}
                  value={query}
                  onChange={e => { setQuery(e.target.value); if (selected) setSelected(null); }}
                  placeholder="Search: pushup, squat, russian twist..."
                  style={s.searchInput}
                />
                {query.length > 0 && (
                  <button style={s.clearBtn} onClick={() => { setQuery(''); setSelected(null); setResults([]); }}>✕</button>
                )}
              </div>

              {/* Dropdown results */}
              {(results.length > 0 || searching) && (
                <div style={s.dropdown}>
                  {searching && <div style={s.searching}>Searching...</div>}
                  {results.map((ex, i) => (
                    <div key={i} style={s.dropdownItem} onClick={() => selectExercise(ex)}>
                      <span style={s.exIcon}>{CATEGORY_ICONS[ex.category] || '✅'}</span>
                      <div style={s.exInfo}>
                        <span style={s.exName}>{ex.name}</span>
                        <span style={{ ...s.exCat, color: CATEGORY_COLORS[ex.category] || '#888' }}>
                          {ex.category_label}
                        </span>
                      </div>
                      <span style={s.exXP}>+{ex.base_xp} XP</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Selected exercise detail */}
            {selected && (
              <div style={{ ...s.selectedCard, borderColor: catColor + '44' }}>
                <div style={s.selectedHeader}>
                  <span style={{ fontSize: 22 }}>{catIcon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={s.selectedName}>{selected.name}</div>
                    <div style={{ ...s.selectedCat, color: catColor }}>{selected.category_label}</div>
                  </div>
                  <div style={{ ...s.baseXPBadge, background: catColor + '22', color: catColor }}>
                    +{selected.base_xp} base XP
                  </div>
                </div>

                {/* Form fields */}
                <div style={s.formGrid}>
                  {/* Sets */}
                  <div style={s.fieldGroup}>
                    <label style={s.fieldLabel}>Sets</label>
                    <div style={s.stepper}>
                      <button style={s.stepBtn} onClick={() => setSets(Math.max(1, sets - 1))}>−</button>
                      <span style={s.stepVal}>{sets}</span>
                      <button style={s.stepBtn} onClick={() => setSets(Math.min(20, sets + 1))}>+</button>
                    </div>
                  </div>

                  {/* Reps or Duration */}
                  {isCardio ? (
                    <div style={s.fieldGroup}>
                      <label style={s.fieldLabel}>Duration (min)</label>
                      <input
                        type="number" min="1" max="300"
                        value={duration}
                        onChange={e => setDuration(e.target.value)}
                        style={s.numInput}
                        placeholder="30"
                      />
                    </div>
                  ) : (
                    <div style={s.fieldGroup}>
                      <label style={s.fieldLabel}>Reps (per set)</label>
                      <div style={s.stepper}>
                        <button style={s.stepBtn} onClick={() => setReps(Math.max(1, reps - 1))}>−</button>
                        <span style={s.stepVal}>{reps}</span>
                        <button style={s.stepBtn} onClick={() => setReps(Math.min(999, reps + 1))}>+</button>
                      </div>
                    </div>
                  )}

                  {/* Weight (optional) */}
                  <div style={s.fieldGroup}>
                    <label style={s.fieldLabel}>Weight (kg) <span style={s.optional}>optional</span></label>
                    <input
                      type="number" min="0"
                      value={weight}
                      onChange={e => setWeight(e.target.value)}
                      style={s.numInput}
                      placeholder="—"
                    />
                  </div>

                  {/* Cardio toggle */}
                  <div style={s.fieldGroup}>
                    <label style={s.fieldLabel}>Type</label>
                    <button
                      style={{ ...s.toggleBtn, ...(isCardio ? s.toggleActive : {}) }}
                      onClick={() => setIsCardio(!isCardio)}
                    >
                      {isCardio ? '🏃 Cardio/Timed' : '💪 Reps-Based'}
                    </button>
                  </div>
                </div>

                {/* Live XP Preview */}
                {preview && (
                  <div style={s.xpPreview}>
                    <div style={s.xpPreviewTitle}>XP Preview</div>
                    <div style={s.xpPreviewRow}>
                      <span style={s.xpPLabel}>Exercise ({selected.category_label})</span>
                      <span style={s.xpPVal}>+{preview.base}</span>
                    </div>
                    {!isCardio && preview.repXP > 0 && (
                      <div style={s.xpPreviewRow}>
                        <span style={s.xpPLabel}>{sets}×{reps} reps × 0.5</span>
                        <span style={s.xpPVal}>+{preview.repXP}</span>
                      </div>
                    )}
                    {preview.setBonus > 0 && (
                      <div style={s.xpPreviewRow}>
                        <span style={s.xpPLabel}>Multi-set bonus</span>
                        <span style={s.xpPVal}>+{preview.setBonus}</span>
                      </div>
                    )}
                    {isCardio && preview.durXP > 0 && (
                      <div style={s.xpPreviewRow}>
                        <span style={s.xpPLabel}>Duration bonus</span>
                        <span style={s.xpPVal}>+{preview.durXP}</span>
                      </div>
                    )}
                    <div style={s.xpPreviewTotal}>
                      <span>Subtotal</span>
                      <span style={{ color: '#F59E0B', fontWeight: 700 }}>+{preview.subtotal} XP</span>
                    </div>
                    <div style={{ fontSize: 10, color: '#555', marginTop: 4 }}>
                      Streak multiplier applied at submission
                    </div>
                  </div>
                )}

                {/* Submit */}
                <button
                  style={{ ...s.submitBtn, opacity: submitting ? 0.6 : 1 }}
                  onClick={handleSubmit}
                  disabled={submitting}
                >
                  {submitting ? 'Logging...' : `Log ${selected.name}`}
                </button>
              </div>
            )}

            {/* Today's log */}
            {todayLog.length > 0 && (
              <div style={s.todayLog}>
                <div style={s.todayTitle}>Today's Exercises</div>
                {todayLog.map((ex, i) => (
                  <div key={i} style={s.todayRow}>
                    <span style={s.todayIcon}>{CATEGORY_ICONS[ex.category] || '✅'}</span>
                    <div style={s.todayInfo}>
                      <span style={s.todayName}>{ex.exercise_name}</span>
                      <span style={s.todayDetail}>
                        {ex.sets}×{ex.reps ? ex.reps + ' reps' : (Math.round(ex.duration_seconds / 60)) + ' min'}
                        {ex.weight_kg ? ` · ${ex.weight_kg}kg` : ''}
                      </span>
                    </div>
                    <span style={s.todayXP}>+{ex.total_xp} XP</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

      </div>
    </div>
  );
}

// ── STYLES ────────────────────────────────────────────────────

const s = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'rgba(0,0,0,0.85)',
    display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
  },
  modal: {
    background: '#111', borderRadius: '20px 20px 0 0',
    width: '100%', maxWidth: 560,
    maxHeight: '92vh', overflowY: 'auto',
    padding: '24px 20px 40px',
    display: 'flex', flexDirection: 'column', gap: 16,
  },
  header: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
  },
  title: { margin: 0, fontSize: 20, fontWeight: 800, color: '#fff' },
  subtitle: { margin: '4px 0 0', fontSize: 12, color: '#555' },
  closeBtn: {
    background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: 8,
    color: '#888', fontSize: 14, cursor: 'pointer', padding: '6px 10px',
  },

  // Search
  searchWrapper: { position: 'relative' },
  searchBox: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: 'rgba(255,255,255,0.06)', borderRadius: 12,
    padding: '10px 14px', border: '1px solid rgba(255,255,255,0.08)',
  },
  searchIcon: { fontSize: 16, flexShrink: 0 },
  searchInput: {
    flex: 1, background: 'transparent', border: 'none', outline: 'none',
    color: '#fff', fontSize: 15,
  },
  clearBtn: { background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 12 },
  dropdown: {
    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
    background: '#1a1a1a', borderRadius: '0 0 12px 12px',
    border: '1px solid rgba(255,255,255,0.08)', borderTop: 'none',
    overflow: 'hidden', maxHeight: 280, overflowY: 'auto',
  },
  searching: { padding: '12px 16px', color: '#555', fontSize: 13 },
  dropdownItem: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '10px 14px', cursor: 'pointer',
    transition: 'background 0.1s',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
  },
  exIcon: { fontSize: 18, flexShrink: 0 },
  exInfo: { display: 'flex', flexDirection: 'column', flex: 1 },
  exName: { fontSize: 14, color: '#ddd', fontWeight: 600 },
  exCat: { fontSize: 11, fontWeight: 500, marginTop: 1 },
  exXP: { fontSize: 12, color: '#F59E0B', fontWeight: 700, flexShrink: 0 },

  // Selected card
  selectedCard: {
    background: 'rgba(255,255,255,0.03)', borderRadius: 14,
    border: '1px solid',
    padding: 16, display: 'flex', flexDirection: 'column', gap: 14,
  },
  selectedHeader: { display: 'flex', alignItems: 'center', gap: 10 },
  selectedName: { fontSize: 16, fontWeight: 700, color: '#fff' },
  selectedCat: { fontSize: 11, fontWeight: 600, marginTop: 2 },
  baseXPBadge: { fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 20 },

  // Form
  formGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 6 },
  fieldLabel: { fontSize: 11, color: '#666', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' },
  optional: { fontWeight: 400, color: '#444' },
  stepper: { display: 'flex', alignItems: 'center', gap: 0 },
  stepBtn: {
    background: 'rgba(255,255,255,0.08)', border: 'none', color: '#ddd',
    width: 32, height: 36, fontSize: 18, cursor: 'pointer',
    borderRadius: 8,
  },
  stepVal: { flex: 1, textAlign: 'center', color: '#fff', fontWeight: 700, fontSize: 16 },
  numInput: {
    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 8, color: '#fff', fontSize: 16, padding: '8px 12px',
    width: '100%', boxSizing: 'border-box', outline: 'none',
  },
  toggleBtn: {
    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 8, color: '#888', fontSize: 12, padding: '8px 12px',
    cursor: 'pointer', textAlign: 'center',
  },
  toggleActive: { background: 'rgba(239,68,68,0.12)', borderColor: '#EF444444', color: '#EF4444' },

  // XP Preview
  xpPreview: {
    background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.15)',
    borderRadius: 10, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 4,
  },
  xpPreviewTitle: { fontSize: 10, color: '#F59E0B', fontWeight: 700, letterSpacing: '0.06em', marginBottom: 4, textTransform: 'uppercase' },
  xpPreviewRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  xpPLabel: { fontSize: 12, color: '#888' },
  xpPVal: { fontSize: 12, color: '#ddd', fontWeight: 600 },
  xpPreviewTotal: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    borderTop: '1px solid rgba(245,158,11,0.15)', paddingTop: 6, marginTop: 4,
    fontSize: 13, color: '#888', fontWeight: 600,
  },

  // Submit
  submitBtn: {
    background: '#F59E0B', border: 'none', borderRadius: 12,
    color: '#000', fontWeight: 800, fontSize: 16,
    padding: '14px', cursor: 'pointer', width: '100%',
    transition: 'opacity 0.2s',
  },

  // Today's log
  todayLog: {
    background: 'rgba(255,255,255,0.02)', borderRadius: 12,
    padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 2,
  },
  todayTitle: { fontSize: 11, color: '#555', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 },
  todayRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' },
  todayIcon: { fontSize: 15, flexShrink: 0 },
  todayInfo: { flex: 1, display: 'flex', flexDirection: 'column' },
  todayName: { fontSize: 13, color: '#ccc', fontWeight: 600 },
  todayDetail: { fontSize: 11, color: '#555' },
  todayXP: { fontSize: 12, color: '#F59E0B', fontWeight: 700 },

  // Success
  successPanel: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
    padding: '10px 0',
  },
  successIcon: { fontSize: 48, lineHeight: 1 },
  successTitle: { fontSize: 22, fontWeight: 800, color: '#fff' },
  xpCard: {
    background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
    borderRadius: 14, padding: '14px 18px', width: '100%',
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  xpRow: { display: 'flex', justifyContent: 'space-between' },
  xpLabel: { fontSize: 13, color: '#888' },
  xpVal: { fontSize: 13, color: '#ddd', fontWeight: 600 },
  xpTotal: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    borderTop: '1px solid rgba(245,158,11,0.2)', paddingTop: 10, marginTop: 4,
    fontSize: 14, color: '#aaa', fontWeight: 600,
  },
  achievementsPanel: {
    background: 'rgba(255,215,0,0.06)', border: '1px solid rgba(255,215,0,0.15)',
    borderRadius: 14, padding: '14px 18px', width: '100%',
  },
  achievementsTitle: { fontSize: 13, fontWeight: 700, color: '#FFD700', marginBottom: 10 },
  achievementRow: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 },
  achievementIcon: { fontSize: 28 },
  achievementName: { fontSize: 14, fontWeight: 700, color: '#fff' },
  achievementXP: { fontSize: 12, color: '#F59E0B' },
  successActions: { display: 'flex', gap: 10, width: '100%' },
  logAnotherBtn: {
    flex: 1, background: 'rgba(255,255,255,0.06)', border: 'none', borderRadius: 12,
    color: '#ddd', fontWeight: 700, fontSize: 15, padding: 14, cursor: 'pointer',
  },
  doneBtn: {
    flex: 1, background: '#F59E0B', border: 'none', borderRadius: 12,
    color: '#000', fontWeight: 800, fontSize: 15, padding: 14, cursor: 'pointer',
  },
};
