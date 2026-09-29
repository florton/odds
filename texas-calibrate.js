// Fitting the player model to how people actually play.
//
// The constants in texas-players.js are not derivable from anything. How much
// fold equity a half-pot bet really has, how far to discount a call for the
// news that somebody bet into you, how random an unskilled player is -- these
// are empirical facts about people, and the only honest way to set them is to
// fit them so the simulated field reproduces behaviour that has been measured
// on real ones.
//
// The targets are the standard tracking statistics, because those are what
// exist for real populations:
//
//   VPIP  how often a player voluntarily puts money in before the flop
//   PFR   how often they raise before the flop
//   AF    aggression factor, bets and raises divided by calls
//   WTSD  how often they see a showdown
//
// ---------------------------------------------------------------------------
// Why this search converges when the blackjack one did not
// ---------------------------------------------------------------------------
//
// blackjack.js tried to search strategy space by grading candidates on win
// rate, and failed: the per-hand standard deviation was about 1.04 units, so
// resolving a 0.0001 edge took a billion hands and the search accepted noise
// as progress. Poker's win-rate variance is worse still.
//
// Calibration escapes that entirely, because it is not fitted to a win rate.
// It is fitted to *behaviour*, and behaviour is enormously cheaper to measure:
// VPIP over ten thousand hands has a standard error near 0.4% against a target
// of 22, while bb/100 over the same hands has a standard error near 20. Three
// orders of magnitude more signal per hand, for the same simulation.
//
// On top of that, every candidate is graded on the *same seeded deals*, which
// is the common random numbers trick from the blackjack post-mortem. Two
// parameter sets that behave identically score identically, exactly, so the
// search is comparing parameters rather than comparing luck.
//
//   node texas-calibrate.js            fit and write calibration.json
//   node texas-calibrate.js --check    report the current fit without changing it
//   node texas-calibrate.js --noise    show the noise floor of the objective
//   node texas-calibrate.js --resume [param=value ...]
//                                      continue the fit from calibration.json
//                                      without re-running stage 1, optionally
//                                      lifting a parameter off its bound first

const fs = require('fs')
const path = require('path')
const { makePlayer, archetype, ARCHETYPES, PARAMS, setParams, setArchetype, makeTracker } =
  require('./texas-players')
const { playHand, makeRng, makeDeck, shuffle } = require('./texas-engine')

const OUT_FILE = path.join(__dirname, 'calibration.json')

// ------------------------------------------------------------------ targets
//
// A table of competent regulars in a 6-max cash game. These are the figures
// such a game is normally quoted at: a solid player is "22/18", plays about
// two and a half aggressive actions per call, and sees a showdown on around a
// quarter of the hands they play. Roughly 60% of hands are folded round before
// a flop is ever dealt, which is the statistic that most obviously distinguishes
// a real game from a simulation where everybody plays.
const REG_TARGETS = {
  vpip: 22,
  pfr: 18,
  af: 2.5,
  wtsd: 26,
  endsPreflop: 60
}

// Named players in a mixed game. Real population stats vary by stake and site,
// so these are the shape of the thing rather than gospel: a nit folds almost
// everything, a station plays half of them and almost never raises, a maniac
// plays most of them and raises constantly.
// Every type carries all four statistics, not just the two preflop ones.
//
// Fitting a type on VPIP and PFR alone leaves its postflop behaviour entirely
// unconstrained, and the search will happily satisfy the two numbers it is
// graded on with a player that is absurd in every other respect -- it produced
// a "TAG" with an aggression factor of 8.5, meaning one that essentially never
// called anything. The calling station only stopped being nonsense once the
// showdown rate that actually defines a station entered its targets. What is
// not measured is not constrained.
const FIELD_TARGETS = {
  nit: { vpip: 13, pfr: 10, af: 2.2, wtsd: 24 },
  tag: { vpip: 22, pfr: 19, af: 2.6, wtsd: 26 },
  lag: { vpip: 32, pfr: 25, af: 3.2, wtsd: 29 },
  station: { vpip: 45, pfr: 6, af: 0.6, wtsd: 42 },
  maniac: { vpip: 62, pfr: 38, af: 2.4, wtsd: 36 }
}

// The starting proficiencies. The fit may move them per archetype via the
// profile's `skill` key, which overrides these once written to
// calibration.json; `fieldSkill` below resolves which of the two applies.
const FIELD_SKILL = {
  nit: 0.70, tag: 0.85, lag: 0.80, station: 0.35, maniac: 0.25
}

