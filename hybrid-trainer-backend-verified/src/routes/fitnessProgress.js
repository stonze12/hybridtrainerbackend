// routes/fitnessProgress.js
// Add to server.js: const fitnessProgressRoutes = require('./routes/fitnessProgress');
//                   app.use('/api/fitness', fitnessProgressRoutes);

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ============================================================
// PROGRAM CONFIGURATION
// ============================================================

const PROGRAM_CONFIG = {
  weight_loss: {
    label: 'Weight Loss',
    color: '#3B82F6',
    baseline_weeks: 20,
    min_weeks: 12,
    // XP per week at baseline effort (3-4 workouts, solid nutrition, 7-day streak)
    xp_per_week_baseline: 900,
    // How to calculate personalized weeks based on user data
    weeks_formula: (profile) => {
      const lbs_to_lose = Math.max(0, (profile.starting_weight - profile.target_weight) * 2.205);
      if (lbs_to_lose <= 0) return 12;
      // Safe loss: 1.0 lb/week average (conservative, realistic)
      const calculated = Math.ceil(lbs_to_lose / 1.0);
      return Math.max(12, Math.min(52, calculated));
    }
  },
  build_muscle: {
    label: 'Build Muscle',
    color: '#F59E0B',
    baseline_weeks: 30,
    min_weeks: 16,
    xp_per_week_baseline: 900,
    weeks_formula: (profile) => {
      // Muscle gain: beginners ~1-2 lbs/month, intermediates ~0.5-1 lb/month
      const lbs_to_gain = Math.max(0, (profile.target_weight - profile.starting_weight) * 2.205);
      if (lbs_to_gain <= 0) return 24;
      const age_factor = profile.age > 35 ? 1.25 : 1.0;
      const calculated = Math.ceil((lbs_to_gain / 1.5) * 4 * age_factor); // weeks
      return Math.max(16, Math.min(52, calculated));
    }
  },
  maintain: {
    label: 'Maintain & Tone',
    color: '#10B981',
    baseline_weeks: 12,
    min_weeks: 8,
    xp_per_week_baseline: 750,
    weeks_formula: () => 12
  },
  athletic: {
    label: 'Athletic Performance',
    color: '#8B5CF6',
    baseline_weeks: 24,
    min_weeks: 12,
    xp_per_week_baseline: 1050, // Higher baseline — more training required
    weeks_formula: (profile) => {
      const age_factor = profile.age > 30 ? 1.15 : 1.0;
      return Math.round(24 * age_factor);
    }
  },
  cut: {
    label: 'Cut & Shred',
    color: '#EF4444',
    baseline_weeks: 16,
    min_weeks: 10,
    xp_per_week_baseline: 1000,
    weeks_formula: (profile) => {
      const lbs_to_lose = Math.max(0, (profile.starting_weight - profile.target_weight) * 2.205);
      if (lbs_to_lose <= 0) return 12;
      const calculated = Math.ceil(lbs_to_lose / 1.5); // Cuts are faster but harder
      return Math.max(10, Math.min(30, calculated));
    }
  }
};

