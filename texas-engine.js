// A Texas Hold'em hand, played properly.
//
// The old texas.js was a single hand with the table state in module globals.
// Four things in it made measurement impossible, and all four are structural
// rather than cosmetic, which is why this is a rewrite:
//
//   1. `folded` was local to the betting round and never returned, so the
//      showdown scored every player's hand whether they had folded or not.
//      A player could fold the flop and win the pot on the river.
//   2. There were no blinds. If folding is free then folding everything is a
//      break-even strategy, and it beats every losing one. Blinds are what
//      make the game a game, and without them no strategy comparison means
//      anything.
//   3. `hasRaised` was stashed on the function object and never cleared, so
//      after the first street nobody could raise again for the life of the
//      process.
//   4. No all-in handling and no side pots, so a short stack calling a big bet
//      either won chips nobody had put in or lost chips it never owed.
//
// Three things are deliberate here and are the reason this file exists at all:
//
// * **The deal is seeded and replayable.** Every hand comes from an explicit
//   RNG, and a pre-shuffled deck can be handed in. That is what makes it
//   possible to play the same board and the same hole cards against two
//   different strategies and difference the results. blackjack.js measured
//   ~0.0003 of noise on a 0.0001 effect and could never resolve anything;
//   poker's per-hand variance is far worse, so paired dealing is not an
//   optimisation to add later, it is the only way any comparison here will
//   ever be significant.
//
// * **Bots see a view, never the table.** `act` is handed a purpose-built
//   object containing that seat's own cards and nothing else private. It is
//   structurally impossible for a strategy to read an opponent's hole cards,
//   or any label describing what kind of opponent it is facing.
//
// * **Every hand returns a full record.** The action list, the board, the
//   showdown and the per-seat result all come back. That record is the thing
//   worth distilling; the chip counts are almost a side effect.

const { evaluate, cardName, describe } = require('./texas-eval')

// ---------------------------------------------------------------- the deal

// mulberry32. Small, fast, and seeded -- Math.random cannot be replayed, and
// replaying a deal is the whole point.
const makeRng = (seed) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const makeDeck = () => {
  const d = new Array(52)
  for (let i = 0; i < 52; i++) d[i] = i
  return d
}

const shuffle = (deck, rng) => {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = deck[i]
    deck[i] = deck[j]
    deck[j] = t
  }
  return deck
}

// ------------------------------------------------------------------ seating

const STREETS = ['preflop', 'flop', 'turn', 'river']

const nextOccupied = (h, seat) => {
  for (let i = 1; i <= h.n; i++) {
    const s = (seat + i) % h.n
    if (h.inHand[s]) return s
  }
  return -1
}

// Still holding cards -- folded players are out, all-in players are not.
const liveCount = (h) => {
  let c = 0
  for (let s = 0; s < h.n; s++) if (h.inHand[s] && !h.folded[s]) c++
  return c
}

// Still able to put chips in.
const actorCount = (h) => {
  let c = 0
  for (let s = 0; s < h.n; s++) if (h.inHand[s] && !h.folded[s] && !h.allIn[s]) c++
  return c
}

const commit = (h, seat, amount) => {
  const a = Math.min(amount, h.stacks[seat])
  h.stacks[seat] -= a
  h.committed[seat] += a
  h.totalCommitted[seat] += a
  if (h.stacks[seat] === 0) h.allIn[seat] = true
  return a
}

