// The opponents at the play table (texas-play.js).
//
// Not the fitted personalities from texas-players.js, and the reason is
// money. That model is fitted to how often players act -- VPIP, PFR, AF,
// WTSD -- and it matches those, but measured from the hero's chair its
// money is far from a real table:
//
//   * Its regulars are weak. Its value model rates checking above betting
//     until a hand is close to the nuts, and it reads a hand against random
//     holdings whatever the preflop action said. A TAG at its fitted skill
//     won +48 bb/100 in the realistic field, a TAG at perfect skill +53 --
//     and plain textbook play (texas-textbook.js) won +150, taking most of
//     the fish's money and the regulars' besides.
//   * Its fish punt stacks. Personality is a bias bounded in pots, so in a
//     big pot it can be worth a whole stack: the station called off 100bb
//     with ace high and called 4-bets with A7o. Facing competent regulars
//     the two fish lost about 470 bb/100 between them, several times what
//     real fish lose.
//
// So every seat here plays one core and the types differ by its settings.
// The core is textbook play plus what real regulars do beyond it:
//
//   * Ranges are read from the whole line. Equity is a Monte Carlo against
//     each opponent's preflop range, weighted by how likely each holding was
//     to take the postflop line it took -- a bet is more often a strong
//     hand, a raise far more often, a call is something or a draw. The
//     textbook player reads the preflop action only, so it pays off.
//   * Position costs equity: a call out of position needs more, and a call
//     before the river is charged for the street it buys.
//   * A HUD. Every seat's VPIP, PFR and postflop aggression is tracked from
//     what the table saw, and ranges are widened or narrowed for the seat's
//     habits -- the maniac's bets mean less, the station is value-bet
//     thinner and not bluffed. The hero is read the same way.
//   * Mixed play: c-bets, barrels, river bluffs, 3-bet bluffs and
//     semi-bluffs at frequencies set by type, so a bet is never a sure thing.
//
// A fish is the same core with leaks turned on, which keeps them systematic
// the way real fish are: the station limps, calls with any pair or draw and
// rarely raises; the maniac opens and 3-bets wide, barrels and bluff-raises.
// Fish barely read lines (`reads`) and keep no HUD.
//
// The settings are tuned so each type's tracked stats land near the targets
// in texas-calibrate.js and the money lands near a real table: run
// `node texas-textbook.js --table` for both.

const { evaluate } = require('./texas-eval')
const { handIndex, handRank } = require('./texas-equity')
const { opponentRanges, sampleHand, positionOf, OPEN_WIDTH } = require('./texas-textbook')

