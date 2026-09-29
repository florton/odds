// Texas Hold'em -- table driver and measurement harness.
//
//   node texas.js                     deal one hand and print it
//   node texas.js --watch [n] [seed]  watch n hands dealt to the fitted personalities
//   node texas.js --players           the personality field's stats over 40k hands
//   node texas.js 100000              measure a lineup over 100,000 hands
//   node texas.js 100000 --paired     the same, with duplicate dealing
//   node texas.js --test              engine invariants
//
// The unit throughout is **bb/100**: big blinds won per hundred hands, which
// is how a cash game result is actually quoted. Every number is reported with
// a standard error next to it, because the lesson from blackjack.js is that a
// win rate without one is not a measurement -- that project spent its entire
// evolutionary search resolving differences of 0.0001 against a noise floor of
// 0.0003, and accepted noise as progress for as long as it ran.

const { playHand, makeRng, makeDeck, shuffle } = require('./texas-engine')
const { evaluate, cardName, rankOf, suitOf } = require('./texas-eval')

// ------------------------------------------------------------ reference bots
//
// Deliberately crude. These exist to exercise the engine and to give the
// measurement harness something to measure; they are not the personality
// model, which is the next piece of work. What matters here is the shape of
// the interface: a bot is a name and an `act(view)`, it sees only what the
// engine hands it, and it returns one of four things.

const folder = {
  name: 'Folder',
  act: () => ({ action: 'fold' })
}

const caller = {
  name: 'Caller',
  act: (v) => ({ action: v.toCall > 0 ? 'call' : 'check' })
}

const maniac = {
  name: 'Maniac',
  act: (v) => {
    if (v.canRaise) return { action: 'raise', to: Math.min(v.minRaiseTo * 2, v.maxRaiseTo) }
    return { action: v.toCall > 0 ? 'call' : 'check' }
  }
}

// `wild` sizes raises anywhere up to a full stack, which is what the engine
// tests want -- it produces all-ins and uneven side pots at a high rate. The
// default sizes off the pot instead, because a bot that shoves a random number
// of chips turns every hand into a preflop all-in and makes the measured rates
// meaningless.
const makeRandomBot = (name, rng, wild = false) => ({
  name,
  act: (v) => {
    const r = rng()
    if (r < 0.15) return { action: 'fold' }
    if (r < 0.75) return { action: v.toCall > 0 ? 'call' : 'check' }
    if (!v.canRaise) return { action: v.toCall > 0 ? 'call' : 'check' }
    const to = wild
      ? v.minRaiseTo + Math.floor(rng() * (v.maxRaiseTo - v.minRaiseTo + 1))
      : Math.min(v.minRaiseTo + Math.floor(rng() * v.pot), v.maxRaiseTo)
    return { action: 'raise', to }
  }
})

// Crude but not random: plays made hands and pot odds, nothing else. No
// draws, no position, no read on the opponent, no bluffing.
//
// The thresholds are parameters rather than literals, which is the shape the
// personality model will need: a strategy is data that can be varied, stored
// and compared, not a function someone hand-edits. Two rocks with different
// numbers are two strategies, and `compare` below can tell them apart.
const makeRock = (name, { preflopCall = 13, preflopRaise = 20, postflopCall = 1 } = {}) => ({
  name,
  params: { preflopCall, preflopRaise, postflopCall },
  act: (v) => {
    const [a, b] = v.holeCards
    if (v.board.length === 0) {
      const hi = Math.max(rankOf(a), rankOf(b))
      const lo = Math.min(rankOf(a), rankOf(b))
      const pair = hi === lo
      const suited = suitOf(a) === suitOf(b)
      const strength = pair ? 10 + hi : hi + (suited ? 2 : 0) + (hi - lo <= 2 ? 1 : 0)
      if (strength >= preflopRaise && v.canRaise) return { action: 'raise', to: v.minRaiseTo }
      if (strength >= preflopCall) return { action: v.toCall > 0 ? 'call' : 'check' }
      return v.toCall > 0 ? { action: 'fold' } : { action: 'check' }
    }
    const cat = evaluate(v.holeCards.concat(v.board)) >> 20
    if (cat >= 3 && v.canRaise) return { action: 'raise', to: v.minRaiseTo }
    if (cat >= postflopCall) return { action: v.toCall > 0 ? 'call' : 'check' }
    if (v.toCall === 0) return { action: 'check' }
    // Pot odds on nothing: call only if it is nearly free.
    return v.toCall <= v.pot * 0.1 ? { action: 'call' } : { action: 'fold' }
  }
})

