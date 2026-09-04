// Players: personality and proficiency as two independent dials.
//
// The reference strategies in texas.js are a single point -- one fixed rule,
// played the same way every time. What a field needs is a range of players who
// are wrong in different directions, because a strategy measured against one
// opponent type has only been measured against one opponent type.
//
// The model separates two things that a single "skill" number would conflate:
//
//   **Personality** is what a player wants to do. It biases the value of each
//   action -- aggression makes betting look better than it is, stickiness
//   makes calling look better, bluffiness makes betting look better
//   specifically when the hand is weak.
//
//   **Proficiency** is how well they do it, and it acts in two separate
//   places. It sets how accurate their read on the hand is (see
//   texas-equity.js, where a weak player miscounts outs and misprices a
//   multiway pot), and it sets how reliably they pick the action they
//   themselves rate highest.
//
// Keeping them independent is the point. Raising proficiency does not turn an
// aggressive player into a passive one -- it turns a wild aggressive player
// into a disciplined aggressive one, which is the distinction that makes a
// "high buy-in" field different from a "free tournament" field rather than
// just better at it.
//
// Note what is deliberately *not* a parameter: how wide a range anybody plays.
// Range width falls out of the traits and the proficiency, and is measured
// afterwards by the tracker at the bottom of this file. Asserting it directly
// would beg the question the simulation is supposed to answer.

const { estimateEquity } = require('./texas-equity')

// ------------------------------------------------------------------ traits
//
// Every trait is 0..1 with 0.5 as neutral, so an all-0.5 player is a plain
// value-maximiser with no personality at all -- which makes it the baseline
// everything else is measured against.
const DEFAULT_TRAITS = {
  aggression: 0.5,   // prefers betting and raising over checking and calling
  looseness: 0.5,    // prefers playing over folding
  stickiness: 0.5,   // prefers calling specifically -- the calling station axis
  bluffiness: 0.5,   // bets *because* the hand is weak, rather than despite it
  sizing: 0.6,       // preferred bet as a fraction of the pot
  tilt: 0.0          // how much a recent loss loosens and angers the player
}

// ------------------------------------------------------------- parameters
//
// The constants of the model, in one place and settable from outside, because
// they are not knowable from first principles -- they are fitted, by
// texas-calibrate.js, so that a field of these players reproduces the
// behaviour real players are known to exhibit.
//
// The trait pulls are in units of the pot: at 0.35, a maximally aggressive
// player will take a raise worth up to about a third of a pot less than its
// best alternative. Large enough to produce real personalities, small enough
// that nobody is playing at random.
const PARAMS = {
  // How hard each trait pulls on the value of an action.
  // Held fixed, not fitted: these and the archetype traits are the same
  // degree of freedom, so only one of the two can be searched.
  pullAggression: 0.50,
  pullLooseness: 0.50,
  pullStickiness: 0.50,
  pullBluffiness: 0.50,

  // Fold equity: the floor, how much a bigger price buys, and how fast it
  // collapses for each time the pot has already been raised.
  foldBase: 0.10,
  foldSlope: 0.55,
  stubbornness: 0.45,

  // How far to discount equity for the news that somebody else is betting.
  //
  // Split by street, because the news is not the same news. A preflop raise is
  // a narrow, honest range -- almost nobody opens trash from early position --
  // so it should be believed. A postflop bet is a much weaker signal, since
  // continuation bets are made with most of a range whether they connected or
  // not, so it should be believed far less.
  //
  // As a single constant this could not do both jobs: the fit drove it to its
  // bound trying to make preflop tight enough, and that same shade then folded
  // every flop, which is why showdowns were reached on 15.8% of hands against
  // a real 26%. One constant, two incompatible demands.
  callShadePre: 0.55,
  callShadePost: 0.20,
  raiseShade: 0.45,

  // A flat discount applied to any postflop call, on top of the price-scaled
  // one above.
  //
  // The price term alone cannot express what it needs to: for a 60%-pot bet the
  // price is 0.375, so even a maximal coefficient shades the equity by barely a
  // third, and a hand that beats half the opponent's holdings still calls
  // comfortably. But a bet is bad news whatever its size -- the range betting
  // it is stronger than the range that would have checked, and that is true of
  // a small bet too.
  //
  // Without this term, players facing a flop bet folded 10% of the time against
  // a real 50-60%, and 89% of flops ran to showdown.
  callShadePostBase: 0.30,

  // Reverse implied odds, per street still to come.
  //
  // Calling a flop bet does not cost what is in front of you -- it buys a turn
  // you will have to pay for again, and often a river after that. A one-shot
  // model that prices only the chips on the table under-folds by construction,
  // and this one did so badly: 89% of the flops it saw reached a showdown,
  // against a real 26%. Nothing was ever won without showing down, because
  // nobody could be made to let go.
  //
  // Charging the call a premium for each street still to come is the cheapest
  // honest way to say that. It is zero on the river, where there is no future
  // to pay for.
  futureCost: 0.35,

  // Proficiency to softmax temperature.
  temperature: 1.2,

  // How much position is worth. Chips out of position are worth less than the
  // same chips on the button, because every later street has to be acted on
  // first, so less of the hand's raw equity actually gets realised.
  pullPosition: 0.45,
  positionPostWeight: 0.35,

  // The most any personality may move the value of an action, in pots.
  //
  // Traits compound -- a calling station is both sticky and loose, and both
  // push the same way on calling -- so without a ceiling the combined bias
  // grows past every expected-value difference on the table and the player
  // stops responding to their cards at all. Fitting without this drove the
  // station to 85% VPIP while the same pulls were still too weak to make a nit
  // tight, which is the signature of a bias that has become an override.
  maxBias: 0.60
}

