// How strong is my hand? -- estimated the way a player estimates it.
//
// The obvious way to give a bot hand equity is to roll out the board a few
// hundred times at every decision and count how often it wins. That is both
// expensive (about a hundredfold, measured) and wrong as a model: nobody at a
// table is running Monte Carlo in their head. What they have is a rough sense
// of how strong the hand is, a count of the cards that would improve it, and a
// guess at what the other players might hold.
//
// So the split here is between what a player has genuinely internalised, which
// is precomputed exactly, and what they work out at the table, which is
// approximated with the same shortcuts they use:
//
//   * **Preflop** they know their starting hands. All 169 of them are solved
//     once against 1-8 opponents and cached, because a competent player really
//     does know that AKs is about 67% heads up and about 34% six ways.
//
//   * **Postflop** they know roughly where their made hand sits, and they count
//     outs. Hand strength is a percentile read off the exact distribution of
//     every seven-card hand, and draws are valued with the 2x/4x rule that
//     every player at every level actually uses.
//
// That makes proficiency mean something specific and much more useful than a
// blur on a perfect answer: a weak player miscounts their outs, ignores how
// many opponents they are against, and reads their own pair as stronger than
// it is. A strong player does none of those. The ceiling is a good human, not
// a solver, which is the right ceiling for modelling a cash game.
//
//   node texas-equity.js --build    regenerate equity.json (a few minutes)
//   node texas-equity.js            show what is in it

const fs = require('fs')
const path = require('path')
const { evaluate, RANKS, cardName } = require('./texas-eval')

const TABLE_FILE = path.join(__dirname, 'equity.json')

// --------------------------------------------------------- starting hands
//
// The 169 distinct starting hands. Suits only matter for whether the two cards
// match, so AhKh and AsKs are the same hand and there are 13 pairs, 78 suited
// and 78 offsuit combinations rather than 1326.
//
// Indexed on a 13x13 grid: the diagonal is pairs, above it suited, below it
// offsuit.
const handIndex = (c1, c2) => {
  const r1 = c1 >> 2
  const r2 = c2 >> 2
  const hi = r1 > r2 ? r1 : r2
  const lo = r1 > r2 ? r2 : r1
  return (c1 & 3) === (c2 & 3) ? hi * 13 + lo : lo * 13 + hi
}

const handLabel = (idx) => {
  const a = Math.floor(idx / 13)
  const b = idx % 13
  if (a === b) return RANKS[a] + RANKS[a]
  const hi = a > b ? a : b
  const lo = a > b ? b : a
  return RANKS[hi] + RANKS[lo] + (a > b ? 's' : 'o')
}

// One concrete pair of cards standing for a starting hand.
const handCards = (idx) => {
  const a = Math.floor(idx / 13)
  const b = idx % 13
  if (a === b) return [a * 4, a * 4 + 1]
  const hi = a > b ? a : b
  const lo = a > b ? b : a
  return a > b ? [hi * 4, lo * 4] : [hi * 4, lo * 4 + 1]
}

// ----------------------------------------------------------------- outs
//
// A card that improves the hand by more than it improves the board. This is
// what a player means by an out: the flush card, the straight card, the card
// that pairs an overcard or turns a set into a boat -- not a card that pairs
// the board, which gives the same pair to everybody. Counting them by testing
// every unseen card is both exact and cheap -- about forty evaluations,
// against the thousands a rollout would cost.
//
// The first version counted any card that raised the hand's category, board
// pairs included, and every hand on every flop was drawing to something: a
// hand with no pair averaged 16.6 outs, which the rule of four reads as 66%
// equity, and that beat its real made-hand strength (0.30) every time. Nobody
// folded a flop with two unpaired cards, and no read of a bettor's range could
// change it, because the draw term was not read against anybody.
//
// So a card is an out when the hand gains on the board: its category above
// the board's own is larger after the card than before. Going from nothing to
// a pair only counts for a pair above the board -- the two overcards of "six
// outs", not the bottom pair nobody counts.
const boardCategory = (cards) => {
  if (cards.length >= 5) return evaluate(cards) >> 20
  const counts = new Uint8Array(13)
  let pairs = 0
  let most = 0
  for (const c of cards) {
    const n = ++counts[c >> 2]
    if (n === 2) pairs++
    if (n > most) most = n
  }
  if (most === 4) return 7
  if (most === 3) return pairs > 1 ? 6 : 3
  return pairs >= 2 ? 2 : pairs
}