const rock = makeRock('Rock')

// --------------------------------------------------------------- statistics

const summarise = (samples, bigBlind, perSample) => {
  const n = samples.length
  let sum = 0
  for (const x of samples) sum += x
  const mean = sum / n
  let sq = 0
  for (const x of samples) sq += (x - mean) * (x - mean)
  const sd = Math.sqrt(sq / (n - 1))
  // A sample here is one deck, which may contain several hands, so the rate
  // per hand divides by how many hands that sample covered.
  const perHand = mean / perSample / bigBlind
  const sePerHand = sd / perSample / bigBlind / Math.sqrt(n)
  return { bb100: perHand * 100, se: sePerHand * 100 }
}

// ----------------------------------------------------------- the harness
//
// Cash-game convention: every seat is topped back up to the starting stack
// before each hand, and the result is the accumulated delta. That measures the
// strategy rather than the bankroll -- otherwise a busted seat stops playing
// and the run silently becomes a different experiment.
const measure = (bots, opts = {}) => {
  const {
    hands = 100000,
    startingStack = 200,
    smallBlind = 1,
    bigBlind = 2,
    ante = 0,
    rake = { percent: 0, cap: 0, noFlopNoDrop: true },
    seed = 1,
    paired = false,
    tracker = null
  } = opts

  const n = bots.length
  const rng = makeRng(seed)
  const totals = new Array(n).fill(0)
  const samples = Array.from({ length: n }, () => [])

  let illegal = 0
  let rakeTotal = 0
  let showdowns = 0
  let handsPlayed = 0

  // Duplicate dealing. Each deck is played through `n` times with the lineup
  // rotated one seat, so every strategy plays every set of hole cards from
  // every position on identical cards. Card luck then cancels between the
  // rotations instead of having to be averaged away, which is the poker
  // version of the common random numbers blackjack.js needed and never got.
  //
  // The rotations of one deck are not independent of each other, so the deck
  // is the sampling unit and the variance is taken across decks. Treating each
  // hand as independent here would understate the error bars badly.
  const rotations = paired ? n : 1
  const decks = paired ? Math.max(1, Math.floor(hands / n)) : hands

  for (let d = 0; d < decks; d++) {
    const deck = shuffle(makeDeck(), rng)
    const perBot = new Array(n).fill(0)

    for (let r = 0; r < rotations; r++) {
      // Seat s is filled by bot (s + r) mod n. The deck and the button stay
      // put, so the cards and the positions are identical across rotations
      // and only the occupants move.
      const lineup = new Array(n)
      for (let s = 0; s < n; s++) lineup[s] = bots[(s + r) % n]

      const result = playHand({
        bots: lineup,
        stacks: new Array(n).fill(startingStack),
        button: paired ? 0 : d % n,
        smallBlind,
        bigBlind,
        ante,
        rake,
        deck
      })

      for (let s = 0; s < n; s++) perBot[(s + r) % n] += result.deltas[s]
      // Strategies that carry state between hands -- tilt, or a read on an
      // opponent -- are told how the hand finished. They still only learn what
      // the table saw, since the result carries no hole cards for anyone who
      // did not show them down.
      for (let s = 0; s < n; s++) {
        if (lineup[s].observe) lineup[s].observe(result, s)
      }
      // The lineup goes with it, because under duplicate dealing a seat is not
      // a player -- the occupants move every rotation.
      if (tracker) tracker.record(result, lineup)
      illegal += result.illegal
      rakeTotal += result.rakePaid
      if (result.wentToShowdown) showdowns++
      handsPlayed++
    }

    for (let b = 0; b < n; b++) {
      totals[b] += perBot[b]
      samples[b].push(perBot[b])
    }
  }

  return {
    handsPlayed,
    decks,
    rotations,
    illegal,
    rakeTotal,
    showdownRate: showdowns / handsPlayed,
    results: bots.map((bot, b) => ({
      name: bot.name,
      chips: totals[b],
      ...summarise(samples[b], bigBlind, rotations)
    }))
  }
}