// ------------------------------------------------------------- the view
//
// The complete set of things a strategy is allowed to know. Everything here is
// either that seat's own information or something visible to the whole table.
// Arrays are copied so a bot cannot reach back through them into engine state.
//
// Note what is absent: other players' hole cards, and any description of who
// the opponents are. A strategy that wants to know whether seat 3 is a bluffer
// has to work it out from `history`, which is exactly the constraint that
// makes anything learned here worth having.
const buildView = (h, seat, street, currentBet, lastRaiseSize, mayRaise) => {
  const toCall = Math.min(currentBet - h.committed[seat], h.stacks[seat])
  const maxRaiseTo = h.committed[seat] + h.stacks[seat]
  const canRaise = mayRaise && maxRaiseTo > currentBet
  const minRaiseTo = Math.min(currentBet + lastRaiseSize, maxRaiseTo)

  const legal = []
  if (currentBet - h.committed[seat] > 0) legal.push('fold', 'call')
  else legal.push('check', 'fold')
  if (canRaise) legal.push('raise')

  return {
    seat,
    button: h.button,
    numPlayers: h.n,
    street,
    streetIndex: STREETS.indexOf(street),

    holeCards: h.holeCards[seat].slice(),
    board: h.board.slice(),

    stack: h.stacks[seat],
    stacks: h.stacks.slice(),
    inHand: h.inHand.slice(),
    folded: h.folded.slice(),
    allIn: h.allIn.slice(),

    // Chips in front of each seat this street, and across the whole hand.
    committed: h.committed.slice(),
    totalCommitted: h.totalCommitted.slice(),

    // Everything already in the middle, this street included -- the number a
    // pot-odds calculation actually needs.
    pot: h.potBefore + h.committed.reduce((a, b) => a + b, 0),
    toCall,
    minRaiseTo,
    maxRaiseTo,
    canRaise,
    legal,

    smallBlind: h.smallBlind,
    bigBlind: h.bigBlind,
    history: h.actions
  }
}

// --------------------------------------------------------- a betting round

const bettingRound = (h, street, currentBet, lastRaiseSize, firstToAct) => {
  // `acted` is cleared by every full raise, so the round ends the moment we
  // reach a player who has acted since the last raise and owes nothing. That
  // one rule covers the big blind's option, a check-around, and action coming
  // back to the last aggressor, with no special cases.
  const acted = new Set()
  const mayRaise = new Array(h.n).fill(true)

  let seat = firstToAct
  if (seat < 0) return currentBet

  let guard = 0
  while (true) {
    if (++guard > h.n * 400) throw new Error('betting round failed to close')
    if (liveCount(h) <= 1) break
    if (actorCount(h) === 0) break

    if (h.inHand[seat] && !h.folded[seat] && !h.allIn[seat]) {
      const owes = currentBet - h.committed[seat]

      if (acted.has(seat) && owes <= 0) break
      // Nobody left to bet into: the last player with chips has nothing to
      // decide, so the round is over rather than checked.
      if (actorCount(h) === 1 && owes <= 0) break

      const view = buildView(h, seat, street, currentBet, lastRaiseSize, mayRaise[seat])
      let choice
      try {
        choice = h.bots[seat].act(view)
      } catch (err) {
        choice = null
      }
      const action = resolve(view, choice)
      if (action.illegal) h.illegal++
      const before = h.committed[seat]

      if (action.type === 'fold') {
        h.folded[seat] = true
      } else if (action.type === 'check') {
        // nothing to commit
      } else if (action.type === 'call') {
        commit(h, seat, owes)
      } else {
        const raiseSize = action.to - currentBet
        commit(h, seat, action.to - h.committed[seat])

        // An all-in that does not amount to a full raise does not reopen the
        // betting: players who have already acted may call it or fold, but
        // they do not get to raise again. Dropping this rule is how a short
        // stack ends up able to restart action with a one-chip shove.
        if (raiseSize >= lastRaiseSize) {
          lastRaiseSize = raiseSize
          acted.clear()
        } else {
          for (const s of acted) mayRaise[s] = false
        }
        currentBet = h.committed[seat]
      }

      h.actions.push({
        street,
        seat,
        type: action.type,
        // Chips this action actually put in, and the seat's total for the
        // street after it. Both read off `committed` rather than off what the
        // bot asked for, so a raise clipped by a short stack records what
        // happened and not what was requested.
        amount: h.committed[seat] - before,
        to: h.committed[seat],
        potBefore: view.pot,
        toCall: view.toCall,
        stackBefore: view.stack,
        allIn: h.allIn[seat]
      })

      acted.add(seat)
      if (h.log) h.log('  ' + h.bots[seat].name + ' ' + describeAction(h, seat, action, currentBet))
    }

    seat = nextOccupied(h, seat)
  }

  return currentBet
}