const setParams = (p) => Object.assign(PARAMS, p)

// --------------------------------------------------------- action values
//
// Everything is expressed in chips, as expected value relative to folding --
// which is worth exactly zero, because chips already in the pot are not the
// player's any more. Putting the actions on a common scale is what lets
// personality be a bias with a size rather than a special case per branch.
//
// This is the same move odds.js makes for blackjack: the decision has to be
// made on the EV scale because the payouts differ per action, and comparing
// anything else silently compares the wrong quantities.
const actionValues = (v, equity, opponents, sizing = 0.6) => {
  const pot = v.pot
  const toCall = v.toCall
  const values = {}

  // ---------------------------------------------------------------- position
  //
  // Postflop the action starts left of the button, so the button acts last on
  // every street and the small blind acts first. A hand played from out of
  // position realises less of its raw equity than the same hand on the button,
  // and pricing every seat identically is what makes a model limp the small
  // blind with anything that clears the pot odds -- the exact spot where a real
  // player folds despite the price, because the price is not the whole cost.
  //
  // The button realises in full and everyone else realises less, so this scales
  // off position directly rather than off distance from an average seat.
  // Written the other way the whole effect was bounded at half the coefficient,
  // leaving the blinds realising 86% of their equity against a real figure
  // nearer 60% -- and a big blind that realises 86% is right never to fold for
  // one more chip into six, which is why hands almost never ended preflop.
  //
  // It applies in full before the flop and at a fitted fraction after it,
  // because realisation is a *forecast*: it prices the streets still to come.
  // Once those streets arrive the disadvantage is already being paid, in the
  // action order itself, and charging the forecast again on every street counts
  // it twice -- which folded so many flops that showdowns fell to 6% of hands.
  const stepsToButton = (v.button - v.seat + v.numPlayers) % v.numPlayers
  const outOfPosition = v.numPlayers > 1 ? stepsToButton / (v.numPlayers - 1) : 0
  const positionPull = v.board.length === 0
    ? PARAMS.pullPosition
    : PARAMS.pullPosition * PARAMS.positionPostWeight
  const realisation = 1 - positionPull * outOfPosition
  equity = Math.max(0, Math.min(1, equity * realisation))

  // Folding forfeits nothing further. It is the origin of the scale.
  values.fold = 0

  if (toCall === 0) {
    // Staying in for free keeps the equity and costs nothing.
    values.check = equity * pot
  } else {
    // Being bet into is bad news. Equity here is measured against random
    // hands, but the player putting chips in does not hold a random hand, and
    // the bigger the bet the less random it is. Pricing a call off
    // unconditional equity is the single thing that makes a heuristic bot call
    // far too much, so the estimate is shaded by the price being laid.
    const price = toCall / (pot + toCall)
    const shadeAmount = v.board.length === 0
      ? PARAMS.callShadePre * price
      : Math.min(0.95, PARAMS.callShadePostBase + PARAMS.callShadePost * price)
    const facing = equity * (1 - shadeAmount)
    // Streets still to be paid for: two on the flop, one on the turn, none on
    // the river. Preflop is priced by its own shade rather than this.
    const toCome = v.board.length === 0 ? 0 : Math.max(0, 4 - v.board.length)
    const effectiveCost = toCall * (1 + PARAMS.futureCost * toCome)
    values.call = facing * pot - (1 - facing) * effectiveCost
  }

  if (v.canRaise) {
    // Preflop is priced in blinds and postflop as a fraction of the pot,
    // which is how raises are actually sized at a table. A `sizing` of 0.6
    // opens for about 3.2bb and bets about 60% of the pot -- both squarely in
    // the normal range, with the trait moving them either way.
    const target = v.board.length === 0
      ? v.committed[v.seat] + toCall + v.bigBlind * (1 + 2 * sizing)
      : v.committed[v.seat] + toCall + pot * sizing
    const raiseTo = Math.max(v.minRaiseTo, Math.min(v.maxRaiseTo, Math.round(target)))
    const cost = raiseTo - v.committed[v.seat]
    const price = cost / (pot + cost)

    // Fold equity is governed by two things: the price the bet offers, and how
    // committed the opponents already are.
    //
    // The second term is the important one. Without it the value of a raise
    // grows with the pot -- `foldsOut * pot` gets bigger every time the pot
    // does -- so a bluff looks better the more it has already been called, and
    // the model happily fires a third barrel into two players who called the
    // first two. Opponents who have most of their stack in the middle are not
    // folding, and saying so is what stops the runaway.
    let invested = 0
    let live = 0
    for (let s = 0; s < v.numPlayers; s++) {
      if (s === v.seat || !v.inHand[s] || v.folded[s]) continue
      live++
      invested += v.totalCommitted[s] / (v.stacks[s] + v.totalCommitted[s] + 1)
    }
    const commitment = live > 0 ? invested / live : 0

    // And how many times this pot has already been raised. Somebody who has
    // re-raised once will not fold to a third bet, and someone who has done it
    // twice certainly will not.
    //
    // Without this the model finds an unbounded re-raise war: every raise
    // grows the pot, a bigger pot makes the `foldsOut * pot` term bigger, and
    // so the next raise looks better than the last. Measured at 15.4 preflop
    // raises per hand, ending 91% of hands heads-up and all-in before the
    // flop. Reading it off the betting history is also the right place for it
    // to come from -- it is exactly what a player at the table is going on.
    let raisesThisStreet = 0
    for (let i = 0; i < v.history.length; i++) {
      const a = v.history[i]
      if (a.street === v.street && a.type === 'raise') raisesThisStreet++
    }
    const stubbornness = Math.pow(PARAMS.stubbornness, raisesThisStreet)

    const perOpponent = Math.min(0.7, PARAMS.foldBase + PARAMS.foldSlope * price) * (1 - commitment) * stubbornness
    const foldsOut = Math.pow(Math.max(0, perOpponent), Math.max(1, opponents))

    // And when the raise *is* called, the caller is not holding a random hand
    // either -- the same correction, more strongly, because calling a raise is
    // a stronger statement than calling a bet.
    const called = equity * (1 - PARAMS.raiseShade * price)

    values.raise = foldsOut * pot +
      (1 - foldsOut) * (called * (pot + cost) - (1 - called) * cost)
    values.raiseTo = raiseTo
  }

  return values
}