// ------------------------------------------------------------------ styles
//
// Preflop
//   open      multiplier on the standard opening widths (first in)
//   iso       width multiplier for raising over limpers
//   limp      limp (or over-limp, or complete) the top limp% that don't raise
//   v3 v4 v5  value 3-bet / 4-bet / 5-bet: the top v% of hands
//   call3     flat a 3-bet with the top call3% (when stacks allow)
//   b3        chance to 3-bet bluff a speculative hand
//   pre       equity a preflop call needs above the pot odds (negative: loose)
// Postflop
//   margin    equity a call needs above the pot odds
//   future    charge calls before the river for the street they buy
//   value     equity to bet for value (heads-up; more multiway)
//   raise     equity to raise a bet for value
//   cbet      flop continuation-bet frequency, heads-up
//   barrel    turn follow-up frequency after betting the flop
//   bluff     river bluff frequency with a busted hand after betting the turn
//   stab      bet when checked to with nothing, heads-up
//   semi      semi-bluff frequency with a real draw
//   braise    bluff-raise frequency facing a bet, heads-up, before the river
//   hope      chance to call a flop or turn bet anyway with any pair or draw
//   hopeRiver chance to call a river bet anyway with any pair
//   size      bet as a fraction of the pot
// Both
//   reads     how far the line and the HUD move the range read (1 = fully)
//   skill     1 plays the thresholds exactly; lower wobbles them
const STYLES = {
  nit: {
    open: 0.72, iso: 0.6, limp: 0, v3: 2.5, v4: 1.2, v5: 0.75, call3: 4, b3: 0, pre: 0.05,
    margin: 0.05, future: true, value: 0.66, raise: 0.85, cbet: 0.6, barrel: 0.25, bluff: 0.04,
    stab: 0.15, semi: 0.25, braise: 0, hope: 0, hopeRiver: 0, size: 0.6, reads: 1, skill: 0.85
  },
  tag: {
    open: 1.15, iso: 0.6, limp: 0, v3: 3.9, v4: 1.7, v5: 0.75, call3: 9, b3: 0.3, pre: 0.02,
    margin: 0.02, future: true, value: 0.6, raise: 0.78, cbet: 0.75, barrel: 0.45, bluff: 0.15,
    stab: 0.45, semi: 0.5, braise: 0.03, hope: 0, hopeRiver: 0, size: 0.66, reads: 1, skill: 0.92
  },
  lag: {
    open: 1.7, iso: 0.7, limp: 0, v3: 6.5, v4: 2.5, v5: 1.2, call3: 13, b3: 0.35, pre: 0,
    margin: -0.02, future: true, value: 0.57, raise: 0.75, cbet: 0.85, barrel: 0.55, bluff: 0.25,
    stab: 0.55, semi: 0.65, braise: 0.06, hope: 0, hopeRiver: 0, size: 0.75, reads: 1, skill: 0.88
  },
  station: {
    open: 0.25, iso: 0.5, limp: 35, v3: 1.2, v4: 0.75, v5: 0.5, call3: 8, b3: 0, pre: -0.06,
    margin: -0.02, future: false, value: 0.68, raise: 0.9, cbet: 0.25, barrel: 0.1, bluff: 0,
    stab: 0.12, semi: 0.05, braise: 0, hope: 0.6, hopeRiver: 0.35, size: 0.45, reads: 0.4, skill: 0.6
  },
  maniac: {
    open: 2.0, iso: 1.5, limp: 50, v3: 9, v4: 6, v5: 3, call3: 25, b3: 0.18, pre: -0.08,
    margin: 0, future: false, value: 0.55, raise: 0.66, cbet: 0.9, barrel: 0.5, bluff: 0.2,
    stab: 0.55, semi: 0.8, braise: 0.1, hope: 0.5, hopeRiver: 0.1, size: 0.8, reads: 0.3, skill: 0.55
  }
}

// Tuning hook: STYLE_OVERRIDE='{"station":{"hope":0.6}}' for experiments.
if (process.env.STYLE_OVERRIDE) {
  const o = JSON.parse(process.env.STYLE_OVERRIDE)
  for (const k of Object.keys(o)) STYLES[k] = { ...STYLES[k], ...o[k] }
}

const isFish = (kind) => kind === 'station' || kind === 'maniac'

// Population figures a player assumes for a seat it has no reads on.
const POP = { vpip: 24, pfr: 18, af: 2.5 }

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)

// ------------------------------------------------------------------ strength on a board
//
// What fraction of all holdings a hand beats on this board, for every
// holding at once: one sort per board, then a lookup. Used to weigh how
// likely a holding was to bet, raise or call.

const tableCache = new Map()
const strengthTable = (board) => {
  const key = board.slice().sort((a, b) => a - b).join(',')
  const hit = tableCache.get(key)
  if (hit) return hit
  const dead = new Uint8Array(52)
  for (const c of board) dead[c] = 1
  const cards = new Array(2 + board.length)
  for (let i = 0; i < board.length; i++) cards[2 + i] = board[i]
  const combos = []
  for (let a = 0; a < 52; a++) {
    if (dead[a]) continue
    for (let b = a + 1; b < 52; b++) {
      if (dead[b]) continue
      cards[0] = a
      cards[1] = b
      combos.push({ k: a * 52 + b, s: evaluate(cards) })
    }
  }
  combos.sort((x, y) => x.s - y.s)
  const out = new Float32Array(52 * 52)
  let i = 0
  while (i < combos.length) {
    let j = i
    while (j + 1 < combos.length && combos[j + 1].s === combos[i].s) j++
    const p = ((i + j) / 2 + 0.5) / combos.length
    for (let t = i; t <= j; t++) out[combos[t].k] = p
    i = j + 1
  }
  if (tableCache.size > 3000) tableCache.clear()
  tableCache.set(key, out)
  return out
}
const strengthOf = (table, a, b) => (a < b ? table[a * 52 + b] : table[b * 52 + a])

