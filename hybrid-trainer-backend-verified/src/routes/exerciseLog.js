// routes/exerciseLog.js
// Add to server.js: const exerciseLogRoutes = require('./routes/exerciseLog');
//                   app.use('/api/exercises', exerciseLogRoutes);

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ============================================================
// XP TABLE — base XP by exercise category
// These values are designed so the bar fills at a realistic pace
// ============================================================
const EXERCISE_XP = {
  // Compound full-body (most rewarded — hardest, most effective)
  compound_full:  { base: 18, label: 'Full Body Compound' },   // Deadlift, squat, clean, thruster
  // Upper body compound
  compound_upper: { base: 14, label: 'Upper Compound' },        // Bench, rows, pull-ups, dips, OHP
  // Lower body compound
  compound_lower: { base: 14, label: 'Lower Compound' },        // Lunges, leg press, hip thrust, RDL
  // Core
  core:           { base: 9,  label: 'Core' },                  // Planks, crunches, v-ups, russian twists, mountain climbers
  // Cardio
  cardio:         { base: 11, label: 'Cardio' },                // Running, cycling, rowing, jump rope
  // Isolation
  isolation:      { base: 7,  label: 'Isolation' },             // Curls, tricep ext, lateral raises, calf raises
  // Mobility / flexibility
  mobility:       { base: 5,  label: 'Mobility' },              // Stretching, yoga, foam roll
  // HIIT / circuit
  hiit:           { base: 16, label: 'HIIT / Circuit' },        // Burpees, box jumps, battle ropes
  // Default fallback
  general:        { base: 8,  label: 'General' }
};

// wger category ID → our category mapping
// wger categories: 8=Arms, 9=Legs, 10=Abs, 11=Chest, 12=Back, 13=Shoulders, 14=Calves
const WGER_CATEGORY_MAP = {
  '8':  'isolation',       // Arms
  '9':  'compound_lower',  // Legs
  '10': 'core',            // Abs
  '11': 'compound_upper',  // Chest
  '12': 'compound_upper',  // Back
  '13': 'compound_upper',  // Shoulders
  '14': 'isolation',       // Calves
};

// Keywords to detect compound/HIIT/cardio from exercise names
const KEYWORD_OVERRIDES = {
  compound_full:  ['deadlift','squat','clean','snatch','thruster','kettlebell swing','farmer','turkish get'],
  compound_upper: ['bench press','pull-up','pullup','chin-up','chinup','row','overhead press','ohp','dip','push-up variation'],
  compound_lower: ['lunge','leg press','hip thrust','rdl','romanian','step up','goblet'],
  core:           ['plank','crunch','sit-up','situp','russian twist','v-up','mountain climber','leg raise','hollow','bicycle','ab '],
  hiit:           ['burpee','box jump','battle rope','jump squat','jumping jack','high knee','sprint','hiit'],
  cardio:         ['run','cycle','cycling','bike','row machine','elliptical','treadmill','swim','jump rope','stair'],
  mobility:       ['stretch','yoga','foam roll','mobility','flexibility','dynamic warm'],
  isolation:      ['curl','extension','raise','fly','flye','kickback','pulldown','pushdown']
};

function classifyExercise(name, wger_category_id) {
  const nameLower = name.toLowerCase();

  // Check keyword overrides first (more accurate than wger category)
  for (const [category, keywords] of Object.entries(KEYWORD_OVERRIDES)) {
    if (keywords.some(kw => nameLower.includes(kw))) {
      return category;
    }
  }

  // Fall back to wger category
  if (wger_category_id && WGER_CATEGORY_MAP[String(wger_category_id)]) {
    return WGER_CATEGORY_MAP[String(wger_category_id)];
  }

  return 'general';
}

function calculateXP(exercise_name, category, reps, sets, duration_seconds) {
  const xp_config = EXERCISE_XP[category] || EXERCISE_XP.general;
  const base_xp = xp_config.base;

  // Rep XP: 0.5 per rep (as spec'd)
  const rep_xp = (reps || 0) * 0.5;

  // Set bonus: each additional set beyond 1 adds 30% of base
  const set_bonus = sets > 1 ? Math.round(base_xp * 0.3 * (sets - 1)) : 0;

  // Duration bonus for cardio (1 XP per 30 seconds, capped at 60 XP)
  const duration_xp = duration_seconds ? Math.min(60, Math.floor(duration_seconds / 30)) : 0;

  const subtotal = base_xp + Math.round(rep_xp) + set_bonus + duration_xp;

  return {
    base_xp,
    rep_xp: Math.round(rep_xp * 10) / 10,
    set_bonus,
    duration_xp,
    subtotal,
    category,
    category_label: xp_config.label
  };
}