// ------------------------------------------------------------ personality
//
// Biases are added to the value of each action, in chips, scaled by the pot so
// that a personality is equally opinionated in a big pot and a small one.
const applyTraits = (values, traits, equity, pot, tiltLevel, preflop) => {
  const out = { ...values }
  const aggression = clamp01(traits.aggression + tiltLevel * 0.3)
  const looseness = clamp01(traits.looseness + tiltLevel * 0.4)

  if (out.raise !== undefined) {
    out.raise += pot * (aggression - 0.5) * PARAMS.pullAggression * 2
    // Bluffing is not "betting more". It is betting *because* the hand cannot
    // win a showdown, so the bonus is tied to the hand being weak.
    if (equity < 0.35) {
      out.raise += pot * (traits.bluffiness - 0.5) * PARAMS.pullBluffiness * 2 *
        (1 - equity / 0.35)
    }
  }
  if (out.call !== undefined) {
    // The two calling traits act on different streets, which is what their
    // names have meant all along: looseness is playing too many hands,
    // stickiness is refusing to let go of the ones you played. Applying both
    // everywhere welded them together, so the only calling station the model
    // could build was one that limped every hand as well -- 72% of them,
    // against the 45% a real station plays. Separating them lets a station be
    // what it actually is: ordinary before the flop, immovable after it.
    if (preflop) out.call += pot * (looseness - 0.5) * PARAMS.pullLooseness * 2
    else out.call += pot * (traits.stickiness - 0.5) * PARAMS.pullStickiness * 2
  }
  if (out.check !== undefined) {
    // A passive player likes checking; an aggressive one dislikes it.
    out.check -= pot * (aggression - 0.5) * PARAMS.pullAggression
  }

  // The ceiling. Personality is allowed to move a decision by at most
  // `maxBias` pots, so a player with extreme traits still notices what they
  // are holding. Without it the traits that push the same way simply add up
  // until nothing else on the table can outweigh them.
  const ceiling = pot * PARAMS.maxBias
  for (const key of Object.keys(out)) {
    if (key === 'raiseTo') continue
    const shift = out[key] - values[key]
    if (shift > ceiling) out[key] = values[key] + ceiling
    else if (shift < -ceiling) out[key] = values[key] - ceiling
  }
  return out
}

