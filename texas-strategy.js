// A preflop strategy a person can actually use, measured against the field.
//
// Everything else in the Hold'em half describes *other* players. This file
// asks the question a player at the table asks: given the people I am sitting
// with, what should I do with this hand from this seat?
//
// The answer has to be in a form a human can carry to a table, which rules out
// anything that needs a calculator at decision time. So the strategy is a
// chart -- the thing real players memorise -- keyed only on what anyone can see
// at a glance:
//
//   * the seat         BTN SB BB UTG HJ CO
//   * the situation    unopened, limped, raised, re-raised after I raised,
//                      or 3-bet before I acted
//   * the hand         one of the 169 starting hands
//
// and the actions are the three a player chooses between, with the sizings a
// player uses without thinking: open 3bb plus 1bb a limper, 3-bet 3x in
// position and 4x from the blinds, 4-bet 2.3x, and all in once a raise would
// commit a third of the stack. After the flop the hero plays the fitted TAG --
// which estimates the way a player does (texas-equity.js: a feel for hand
// strength and outs by the 2x/4x rule), not the way a solver does.
//
// How the chart is found is the same move odds.js makes for blackjack, and the
// opposite of the evolutionary search that failed there. Nothing is searched.
// Each decision is valued directly: the hand is played out once as the chart
// says, then replayed from the same deck with the same random draws for
// everybody, the hero forced into each other action at that one decision and
// following the chart everywhere else. Everything before the decision is
// identical, so the difference between the replays is the value of the
// decision and nothing else. Averaged over many deals, every cell of the chart
// gets an expected value per action with a standard error, and the chart takes
// whichever action is clearly best.
//
// The values depend on the chart itself -- opening a hand is worth more if you
// play well when 3-bet -- so this runs as policy iteration: estimate every
// cell, update the ones that are clearly wrong, estimate again.
//
// What it cannot tell you is written down in advance: a chart solved here is
// the best response to *this* field, which is fitted to how often real players
// act, not to how much their mistakes cost. That is why it can be solved
// against several fields, and why the output marks which cells agree.
//
//   node texas-strategy.js                    solve against the realistic field
//   node texas-strategy.js 400 --field tough  400 deals per seat/hand per pass
//   node texas-strategy.js --no-rake          no rake (default: 5%, cap 3bb)
//   node texas-strategy.js --show             print the saved chart(s)
//   node texas-strategy.js --agree            what the saved fields agree on

const fs = require('fs')
const path = require('path')
const { playHand, makeRng, shuffle } = require('./texas-engine')
const { archetype } = require('./texas-players')
const { fieldSkill } = require('./texas-calibrate')
const { handIndex, handLabel, preflopEquity } = require('./texas-equity')
const { RANKS } = require('./texas-eval')

const OUT_FILE = path.join(__dirname, 'strategy.json')
const BIG_BLIND = 2
const STACK = 200
const POSITIONS = ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO']
const ACTING_ORDER = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB']
const SITUATIONS = ['unopened', 'limped', 'raised', 'reraised', '3bet']
const RAKE = { percent: 0.05, cap: 3 * BIG_BLIND, noFlopNoDrop: true }

// The opponents the hero is solved against. `realistic` is the fitted table
// from texas-results.js with the hero in the second TAG's chair; the other two
// bracket it, so a cell that holds in all three is not an artefact of one mix.
const FIELDS = {
  realistic: ['nit', 'tag', 'lag', 'station', 'maniac'],
  tough: ['tag', 'tag', 'nit', 'lag', 'tag'],
  soft: ['station', 'station', 'maniac', 'lag', 'tag']
}

// ---------------------------------------------------------- reading a spot

const positionOf = (v) => POSITIONS[(v.seat - v.button + v.numPlayers) % v.numPlayers]

