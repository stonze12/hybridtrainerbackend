// components/FitnessProgressBar.jsx
// Drop this component into your Fuel tab next to "Nutrition"
// and into your Workout tab next to "Program"
//
// Usage:
//   <FitnessProgressBar userId={currentUser.id} />

import { useState, useEffect } from 'react';

const API_BASE = process.env.REACT_APP_API_URL || 'https://your-api.onrender.com';

const PROGRAM_COLORS = {
  weight_loss:   { bar: '#3B82F6', bg: 'rgba(59,130,246,0.12)', text: '#3B82F6', glow: '0 0 10px rgba(59,130,246,0.4)' },
  build_muscle:  { bar: '#F59E0B', bg: 'rgba(245,158,11,0.12)',  text: '#F59E0B', glow: '0 0 10px rgba(245,158,11,0.4)' },
  maintain:      { bar: '#10B981', bg: 'rgba(16,185,129,0.12)',  text: '#10B981', glow: '0 0 10px rgba(16,185,129,0.4)' },
  athletic:      { bar: '#8B5CF6', bg: 'rgba(139,92,246,0.12)',  text: '#8B5CF6', glow: '0 0 10px rgba(139,92,246,0.4)' },
  cut:           { bar: '#EF4444', bg: 'rgba(239,68,68,0.12)',   text: '#EF4444', glow: '0 0 10px rgba(239,68,68,0.4)' },
};

export default function FitnessProgressBar({ userId, compact = false }) {
  const [program, setProgram] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    if (!userId) return;
    fetchProgress();
    const interval = setInterval(fetchProgress, 60000); // refresh every minute
    return () => clearInterval(interval);
  }, [userId]);

  async function fetchProgress() {
    try {
      const res = await fetch(`${API_BASE}/api/fitness/progress/${userId}`);
      const data = await res.json();
      setProgram(data.program);
    } catch (e) {
      console.error('FitnessProgressBar:', e);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div style={styles.skeleton} />
    );
  }

  if (!program) {
    return (
      <div style={styles.noProgramBadge}>
        <span style={styles.noProgramText}>No program active</span>
      </div>
    );
  }

  const colors = PROGRAM_COLORS[program.program_type] || PROGRAM_COLORS.maintain;
  const pct = Math.min(100, program.progress_pct || 0);
  const weeks_remaining = program.weeks_remaining || program.baseline_weeks;
  const est_date = program.est_completion_date
    ? new Date(program.est_completion_date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    : null;

  // Pace indicator
  const pace = program.pace_ratio;
  const paceIcon = !pace ? '—' : pace >= 1.15 ? '🔥' : pace >= 0.95 ? '✅' : pace >= 0.7 ? '⚠️' : '🐢';
  const paceLabel = !pace ? 'Calculating...' : pace >= 1.15 ? 'Ahead of pace' : pace >= 0.95 ? 'On pace' : pace >= 0.7 ? 'Below pace' : 'Behind pace';

  if (compact) {
    // ── COMPACT MODE ──────────────────────────────────────────
    // Used inline next to "Nutrition" or "Program" text
    return (
      <div style={styles.compactWrapper} onClick={() => setShowDetails(!showDetails)}>
        {/* Program badge */}
        <span style={{ ...styles.programBadge, color: colors.text, background: colors.bg }}>
          {program.config?.label || program.program_type}
        </span>

        {/* The bar */}
        <div style={styles.compactBarTrack}>
          <div
            style={{
              ...styles.compactBarFill,
              width: `${pct}%`,
              background: colors.bar,
              boxShadow: pct > 0 ? colors.glow : 'none',
            }}
          />
        </div>

        {/* Percent */}
        <span style={{ ...styles.compactPct, color: colors.text }}>{Math.round(pct)}%</span>

        {/* Time estimate */}
        <span style={styles.compactTime}>
          {Math.round(weeks_remaining)}w{est_date ? ` · ${est_date}` : ''}
        </span>
      </div>
    );
  }

  // ── FULL MODE ─────────────────────────────────────────────
  return (
    <div style={styles.fullWrapper}>
      {/* Header row: program name + pace icon */}
      <div style={styles.headerRow}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...styles.programLabel, color: colors.text }}>
            {program.config?.label || program.program_type}
          </span>
          <span style={{ fontSize: 11, color: '#888', fontWeight: 500 }}>PROGRAM</span>
        </div>
        <div style={styles.paceChip} title={paceLabel}>
          <span>{paceIcon}</span>
          <span style={{ fontSize: 11, color: '#aaa', marginLeft: 4 }}>{paceLabel}</span>
        </div>
      </div>

      {/* Progress bar */}
      <div style={styles.fullBarTrack}>
        {/* Segment markers at 25/50/75% */}
        {[25, 50, 75].map(mark => (
          <div key={mark} style={{ ...styles.segmentMark, left: `${mark}%` }} />
        ))}
        <div
          style={{
            ...styles.fullBarFill,
            width: `${pct}%`,
            background: `linear-gradient(90deg, ${colors.bar}cc, ${colors.bar})`,
            boxShadow: pct > 0 ? colors.glow : 'none',
          }}
        />
      </div>

      {/* Stats row */}
      <div style={styles.statsRow}>
        <span style={styles.statItem}>
          <span style={styles.statValue}>{Math.round(pct)}%</span>
          <span style={styles.statLabel}>complete</span>
        </span>
        <span style={styles.statDivider}>·</span>
        <span style={styles.statItem}>
          <span style={styles.statValue}>{program.current_xp?.toLocaleString()}</span>
          <span style={styles.statLabel}>XP earned</span>
        </span>
        <span style={styles.statDivider}>·</span>
        <span style={styles.statItem}>
          <span style={styles.statValue}>~{Math.round(weeks_remaining)}w</span>
          <span style={styles.statLabel}>remaining</span>
        </span>
        {est_date && (
          <>
            <span style={styles.statDivider}>·</span>
            <span style={styles.statItem}>
              <span style={styles.statValue}>{est_date}</span>
              <span style={styles.statLabel}>est. finish</span>
            </span>
          </>
        )}
      </div>

      {/* XP breakdown hint */}
      <div style={styles.xpHint}>
        <span style={{ color: '#555' }}>
          Earn XP by logging workouts, exercises, and hitting nutrition goals daily.
          Streaks multiply your XP.
        </span>
      </div>
    </div>
  );
}

