// Texas Hold'em -- sit down at the table yourself.
//
//   node texas-play.js                  you against the realistic field
//   node texas-play.js --field tough    nit, two TAGs, two LAGs: the regulars' game
//   node texas-play.js --field soft     two stations and a maniac: the fun game
//   node texas-play.js --seed 7         replay a session (same deals while you play the same way)
//   node texas-play.js --fast           no pause between the bots' actions
//   node texas-play.js --no-coach       hide the equity / pot-odds / coach lines
//   node texas-play.js --ascii          s h d c instead of suit symbols
//   node texas-play.js --no-color
//
// Six-max no-limit, blinds 1/2, everybody starts with 200 (100 big blinds).
// You are seat 0 in texas-engine.js like any other bot: your `act` just reads
// the keyboard instead of a model. The five opponents are the fitted
// personalities from texas-players.js, each at the proficiency it was fitted
// at, so the table plays the way the measured population does.
//
// The narration is rebuilt from the hand's public history -- the same record
// the bots decide from -- so nothing printed here is information a player at
// a real table would not have. The exception is the opponent types, which are
// shown because at a real table you would have a read on them after an orbit
// or two (pass --blind to play without them).

const fs = require('fs')
const { playHand, makeRng, makeDeck, shuffle } = require('./texas-engine')
const {
  RANKS, evaluate, categoryOf,
  PAIR, TWO_PAIR, TRIPS, STRAIGHT, FLUSH, FULL_HOUSE, QUADS, STRAIGHT_FLUSH
} = require('./texas-eval')
const { handIndex, handLabel, handRank, countOuts } = require('./texas-equity')
const { archetype, PARAMS } = require('./texas-players')
const { fieldSkill } = require('./texas-calibrate')

// ------------------------------------------------------------------ options

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt
}

const FAST = flag('--fast')
const COACH = !flag('--no-coach')
const BLIND = flag('--blind')
const ASCII = flag('--ascii')
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR && !flag('--no-color')
const SEED = Number(option('--seed', Date.now() >>> 0)) >>> 0
const FIELD = option('--field', 'realistic')

const SMALL_BLIND = 1
const BIG_BLIND = 2
const BUY_IN = 200
const HERO = 0

// ------------------------------------------------------------------ the field

const FIELDS = {
  realistic: ['nit', 'tag', 'lag', 'station', 'maniac'],
  tough: ['nit', 'tag', 'tag', 'lag', 'lag'],
  soft: ['station', 'maniac', 'station', 'tag', 'nit']
}

const NAMES = {
  nit: ['Nina', 'Ned'],
  tag: ['Theo', 'Tess'],
  lag: ['Lars', 'Lucy'],
  station: ['Stan', 'Sally'],
  maniac: ['Max', 'Mia']
}

const TYPES = {
  nit: {
    label: 'Nit',
    blurb: 'Plays only premium hands and almost never bluffs. When a nit raises, ' +
      'believe it. Steal their blinds freely, and fold to their big bets.'
  },
  tag: {
    label: 'TAG',
    blurb: 'Tight-aggressive regular. Plays a solid range and bets it hard. ' +
      'The best player at the table -- avoid big pots without a big hand.'
  },
  lag: {
    label: 'LAG',
    blurb: 'Loose-aggressive. Plays lots of hands and keeps the pressure on; ' +
      'a bet from a LAG does not always mean strength.'
  },
  station: {
    label: 'Station',
    blurb: 'Calling station. Calls far too much and rarely raises. Do not bluff ' +
      'this one -- bet your good hands, and bet them bigger.'
  },
  maniac: {
    label: 'Maniac',
    blurb: 'Raises and bets with almost anything. Expect chaos: call down lighter ' +
      'and let them bluff into you.'
  }
}

// How much wider than a population player each type plays a given line. Used
// only for the hero's equity estimate -- the bots themselves never see it.
const RANGE_WIDTH = { nit: 0.6, tag: 1, lag: 1.4, station: 2.2, maniac: 2.8 }

if (!FIELDS[FIELD]) {
  console.log('Unknown field "' + FIELD + '" -- choose one of: ' + Object.keys(FIELDS).join(', '))
  process.exit(1)
}

// ------------------------------------------------------------------ output

const paint = (code) => (s) => COLOR ? '\x1b[' + code + 'm' + s + '\x1b[0m' : String(s)
const bold = paint('1')
const dim = paint('2')
const red = paint('31')
const green = paint('32')
const yellow = paint('33')
const magenta = paint('35')
const cyan = paint('36')

const say = (s = '') => console.log(s)

const SUIT_GLYPH = ASCII ? ['s', 'h', 'd', 'c'] : ['♠', '♥', '♦', '♣']
const card = (c) => {
  const s = RANKS[c >> 2] + SUIT_GLYPH[c & 3]
  return (c & 3) === 1 || (c & 3) === 2 ? red(bold(s)) : bold(s)
}
const cards = (cs) => cs.map(card).join(' ')

const RANK_NAME = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Jack', 'Queen', 'King', 'Ace']
const RANK_PLURAL = ['Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights',
  'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces']

const pct = (x) => Math.round(x * 100) + '%'
const bb = (chips) => {
  const v = chips / BIG_BLIND
  return (Number.isInteger(v) ? v : v.toFixed(1)) + ' bb'
}
const signed = (n) => (n > 0 ? '+' : '') + n

// ------------------------------------------------------------------ input
//
// The engine asks each seat for a decision synchronously, so the keyboard is
// read synchronously too: fs.readSync on stdin, buffered by line. Nothing here
// touches process.stdin, which would switch the console into stream mode.

let pending = Buffer.alloc(0)
let inputClosed = false