// What has happened before the hero acts, in the words a player would use.
// Blinds are posted outside the action history, so a limp is any call before
// the first raise, the small blind completing included.
const situationOf = (v) => {
  let raises = 0
  let limpers = 0
  let heroRaised = false
  for (const a of v.history) {
    if (a.street !== 'preflop') continue
    if (a.type === 'raise') {
      raises++
      if (a.seat === v.seat) heroRaised = true
    } else if (a.type === 'call' && raises === 0 && a.seat !== v.seat) {
      limpers++
    }
  }
  if (raises === 0) return limpers > 0 ? 'limped' : 'unopened'
  if (heroRaised) return 'reraised'
  return raises === 1 ? 'raised' : '3bet'
}

const keyOf = (pos, situation, hand) => pos + '|' + situation + '|' + handLabel(hand)

// The chart's vocabulary. `call` doubles as a check when there is nothing to
// call, and folding is not offered then because a free card is never worse.
const legalOf = (v) => {
  const legal = v.toCall > 0 ? ['fold', 'call'] : ['call']
  if (v.canRaise) legal.push('raise')
  return legal
}

// The sizings a player uses without thinking about them.
const raiseTo = (v, situation) => {
  const bb = v.bigBlind
  const currentBet = v.committed[v.seat] + v.toCall
  let callers = 0
  let raises = 0
  for (const a of v.history) {
    if (a.street !== 'preflop') continue
    if (a.type === 'raise') {
      raises++
      callers = 0
    } else if (a.type === 'call') {
      callers++
    }
  }
  const pos = positionOf(v)
  let to
  if (raises === 0) to = 3 * bb + callers * bb
  else if (raises === 1) to = (pos === 'SB' || pos === 'BB' ? 4 : 3) * currentBet + callers * currentBet
  else to = 2.3 * currentBet
  // A raise that commits a third of the stack is a raise that cannot fold, so
  // it may as well be all of it.
  if (to > (v.stack + v.committed[v.seat]) / 3) to = v.maxRaiseTo
  return Math.max(v.minRaiseTo, Math.min(v.maxRaiseTo, Math.round(to)))
}

// ------------------------------------------------------------------ the hero
//
// Plays the chart before the flop and hands everything after it to `post`.
// Cells the chart has no answer for yet are played the way `post` would play
// them, translated into the chart's vocabulary and sizings, so the chart can
// start empty and fill in.
//
// Stateless apart from `override` and `trace`, which only the solver sets: the
// decision number is read off the history, so the same bot can be replayed.
const makeHero = (name, chart, post) => {
  const hero = {
    name,
    chart,
    override: null,
    trace: null,
    act: (v) => {
      if (v.board.length > 0) return post.act(v)

      let k = 0
      for (const a of v.history) if (a.seat === v.seat && a.street === 'preflop') k++
      const situation = situationOf(v)
      const key = keyOf(positionOf(v), situation, handIndex(v.holeCards[0], v.holeCards[1]))
      const legal = legalOf(v)

      let action = chart.get(key)
      if (!action || !legal.includes(action)) {
        const said = post.act(v).action
        action = said === 'raise' ? 'raise' : said === 'fold' && v.toCall > 0 ? 'fold' : 'call'
        if (!legal.includes(action)) action = 'call'
      }
      // The solver records the decision as the chart would have made it, then
      // replaces it -- after `post` has drawn its random numbers, so a forced
      // replay consumes exactly the draws the original did.
      if (hero.trace) hero.trace.push({ k, key, legal, action })
      if (hero.override && hero.override.k === k) action = hero.override.action

      if (action === 'raise') return { action: 'raise', to: raiseTo(v, situation) }
      if (action === 'call') return { action: 'call' }
      return { action: 'fold' }
    }
  }
  return hero
}

// ---------------------------------------------------------------- the table
//
// Every random draw anybody makes goes through one stream whose state the
// solver resets before each replay. That is the whole of the common random
// numbers: the opponents do exactly what they did last time, right up to the
// moment the hero does something different.
const makeTable = (fieldName) => {
  const kinds = FIELDS[fieldName]
  if (!kinds) throw new Error('unknown field ' + fieldName)
  const stream = { next: makeRng(1) }
  const rng = () => stream.next()
  const opponents = kinds.map((k, i) => archetype(k, fieldSkill(k), rng, k + i))
  const post = archetype('tag', fieldSkill('tag'), rng, 'hero-post')
  return { stream, opponents, post }
}

