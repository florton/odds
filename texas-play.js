// Texas Hold'em -- sit down at the table yourself.
//
//   node texas-play.js                  you against the realistic field
//   node texas-play.js --field tough    nit, two TAGs, a LAG and one fish
//   node texas-play.js --field soft     three fish, a TAG and a nit
//   node texas-play.js --seed 7         replay a session (same deals while you play the same way)
//   node texas-play.js --slow           pause between the bots' actions (--pace <ms> to pick)
//   node texas-play.js --no-coach       hide the equity / pot-odds / textbook lines
//   node texas-play.js --ascii          s h d c instead of suit symbols
//   node texas-play.js --no-color
//
// Six-max no-limit, blinds 1/2, everybody starts with 200 (100 big blinds).
// You are seat 0 in texas-engine.js like any other bot: your `act` just reads
// the keyboard instead of a model. The five opponents come from
// texas-opponents.js: regulars who read lines, keep a HUD on every seat (you
// included) and adjust, and fish with the systematic leaks real fish have.
// Every field has at least one fish (a station or a maniac) in it. The
// textbook line the coach shows is texas-textbook.js; played blindly it
// breaks about even at the realistic table (`node texas-textbook.js --table`).
//
// The narration is rebuilt from the hand's public history -- the same record
// the bots decide from -- so nothing printed here is information a player at
// a real table would not have. That includes the opponents' types: seats,
// names and the equity estimate are all type-blind, and the only read you get
// is the one you build yourself (p shows the VPIP / PFR you have seen). The
// types are revealed when you leave.

const fs = require('fs')
const { playHand, makeRng, makeDeck, shuffle } = require('./texas-engine')
const {
  RANKS, evaluate, categoryOf,
  PAIR, TWO_PAIR, TRIPS, STRAIGHT, FLUSH, FULL_HOUSE, QUADS, STRAIGHT_FLUSH
} = require('./texas-eval')
const { handIndex, handRank, countOuts } = require('./texas-equity')
const { positionOf, opponentRanges, equityVs, sizeOptions, decide } = require('./texas-textbook')
const { makeOpponent } = require('./texas-opponents')

// ------------------------------------------------------------------ options

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt
}

// No pause by default; --fast is still accepted from the old default.
const PACE = Math.max(0, Number(option('--pace', flag('--slow') ? 450 : 0)) || 0)
const COACH = !flag('--no-coach')
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
  tough: ['nit', 'tag', 'tag', 'lag', 'station'],
  soft: ['station', 'maniac', 'station', 'tag', 'nit']
}

const TYPE_LABEL = {
  nit: 'Nit', tag: 'TAG', lag: 'LAG', station: 'Calling station (fish)', maniac: 'Maniac (fish)'
}

// Names carry no hint of the type: they are shuffled onto shuffled seats.
const NAME_POOL = ['Alex', 'Blake', 'Casey', 'Drew', 'Emery', 'Finn', 'Gray', 'Harper',
  'Jordan', 'Kai', 'Logan', 'Morgan', 'Quinn', 'Reese', 'Sam', 'Toby']

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

// ------------------------------------------------------------------ hand reading