const fieldSkill = (kind) => ARCHETYPES[kind].skill !== undefined
  ? ARCHETYPES[kind].skill
  : FIELD_SKILL[kind]

// --------------------------------------------------------------- measuring

const runField = (players, hands, seed) => {
  const n = players.length
  const tracker = makeTracker(n)
  const rng = makeRng(seed)
  let endsPreflop = 0
  for (let d = 0; d < hands; d++) {
    const res = playHand({
      bots: players,
      stacks: new Array(n).fill(200),
      button: d % n,
      smallBlind: 1,
      bigBlind: 2,
      deck: shuffle(makeDeck(), rng)
    })
    tracker.record(res)
    for (let s = 0; s < n; s++) if (players[s].observe) players[s].observe(res, s)
    if (res.endedOn === 'preflop') endsPreflop++
  }
  const rows = tracker.summary(players.map((p) => p.name), 2)
  return { rows, endsPreflop: (endsPreflop / hands) * 100 }
}

const average = (rows, key) => {
  let sum = 0
  let n = 0
  for (const r of rows) {
    const v = r[key]
    if (isFinite(v)) {
      sum += v
      n++
    }
  }
  return n ? sum / n : 0
}

// A homogeneous table of neutral players. Every trait sits at 0.5, so every
// personality term is multiplied by zero and drops out -- which is what makes
// this stage a clean measurement of the value model alone, with the four trait
// scales unable to affect the result even in principle.
const measureRegs = (params, hands, seed, proficiency = 0.85) => {
  setParams(params)
  const rng = makeRng(1234)
  const players = []
  for (let i = 0; i < 6; i++) players.push(makePlayer('reg' + i, { proficiency, rng }))
  const { rows, endsPreflop } = runField(players, hands, seed)
  return {
    vpip: average(rows, 'vpip'),
    pfr: average(rows, 'pfr'),
    af: average(rows, 'af'),
    wtsd: average(rows, 'wtsd'),
    endsPreflop
  }
}

// A mixed table, one of each named type. Population statistics are gathered
// from mixed games, so they have to be reproduced in one.
const measureArchetypes = (params, traits, hands, seed) => {
  setParams(params)
  if (traits) {
    for (const kind of Object.keys(traits)) setArchetype(kind, traits[kind])
  }
  const rng = makeRng(4321)
  const kinds = ['nit', 'tag', 'lag', 'station', 'maniac', 'tag']
  const players = kinds.map((k, i) =>
    archetype(k, fieldSkill(k), rng, k + i))
  const { rows } = runField(players, hands, seed)
  const out = {}
  kinds.forEach((k, i) => {
    if (!out[k]) out[k] = { vpip: 0, pfr: 0, af: 0, wtsd: 0, n: 0 }
    out[k].vpip += rows[i].vpip
    out[k].pfr += rows[i].pfr
    out[k].af += isFinite(rows[i].af) ? rows[i].af : 0
    out[k].wtsd += rows[i].wtsd
    out[k].n++
  })
  for (const k of Object.keys(out)) {
    out[k].vpip /= out[k].n
    out[k].pfr /= out[k].n
    out[k].af /= out[k].n
    out[k].wtsd /= out[k].n
  }
  return out
}

// ------------------------------------------------------------- objective
//
// Relative squared error, so a statistic measured in percent and one measured
// as a bare ratio contribute comparably instead of the larger number dominating
// by virtue of being larger.
const errorAgainst = (got, targets) => {
  let total = 0
  let n = 0
  for (const key of Object.keys(targets)) {
    const want = targets[key]
    const have = got[key]
    if (!isFinite(have)) {
      total += 4
      n++
      continue
    }
    const d = (have - want) / want
    total += d * d
    n++
  }
  return total / n
}