// Deal one hand with the hero in `seat` holding `hole`, the rest of the deck
// shuffled. The engine deals one card to each seat left of the button, then a
// second round, so the hero's cards go in the slots it will reach for.
const buildDeck = (hole, seat, button, n, rng) => {
  const rest = []
  for (let c = 0; c < 52; c++) if (c !== hole[0] && c !== hole[1]) rest.push(c)
  shuffle(rest, rng)
  const slot = (seat - button - 1 + 2 * n) % n
  const deck = new Array(52)
  deck[slot] = hole[0]
  deck[n + slot] = hole[1]
  let r = 0
  for (let i = 0; i < 52; i++) if (deck[i] === undefined) deck[i] = rest[r++]
  return deck
}

// A concrete pair of cards for one of the 169 hands, suits chosen at random.
const dealHand = (idx, rng) => {
  const a = Math.floor(idx / 13)
  const b = idx % 13
  const s1 = Math.floor(rng() * 4)
  if (a === b) {
    const s2 = (s1 + 1 + Math.floor(rng() * 3)) % 4
    return [a * 4 + s1, a * 4 + s2]
  }
  const hi = a > b ? a : b
  const lo = a > b ? b : a
  if (a > b) return [hi * 4 + s1, lo * 4 + s1]
  return [hi * 4 + s1, lo * 4 + (s1 + 1 + Math.floor(rng() * 3)) % 4]
}

// Seat the hero and the opponents, in a random order so nobody is always on
// the hero's left, and return a function that plays the hand from scratch.
const makeDeal = (table, hero, pos, hand, rng, rake) => {
  const n = 6
  const button = 0
  const seat = POSITIONS.indexOf(pos)
  const others = shuffle(table.opponents.slice(), rng)
  const bots = []
  let o = 0
  for (let s = 0; s < n; s++) bots.push(s === seat ? hero : others[o++])
  const deck = buildDeck(dealHand(hand, rng), seat, button, n, rng)
  const seed = Math.floor(rng() * 4294967296)

  return (override) => {
    table.stream.next = makeRng(seed)
    hero.override = override
    hero.trace = override ? null : []
    const res = playHand({
      bots,
      stacks: new Array(n).fill(STACK),
      button,
      smallBlind: BIG_BLIND / 2,
      bigBlind: BIG_BLIND,
      rake,
      deck
    })
    const trace = hero.trace
    hero.override = null
    hero.trace = null
    return { delta: res.deltas[seat], trace }
  }
}

// ------------------------------------------------------------- the estimates
//
// Per cell, the value of each action and of the difference between each pair
// of them. The pair statistics are what decisions are made on: every action at
// a decision is played from the same deal, so the differences are paired and
// carry far less noise than the values themselves.
const makeCells = () => {
  const cells = new Map()
  return {
    cells,
    // How many deals each seat/hand pair got, so a cell's count can be turned
    // back into how often the spot is reached.
    dealt: new Map(),
    add: (key, q) => {
      let c = cells.get(key)
      if (!c) {
        c = { n: 0, sum: {}, pair: {} }
        cells.set(key, c)
      }
      c.n++
      const acts = Object.keys(q)
      for (const a of acts) c.sum[a] = (c.sum[a] || 0) + q[a]
      for (let i = 0; i < acts.length; i++) {
        for (let j = i + 1; j < acts.length; j++) {
          const [x, y] = [acts[i], acts[j]].sort()
          const d = q[x] - q[y]
          const p = c.pair[x + '|' + y] || (c.pair[x + '|' + y] = { n: 0, s: 0, ss: 0 })
          p.n++
          p.s += d
          p.ss += d * d
        }
      }
    }
  }
}