const countOuts = (hole, board) => {
  const seen = new Uint8Array(52)
  for (const c of hole) seen[c] = 1
  let top = 0
  for (const c of board) {
    seen[c] = 1
    if ((c >> 2) > top) top = c >> 2
  }

  const seven = hole.concat(board)
  const shared = board.slice()
  const current = evaluate(seven) >> 20
  const lead = current - boardCategory(board)
  let outs = 0
  for (let c = 0; c < 52; c++) {
    if (seen[c]) continue
    seven.push(c)
    const now = evaluate(seven) >> 20
    seven.pop()
    if (now <= current) continue
    shared.push(c)
    const boardNow = boardCategory(shared)
    shared.pop()
    const gain = now - boardNow - lead
    if (gain <= 0) continue
    if (lead === 0 && gain === 1 && now <= 2 && (c >> 2) <= top) continue
    outs++
  }
  return outs
}

// ------------------------------------------------------------- the table

let table = null

const load = () => {
  if (table) return table
  if (!fs.existsSync(TABLE_FILE)) {
    throw new Error('equity.json missing -- run: node texas-equity.js --build')
  }
  table = JSON.parse(fs.readFileSync(TABLE_FILE, 'utf8'))
  return table
}

// Where this hand sits among all seven-card hands, from the exact
// distribution. 0.9 means it beats 90% of hands dealt at random.
//
// A percentile is not the probability of winning -- against several opponents
// it has to be raised to a power, and it ignores the board being shared. It is
// what a player has: a sense of how good the hand is in the abstract.
const strengthPercentile = (score) => {
  const t = load()
  const scores = t.cdfScores
  let lo = 0
  let hi = scores.length - 1
  let best = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (scores[mid] <= score) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return t.cdfBelow[best]
}

// ------------------------------------------------- strength on this board
//
// What fraction of the hands an opponent could be holding does this hand beat,
// *given the board that is actually out*?
//
// The percentile above is the wrong question postflop and was the model's
// binding constraint. It scores a hand against every seven-card hand there is,
// but everyone at the table shares five of their seven cards, so the real
// distribution is far more compressed than the unconditional one. One pair is
// much stronger than its 44th percentile on a dry board and much weaker on a
// paired one, and a model that cannot tell those apart folds flops it should
// call -- which is why showdowns were reached on 17% of hands against a real 26.
//
// This enumerates every hole-card pair an opponent could hold. On a flop that
// is C(47,2) = 1081 hands, which is exact rather than sampled, and expensive
// enough to matter: about 6ms a hand, against 0.09ms for the whole rest of the
// simulation.
//
// What makes it affordable is that it is a pure function of the cards, and a
// calibration run replays the same seeded decks hundreds of times. Memoised,
// the first pass pays for every pass after it.
const strengthCache = new Map()
const CACHE_LIMIT = 4000000

const boardStrength = (hole, board) => {
  const a = hole[0] < hole[1] ? hole[0] : hole[1]
  const b = hole[0] < hole[1] ? hole[1] : hole[0]
  // The board is sorted for the key only, so the same three cards dealt in a
  // different order still hit the same entry.
  const key = a * 52 + b + '|' + board.slice().sort((x, y) => x - y).join(',')
  const hit = strengthCache.get(key)
  if (hit !== undefined) return hit

  const seen = new Uint8Array(52)
  seen[hole[0]] = 1
  seen[hole[1]] = 1
  for (let i = 0; i < board.length; i++) seen[board[i]] = 1

  const mine = evaluate(hole.concat(board))
  const theirs = new Array(2 + board.length)
  for (let i = 0; i < board.length; i++) theirs[2 + i] = board[i]

  // Without a flush, a hand's score depends only on its ranks, and on a fixed
  // board the opponent contributes just two of them -- at most 91 distinct
  // rank pairs among the 1081 holdings. So each rank pair is evaluated once
  // and reused, and only holdings that could complete a flush are evaluated
  // individually. The result is identical to evaluating every holding, at
  // about a tenth of the cost; evaluation was three quarters of all runtime.
  const boardSuits = [0, 0, 0, 0]
  for (let i = 0; i < board.length; i++) boardSuits[board[i] & 3]++
  const byRanks = new Int32Array(169).fill(-1)

  let ahead = 0
  let tied = 0
  let total = 0
  for (let x = 0; x < 52; x++) {
    if (seen[x]) continue
    theirs[0] = x
    for (let y = x + 1; y < 52; y++) {
      if (seen[y]) continue
      theirs[1] = y
      const xs = x & 3
      const ys = y & 3
      const flushable = boardSuits[xs] + 1 + (xs === ys ? 1 : 0) >= 5 ||
        boardSuits[ys] + 1 + (xs === ys ? 1 : 0) >= 5
      let score
      if (flushable) {
        score = evaluate(theirs)
      } else {
        const slot = (x >> 2) * 13 + (y >> 2)
        score = byRanks[slot]
        if (score < 0) score = byRanks[slot] = evaluate(theirs)
      }
      if (mine > score) ahead++
      else if (mine === score) tied++
      total++
    }
  }

  const strength = total > 0 ? (ahead + tied / 2) / total : 0
  if (strengthCache.size < CACHE_LIMIT) strengthCache.set(key, strength)
  return strength
}

