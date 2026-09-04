// Seven-card hand evaluation.
//
// The old evaluator returned [category, oneValue], which is not an ordering.
// Two pair compared only the higher pair, a flush compared only its top card,
// and AK and AQ chopped on an ace-high board. Every one of those errors moves
// money to the wrong player at showdown, so no win rate measured on top of it
// means anything.
//
// What replaces it packs the category and all five ranks into a single
// integer, which makes comparing two hands one integer comparison with the
// kickers already in it. It also does no allocation and enumerates no
// combinations, which is what makes millions of hands per run tractable.
//
//   node texas-eval.js              unit checks plus a Monte Carlo frequency check
//   node texas-eval.js --enumerate  exact category counts over all C(52,7) hands

// ------------------------------------------------------------------- cards
//
// A card is an integer 0-51, rank * 4 + suit. Rank 0 is a deuce and rank 12
// is an ace, so ranks compare directly as numbers with no lookup.

const RANKS = '23456789TJQKA'
const SUITS = 'shdc'

const rankOf = (card) => card >> 2
const suitOf = (card) => card & 3
const cardName = (card) => RANKS[rankOf(card)] + SUITS[suitOf(card)]

// 'As', 'Td', '7c' -> integer. Only used by tests and hand-written setups;
// nothing on the hot path parses strings.
const cardFromName = (name) => {
  const r = RANKS.indexOf(name[0].toUpperCase())
  const s = SUITS.indexOf(name[1].toLowerCase())
  if (r < 0 || s < 0) throw new Error('bad card: ' + name)
  return r * 4 + s
}

// --------------------------------------------------------------- the score
//
// Category in the top nibble, then five ranks high to low, four bits each.
// Ranks reach 12 and categories reach 8, so the whole thing fits in 24 bits
// and stays a small integer.

const HIGH_CARD = 0
const PAIR = 1
const TWO_PAIR = 2
const TRIPS = 3
const STRAIGHT = 4
const FLUSH = 5
const FULL_HOUSE = 6
const QUADS = 7
const STRAIGHT_FLUSH = 8

const CATEGORY_NAMES = [
  'High Card', 'One Pair', 'Two Pair', 'Three of a Kind', 'Straight',
  'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'
]

const score = (cat, a, b, c, d, e) =>
  (cat << 20) | (a << 16) | (b << 12) | (c << 8) | (d << 4) | e

const categoryOf = (s) => s >> 20

// A royal flush is not a separate category, it is the top straight flush --
// treating it as one is what let the old evaluator match it and then fall
// through and test straight flush again on the same hand.
const describe = (s) => {
  const cat = categoryOf(s)
  if (cat === STRAIGHT_FLUSH && ((s >> 16) & 0xf) === 12) return 'Royal Flush'
  return CATEGORY_NAMES[cat]
}

// ----------------------------------------------------------- rank patterns

// The n highest ranks set in a mask, high first, zero-padded to five.
const top = (mask, n) => {
  const out = [0, 0, 0, 0, 0]
  let k = 0
  for (let r = 12; r >= 0 && k < n; r--) {
    if (mask & (1 << r)) out[k++] = r
  }
  return out
}

// Five consecutive ranks, returning the rank of the high end, or -1.
//
// The ace has to play at both ends. Shifting the mask up one place and
// dropping the ace bit into the vacated slot puts the wheel in exactly the
// same shape as every other straight, so one loop finds all ten of them and
// A-2-3-4-5 needs no special case.
const straightHigh = (mask) => {
  const m = (mask << 1) | ((mask >> 12) & 1)
  for (let hi = 13; hi >= 4; hi--) {
    if (((m >> (hi - 4)) & 0x1f) === 0x1f) return hi - 1
  }
  return -1
}

// ------------------------------------------------------------ the evaluator

const rankCount = new Int8Array(13)
const suitCount = new Int8Array(4)
const suitMask = new Int32Array(4)