// -------------------------------------------------------------- the search
//
// Coordinate descent: walk one parameter at a time, try it larger and smaller,
// keep any move that lowers the error, repeat. Crude, but the objective has
// only a handful of dimensions and almost no noise, which is exactly the
// regime where crude works and where the blackjack search would have worked
// too had it been measuring something this cheap.
// The trait pulls are capped well below the scale of a typical pot on purpose.
// A personality is meant to bias a decision, not replace it -- let the pull
// grow past about 0.8 and the bias exceeds every expected-value difference on
// the table, at which point the "player" simply always takes one action and
// stops being a player at all. Left uncapped the fit did exactly that, driving
// stickiness to 1.24 and turning the calling station into a bot that called
// 89% of hands.
const BOUNDS = {
  pullAggression: [0.02, 2.0],
  pullLooseness: [0.02, 3.0],
  pullStickiness: [0.02, 2.0],
  pullBluffiness: [0.02, 2.0],
  foldBase: [0.0, 0.6],
  foldSlope: [0.05, 1.5],
  stubbornness: [0.05, 0.95],
  callShadePre: [0.0, 4.0],
  callShadePost: [0.0, 0.99],
  raiseShade: [0.0, 0.99],
  temperature: [0.05, 6.0],
  temperatureCurve: [0.05, 2.0],
  pullPosition: [0.02, 1.20],
  positionPostWeight: [0.0, 1.0],
  // The 2026-09 refit pinned this at 1.2 with the calling station's WTSD still
  // half its target: the ceiling, not the stickiness trait, was what stopped
  // sticky players calling down. It needs real headroom.
  maxBias: [0.05, 2.5],
  // Made-hand overvalue, scaled by a trait's distance from neutral, so the
  // negative side lets tight types undervalue made hands and the positive
  // side reaches ~+0.29 equity at the stickiness bound of 0.98.
  handOvervalue: [-0.2, 0.6],
  futureCost: [0.0, 3.0],
  callShadePostBase: [0.0, 0.9]
}

const clampParam = (key, value) => {
  const [lo, hi] = BOUNDS[key] || [-Infinity, Infinity]
  return Math.max(lo, Math.min(hi, value))
}

const search = (start, keys, evaluate, passes, label) => {
  let best = { ...start }
  let bestErr = evaluate(best)
  let evals = 1
  console.log('  start  error ' + bestErr.toFixed(5))

  // Steps shrink toward 1 when a pass fails instead of the search stopping
  // there. Fixed-size steps stop at the first point where no single coarse
  // move helps, which is not a minimum -- it is just the resolution running
  // out. Halting on it left two parameters never moved from their defaults and
  // landed a fit measurably worse than a previous run had reached.
  let span = 0.45
  for (let pass = 0; pass < passes; pass++) {
    let improved = false
    const mults = [1 - span, 1 - span / 2, 1 + span / 2, 1 + span]
    for (const key of keys) {
      for (const mult of mults) {
        const value = clampParam(key, best[key] * mult)
        if (Math.abs(value - best[key]) < 1e-12) continue
        const candidate = { ...best, [key]: value }
        const err = evaluate(candidate)
        evals++
        if (err < bestErr - 1e-9) {
          bestErr = err
          best = candidate
          improved = true
        }
      }
    }
    console.log('  pass ' + (pass + 1) + '  error ' + bestErr.toFixed(5) +
      '  step ' + span.toFixed(3) + (improved ? '' : '   (refining)'))
    if (!improved) {
      span /= 2
      if (span < 0.02) break
    }
  }
  console.log('  ' + label + ': ' + evals + ' evaluations')
  return { best, bestErr }
}

// ------------------------------------------------- fitting the archetypes
//
// The named types are guesses, and they are guesses in the same units the
// `pull` scales are measured in -- doubling a pull and halving every trait's
// distance from neutral gives back an identical player. Searching both at once
// is therefore over-parameterised, and a search asked to do it will simply run
// the pulls to their bounds, which is exactly what happened. The pulls are held
// fixed at 0.5 and the traits are what moves.
//
// Traits live on [0,1], so this steps them additively rather than scaling them.
// Each archetype is graded only against its own targets, so a type that is hard
// to hit cannot drag the others off -- the previous version averaged one error
// across all five and bought a good nit by wrecking the calling station.
const TRAIT_KEYS = ['looseness', 'preflopAggression', 'aggression', 'stickiness', 'bluffiness']

// The fitted profile is the traits plus the archetype's proficiency (`skill`,
// stepped additively on its own bounds) plus the one trait scale.
const ADDITIVE_KEYS = [...TRAIT_KEYS, 'skill']
const KEY_BOUNDS = { skill: [0.05, 0.95] }   // per-key; default [0.02, 0.98]
// stickinessScale multiplies the stickiness pull per archetype. The calling
// station's WTSD target is unreachable through the trait alone -- it
// saturates at 0.98 (~0.5 pots of bias where ~1.5 are needed) and a capped
// bias has zero gradient, which is why the trait search stalls on it. The
// scale is the minimal extra degree of freedom: it restores reach without
// touching the four well-fitted types, whose scales should land near 1.
const SCALE_KEYS = ['stickinessScale']
const SCALE_BOUNDS = [0.25, 4.0]