const sleep = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const readLine = () => {
  const chunk = Buffer.alloc(1024)
  while (true) {
    const nl = pending.indexOf(10)
    if (nl >= 0) {
      const line = pending.slice(0, nl).toString('utf8').replace(/\r$/, '')
      pending = pending.slice(nl + 1)
      return line
    }
    let n
    try {
      n = fs.readSync(0, chunk, 0, chunk.length, null)
    } catch (err) {
      if (err.code === 'EAGAIN') {
        sleep(25)
        continue
      }
      if (err.code === 'EOF') n = 0
      else throw err
    }
    if (n === 0) {
      if (pending.length === 0) return null
      const line = pending.toString('utf8')
      pending = Buffer.alloc(0)
      return line
    }
    pending = Buffer.concat([pending, chunk.slice(0, n)])
  }
}

const ask = (prompt) => {
  process.stdout.write(prompt)
  const line = readLine()
  if (line === null) {
    inputClosed = true
    say('')
    return 'q'
  }
  return line.trim().toLowerCase()
}

// ------------------------------------------------------------------ positions

const POSITIONS = ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO']
const POSITION_BLURB = {
  BTN: 'the button. You act last on every street after the flop -- the best seat ' +
    'at the table, where you can play the most hands.',
  SB: 'the small blind, 1 chip already in. You will act first on every street ' +
    'after the flop, the hardest seat to win from.',
  BB: 'the big blind, 2 chips already in. You act last before the flop and often ' +
    'see it cheaply, but first-ish after it.',
  UTG: '"under the gun": first to act before the flop with five players behind ' +
    'you. Play tight here.',
  HJ: 'the hijack, middle position. Four players behind; a little looser than UTG.',
  CO: 'the cutoff, one seat before the button. A good seat to raise and steal ' +
    'the blinds from.'
}
// Roughly how wide a solid player opens from each seat, in percent of hands.
const OPEN_WIDTH = { UTG: 15, HJ: 19, CO: 27, BTN: 45, SB: 38, BB: 0 }

const positionOf = (seat, button, n) => POSITIONS[(seat - button + n) % n]

// ------------------------------------------------------------------ hand reading

const handName = (idx) => {
  const a = Math.floor(idx / 13)
  const b = idx % 13
  if (a === b) return 'a pair of ' + RANK_PLURAL[a]
  const hi = a > b ? a : b
  const lo = a > b ? b : a
  return RANK_NAME[hi] + '-' + RANK_NAME[lo] + (a > b ? ' suited' : ' offsuit')
}

const NICKNAMES = {
  AA: 'pocket rockets', KK: 'cowboys', QQ: 'ladies', JJ: 'fishhooks',
  AKs: 'big slick', AKo: 'big slick', '72o': 'the worst hand in poker'
}

// A one-line sense of what kind of starting hand this is.
const handClass = (idx) => {
  const a = Math.floor(idx / 13)
  const b = idx % 13
  const hi = Math.max(a, b)
  const lo = Math.min(a, b)
  const suited = a > b
  const rank = handRank(idx, 1)
  if (a === b) {
    if (hi >= 10) return 'a premium pair -- raise it'
    if (hi >= 7) return 'a strong pair, usually worth a raise'
    if (hi >= 4) return 'a middle pair: often good, sometimes in trouble against overcards'
    return 'a small pair: mostly hoping to flop a set (about 1 time in 8.5)'
  }
  if (hi === 12 && lo >= 11) return 'a premium hand -- raise it'
  if (hi === 12 && lo >= 9) return 'a big ace, strong in most spots'
  if (hi === 12 && suited) return 'a suited ace: can make the nut flush'
  if (hi === 12) return 'a weak ace -- dominated by better aces, careful'
  if (lo >= 8) return 'two broadway cards, good for top pair'
  if (suited && hi - lo === 1 && lo >= 3) return 'a suited connector: makes straights and flushes, likes cheap flops'
  if (suited && hi - lo === 2 && lo >= 3) return 'a suited one-gapper: speculative'
  if (suited && hi >= 10) return 'a suited high card, playable in late position'
  if (rank > 70) return 'trash -- most players fold this'
  if (rank > 50) return 'a weak hand, playable only cheaply or from late position'
  return 'a marginal hand, fine in late position'
}

const strHigh = (mask) => {
  // Highest straight in a rank bitmask (bit r+1 for rank r, bit 0 for a low ace).
  for (let top = 13; top >= 4; top--) {
    if (((mask >> (top - 4)) & 31) === 31) return top
  }
  return -1
}
const rankMask = (cs) => cs.reduce((m, c) => {
  const r = c >> 2
  return m | (1 << (r + 1)) | (r === 12 ? 1 : 0)
}, 0)