// Takes any number of cards from five up: seven at showdown, five or six when
// the board is short. Returns a score comparable against any other score.
const evaluate = (cards) => {
  rankCount.fill(0)
  suitCount.fill(0)
  suitMask.fill(0)
  let rankMask = 0

  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]
    const r = c >> 2
    const s = c & 3
    rankMask |= 1 << r
    rankCount[r]++
    suitCount[s]++
    suitMask[s] |= 1 << r
  }

  // With seven cards at most one suit can reach five, so there is never a
  // choice of which flush to make.
  let flushSuit = -1
  for (let s = 0; s < 4; s++) {
    if (suitCount[s] >= 5) flushSuit = s
  }

  if (flushSuit >= 0) {
    const sf = straightHigh(suitMask[flushSuit])
    if (sf >= 0) return score(STRAIGHT_FLUSH, sf, 0, 0, 0, 0)
  }

  let quad = -1
  let trip = -1
  let trip2 = -1
  let pair = -1
  let pair2 = -1
  for (let r = 12; r >= 0; r--) {
    const n = rankCount[r]
    if (n === 4) {
      if (quad < 0) quad = r
    } else if (n === 3) {
      if (trip < 0) trip = r
      else if (trip2 < 0) trip2 = r
    } else if (n === 2) {
      if (pair < 0) pair = r
      else if (pair2 < 0) pair2 = r
    }
  }

  if (quad >= 0) {
    const k = top(rankMask & ~(1 << quad), 1)
    return score(QUADS, quad, k[0], 0, 0, 0)
  }

  // Seven cards can hold two sets of trips. The higher one makes the trips and
  // the lower one supplies the pair, which beats using an actual pair only if
  // it outranks it.
  if (trip >= 0 && (trip2 >= 0 || pair >= 0)) {
    const two = trip2 > pair ? trip2 : pair
    return score(FULL_HOUSE, trip, two, 0, 0, 0)
  }

  if (flushSuit >= 0) {
    const f = top(suitMask[flushSuit], 5)
    return score(FLUSH, f[0], f[1], f[2], f[3], f[4])
  }

  const st = straightHigh(rankMask)
  if (st >= 0) return score(STRAIGHT, st, 0, 0, 0, 0)

  if (trip >= 0) {
    const k = top(rankMask & ~(1 << trip), 2)
    return score(TRIPS, trip, k[0], k[1], 0, 0)
  }

  if (pair2 >= 0) {
    // A third pair cannot play as a pair but its rank is still a live kicker,
    // which is why this filters the two playing pairs out of the full mask
    // rather than looking only at unpaired ranks.
    const k = top(rankMask & ~(1 << pair) & ~(1 << pair2), 1)
    return score(TWO_PAIR, pair, pair2, k[0], 0, 0)
  }

  if (pair >= 0) {
    const k = top(rankMask & ~(1 << pair), 3)
    return score(PAIR, pair, k[0], k[1], k[2], 0)
  }

  const h = top(rankMask, 5)
  return score(HIGH_CARD, h[0], h[1], h[2], h[3], h[4])
}

module.exports = {
  RANKS, SUITS, rankOf, suitOf, cardName, cardFromName,
  evaluate, categoryOf, describe, straightHigh, CATEGORY_NAMES,
  HIGH_CARD, PAIR, TWO_PAIR, TRIPS, STRAIGHT, FLUSH, FULL_HOUSE, QUADS,
  STRAIGHT_FLUSH
}

// ------------------------------------------------------------------- checks