// Mean of (x - y) in big blinds per decision, with its standard error.
const pairDiff = (c, x, y) => {
  const flip = x > y
  const p = c.pair[flip ? y + '|' + x : x + '|' + y]
  if (!p || p.n < 2) return null
  const m = p.s / p.n
  const v = Math.max(0, (p.ss - p.n * m * m) / (p.n - 1))
  const se = Math.sqrt(v / p.n)
  return { mean: (flip ? -m : m) / BIG_BLIND, se: se / BIG_BLIND, n: p.n }
}

const valuesOf = (c) => {
  const out = {}
  for (const a of Object.keys(c.sum)) out[a] = c.sum[a] / c.n / BIG_BLIND
  return out
}

// ----------------------------------------------------------------- solving

const solve = ({ fieldName, perCell, passes, focus = 3, rake, seed, minN, log }) => {
  const table = makeTable(fieldName)
  const chart = new Map()
  const hero = makeHero('hero', chart, table.post)
  const rng = makeRng(seed)

  // Deal `deals` hands to each (seat, hand) pair that `want` admits, and add
  // every decision the hero meets along the way to `est`. Every sample of a
  // cell comes from that cell's own seat and hand, so dealing some pairs more
  // than others biases nothing -- it only narrows their error bars.
  const sample = (est, deals, want) => {
    let plays = 0
    for (let rep = 0; rep < deals; rep++) {
      for (const pos of POSITIONS) {
        for (let hand = 0; hand < 169; hand++) {
          if (want && !want(pos, hand)) continue
          const dk = pos + '|' + handLabel(hand)
          est.dealt.set(dk, (est.dealt.get(dk) || 0) + 1)
          const play = makeDeal(table, hero, pos, hand, rng, rake)
          const base = play(null)
          plays++
          for (const t of base.trace) {
            const q = { [t.action]: base.delta }
            for (const a of t.legal) {
              if (a === t.action) continue
              q[a] = play({ k: t.k, action: a }).delta
              plays++
            }
            est.add(t.key, q)
          }
        }
      }
    }
    return plays
  }

  // A cell with no entry takes its best-looking action; a cell that has one
  // only changes it when the alternative is better by two standard errors, so
  // a noisy pass cannot flip a settled cell back and forth.
  const update = (est) => {
    let set = 0
    let changed = 0
    for (const [key, c] of est.cells) {
      if (c.n < minN) continue
      const vals = valuesOf(c)
      const acts = Object.keys(vals)
      let best = acts[0]
      for (const a of acts) if (vals[a] > vals[best]) best = a
      const cur = chart.get(key)
      if (!cur || !(cur in vals)) {
        chart.set(key, best)
        set++
      } else if (best !== cur) {
        const d = pairDiff(c, best, cur)
        if (d && d.mean > 2 * d.se) {
          chart.set(key, best)
          changed++
        }
      }
    }
    return set + ' cells filled, ' + changed + ' changed'
  }

  // Policy iteration. Each pass starts a fresh estimate, because the values
  // depend on the chart and the chart just changed.
  let est = null
  for (let pass = 1; pass <= passes; pass++) {
    const started = Date.now()
    est = makeCells()
    const plays = sample(est, perCell, null)
    const note = update(est)
    if (log) {
      log('  pass ' + pass + ': ' + perCell + ' deals per seat and hand, ' +
        plays.toLocaleString() + ' hands in ' +
        ((Date.now() - started) / 1000).toFixed(0) + 's; ' + note)
    }
  }

  // Then more deals only where the answer is still in doubt: a seat and hand
  // with any charted cell whose best action is not yet two standard errors
  // clear of the next. Most of the chart is settled after the first passes --
  // aces are a raise, 72o is a fold -- and dealing it again buys nothing.
  for (let round = 1; round <= focus; round++) {
    const unsure = new Set()
    for (const [key, c] of est.cells) {
      if (c.n < minN) continue
      if (confidenceOf(c, chart.get(key)) < 2) {
        const [pos, , label] = key.split('|')
        unsure.add(pos + '|' + label)
      }
    }
    if (!unsure.size) break
    const started = Date.now()
    const plays = sample(est, perCell, (pos, hand) => unsure.has(pos + '|' + handLabel(hand)))
    const note = update(est)
    if (log) {
      log('  focus ' + round + ': ' + unsure.size + ' seat/hand pairs still close, ' +
        plays.toLocaleString() + ' hands in ' +
        ((Date.now() - started) / 1000).toFixed(0) + 's; ' + note)
    }
  }

  // The hysteresis above is for stability while the values are still moving.
  // The chart handed back takes each cell's best estimated action on the final
  // estimates -- otherwise it keeps choices made on an early, noisy pass that
  // the latest data no longer supports.
  for (const [key, c] of est.cells) {
    if (c.n < minN) continue
    const vals = valuesOf(c)
    let best = null
    for (const a of Object.keys(vals)) if (best === null || vals[a] > vals[best]) best = a
    chart.set(key, best)
  }

  return { chart, cells: est.cells, dealt: est.dealt, table }
}