// ------------------------------------------------- comparing two strategies
//
// This is the tool that makes iterating on a strategy possible, and it is the
// one blackjack.js never had.
//
// Measuring two strategies separately and subtracting the win rates means
// subtracting two noisy numbers, and poker's per-hand variance is large enough
// that the difference drowns long before it is interesting. Instead both
// candidates are sat in the *same seat*, against the *same opponents*, on the
// *same deck*, and the results are differenced hand by hand. Every hand where
// the two would have played identically cancels to exactly zero and
// contributes no noise at all -- only the hands where they actually disagree
// carry any variance.
//
// That is the common random numbers idea from the blackjack post-mortem, and
// it is worth far more here than it would have been there, because a change to
// one line of a poker strategy affects a small fraction of hands and leaves
// the rest untouched.
const compare = (a, b, field, opts = {}) => {
  const {
    hands = 100000,
    startingStack = 200,
    smallBlind = 1,
    bigBlind = 2,
    ante = 0,
    rake = { percent: 0, cap: 0, noFlopNoDrop: true },
    seed = 1
  } = opts

  const n = field.length + 1
  const rng = makeRng(seed)
  const diffs = []
  const aDeltas = []
  const bDeltas = []
  let diverged = 0

  for (let d = 0; d < hands; d++) {
    const deck = shuffle(makeDeck(), rng)
    // The button moves with the deck, so across the run the challenger seat
    // occupies every position an equal number of times -- and occupies the
    // same one for both candidates on any given deck.
    const button = d % n
    const played = []

    for (const who of [a, b]) {
      const res = playHand({
        bots: [who, ...field],
        stacks: new Array(n).fill(startingStack),
        button,
        smallBlind,
        bigBlind,
        ante,
        rake,
        deck
      })
      played.push({
        delta: res.deltas[0],
        line: res.actions
          .filter((x) => x.seat === 0)
          .map((x) => x.type + x.to)
          .join(',')
      })
    }

    if (played[0].line !== played[1].line) diverged++
    aDeltas.push(played[0].delta)
    bDeltas.push(played[1].delta)
    diffs.push(played[0].delta - played[1].delta)
  }

  const stat = (xs) => {
    const m = xs.reduce((p, q) => p + q, 0) / xs.length
    const v = xs.reduce((p, q) => p + (q - m) * (q - m), 0) / (xs.length - 1)
    return {
      bb100: (m / bigBlind) * 100,
      se: (Math.sqrt(v) / bigBlind / Math.sqrt(xs.length)) * 100
    }
  }

  const paired = stat(diffs)
  const sa = stat(aDeltas)
  const sb = stat(bDeltas)
  // What the same measurement would have cost without pairing: two independent
  // estimates, their errors added in quadrature.
  const unpairedSe = Math.sqrt(sa.se * sa.se + sb.se * sb.se)

  return {
    hands,
    a: { name: a.name, ...sa },
    b: { name: b.name, ...sb },
    diff: paired,
    unpairedSe,
    reduction: unpairedSe / paired.se,
    divergenceRate: diverged / hands
  }
}