// A real draw, with cards still to come: 2 for four to a flush, 1 for four
// to a straight, using at least one hole card.
const drawOf = (hole, board) => {
  if (board.length >= 5) return 0
  const all = hole.concat(board)
  for (let suit = 0; suit < 4; suit++) {
    if (!hole.some((c) => (c & 3) === suit)) continue
    if (all.filter((c) => (c & 3) === suit).length >= 4) return 2
  }
  const bits = (cs) => cs.reduce((m, c) => {
    const r = c >> 2
    return m | (1 << (r + 1)) | (r === 12 ? 1 : 0)
  }, 0)
  const have = bits(all)
  const mine = bits(hole)
  for (let low = 0; low <= 9; low++) {
    const w = 31 << low
    let n = 0
    for (let x = have & w; x; x &= x - 1) n++
    if (n >= 4 && (mine & w)) return 1
  }
  return 0
}

// A pair that uses a hole card: what a fish hangs on to.
const pairOf = (hole, board) => {
  const r0 = hole[0] >> 2
  const r1 = hole[1] >> 2
  return r0 === r1 || board.some((c) => (c >> 2) === r0 || (c >> 2) === r1)
}

// How likely a holding of strength p (with draw d) was to take an action.
// Bets and raises lean on strength with a floor for bluffs, which a seat's
// aggression raises; a call is a made hand or a draw; a check caps a range
// a little, since strong hands usually bet.
const likelihood = (type, p, d, floor) => {
  const pd = d === 2 ? Math.max(p, 0.6) : d === 1 ? Math.max(p, 0.5) : p
  if (type === 'bet') return floor + pd * pd
  if (type === 'raise') return floor * 0.5 + pd * pd * pd * pd
  if (type === 'call') return 0.15 + pd
  if (type === 'check') return 1 - 0.55 * p * p
  return 1
}

// How much of a bet is bluffs, by board length: a flop c-bet is made with
// most of a range, a river bet mostly is not.
const BLUFF_FLOOR = { 3: 0.6, 4: 0.2, 5: 0.08 }

// ------------------------------------------------------------------ reads

const makeReads = (n) => {
  const seats = Array.from({ length: n }, () => ({ hands: 0, vpip: 0, pfr: 0, bets: 0, calls: 0 }))
  const shrink = (seen, n0, pop, k = 25) => (seen + k * pop) / (n0 + k)
  return {
    observe: (result) => {
      for (let s = 0; s < n; s++) {
        if (!result.holeCards[s]) continue
        const st = seats[s]
        const pre = result.actions.filter((a) => a.seat === s && a.street === 'preflop')
        st.hands++
        if (pre.some((a) => a.type === 'call' || a.type === 'raise')) st.vpip++
        if (pre.some((a) => a.type === 'raise')) st.pfr++
      }
      for (const a of result.actions) {
        if (a.street === 'preflop') continue
        if (a.type === 'raise') seats[a.seat].bets++
        else if (a.type === 'call') seats[a.seat].calls++
      }
    },
    vpip: (s) => shrink(seats[s].vpip * 100, seats[s].hands, POP.vpip),
    pfr: (s) => shrink(seats[s].pfr * 100, seats[s].hands, POP.pfr),
    af: (s) => (seats[s].bets + POP.af * 6) / (seats[s].calls + 6),
    // A loose passive seat: value-bet thinner, bluff rarely.
    station: (s) => shrink(seats[s].vpip * 100, seats[s].hands, POP.vpip) -
      shrink(seats[s].pfr * 100, seats[s].hands, POP.pfr) > 22
  }
}