// ------------------------------------------------------------- the verdict
//
// Replays the solved chart and the plain TAG from every seat on the same deals
// with the same draws, and differences them hand by hand. This is the only
// number that says whether the chart is worth learning, so it is measured on
// fresh deals the solver never saw.
const validate = ({ table, chart, rake, hands, seed }) => {
  const hero = makeHero('chart', chart, table.post)
  const rng = makeRng(seed)
  const decks = Math.max(1, Math.floor(hands / 6))
  const acc = { chart: [], tag: [], diff: [] }
  for (let d = 0; d < decks; d++) {
    const others = shuffle(table.opponents.slice(), rng)
    const deck = shuffle([...Array(52).keys()], rng)
    const seed2 = Math.floor(rng() * 4294967296)
    const tot = { chart: 0, tag: 0 }
    for (let seat = 0; seat < 6; seat++) {
      for (const who of ['chart', 'tag']) {
        const bots = []
        let o = 0
        for (let s = 0; s < 6; s++) {
          bots.push(s === seat ? (who === 'chart' ? hero : table.post) : others[o++])
        }
        table.stream.next = makeRng(seed2 + seat)
        const res = playHand({
          bots, stacks: new Array(6).fill(STACK), button: 0,
          smallBlind: BIG_BLIND / 2, bigBlind: BIG_BLIND, rake, deck
        })
        tot[who] += res.deltas[seat]
      }
    }
    acc.chart.push(tot.chart)
    acc.tag.push(tot.tag)
    acc.diff.push(tot.chart - tot.tag)
  }
  const stat = (xs) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length
    const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1)
    return { bb100: m / 6 / BIG_BLIND * 100, se: Math.sqrt(v / xs.length) / 6 / BIG_BLIND * 100 }
  }
  return { hands: decks * 6, chart: stat(acc.chart), tag: stat(acc.tag), diff: stat(acc.diff) }
}

// ---------------------------------------------------------------- printing
//
// Ranges in the shorthand players write them in: "77+", "A2s+", "KTs+",
// "QJo", "T9s-65s" is not attempted -- a run of kickers under one high card is
// the unit, which is how charts are actually memorised.
const rangeText = (hands) => {
  const has = new Set(hands)
  const parts = []
  const runs = (list) => {
    const out = []
    let start = null
    let prev = null
    for (const x of list) {
      if (start === null) start = prev = x
      else if (x === prev - 1) prev = x
      else {
        out.push([start, prev])
        start = prev = x
      }
    }
    if (start !== null) out.push([start, prev])
    return out
  }

  const pairs = []
  for (let r = 12; r >= 0; r--) if (has.has(r * 13 + r)) pairs.push(r)
  for (const [hi, lo] of runs(pairs)) {
    if (hi === 12 && hi !== lo) parts.push(RANKS[lo] + RANKS[lo] + '+')
    else if (hi === lo) parts.push(RANKS[hi] + RANKS[hi])
    else parts.push(RANKS[hi] + RANKS[hi] + '-' + RANKS[lo] + RANKS[lo])
  }

  for (const suited of [true, false]) {
    const tag = suited ? 's' : 'o'
    for (let hi = 12; hi >= 1; hi--) {
      const lows = []
      for (let lo = hi - 1; lo >= 0; lo--) {
        if (has.has(suited ? hi * 13 + lo : lo * 13 + hi)) lows.push(lo)
      }
      for (const [top, bottom] of runs(lows)) {
        const H = RANKS[hi]
        if (top === hi - 1 && top !== bottom) parts.push(H + RANKS[bottom] + tag + '+')
        else if (top === bottom) parts.push(H + RANKS[top] + tag)
        else parts.push(H + RANKS[top] + tag + '-' + H + RANKS[bottom] + tag)
      }
    }
  }
  return parts.join(' ')
}