const reportCompare = (out) => {
  console.log('\n' + out.a.name + ' vs ' + out.b.name +
    '   (' + out.hands.toLocaleString() + ' paired hands)')
  console.log('  ' + out.a.name.padEnd(14) + out.a.bb100.toFixed(2).padStart(9) +
    ' bb/100  +/- ' + out.a.se.toFixed(2))
  console.log('  ' + out.b.name.padEnd(14) + out.b.bb100.toFixed(2).padStart(9) +
    ' bb/100  +/- ' + out.b.se.toFixed(2))
  console.log('  ' + 'difference'.padEnd(14) + out.diff.bb100.toFixed(2).padStart(9) +
    ' bb/100  +/- ' + out.diff.se.toFixed(2) +
    '   t = ' + Math.abs(out.diff.bb100 / out.diff.se).toFixed(1))
  console.log('  the two played differently on ' +
    (out.divergenceRate * 100).toFixed(1) + '% of hands')
  console.log('  pairing cut the error bar ' + out.reduction.toFixed(1) +
    'x (unpaired would be +/- ' + out.unpairedSe.toFixed(2) + ')')
}

const report = (label, out) => {
  console.log('\n' + label)
  console.log('  ' + out.handsPlayed.toLocaleString() + ' hands' +
    (out.rotations > 1 ? '  (' + out.decks.toLocaleString() + ' decks x ' + out.rotations + ' rotations)' : '') +
    '   showdown ' + (out.showdownRate * 100).toFixed(1) + '%' +
    (out.rakeTotal > 0 ? '   rake ' + out.rakeTotal.toLocaleString() : '') +
    (out.illegal > 0 ? '   illegal actions ' + out.illegal : ''))
  console.log('  ' + 'strategy'.padEnd(12) + 'bb/100'.padStart(10) + '  +/- SE')
  const sorted = out.results.slice().sort((a, b) => b.bb100 - a.bb100)
  for (const r of sorted) {
    console.log('  ' + r.name.padEnd(12) +
      r.bb100.toFixed(2).padStart(10) + '   ' + r.se.toFixed(2))
  }
  const sum = out.results.reduce((a, r) => a + r.chips, 0)
  console.log('  sum of chips: ' + sum + (out.rakeTotal > 0 ? ' (+ ' + out.rakeTotal + ' raked = 0)' : ''))

  // A real 6-max cash game reaches showdown on roughly a quarter to a third of
  // hands. The reference strategies here miss that badly because they hardly
  // ever bet, so hands get checked down instead of won without a showdown.
  // That is a property of the placeholder strategies, not of the engine -- and
  // it is the concrete target the personality model has to hit before any win
  // rate measured against this field describes anything real.
  if (out.showdownRate > 0.45) {
    console.log('  NOTE: showdown rate ' + (out.showdownRate * 100).toFixed(0) +
      '% is far above the ~25-30% of a real game -- these reference')
    console.log('        strategies check too much. Rates below separate them, but do not')
    console.log('        describe a casino table.')
  }
}

// ----------------------------------------------------------------- checks