// What the hero's hand is right now, in words, plus whatever it is drawing to.
const readHand = (hole, board) => {
  const all = hole.concat(board)
  const sc = evaluate(all)
  const cat = categoryOf(sc)
  const r1 = (sc >> 16) & 15
  const r2 = (sc >> 12) & 15
  const boardRanks = board.map((c) => c >> 2)
  const distinct = [...new Set(boardRanks)].sort((x, y) => y - x)
  const h0 = hole[0] >> 2
  const h1 = hole[1] >> 2
  const pocket = h0 === h1
  const onBoard = (r) => boardRanks.filter((x) => x === r).length
  const boardScore = board.length === 5 ? evaluate(board) : -1
  let made

  if (sc === boardScore) {
    made = 'nothing beyond the board itself -- every player still in shares it ' +
      '(a chop at best)'
  } else if (cat === 0) {
    made = RANK_NAME[r1] + ' high -- no pair yet'
  } else if (cat === PAIR) {
    if (pocket && r1 === h0) {
      made = r1 > distinct[0]
        ? 'an overpair, ' + RANK_PLURAL[r1] + ' -- bigger than every card on the board. Strong'
        : 'pocket ' + RANK_PLURAL[r1] + ' with higher cards on the board (an underpair). ' +
          'Beaten by anyone holding one of those'
    } else if (onBoard(r1) === 2) {
      const kick = Math.max(h0, h1)
      made = 'only the board\'s pair of ' + RANK_PLURAL[r1] + ' -- you really have ' +
        RANK_NAME[kick] + ' high'
    } else {
      const where = distinct.indexOf(r1)
      const kicker = h0 === r1 ? h1 : h0
      const which = where === 0 ? 'top pair' : where === 1 ? 'second pair' : 'bottom pair'
      const strength = where === 0
        ? (kicker >= 10 ? ' -- a good hand' : ' -- decent, but a better kicker beats you')
        : where === 1 ? ' -- a medium hand, vulnerable' : ' -- weak'
      made = which + ', ' + RANK_PLURAL[r1] + ', with a ' + RANK_NAME[kicker] + ' kicker' + strength
    }
  } else if (cat === TWO_PAIR) {
    const boardPaired = distinct.length < boardRanks.length
    made = 'two pair, ' + RANK_PLURAL[r1] + ' and ' + RANK_PLURAL[r2] +
      (boardPaired
        ? ' -- but one pair is on the board for everyone, so it is weaker than it sounds'
        : ' -- strong')
  } else if (cat === TRIPS) {
    if (pocket) made = 'a set of ' + RANK_PLURAL[r1] + ' (your pocket pair plus one on the board) -- very strong, and well hidden'
    else if (onBoard(r1) === 3) made = 'three ' + RANK_PLURAL[r1] + ' on the board -- everyone shares them; your kicker decides'
    else made = 'trips, ' + RANK_PLURAL[r1] + ' (one in your hand, two on the board) -- strong, but watch your kicker'
  } else if (cat === STRAIGHT) {
    made = 'a straight, ' + RANK_NAME[r1] + ' high -- very strong'
  } else if (cat === FLUSH) {
    made = 'a flush, ' + RANK_NAME[r1] + ' high' + (r1 === 12 ? ' -- the nut flush' : ' -- very strong unless a bigger flush is out there')
  } else if (cat === FULL_HOUSE) {
    made = 'a full house, ' + RANK_PLURAL[r1] + ' full of ' + RANK_PLURAL[r2] + ' -- a monster'
  } else if (cat === QUADS) {
    made = 'four of a kind, ' + RANK_PLURAL[r1] + '! -- a monster'
  } else {
    made = r1 === 12 ? 'a ROYAL FLUSH!' : 'a straight flush, ' + RANK_NAME[r1] + ' high!'
  }

  const draws = []
  if (board.length < 5) {
    if (cat < FLUSH) {
      for (let suit = 0; suit < 4; suit++) {
        const mine = hole.filter((c) => (c & 3) === suit).length
        if (mine === 0) continue
        const n = all.filter((c) => (c & 3) === suit).length
        if (n === 4) draws.push('a flush draw (9 cards complete it)')
        else if (n === 3 && board.length === 3 && mine === 2) {
          draws.push('a backdoor flush draw (needs both turn and river)')
        }
      }
    }
    if (cat < STRAIGHT) {
      const have = rankMask(all)
      const boardOnly = rankMask(board)
      let completing = 0
      for (let r = 0; r < 13; r++) {
        const bit = (1 << (r + 1)) | (r === 12 ? 1 : 0)
        if (have & (1 << (r + 1))) continue
        if (strHigh(have | bit) >= 0 && strHigh(boardOnly | bit) < 0) completing++
      }
      if (completing >= 2) draws.push('an open-ended straight draw (8 cards complete it)')
      else if (completing === 1) draws.push('a gutshot straight draw (4 cards complete it)')
    }
  }
  const outs = board.length < 5 ? countOuts(hole, board) : 0
  return { made, draws, outs, cat }
}

const describeBoard = (board) => {
  const notes = []
  const suits = [0, 0, 0, 0]
  for (const c of board) suits[c & 3]++
  const most = Math.max(...suits)
  if (board.length === 3) {
    if (most === 3) notes.push('monotone: all one suit, a flush is possible already')
    else if (most === 2) notes.push('two-tone: flush draws are out there')
    else notes.push('rainbow: no flush draws')
  } else if (most >= 3) {
    notes.push(most + ' of one suit: flushes are possible')
  }
  const ranks = board.map((c) => c >> 2)
  if (new Set(ranks).size < ranks.length) notes.push('paired board: full houses and trips are possible')
  const mask = rankMask(board)
  let connected = false
  for (let low = 0; low <= 9; low++) {
    let n = 0
    for (let k = 0; k < 5; k++) if (mask & (1 << (low + k))) n++
    if (n >= 3) connected = true
  }
  if (connected) notes.push('connected: straights are possible')
  if (notes.length === 1 && board.length === 3 && most === 1) notes[0] = 'rainbow and disconnected: a dry board'
  return notes.join('; ')
}

// ------------------------------------------------------------------ equity
//
// A Monte Carlo of the hero's hand against a guessed range for every live
// opponent. The guess comes off their preflop line -- the same population
// read the bots use (PARAMS.rangeOpen and friends) -- widened or narrowed by
// what type of player they are. It does not narrow for postflop bets, and the
// coach line says so.

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