const combos = (hands) => hands.reduce((n, h) => {
  const a = Math.floor(h / 13)
  const b = h % 13
  return n + (a === b ? 6 : a > b ? 4 : 12)
}, 0)

// How sure the chart is about a cell: the gap to the next-best action in
// standard errors. A close cell is one where either choice is fine, which is
// worth knowing too -- it is the part of the chart not worth memorising hard.
const confidenceOf = (c, action) => {
  let worst = Infinity
  for (const a of Object.keys(c.sum)) {
    if (a === action) continue
    const d = pairDiff(c, action, a)
    if (d) worst = Math.min(worst, d.se > 0 ? d.mean / d.se : Infinity)
  }
  return worst
}

const printChart = (entries, minN) => {
  for (const situation of SITUATIONS) {
    const rows = []
    for (const pos of ACTING_ORDER) {
      const by = { raise: [], call: [], close: [] }
      let seen = 0
      for (let h = 0; h < 169; h++) {
        const e = entries[keyOf(pos, situation, h)]
        if (!e || e.n < minN) continue
        seen++
        if (e.action === 'raise') by.raise.push(h)
        if (e.action === 'call') by.call.push(h)
        if (e.z < 2) by.close.push(h)
      }
      if (seen) rows.push({ pos, seen, ...by })
    }
    if (!rows.length) continue
    console.log('\n  ' + situation.toUpperCase())
    for (const r of rows) {
      const callWord = situation === 'unopened' || situation === 'limped' ? 'limp' : 'call'
      const lines = []
      if (r.raise.length) {
        lines.push('raise ' + (combos(r.raise) / 1326 * 100).toFixed(1) + '%: ' + rangeText(r.raise))
      }
      if (r.call.length) {
        lines.push(callWord + '  ' + (combos(r.call) / 1326 * 100).toFixed(1) + '%: ' + rangeText(r.call))
      }
      if (!lines.length) lines.push('fold everything')
      console.log('    ' + r.pos.padEnd(4) + lines.join('\n        '))
      const notes = []
      if (r.close.length) {
        notes.push(r.close.length + ' close' + (r.close.length <= 12
          ? ': ' + r.close.map(handLabel).join(' ') : '') + ' -- either choice is within 2 SE')
      }
      if (r.seen < 169) notes.push((169 - r.seen) + ' hands too rarely reach this spot to chart')
      if (notes.length) console.log('        (' + notes.join('; ') + ')')
    }
  }
}