const runTests = () => {
  let failures = 0
  const check = (label, cond, detail) => {
    if (cond) return
    failures++
    console.log('FAIL  ' + label + (detail !== undefined ? '   ' + detail : ''))
  }

  console.log('Chip conservation')
  // Random stacks and random bots, which is what actually stresses side pots:
  // uneven all-ins at every level, several at once, and folded players whose
  // chips have to stay in the pot without making them eligible for it.
  {
    const rng = makeRng(7)
    const bots = [
      makeRandomBot('r0', rng, true), makeRandomBot('r1', rng, true),
      makeRandomBot('r2', rng, true), makeRandomBot('r3', rng, true),
      makeRandomBot('r4', rng, true), makeRandomBot('r5', rng, true)
    ]
    let bad = 0
    let foldedWinner = 0
    let negative = 0
    let sidePots = 0
    let allInHands = 0
    for (let i = 0; i < 20000; i++) {
      const stacks = bots.map(() => 1 + Math.floor(rng() * 300))
      const before = stacks.reduce((a, b) => a + b, 0)
      const res = playHand({
        bots,
        stacks,
        button: i % 6,
        smallBlind: 1,
        bigBlind: 2,
        rake: { percent: 0.05, cap: 12, noFlopNoDrop: true },
        deck: shuffle(makeDeck(), rng)
      })
      const after = res.stacks.reduce((a, b) => a + b, 0)
      if (after + res.rakePaid !== before) bad++
      for (const w of res.winners) if (res.folded[w.seat]) foldedWinner++
      for (const s of res.stacks) if (s < 0) negative++
      if (res.pots.length > 1) sidePots++
      if (res.allIn.some(Boolean)) allInHands++
    }
    check('chips in == chips out + rake, over 20,000 hands', bad === 0, bad + ' broke')
    check('a folded player never wins a pot', foldedWinner === 0, foldedWinner + ' did')
    check('no stack goes negative', negative === 0, negative + ' did')
    check('side pots actually occurred (the test is exercising them)', sidePots > 500, sidePots)
    console.log('  ' + sidePots.toLocaleString() + ' hands built side pots, ' +
      allInHands.toLocaleString() + ' had someone all in')
  }

  console.log('Blinds and position')
  {
    // A bot that folds every hand against callers loses exactly its blinds:
    // one small and one big per orbit. With 1/2 blinds and six seats that is
    // 3 chips per 6 hands = -25 bb/100, with no variance at all. If the blinds,
    // the button rotation or the fold handling were wrong this would not land
    // on the number.
    const bots = [folder, caller, caller, caller, caller, caller]
    const out = measure(bots, { hands: 6000, seed: 3, startingStack: 200 })
    const f = out.results[0]
    check('a folder loses exactly 25 bb/100 in a 6-max 1/2 game',
      Math.abs(f.bb100 + 25) < 0.001, f.bb100.toFixed(4))
  }
  {
    // Heads-up reverses the blinds: the button posts the small blind and the
    // other seat posts the big. A folder still loses 1 + 2 per orbit, but an
    // orbit is two hands rather than six, so it is 1.5 chips a hand = -75.
    const out = measure([folder, caller], { hands: 4000, seed: 4, startingStack: 200 })
    check('heads-up blinds are reversed',
      Math.abs(out.results[0].bb100 + 75) < 0.001, out.results[0].bb100.toFixed(4))
  }

  console.log('Betting rules')
  {
    // A min-raise war: every raise must be at least the size of the last one.
    const rng = makeRng(11)
    let violations = 0
    let raises = 0
    const bots = [
      makeRandomBot('a', rng, true), makeRandomBot('b', rng, true),
      makeRandomBot('c', rng, true), makeRandomBot('d', rng, true)
    ]
    for (let i = 0; i < 5000; i++) {
      const res = playHand({
        bots,
        stacks: [200, 200, 200, 200],
        button: i % 4,
        smallBlind: 1,
        bigBlind: 2,
        deck: shuffle(makeDeck(), rng)
      })
      let street = null
      let currentBet = 0
      let lastRaise = 2
      for (const a of res.actions) {
        if (a.street !== street) {
          street = a.street
          currentBet = street === 'preflop' ? 2 : 0
          lastRaise = 2
        }
        if (a.type === 'raise') {
          raises++
          const size = a.to - currentBet
          // A raise is either a legal full raise or an all-in for less.
          const seatAllIn = a.allIn
          if (size < lastRaise && !seatAllIn) violations++
          if (size >= lastRaise) lastRaise = size
          currentBet = a.to
        }
      }
    }
    check('every raise is a full raise or an all-in', violations === 0,
      violations + ' of ' + raises)
    console.log('  ' + raises.toLocaleString() + ' raises checked')
  }

  console.log('Rake')
  {
    // A table of pure callers builds a 6-chip pot, and 5% of that floors to
    // nothing -- which is correct, and also why the lineup here needs someone
    // building pots worth raking.
    const lineup = [maniac, caller, caller]
    const noRake = measure(lineup, { hands: 3000, seed: 9 })
    const raked = measure(lineup, {
      hands: 3000, seed: 9, rake: { percent: 0.05, cap: 12, noFlopNoDrop: true }
    })
    check('rake is taken out of the pot', raked.rakeTotal > 0, raked.rakeTotal)
    const sumNo = noRake.results.reduce((a, r) => a + r.chips, 0)
    const sumRaked = raked.results.reduce((a, r) => a + r.chips, 0)
    check('an unraked table is zero sum', sumNo === 0, sumNo)
    check('a raked table loses exactly the rake',
      sumRaked === -raked.rakeTotal, sumRaked + ' vs -' + raked.rakeTotal)
  }

  {
    // No flop, no drop. A table that folds round to the big blind every hand
    // never sees a flop, so it can never be raked.
    const out = measure([folder, folder, folder, folder], {
      hands: 2000, seed: 12, rake: { percent: 0.5, cap: 100, noFlopNoDrop: true }
    })
    check('a hand that ends before the flop is not raked', out.rakeTotal === 0,
      out.rakeTotal)
  }

  console.log('Duplicate dealing')
  {
    // Rotating the lineup one seat per replay puts every strategy in every
    // seat on the same deck. When the rotation does not change the shape of
    // the hand -- everyone calling, nobody folding -- the per-seat results are
    // identical across rotations and each strategy's total is the whole
    // table's, which is zero. The cancellation is then exact, not approximate.
    const dup = measure([caller, caller, maniac, caller], {
      hands: 8000, seed: 21, paired: true
    })
    const worst = Math.max(...dup.results.map((r) => r.se))
    check('rotation cancels card luck exactly when the hand shape is fixed',
      worst === 0, worst)

    // Once strategies fold selectively the rotations really are different
    // games, so the cancellation is partial. Reported rather than asserted at
    // a threshold, because the size of it is a property of the lineup.
    const flat = measure([rock, caller, maniac, caller], { hands: 20000, seed: 21 })
    const mixed = measure([rock, caller, maniac, caller], {
      hands: 20000, seed: 21, paired: true
    })
    const flatSe = flat.results.reduce((a, r) => a + r.se, 0) / 4
    const mixedSe = mixed.results.reduce((a, r) => a + r.se, 0) / 4
    check('duplicate dealing does not make the error bars worse', mixedSe < flatSe,
      mixedSe.toFixed(3) + ' vs ' + flatSe.toFixed(3))
    console.log('  mixed lineup mean SE  flat ' + flatSe.toFixed(2) +
      '   duplicate ' + mixedSe.toFixed(2) +
      '   (' + (flatSe / mixedSe).toFixed(1) + 'x tighter)')

    const sum = mixed.results.reduce((a, r) => a + r.chips, 0)
    check('duplicate run is exactly zero sum', sum === 0, sum)
  }

  console.log('Paired comparison')
  {
    const field = [caller, maniac, caller, caller, makeRock('field')]

    // The same strategy against itself must difference to exactly zero, with
    // no error bar at all -- every hand cancels because the two never diverge.
    const same = compare(rock, makeRock('Rock (copy)'), field,
      { hands: 4000, seed: 33 })
    check('a strategy compared with itself differs by exactly zero',
      same.diff.bb100 === 0 && same.diff.se === 0,
      same.diff.bb100 + ' +/- ' + same.diff.se)
    check('a strategy compared with itself never diverges',
      same.divergenceRate === 0, same.divergenceRate)

    // How much pairing is worth depends entirely on how often the change
    // actually changes a hand. A narrow change leaves almost every hand
    // identical, and identical hands cancel to exactly zero and contribute no
    // noise at all; a sweeping one has to be paid for in variance like any
    // other measurement. Both are reported because the contrast is the useful
    // part -- it says small, surgical changes are cheap to evaluate and broad
    // ones are not.
    const narrow = compare(rock, makeRock('Rock (tighter post)', { postflopCall: 2 }),
      field, { hands: 20000, seed: 33 })
    const broad = compare(rock, makeRock('Rock (looser pre)', { preflopCall: 10 }),
      field, { hands: 20000, seed: 33 })

    check('pairing shrinks the error bar on a narrow change',
      narrow.reduction > 5, narrow.reduction.toFixed(1) + 'x')
    check('pairing never makes the error bar worse',
      broad.reduction > 1, broad.reduction.toFixed(1) + 'x')

    for (const [label, out] of [['narrow', narrow], ['broad ', broad]]) {
      console.log('  ' + label + '  diverged on ' +
        (out.divergenceRate * 100).toFixed(2).padStart(5) + '% of hands' +
        '   SE ' + out.unpairedSe.toFixed(2).padStart(6) + ' -> ' +
        out.diff.se.toFixed(2).padStart(5) +
        '   (' + out.reduction.toFixed(1) + 'x)')
    }
  }

  console.log(failures === 0 ? '\nAll checks passed.' : '\n' + failures + ' CHECK(S) FAILED')
  return failures
}