const handName = (idx) => {
  const a = Math.floor(idx / 13)
  const b = idx % 13
  if (a === b) return 'pair of ' + RANK_PLURAL[a]
  const hi = a > b ? a : b
  const lo = a > b ? b : a
  return RANK_NAME[hi] + '-' + RANK_NAME[lo] + (a > b ? ' suited' : ' offsuit')
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

// What the hero's hand is right now, plus whatever it is drawing to. Names
// only -- how much the hand is worth is the equity line's job.
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
    made = 'the board plays (a split at best)'
  } else if (cat === 0) {
    made = RANK_NAME[r1] + ' high'
  } else if (cat === PAIR) {
    if (pocket && r1 === h0) {
      made = r1 > distinct[0] ? 'overpair, ' + RANK_PLURAL[r1] : 'underpair, ' + RANK_PLURAL[r1]
    } else if (onBoard(r1) === 2) {
      made = 'the board\'s pair of ' + RANK_PLURAL[r1] + ', ' + RANK_NAME[Math.max(h0, h1)] + ' kicker'
    } else {
      const where = distinct.indexOf(r1)
      const kicker = h0 === r1 ? h1 : h0
      const which = where === 0 ? 'top pair' : where === 1 ? 'second pair'
        : where === distinct.length - 1 ? 'bottom pair' : 'third pair'
      made = which + ', ' + RANK_PLURAL[r1] + ', ' + RANK_NAME[kicker] + ' kicker'
    }
  } else if (cat === TWO_PAIR) {
    const boardPaired = distinct.length < boardRanks.length
    made = 'two pair, ' + RANK_PLURAL[r1] + ' and ' + RANK_PLURAL[r2] +
      (boardPaired ? ' (one pair is on the board)' : '')
  } else if (cat === TRIPS) {
    if (pocket) made = 'set of ' + RANK_PLURAL[r1]
    else if (onBoard(r1) === 3) made = 'trip ' + RANK_PLURAL[r1] + ' on the board (kickers play)'
    else made = 'trips, ' + RANK_PLURAL[r1]
  } else if (cat === STRAIGHT) {
    made = 'straight, ' + RANK_NAME[r1] + ' high'
  } else if (cat === FLUSH) {
    made = r1 === 12 ? 'nut flush' : 'flush, ' + RANK_NAME[r1] + ' high'
  } else if (cat === FULL_HOUSE) {
    made = 'full house, ' + RANK_PLURAL[r1] + ' full of ' + RANK_PLURAL[r2]
  } else if (cat === QUADS) {
    made = 'four ' + RANK_PLURAL[r1]
  } else {
    made = r1 === 12 ? 'royal flush' : 'straight flush, ' + RANK_NAME[r1] + ' high'
  }

  const draws = []
  if (board.length < 5) {
    if (cat < FLUSH) {
      for (let suit = 0; suit < 4; suit++) {
        const mine = hole.filter((c) => (c & 3) === suit).length
        if (mine === 0) continue
        const n = all.filter((c) => (c & 3) === suit).length
        if (n === 4) draws.push('flush draw (9 cards)')
        else if (n === 3 && board.length === 3 && mine === 2) draws.push('backdoor flush draw')
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
      if (completing >= 2) draws.push('open-ended straight draw (8 cards)')
      else if (completing === 1) draws.push('gutshot (4 cards)')
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
  if (board.length === 3) notes.push(most === 3 ? 'monotone' : most === 2 ? 'two-tone' : 'rainbow')
  else if (most >= 3) notes.push(most + ' to a flush')
  const ranks = board.map((c) => c >> 2)
  if (new Set(ranks).size < ranks.length) notes.push('paired')
  const mask = rankMask(board)
  let connected = false
  for (let low = 0; low <= 9; low++) {
    let n = 0
    for (let k = 0; k < 5; k++) if (mask & (1 << (low + k))) n++
    if (n >= 3) connected = true
  }
  if (connected) notes.push('straight possible')
  return notes.join(', ')
}

// ------------------------------------------------------------------ session state

const rng = makeRng(SEED)
// Seating gets its own stream so the deals for a seed do not depend on it.
const seatRng = makeRng((SEED ^ 0x9e3779b9) >>> 0)
const lineup = shuffle(FIELDS[FIELD].slice(), seatRng)
const kinds = ['hero'].concat(lineup)
const names = ['You'].concat(shuffle(NAME_POOL.slice(), seatRng).slice(0, lineup.length))
const models = lineup.map((k, i) => makeOpponent(k, rng, names[i + 1]))

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
// What you have seen each opponent do: the HUD a player keeps in their head.
const seen = names.map(() => ({ hands: 0, vpip: 0, pfr: 0, showdowns: 0 }))

const who = (s, h) => {
  const pos = h ? dim(positionOf(s, h.button, 6)) : ''
  const name = s === HERO ? green(bold('You')) : cyan(names[s])
  return name + (pos ? ' ' + pos : '')
}

// ------------------------------------------------------------------ narration
//
// Rebuilt from `history` each time any seat is asked to act, so actions print
// in order as they happen. Once you fold, the rest of the hand is collected
// into a one-line summary instead.

let hand = null
const glossed = new Set()
const gloss = (term, text) => {
  if (glossed.has(term) || hand.heroFolded) return ''
  glossed.add(term)
  return dim(' (' + text + ')')
}

const STREET_LABEL = { preflop: 'PRE-FLOP', flop: 'FLOP', turn: 'TURN', river: 'RIVER' }
const boardFor = (street, board) =>
  street === 'flop' ? board.slice(0, 3) : street === 'turn' ? board.slice(0, 4) : board.slice(0, 5)

const streetHeader = (street, board, note) => {
  const shown = boardFor(street, board)
  if (hand.heroFolded) {
    hand.rest.push(dim(STREET_LABEL[street]) + ' ' + cards(street === 'flop' ? shown : shown.slice(-1)))
    return
  }
  const fresh = street === 'flop' ? shown : shown.slice(-1)
  const old = street === 'flop' ? [] : shown.slice(0, -1)
  const texture = describeBoard(shown)
  say(yellow(bold(STREET_LABEL[street])) + '  ' + (old.length ? cards(old) + '  ' : '') + cards(fresh) +
    '   pot ' + bold(hand.pot) + (texture ? dim('   ' + texture) : '') + (note ? '  ' + dim(note) : ''))
  // Nobody is left to bet, so there is no decision block to show the hand in.
  if (note !== undefined) {
    const read = readHand(hand.hole, shown)
    say('  ' + dim('you: ') + read.made + (read.draws.length ? dim(' + ') + read.draws.join(', ') : ''))
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
        return 'completes to ' + a.to + gloss('limp', 'calling the big blind without raising is a "limp"')
      }
      return 'limps for ' + a.to + gloss('limp', 'calling the big blind without raising')
    }
    return 'calls ' + a.amount + allIn
  }
  // A raise (or a bet, when nothing was owed).
  let text
  if (a.street === 'preflop') {
    const label = st.raises === 0 ? (st.limpers > 0 ? 'raises over the limp' + (st.limpers > 1 ? 's' : '') + ' to ' : 'opens to ')
      : st.raises === 1 ? '3-bets to ' : st.raises === 2 ? '4-bets to ' : (st.raises + 2) + '-bets to '
    text = label + a.to + dim(' (' + bb(a.to) + ')')
    if (st.raises === 1) text += gloss('3bet', 'the re-raise of an open')
    if (st.raises === 2) text += gloss('4bet', 'the re-raise of a 3-bet')
    hand.preflopRaiser = a.seat
  } else if (a.toCall === 0 && st.raises === 0) {
    const size = a.potBefore > 0 ? a.amount / a.potBefore : 1
    text = 'bets ' + a.amount + dim(' (' + pct(size) + ' pot)')
    if (a.street === 'flop' && a.seat === hand.preflopRaiser) {
      text += gloss('cbet', 'a continuation bet: the preflop raiser bets the flop')
    }
  } else {
    const check = st.checked.has(a.seat)
    text = (check ? 'check-raises to ' : st.raises >= 2 ? 're-raises to ' : 'raises to ') + a.to
    if (check) text += gloss('checkraise', 'a check, then a raise after someone bets')
  }
  st.raises++
  return text + allIn
}