// Whatever a bot returns is forced into something legal here rather than
// trusted. A strategy under search will produce nonsense, and a million-hand
// run should record that it did instead of crashing or, worse, quietly
// letting it bet chips it does not have.
const resolve = (view, choice) => {
  const owes = view.toCall
  const fallback = owes > 0 ? { type: 'fold', illegal: true } : { type: 'check', illegal: true }

  if (!choice || typeof choice.action !== 'string') return fallback
  const want = choice.action.toLowerCase()

  if (want === 'fold') {
    return { type: 'fold', illegal: false }
  }
  if (want === 'check') {
    return owes > 0 ? { type: 'call', illegal: true } : { type: 'check', illegal: false }
  }
  if (want === 'call') {
    return owes > 0 ? { type: 'call', illegal: false } : { type: 'check', illegal: false }
  }
  if (want === 'raise' || want === 'bet' || want === 'allin') {
    if (!view.canRaise) {
      return owes > 0 ? { type: 'call', illegal: true } : { type: 'check', illegal: true }
    }
    let to = want === 'allin' ? view.maxRaiseTo : Math.round(choice.to)
    let illegal = false
    if (!Number.isFinite(to)) return fallback
    if (to < view.minRaiseTo) {
      to = view.minRaiseTo
      illegal = true
    }
    if (to > view.maxRaiseTo) {
      to = view.maxRaiseTo
      illegal = true
    }
    return { type: 'raise', to, illegal }
  }
  return fallback
}

const describeAction = (h, seat, action, currentBet) => {
  if (action.type === 'fold') return 'folds'
  if (action.type === 'check') return 'checks'
  if (action.type === 'call') return 'calls ' + h.committed[seat] + (h.allIn[seat] ? ' (all in)' : '')
  return 'raises to ' + action.to + (h.allIn[seat] ? ' (all in)' : '')
}

// ------------------------------------------------------------- side pots

// Chips from folded players stay in the pot; what decides eligibility is how
// much each player put in, not whether they are still holding cards. Building
// the pot in layers at each distinct commitment level is what makes a short
// all-in win only the part of the pot it actually covered.
const buildPots = (h) => {
  const levels = []
  for (let s = 0; s < h.n; s++) {
    const c = h.totalCommitted[s]
    if (c > 0 && !levels.includes(c)) levels.push(c)
  }
  levels.sort((a, b) => a - b)

  const pots = []
  let prev = 0
  for (const level of levels) {
    let amount = 0
    const eligible = []
    for (let s = 0; s < h.n; s++) {
      const c = h.totalCommitted[s]
      amount += Math.min(c, level) - Math.min(c, prev)
      if (!h.folded[s] && h.inHand[s] && c >= level) eligible.push(s)
    }
    if (amount > 0) pots.push({ amount, eligible })
    prev = level
  }
  return pots
}

// A bet nobody called is not part of the pot -- it comes straight back. Without
// this, a player who shoves 500 into a field that all folds "wins" a pot
// containing their own 500 and the arithmetic still balances, but every pot
// size in the recorded history is wrong.
const returnUncalled = (h) => {
  let hi = -1
  let hiSeat = -1
  let second = 0
  for (let s = 0; s < h.n; s++) {
    const c = h.totalCommitted[s]
    if (c > hi) {
      second = hi < 0 ? 0 : hi
      hi = c
      hiSeat = s
    } else if (c > second) {
      second = c
    }
  }
  if (hiSeat >= 0 && hi > second) {
    const back = hi - second
    h.stacks[hiSeat] += back
    h.totalCommitted[hiSeat] = second
    return { seat: hiSeat, amount: back }
  }
  return null
}