const archetypeError = (got) => {
  const per = {}
  let total = 0
  let n = 0
  for (const kind of Object.keys(FIELD_TARGETS)) {
    per[kind] = errorAgainst(got[kind], FIELD_TARGETS[kind])
    total += per[kind]
    n++
  }
  return { total: total / n, per }
}

const runTraitDescent = (startTraits, evaluate, passes, initialStep, label) => {
  let best = JSON.parse(JSON.stringify(startTraits))
  let bestErr = evaluate(best)
  let evals = 1
  console.log('  ' + label + ' start  error ' + bestErr.toFixed(5))

  // Same refinement as the parameter search: shrink the step instead of
  // halting the moment a coarse pass fails. The additive keys and the scales
  // refine together on that schedule, each honouring its own floor: 0.01 for
  // trait steps, 0.02 for scale spans, as in the parameter search above.
  let step = initialStep
  let scaleSpan = 0.45
  for (let pass = 0; pass < passes; pass++) {
    let improved = false
    for (const kind of Object.keys(FIELD_TARGETS)) {
      if (step >= 0.01) {
        for (const key of ADDITIVE_KEYS) {
          const [lo, hi] = KEY_BOUNDS[key] || [0.02, 0.98]
          for (const delta of [-step, -step / 2, step / 2, step]) {
            const value = Math.max(lo, Math.min(hi, best[kind][key] + delta))
            if (Math.abs(value - best[kind][key]) < 1e-9) continue
            const candidate = JSON.parse(JSON.stringify(best))
            candidate[kind][key] = value
            const err = evaluate(candidate)
            evals++
            if (err < bestErr - 1e-9) {
              bestErr = err
              best = candidate
              improved = true
            }
          }
        }
      }
      if (scaleSpan >= 0.02) {
        for (const key of SCALE_KEYS) {
          for (const mult of [1 - scaleSpan, 1 - scaleSpan / 2,
            1 + scaleSpan / 2, 1 + scaleSpan]) {
            const value = Math.max(SCALE_BOUNDS[0], Math.min(SCALE_BOUNDS[1],
              best[kind][key] * mult))
            if (Math.abs(value - best[kind][key]) < 1e-9) continue
            const candidate = JSON.parse(JSON.stringify(best))
            candidate[kind][key] = value
            const err = evaluate(candidate)
            evals++
            if (err < bestErr - 1e-9) {
              bestErr = err
              best = candidate
              improved = true
            }
          }
        }
      }
    }
    console.log('  ' + label + ' pass ' + (pass + 1) + '  error ' +
      bestErr.toFixed(5) + '  step ' + step.toFixed(3) +
      (improved ? '' : '   (refining)'))
    if (!improved) {
      step /= 2
      scaleSpan /= 2
      if (step < 0.01 && scaleSpan < 0.02) break
    }
  }
  return { best, bestErr, evals }
}

// Coordinate descent is greedy, so where it lands depends on the path it took:
// the same search from the same start with a slightly different step schedule
// settled at 0.0489 one run and 0.0419 the next. More search was not a better
// fit, it was a different local optimum. Running several starts and keeping the
// best result is the cheap fix, and reporting the spread between them says how
// much the answer should be trusted.
const searchTraits = (startTraits, params, hands, seed, passes, starts = 3) => {
  const evaluate = (t) => archetypeError(measureArchetypes(params, t, hands, seed)).total

  // One start from the guesses as written, and two displaced from them, so the
  // restarts explore rather than re-running the same descent. Traits and skill
  // shift additively; the scales shift multiplicatively, up for a positive
  // nudge and back down for a negative one.
  const nudge = (amount) => {
    const out = JSON.parse(JSON.stringify(startTraits))
    for (const kind of Object.keys(out)) {
      for (const key of ADDITIVE_KEYS) {
        const [lo, hi] = KEY_BOUNDS[key] || [0.02, 0.98]
        out[kind][key] = Math.max(lo, Math.min(hi, out[kind][key] + amount))
      }
      for (const key of SCALE_KEYS) {
        const value = amount >= 0
          ? out[kind][key] * (1 + amount)
          : out[kind][key] / (1 - amount)
        out[kind][key] = Math.max(SCALE_BOUNDS[0], Math.min(SCALE_BOUNDS[1], value))
      }
    }
    return out
  }

  const attempts = [
    { traits: startTraits, step: 0.12, label: 'a' },
    { traits: nudge(0.10), step: 0.08, label: 'b' },
    { traits: nudge(-0.10), step: 0.16, label: 'c' }
  ].slice(0, starts)

  let overall = null
  let evals = 0
  const errors = []
  for (const attempt of attempts) {
    const r = runTraitDescent(attempt.traits, evaluate, passes, attempt.step, attempt.label)
    evals += r.evals
    errors.push(r.bestErr)
    if (!overall || r.bestErr < overall.bestErr) overall = r
  }

  console.log('  stage 2: ' + evals + ' evaluations across ' + attempts.length +
    ' starts, errors ' + errors.map((e) => e.toFixed(5)).join(' / ') +
    '  -> kept ' + overall.bestErr.toFixed(5))
  return overall
}