// Opponents may be fractional -- an expected count, before the flop -- and are
// interpolated between the whole numbers either side.
const preflopEquity = (idx, opponents) => {
  const t = load()
  const n = Math.max(1, Math.min(8, opponents))
  const lo = Math.floor(n)
  const f = n - lo
  if (f < 1e-9 || lo >= 8) return t.preflop[lo - 1][idx]
  return t.preflop[lo - 1][idx] * (1 - f) + t.preflop[lo][idx] * f
}

// ------------------------------------------------------ against a range
//
// "He raised, so he has a good hand" is the single most important read in
// preflop poker, and every player makes it: nobody prices a call against a
// raise as if the raiser held a random hand. The read has a size, too -- an
// open is a fifth of all hands, a 3-bet a few percent, an all-in shove over a
// 3-bet barely more than the big pairs.
//
// So the table holds each starting hand's heads-up equity against the top X%
// of hands, for a grid of X. "Top" is ranked by equity against three random
// hands, the ordering range charts are conventionally written in, and a range
// is built from whole starting hands, best first, until it covers X% of the
// 1326 combinations.
//
// The model this replaces priced a call off equity against random hands and
// then shaded it by the price, with the shade a fitted constant. The fit ran
// that constant to 3.5, where the shaded equity is negative for any real raise:
// no fitted player would ever call a preflop raise, holding aces or not, and
// facing an all-in they folded everything. Behavioural statistics could not
// see it, because the frequencies came out right.
const RANGE_GRID = [1.5, 2.5, 4, 6, 9, 13, 18, 25, 35, 50, 70, 100]

// Starting hands, strongest first, by equity against three random hands.
const rangeOrder = (preflop) => [...Array(169).keys()]
  .sort((x, y) => preflop[2][y] - preflop[2][x])

// Where a starting hand sits in the ranking, as a percentage: 0.5 is the very
// top, 99 the very bottom. Measured at the middle of the hand's own combos, so
// "open the top 20%" means exactly the hands whose rank is below 20.
//
// `skill` blends the true ranking with the naive one, which orders hands by
// heads-up equity against a random hand. That ranking is the one weak players
// carry: it rates A2o and K5o above 76s and 55, because they win more often
// heads up, and misses that the suited connector plays better in a real pot.
// The same shape of error as postflop, where a weak player reads a made hand
// by its unconditional strength.
let ranks = null
const handRank = (idx, skill = 1) => {
  if (!ranks) {
    const t = load()
    const place = (order) => {
      const out = new Array(169)
      let cum = 0
      for (const h of order) {
        const a = Math.floor(h / 13)
        const b = h % 13
        const share = (a === b ? 6 : a > b ? 4 : 12) / 1326 * 100
        out[h] = cum + share / 2
        cum += share
      }
      return out
    }
    ranks = {
      true: place(rangeOrder(t.preflop)),
      naive: place([...Array(169).keys()].sort((x, y) => t.preflop[0][y] - t.preflop[0][x]))
    }
  }
  return ranks.true[idx] + (1 - skill) * (ranks.naive[idx] - ranks.true[idx])
}

