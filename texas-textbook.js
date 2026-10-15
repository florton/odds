// The textbook player: what the coach in texas-play.js recommends, as a bot.
//
//   node texas-textbook.js [hands] [--field realistic|tough|soft] [--seed n]
//
// Preflop it plays a chart: raise first in with the standard opening range
// for its seat, never limp; facing a raise 3-bet JJ+/AK, set-mine pairs, call
// the top 8% in position and defend the big blind at a price; facing a 3-bet
// 4-bet QQ+/AK and call JJ/TT/AQs; facing a 4-bet only AA-QQ and AK go on.
// Postflop it bets or raises for value at 60% / 70% equity, c-bets the flop
// heads-up as the preflop raiser, and otherwise goes by pot odds.
//
// Equity is a Monte Carlo against a range for each opponent read off their
// preflop line only -- the same population read for everyone, since the
// textbook player does not know who is who. It does not narrow for bets
// after the flop, which is the textbook player's characteristic mistake: it
// pays off.
//
// Run as a script it measures the textbook player against a field. That is
// the realism check for the field: an ABC player who never adjusts should
// lose a little to a table of regulars, roughly break even at a normal table
// and win in the tens against fish -- not hundreds. Against the fitted model
// it won +150 bb/100 in the realistic field; against the play table
// (--table, texas-opponents.js) it wins about +5 to +25, loses 15-35 in the
// tough field and wins 30-40 in the soft one (16000 hands, se about 13).

const { playHand, makeRng, makeDeck, shuffle } = require('./texas-engine')
const { evaluate } = require('./texas-eval')
const { handIndex, handLabel, handRank } = require('./texas-equity')

const POSITIONS = ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO']
// Standard six-max opening ranges, in percent of hands, for a first-in raise.
const OPEN_WIDTH = { UTG: 15, HJ: 19, CO: 27, BTN: 45, SB: 38, BB: 0 }

const positionOf = (seat, button, n) => POSITIONS[(seat - button + n) % n]
const pct = (x) => Math.round(x * 100) + '%'

// ------------------------------------------------------------------ equity

const COMBOS = (() => {
  const out = []
  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) out.push({ a, b, rank: handRank(handIndex(a, b), 1) })
  }
  return out.sort((x, y) => x.rank - y.rank)
})()

const sampleHand = (widthPct, dead) => {
  const limit = Math.max(12, Math.min(COMBOS.length, Math.round(widthPct / 100 * COMBOS.length)))
  for (let tries = 0; tries < 80; tries++) {
    const c = COMBOS[Math.floor(Math.random() * limit)]
    if (!dead[c.a] && !dead[c.b]) return c
  }
  for (let tries = 0; tries < 2000; tries++) {
    const c = COMBOS[Math.floor(Math.random() * COMBOS.length)]
    if (!dead[c.a] && !dead[c.b]) return c
  }
  return null
}

// The standard reads on a preflop line, in percent of hands: a first-in raise
// is that seat's opening range, an isolation raise over limpers a bit
// tighter, then about 7% for a 3-bet, 2.5% for a 4-bet and the big pairs
// beyond. A call is wider than the raise it calls; a limp is wide.
const RERAISE_WIDTH = [null, null, 7, 2.5, 1.2]

const opponentRanges = (v) => {
  let raises = 0
  let lastRaise = 100
  let limps = 0
  const sb = v.numPlayers === 2 ? v.button : (v.button + 1) % v.numPlayers
  const width = {}
  for (const a of v.history) {
    if (a.street !== 'preflop') continue
    if (a.type === 'raise') {
      raises++
      if (raises === 1) {
        const pos = positionOf(a.seat, v.button, v.numPlayers)
        lastRaise = limps > 0 ? 15 : Math.max(10, OPEN_WIDTH[pos] || 15)
      } else {
        lastRaise = RERAISE_WIDTH[Math.min(raises, 4)]
      }
      width[a.seat] = lastRaise
    } else if (a.type === 'call') {
      if (raises === 0) limps++
      width[a.seat] = raises === 0 ? (a.seat === sb ? 70 : 45) : Math.min(50, lastRaise * 1.8 + 3)
    } else if (a.type === 'check' && width[a.seat] === undefined) {
      width[a.seat] = 100
    }
  }
  // Before the flop, once somebody has come in, the players still to act are
  // left out: most of them will fold, and counting them as random hands would
  // make every call look worse than it is.
  const entered = v.street === 'preflop' &&
    v.history.some((a) => a.seat !== v.seat && (a.type === 'call' || a.type === 'raise'))
  const out = []
  for (let s = 0; s < v.numPlayers; s++) {
    if (s === v.seat || !v.inHand[s] || v.folded[s]) continue
    if (entered && width[s] === undefined) continue
    const base = width[s] === undefined ? 100 : width[s]
    out.push({ seat: s, width: Math.max(1.5, Math.min(100, base)) })
  }
  return out
}