// ---------------------------------------------------------------- reporting

const line = (name, got, want) => {
  const g = isFinite(got) ? got.toFixed(1) : 'inf'
  const mark = isFinite(got) && Math.abs((got - want) / want) < 0.15 ? 'ok' : ''
  return '  ' + name.padEnd(14) + g.padStart(7) + want.toFixed(1).padStart(9) +
    '   ' + mark
}

const reportRegs = (stats) => {
  console.log('\nTable of neutral regulars, proficiency 0.85')
  console.log('  ' + 'stat'.padEnd(14) + 'measured'.padStart(7) + '   target')
  for (const k of Object.keys(REG_TARGETS)) {
    console.log(line(k, stats[k], REG_TARGETS[k]))
  }
}

const reportArchetypes = (got) => {
  console.log('\nMixed field   (measured / target)')
  console.log('  ' + 'type'.padEnd(9) + 'VPIP'.padStart(12) + 'PFR'.padStart(12) +
    'AF'.padStart(12) + 'WTSD'.padStart(12))
  const cell = (have, want) =>
    ((isFinite(have) ? have.toFixed(1) : 'inf') + '/' + want).padStart(12)
  for (const k of Object.keys(FIELD_TARGETS)) {
    const t = FIELD_TARGETS[k]
    console.log('  ' + k.padEnd(9) + cell(got[k].vpip, t.vpip) +
      cell(got[k].pfr, t.pfr) + cell(got[k].af, t.af) + cell(got[k].wtsd, t.wtsd))
  }
}

// Short labels for the fitted profile's keys, in the order the fit report
// prints them: five traits, then proficiency, then the one trait scale.
const PROFILE_LABELS = {
  looseness: 'loos', preflopAggression: 'pref', aggression: 'aggr',
  stickiness: 'stic', bluffiness: 'bluf', skill: 'skil',
  stickinessScale: 'scal'
}

// ------------------------------------------------------- fitting, resumed
//
// The traits the archetypes currently hold: the starting guesses on a fresh
// fit, the fitted values on a resumed one.
const currentTraits = () => {
  const startTraits = {}
  for (const kind of Object.keys(FIELD_TARGETS)) {
    startTraits[kind] = {}
    for (const key of TRAIT_KEYS) {
      // A type that has never had its preflop aggression fitted starts from
      // its single aggression value, which is what it was playing with.
      startTraits[kind][key] = ARCHETYPES[kind][key] !== undefined
        ? ARCHETYPES[kind][key]
        : ARCHETYPES[kind].aggression
    }
    // The fitted profile is traits plus proficiency plus the one trait scale.
    // skill and stickinessScale ride through setArchetype like any other key,
    // so a fitted value lands in ARCHETYPES and reaches the players from
    // there.
    startTraits[kind].skill = ARCHETYPES[kind].skill !== undefined
      ? ARCHETYPES[kind].skill
      : FIELD_SKILL[kind]
    startTraits[kind].stickinessScale = ARCHETYPES[kind].stickinessScale !== undefined
      ? ARCHETYPES[kind].stickinessScale
      : 1
  }
  return startTraits
}