const opponentRanges = (v, kinds) => {
  let raises = 0
  let bet = v.bigBlind
  let lastRaise = 100
  const sb = v.numPlayers === 2 ? v.button : (v.button + 1) % v.numPlayers
  const width = {}
  for (const a of v.history) {
    if (a.street !== 'preflop') continue
    if (a.type === 'raise') {
      const size = a.to / bet
      bet = a.to
      raises++
      lastRaise = PARAMS.rangeOpen * Math.pow(PARAMS.rangeStep, raises - 1) *
        Math.pow(Math.min(1, 3 / size), PARAMS.rangeSizeExp)
      width[a.seat] = lastRaise
    } else if (a.type === 'call') {
      width[a.seat] = raises === 0 ? (a.seat === sb ? 70 : 45) : Math.min(60, lastRaise * 1.6 + 4)
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
    const scaled = base * (RANGE_WIDTH[kinds[s]] || 1)
    out.push({ seat: s, width: Math.max(1.5, Math.min(100, scaled)) })
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

// ------------------------------------------------------------------ session state

const rng = makeRng(SEED)
const lineup = FIELDS[FIELD]
const used = {}
const kinds = ['hero'].concat(lineup)
const names = ['You'].concat(lineup.map((k) => {
  used[k] = (used[k] || 0) + 1
  return NAMES[k][used[k] - 1] || k + used[k]
}))
const models = lineup.map((k, i) => archetype(k, fieldSkill(k), rng, names[i + 1]))

const stacks = new Array(6).fill(BUY_IN)
const session = {
  hands: 0,
  net: 0,
  buyIns: 1,
  vpip: 0,
  pfr: 0,
  showdowns: 0,
  showdownsWon: 0,
  biggestPot: 0,
  quit: false
}

const typeTag = (s) => {
  if (s === HERO) return ''
  return BLIND ? '' : ' ' + dim('(' + TYPES[kinds[s]].label + ')')
}
const who = (s, hand) => {
  const pos = hand ? dim(positionOf(s, hand.button, 6)) : ''
  const name = s === HERO ? green(bold('You')) : cyan(names[s])
  return name + typeTag(s) + (pos ? ' ' + pos : '')
}

// ------------------------------------------------------------------ narration
//
// Rebuilt from `history` each time any seat is asked to act, so actions print
// in order as they happen, with a pause between bot actions while you are
// still in the hand.

let hand = null
const glossed = new Set()
const gloss = (term, text) => {
  if (glossed.has(term)) return ''
  glossed.add(term)
  return dim(' (' + text + ')')
}

const STREET_LABEL = { preflop: 'PRE-FLOP', flop: 'FLOP', turn: 'TURN', river: 'RIVER' }
const boardFor = (street, board) =>
  street === 'flop' ? board.slice(0, 3) : street === 'turn' ? board.slice(0, 4) : board.slice(0, 5)

const streetHeader = (street, board, note) => {
  const shown = boardFor(street, board)
  const fresh = street === 'flop' ? shown : shown.slice(-1)
  const old = street === 'flop' ? [] : shown.slice(0, -1)
  say('')
  say(yellow(bold('--- ' + STREET_LABEL[street] + ' ---')) + '   ' +
    (old.length ? cards(old) + '  ' : '') + cards(fresh) +
    '        pot ' + bold(hand.pot) + (note ? '  ' + dim(note) : ''))
  const texture = describeBoard(shown)
  if (texture) say('    ' + dim(texture))
  if (!hand.heroFolded) {
    const read = readHand(hand.hole, shown)
    say('    ' + dim('You have ') + read.made + (read.draws.length ? dim(', plus ') + read.draws.join(' and ') : ''))
  }
}

const describeAction = (a) => {
  const st = hand.streetState
  const allIn = a.allIn ? ' ' + red(bold('ALL IN')) : ''
  if (a.type === 'fold') return 'folds'
  if (a.type === 'check') {
    st.checked.add(a.seat)
    return 'checks'
  }
  if (a.type === 'call') {
    if (a.street === 'preflop' && st.raises === 0) {
      if (a.toCall === BIG_BLIND / 2 && a.amount === BIG_BLIND / 2 && positionOf(a.seat, hand.button, 6) === 'SB') {
        return 'completes the small blind to ' + a.to + gloss('limp', 'calling just the big blind rather than raising is a "limp"')
      }
      return 'limps in for ' + a.to + gloss('limp', 'calling just the big blind rather than raising -- usually a weak or passive play')
    }
    const frac = a.potBefore > 0 ? a.amount / (a.potBefore + a.amount) : 0
    return 'calls ' + a.amount + allIn +
      (frac > 0 && a.street !== 'preflop' ? dim('  (paying ' + pct(frac) + ' of the new pot)') : '')
  }
  // A raise (or a bet, when nothing was owed).
  let text
  if (a.street === 'preflop') {
    const label = st.raises === 0 ? (st.limpers > 0 ? 'raises over the limp' + (st.limpers > 1 ? 's' : '') + ' to ' : 'opens with a raise to ')
      : st.raises === 1 ? '3-bets to ' : st.raises === 2 ? '4-bets to ' : (st.raises + 2) + '-bets to '
    text = label + a.to + dim(' (' + bb(a.to) + ')')
    if (st.raises === 1) text += gloss('3bet', 're-raise of an open -- shows a strong range, or a bluff')
    if (st.raises === 2) text += gloss('4bet', 'a re-raise of a 3-bet -- usually very strong')
    hand.preflopRaiser = a.seat
  } else if (a.toCall === 0 && st.raises === 0) {
    const size = a.potBefore > 0 ? a.amount / a.potBefore : 1
    text = 'bets ' + a.amount + dim(' into ' + a.potBefore + ' (' + pct(size) + ' pot)')
    if (a.street === 'flop' && a.seat === hand.preflopRaiser) {
      text += gloss('cbet', 'a "continuation bet": the preflop raiser keeps betting')
    }
  } else {
    const check = st.checked.has(a.seat)
    text = (check ? 'check-raises to ' : st.raises >= 2 ? 're-raises to ' : 'raises to ') + a.to
    if (check) text += gloss('checkraise', 'checking, then raising a bet -- a strong move')
  }
  st.raises++
  return text + allIn
}

const flush = (history, board, view) => {
  while (hand.printed < history.length) {
    const a = history[hand.printed]
    if (a.street !== hand.street) {
      hand.street = a.street
      hand.streetState = { raises: 0, limpers: 0, checked: new Set() }
      if (a.street !== 'preflop') streetHeader(a.street, board)
    }
    if (a.seat !== HERO) sleep(FAST ? 0 : hand.heroFolded ? 120 : 550)
    const text = describeAction(a)
    if (a.street === 'preflop' && a.type === 'call' && hand.streetState.raises === 0) hand.streetState.limpers++
    hand.pot = a.potBefore + a.amount
    if (a.seat === HERO && a.type === 'fold') hand.heroFolded = true
    say('  ' + who(a.seat, hand) + ' ' + (a.seat === HERO ? text.replace(/^(\S+?)s\b/, '$1') : text))
    hand.printed++
  }
  // The first actor on a new street: the header goes up before they decide.
  if (view && view.street !== hand.street) {
    hand.street = view.street
    hand.streetState = { raises: 0, limpers: 0, checked: new Set() }
    streetHeader(view.street, board)
  }
}

// ------------------------------------------------------------------ the hero

const HELP = [
  '',
  bold('How to play'),
  '  f          fold (give up the hand)',
  '  c  or  k   call the bet, or check when there is nothing to call',
  '  1 2 3 ...  pick one of the listed bet / raise sizes',
  '  r 40       raise (or bet) to exactly 40 -- the total you will have in this street',
  '  a          all in',
  '  t          show the table      p  the players     s  your session stats',
  '  q          fold and leave the table',
  '',
  bold('Reading the screen'),
  '  pot        every chip in the middle, including bets made on this street',
  '  equity     how often your hand wins if everyone checks it down from here,',
  '             simulated against the hands each opponent is likely to hold',
  '  pot odds   the share of the final pot you are paying to call. If your',
  '             equity is higher than that, calling makes money in the long run',
  '  outs       cards still in the deck that improve you to a likely winner.',
  '             Rule of 4 and 2: outs x 4 with two cards to come, x 2 with one',
  '  bb         big blinds. 200 chips = 100 bb; win rates are quoted in bb/100 hands',
  '  T          is a ten:  T' + SUIT_GLYPH[0] + ' = ten of spades',
  ''
].join('\n')

const showPlayers = () => {
  say('')
  say(bold('The table'))
  for (let s = 1; s < 6; s++) {
    const t = TYPES[kinds[s]]
    say('  ' + cyan(names[s].padEnd(6)) + (BLIND ? '' : bold(t.label.padEnd(8)) + t.blurb))
  }
  if (BLIND) say(dim('  (playing --blind: work out who is who yourself)'))
  say('')
}

const showTable = (v, button) => {
  say('')
  for (let k = 0; k < 6; k++) {
    const s = (button + k) % 6
    const pos = positionOf(s, button, 6)
    let status = ''
    if (v) {
      if (!v.inHand[s]) status = dim('sitting out')
      else if (v.folded[s]) status = dim('folded')
      else if (v.allIn[s]) status = red('all in') + (v.committed[s] ? dim(' (' + v.committed[s] + ' this street)') : '')
      else if (v.committed[s]) status = 'in for ' + v.committed[s] + ' this street'
    } else if (pos === 'SB' || pos === 'BB') {
      status = dim('posts ' + (pos === 'SB' ? SMALL_BLIND : BIG_BLIND))
    }
    const name = s === HERO ? 'You' : names[s]
    const tag = s === HERO || BLIND ? '' : TYPES[kinds[s]].label
    say('  ' + dim(pos.padEnd(4)) + (s === HERO ? green(bold(name.padEnd(7))) : cyan(name.padEnd(7))) +
      dim(tag.padEnd(9)) + String(v ? v.stacks[s] : stacks[s]).padStart(5) + '   ' + status)
  }
}

const showStats = () => {
  const s = session
  say('')
  say(bold('Your session') + dim('  (' + FIELD + ' field, seed ' + SEED + ')'))
  say('  hands played   ' + s.hands)
  const rate = s.hands ? (s.net / BIG_BLIND) / s.hands * 100 : 0
  say('  net result     ' + (s.net >= 0 ? green(signed(s.net)) : red(signed(s.net))) + ' chips  (' +
    signed(Math.round(s.net / BIG_BLIND)) + ' bb, ' + signed(rate.toFixed(1)) + ' bb/100)')
  if (s.buyIns > 1) say('  buy-ins        ' + s.buyIns)
  if (s.hands) {
    say('  VPIP / PFR     ' + pct(s.vpip / s.hands) + ' / ' + pct(s.pfr / s.hands) +
      dim('   (hands you put money in / raised before the flop -- a solid regular runs about 22 / 18)'))
  }
  if (s.showdowns) say('  showdowns won  ' + s.showdownsWon + ' of ' + s.showdowns)
  if (s.biggestPot) say('  biggest pot    ' + s.biggestPot)
  say(dim('  A few hundred hands is noise: even a winning player swings 20+ bb/100 over that many.'))
}

// The bet / raise sizes worth offering in this spot, as "raise to" totals.
const sizeOptions = (v) => {
  const opts = []
  if (!v.canRaise) return opts
  const curBet = Math.max(...v.committed)
  const pot = v.pot
  const preflop = v.street === 'preflop'
  const add = (to, label) => {
    to = Math.round(to)
    if (to < v.minRaiseTo) to = v.minRaiseTo
    if (to >= v.maxRaiseTo) return
    if (opts.some((o) => o.to === to)) return
    opts.push({ to, label })
  }
  if (preflop && curBet <= v.bigBlind) {
    const limpers = v.history.filter((a) => a.street === 'preflop' && a.type === 'call').length
    const extra = limpers * v.bigBlind
    add(2.5 * v.bigBlind + extra, '2.5x' + (limpers ? ' + 1 bb per limper' : '') + ', a small open')
    add(3 * v.bigBlind + extra, '3x' + (limpers ? ' + 1 bb per limper' : '') + ', the standard open')
    add(4 * v.bigBlind + extra, '4x' + (limpers ? ' + 1 bb per limper' : '') + ', a big open')
  } else if (preflop) {
    add(3 * curBet, '3x their raise, a standard re-raise in position')
    add(4 * curBet, '4x their raise, standard out of position')
    add(curBet + pot + v.toCall, 'a pot-sized raise')
  } else if (curBet === 0) {
    add(pot / 3, 'one third of the pot -- cheap, for thin value or a probe')
    add(pot / 2, 'half the pot')
    add(pot * 2 / 3, 'two thirds of the pot -- the standard size')
    add(pot, 'the full pot -- for big hands and big draws')
  } else {
    add(v.minRaiseTo, 'the minimum raise')
    add(curBet + (pot + v.toCall) * 0.66, 'a two-thirds-pot raise')
    add(curBet + pot + v.toCall, 'a pot-sized raise')
  }
  opts.sort((x, y) => x.to - y.to)
  // A minimum raise is worth offering against a bet; a 2-chip lead into a
  // big pot is not.
  if (curBet > 0 && opts.length && opts[0].to !== v.minRaiseTo && v.minRaiseTo < v.maxRaiseTo) {
    opts.unshift({ to: v.minRaiseTo, label: 'the minimum' })
  }
  return opts
}

const coachLine = (v, equity, read) => {
  const lines = []
  const preflop = v.street === 'preflop'
  const need = v.toCall > 0 ? v.toCall / (v.pot + v.toCall) : 0
  if (preflop) {
    const pos = positionOf(v.seat, v.button, v.numPlayers)
    const rank = handRank(handIndex(v.holeCards[0], v.holeCards[1]), 1)
    const raised = v.history.some((a) => a.street === 'preflop' && a.type === 'raise')
    if (!raised) {
      if (pos === 'BB') {
        lines.push(rank < 12 ? 'Nobody raised: a strong hand like this should raise for value.'
          : 'Nobody raised, so you can see the flop for free -- check unless your hand is strong.')
      } else {
        const width = OPEN_WIDTH[pos]
        lines.push('From ' + pos + ' a solid player raises roughly the top ' + width + '% of hands. Yours is in the top ' +
          Math.max(1, Math.round(rank)) + '% -- ' +
          (rank < width ? 'a raise.' : rank < width * 1.4 ? 'borderline; folding or raising are both fine.' : 'a fold for most good players.'))
      }
    } else {
      lines.push('Facing a raise you need a better hand than the raiser\'s whole range, not just a playable one: ' +
        (equity > 0.55 ? 'you are a favourite here, so a re-raise is reasonable.'
          : equity > need + 0.08 ? 'calling is reasonable, especially with position.'
            : 'folding is usually right unless the price is very small.'))
    }
    return lines
  }
  if (v.toCall > 0) {
    if (equity > need + 0.12) lines.push('Your equity clears the price comfortably -- calling (or raising for value) shows a profit.')
    else if (equity > need - 0.04) lines.push('A close call on the numbers. Position, the bettor\'s type and future bets decide it.')
    else if (read.outs >= 8 && v.street !== 'river') lines.push('Behind on the numbers, but a real draw: a call can pay if you will win a big pot when it hits (implied odds).')
    else lines.push('Your equity is below the price. Calling only works if they bluff more often than these numbers assume.')
  } else {
    if (equity > 0.65) lines.push('You are likely ahead. Betting makes worse hands pay you; checking risks giving free cards.')
    else if (equity > 0.4) lines.push('Medium strength: a check keeps the pot small, a modest bet can take it down or protect.')
    else lines.push('Probably behind. Check, or bet as a bluff if this opponent folds often.')
  }
  lines.push(dim('Equity guesses ranges from the preflop action only; a bet after the flop usually means a stronger hand than that.'))
  return lines
}

const heroAct = (v) => {
  flush(v.history, v.board, v)
  if (session.quit) return { action: v.toCall > 0 ? 'fold' : 'check' }

  const preflop = v.street === 'preflop'
  const pos = positionOf(v.seat, v.button, v.numPlayers)
  const opponents = opponentRanges(v, kinds)
  const read = readHand(v.holeCards, v.board)
  const equity = equityVs(v.holeCards, v.board, opponents)
  const need = v.toCall > 0 ? v.toCall / (v.pot + v.toCall) : 0

  say('')
  say(green(bold('>> Your turn')) + dim(' -- ' + STREET_LABEL[v.street].toLowerCase() + ', ' + pos))
  say('   Your cards  ' + cards(v.holeCards) + (v.board.length ? '     Board  ' + cards(v.board) : ''))
  say('   Pot ' + bold(v.pot) + '     Your stack ' + bold(v.stack) + dim(' (' + bb(v.stack) + ')') +
    '     Opponents still in: ' + v.folded.filter((f, s) => s !== v.seat && v.inHand[s] && !f).length)
  if (!preflop) {
    say('   Hand        ' + read.made)
    if (read.draws.length) say('   Drawing to  ' + read.draws.join(', '))
    if (read.outs > 0 && v.street !== 'river') {
      const toCome = 5 - v.board.length
      say('   Outs        about ' + read.outs + dim(' -> roughly ' + Math.min(100, read.outs * (toCome === 2 ? 4 : 2)) +
        '% to improve by the river (rule of ' + (toCome === 2 ? '4' : '2') + ')'))
    }
  }
  if (COACH) {
    say('   Equity      ' + bold(pct(equity)) + dim(' against ' + opponents.map((o) =>
      names[o.seat] + ' (~top ' + Math.round(o.width) + '%)').join(', ')))
    // Limping in before anyone raises is not a pot-odds decision, and quoting
    // one there would make limping look like a price worth paying.
    const opened = v.history.some((a) => a.street === 'preflop' && a.type === 'raise')
    if (v.toCall > 0 && (!preflop || opened)) {
      say('   Price       ' + 'call ' + bold(v.toCall) + ' to win ' + v.pot + dim(' -> you need ' + pct(need) +
        ' equity to break even (pot odds)'))
    }
    for (const line of coachLine(v, equity, read)) say('   ' + magenta('Coach') + '       ' + line)
  } else if (v.toCall > 0) {
    say('   To call     ' + bold(v.toCall))
  }

  const sizes = sizeOptions(v)
  const verb = v.toCall === 0 && Math.max(...v.committed) === 0 ? 'bet' : 'raise to'
  say('')
  say('   ' + bold('f') + '  fold')
  say('   ' + bold('c') + '  ' + (v.toCall > 0 ? 'call ' + v.toCall + (v.toCall >= v.stack ? ' (all in)' : '') : 'check'))
  sizes.forEach((o, i) => say('   ' + bold(String(i + 1)) + '  ' + verb + ' ' + o.to + dim('   ' + o.label +
    (v.street === 'preflop' ? '' : '') + ' (' + bb(o.to) + ')')))
  if (v.canRaise) say('   ' + bold('a') + '  all in for ' + v.maxRaiseTo + dim('   (' + bb(v.maxRaiseTo) + ')'))
  say(dim('   r <amount> to ' + (verb === 'bet' ? 'bet' : 'raise to') + ' any amount  ·  ? help  ·  t table  ·  p players  ·  s stats  ·  q quit'))

  while (true) {
    const input = ask(green('> '))
    if (input === '' ) continue
    if (input === '?' || input === 'h' || input === 'help') {
      say(HELP)
      continue
    }
    if (input === 't') { showTable(v, v.button); continue }
    if (input === 'p') { showPlayers(); continue }
    if (input === 's') { showStats(); continue }
    if (input === 'q') {
      const sure = inputClosed ? 'y' : ask('Fold this hand and leave the table? (y/n) ')
      if (sure.startsWith('y')) {
        session.quit = true
        return { action: v.toCall > 0 ? 'fold' : 'check' }
      }
      continue
    }
    if (input === 'f' || input === 'fold') {
      if (v.toCall === 0) {
        say(dim('   Checking is free here, so you check instead of folding.'))
        return { action: 'check' }
      }
      return { action: 'fold' }
    }
    if (input === 'c' || input === 'k' || input === 'call' || input === 'check') {
      return { action: v.toCall > 0 ? 'call' : 'check' }
    }
    if (input === 'a' || input === 'allin' || input === 'all in') {
      if (!v.canRaise) {
        say(dim('   You cannot raise here -- call (c) puts you all in if it covers your stack.'))
        continue
      }
      return { action: 'raise', to: v.maxRaiseTo }
    }
    if (/^\d+$/.test(input) && Number(input) >= 1 && Number(input) <= sizes.length) {
      return { action: 'raise', to: sizes[Number(input) - 1].to }
    }
    const m = input.match(/^(?:r|b|raise|bet)\s*(\d*)$/)
    if (m) {
      if (!v.canRaise) {
        say(dim('   Raising is not allowed here (nobody has re-opened the betting).'))
        continue
      }
      let amount = m[1] ? Number(m[1]) : NaN
      if (!m[1]) {
        const got = ask('   ' + (verb === 'bet' ? 'Bet' : 'Raise to') + ' how much? (' + v.minRaiseTo + ' to ' + v.maxRaiseTo + ') ')
        amount = Number(got)
      }
      if (!Number.isFinite(amount) || amount < v.minRaiseTo || amount > v.maxRaiseTo) {
        say(dim('   That has to be between ' + v.minRaiseTo + ' (the minimum raise) and ' + v.maxRaiseTo + ' (all in).'))
        continue
      }
      return { action: 'raise', to: amount }
    }
    say(dim('   Not sure what "' + input + '" means -- type ? for help.'))
  }
}

const hero = { name: 'You', act: heroAct }
const bots = [hero].concat(models.map((m) => ({
  name: m.name,
  act: (v) => {
    flush(v.history, v.board, v)
    return m.act(v)
  },
  observe: m.observe
})))

// ------------------------------------------------------------------ a hand

const playOne = (button) => {
  for (let s = 1; s < 6; s++) {
    if (stacks[s] === 0) {
      stacks[s] = BUY_IN
      say(dim('  ' + names[s] + ' reloads for ' + BUY_IN + '.'))
    }
  }

  session.hands++
  // The deck is shuffled here rather than inside playHand -- the same call on
  // the same rng, so nothing changes -- because the hero's cards have to be
  // on screen before anybody acts. The engine deals one card at a time
  // starting left of the button, so seat s gets cards k and k + 6.
  const deck = shuffle(makeDeck(), rng)
  const k = (HERO - button - 1 + 12) % 6
  hand = {
    button,
    printed: 0,
    street: 'preflop',
    streetState: { raises: 0, limpers: 0, checked: new Set() },
    pot: SMALL_BLIND + BIG_BLIND,
    hole: [deck[k], deck[k + 6]],
    heroFolded: false,
    preflopRaiser: -1
  }

  say('')
  say(bold('=================== Hand #' + session.hands + ' ===================') +
    dim('   blinds ' + SMALL_BLIND + '/' + BIG_BLIND))
  showTable(null, button)
  const idx = handIndex(hand.hole[0], hand.hole[1])
  const label = handLabel(idx)
  const nick = NICKNAMES[label] ? ' "' + NICKNAMES[label] + '"' : ''
  const pos = positionOf(HERO, button, 6)
  say('')
  say('  Your cards: ' + cards(hand.hole) + '   ' + bold(handName(idx)) + dim(nick))
  say('  ' + dim('That is ' + handClass(idx) + '. Top ' + Math.max(1, Math.round(handRank(idx, 1))) +
    '% of starting hands.'))
  say('  ' + dim('You are ' + pos + ': ' + POSITION_BLURB[pos]))
  say('')
  say(yellow(bold('--- PRE-FLOP ---')) + dim('   (blinds are in; the action starts left of the big blind)'))

  const startStack = stacks[HERO]
  const result = playHand({
    bots,
    stacks,
    button,
    smallBlind: SMALL_BLIND,
    bigBlind: BIG_BLIND,
    rng,
    deck
  })

  flush(result.actions, result.board, null)
  // An all-in with cards still to come: the rest of the board runs out with
  // nobody left to bet.
  const LEN = { preflop: 0, flop: 3, turn: 4, river: 5 }
  const shown = LEN[hand.street]
  let first = true
  for (const st of ['flop', 'turn', 'river']) {
    if (LEN[st] <= shown || LEN[st] > result.board.length) continue
    sleep(FAST ? 0 : 900)
    hand.street = st
    streetHeader(st, result.board, first ? '(no more betting -- the cards run out)' : '')
    first = false
  }

  report(result, startStack)

  for (let s = 0; s < 6; s++) stacks[s] = result.stacks[s]
  for (let s = 1; s < 6; s++) if (models[s - 1].observe) models[s - 1].observe(result, s)
}

const report = (result, startStack) => {
  say('')
  if (result.wentToShowdown) {
    say(bold('Showdown'))
    const best = Math.max(...result.showdown.map((sd) => sd.score))
    for (const sd of result.showdown) {
      const r = readHandName(sd.score)
      say('  ' + who(sd.seat, hand) + '  ' + cards(result.holeCards[sd.seat]) + '   ' +
        (sd.score === best ? bold(r) : r))
    }
    if (hand.heroFolded) say(dim('  (you folded ' + cards(hand.hole) + ')'))
  }
  // The engine builds a pot layer at every distinct commitment level, folded
  // players included, so layers contested by the same players are one pot as
  // far as anyone at the table is concerned. Merge those, and only name main
  // and side pots when there really is more than one.
  const potGroup = []
  const groupKeys = []
  result.pots.forEach((p, i) => {
    const key = p.eligible.join(',')
    if (!groupKeys.includes(key)) groupKeys.push(key)
    potGroup[i] = groupKeys.indexOf(key)
  })
  const takes = new Map()
  for (const w of result.winners) {
    const key = w.seat + ':' + (groupKeys.length > 1 ? potGroup[w.pot] : 0)
    const got = takes.get(key) || { seat: w.seat, group: potGroup[w.pot], amount: 0 }
    got.amount += w.amount
    takes.set(key, got)
  }
  for (const w of takes.values()) {
    const potName = groupKeys.length > 1 ? (w.group === 0 ? ' from the main pot' : ' from side pot ' + w.group) : ''
    const how = result.wentToShowdown ? '' : dim(' -- everyone else folded, no cards shown')
    say('  ' + who(w.seat, hand) + (w.seat === HERO ? ' win ' : ' wins ') + bold(w.amount) + potName + how)
  }

  const delta = result.stacks[HERO] - startStack
  session.net += delta
  const pre = result.actions.filter((a) => a.seat === HERO && a.street === 'preflop')
  if (pre.some((a) => a.type === 'call' || a.type === 'raise')) session.vpip++
  if (pre.some((a) => a.type === 'raise')) session.pfr++
  if (result.wentToShowdown && result.showdown.some((sd) => sd.seat === HERO)) {
    session.showdowns++
    if (result.winners.some((w) => w.seat === HERO)) session.showdownsWon++
  }
  const won = result.winners.filter((w) => w.seat === HERO).reduce((a, w) => a + w.amount, 0)
  if (won > session.biggestPot) session.biggestPot = won

  say('')
  const chips = (n) => n + (Math.abs(n) === 1 ? ' chip' : ' chips')
  const line = delta > 0 ? green(bold('You won ' + chips(delta))) + dim(' (' + signed(delta / BIG_BLIND) + ' bb)')
    : delta < 0 ? red('You lost ' + chips(-delta)) + dim(' (' + (delta / BIG_BLIND) + ' bb)')
      : dim('You broke even this hand.')
  say('  ' + line + '     stack ' + bold(result.stacks[HERO]) +
    dim('     session ' + signed(session.net) + ' over ' + session.hands + ' hand' + (session.hands > 1 ? 's' : '')))
}

const readHandName = (sc) => {
  const cat = categoryOf(sc)
  const r1 = (sc >> 16) & 15
  const r2 = (sc >> 12) & 15
  switch (cat) {
    case 0: return RANK_NAME[r1] + ' high'
    case PAIR: return 'a pair of ' + RANK_PLURAL[r1]
    case TWO_PAIR: return 'two pair, ' + RANK_PLURAL[r1] + ' and ' + RANK_PLURAL[r2]
    case TRIPS: return 'three ' + RANK_PLURAL[r1]
    case STRAIGHT: return 'a straight, ' + RANK_NAME[r1] + ' high'
    case FLUSH: return 'a flush, ' + RANK_NAME[r1] + ' high'
    case FULL_HOUSE: return 'a full house, ' + RANK_PLURAL[r1] + ' full of ' + RANK_PLURAL[r2]
    case QUADS: return 'four ' + RANK_PLURAL[r1]
    case STRAIGHT_FLUSH: return r1 === 12 ? 'a royal flush' : 'a straight flush, ' + RANK_NAME[r1] + ' high'
    default: return '?'
  }
}

// ------------------------------------------------------------------ main

const main = () => {
  say('')
  say(bold('Texas Hold\'em -- six-max no-limit, blinds 1/2, 200-chip stacks (100 big blinds)'))
  say(dim('You sit with five players from the fitted personality model (' + FIELD + ' field). ' +
    'Each plays at the skill level it was calibrated to, so they make the mistakes real players make.'))
  showPlayers()
  say(dim('Type ? at any decision for help. The coach lines (equity, pot odds, advice) are estimates, not orders.'))
  ask(dim('Press Enter to deal. '))

  let button = Math.floor(rng() * 6)
  while (!session.quit) {
    playOne(button)
    button = (button + 1) % 6
    if (session.quit || inputClosed) break

    if (stacks[HERO] === 0) {
      const again = ask('\nYou are out of chips. Buy in again for ' + BUY_IN + '? (y/n) ')
      if (!again.startsWith('y')) break
      stacks[HERO] = BUY_IN
      session.buyIns++
    }

    while (true) {
      const next = ask(dim('\n[Enter] next hand   s stats   t table   p players   q quit  '))
      if (next === 'q') {
        session.quit = true
        break
      }
      if (next === 's') { showStats(); continue }
      if (next === 'p') { showPlayers(); continue }
      if (next === 't') { showTable(null, button); continue }
      break
    }
  }
  showStats()
  say('')
  say('Thanks for playing.')
}

main()