const equityVs = (hole, board, ranges, trials = 3000) => {
  let won = 0
  const dead = new Uint8Array(52)
  for (let t = 0; t < trials; t++) {
    dead.fill(0)
    for (const c of hole) dead[c] = 1
    for (const c of board) dead[c] = 1
    const opp = []
    for (const r of ranges) {
      const h = sampleHand(r.width, dead)
      if (!h) break
      dead[h.a] = 1
      dead[h.b] = 1
      opp.push([h.a, h.b])
    }
    const full = board.slice()
    while (full.length < 5) {
      const c = Math.floor(Math.random() * 52)
      if (dead[c]) continue
      dead[c] = 1
      full.push(c)
    }
    const mine = evaluate(hole.concat(full))
    let best = 0
    let ties = 0
    for (const o of opp) {
      const s = evaluate(o.concat(full))
      if (s > best) best = s
    }
    if (mine > best) won += 1
    else if (mine === best) {
      for (const o of opp) if (evaluate(o.concat(full)) === mine) ties++
      won += 1 / (ties + 1)
    }
  }
  return won / trials
}

// ------------------------------------------------------------------ sizes

// The bet / raise sizes worth offering in this spot, as "raise to" totals.
// `id` is what the textbook decision refers to.
const sizeOptions = (v) => {
  const opts = []
  if (!v.canRaise) return opts
  const curBet = Math.max(...v.committed)
  const pot = v.pot
  const preflop = v.street === 'preflop'
  const add = (to, label, id) => {
    to = Math.round(to)
    if (to < v.minRaiseTo) to = v.minRaiseTo
    if (to >= v.maxRaiseTo) return
    const same = opts.find((o) => o.to === to)
    if (same) {
      if (id && !same.id) same.id = id
      return
    }
    opts.push({ to, label, id })
  }
  if (preflop && curBet <= v.bigBlind) {
    const limpers = v.history.filter((a) => a.street === 'preflop' && a.type === 'call').length
    const extra = limpers * v.bigBlind
    const plus = limpers ? '+' + limpers : ''
    add(2.5 * v.bigBlind + extra, '2.5x' + plus)
    add(3 * v.bigBlind + extra, '3x' + plus, 'open')
    add(4 * v.bigBlind + extra, '4x' + plus)
  } else if (preflop) {
    const raises = v.history.filter((a) => a.street === 'preflop' && a.type === 'raise').length
    if (raises >= 2) add(2.3 * curBet, '2.3x', 'reraise')
    add(3 * curBet, '3x', raises === 1 ? 'ip' : undefined)
    add(4 * curBet, '4x', raises === 1 ? 'oop' : undefined)
    add(curBet + pot + v.toCall, 'pot')
  } else if (curBet === 0) {
    add(pot / 3, '1/3 pot')
    add(pot / 2, '1/2 pot', 'cbet')
    add(pot * 2 / 3, '2/3 pot', 'value')
    add(pot, 'pot')
  } else {
    add(v.minRaiseTo, 'min')
    add(curBet + (pot + v.toCall) * 0.66, '2/3 pot', 'value')
    add(curBet + pot + v.toCall, 'pot')
  }
  opts.sort((x, y) => x.to - y.to)
  // A minimum raise is worth offering against a bet; a 2-chip lead into a
  // big pot is not.
  if (curBet > 0 && opts.length && opts[0].to !== v.minRaiseTo && v.minRaiseTo < v.maxRaiseTo) {
    opts.unshift({ to: v.minRaiseTo, label: 'min' })
  }
  return opts
}

// ------------------------------------------------------------------ the decision

const VALUE_3BET = new Set(['AA', 'KK', 'QQ', 'JJ', 'AKs', 'AKo'])
const VALUE_4BET = new Set(['AA', 'KK', 'QQ', 'AKs', 'AKo'])
const VALUE_5BET = new Set(['AA', 'KK'])

const preflopRaiserOf = (v) => {
  let raiser = -1
  for (const a of v.history) if (a.street === 'preflop' && a.type === 'raise') raiser = a.seat
  return raiser
}