// --------------------------------------------------------- the decision
//
// Softmax over the action values. Temperature is set by proficiency: at 1 the
// player reliably takes the action they rate highest, at 0 they pick almost at
// random among the legal ones. Scaling the temperature by the pot keeps it
// meaningful -- a two-chip mistake matters in a ten-chip pot and not in a
// three-hundred-chip one.
//
// Note that a low-proficiency player is not a player with no personality: the
// traits are baked into the values *before* the temperature is applied, so an
// unskilled aggressive player is erratic in an aggressive direction. That is
// the whole reason the two dials are separate.
const choose = (values, proficiency, pot, rng) => {
  const keys = Object.keys(values).filter((k) => k !== 'raiseTo')
  const temperature = pot * (1.02 - proficiency) * PARAMS.temperature

  if (temperature < 1e-9) {
    let best = keys[0]
    for (const k of keys) if (values[k] > values[best]) best = k
    return best
  }

  let max = -Infinity
  for (const k of keys) if (values[k] > max) max = values[k]

  const weights = keys.map((k) => Math.exp((values[k] - max) / temperature))
  const total = weights.reduce((a, b) => a + b, 0)
  let r = rng() * total
  for (let i = 0; i < keys.length; i++) {
    r -= weights[i]
    if (r <= 0) return keys[i]
  }
  return keys[keys.length - 1]
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)

// ------------------------------------------------------------- the player