// ------------------------------------------------------- the rule of thumb
//
// A full chart is 169 answers per seat. What a player actually carries is
// "open the top 15% from the cutoff" -- one number, applied to a ranking they
// already know. So for each seat the chart is also boiled down to the single
// cutoff that loses least, and the loss is reported: the price of the rule of
// thumb against the full chart, in big blinds per 100 hands dealt at that seat.
//
// Hands are weighted by how often they are dealt (combinations) and by how
// often, once dealt in that seat, they reach the spot.
const ruleOfThumb = (entries, order, situation, actions) => {
  const out = []
  for (const pos of ACTING_ORDER) {
    const rows = []
    for (const h of order) {
      const e = entries[keyOf(pos, situation, h)]
      if (!e) continue
      const a = Math.floor(h / 13)
      const b = h % 13
      const weight = (a === b ? 6 : a > b ? 4 : 12) / 1326
      rows.push({ h, e, weight })
    }
    if (rows.length < 100) continue
    const ev = (e, a) => (e.ev[a] !== undefined ? e.ev[a] : -1e6)
    const w = rows.map((r) => r.weight * r.e.reach)
    const full = rows.reduce((s, r, i) => s + w[i] * ev(r.e, r.e.action), 0)

    // Two cutoffs: the top X% take `actions[0]`, the next Y% `actions[1]`,
    // the rest `actions[2]`. Prefix sums make every pair of cutoffs a lookup.
    const n = rows.length
    const prefix = actions.map((a) => {
      const s = [0]
      for (let i = 0; i < n; i++) s.push(s[i] + w[i] * ev(rows[i].e, a))
      return s
    })
    const pctAt = [0]
    for (let i = 0; i < n; i++) pctAt.push(pctAt[i] + rows[i].weight * 100)
    let best = null
    for (let c1 = 0; c1 <= n; c1++) {
      for (let c2 = c1; c2 <= n; c2++) {
        const total = prefix[0][c1] + (prefix[1][c2] - prefix[1][c1]) +
          (prefix[2][n] - prefix[2][c2])
        if (!best || total > best.total + 1e-12) best = { total, c1, c2 }
      }
    }
    out.push({
      pos,
      first: pctAt[best.c1],
      second: pctAt[best.c2] - pctAt[best.c1],
      loss: (full - best.total) * 100
    })
  }
  return out
}

const printRules = (entries) => {
  const order = [...Array(169).keys()].sort((x, y) => preflopEquity(y, 3) - preflopEquity(x, 3))
  console.log('\n  RULES OF THUMB  (hands ranked by equity against three random hands)')
  const show = (title, rules, verbs) => {
    if (!rules.length) return
    console.log('    ' + title)
    for (const r of rules) {
      console.log('      ' + r.pos.padEnd(4) + verbs[0] + ' the top ' + r.first.toFixed(0).padStart(2) +
        '%, ' + verbs[1] + ' the next ' + r.second.toFixed(0).padStart(2) + '%, fold the rest' +
        '   (costs ' + r.loss.toFixed(2) + ' bb/100 against the full chart)')
    }
  }
  const rules = {
    unopened: ruleOfThumb(entries, order, 'unopened', ['raise', 'call', 'fold']),
    raised: ruleOfThumb(entries, order, 'raised', ['raise', 'call', 'fold'])
  }
  show('Folded to you:', rules.unopened, ['raise', 'limp'])
  show('Facing one raise:', rules.raised, ['3-bet', 'call'])
  return rules
}

// ------------------------------------------------------------ robustness
//
// A chart solved against one field is a best response to that field, and the
// field is a fit. The defence is to solve against several and keep what they
// agree on: a cell that is the same clear answer against the realistic table,
// a table of regulars and a table of fish is not an artefact of any one of
// them. A cell counts as clear in a field when its action beats the next best
// by two standard errors there.
const printAgreement = (saved, minN) => {
  const names = Object.keys(saved)
  if (names.length < 2) {
    console.log('Solve at least two fields first (--field realistic|tough|soft).')
    return
  }
  console.log('\nAgreement across fields: ' + names.join(', '))
  for (const situation of SITUATIONS) {
    let lines = 0
    for (const pos of ACTING_ORDER) {
      let both = 0
      let agree = 0
      const robust = { raise: [], call: [] }
      const split = []
      for (let h = 0; h < 169; h++) {
        const key = keyOf(pos, situation, h)
        const es = names.map((n) => saved[n].entries[key]).filter((e) => e && e.n >= minN)
        if (es.length < names.length) continue
        both++
        const acts = new Set(es.map((e) => e.action))
        if (acts.size === 1) {
          agree++
          const a = es[0].action
          if (robust[a] && es.every((e) => e.z >= 2)) robust[a].push(h)
        } else if (es.every((e) => e.z >= 2)) {
          split.push(handLabel(h) + ' ' + es.map((e) => e.action[0]).join('/'))
        }
      }
      if (!both) continue
      if (!lines++) console.log('\n  ' + situation.toUpperCase())
      console.log('    ' + pos.padEnd(4) + agree + ' of ' + both + ' hands agree' +
        (split.length ? '; clearly different in ' + split.length : ''))
      if (robust.raise.length) console.log('        always raise: ' + rangeText(robust.raise))
      if (robust.call.length) console.log('        always call:  ' + rangeText(robust.call))
      if (split.length && split.length <= 20) {
        console.log('        field-dependent (' + names.map((n) => n[0]).join('/') + '): ' + split.join(', '))
      }
    }
  }
}