// -------------------------------------------------------------- the hand

const playHand = (config) => {
  const {
    bots,
    stacks,
    button = 0,
    smallBlind = 1,
    bigBlind = 2,
    ante = 0,
    rake = { percent: 0, cap: 0, noFlopNoDrop: true },
    rng = Math.random,
    deck: providedDeck = null,
    log = null
  } = config

  const n = bots.length
  const h = {
    n,
    bots,
    button,
    smallBlind,
    bigBlind,
    stacks: stacks.slice(),
    startStacks: stacks.slice(),
    // A seat with no chips is not dealt in. Everything downstream checks this
    // rather than assuming every seat is playing.
    inHand: stacks.map((c) => c > 0),
    folded: new Array(n).fill(false),
    allIn: new Array(n).fill(false),
    committed: new Array(n).fill(0),
    totalCommitted: new Array(n).fill(0),
    potBefore: 0,
    holeCards: [],
    board: [],
    actions: [],
    illegal: 0,
    log
  }

  const seated = h.inHand.filter(Boolean).length
  if (seated < 2) throw new Error('need at least two funded seats')

  const deck = providedDeck ? providedDeck.slice() : shuffle(makeDeck(), rng)
  let d = 0

  if (ante > 0) {
    for (let s = 0; s < n; s++) if (h.inHand[s]) commit(h, s, ante)
    h.potBefore = h.committed.reduce((a, b) => a + b, 0)
    h.committed.fill(0)
  }

  // Heads-up reverses the blinds: the button posts the small blind and acts
  // first before the flop, then last on every street after it. With the blinds
  // assigned this way the general rules -- first to act preflop is left of the
  // big blind, first to act after the flop is left of the button -- come out
  // right for both cases with no branch.
  const sb = seated === 2 ? button : nextOccupied(h, button)
  const bb = nextOccupied(h, sb)

  commit(h, sb, smallBlind)
  commit(h, bb, bigBlind)

  for (let i = 0; i < 2; i++) {
    for (let k = 0; k < n; k++) {
      const s = (button + 1 + k) % n
      if (!h.inHand[s]) continue
      if (!h.holeCards[s]) h.holeCards[s] = []
      h.holeCards[s].push(deck[d++])
    }
  }
  for (let s = 0; s < n; s++) if (!h.holeCards[s]) h.holeCards[s] = []

  if (log) {
    log('Button: ' + bots[button].name + '   blinds ' + smallBlind + '/' + bigBlind)
    for (let s = 0; s < n; s++) {
      if (h.inHand[s]) {
        log('  ' + bots[s].name.padEnd(10) + h.holeCards[s].map(cardName).join(' ') +
          '   ' + h.stacks[s])
      }
    }
  }

  let street = 'preflop'
  let endedOn = 'preflop'

  for (let si = 0; si < 4; si++) {
    street = STREETS[si]
    endedOn = street

    if (si === 0) {
      if (log) log('--- preflop ---')
      const first = nextOccupied(h, bb)
      bettingRound(h, street, bigBlind, bigBlind, first)
    } else {
      // Burn, then deal. Burning changes nothing statistically but it is what
      // a table does, and a replayed deck has to line up with a real one.
      d++
      const count = si === 1 ? 3 : 1
      for (let k = 0; k < count; k++) h.board.push(deck[d++])
      if (log) log('--- ' + street + ' --- ' + h.board.map(cardName).join(' '))

      if (liveCount(h) > 1 && actorCount(h) > 1) {
        const first = nextOccupied(h, button)
        bettingRound(h, street, 0, bigBlind, first)
      }
    }

    h.potBefore += h.committed.reduce((a, b) => a + b, 0)
    h.committed.fill(0)

    if (liveCount(h) <= 1) break
    // Everyone is all-in: the rest of the board still runs out, but there is
    // nothing left to decide.
    if (actorCount(h) <= 1 && si < 3) {
      for (let rest = si + 1; rest < 4; rest++) {
        d++
        const count = rest === 1 ? 3 : 1
        for (let k = 0; k < count; k++) h.board.push(deck[d++])
      }
      endedOn = 'river'
      if (log) log('--- run out --- ' + h.board.map(cardName).join(' '))
      break
    }
  }

  const uncalled = returnUncalled(h)
  if (uncalled && log) {
    log('  ' + bots[uncalled.seat].name.padEnd(10) + 'takes back ' + uncalled.amount + ' uncalled')
  }

  // ------------------------------------------------------------- payout
  const pots = buildPots(h)
  const potTotal = pots.reduce((a, p) => a + p.amount, 0)

  // Rake is taken from the pot, not from a player, and no-flop-no-drop is the
  // standard house rule. It is the single biggest determinant of whether a
  // strategy is profitable in a real cardroom -- the same role penetration
  // plays for counting in blackjack.js -- so it is a knob rather than zero.
  let rakePaid = 0
  const rakeable = !(rake.noFlopNoDrop && h.board.length === 0)
  if (rakeable && rake.percent > 0) {
    rakePaid = Math.min(Math.floor(potTotal * rake.percent), rake.cap || Infinity)
  }

  const showdown = []
  const scores = new Array(n).fill(-1)
  const isShowdown = liveCount(h) > 1
  if (isShowdown) {
    for (let s = 0; s < n; s++) {
      if (h.inHand[s] && !h.folded[s]) {
        scores[s] = evaluate(h.holeCards[s].concat(h.board))
        showdown.push({ seat: s, score: scores[s], hand: describe(scores[s]) })
      }
    }
  }

  let rakeLeft = rakePaid
  const winners = []
  for (let i = 0; i < pots.length; i++) {
    const pot = pots[i]
    // Spread the rake across the pots in proportion, with any rounding
    // remainder falling on the last one so the chips balance exactly.
    const share = i === pots.length - 1
      ? rakeLeft
      : Math.floor(rakePaid * pot.amount / potTotal)
    rakeLeft -= share
    const amount = pot.amount - share

    if (pot.eligible.length === 0) continue

    let best = -1
    let takers = []
    for (const s of pot.eligible) {
      const sc = isShowdown ? scores[s] : 0
      if (sc > best) {
        best = sc
        takers = [s]
      } else if (sc === best) {
        takers.push(s)
      }
    }

    const each = Math.floor(amount / takers.length)
    let odd = amount - each * takers.length
    // The odd chip goes to the first winner left of the button, as at a table.
    const ordered = takers.slice().sort((a, b) =>
      ((a - button + n - 1) % n) - ((b - button + n - 1) % n))
    for (const s of ordered) {
      let won = each
      if (odd > 0) {
        won++
        odd--
      }
      h.stacks[s] += won
      winners.push({ seat: s, pot: i, amount: won })
    }
  }

  const deltas = new Array(n)
  for (let s = 0; s < n; s++) deltas[s] = h.stacks[s] - h.startStacks[s]

  if (log) {
    if (isShowdown) {
      for (const sd of showdown) {
        log('  ' + bots[sd.seat].name.padEnd(10) +
          h.holeCards[sd.seat].map(cardName).join(' ') + '   ' + sd.hand)
      }
    }
    if (rakePaid > 0) log('  rake ' + rakePaid)
    for (const w of winners) {
      log('  ' + bots[w.seat].name.padEnd(10) + 'wins ' + w.amount)
    }
    log('  stacks ' + h.stacks.join(' '))
  }

  return {
    button,
    board: h.board,
    holeCards: h.holeCards,
    stacks: h.stacks,
    deltas,
    pots,
    potTotal,
    rakePaid,
    winners,
    showdown,
    actions: h.actions,
    folded: h.folded,
    allIn: h.allIn,
    endedOn,
    wentToShowdown: isShowdown,
    illegal: h.illegal
  }
}

module.exports = { playHand, makeRng, makeDeck, shuffle, STREETS }