const countOpponents = (v) => {
  let n = 0
  for (let s = 0; s < v.numPlayers; s++) {
    if (s !== v.seat && v.inHand[s] && !v.folded[s]) n++
  }
  return Math.max(1, n)
}

const makePlayer = (name, { traits = {}, proficiency = 0.5, rng = Math.random } = {}) => {
  const t = { ...DEFAULT_TRAITS, ...traits }
  const player = {
    name,
    traits: t,
    proficiency,
    tiltLevel: 0,

    act: (v) => {
      const opponents = countOpponents(v)
      // Proficiency first degrades the read on the hand, before it is used
      // for anything. A weak player is not making good decisions noisily --
      // they are making decisions on a wrong number.
      const equity = estimateEquity(v.holeCards, v.board, opponents, proficiency)
      const base = actionValues(v, equity, opponents, t.sizing)
      const biased = applyTraits(base, t, equity, v.pot, player.tiltLevel,
        v.board.length === 0)
      const pick = choose(biased, proficiency, Math.max(v.bigBlind, v.pot), rng)

      if (pick === 'raise') return { action: 'raise', to: base.raiseTo }
      if (pick === 'call') return { action: 'call' }
      if (pick === 'check') return { action: 'check' }
      return { action: 'fold' }
    },

    // Called by the harness after each hand, when it supports it. Tilt decays
    // on its own and spikes on a loss, so a tilting player is not permanently
    // angry -- they are angry for the next few hands, which is what tilt is.
    observe: (result, seat) => {
      if (!t.tilt) return
      player.tiltLevel *= 0.7
      const delta = result.deltas[seat]
      if (delta < 0) {
        const severity = Math.min(1, -delta / (result.stacks[seat] + 1))
        player.tiltLevel = Math.min(1, player.tiltLevel + t.tilt * severity)
      }
    }
  }
  return player
}

// ------------------------------------------------------------- archetypes
//
// Named points in the trait space. The names are a convenience for talking
// about them; nothing downstream reads them, and in particular nothing a
// strategy under test can see reveals which of these it is sitting against.
const ARCHETYPES = {
  nit: { aggression: 0.30, looseness: 0.12, stickiness: 0.35, bluffiness: 0.10, sizing: 0.5 },
  rock: { aggression: 0.40, looseness: 0.25, stickiness: 0.40, bluffiness: 0.20, sizing: 0.5 },
  tag: { aggression: 0.75, looseness: 0.35, stickiness: 0.35, bluffiness: 0.55, sizing: 0.65 },
  lag: { aggression: 0.85, looseness: 0.65, stickiness: 0.40, bluffiness: 0.75, sizing: 0.75 },
  station: { aggression: 0.15, looseness: 0.80, stickiness: 0.92, bluffiness: 0.10, sizing: 0.4 },
  maniac: { aggression: 0.95, looseness: 0.90, stickiness: 0.50, bluffiness: 0.85, sizing: 0.9 },
  bluffer: { aggression: 0.70, looseness: 0.55, stickiness: 0.30, bluffiness: 0.95, sizing: 0.8 },
  // Cocky is the interesting one: aggressive, and it tilts, so its personality
  // is not constant across a session even though its parameters are.
  cocky: { aggression: 0.80, looseness: 0.60, stickiness: 0.45, bluffiness: 0.70, sizing: 0.8, tilt: 0.6 }
}

// The trait values above are starting guesses, not measurements. They and the
// four `pull` scales are the same degree of freedom -- doubling a pull and
// halving every trait's distance from neutral produces an identical player --
// so fitting both at once is over-parameterised, and a search asked to do it
// simply runs the pulls to their bounds. The pulls are therefore held fixed
// and the traits are what gets fitted, by texas-calibrate.js, against the
// behaviour each named type is supposed to exhibit.
const setArchetype = (kind, traits) => {
  ARCHETYPES[kind] = { ...ARCHETYPES[kind], ...traits }
}