const newStreet = (street, board) => {
  hand.street = street
  hand.streetState = { raises: 0, limpers: 0, checked: new Set() }
  if (street !== 'preflop') streetHeader(street, board)
}

const flush = (history, board, view) => {
  while (hand.printed < history.length) {
    const a = history[hand.printed]
    if (a.street !== hand.street) newStreet(a.street, board)
    if (a.seat !== HERO && !hand.heroFolded) sleep(PACE)
    const text = describeAction(a)
    if (a.street === 'preflop' && a.type === 'call' && hand.streetState.raises === 0) hand.streetState.limpers++
    hand.pot = a.potBefore + a.amount
    if (hand.heroFolded) {
      hand.rest.push(names[a.seat] + ' ' + text.replace(/ \(.*?\)/g, ''))
    } else {
      say('  ' + who(a.seat, hand) + ' ' + (a.seat === HERO ? text.replace(/^(\S+?)s\b/, '$1') : text))
    }
    if (a.seat === HERO && a.type === 'fold') hand.heroFolded = true
    hand.printed++
  }
  // The first actor on a new street: the header goes up before they decide.
  if (view && view.street !== hand.street) newStreet(view.street, board)
}

// ------------------------------------------------------------------ the hero

const HELP = [
  '',
  bold('Keys'),
  '  f          fold',
  '  c  or  k   call, or check when there is nothing to call',
  '  1 2 3 ...  one of the listed bet / raise sizes',
  '  r 40       raise (or bet) to exactly 40 -- your total for this street',
  '  a          all in',
  '  t  table   p  players (what you have seen them do)   s  session stats   q  leave',
  '',
  bold('Numbers'),
  '  pot        every chip in the middle, this street\'s bets included',
  '  equity     how often your hand wins at showdown, simulated against a range',
  '             for each opponent guessed from their preflop action only. Bets',
  '             after the flop are not counted, so it runs high against them',
  '  pot odds   the share of the final pot you pay to call: call when your',
  '             equity is above it',
  '  outs       cards that improve you. Rule of 4 and 2: outs x 4 with two cards',
  '             to come, x 2 with one',
  '  VPIP/PFR   how often a player puts money in / raises before the flop',
  '  bb         big blinds. 200 chips = 100 bb; win rates are bb per 100 hands',
  '  T          a ten:  T' + SUIT_GLYPH[0] + ' = ten of spades',
  '',
  bold('Textbook line'),
  '  Preflop: raise first in with the standard opening range for your seat',
  '  (UTG 15%, HJ 19%, CO 27%, BTN 45%, SB 38%), never limp; over limpers raise',
  '  a range 60% as wide. Facing a raise: 3-bet JJ+ and AK, call pairs when 15x',
  '  the call is behind, call the top 8% in position, defend the big blind with',
  '  the top 20% (35% against a late-position raise) at a price; the small',
  '  blind 3-bets or folds. Facing a 3-bet: 4-bet QQ+ and AK, call JJ, TT, AQs.',
  '  Facing a 4-bet: AA and KK get it in, QQ and AK call a shove.',
  '  Postflop: bet or raise for value at 60% / 70% equity, c-bet the flop',
  '  heads-up as the preflop raiser, otherwise call when equity beats the pot',
  '  odds and fold when it does not.',
  '',
  bold('About the table'),
  '  The regulars read your whole line, keep stats on you and adjust. The',
  '  textbook line does not: its equity counts only the preflop action, so',
  '  following it blindly pays off their bets. It breaks about even here.',
  ''
].join('\n')