// -------------------------------------------------------------------- main

// Only when run directly. texas-results.js requires this file for `measure`.
const arg = require.main === module ? process.argv[2] : null

// A field of personalities, and the stats it produces. This is the calibration
// check: the archetypes are only worth their names if a nit really does play
// tight and a station really does call too much, measured rather than asserted.
//
// Reference points for 6-max cash, from the way these stats are normally
// quoted: a solid regular runs about 22/18 with an aggression factor near 2.5
// and sees a showdown on roughly a quarter of hands; a loose passive player
// runs 40+/5 with an AF below 1.
const runPlayers = (hands) => {
  const { archetype, makeTracker } = require('./texas-players')
  const rng = makeRng(4242)
  const field = [
    archetype('nit', 0.75, rng, 'Nit .75'),
    archetype('tag', 0.85, rng, 'TAG .85'),
    archetype('lag', 0.80, rng, 'LAG .80'),
    archetype('station', 0.30, rng, 'Station .30'),
    archetype('maniac', 0.25, rng, 'Maniac .25'),
    archetype('bluffer', 0.55, rng, 'Bluffer .55')
  ]
  const tracker = makeTracker(field.length)
  const out = measure(field, { hands, seed: 5, tracker })

  console.log('\nPersonality field, 6-max 1/2, 100bb, no rake  (' +
    out.handsPlayed.toLocaleString() + ' hands)')
  console.log('  showdown ' + (out.showdownRate * 100).toFixed(1) +
    '%   (a real 6-max game runs 25-30%)')
  console.log('  ' + 'player'.padEnd(13) + 'VPIP'.padStart(6) + 'PFR'.padStart(6) +
    'AF'.padStart(6) + 'WTSD'.padStart(7) + 'bb/100'.padStart(10))
  for (const s of tracker.summary(field.map((f) => f.name), 2)) {
    console.log('  ' + s.name.padEnd(13) +
      s.vpip.toFixed(1).padStart(6) + s.pfr.toFixed(1).padStart(6) +
      (isFinite(s.af) ? s.af.toFixed(2) : 'inf').padStart(6) +
      s.wtsd.toFixed(1).padStart(7) + s.bb100.toFixed(1).padStart(10))
  }

  // The same archetype at three proficiencies. If the two dials are really
  // independent, these should stay recognisably the same personality and
  // differ in how well it is executed -- not drift into a different player.
  console.log('\nOne archetype (LAG) at three proficiencies')
  const rng2 = makeRng(77)
  const ladder = [
    archetype('lag', 0.15, rng2, 'LAG .15'),
    archetype('lag', 0.50, rng2, 'LAG .50'),
    archetype('lag', 0.90, rng2, 'LAG .90'),
    archetype('tag', 0.60, rng2, 'TAG .60'),
    archetype('station', 0.40, rng2, 'Station'),
    archetype('nit', 0.60, rng2, 'Nit')
  ]
  const t2 = makeTracker(ladder.length)
  measure(ladder, { hands, seed: 6, tracker: t2 })
  console.log('  ' + 'player'.padEnd(13) + 'VPIP'.padStart(6) + 'PFR'.padStart(6) +
    'AF'.padStart(6) + 'WTSD'.padStart(7) + 'bb/100'.padStart(10))
  for (const s of t2.summary(ladder.map((f) => f.name), 2)) {
    console.log('  ' + s.name.padEnd(13) +
      s.vpip.toFixed(1).padStart(6) + s.pfr.toFixed(1).padStart(6) +
      (isFinite(s.af) ? s.af.toFixed(2) : 'inf').padStart(6) +
      s.wtsd.toFixed(1).padStart(7) + s.bb100.toFixed(1).padStart(10))
  }
}