// A fitted set overrides the guesses when one exists.
try {
  const fitted = require('./calibration.json')
  if (fitted && fitted.params) setParams(fitted.params)
  if (fitted && fitted.archetypes) {
    for (const kind of Object.keys(fitted.archetypes)) {
      setArchetype(kind, fitted.archetypes[kind])
    }
  }
} catch (err) {
  // No calibration yet -- the defaults above are what the model runs on.
}

const archetype = (kind, proficiency, rng, label) =>
  makePlayer(label || (kind + '/' + proficiency.toFixed(1)), {
    traits: ARCHETYPES[kind],
    proficiency,
    rng
  })

// ---------------------------------------------------------------- tracking
//
// The stats a real player would have on an opponent, and the only honest way
// to check whether a personality behaves the way its name claims. VPIP and PFR
// are the standard measures of how wide somebody plays; AF is how often they
// bet rather than call; WTSD is how often they see a showdown.
//
// These are also the calibration targets. A 6-max cash game runs roughly
// 22/18 for a solid regular and 40+/5 for a loose passive one, and a field
// that does not reproduce numbers in that neighbourhood is not modelling
// anything, whatever its archetypes are called.
const makeTracker = (numPlayers) => {
  const blank = () => ({
    hands: 0, vpip: 0, pfr: 0, bets: 0, calls: 0, folds: 0,
    sawFlop: 0, showdowns: 0, won: 0, chips: 0
  })
  const stats = Array.from({ length: numPlayers }, blank)

  return {
    stats,
    record: (result) => {
      const voluntary = new Array(numPlayers).fill(false)
      const raisedPre = new Array(numPlayers).fill(false)
      const foldedPre = new Array(numPlayers).fill(false)

      for (const a of result.actions) {
        const s = a.seat
        if (a.type === 'raise') {
          stats[s].bets++
          if (a.street === 'preflop') {
            raisedPre[s] = true
            voluntary[s] = true
          }
        } else if (a.type === 'call') {
          stats[s].calls++
          if (a.street === 'preflop') voluntary[s] = true
        } else if (a.type === 'fold') {
          stats[s].folds++
          if (a.street === 'preflop') foldedPre[s] = true
        }
      }

      const flopDealt = result.board.length >= 3
      for (let s = 0; s < numPlayers; s++) {
        if (!result.holeCards[s] || result.holeCards[s].length === 0) continue
        stats[s].hands++
        if (voluntary[s]) stats[s].vpip++
        if (raisedPre[s]) stats[s].pfr++
        if (flopDealt && !foldedPre[s]) stats[s].sawFlop++
        stats[s].chips += result.deltas[s]
        if (result.wentToShowdown && !result.folded[s]) stats[s].showdowns++
        if (result.winners.some((w) => w.seat === s)) stats[s].won++
      }
    },
    summary: (names, bigBlind) => stats.map((st, i) => ({
      name: names[i],
      hands: st.hands,
      vpip: st.hands ? (st.vpip / st.hands) * 100 : 0,
      pfr: st.hands ? (st.pfr / st.hands) * 100 : 0,
      af: st.calls ? st.bets / st.calls : (st.bets ? Infinity : 0),
      // WTSD is "went to showdown *when saw flop*" -- the denominator is the
      // hands that reached a flop, not every hand dealt. Measured against all
      // hands it is a different statistic entirely, and one that cannot reach
      // the published figure at any sane VPIP: a player in 22% of hands cannot
      // show down 26% of them. Fitting to it that way made the target
      // unreachable by construction, and five calibration runs duly failed to
      // move it however the model changed.
      wtsd: st.sawFlop ? (st.showdowns / st.sawFlop) * 100 : 0,
      sawFlop: st.hands ? (st.sawFlop / st.hands) * 100 : 0,
      bb100: st.hands ? (st.chips / bigBlind / st.hands) * 100 : 0
    }))
  }
}

module.exports = {
  makePlayer, archetype, ARCHETYPES, DEFAULT_TRAITS, makeTracker,
  actionValues, applyTraits, choose, PARAMS, setParams, setArchetype
}