const showPlayers = () => {
  say('')
  say(bold('What you have seen') + dim('   VPIP / PFR over the hands they were dealt'))
  for (let s = 1; s < 6; s++) {
    const p = seen[s]
    const stat = p.hands ? pct(p.vpip / p.hands).padStart(4) + ' / ' + pct(p.pfr / p.hands).padEnd(4) : '  -- / --  '
    say('  ' + cyan(names[s].padEnd(8)) + stat + dim('   ' + p.hands + ' hands, ' + p.showdowns + ' shown down'))
  }
  say(dim('  Under ~30 hands these numbers are mostly noise.'))
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
    }
    const name = s === HERO ? 'You' : names[s]
    say('  ' + dim(pos.padEnd(4)) + (s === HERO ? green(bold(name.padEnd(8))) : cyan(name.padEnd(8))) +
      String(v ? v.stacks[s] : stacks[s]).padStart(5) + '   ' + status)
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
      dim('   (a standard six-max range is about 22 / 18)'))
  }
  if (s.showdowns) say('  showdowns won  ' + s.showdownsWon + ' of ' + s.showdowns)
  if (s.biggestPot) say('  biggest pot    ' + s.biggestPot)
  say(dim('  Over a few hundred hands, results swing 20+ bb/100 either way.'))
}

// Lays out items on lines no wider than `width`, measured without colour codes.
const wrapItems = (items, width, indent) => {
  const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')
  const lines = []
  let line = ''
  for (const it of items) {
    if (line && plain(line).length + 3 + plain(it).length > width) {
      lines.push(line)
      line = ''
    }
    line += (line ? '   ' : '') + it
  }
  if (line) lines.push(line)
  return lines.map((l) => indent + l)
}

