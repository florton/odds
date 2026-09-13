// What the simulation says.
//
//   node texas-results.js            300,000 hands per experiment
//   node texas-results.js 60000      a quicker, noisier run
//
// Everything before this file exists to make these numbers worth reading: an
// engine checked against its invariants, an evaluator checked against every
// seven-card hand, and a player model fitted until a table of it reproduces
// how real players are measured to play. This is where that field is finally
// asked who wins.
//
// Four experiments, each designed to isolate one thing:
//
//   1. **Personality at equal skill.** The five fitted types, all at the same
//      proficiency, so any difference in win rate is the style and nothing else.
//   2. **Skill at equal personality.** Six identical neutral players at six
//      proficiencies, so any difference is execution and nothing else.
//   3. **The realistic table.** The types at the proficiencies they were fitted
//      at, with and without rake -- the closest thing here to a real game.
//   4. **Where the money comes from**, broken down by position and by starting
//      hand across that realistic table.
//
// Every table is dealt in duplicate: each deck is played once per seat with the
// lineup rotated, so every player gets every set of cards from every position
// and card luck cancels instead of being averaged away. Rotations of the same
// deck are not independent, so the deck is the sampling unit and every error
// bar here is clustered on it. Treating the hands as independent would make the
// error bars look several times tighter than they are.
//
// A win rate is reported only with its standard error, and a claim is only made
// where the difference clears it.

const fs = require('fs')
const path = require('path')
const { measure } = require('./texas')
const { archetype, makePlayer } = require('./texas-players')
const { FIELD_SKILL } = require('./texas-calibrate')
const { handIndex, handLabel } = require('./texas-equity')
const { makeRng } = require('./texas-engine')

const OUT_FILE = path.join(__dirname, 'results.json')
const BIG_BLIND = 2
const POSITIONS = ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO']

// ------------------------------------------------------ clustered estimates
//
// A running mean whose standard error respects the clustering. Observations
// arrive grouped by deck; the variance of the mean is built from how far each
// deck's total strays from what the overall mean predicts for that many
// observations, which is the cluster-robust estimator. With one observation per
// deck it reduces exactly to the ordinary standard error.
const makeEstimate = () => {
  let n = 0
  let sum = 0
  let clusterSum = 0
  let clusterN = 0
  let sumSq = 0     // sum over decks of (deck total)^2
  let sumCross = 0  // sum over decks of deck total * deck count
  let sumNSq = 0    // sum over decks of (deck count)^2
  return {
    add: (x) => {
      clusterSum += x
      clusterN++
    },
    endDeck: () => {
      if (clusterN === 0) return
      n += clusterN
      sum += clusterSum
      sumSq += clusterSum * clusterSum
      sumCross += clusterSum * clusterN
      sumNSq += clusterN * clusterN
      clusterSum = 0
      clusterN = 0
    },
    // Mean and standard error in bb/100.
    result: () => {
      if (n < 2) return { n, bb100: 0, se: 0 }
      const mean = sum / n
      const v = Math.max(0, sumSq - 2 * mean * sumCross + mean * mean * sumNSq) / (n * n)
      return { n, bb100: (mean / BIG_BLIND) * 100, se: (Math.sqrt(v) / BIG_BLIND) * 100 }
    }
  }
}

// Attaches to `measure` as its tracker, and breaks each hand's result down by
// player, by position and by starting hand. Under duplicate dealing the button
// never moves -- the players do -- so a seat index is a position.
const makeBreakdown = (bots) => {
  const n = bots.length
  const which = new Map(bots.map((b, i) => [b, i]))
  const byPlayer = bots.map(() => makeEstimate())
  const byPosition = POSITIONS.slice(0, n).map(() => makeEstimate())
  const byPlayerPosition = bots.map(() => POSITIONS.slice(0, n).map(() => makeEstimate()))
  const byHand = Array.from({ length: 169 }, () => makeEstimate())
  const all = [...byPlayer, ...byPosition, ...byHand, ...byPlayerPosition.flat()]
  let handsThisDeck = 0

  return {
    record: (result, lineup) => {
      for (let s = 0; s < n; s++) {
        const delta = result.deltas[s]
        const pos = (s - result.button + n) % n
        const p = which.get(lineup[s])
        byPlayer[p].add(delta)
        byPosition[pos].add(delta)
        byPlayerPosition[p][pos].add(delta)
        const hole = result.holeCards[s]
        byHand[handIndex(hole[0], hole[1])].add(delta)
      }
      if (++handsThisDeck === n) {
        for (const e of all) e.endDeck()
        handsThisDeck = 0
      }
    },
    byPlayer: () => byPlayer.map((e, i) => ({ name: bots[i].name, ...e.result() })),
    byPosition: () => byPosition.map((e, i) => ({ position: POSITIONS[i], ...e.result() })),
    byPlayerPosition: () => bots.map((b, i) => ({
      name: b.name,
      positions: byPlayerPosition[i].map((e, k) => ({ position: POSITIONS[k], ...e.result() }))
    })),
    byHand: () => byHand.map((e, i) => ({ hand: handLabel(i), ...e.result() }))
  }
}