// Stages 2 and 3, alternating, because neither alone stays fitted: stage 2
// fits the traits against whatever the pulls currently are; stage 3 then
// moves the pulls, which invalidates the traits it was just handed. Neither
// stage can touch the table of regulars, because both only move things that
// are multiplied by a trait's distance from neutral, and the regulars sit at
// neutral -- so the stage 1 fit stays intact throughout. Shared by a fresh
// fit (starting from the stage 1 value model) and --resume (starting from the
// current calibration.json).
const fitPersonality = (paramStart, startTraits, hands, traitPasses, cycles) => {
  let s2 = searchTraits(startTraits, paramStart, hands, 8, traitPasses)

  // handOvervalue moves only archetype evals, and only in proportion to a
  // trait's distance from neutral -- the neutral regulars of stage 1 cannot
  // see it, so that fit is untouched by construction.
  const stage3Keys = ['pullAggression', 'pullLooseness', 'pullStickiness',
    'pullBluffiness', 'maxBias', 'temperatureCurve', 'handOvervalue']
  let s3 = search(paramStart, stage3Keys, (p) =>
    archetypeError(measureArchetypes(p, s2.best, hands, 8)).total, 8, 'stage 3')

  for (let cycle = 2; cycle <= cycles; cycle++) {
    console.log('\nStage 2/3 cycle ' + cycle + ': re-fitting traits against the new scales')
    const again = searchTraits(s2.best, s3.best, hands, 8, 4, 1)
    if (again.bestErr < s3.bestErr - 1e-9) s2 = again
    s3 = search(s3.best, stage3Keys, (p) =>
      archetypeError(measureArchetypes(p, s2.best, hands, 8)).total, 6,
      'stage 3 cycle ' + cycle)
  }
  return { s2, s3 }
}

// Everything after the search converges: report the fit, flag parameters
// resting on a bound, and write calibration.json.
const finishFit = (baseline, s2, s3, startTraits, hands, started) => {
  setParams(s3.best)
  console.log('\nAfter:')
  const afterRegs = measureRegs(s3.best, hands, 7)
  reportRegs(afterRegs)
  const afterArch = measureArchetypes(s3.best, s2.best, hands, 8)
  reportArchetypes(afterArch)

  console.log('\nArchetype traits')
  for (const kind of Object.keys(s2.best)) {
    const parts = Object.keys(PROFILE_LABELS).map((k) =>
      PROFILE_LABELS[k] + ' ' + startTraits[kind][k].toFixed(2) + '->' +
      s2.best[kind][k].toFixed(2))
    console.log('  ' + kind.padEnd(9) + parts.join('  '))
  }

  console.log('\nParameters')
  let atBound = 0
  for (const k of Object.keys(s3.best)) {
    const from = baseline[k]
    const to = s3.best[k]
    // A parameter resting on its bound means the search wanted to go further
    // and was not allowed to. That is not a converged fit, it is a
    // constrained one, and it usually says the model is missing a term
    // rather than that the constant is wrong.
    const b = BOUNDS[k]
    const pinned = b && (Math.abs(to - b[0]) < 1e-9 || Math.abs(to - b[1]) < 1e-9)
    if (pinned) atBound++
    console.log('  ' + k.padEnd(16) + from.toFixed(3).padStart(7) + ' -> ' +
      to.toFixed(3).padStart(7) +
      (pinned ? '   AT BOUND' : (Math.abs(to - from) > 1e-9 ? '' : '   (unchanged)')))
  }
  if (atBound > 0) {
    console.log('  ' + atBound + ' parameter(s) pinned to a bound -- the fit is')
    console.log('  constrained rather than converged.')
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    params: s3.best,
    archetypes: s2.best,
    targets: { regulars: REG_TARGETS, field: FIELD_TARGETS },
    fitted: { regulars: afterRegs, field: afterArch },
    hands,
    generated: new Date().toISOString()
  }, null, 2))
  console.log('\nWrote calibration.json in ' +
    ((Date.now() - started) / 1000).toFixed(0) + 's')
}