// The textbook play: { action, to, text }, text being the one instruction
// and the number behind it.
const decide = (v, equity, sizes = sizeOptions(v)) => {
  const preflop = v.street === 'preflop'
  const need = v.toCall > 0 ? v.toCall / (v.pot + v.toCall) : 0
  const passive = v.toCall > 0 ? { action: 'call', word: 'Call' } : { action: 'check', word: 'Check' }
  const raise = (id, word, why) => {
    if (!v.canRaise) return { action: passive.action, text: passive.word + ' -- ' + why + ' (no raise allowed here)' }
    const o = sizes.find((s) => s.id === id)
    if (!o) return { action: 'raise', to: v.maxRaiseTo, text: word + ' all in -- ' + why }
    return { action: 'raise', to: o.to, text: word + ' to ' + o.to + ' -- ' + why }
  }
  const byOdds = () => equity >= need
    ? { action: 'call', text: 'Call -- equity ' + pct(equity) + ' is above the ' + pct(need) + ' pot odds.' }
    : { action: 'fold', text: 'Fold -- equity ' + pct(equity) + ' is below the ' + pct(need) + ' pot odds.' }

  if (preflop) {
    const pos = positionOf(v.seat, v.button, v.numPlayers)
    const idx = handIndex(v.holeCards[0], v.holeCards[1])
    const label = handLabel(idx)
    const rank = handRank(idx, 1)
    const top = 'top ' + Math.max(1, Math.round(rank)) + '%'
    const raises = v.history.filter((a) => a.street === 'preflop' && a.type === 'raise').length
    const limpers = v.history.filter((a) => a.street === 'preflop' && a.type === 'call').length
    if (raises === 0) {
      if (pos === 'BB') {
        return rank <= 10
          ? raise('open', 'Raise', label + ' is ' + top + '; raise the top 10% over limpers from the big blind.')
          : { action: 'check', text: 'Check -- ' + label + ' is ' + top + '; raise only the top 10% here.' }
      }
      const width = limpers ? Math.round(OPEN_WIDTH[pos] * 0.6) : OPEN_WIDTH[pos]
      const range = (limpers ? 'the over-limper range from ' : 'the opening range from ') + pos + ' is the top ' + width + '%'
      return rank < width
        ? raise('open', 'Raise', range + '; ' + label + ' is ' + top + '.')
        : { action: 'fold', text: 'Fold -- ' + range + '; ' + label + ' is ' + top + '.' }
    }
    const inBlinds = pos === 'SB' || pos === 'BB'
    const pair = Math.floor(idx / 13) === idx % 13
    let raiser = -1
    for (const a of v.history) if (a.street === 'preflop' && a.type === 'raise') raiser = a.seat
    const raiserPos = positionOf(raiser, v.button, v.numPlayers)
    const effective = Math.min(v.stack, v.stacks[raiser] + v.committed[raiser])
    if (raises === 1) {
      if (VALUE_3BET.has(label)) return raise(inBlinds ? 'oop' : 'ip', '3-bet', 'JJ+ and AK are value 3-bets.')
      if (pair) {
        return v.toCall * 15 <= effective
          ? { action: 'call', text: 'Call -- a pair calls to flop a set when 15x the call is behind (' + effective + ' here).' }
          : { action: 'fold', text: 'Fold -- set-mining needs 15x the call behind; there is ' + effective + '.' }
      }
      if (pos === 'BB') {
        const defend = ['CO', 'BTN', 'SB'].includes(raiserPos) ? 35 : 20
        if (rank <= defend && equity >= need) {
          return { action: 'call', text: 'Call -- the big blind defends the top ' + defend + '% against a ' + raiserPos + ' raise; ' + label + ' is ' + top + '.' }
        }
        return { action: 'fold', text: 'Fold -- the big blind defends the top ' + defend + '% against a ' + raiserPos + ' raise; ' + label + ' is ' + top + '.' }
      }
      if (pos === 'SB') return { action: 'fold', text: 'Fold -- the small blind 3-bets or folds; ' + label + ' is not a 3-bet.' }
      return rank <= 8
        ? { action: 'call', text: 'Call -- in position, call a raise with the top 8% that is not a 3-bet; ' + label + ' is ' + top + '.' }
        : { action: 'fold', text: 'Fold -- calling a raise takes the top 8%; ' + label + ' is ' + top + '.' }
    }
    if (raises === 2) {
      if (VALUE_4BET.has(label)) return raise('reraise', '4-bet', 'QQ+ and AK are value 4-bets.')
      if (['JJ', 'TT', 'AQs'].includes(label) && v.toCall * 8 <= effective) {
        return { action: 'call', text: 'Call -- JJ, TT and AQs call a 3-bet.' }
      }
      return { action: 'fold', text: 'Fold -- against a 3-bet, continue with TT+ and AQs+ only.' }
    }
    if (VALUE_5BET.has(label)) {
      return v.canRaise
        ? { action: 'raise', to: v.maxRaiseTo, text: 'All in -- AA and KK get it in.' }
        : { action: 'call', text: 'Call -- AA and KK get it in.' }
    }
    if (label === 'AKs' || label === 'AKo' || label === 'QQ') {
      return need <= 0.4 ? { action: 'call', text: 'Call -- QQ and AK call a 4-bet shove at this price.' } : byOdds()
    }
    return { action: 'fold', text: 'Fold -- against a 4-bet, only AA, KK, QQ and AK continue.' }
  }

  if (v.toCall > 0) {
    if (equity >= 0.7) return raise('value', 'Raise', 'equity ' + pct(equity) + ' is a value raise.')
    return byOdds()
  }
  if (equity >= 0.6) return raise('value', 'Bet', 'equity ' + pct(equity) + ' is a value bet.')
  const opponents = v.folded.filter((f, s) => s !== v.seat && v.inHand[s] && !f).length
  if (v.street === 'flop' && preflopRaiserOf(v) === v.seat && opponents === 1) {
    return raise('cbet', 'C-bet', 'the preflop raiser c-bets the flop heads-up.')
  }
  return { action: 'check', text: 'Check -- equity ' + pct(equity) + ' is below a value bet (60%).' }
}