// ── STYLES ────────────────────────────────────────────────────

const styles = {
  skeleton: {
    height: 8,
    width: 120,
    borderRadius: 4,
    background: 'rgba(255,255,255,0.06)',
    animation: 'pulse 1.5s infinite',
  },
  noProgramBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '2px 10px',
    borderRadius: 20,
    background: 'rgba(255,255,255,0.06)',
    cursor: 'default',
  },
  noProgramText: {
    fontSize: 11,
    color: '#666',
    fontWeight: 500,
  },

  // COMPACT
  compactWrapper: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    cursor: 'pointer',
  },
  programBadge: {
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 7px',
    borderRadius: 10,
    letterSpacing: '0.02em',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
  },
  compactBarTrack: {
    width: 80,
    height: 6,
    borderRadius: 3,
    background: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
    position: 'relative',
  },
  compactBarFill: {
    height: '100%',
    borderRadius: 3,
    transition: 'width 0.8s ease',
  },
  compactPct: {
    fontSize: 11,
    fontWeight: 700,
    minWidth: 28,
  },
  compactTime: {
    fontSize: 10,
    color: '#666',
    whiteSpace: 'nowrap',
  },

  // FULL
  fullWrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '10px 0',
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  programLabel: {
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.01em',
  },
  paceChip: {
    display: 'flex',
    alignItems: 'center',
    fontSize: 12,
  },
  fullBarTrack: {
    width: '100%',
    height: 10,
    borderRadius: 5,
    background: 'rgba(255,255,255,0.07)',
    position: 'relative',
    overflow: 'hidden',
  },
  segmentMark: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    background: 'rgba(255,255,255,0.08)',
    zIndex: 1,
  },
  fullBarFill: {
    height: '100%',
    borderRadius: 5,
    transition: 'width 1s ease',
    position: 'relative',
    zIndex: 2,
  },
  statsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  statItem: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 3,
  },
  statValue: {
    fontSize: 12,
    fontWeight: 700,
    color: '#ddd',
  },
  statLabel: {
    fontSize: 10,
    color: '#555',
    fontWeight: 500,
  },
  statDivider: {
    color: '#333',
    fontSize: 10,
  },
  xpHint: {
    fontSize: 10,
    lineHeight: 1.4,
    color: '#444',
    marginTop: 2,
  },
};