// `ev` is in big blinds per decision, relative to nothing -- the hero's whole
// result for the hand -- so differences between actions are what matter.
// `reach` is how often a hand dealt in that seat arrives at this spot.
const entriesOf = (chart, cells, dealt) => {
  const out = {}
  for (const [key, action] of chart) {
    const c = cells.get(key)
    if (!c) continue
    const ev = valuesOf(c)
    for (const a of Object.keys(ev)) ev[a] = Math.round(ev[a] * 1000) / 1000
    const z = confidenceOf(c, action)
    const [pos, , label] = key.split('|')
    const reach = c.n / (dealt.get(pos + '|' + label) || c.n)
    out[key] = {
      action,
      n: c.n,
      reach: Math.round(reach * 1000) / 1000,
      ev,
      z: Number.isFinite(z) ? Math.round(z * 10) / 10 : 99
    }
  }
  return out
}

// -------------------------------------------------------------------- main

module.exports = { makeHero, makeTable, situationOf, positionOf, raiseTo, rangeText, solve, validate, FIELDS }

if (require.main === module) {
  const args = process.argv.slice(2)
  const flag = (name, fallback) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : fallback
  }
  const minN = 20
  const saved = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : {}

  if (args.includes('--show')) {
    for (const name of Object.keys(saved)) {
      const s = saved[name]
      console.log('\n=== ' + name + ' field' + (s.rake ? ', raked' : ', no rake') + ' ===')
      printChart(s.entries, minN)
      printRules(s.entries)
    }
    process.exit(0)
  }
  if (args.includes('--agree')) {
    printAgreement(saved, minN)
    process.exit(0)
  }

  const perCell = Number(args.find((a) => /^\d+$/.test(a))) || 100
  const fieldName = flag('--field', 'realistic')
  const rake = args.includes('--no-rake') ? { percent: 0, cap: 0, noFlopNoDrop: true } : RAKE
  const passes = Number(flag('--passes', 3))

  console.log('Solving a preflop chart against the ' + fieldName + ' field (' +
    FIELDS[fieldName].join(', ') + '), ' +
    (rake.percent ? '5% rake capped at 3bb' : 'no rake'))
  const started = Date.now()
  const { chart, cells, dealt, table } = solve({
    fieldName, perCell, passes, focus: Number(flag('--focus', 3)), rake, seed: 12345, minN, log: console.log
  })
  const entries = entriesOf(chart, cells, dealt)
  printChart(entries, minN)
  const rules = printRules(entries)

  const check = validate({ table, chart, rake, hands: 120000, seed: 777 })
  console.log('\n  Against the plain fitted TAG on ' + check.hands.toLocaleString() +
    ' fresh hands, same seats and draws:')
  console.log('    chart ' + check.chart.bb100.toFixed(1) + ' +/- ' + check.chart.se.toFixed(1) +
    '   tag ' + check.tag.bb100.toFixed(1) + ' +/- ' + check.tag.se.toFixed(1) +
    '   difference ' + (check.diff.bb100 >= 0 ? '+' : '') + check.diff.bb100.toFixed(1) +
    ' +/- ' + check.diff.se.toFixed(1) + ' bb/100')

  saved[fieldName] = {
    generated: new Date().toISOString(),
    perCell, passes, rake: rake.percent > 0 ? rake : null,
    validation: check,
    rules,
    entries
  }
  fs.writeFileSync(OUT_FILE, JSON.stringify(saved))
  console.log('\nWrote strategy.json in ' + ((Date.now() - started) / 1000).toFixed(0) + 's')
}