if (arg === '--players') {
  runPlayers(Number(process.argv[3]) || 40000)
} else if (arg === '--watch') {
  const hands = Math.max(1, Number(process.argv[3]) || 1)
  const seed = process.argv[4] !== undefined ? Number(process.argv[4]) : Date.now() >>> 0
  const { archetype } = require('./texas-players')
  const { fieldSkill } = require('./texas-calibrate')
  const rng = makeRng(seed)
  // The same lineup texas-results.js calls the realistic table: each type at
  // the proficiency it was fitted at, with a second tag in the last seat.
  const lineup = ['nit', 'tag', 'lag', 'station', 'maniac', 'tag']
  const bots = lineup.map((k, i) => archetype(k, fieldSkill(k), rng,
    k + (lineup.indexOf(k) !== i ? ' (2)' : '')))
  console.log('Watching ' + hands + ' hand' + (hands > 1 ? 's' : '') +
    '  --  ' + lineup.map((k, i) => k + (lineup.indexOf(k) !== i ? ' (2)' : '')).join('/') +
    ' at their fitted proficiencies, 6-max 1/2, 100bb, no rake  (seed ' + seed + ')')
  for (let h = 0; h < hands; h++) {
    console.log('')
    const res = playHand({
      bots,
      stacks: new Array(bots.length).fill(200),
      button: h % bots.length,
      smallBlind: 1,
      bigBlind: 2,
      rng,
      log: (s) => console.log(s)
    })
    for (let s = 0; s < bots.length; s++) {
      if (bots[s].observe) bots[s].observe(res, s)
    }
  }
} else if (arg === '--test') {
  process.exit(runTests() === 0 ? 0 : 1)
} else if (arg && Number(arg)) {
  const hands = Number(arg)
  const paired = process.argv.includes('--paired')
  const rng = makeRng(99)
  // Placeholder strategies, not a model of anybody. What the numbers below
  // demonstrate is that the harness separates them and puts an error bar on
  // the separation -- the strategies themselves are the next piece of work.
  const lineup = [
    makeRock('Tight', { preflopCall: 17 }),
    makeRock('Solid', { preflopCall: 15 }),
    makeRock('Loose', { preflopCall: 12 }),
    makeRock('Wide', { preflopCall: 9 }),
    caller,
    makeRandomBot('Random', rng)
  ]

  report('6-max, 1/2, 100bb, no rake', measure(lineup, { hands, seed: 5, paired }))
  report('6-max, 1/2, 100bb, 5% rake capped at 6', measure(lineup, {
    hands, seed: 5, paired, rake: { percent: 0.05, cap: 6, noFlopNoDrop: true }
  }))

  reportCompare(compare(
    makeRock('Tight', { preflopCall: 15 }),
    makeRock('Looser', { preflopCall: 12 }),
    lineup.slice(1),
    { hands: Math.min(hands, 40000), seed: 7 }
  ))
} else if (require.main === module) {
  const rng = makeRng(Date.now() >>> 0)
  const lineup = [
    { name: 'Rock', act: rock.act },
    { name: 'Caller', act: caller.act },
    { name: 'Maniac', act: maniac.act },
    makeRandomBot('Random', rng),
    { name: 'Rock2', act: rock.act },
    { name: 'Caller2', act: caller.act }
  ]
  playHand({
    bots: lineup,
    stacks: new Array(6).fill(200),
    button: 0,
    smallBlind: 1,
    bigBlind: 2,
    rake: { percent: 0.05, cap: 6, noFlopNoDrop: true },
    rng,
    log: (s) => console.log(s)
  })
}

module.exports = { measure, compare, makeRock, makeRandomBot, folder, caller, maniac }