if (require.main === module) {
  let failures = 0
  const hand = (str) => str.trim().split(/\s+/).map(cardFromName)
  const ev = (str) => evaluate(hand(str))

  const check = (label, cond) => {
    if (!cond) {
      failures++
      console.log('FAIL  ' + label)
    }
  }

  const beats = (a, b, label) => {
    const sa = ev(a)
    const sb = ev(b)
    check(label + '  [' + describe(sa) + ' vs ' + describe(sb) + ']', sa > sb)
  }

  const ties = (a, b, label) => check(label, ev(a) === ev(b))

  const named = (a, name) => {
    const got = describe(ev(a))
    check(a + ' -> ' + name + ' (got ' + got + ')', got === name)
  }

  console.log('Category detection')
  named('As Ks Qs Js Ts 2h 3d', 'Royal Flush')
  named('9c 8c 7c 6c 5c Ah Kd', 'Straight Flush')
  named('Ah Ad As Ac Kd 2h 3s', 'Four of a Kind')
  named('Ah Ad As Kc Kd 2h 3s', 'Full House')
  named('Ah 9h 7h 4h 2h Ks Qd', 'Flush')
  named('Ah Kd Qs Jc Th 2h 3s', 'Straight')
  named('Ah Ad As Kc Qd 2h 3s', 'Three of a Kind')
  named('Ah Ad Ks Kc Qd 2h 3s', 'Two Pair')
  named('Ah Ad Ks Qc Jd 2h 3s', 'One Pair')
  named('Ah Kd Qs Jc 9h 2h 3s', 'High Card')

  // The wheel, at both ends, and the near miss that is not a straight.
  named('Ah 2d 3s 4c 5h Kd Qs', 'Straight')
  named('As 2s 3s 4s 5s Kd Qh', 'Straight Flush')
  check('wheel is five high, not ace high',
    ((ev('Ah 2d 3s 4c 5h Kd Qs') >> 16) & 0xf) === 3)
  named('Ah Kd Qs Jc 9d 3h 2s', 'High Card')

  console.log('Kickers and ties -- what the old evaluator got wrong')
  // These are the exact failures that made the old showdown wrong.
  beats('Ah Kd As Ks Qh 7c 2d', 'Ah Qd As Ks Qh 7c 2d',
    'AK outkicks AQ on an ace-high board')
  beats('Ah Kd Ks Qh 9c 7d 2s', 'Ah Kd Ks Qh 8c 7d 2s',
    'two pair splits on the fifth card')
  beats('Ah 9h 7h 4h 2h 3s Kd', 'Kh 9h 7h 4h 2h 3s Qd',
    'flush compares below its top card')
  beats('Kh Kd Ks 9c 8d 7h 2s', 'Qh Qd Qs Ac Kd 7h 2s',
    'trips compare on the trips, not the kicker')

  ties('Ah Kd As Ks Qh 7c 2d', 'Ac Kh As Ks Qh 7c 2d', 'identical hands chop')
  ties('2h 3d As Ks Qh Jc Td', '4h 5d As Ks Qh Jc Td',
    'a board that plays chops regardless of hole cards')

  console.log('Category ordering')
  beats('2h 3h 4h 5h 6h Ad Kc', 'Ah Ad As Ac Kd 2s 3c', 'straight flush > quads')
  beats('Ah Ad As Ac Kd 2s 3c', 'Ah Ad As Kc Kd 2s 3c', 'quads > full house')
  beats('Ah Ad As Kc Kd 2s 3c', 'Ah 9h 7h 4h 2h Ks Qd', 'full house > flush')
  beats('Ah 9h 7h 4h 2h Ks Qd', 'Ah Kd Qs Jc Th 2d 3c', 'flush > straight')
  beats('Ah Kd Qs Jc Th 2d 3c', 'Ah Ad As Kc Qd 2s 3c', 'straight > trips')
  beats('Ah Ad As Kc Qd 2s 3c', 'Ah Ad Ks Kc Qd 2s 3c', 'trips > two pair')
  beats('Ah Ad Ks Kc Qd 2s 3c', 'Ah Ad Ks Qc Jd 2s 3c', 'two pair > pair')
  beats('Ah Ad Ks Qc Jd 2s 3c', 'Ah Kd Qs Jc 9h 2s 3c', 'pair > high card')

  console.log('Seven-card edge cases')
  // Two sets of trips is a full house, and the pair comes from the lower set
  // only when it outranks a real pair.
  check('two trips make the higher boat',
    ev('Ah Ad As Kh Kd Ks 2c') === ev('Ah Ad As Kh Kd Kc 3d'))
  named('Ah Ad As Kh Kd Ks 2c', 'Full House')
  beats('Ah Ad As Kh Kd Ks 2c', 'Ah Ad As Qh Qd Qs 2c', 'A over K beats A over Q')
  // Three pairs: the third pair is a kicker, not a third pair.
  named('Ah Ad Kh Kd Qh Qd 2c', 'Two Pair')
  check('third pair plays as the kicker',
    ((ev('Ah Ad Kh Kd Qh Qd 2c') >> 8) & 0xf) === 10)
  // A six-card flush plays its top five.
  named('Ah Kh Qh 9h 7h 2h 3d', 'Flush')
  ties('Ah Kh Qh 9h 7h 2h 3d', 'Ah Kh Qh 9h 7h 2h 3s',
    'the sixth flush card does not play')

  if (failures === 0) console.log('All checks passed.')
  else console.log(failures + ' CHECK(S) FAILED')

  // ------------------------------------------------------- frequency check
  //
  // Published seven-card frequencies. Matching them is the real test: the unit
  // checks above only cover the cases someone thought to write down, this
  // covers every hand there is.
  const EXPECTED = {
    'Straight Flush': 0.0311,
    'Four of a Kind': 0.1681,
    'Full House': 2.5961,
    'Flush': 3.0255,
    'Straight': 4.6194,
    'Three of a Kind': 4.8299,
    'Two Pair': 23.4955,
    'One Pair': 43.8225,
    'High Card': 17.4119
  }

  const report = (counts, total, label) => {
    console.log('\n' + label + '  (n = ' + total.toLocaleString() + ')')
    console.log('category           measured   published      diff')
    for (const name of Object.keys(EXPECTED)) {
      const idx = CATEGORY_NAMES.indexOf(name)
      const pct = (counts[idx] / total) * 100
      const exp = EXPECTED[name]
      console.log(
        name.padEnd(18) +
        pct.toFixed(4).padStart(8) + '%' +
        exp.toFixed(4).padStart(11) + '%' +
        (pct - exp).toFixed(4).padStart(10)
      )
    }
  }

  const counts = new Array(9).fill(0)
  const seven = new Array(7)

  if (process.argv[2] === '--enumerate') {
    // Every seven-card hand there is. Slower than sampling but it is a proof
    // rather than an estimate, which is the same reason odds.js enumerates.
    let total = 0
    for (let a = 0; a < 46; a++) {
      seven[0] = a
      for (let b = a + 1; b < 47; b++) {
        seven[1] = b
        for (let c = b + 1; c < 48; c++) {
          seven[2] = c
          for (let d = c + 1; d < 49; d++) {
            seven[3] = d
            for (let e = d + 1; e < 50; e++) {
              seven[4] = e
              for (let f = e + 1; f < 51; f++) {
                seven[5] = f
                for (let g = f + 1; g < 52; g++) {
                  seven[6] = g
                  counts[categoryOf(evaluate(seven))]++
                  total++
                }
              }
            }
          }
        }
      }
    }
    report(counts, total, 'Exact, all C(52,7) hands')
  } else {
    const N = Number(process.argv[2]) || 2000000
    const deck = new Array(52)
    for (let i = 0; i < 52; i++) deck[i] = i
    for (let n = 0; n < N; n++) {
      // Partial Fisher-Yates: only the seven cards actually needed are drawn.
      for (let i = 0; i < 7; i++) {
        const j = i + Math.floor(Math.random() * (52 - i))
        const t = deck[i]
        deck[i] = deck[j]
        deck[j] = t
        seven[i] = deck[i]
      }
      counts[categoryOf(evaluate(seven))]++
    }
    report(counts, N, 'Monte Carlo')
    console.log('\n(node texas-eval.js --enumerate for the exact counts)')
  }
}