// Equity against the top `pct` percent, interpolated on the grid in log space
// because the interesting ranges are all at the narrow end.
const rangeEquity = (idx, pct) => {
  const t = load()
  if (!t.vsRange) {
    throw new Error('equity.json has no range table -- run: node texas-equity.js --build-ranges')
  }
  const p = Math.max(RANGE_GRID[0], Math.min(100, pct))
  let i = 0
  while (i < RANGE_GRID.length - 2 && RANGE_GRID[i + 1] < p) i++
  const lo = RANGE_GRID[i]
  const hi = RANGE_GRID[i + 1]
  const f = (Math.log(p) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))
  const row = t.vsRange[idx]
  return row[i] + Math.max(0, Math.min(1, f)) * (row[i + 1] - row[i])
}

// ------------------------------------------------------- the estimate
//
// `skill` in [0,1] is how well the player does this, and it is applied to the
// estimate rather than to the decision that follows. Three specific errors are
// modelled because they are the three that real weak players actually make:
//
//   1. Ignoring the field. A hand that beats 80% of random hands beats all
//      five opponents only 0.8^5 = 33% of the time. Weak players price their
//      hand against one opponent no matter how many are in the pot, which is
//      the single most expensive mistake in a loose game.
//   2. Miscounting outs -- usually counting too many, because tainted outs and
//      cards that improve an opponent more get counted anyway.
//   3. Overvaluing a made hand, top pair especially.
//
// Nothing here is random per call: the same player estimating the same spot
// gets the same answer. The variability in what they *do* belongs to the
// decision rule, not to the estimate.
//
// `range` is the read on the opponent whose line says the most. Preflop it is
// how wide the last raiser's range is, as a percentage of hands -- null when
// nobody has raised; see rangeEquity. After the flop it is the fraction of
// holdings on this board that opponent would play the way they have, 1 (or
// null) for no read at all.
const estimateEquity = (hole, board, opponents, skill = 1, range = null) => {
  if (board.length === 0) {
    const idx = handIndex(hole[0], hole[1])
    const exact = preflopEquity(idx, opponents)
    const headsUp = preflopEquity(idx, 1)
    // Facing a raise, the skilled read is equity against the raiser's range,
    // discounted for the rest of the field by the same factor extra random
    // hands would cost.
    const read = range !== null && range < 100
      ? rangeEquity(idx, range) * exact / headsUp
      : exact
    // A weak player prices the hand at its heads-up value against a random
    // hand: blind both to how many are in the pot and to what a raise means.
    // That is the calling station's preflop leak, stated as a read.
    return read + (1 - skill) * (headsUp - read)
  }

  // The two readings of the same hand, and the difference between them is a
  // real difference between players.
  //
  // The unconditional percentile is the naive one -- "I have top pair, top pair
  // is a good hand" -- and it is genuinely how a weak player reads a board.
  // The board-conditional strength is the skilled one: top pair is strong on
  // 9-4-2 rainbow and close to worthless on QJT two-tone, and that distinction
  // is most of what postflop skill consists of.
  //
  // So proficiency interpolates between them, which makes an unskilled player
  // wrong in the specific way real unskilled players are wrong -- overvaluing a
  // made hand on a board that has passed it by -- rather than merely noisy.
  const naive = strengthPercentile(evaluate(hole.concat(board)))
  const informed = boardStrength(hole, board)
  const percentile = naive + skill * (informed - naive)

  // Against the opponent with a line, the hand has to beat the top `range` of
  // holdings rather than all of them: a hand that beats 85% of holdings beats
  // (0.85 - 0.45) / 0.55 = 73% of the top 55%, and none of the top 15%. That
  // is the read "he bet twice, my middle pair is no good", and a weak player
  // makes it less -- they believe a random hand bet into them, just as before
  // the flop they believe a random hand raised.
  const read = range !== null && range < 1 ? range + (1 - skill) * (1 - range) : 1
  const againstLine = read < 1 ? Math.max(0, (percentile - (1 - read)) / read) : percentile

  // Against several opponents every one of them has to be beaten. A skilled
  // player discounts for the field; an unskilled one barely does.
  const made = againstLine * Math.pow(percentile, (opponents - 1) * skill)

  // Draws, priced with the rule of 2 and 4: each out is worth about 4% with
  // two cards to come and about 2% with one. A weak player inflates the count.
  const cardsToCome = 5 - board.length
  if (cardsToCome > 0) {
    const outs = countOuts(hole, board)
    const inflated = outs * (1 + (1 - skill) * 0.5)
    const perOut = cardsToCome >= 2 ? 0.04 : 0.02
    const draw = Math.min(inflated * perOut, 0.95)
    // The hand is worth whichever is better -- what it is now, or what it is
    // drawing to. Adding them would double count the times it is already good.
    return Math.min(0.99, Math.max(made, draw))
  }

  return made
}