// ============================================================
// SEARCH EXERCISES (via wger API — 10,000+ exercises)
// GET /api/exercises/search?q=pushup&limit=10
// ============================================================
router.get('/search', async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;
    if (!q || q.length < 2) return res.json({ results: [] });

    // Search wger's exercise database (free, no API key needed for basic search)
    const url = `https://wger.de/api/v2/exercise/search/?term=${encodeURIComponent(q)}&language=english&format=json`;
    const response = await fetch(url);
    const data = await response.json();

    const suggestions = (data.suggestions || []).slice(0, Number(limit)).map(item => {
      const category = classifyExercise(item.value, item.data?.category);
      const xp_config = EXERCISE_XP[category];
      return {
        id: item.data?.id,
        name: item.value,
        category,
        category_label: xp_config.label,
        base_xp: xp_config.base,
        muscles: item.data?.muscles || [],
        wger_category: item.data?.category
      };
    });

    res.json({ results: suggestions });
  } catch (err) {
    console.error('Exercise search error:', err);
    // Fallback: return common exercises if wger is down
    res.json({ results: FALLBACK_EXERCISES.filter(e =>
      e.name.toLowerCase().includes(req.query.q?.toLowerCase() || '')
    ).slice(0, 10) });
  }
});

// ============================================================
// LOG AN EXERCISE
// POST /api/exercises/log
// ============================================================
router.post('/log', async (req, res) => {
  try {
    const {
      user_id,
      exercise_name,
      exercise_id_external,
      wger_category,
      sets = 1,
      reps,
      duration_seconds,
      weight_kg
    } = req.body;

    if (!user_id || !exercise_name) {
      return res.status(400).json({ error: 'user_id and exercise_name required' });
    }

    // Classify and calculate XP
    const category = classifyExercise(exercise_name, wger_category);
    const xp_breakdown = calculateXP(exercise_name, category, reps, sets, duration_seconds);

    // Get active program for streak multiplier
    const { data: program } = await supabase
      .from('fitness_programs')
      .select('id')
      .eq('user_id', user_id)
      .eq('status', 'active')
      .single();

    // Get streak multiplier
    const streakMultiplier = await getStreakMultiplier(user_id);
    const total_xp = Math.round(xp_breakdown.subtotal * streakMultiplier);

    // Log the exercise
    const { data: logged, error } = await supabase
      .from('custom_exercise_log')
      .insert({
        user_id,
        program_id: program?.id || null,
        exercise_name,
        exercise_id_external,
        category,
        muscle_group: null,
        sets,
        reps: reps || null,
        duration_seconds: duration_seconds || null,
        weight_kg: weight_kg || null,
        base_xp: xp_breakdown.base_xp,
        rep_xp: xp_breakdown.rep_xp,
        set_bonus: xp_breakdown.set_bonus,
        streak_multiplier: streakMultiplier,
        total_xp,
        session_date: new Date().toISOString().split('T')[0]
      })
      .select()
      .single();

    if (error) throw error;

    // Award XP to fitness progress
    if (program) {
      await supabase.from('fitness_xp_log').insert({
        user_id,
        program_id: program.id,
        source: 'custom_exercise',
        xp_amount: total_xp,
        description: `${exercise_name} — ${sets}×${reps || duration_seconds + 's'}`,
        source_ref_id: logged.id
      });

      // Update program XP total
      await supabase.rpc('increment_program_xp', { p_user_id: user_id, p_xp: total_xp });
    }

    // Check achievements
    const achievements = await checkExerciseAchievements(user_id, { reps, program });

    res.json({
      success: true,
      exercise: logged,
      xp_breakdown: { ...xp_breakdown, streak_multiplier: streakMultiplier, total_xp },
      achievements
    });
  } catch (err) {
    console.error('Log exercise error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET USER'S EXERCISE LOG
// GET /api/exercises/history/:user_id?date=2025-01-15&limit=20
// ============================================================
router.get('/history/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    const { date, limit = 20 } = req.query;

    let query = supabase
      .from('custom_exercise_log')
      .select('*')
      .eq('user_id', user_id)
      .order('logged_at', { ascending: false })
      .limit(Number(limit));

    if (date) query = query.eq('session_date', date);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ exercises: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET EXERCISE STATS SUMMARY
// GET /api/exercises/stats/:user_id
// ============================================================
router.get('/stats/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    const { data } = await supabase
      .from('custom_exercise_log')
      .select('reps, total_xp, category, exercise_name, session_date')
      .eq('user_id', user_id);

    if (!data) return res.json({ stats: {} });

    const total_reps = data.reduce((s, r) => s + (r.reps || 0), 0);
    const total_xp = data.reduce((s, r) => s + r.total_xp, 0);
    const unique_exercises = new Set(data.map(r => r.exercise_name.toLowerCase())).size;
    const unique_days = new Set(data.map(r => r.session_date)).size;
    const by_category = data.reduce((acc, r) => {
      acc[r.category] = (acc[r.category] || 0) + 1;
      return acc;
    }, {});

    res.json({ stats: { total_reps, total_xp, total_sessions: data.length, unique_exercises, unique_days, by_category } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// HELPERS
// ============================================================
async function getStreakMultiplier(user_id) {
  try {
    const { data } = await supabase
      .from('fitness_xp_log')
      .select('earned_at')
      .eq('user_id', user_id)
      .order('earned_at', { ascending: false })
      .limit(60);
    if (!data || !data.length) return 1.0;
    const days = [...new Set(data.map(r => r.earned_at.split('T')[0]))].sort().reverse();
    let streak = 0;
    let check = new Date();
    for (const day of days) {
      const diff = Math.floor((check - new Date(day)) / 864e5);
      if (diff <= 1) { streak++; check = new Date(day); }
      else break;
    }
    return Math.round((1.0 + Math.min(0.5, streak * 0.05)) * 100) / 100;
  } catch { return 1.0; }
}

async function checkExerciseAchievements(user_id, context) {
  const unlocked = [];
  const checks = [
    {
      key: 'first_custom_exercise',
      name: 'Custom Warrior',
      desc: 'Log your first custom exercise',
      icon: '🏋️',
      xp: 50,
      check: async () => {
        const { count } = await supabase.from('custom_exercise_log').select('*', { count: 'exact', head: true }).eq('user_id', user_id);
        return count === 1;
      }
    }
  ];

  for (const ach of checks) {
    const { data: existing } = await supabase.from('fitness_achievements').select('id').eq('user_id', user_id).eq('achievement_key', ach.key).single();
    if (existing) continue;
    const earned = await ach.check();
    if (earned) {
      await supabase.from('fitness_achievements').insert({ user_id, achievement_key: ach.key, achievement_name: ach.name, description: ach.desc, icon: ach.icon, xp_reward: ach.xp });
      unlocked.push({ key: ach.key, name: ach.name, icon: ach.icon, xp: ach.xp });
    }
  }
  return unlocked;
}

// Common exercises fallback (used if wger API is unreachable)
const FALLBACK_EXERCISES = [
  { name: 'Push-Up', category: 'compound_upper', base_xp: 14, category_label: 'Upper Compound' },
  { name: 'Pull-Up', category: 'compound_upper', base_xp: 14, category_label: 'Upper Compound' },
  { name: 'Squat', category: 'compound_full', base_xp: 18, category_label: 'Full Body Compound' },
  { name: 'Deadlift', category: 'compound_full', base_xp: 18, category_label: 'Full Body Compound' },
  { name: 'Burpee', category: 'hiit', base_xp: 16, category_label: 'HIIT / Circuit' },
  { name: 'Plank', category: 'core', base_xp: 9, category_label: 'Core' },
  { name: 'Russian Twist', category: 'core', base_xp: 9, category_label: 'Core' },
  { name: 'V-Up', category: 'core', base_xp: 9, category_label: 'Core' },
  { name: 'Mountain Climber', category: 'hiit', base_xp: 16, category_label: 'HIIT / Circuit' },
  { name: 'Lunge', category: 'compound_lower', base_xp: 14, category_label: 'Lower Compound' },
  { name: 'Bicep Curl', category: 'isolation', base_xp: 7, category_label: 'Isolation' },
  { name: 'Tricep Extension', category: 'isolation', base_xp: 7, category_label: 'Isolation' },
  { name: 'Lateral Raise', category: 'isolation', base_xp: 7, category_label: 'Isolation' },
  { name: 'Jumping Jack', category: 'cardio', base_xp: 11, category_label: 'Cardio' },
  { name: 'Box Jump', category: 'hiit', base_xp: 16, category_label: 'HIIT / Circuit' },
  { name: 'Hip Thrust', category: 'compound_lower', base_xp: 14, category_label: 'Lower Compound' },
  { name: 'Romanian Deadlift', category: 'compound_lower', base_xp: 14, category_label: 'Lower Compound' },
  { name: 'Dumbbell Row', category: 'compound_upper', base_xp: 14, category_label: 'Upper Compound' },
  { name: 'Leg Raise', category: 'core', base_xp: 9, category_label: 'Core' },
  { name: 'Calf Raise', category: 'isolation', base_xp: 7, category_label: 'Isolation' },
  { name: 'Dip', category: 'compound_upper', base_xp: 14, category_label: 'Upper Compound' },
  { name: 'Hollow Body Hold', category: 'core', base_xp: 9, category_label: 'Core' },
  { name: 'Kettlebell Swing', category: 'compound_full', base_xp: 18, category_label: 'Full Body Compound' },
  { name: 'Step-Up', category: 'compound_lower', base_xp: 14, category_label: 'Lower Compound' },
  { name: 'Bicycle Crunch', category: 'core', base_xp: 9, category_label: 'Core' },
];

module.exports = router;