const heroAct = (v) => {
  flush(v.history, v.board, v)
  if (session.quit) return { action: v.toCall > 0 ? 'fold' : 'check' }

  const preflop = v.street === 'preflop'
  const pos = positionOf(v.seat, v.button, v.numPlayers)
  const opponents = opponentRanges(v)
  const equity = equityVs(v.holeCards, v.board, opponents)
  const need = v.toCall > 0 ? v.toCall / (v.pot + v.toCall) : 0
  const live = v.folded.filter((f, s) => s !== v.seat && v.inHand[s] && !f).length

  say(green(bold('>> ' + STREET_LABEL[v.street].toLowerCase() + ', ' + pos)) +
    '   pot ' + bold(v.pot) + '   stack ' + bold(v.stack) + dim(' (' + bb(v.stack) + ')') +
    '   ' + live + ' opponent' + (live === 1 ? '' : 's'))
  if (preflop) {
    const idx = handIndex(v.holeCards[0], v.holeCards[1])
    say('   ' + cards(v.holeCards) + '  ' + handName(idx) + dim(', top ' + Math.max(1, Math.round(handRank(idx, 1))) + '% of hands'))
  } else {
    const read = readHand(v.holeCards, v.board)
    let line = '   ' + cards(v.holeCards) + '  ' + read.made + (read.draws.length ? dim(' + ') + read.draws.join(', ') : '')
    if (read.outs > 0 && v.street !== 'river') {
      const toCome = 5 - v.board.length
      line += dim('   ' + read.outs + ' outs ~ ' + Math.min(100, read.outs * (toCome === 2 ? 4 : 2)) + '% by the river')
    }
    say(line)
  }
  const sizes = sizeOptions(v)
  if (COACH) {
    let line = '   equity ' + bold(pct(equity)) + dim(' vs ' + opponents.map((o) =>
      names[o.seat] + ' ' + Math.round(o.width) + '%').join(', '))
    // Limping in before anyone raises is not a pot-odds decision, and quoting
    // one there would make limping look like a price worth paying.
    const opened = v.history.some((a) => a.street === 'preflop' && a.type === 'raise')
    if (v.toCall > 0 && (!preflop || opened)) {
      line += '   pot odds ' + bold(pct(need)) + dim(' (' + v.toCall + ' to win ' + v.pot + ')')
    }
    say(line)
    const book = decide(v, equity, sizes)
    const i = book.action === 'raise' ? sizes.findIndex((o) => o.to === book.to) : -1
    const key = book.action === 'fold' ? 'f' : book.action !== 'raise' ? 'c'
      : i >= 0 ? String(i + 1) : book.to >= v.maxRaiseTo ? 'a' : 'r ' + book.to
    say('   ' + magenta('textbook') + '  ' + book.text + dim('  [' + key + ']'))
  }

  const verb = v.toCall === 0 && Math.max(...v.committed) === 0 ? 'bet' : 'raise'
  const items = [bold('f') + ' fold', bold('c') + ' ' + (v.toCall > 0 ? 'call ' + v.toCall + (v.toCall >= v.stack ? ' (all in)' : '') : 'check')]
  sizes.forEach((o, i) => items.push(bold(String(i + 1)) + ' ' + verb + ' ' + o.to + dim(' ' + o.label)))
  if (v.canRaise) items.push(bold('a') + ' all in ' + v.maxRaiseTo)
  items.push(dim('? help'))
  for (const l of wrapItems(items, 96, '   ')) say(l)

  while (true) {
    const input = ask(green('> '))
    if (input === '') continue
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
        say(dim('   Nothing to call -- you check.'))
        return { action: 'check' }
      }
      return { action: 'fold' }
    }
    if (input === 'c' || input === 'k' || input === 'call' || input === 'check') {
      return { action: v.toCall > 0 ? 'call' : 'check' }
    }
    if (input === 'a' || input === 'allin' || input === 'all in') {
      if (!v.canRaise) {
        say(dim('   You cannot raise here -- c calls, which puts you all in if it covers your stack.'))
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
  // The opponents play a 100bb game the way a real table cycles: a short
  // stack tops up, and a big one takes chips off (as if they left and sat
  // back down). Left alone, winning regulars sat with 1000+ chips and pots ran
  // to thousands, nothing like a 100bb cash game.
  for (let s = 1; s < 6; s++) {
    if (stacks[s] === 0) {
      stacks[s] = BUY_IN
      say(dim('  ' + names[s] + ' reloads for ' + BUY_IN + '.'))
    } else if (stacks[s] < BUY_IN / 2) {
      say(dim('  ' + names[s] + ' tops up to ' + BUY_IN + '.'))
      stacks[s] = BUY_IN
    } else if (stacks[s] > BUY_IN * 1.5) {
      say(dim('  ' + names[s] + ' takes ' + (stacks[s] - BUY_IN) + ' off the table, back to ' + BUY_IN + '.'))
      stacks[s] = BUY_IN
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
    preflopRaiser: -1,
    rest: []
  }

  const pos = positionOf(HERO, button, 6)
  say('')
  say(bold('-- Hand ' + session.hands + ' --') + '  ' + cards(hand.hole) + '   you are ' + bold(pos) +
    dim('   stack ' + stacks[HERO]))

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
    if (!hand.heroFolded) sleep(PACE * 2)
    hand.street = st
    streetHeader(st, result.board, first ? '(all in -- no more betting)' : '')
    first = false
  }
  if (hand.rest.length) {
    for (const l of wrapItems(hand.rest.map((t) => dim(t)), 96, '  ')) say(l)
  }

  report(result, startStack)

  for (let s = 0; s < 6; s++) stacks[s] = result.stacks[s]
  for (let s = 1; s < 6; s++) if (models[s - 1].observe) models[s - 1].observe(result, s)
}

const report = (result, startStack) => {
  if (result.wentToShowdown) {
    const best = Math.max(...result.showdown.map((sd) => sd.score))
    for (const sd of result.showdown) {
      const r = readHandName(sd.score)
      say('  ' + who(sd.seat, hand) + (sd.seat === HERO ? ' show ' : ' shows ') + cards(result.holeCards[sd.seat]) + '  ' +
        (sd.score === best ? bold(r) : r))
    }
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
    const how = result.wentToShowdown ? '' : dim(' (no showdown)')
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

  for (let s = 1; s < 6; s++) {
    const acts = result.actions.filter((a) => a.seat === s && a.street === 'preflop')
    seen[s].hands++
    if (acts.some((a) => a.type === 'call' || a.type === 'raise')) seen[s].vpip++
    if (acts.some((a) => a.type === 'raise')) seen[s].pfr++
    if (result.wentToShowdown && result.showdown.some((sd) => sd.seat === s)) seen[s].showdowns++
  }

  // Only a hand you put money into gets a result line; a preflop fold is just
  // the blind or nothing.
  if (delta !== 0 || pre.some((a) => a.type !== 'fold')) {
    const line = delta > 0 ? green(bold('+' + delta)) : delta < 0 ? red(String(delta)) : dim('±0')
    say('  ' + line + dim(' (' + signed(delta / BIG_BLIND) + ' bb)   stack ' + result.stacks[HERO] +
      '   session ' + signed(session.net)))
  }
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

const reveal = () => {
  say('')
  say(bold('Who was who'))
  for (let s = 1; s < 6; s++) {
    const p = seen[s]
    const stat = p.hands ? dim('   you saw ' + pct(p.vpip / p.hands) + ' / ' + pct(p.pfr / p.hands) + ' over ' + p.hands + ' hands') : ''
    say('  ' + cyan(names[s].padEnd(8)) + TYPE_LABEL[kinds[s]].padEnd(23) + stat)
  }
}

// ------------------------------------------------------------------ main

const main = () => {
  say('')
  say(bold('Texas Hold\'em -- six-max no-limit, blinds 1/2, 200-chip stacks (100 big blinds)'))
  say(dim('Five opponents (' + FIELD + ' field): regulars who read your line and keep stats on you, and fish. Their styles ' +
    'are hidden: work them out from what they do (p shows their stats so far). Revealed when you leave.'))
  say(dim('Each decision shows your equity, the pot odds and the textbook play, with the key that makes it. ' +
    'Type ? for help.'))
  say('  ' + names.slice(1).map((n) => cyan(n)).join('  '))
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
  }
  showStats()
  reveal()
  say('')
  say('Thanks for playing.')
}

main()