module.exports = {
  handIndex, handLabel, handCards, countOuts,
  strengthPercentile, boardStrength, preflopEquity, rangeEquity, rangeOrder, RANGE_GRID, handRank,
  estimateEquity, TABLE_FILE
}

// ------------------------------------------------------------- building

const buildCdf = () => {
  process.stdout.write('  enumerating all C(52,7) hands for the exact strength curve... ')
  const counts = new Map()
  const seven = new Array(7)
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
                const s = evaluate(seven)
                counts.set(s, (counts.get(s) || 0) + 1)
                total++
              }
            }
          }
        }
      }
    }
  }
  const scores = [...counts.keys()].sort((x, y) => x - y)
  const below = new Array(scores.length)
  let running = 0
  for (let i = 0; i < scores.length; i++) {
    below[i] = running / total
    running += counts.get(scores[i])
  }
  console.log(scores.length + ' distinct hand values over ' + total.toLocaleString())
  return { cdfScores: scores, cdfBelow: below.map((x) => Math.round(x * 1e6) / 1e6) }
}

const buildPreflop = (samples) => {
  const deck = new Array(52)
  const out = []
  for (let opp = 1; opp <= 8; opp++) {
    const row = new Array(169).fill(0)
    process.stdout.write('  preflop equity vs ' + opp + ' opponent' +
      (opp > 1 ? 's' : '') + '... ')
    for (let idx = 0; idx < 169; idx++) {
      const mine = handCards(idx)
      let won = 0
      for (let s = 0; s < samples; s++) {
        let k = 0
        for (let c = 0; c < 52; c++) {
          if (c !== mine[0] && c !== mine[1]) deck[k++] = c
        }
        const need = 5 + opp * 2
        for (let i = 0; i < need; i++) {
          const j = i + Math.floor(Math.random() * (k - i))
          const t = deck[i]
          deck[i] = deck[j]
          deck[j] = t
        }
        const board = [deck[0], deck[1], deck[2], deck[3], deck[4]]
        const mineScore = evaluate([mine[0], mine[1], ...board])
        let best = 0
        let tied = 0
        for (let o = 0; o < opp; o++) {
          const os = evaluate([deck[5 + o * 2], deck[6 + o * 2], ...board])
          if (os > best) {
            best = os
            tied = 0
          } else if (os === best) tied++
        }
        if (mineScore > best) won += 1
        else if (mineScore === best) won += 1 / (2 + tied)
      }
      row[idx] = Math.round((won / samples) * 1e4) / 1e4
    }
    out.push(row)
    console.log('done')
  }
  return out
}