// ============================================================
// ENROLL IN A PROGRAM
// POST /api/fitness/enroll
// ============================================================
router.post('/enroll', async (req, res) => {
  try {
    const { user_id, program_type, starting_weight, target_weight, age, height_cm, activity_level } = req.body;

    if (!PROGRAM_CONFIG[program_type]) {
      return res.status(400).json({ error: 'Invalid program type' });
    }

    const config = PROGRAM_CONFIG[program_type];
    const profile = { starting_weight, target_weight, age, height_cm, activity_level };

    const baseline_weeks = config.weeks_formula(profile);
    const min_weeks = config.min_weeks;
    const total_xp_required = baseline_weeks * config.xp_per_week_baseline;

    // Deactivate any current active program
    await supabase
      .from('fitness_programs')
      .update({ status: 'paused', updated_at: new Date().toISOString() })
      .eq('user_id', user_id)
      .eq('status', 'active');

    const { data, error } = await supabase
      .from('fitness_programs')
      .insert({
        user_id,
        program_type,
        starting_weight,
        target_weight,
        age,
        height_cm,
        activity_level,
        baseline_weeks,
        min_weeks,
        total_xp_required,
        adjusted_weeks_remaining: baseline_weeks,
        status: 'active',
        start_date: new Date().toISOString().split('T')[0]
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, program: data, config });
  } catch (err) {
    console.error('Enroll error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET ACTIVE PROGRAM + PROGRESS
// GET /api/fitness/progress/:user_id
// ============================================================
router.get('/progress/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;

    const { data: program, error } = await supabase
      .from('fitness_programs')
      .select('*')
      .eq('user_id', user_id)
      .eq('status', 'active')
      .single();

    if (error || !program) {
      return res.json({ program: null });
    }

    const config = PROGRAM_CONFIG[program.program_type];
    const progress_pct = Math.min(100, (program.current_xp / program.total_xp_required) * 100);

    // Calculate weeks elapsed
    const start = new Date(program.start_date);
    const now = new Date();
    const weeks_elapsed = Math.floor((now - start) / (7 * 24 * 60 * 60 * 1000));

    // Get last 2 weeks of XP for pace calculation
    const two_weeks_ago = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recent_xp } = await supabase
      .from('fitness_xp_log')
      .select('xp_amount, earned_at')
      .eq('user_id', user_id)
      .eq('program_id', program.id)
      .gte('earned_at', two_weeks_ago);

    const recent_total = (recent_xp || []).reduce((sum, row) => sum + row.xp_amount, 0);
    const xp_per_week_recent = recent_total / 2; // average over 2 weeks

    // Dynamic time estimate
    const xp_remaining = program.total_xp_required - program.current_xp;
    let weeks_remaining;
    if (xp_per_week_recent > 0) {
      weeks_remaining = Math.ceil(xp_remaining / xp_per_week_recent);
    } else {
      weeks_remaining = program.adjusted_weeks_remaining;
    }

    // Enforce biological minimum
    const weeks_since_start = (Date.now() - new Date(program.start_date)) / (7 * 24 * 60 * 60 * 1000);
    const min_weeks_remaining = Math.max(0, program.min_weeks - weeks_since_start);
    weeks_remaining = Math.max(weeks_remaining, min_weeks_remaining);

    // Est completion date
    const est_completion = new Date();
    est_completion.setDate(est_completion.getDate() + (weeks_remaining * 7));

    res.json({
      program: {
        ...program,
        config,
        progress_pct: Math.round(progress_pct * 10) / 10,
        weeks_elapsed,
        weeks_remaining: Math.round(weeks_remaining * 10) / 10,
        est_completion_date: est_completion.toISOString().split('T')[0],
        xp_per_week_recent: Math.round(xp_per_week_recent),
        xp_per_week_baseline: config.xp_per_week_baseline,
        pace_ratio: xp_per_week_recent > 0 ? (xp_per_week_recent / config.xp_per_week_baseline) : null
      }
    });
  } catch (err) {
    console.error('Progress error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// AWARD XP (called internally from other routes)
// POST /api/fitness/award-xp
// ============================================================
router.post('/award-xp', async (req, res) => {
  try {
    const { user_id, source, xp_amount, description, source_ref_id } = req.body;

    // Get active program
    const { data: program } = await supabase
      .from('fitness_programs')
      .select('id, current_xp, total_xp_required, status')
      .eq('user_id', user_id)
      .eq('status', 'active')
      .single();

    if (!program) return res.json({ success: true, no_program: true });

    // Get current streak for multiplier
    const streakMultiplier = await getStreakMultiplier(user_id);
    const final_xp = Math.round(xp_amount * streakMultiplier);

    // Log the XP
    await supabase.from('fitness_xp_log').insert({
      user_id,
      program_id: program.id,
      source,
      xp_amount: final_xp,
      description,
      source_ref_id
    });

    // Update program total
    const new_xp = program.current_xp + final_xp;
    await supabase
      .from('fitness_programs')
      .update({ current_xp: new_xp, updated_at: new Date().toISOString() })
      .eq('id', program.id);

    // Check if program complete
    if (new_xp >= program.total_xp_required) {
      await supabase
        .from('fitness_programs')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', program.id);
    }

    // Check achievements
    const achievements = await checkFitnessAchievements(user_id, { source, xp_amount: final_xp, program_xp: new_xp, total_required: program.total_xp_required });

    res.json({ success: true, xp_awarded: final_xp, streak_multiplier: streakMultiplier, achievements });
  } catch (err) {
    console.error('Award XP error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// NUTRITION XP (call this when user logs a nutrition day)
// POST /api/fitness/nutrition-xp
// ============================================================
router.post('/nutrition-xp', async (req, res) => {
  try {
    const { user_id, quality_score, macros_hit, calories_in_range } = req.body;
    const today = new Date().toISOString().split('T')[0];

    // Check if already scored today
    const { data: existing } = await supabase
      .from('daily_nutrition_score')
      .select('id')
      .eq('user_id', user_id)
      .eq('score_date', today)
      .single();

    if (existing) {
      return res.json({ success: true, message: 'Already scored today' });
    }

    // XP: quality_score is 0-100, maps to 0-50 XP
    // Bonus: +10 if macros hit, +10 if calories in range
    let xp = Math.round((quality_score / 100) * 30);
    if (macros_hit) xp += 10;
    if (calories_in_range) xp += 10;

    await supabase.from('daily_nutrition_score').insert({
      user_id, quality_score, xp_awarded: xp,
      macros_hit, calories_in_range, score_date: today
    });

    // Award XP to program
    const awardRes = await fetch(`${req.protocol}://${req.get('host')}/api/fitness/award-xp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id, source: 'nutrition_day', xp_amount: xp, description: `Nutrition score: ${quality_score}/100` })
    });

    res.json({ success: true, xp_awarded: xp });
  } catch (err) {
    console.error('Nutrition XP error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// HELPERS
// ============================================================

async function getStreakMultiplier(user_id) {
  try {
    // Count consecutive days with any XP earned (workout or nutrition)
    const { data } = await supabase
      .from('fitness_xp_log')
      .select('earned_at')
      .eq('user_id', user_id)
      .order('earned_at', { ascending: false })
      .limit(90);

    if (!data || data.length === 0) return 1.0;

    const days = [...new Set(data.map(r => r.earned_at.split('T')[0]))].sort().reverse();
    let streak = 0;
    let checkDate = new Date();

    for (const day of days) {
      const d = new Date(day);
      const diff = Math.floor((checkDate - d) / (24 * 60 * 60 * 1000));
      if (diff <= 1) { streak++; checkDate = d; }
      else break;
    }

    // +5% per streak day, capped at +50% (11 days = max)
    const bonus = Math.min(0.5, streak * 0.05);
    return 1.0 + bonus;
  } catch { return 1.0; }
}

async function checkFitnessAchievements(user_id, context) {
  const unlocked = [];

  const ACHIEVEMENTS = [
    { key: 'workout_streak_7',    check: async () => await checkStreak(user_id, 7),   name: 'Iron Will',         desc: '7-day activity streak',          icon: '🔥', xp: 200  },
    { key: 'workout_streak_30',   check: async () => await checkStreak(user_id, 30),  name: 'Unstoppable',       desc: '30-day activity streak',         icon: '⚡', xp: 1000 },
    { key: 'total_reps_1000',     check: async () => await checkTotalReps(user_id, 1000),   name: 'Rep Grinder',  desc: '1,000 total reps logged',        icon: '💪', xp: 100  },
    { key: 'total_reps_10000',    check: async () => await checkTotalReps(user_id, 10000),  name: 'Volume Beast', desc: '10,000 total reps logged',       icon: '🦁', xp: 500  },
    { key: 'total_reps_50000',    check: async () => await checkTotalReps(user_id, 50000),  name: 'Rep Legend',   desc: '50,000 total reps logged',       icon: '👑', xp: 2000 },
    { key: 'unique_exercises_10', check: async () => await checkUniqueExercises(user_id, 10),  name: 'Well Rounded',    desc: '10 different exercises logged', icon: '🔄', xp: 75  },
    { key: 'unique_exercises_50', check: async () => await checkUniqueExercises(user_id, 50),  name: 'Exercise Explorer', desc: '50 different exercises logged', icon: '🗺️', xp: 300 },
    { key: 'program_25_percent',  check: () => context.total_required > 0 && (context.program_xp / context.total_required) >= 0.25, name: 'First Steps',   desc: '25% program completion',  icon: '🌱', xp: 250  },
    { key: 'program_50_percent',  check: () => context.total_required > 0 && (context.program_xp / context.total_required) >= 0.50, name: 'Halfway There', desc: '50% program completion',  icon: '🏃', xp: 500  },
    { key: 'program_75_percent',  check: () => context.total_required > 0 && (context.program_xp / context.total_required) >= 0.75, name: 'Almost There',  desc: '75% program completion',  icon: '⭐', xp: 750  },
    { key: 'program_complete',    check: () => context.total_required > 0 && context.program_xp >= context.total_required,           name: 'Transformed',   desc: 'Program complete',        icon: '🏆', xp: 2000 },
    { key: 'nutrition_streak_7',  check: async () => await checkNutritionStreak(user_id, 7),  name: 'Clean Fueled',     desc: '7-day nutrition streak',  icon: '🥗', xp: 150 },
    { key: 'nutrition_streak_14', check: async () => await checkNutritionStreak(user_id, 14), name: 'Discipline Engine', desc: '14-day nutrition streak', icon: '🎯', xp: 400 },
    { key: 'perfect_week',        check: async () => await checkPerfectWeek(user_id), name: 'Perfect Week', desc: 'Workout + nutrition goals hit all week', icon: '✅', xp: 400 },
    { key: 'double_session',      check: async () => await checkDoubleSession(user_id), name: 'Two-A-Day', desc: 'Two workouts logged in one day', icon: '🌓', xp: 100 },
  ];

  for (const ach of ACHIEVEMENTS) {
    // Skip if already unlocked
    const { data: existing } = await supabase
      .from('fitness_achievements')
      .select('id')
      .eq('user_id', user_id)
      .eq('achievement_key', ach.key)
      .single();
    if (existing) continue;

    const earned = typeof ach.check === 'function' ? await ach.check() : ach.check;
    if (earned) {
      await supabase.from('fitness_achievements').insert({
        user_id, achievement_key: ach.key, achievement_name: ach.name,
        description: ach.desc, icon: ach.icon, xp_reward: ach.xp
      });
      // Award the XP bonus for unlocking
      if (ach.xp > 0) {
        await supabase.from('fitness_xp_log').insert({
          user_id, source: 'achievement', xp_amount: ach.xp,
          description: `Achievement: ${ach.name}`
        });
      }
      unlocked.push({ key: ach.key, name: ach.name, icon: ach.icon, xp: ach.xp });
    }
  }

  return unlocked;
}

async function checkStreak(user_id, required) {
  const { data } = await supabase
    .from('fitness_xp_log')
    .select('earned_at')
    .eq('user_id', user_id)
    .order('earned_at', { ascending: false })
    .limit(required * 2);
  if (!data) return false;
  const days = [...new Set(data.map(r => r.earned_at.split('T')[0]))].sort().reverse();
  let streak = 0;
  let checkDate = new Date();
  for (const day of days) {
    const diff = Math.floor((checkDate - new Date(day)) / (24 * 60 * 60 * 1000));
    if (diff <= 1) { streak++; checkDate = new Date(day); }
    else break;
  }
  return streak >= required;
}

async function checkTotalReps(user_id, required) {
  const { data } = await supabase
    .from('custom_exercise_log')
    .select('reps')
    .eq('user_id', user_id);
  const total = (data || []).reduce((s, r) => s + (r.reps || 0), 0);
  return total >= required;
}

async function checkUniqueExercises(user_id, required) {
  const { data } = await supabase
    .from('custom_exercise_log')
    .select('exercise_name')
    .eq('user_id', user_id);
  const unique = new Set((data || []).map(r => r.exercise_name.toLowerCase()));
  return unique.size >= required;
}

async function checkNutritionStreak(user_id, required) {
  const { data } = await supabase
    .from('daily_nutrition_score')
    .select('score_date')
    .eq('user_id', user_id)
    .order('score_date', { ascending: false })
    .limit(required + 5);
  if (!data || data.length < required) return false;
  let streak = 0;
  let checkDate = new Date();
  for (const row of data) {
    const diff = Math.floor((checkDate - new Date(row.score_date)) / (24 * 60 * 60 * 1000));
    if (diff <= 1) { streak++; checkDate = new Date(row.score_date); }
    else break;
  }
  return streak >= required;
}

async function checkPerfectWeek(user_id) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: workouts } = await supabase
    .from('fitness_xp_log')
    .select('earned_at')
    .eq('user_id', user_id)
    .in('source', ['workout_session', 'custom_exercise'])
    .gte('earned_at', weekAgo);
  const { data: nutrition } = await supabase
    .from('daily_nutrition_score')
    .select('score_date, quality_score')
    .eq('user_id', user_id)
    .gte('score_date', weekAgo.split('T')[0]);
  const workout_days = new Set((workouts || []).map(r => r.earned_at.split('T')[0])).size;
  const good_nutrition_days = (nutrition || []).filter(r => r.quality_score >= 70).length;
  return workout_days >= 4 && good_nutrition_days >= 5;
}

async function checkDoubleSession(user_id) {
  const { data } = await supabase
    .from('fitness_xp_log')
    .select('earned_at')
    .eq('user_id', user_id)
    .in('source', ['workout_session', 'custom_exercise']);
  if (!data) return false;
  const byDay = {};
  data.forEach(r => {
    const day = r.earned_at.split('T')[0];
    byDay[day] = (byDay[day] || 0) + 1;
  });
  return Object.values(byDay).some(count => count >= 2);
}

module.exports = router;