// Continue a fit from the current calibration.json without re-running stage
// 1. Optional key=value arguments lift parameters to new starting values
// first -- the escape hatch for a parameter pinned on its bound, where no
// single-coordinate move improves. Raising the ceiling alone frees a bias
// that was capped at it, after which the trait stage can walk the trait back
// down; the search could not reach that joint move one coordinate at a time.
const resumeFit = (hands, args) => {
  const overrides = {}
  for (const kv of args) {
    const m = kv.match(/^([A-Za-z]+)=([\d.eE+-]+)$/)
    if (!m) continue // the hands count sits in the same argv slice
    if (!(m[1] in BOUNDS)) {
      console.error('usage: node texas-calibrate.js --resume [' +
        Object.keys(BOUNDS).join('|') + ']=number ...')
      process.exit(2)
    }
    overrides[m[1]] = clampParam(m[1], Number(m[2]))
  }

  const started = Date.now()
  const baseline = { ...PARAMS, ...overrides }
  const startTraits = currentTraits()
  console.log('Resuming from calibration.json' +
    (Object.keys(overrides).length ? '  overrides ' + JSON.stringify(overrides) : ''))

  const { s2, s3 } = fitPersonality(baseline, startTraits, hands, 5, 3)
  finishFit(baseline, s2, s3, startTraits, hands, started)
}

// --------------------------------------------------------------------- main

if (require.main === module) {
  const mode = process.argv[2]
  const HANDS = Number(process.argv[3]) || 8000

  if (mode === '--noise') {
    // How much of the objective is real and how much is sampling noise. This
    // is the number that says whether the search can work at all -- the same
    // question blackjack.js answered the wrong way.
    console.log('Noise floor of the objective, ' + HANDS + ' hands per run\n')
    const runs = []
    for (let s = 0; s < 6; s++) runs.push(measureRegs({ ...PARAMS }, HANDS, 100 + s))
    for (const key of Object.keys(REG_TARGETS)) {
      const xs = runs.map((r) => r[key])
      const m = xs.reduce((a, b) => a + b, 0) / xs.length
      const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1))
      console.log('  ' + key.padEnd(13) + 'mean ' + m.toFixed(2).padStart(7) +
        '   sd ' + sd.toFixed(3).padStart(6) +
        '   target ' + REG_TARGETS[key])
    }
    console.log('\nFor comparison, bb/100 over the same hands carries a standard')
    console.log('error near 20. Behaviour is the cheap thing to measure.')
  } else if (mode === '--check') {
    reportRegs(measureRegs({ ...PARAMS }, HANDS, 7))
    reportArchetypes(measureArchetypes({ ...PARAMS }, null, HANDS, 8))
    console.log('\nParameters in force:')
    console.log('  ' + JSON.stringify(PARAMS))
  } else if (mode === '--resume') {
    resumeFit(HANDS, process.argv.slice(3))
  } else {
    const started = Date.now()
    const baseline = { ...PARAMS }

    console.log('Before:')
    const beforeRegs = measureRegs(baseline, HANDS, 7)
    reportRegs(beforeRegs)
    const beforeArch = measureArchetypes(baseline, null, HANDS, 8)
    reportArchetypes(beforeArch)

    // Stage one. Neutral traits, so the four personality scales are multiplied
    // by zero and cannot affect anything -- this fits the value model alone.
    console.log('\nStage 1: the value model, against a table of regulars')
    const stage1Keys = ['foldBase', 'foldSlope', 'stubbornness', 'callShadePre',
      'callShadePost', 'raiseShade', 'temperature', 'pullPosition',
      'positionPostWeight', 'futureCost',
      'callShadePostBase']
    const s1 = search(baseline, stage1Keys,
      (p) => errorAgainst(measureRegs(p, HANDS, 7), REG_TARGETS), 12, 'stage 1')

    // Stages two and three: move each named type's traits until it behaves
    // the way that type is supposed to, then fit how hard the traits pull,
    // alternating. Stage three exists because a trait can saturate its [0,1]
    // range while still losing to the value model's charges -- the calling
    // station saturates, which is what makes the pull identifiable only after
    // the traits have taken up all the slack they can. The temperature curve
    // belongs there too, for the same structural reason: it pivots on the
    // regulars' proficiency, so it moves every player except the ones stage 1
    // was fitted on. Run in a single pass it pushed pullLooseness from 0.5 to
    // 1.21 and left the LAG archetype -- whose traits were fitted for 0.5 --
    // playing 59.6% of hands against a target of 32.
    console.log('\nStage 2: the archetype traits, against a mixed field')
    const startTraits = currentTraits()
    const { s2, s3 } = fitPersonality(s1.best, startTraits, HANDS, 5, 3)

    finishFit(baseline, s2, s3, startTraits, HANDS, started)
  }
}

module.exports = { REG_TARGETS, FIELD_TARGETS, FIELD_SKILL, fieldSkill, measureRegs, measureArchetypes }