// ------------------------------------------------------------------ equity from the line

// `skill` is how far the player lets the line and the HUD move the read: at
// 1 fully, at 0 it is the textbook player's preflop-only read.
const lineEquity = (v, reads, skill = 1, trials = 360) => {
  const ranges = opponentRanges(v)
  // Widen or narrow each seat's preflop range for how that seat plays.
  const lastPre = {}
  for (const a of v.history) if (a.street === 'preflop' && a.type !== 'fold') lastPre[a.seat] = a.type
  for (const r of ranges) {
    const t = lastPre[r.seat]
    const scale = t === 'raise' ? reads.pfr(r.seat) / POP.pfr
      : t === 'call' ? reads.vpip(r.seat) / POP.vpip : 1
    r.width = clamp(r.width * Math.pow(clamp(scale, 0.5, 2.6), skill), 1.5, 100)
  }
  // Each opponent's postflop actions, with the board they were made on.
  const lines = {}
  const streetLen = { flop: 3, turn: 4, river: 5 }
  const raisedOn = {}
  for (const a of v.history) {
    if (a.street === 'preflop') continue
    const type = a.type === 'raise' ? (raisedOn[a.street] ? 'raise' : 'bet') : a.type
    if (a.type === 'raise') raisedOn[a.street] = true
    if (a.seat === v.seat || type === 'fold' || skill <= 0) continue
    ;(lines[a.seat] || (lines[a.seat] = [])).push({ type, board: v.board.slice(0, streetLen[a.street]) })
  }
  for (const seat of Object.keys(lines)) {
    for (const act of lines[seat]) act.table = strengthTable(act.board)
  }

  let won = 0
  let total = 0
  const dead = new Uint8Array(52)
  for (let t = 0; t < trials; t++) {
    dead.fill(0)
    for (const c of v.holeCards) dead[c] = 1
    for (const c of v.board) dead[c] = 1
    const opp = []
    let weight = 1
    for (const r of ranges) {
      const h = sampleHand(r.width, dead)
      if (!h) break
      dead[h.a] = 1
      dead[h.b] = 1
      opp.push([h.a, h.b])
      const line = lines[r.seat]
      if (line) {
        const aggression = Math.pow(clamp(reads.af(r.seat) / POP.af, 0.5, 3), skill)
        for (const act of line) {
          const p = strengthOf(act.table, h.a, h.b)
          const floor = BLUFF_FLOOR[act.board.length] * aggression
          weight *= Math.pow(likelihood(act.type, p, drawOf([h.a, h.b], act.board), floor), skill)
        }
      }
    }
    const full = v.board.slice()
    while (full.length < 5) {
      const c = Math.floor(Math.random() * 52)
      if (dead[c]) continue
      dead[c] = 1
      full.push(c)
    }
    const mine = evaluate(v.holeCards.concat(full))
    let best = 0
    const scores = opp.map((o) => evaluate(o.concat(full)))
    for (const s of scores) if (s > best) best = s
    let share = 0
    if (mine > best) share = 1
    else if (mine === best) share = 1 / (scores.filter((s) => s === mine).length + 1)
    won += weight * share
    total += weight
  }
  return total > 0 ? won / total : 0
}

// ------------------------------------------------------------------ the player