// Heads-up equity of every starting hand against the top X% of hands, for each
// X on the grid. The opponent's holding is drawn uniformly from the range's
// combinations -- which is what weights a pair (6 combos) against an offsuit
// hand (12) correctly -- redrawing any that collide with the hero's cards.
const buildRanges = (preflop, samples) => {
  const order = rangeOrder(preflop)
  const combosOf = (idx) => {
    const a = Math.floor(idx / 13)
    const b = idx % 13
    const out = []
    for (let s1 = 0; s1 < 4; s1++) {
      for (let s2 = 0; s2 < 4; s2++) {
        if (a === b && s2 <= s1) continue
        if (a > b && s1 !== s2) continue
        if (a < b && s1 === s2) continue
        const hi = a > b ? a : b
        const lo = a > b ? b : a
        out.push([hi * 4 + s1, lo * 4 + s2])
      }
    }
    return out
  }
  const ranges = RANGE_GRID.map((pct) => {
    const want = 1326 * pct / 100
    const combos = []
    for (const idx of order) {
      if (combos.length >= want) break
      combos.push(...combosOf(idx))
    }
    return combos
  })

  let seed = 20260929
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const out = []
  const used = new Uint8Array(52)
  const board = new Array(5)
  for (let idx = 0; idx < 169; idx++) {
    const mine = handCards(idx)
    const row = []
    for (const range of ranges) {
      let won = 0
      for (let s = 0; s < samples; s++) {
        let theirs
        do {
          theirs = range[Math.floor(rand() * range.length)]
        } while (theirs[0] === mine[0] || theirs[0] === mine[1] ||
          theirs[1] === mine[0] || theirs[1] === mine[1])
        used.fill(0)
        used[mine[0]] = used[mine[1]] = used[theirs[0]] = used[theirs[1]] = 1
        for (let k = 0; k < 5; k++) {
          let c
          do c = Math.floor(rand() * 52); while (used[c])
          used[c] = 1
          board[k] = c
        }
        const a = evaluate([mine[0], mine[1], ...board])
        const b = evaluate([theirs[0], theirs[1], ...board])
        won += a > b ? 1 : a === b ? 0.5 : 0
      }
      row.push(Math.round((won / samples) * 1e4) / 1e4)
    }
    out.push(row)
  }
  return out
}

if (require.main === module) {
  if (process.argv[2] === '--build-ranges') {
    const samples = Number(process.argv[3]) || 20000
    const t = load()
    const started = Date.now()
    console.log('Building the range table (' + samples.toLocaleString() +
      ' samples per cell, ' + RANGE_GRID.length + ' ranges)')
    t.vsRange = buildRanges(t.preflop, samples)
    t.rangeGrid = RANGE_GRID
    t.rangeSamples = samples
    fs.writeFileSync(TABLE_FILE, JSON.stringify(t))
    console.log('Wrote equity.json in ' + ((Date.now() - started) / 1000).toFixed(0) + 's')
    const label = (l) => [...Array(169).keys()].find((i) => handLabel(i) === l)
    console.log('\n  vs top %   ' + RANGE_GRID.map((p) => String(p).padStart(6)).join(''))
    for (const l of ['AA', 'KK', 'QQ', 'AKs', 'AKo', 'JJ', '99', 'AJo', 'KQs', '76s', '72o']) {
      console.log('  ' + l.padEnd(10) + t.vsRange[label(l)]
        .map((x) => (x * 100).toFixed(1).padStart(6)).join(''))
    }
  } else if (process.argv[2] === '--build') {
    const samples = Number(process.argv[3]) || 40000
    console.log('Building equity.json (' + samples.toLocaleString() +
      ' samples per preflop cell)')
    const started = Date.now()
    const cdf = buildCdf()
    const preflop = buildPreflop(samples)
    fs.writeFileSync(TABLE_FILE, JSON.stringify({ ...cdf, preflop, samples }))
    const kb = Math.round(fs.statSync(TABLE_FILE).size / 1024)
    console.log('Wrote equity.json (' + kb + ' KB) in ' +
      ((Date.now() - started) / 1000).toFixed(0) + 's')
  } else {
    load()
    console.log('Preflop equity, 6-handed (5 opponents)\n')
    const rows = []
    for (let idx = 0; idx < 169; idx++) {
      rows.push({ label: handLabel(idx), eq: preflopEquity(idx, 5) })
    }
    rows.sort((a, b) => b.eq - a.eq)
    console.log('  best 12:  ' + rows.slice(0, 12)
      .map((r) => r.label + ' ' + (r.eq * 100).toFixed(0) + '%').join('  '))
    console.log('  worst 6:  ' + rows.slice(-6)
      .map((r) => r.label + ' ' + (r.eq * 100).toFixed(0) + '%').join('  '))
    console.log('\nHeads up, a few known numbers')
    for (const l of ['AA', 'KK', 'AKs', 'AKo', 'QQ', '72o']) {
      const idx = [...Array(169).keys()].find((i) => handLabel(i) === l)
      console.log('  ' + l.padEnd(4) + (preflopEquity(idx, 1) * 100).toFixed(1) + '%')
    }
    const t = load()
    console.log('\nStrength curve: ' + t.cdfScores.length +
      ' distinct seven-card hand values (exact)')
  }
}