const makeTextbook = (name = 'Textbook', trials = 600) => ({
  name,
  act: (v) => {
    const d = decide(v, equityVs(v.holeCards, v.board, opponentRanges(v), trials))
    return d.action === 'raise' ? { action: 'raise', to: d.to } : { action: d.action }
  }
})

module.exports = {
  OPEN_WIDTH, positionOf, opponentRanges, sampleHand, equityVs, sizeOptions, decide, makeTextbook
}

// ------------------------------------------------------------------ measuring

if (require.main === module) {
  const { archetype } = require('./texas-players')
  const { fieldSkill } = require('./texas-calibrate')
  const args = process.argv.slice(2)
  const option = (name, dflt) => {
    const i = args.indexOf(name)
    return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt
  }
  const FIELDS = {
    realistic: ['nit', 'tag', 'lag', 'station', 'maniac'],
    tough: ['nit', 'tag', 'tag', 'lag', 'station'],
    soft: ['station', 'maniac', 'station', 'tag', 'nit']
  }
  // --set key=value overrides a model constant for the run, for experiments.
  const { setParams } = require('./texas-players')
  args.forEach((a, i) => {
    const m = args[i - 1] === '--set' && a.match(/^(\w+)=([\d.eE+-]+)$/)
    if (m) setParams({ [m[1]]: Number(m[2]) })
  })
  const hands = Number(args.find((a, i) => /^\d+$/.test(a) && args[i - 1] !== '--seed') || 20000)
  const fieldName = option('--field', 'realistic')
  const seed = Number(option('--seed', 1))
  const rng = makeRng(seed)
  Math.random = makeRng(seed ^ 0x5bd1e995)
  const lineup = FIELDS[fieldName]
  // --hero kind[:skill] seats a model player in the textbook player's chair,
  // for comparison.
  const heroOpt = option('--hero', null)
  const heroBot = heroOpt
    ? archetype(heroOpt.split(':')[0], heroOpt.includes(':') ? Number(heroOpt.split(':')[1]) : fieldSkill(heroOpt), rng, 'hero')
    : makeTextbook()
  // --table plays the field the play table seats (texas-opponents.js);
  // without it, the fitted model's players throughout.
  const { makeOpponent } = require('./texas-opponents')
  const table = args.includes('--table')
  const bots = [heroBot].concat(lineup.map((k, i) => table
    ? makeOpponent(k, rng, k + (i + 1))
    : archetype(k, fieldSkill(k), rng, k + (i + 1))))
  const { makeTracker } = require('./texas-players')
  const tracker = makeTracker(bots.length)
  const kinds = ['textbook'].concat(lineup)
  const n = bots.length
  const sum = new Array(n).fill(0)
  const sq = new Array(n).fill(0)
  // Where the textbook player's money comes from.
  const parts = {}
  const part = (key, d) => {
    const p = parts[key] || (parts[key] = { n: 0, chips: 0 })
    p.n++
    p.chips += d
  }
  // How the field answers its bets after the flop.
  const facing = {}
  for (let h = 0; h < hands; h++) {
    const stacks = new Array(n).fill(200)
    const res = playHand({ bots, stacks, button: h % n, smallBlind: 1, bigBlind: 2, rng, deck: shuffle(makeDeck(), rng) })
    for (let s = 0; s < n; s++) {
      sum[s] += res.deltas[s]
      sq[s] += res.deltas[s] * res.deltas[s]
      if (bots[s].observe) bots[s].observe(res, s)
    }
    tracker.record(res)
    const d = res.deltas[0]
    const mine = res.actions.filter((a) => a.seat === 0)
    const pre = mine.filter((a) => a.street === 'preflop')
    const sawFlop = res.actions.some((a) => a.seat === 0 && a.street !== 'preflop') ||
      (res.board.length >= 3 && !mine.some((a) => a.type === 'fold'))
    const sd = res.wentToShowdown && res.showdown.some((x) => x.seat === 0)
    const preRaises = res.actions.filter((a) => a.street === 'preflop' && a.type === 'raise').length
    const potType = preRaises === 0 ? 'limped' : preRaises === 1 ? 'single-raised' : preRaises === 2 ? '3-bet' : '4-bet+'
    if (!pre.some((a) => a.type === 'call' || a.type === 'raise')) part('preflop: did not play', d)
    else if (!sawFlop) part('preflop: hand ended before the flop', d)
    else part('flop+ ' + potType + (sd ? ', showdown' : ', no showdown'), d)
    // Each postflop bet or raise by the textbook player, and what came back.
    for (let i = 0; i < res.actions.length; i++) {
      const a = res.actions[i]
      if (a.seat !== 0 || a.type !== 'raise' || a.street === 'preflop') continue
      const replies = []
      for (let j = i + 1; j < res.actions.length; j++) {
        const b = res.actions[j]
        if (b.street !== a.street) break
        if (b.seat === 0) break
        replies.push(b.type)
      }
      const key = a.street + (a.toCall > 0 ? ' raise' : ' bet')
      const f = facing[key] || (facing[key] = { n: 0, allFold: 0, raised: 0 })
      f.n++
      if (replies.length && replies.every((t) => t === 'fold')) f.allFold++
      if (replies.includes('raise')) f.raised++
    }
  }
  const bb100 = (s) => {
    const mean = sum[s] / hands
    const sd = Math.sqrt(Math.max(0, sq[s] / hands - mean * mean))
    return (mean / 2 * 100).toFixed(1) + ' ± ' + (sd / Math.sqrt(hands) / 2 * 100).toFixed(1)
  }
  console.log('Textbook vs the ' + fieldName + ' field, ' + hands + ' hands (bb/100 ± 1 se)')
  for (let s = 0; s < n; s++) console.log('  ' + kinds[s].padEnd(10) + bb100(s))
  console.log('\nTracked stats')
  console.log('  ' + 'seat'.padEnd(10) + ['VPIP', 'PFR', 'AF', 'WTSD', 'W$SD', 'Cbet', 'FCbet', 'FTurn', '3bet', 'F3bet'].map((h) => h.padStart(7)).join(''))
  tracker.summary(kinds, 2).forEach((r) => {
    console.log('  ' + r.name.padEnd(10) + [r.vpip, r.pfr, r.af, r.wtsd, r.wsd, r.cbet, r.foldToCbet,
      r.foldToTurnCbet, r.threeBet, r.foldTo3bet].map((x) => (isFinite(x) ? x.toFixed(1) : '-').padStart(7)).join(''))
  })
  console.log('\nTextbook money by how the hand went (bb/100 contribution, share of hands)')
  for (const [k, p] of Object.entries(parts).sort((x, y) => y[1].chips - x[1].chips)) {
    console.log('  ' + k.padEnd(38) + (p.chips / 2 / hands * 100).toFixed(1).padStart(8) + '   ' +
      (p.n / hands * 100).toFixed(1) + '%   ' + (p.chips / 2 / p.n).toFixed(2) + ' bb/hand')
  }
  console.log('\nField reply to textbook postflop bets')
  for (const [k, f] of Object.entries(facing)) {
    console.log('  ' + k.padEnd(12) + String(f.n).padStart(6) + '   everyone folds ' + pct(f.allFold / f.n) +
      '   raised ' + pct(f.raised / f.n))
  }
}