const gauss = (rng) => {
  const u = Math.max(1e-9, rng())
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

const makeOpponent = (kind, rng, name) => {
  const st = STYLES[kind]
  if (!st) throw new Error('no style for ' + kind)
  const fish = isFish(kind)
  let reads = null
  const wobble = () => gauss(rng) * (1 - st.skill) * 0.15
  const chance = (p) => p > 0 && rng() < p

  const raiseTo = (v, to) => {
    if (!v.canRaise) return null
    to = Math.round(to)
    // Past about 40% of the stack there is no fold left in it: get it in.
    if (to >= 0.4 * (v.stack + v.committed[v.seat])) to = v.maxRaiseTo
    return { action: 'raise', to: clamp(to, v.minRaiseTo, v.maxRaiseTo) }
  }
  const passive = (v) => ({ action: v.toCall > 0 ? 'fold' : 'check' })
  const call = (v) => ({ action: v.toCall > 0 ? 'call' : 'check' })

  const live = (v) => {
    const out = []
    for (let s = 0; s < v.numPlayers; s++) if (s !== v.seat && v.inHand[s] && !v.folded[s]) out.push(s)
    return out
  }

  // How much of its raw equity a hand realises from this seat: acting last
  // after the flop is worth more than acting first. Fish do not count it.
  const realisation = (v, opps) => {
    if (fish) return 1
    const order = (s) => (s - v.button - 1 + v.numPlayers) % v.numPlayers
    const last = opps.every((s) => order(v.seat) > order(s))
    const pos = positionOf(v.seat, v.button, v.numPlayers)
    const r = last ? 0.97 : pos === 'SB' ? 0.75 : 0.82
    return v.street === 'preflop' ? r : 1 - (1 - r) * 0.4
  }

  const preflop = (v) => {
    const idx = handIndex(v.holeCards[0], v.holeCards[1])
    const rank = handRank(idx, 1)
    const pos = positionOf(v.seat, v.button, v.numPlayers)
    const raises = v.history.filter((a) => a.street === 'preflop' && a.type === 'raise').length
    const limpers = v.history.filter((a) => a.street === 'preflop' && a.type === 'call').length
    const curBet = Math.max(...v.committed)
    const edge = rank * Math.exp(wobble() * 2)
    const openSize = (kind === 'maniac' ? 4 : 3) + limpers

    if (raises === 0) {
      if (pos === 'BB') {
        return edge <= 10 * st.open ? raiseTo(v, openSize * v.bigBlind) || call(v) : call(v)
      }
      const width = Math.min(100, OPEN_WIDTH[pos] * st.open * (limpers ? st.iso : 1))
      if (edge < width) return raiseTo(v, openSize * v.bigBlind) || call(v)
      if (edge < st.limp || (pos === 'SB' && limpers > 0 && edge < st.limp * 1.5)) return call(v)
      return passive(v)
    }

    const opps = live(v).filter((s) => v.history.some((a) => a.seat === s && a.street === 'preflop' && a.type !== 'fold'))
    const need = v.toCall / (v.pot + v.toCall)
    const ranges = opponentRanges(v)
    const multi = ranges.length > 1
    const equity = lineEquity(v, reads, st.reads, 260)
    const real = realisation(v, opps) * (multi ? 0.95 : 1)
    const inBlinds = pos === 'SB' || pos === 'BB'
    const effective = Math.min(v.stack, ...opps.map((s) => v.stacks[s] + v.committed[s]))

    if (raises === 1) {
      if (edge <= st.v3) return raiseTo(v, curBet * (inBlinds ? 4 : 3)) || call(v)
      const suited = Math.floor(idx / 13) > idx % 13
      const candidate = fish ? rank < 60 : suited && rank > 12 && rank < 40 && !inBlinds && !multi
      if (candidate && chance(st.b3)) return raiseTo(v, curBet * 3) || passive(v)
    } else if (raises === 2) {
      if (edge <= st.v4) return raiseTo(v, curBet * 2.3) || call(v)
      // Against a 3-bet a regular defends a calling range, not just the
      // hands the price alone justifies.
      if (edge <= st.call3 && v.toCall * 8 <= effective) return call(v)
    } else if (edge <= st.v5) {
      return raiseTo(v, v.maxRaiseTo) || call(v)
    }
    if (equity * real >= need + st.pre + wobble()) return call(v)
    // Small pairs set-mine when the stacks behind pay for it.
    const pair = Math.floor(idx / 13) === idx % 13
    if (pair && raises === 1 && v.toCall * 15 <= effective) return call(v)
    return passive(v)
  }

  const postflop = (v) => {
    const opps = live(v)
    const heads = opps.length === 1
    const equity = lineEquity(v, reads, st.reads)
    const draw = drawOf(v.holeCards, v.board)
    const street = v.street
    const pot = v.pot
    const curBet = Math.max(...v.committed)
    // Regulars value-bet a station thinner and hardly bluff it.
    const fishy = !fish && opps.some((s) => reads.station(s))
    let preRaiser = -1
    for (const a of v.history) if (a.street === 'preflop' && a.type === 'raise') preRaiser = a.seat
    const prevStreet = street === 'turn' ? 'flop' : street === 'river' ? 'turn' : 'preflop'
    let lastAggressor = -1
    for (const a of v.history) if (a.street === prevStreet && a.type === 'raise') lastAggressor = a.seat
    const hadInitiative = lastAggressor === v.seat
    const bluffScale = fishy ? 0.2 : 1
    const sized = (frac) => raiseTo(v, v.committed[v.seat] + pot * frac)
    const check = { action: 'check' }

    if (v.toCall === 0) {
      const valueAt = st.value + 0.06 * (opps.length - 1) - (fishy ? 0.07 : 0) + wobble()
      if (equity >= valueAt) return sized(st.size) || check
      if (heads) {
        if (street === 'flop' && preRaiser === v.seat && chance(st.cbet * bluffScale * (draw ? 1.3 : 1))) {
          return sized(fish ? st.size : 0.4) || check
        }
        if (street === 'turn' && hadInitiative && chance(st.barrel * bluffScale * (draw ? 1.6 : 0.8))) {
          return sized(st.size) || check
        }
        if (street === 'river' && hadInitiative && equity < 0.2 && chance(st.bluff * bluffScale)) {
          return sized(st.size) || check
        }
        // Checked to, with nothing: take a stab -- more often once a whole
        // street has been checked through, since nobody has shown interest.
        const quiet = street !== 'flop' && lastAggressor < 0
        if (preRaiser !== v.seat || quiet) {
          if (chance(st.stab * (quiet ? 1 : street === 'river' ? 0.3 : 0.5) * bluffScale)) {
            return sized(0.5) || check
          }
        }
      }
      if (draw && street !== 'river' && chance(st.semi * 0.5 * bluffScale)) return sized(st.size) || check
      return check
    }

    // A call before the river buys a street that has to be paid for again,
    // unless the hand is a draw that gets paid when it lands.
    const need = v.toCall / (pot + v.toCall) + (!st.future ? 0
      : draw ? -0.04 : street === 'flop' ? 0.04 : street === 'turn' ? 0.03 : 0)
    if (equity >= st.raise + 0.04 * (opps.length - 1) + wobble()) {
      return raiseTo(v, curBet * 2 + pot) || call(v)
    }
    if (heads && street !== 'river' && chance((draw === 2 ? st.semi * 0.3 : 0) + st.braise * bluffScale)) {
      return raiseTo(v, curBet * 2 + pot) || call(v)
    }
    if (equity * realisation(v, opps) >= need + st.margin + wobble()) return call(v)
    // The fish's hope: on the flop anything with a pair, a draw or an ace
    // floats; on the turn a pair or a draw, less often; on the river a pair.
    const pair = pairOf(v.holeCards, v.board)
    const ace = v.holeCards.some((c) => (c >> 2) === 12)
    const hoping = street === 'flop' ? (pair || draw > 0 || ace) && chance(st.hope)
      : street === 'turn' ? (pair || draw > 0) && chance(st.hope * 0.6)
        : pair && chance(st.hopeRiver)
    if (hoping) return call(v)
    return passive(v)
  }

  return {
    name,
    kind,
    act: (v) => {
      if (!reads) reads = makeReads(v.numPlayers)
      const d = v.street === 'preflop' ? preflop(v) : postflop(v)
      if (d.action === 'fold' && v.toCall === 0) return { action: 'check' }
      return d
    },
    observe: (result) => {
      if (!reads) reads = makeReads(result.stacks.length)
      reads.observe(result)
    }
  }
}

module.exports = { STYLES, makeOpponent, isFish, lineEquity, strengthTable }