const run = (bots, hands, opts = {}) => {
  const breakdown = makeBreakdown(bots)
  const out = measure(bots, { hands, paired: true, tracker: breakdown, ...opts })
  return { out, breakdown }
}

// ----------------------------------------------------------------- printing

const fmt = (x, d = 1) => (x >= 0 ? '+' : '') + x.toFixed(d)

const printRows = (rows, labelKey, width = 14) => {
  console.log('  ' + ''.padEnd(width) + 'bb/100'.padStart(9) + '    +/- SE')
  for (const r of rows) {
    console.log('  ' + String(r[labelKey]).padEnd(width) + fmt(r.bb100).padStart(9) +
      '    ' + r.se.toFixed(1).padStart(5))
  }
}

// Two estimates differ when the gap clears three combined standard errors.
// Error bars are shown on everything, but a claim needs this.
const clearlyAbove = (a, b) =>
  a.bb100 - b.bb100 > 3 * Math.sqrt(a.se * a.se + b.se * b.se)

// --------------------------------------------------------------------- main

if (require.main === module) {
  const HANDS = Number(process.argv[2]) || 300000
  const started = Date.now()
  const saved = { hands: HANDS, generated: new Date().toISOString() }
  const checks = []
  const check = (label, ok, detail) => {
    checks.push({ label, ok, detail })
    console.log('  ' + (ok ? 'yes ' : 'NO  ') + label + (detail ? '   (' + detail + ')' : ''))
  }

  const TYPES = ['nit', 'tag', 'lag', 'station', 'maniac']

  // 1. Personality at equal skill. Six seats and five types, so the sixth is a
  // neutral regular: the plain value-maximiser the traits are measured from.
  {
    const rng = makeRng(101)
    const bots = TYPES.map((k) => archetype(k, 0.85, rng, k))
      .concat([makePlayer('neutral', { proficiency: 0.85, rng })])
    const { out, breakdown } = run(bots, HANDS, { seed: 11 })
    console.log('\n1. Personality at equal skill -- every seat at proficiency 0.85')
    console.log('   ' + out.handsPlayed.toLocaleString() + ' hands, dealt in duplicate' +
      '   showdown ' + (out.showdownRate * 100).toFixed(1) + '%')
    const rows = breakdown.byPlayer().sort((a, b) => b.bb100 - a.bb100)
    printRows(rows, 'name')
    saved.personality = { hands: out.handsPlayed, showdownRate: out.showdownRate, players: rows }
  }

  // 2. Skill at equal personality. All neutral, so the only thing that differs
  // between seats is how well the same player executes.
  const SKILLS = [0.25, 0.40, 0.55, 0.70, 0.85, 1.0]
  {
    const rng = makeRng(202)
    const bots = SKILLS.map((p) => makePlayer('skill ' + p.toFixed(2), { proficiency: p, rng }))
    const { out, breakdown } = run(bots, HANDS, { seed: 22 })
    console.log('\n2. Skill at equal personality -- six neutral players')
    console.log('   ' + out.handsPlayed.toLocaleString() + ' hands, dealt in duplicate' +
      '   showdown ' + (out.showdownRate * 100).toFixed(1) + '%')
    const rows = breakdown.byPlayer()
    printRows(rows, 'name')
    saved.skill = { hands: out.handsPlayed, showdownRate: out.showdownRate, players: rows }

    console.log('\n   Is more skill worth more money?')
    let ordered = 0
    for (let i = 1; i < rows.length; i++) if (rows[i].bb100 > rows[i - 1].bb100) ordered++
    check('win rate rises with every step of proficiency', ordered === rows.length - 1,
      ordered + ' of ' + (rows.length - 1) + ' steps')
    check('the best player clearly beats the worst', clearlyAbove(rows[rows.length - 1], rows[0]))
  }

  // 3 and 4. The realistic table: each type at the proficiency it was fitted
  // at, in the lineup it was fitted in.
  {
    const rng = makeRng(303)
    const lineup = ['nit', 'tag', 'lag', 'station', 'maniac', 'tag']
    const bots = lineup.map((k, i) => archetype(k, FIELD_SKILL[k], rng,
      k + (lineup.indexOf(k) !== i ? ' (2)' : '')))
    const { out, breakdown } = run(bots, HANDS, { seed: 33 })
    console.log('\n3. The realistic table -- types at their fitted proficiencies, no rake')
    console.log('   ' + out.handsPlayed.toLocaleString() + ' hands, dealt in duplicate' +
      '   showdown ' + (out.showdownRate * 100).toFixed(1) + '%')
    const rows = breakdown.byPlayer().sort((a, b) => b.bb100 - a.bb100)
    printRows(rows, 'name')

    const rakeCfg = { percent: 0.05, cap: 3 * BIG_BLIND, noFlopNoDrop: true }
    const raked = run(bots, HANDS, { seed: 33, rake: rakeCfg })
    const rakeRows = raked.breakdown.byPlayer().sort((a, b) => b.bb100 - a.bb100)
    const rakePer100 = (raked.out.rakeTotal / raked.out.handsPlayed) * 100 / BIG_BLIND / bots.length
    console.log('\n   The same table with a 5% rake capped at 3bb')
    printRows(rakeRows, 'name')
    console.log('   rake costs each seat ' + rakePer100.toFixed(1) + ' bb/100 on average')

    console.log('\n4. Where the money comes from, across the realistic table')
    const positions = breakdown.byPosition()
    console.log('\n   By position (whole table)')
    printRows(positions, 'position')

    const perType = breakdown.byPlayerPosition()
    console.log('\n   By position and player (bb/100)')
    console.log('  ' + ''.padEnd(12) + POSITIONS.map((p) => p.padStart(8)).join(''))
    for (const r of perType) {
      console.log('  ' + r.name.padEnd(12) + r.positions.map((c) => fmt(c.bb100, 0).padStart(8)).join(''))
    }

    const hands = breakdown.byHand().sort((a, b) => b.bb100 - a.bb100)
    console.log('\n   Starting hands, most and least profitable (bb/100 when dealt)')
    const top = hands.slice(0, 10)
    const bottom = hands.slice(-10)
    for (let i = 0; i < 10; i++) {
      const a = top[i]
      const b = bottom[i]
      console.log('  ' + a.hand.padEnd(5) + fmt(a.bb100, 0).padStart(7) + ' +/-' + a.se.toFixed(0).padStart(4) +
        '        ' + b.hand.padEnd(5) + fmt(b.bb100, 0).padStart(7) + ' +/-' + b.se.toFixed(0).padStart(4))
    }

    // What is known about real games, as shapes rather than figures: the
    // specific numbers vary with stakes and population, but the orderings are
    // among the most reproduced results in tracked poker data.
    console.log('\n   Does it have the shape of a real game?')
    const at = (p) => positions[POSITIONS.indexOf(p)]
    check('the button is the most profitable seat',
      positions.every((p) => p.position === 'BTN' || at('BTN').bb100 > p.bb100))
    check('both blinds lose money', at('SB').bb100 < 0 && at('BB').bb100 < 0,
      'SB ' + fmt(at('SB').bb100) + ', BB ' + fmt(at('BB').bb100))
    check('later position earns more: CO > HJ > UTG',
      at('CO').bb100 > at('HJ').bb100 && at('HJ').bb100 > at('UTG').bb100)
    check('aces are the most profitable starting hand', hands[0].hand === 'AA', 'top is ' + hands[0].hand)
    check('the top five hands are big pairs and AK',
      hands.slice(0, 5).every((h) => ['AA', 'KK', 'QQ', 'JJ', 'TT', 'AKs', 'AKo'].includes(h.hand)),
      hands.slice(0, 5).map((h) => h.hand).join(' '))
    const byName = (name) => rows.find((r) => r.name === name)
    check('the calling station loses', byName('station').bb100 + 3 * byName('station').se < 0,
      fmt(byName('station').bb100))
    check('the maniac loses', byName('maniac').bb100 + 3 * byName('maniac').se < 0,
      fmt(byName('maniac').bb100))
    check('a TAG beats the station and the maniac',
      clearlyAbove(byName('tag'), byName('station')) && clearlyAbove(byName('tag'), byName('maniac')))

    saved.realistic = {
      hands: out.handsPlayed,
      showdownRate: out.showdownRate,
      proficiency: FIELD_SKILL,
      players: rows,
      raked: { rake: rakeCfg, rakePer100PerSeat: rakePer100, players: rakeRows },
      positions,
      playerPositions: perType,
      startingHands: hands
    }
  }

  saved.checks = checks
  fs.writeFileSync(OUT_FILE, JSON.stringify(saved, null, 2))
  console.log('\nWrote results.json in ' + ((Date.now() - started) / 1000).toFixed(0) + 's')
}

module.exports = { makeEstimate, makeBreakdown }
