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

const { estimateEquity, handIndex, handRank } = require('./texas-equity')
const { evaluate, categoryOf } = require('./texas-eval')

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

  // Made-hand overvalue. Sticky players read a made hand as stronger than it
  // is: a station calls down with any pair *and* bets it, which is why this
  // lifts calls and bets together where a raw stickiness bias only lifts
  // calls -- and calls alone drag AF below target while WTSD rises. It is a
  // flat equity bonus postflop when holding a pair or better, scaled by how
  // far stickiness sits from neutral. That scaling is also why it is zero
  // at neutral: the stage-1 regulars sit at exactly 0.5 and cannot see it,
  // so it is fitted with the personality scales rather than the value model.
  handOvervalue: 0,

  // Fold equity: the floor, how much a bigger price buys, and how fast it
  // collapses for each time the pot has already been raised.
  foldBase: 0.10,
  foldSlope: 0.55,
  stubbornness: 0.45,

  // How wide a player reads the last raiser's range before the flop, as a
  // percentage of all hands: an open is `rangeOpen`, each further raise
  // narrows it by `rangeStep`, and a raise bigger than the standard 3x
  // narrows it again by (3 / size)^rangeSizeExp -- a shove over an open is not
  // a 3-bet range, it is the big pairs. Equity is then read against that range
  // (texas-equity.js, rangeEquity), which is how a player prices a call.
  //
  // This replaced `callShadePre`, a discount of preflop equity proportional to
  // the price. The fit ran it to 3.5, where the discounted equity is negative
  // for every real raise: nobody would call a raise with aces, and against a
  // shove everybody folded everything. VPIP and PFR came out right regardless,
  // which is how it survived -- they count how often a player acts, not with
  // what. A range read cannot go negative however it is fitted, and it says
  // what the old constant was trying to: a raise is a strong hand.
  rangeOpen: 20,
  rangeStep: 0.3,
  rangeSizeExp: 0.5,

  // Facing a preflop raise, how many of the players still to act a player
  // expects to come along: a call is priced against everyone already in plus
  // this fraction of those behind, since most of them will fold.
  enterRate: 0.3,
  // And how likely each of them is to raise again -- a squeeze -- which
  // usually costs the call.
  raiseBehind: 0.12,

  // The preflop chart (see preflopValues). Open the top `openBase`% with two
  // players left behind (the button), times `openDecay` for each further one
  // and `limpedMult` for each limper; a raise is worth `chartScale` pots per
  // unit of log-margin inside that width, a limp `limpGap` less. Facing a raise,
  // 3-bet when equity against the raiser's range clears `threeBetEq`.
  openBase: 45,
  openDecay: 0.75,
  limpedMult: 0.9,
  limpGap: 0.08,
  chartScale: 3,
  threeBetEq: 0.58,

  // How far to discount postflop equity for the news that somebody is betting.
  // A postflop bet is a much weaker signal than a preflop raise, since
  // continuation bets are made with most of a range whether they connected or
  // not, so it is believed far less.
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

  // Proficiency to softmax temperature, after the flop and before it.
  temperature: 1.2,
  temperaturePre: 0.6,
  temperatureCurve: 1.0,

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

// Only keys the model still has: a calibration.json written before a constant
// was retired would otherwise carry it back in, unused but reported as fitted.
const setParams = (p) => {
  for (const k of Object.keys(p)) if (k in PARAMS) PARAMS[k] = p[k]
  return PARAMS
}

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
//
// After the flop only. Before it, see preflopValues: a one-shot valuation like
// this one cannot price a preflop hand, whose value is mostly in the streets
// it has not seen yet.
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
  // It applies in full before the flop (in preflopValues) and at a fitted
  // fraction after it, because realisation is a *forecast*: it prices the
  // streets still to come. Once those streets arrive the disadvantage is
  // already being paid, in the action order itself, and charging the forecast
  // again on every street counts it twice -- which folded so many flops that
  // showdowns fell to 6% of hands.
  const realisation = 1 - PARAMS.pullPosition * PARAMS.positionPostWeight * outOfPositionOf(v)
  equity = Math.max(0, Math.min(1, equity * realisation))

  // Folding forfeits nothing further. It is the origin of the scale.
  values.fold = 0

  if (toCall === 0) {
    // Staying in for free keeps the equity and costs nothing.
    values.check = equity * pot
  } else {
    // Being bet into is bad news. Equity here is measured against random
    // hands, but the player putting chips in does not hold a random hand, and
    // the bigger the bet the less random it is, so the estimate is shaded by
    // the price being laid.
    const price = toCall / (pot + toCall)
    const shadeAmount = Math.min(0.95, PARAMS.callShadePostBase + PARAMS.callShadePost * price)
    const facing = equity * (1 - shadeAmount)
    // Streets still to be paid for: two on the flop, one on the turn, none on
    // the river.
    const toCome = Math.max(0, 4 - v.board.length)
    const effectiveCost = toCall * (1 + PARAMS.futureCost * toCome)
    values.call = facing * pot - (1 - facing) * effectiveCost
  }

  if (v.canRaise) {
    // Bets are sized as a fraction of the pot, which is how they are actually
    // sized at a table. A `sizing` of 0.6 bets about 60% of the pot, with the
    // trait moving it either way; preflop sizing is preflopRaiseTo.
    const target = v.committed[v.seat] + toCall + pot * sizing
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
  // Aggression is split by street, for the same reason calling was: PFR and AF
  // are tracked separately because they are separate habits. As one trait it
  // could not build a LAG. Loosening its calling from 0.65 all the way to 0.02
  // took VPIP only from 51.8 to 35.8 while PFR stayed at 35.5 -- it was raising
  // nearly every hand it played -- and lowering aggression enough to bring PFR
  // to 15 dragged its postflop AF down to 1.0 with it. A player who opens
  // selectively and then bets relentlessly was not expressible.
  //
  // Falls back to `aggression` when not given, so a player defined with one
  // number behaves exactly as it did before the split.
  const streetAggression = preflop && traits.preflopAggression !== undefined
    ? traits.preflopAggression
    : traits.aggression
  const aggression = clamp01(streetAggression + tiltLevel * 0.3)
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
    // The per-archetype scale extends the reach of that immovability: the
    // trait itself saturates at 0.98, so past it only the scale has any
    // gradient to give.
    //
    // Before the flop the bias fades as the hand gets stronger, by (1 -
    // equity): looseness is about which marginal hands a player takes on,
    // and nobody's personality decides whether to play aces. As a flat bias
    // it let a tight enough nit fold AA to a raise.
    if (preflop) out.call += pot * (looseness - 0.5) * PARAMS.pullLooseness * 2 * (1 - equity)
    else out.call += pot * (traits.stickiness - 0.5) * PARAMS.pullStickiness * 2 *
      (traits.stickinessScale || 1)
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
//
// `base` is the temperature at the regulars' proficiency. Preflop has its own
// (temperaturePre): a memorised chart is played far more steadily than a
// postflop judgement is made, and one shared temperature could not be low
// enough for the first without freezing the second.
const choose = (values, proficiency, pot, rng, base = PARAMS.temperature) => {
  const keys = Object.keys(values).filter((k) => k !== 'raiseTo')
  const temperature = pot * base * REG_SLOPPINESS *
    Math.pow((1.02 - proficiency) / REG_SLOPPINESS, PARAMS.temperatureCurve)

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

// The sloppiness of the proficiency the table of regulars is fitted at. The
// temperature curve pivots on this point, so bending it reshapes how erratic
// weaker and stronger players are while leaving the regulars -- and therefore
// the whole stage 1 fit -- exactly where they were.
const REG_PROFICIENCY = 0.85
const REG_SLOPPINESS = 1.02 - REG_PROFICIENCY

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)

// ------------------------------------------------------------- the player

const countOpponents = (v) => {
  let n = 0
  for (let s = 0; s < v.numPlayers; s++) {
    if (s !== v.seat && v.inHand[s] && !v.folded[s]) n++
  }
  return Math.max(1, n)
}

// Preflop, who is already in voluntarily and who is still to act (posting a
// blind is not acting).
const splitOpponents = (v) => {
  const acted = new Set()
  for (const a of v.history) {
    if (a.street === 'preflop' && a.type !== 'fold') acted.add(a.seat)
  }
  let inAlready = 0
  let pending = 0
  for (let s = 0; s < v.numPlayers; s++) {
    if (s === v.seat || !v.inHand[s] || v.folded[s]) continue
    if (acted.has(s)) inAlready++
    else pending++
  }
  return { inAlready, pending }
}

// The read on the last preflop raiser: what percentage of hands they would do
// this with, or null if nobody has raised. Everything it uses is on the table
// -- how many raises, and how big the last one was relative to the bet it
// raised.
const raiserRange = (v) => {
  let raises = 0
  let bet = v.bigBlind
  let size = 3
  for (const a of v.history) {
    if (a.street !== 'preflop' || a.type !== 'raise') continue
    size = a.to / bet
    bet = a.to
    raises++
  }
  if (raises === 0) return null
  const pct = PARAMS.rangeOpen * Math.pow(PARAMS.rangeStep, raises - 1) *
    Math.pow(Math.min(1, 3 / size), PARAMS.rangeSizeExp)
  return Math.max(1, Math.min(100, pct))
}

// ---------------------------------------------------------- before the flop
//
// Nobody works out the expected value of a preflop open. They know roughly how
// good their hand is -- where it sits among the 169 -- and roughly how wide
// they open from this seat, and they compare the two. Facing a raise they do
// work something out, but it is the pot-odds sum against the raiser's range,
// not a simulation of the rest of the hand.
//
// That is how the model plays before the flop too, and it replaced a one-shot
// valuation (equity times pot, as if every hand went quietly to showdown) that
// could not do it. That valuation priced a raise with aces under the gun at
// under half a big blind -- it cannot see the later streets where aces make
// their money -- so aces were folded to decision noise, and the only fit that
// ever made the field look tight got there with a constant that made every
// preflop call unprofitable, aces included.
//
// The values below are in the same currency as everything else -- chips, with
// fold at zero -- so personality biases and the proficiency temperature act on
// them exactly as they do after the flop.
//
// Unopened (or only limped): open the top W% of hands, where W widens as fewer
// players are left behind and shifts with each limper. A hand's raise value is
// how far inside W it sits, times `chartScale` pots. A limp is the same hand
// valued `limpGap` lower: a regular prefers to raise the hands they play, and
// only a player whose personality likes calling ends up limping.
//
// Facing a raise: the pot-odds sum on equity against the raiser's range, with
// the cost of position and of being squeezed by players still to act. A 3-bet
// is valued by how far that equity clears `threeBetEq`.
// Opens are priced in blinds -- a `sizing` of 0.6 opens for about 3.2bb, plus
// a blind per limper -- and re-raises as a multiple of the bet they raise,
// 3.2x at the same sizing, which is how both are sized at a table. Pricing a
// 3-bet in blinds too made it a near-minimum raise that nobody had a reason
// to fold to.
const preflopRaiseTo = (v, sizing) => {
  const currentBet = v.committed[v.seat] + v.toCall
  let raised = false
  let limpers = 0
  for (const a of v.history) {
    if (a.street !== 'preflop') continue
    if (a.type === 'raise') raised = true
    else if (a.type === 'call' && !raised) limpers++
  }
  const target = raised
    ? currentBet * (2 + 2 * sizing)
    : v.bigBlind * (2 + 2 * sizing) + limpers * v.bigBlind
  return Math.max(v.minRaiseTo, Math.min(v.maxRaiseTo, Math.round(target)))
}

const outOfPositionOf = (v) => {
  const stepsToButton = (v.button - v.seat + v.numPlayers) % v.numPlayers
  return v.numPlayers > 1 ? stepsToButton / (v.numPlayers - 1) : 0
}

const preflopValues = (v, skill, sizing) => {
  const idx = handIndex(v.holeCards[0], v.holeCards[1])
  const pot = v.pot
  const values = { fold: 0 }
  const range = raiserRange(v)
  const { inAlready, pending } = splitOpponents(v)
  let strength

  if (range === null) {
    const rank = handRank(idx, skill)
    // The button's width is the widest: the blinds, facing limpers with one
    // or no players behind them, raise at most that wide. Extrapolating the
    // decay past the button had the big blind isolating a limp with 72% of
    // hands, and the first chart solved against it limped the button with
    // 78% of hands to re-raise those isolations.
    const behind = Math.max(2, pending)
    const width = Math.max(0.5, Math.min(100, PARAMS.openBase *
      Math.pow(PARAMS.openDecay, behind - 2) * Math.pow(PARAMS.limpedMult, inAlready)))
    // How many times inside the range the hand is, on a log scale. Aces are
    // about a hundred times inside any opening range and a hand at the edge is
    // at zero, so decision noise lands where people actually make mistakes --
    // on the marginal hands. Measured as a plain difference in rank, aces sat
    // only 19 points inside a nit's range under the gun, no further from the
    // edge in value than a middling hand, and were folded to noise.
    const margin = Math.log(width / rank)
    const scale = PARAMS.chartScale * pot
    if (v.canRaise) values.raise = scale * margin
    // The big blind's option costs nothing, so checking is worth a little
    // more than folding whatever the hand.
    if (v.toCall === 0) values.check = scale * 0.01
    else values.call = scale * (margin - PARAMS.limpGap)
    strength = 1 - rank / 100
  } else {
    const opponents = Math.max(1, inAlready + pending * PARAMS.enterRate)
    const equity = estimateEquity(v.holeCards, [], opponents, skill, range)
    // Once the money is all in there are no later streets to play out of
    // position and nothing left to be squeezed off the hand by: the equity is
    // realised in full. Charging both anyway had the fitted TAG folding aces
    // to an all-in 15% of the time.
    const allIn = v.toCall >= v.stack || v.allIn.some((a, s) => a && s !== v.seat && !v.folded[s])
    const realised = allIn
      ? equity
      : equity * (1 - PARAMS.pullPosition * outOfPositionOf(v) * (1 - equity))
    const squeezed = allIn ? 0 : 1 - Math.pow(1 - PARAMS.raiseBehind, pending)
    const call = realised * (pot + v.toCall) - v.toCall
    values.call = (1 - squeezed) * call - squeezed * v.toCall
    if (v.canRaise) values.raise = PARAMS.chartScale * pot * (equity - PARAMS.threeBetEq)
    strength = equity
  }
  values.raiseTo = preflopRaiseTo(v, sizing)
  return { values, strength }
}

const makePlayer = (name, { traits = {}, proficiency = 0.5, rng = Math.random } = {}) => {
  const t = { ...DEFAULT_TRAITS, ...traits }
  const player = {
    name,
    traits: t,
    proficiency,
    tiltLevel: 0,

    act: (v) => {
      const preflop = v.board.length === 0
      let base
      let equity
      if (preflop) {
        const pre = preflopValues(v, proficiency, t.sizing)
        base = pre.values
        equity = pre.strength
      } else {
        const opponents = countOpponents(v)
        // Proficiency first degrades the read on the hand, before it is used
        // for anything. A weak player is not making good decisions noisily --
        // they are making decisions on a wrong number.
        equity = estimateEquity(v.holeCards, v.board, opponents, proficiency)
        // Sticky players overvalue made hands -- a station calls down with
        // any pair and bets it, which is why the bonus lifts both calls and
        // bets where a raw stickiness bias only lifts calls. Symmetric about
        // neutral: a non-sticky player undervalues the same hands.
        if (PARAMS.handOvervalue !== 0) {
          const made = categoryOf(evaluate(v.holeCards.concat(v.board))) >= 1
          if (made) {
            equity = Math.max(0, Math.min(1,
              equity + PARAMS.handOvervalue * (t.stickiness - 0.5)))
          }
        }
        base = actionValues(v, equity, opponents, t.sizing)
      }
      const biased = applyTraits(base, t, equity, v.pot, player.tiltLevel, preflop)
      const pick = choose(biased, proficiency, Math.max(v.bigBlind, v.pot), rng,
        preflop ? PARAMS.temperaturePre : PARAMS.temperature)

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
// Every entry also carries stickinessScale, a per-archetype multiplier on the
// global stickiness pull. One global pull cannot serve both the tag and the
// calling station: the trait saturates at 0.98, which caps how far the bias
// reaches, and a capped bias has no gradient left to fit with.
const ARCHETYPES = {
  nit: { aggression: 0.30, looseness: 0.12, stickiness: 0.35, bluffiness: 0.10, sizing: 0.5, stickinessScale: 1 },
  rock: { aggression: 0.40, looseness: 0.25, stickiness: 0.40, bluffiness: 0.20, sizing: 0.5, stickinessScale: 1 },
  tag: { aggression: 0.75, looseness: 0.35, stickiness: 0.35, bluffiness: 0.55, sizing: 0.65, stickinessScale: 1 },
  lag: { aggression: 0.85, looseness: 0.65, stickiness: 0.40, bluffiness: 0.75, sizing: 0.75, stickinessScale: 1 },
  station: { aggression: 0.15, looseness: 0.80, stickiness: 0.92, bluffiness: 0.10, sizing: 0.4, stickinessScale: 1 },
  maniac: { aggression: 0.95, looseness: 0.90, stickiness: 0.50, bluffiness: 0.85, sizing: 0.9, stickinessScale: 1 },
  bluffer: { aggression: 0.70, looseness: 0.55, stickiness: 0.30, bluffiness: 0.95, sizing: 0.8, stickinessScale: 1 },
  // Cocky is the interesting one: aggressive, and it tilts, so its personality
  // is not constant across a session even though its parameters are.
  cocky: { aggression: 0.80, looseness: 0.60, stickiness: 0.45, bluffiness: 0.70, sizing: 0.8, tilt: 0.6, stickinessScale: 1 }
}

// The trait values above are starting guesses, not measurements. They and the
// four `pull` scales are the same degree of freedom -- doubling a pull and
// halving every trait's distance from neutral produces an identical player --
// so fitting both at once is over-parameterised, and a search asked to do it
// simply runs the pulls to their bounds. The pulls are therefore held fixed
// and the traits are what gets fitted, by texas-calibrate.js, against the
// behaviour each named type is supposed to exhibit.
// The one fitted per-archetype exception is `stickinessScale`, which
// multiplies the stickiness pull for that type alone. It escapes the
// over-parameterisation argument precisely because the trait is bounded on
// [0.02, 0.98]: the calling station saturates it, and once saturated the
// trait has nothing left to give -- only the scale can reach further.
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
    sawFlop: 0, showdowns: 0, won: 0, chips: 0,
    threeBetOpp: 0, threeBet: 0, foldTo3betOpp: 0, foldTo3bet: 0,
    stealOpp: 0, foldToSteal: 0, premiumOpp: 0, premiumFold: 0
  })
  const stats = Array.from({ length: numPlayers }, blank)

  // The preflop response statistics, each counted over its own opportunities
  // the way a tracker counts them. These exist because VPIP and PFR say how
  // often a player acts and nothing about with what -- a field that folded
  // aces to every raise fitted all four of the original statistics. These
  // four say what happens when somebody raises:
  //
  //   3-bet         re-raised a single raise, when they had the chance
  //   fold to 3-bet opened, got re-raised, folded
  //   fold to steal in the big blind against a lone open from CO/BTN/SB
  //   premium fold  folded AA or KK to a bet -- which real players do not do
  const recordResponses = (result) => {
    const n = numPlayers
    const once = new Set()
    let raises = 0
    let opener = -1
    let calledOpen = false
    let limped = false
    for (const a of result.actions) {
      if (a.street !== 'preflop') break
      const s = a.seat
      const st = stats[s]
      if (raises === 1 && s !== opener && !once.has('3b' + s)) {
        once.add('3b' + s)
        st.threeBetOpp++
        if (a.type === 'raise') st.threeBet++
      }
      if (raises === 2 && s === opener && !once.has('f3' + s)) {
        once.add('f3' + s)
        st.foldTo3betOpp++
        if (a.type === 'fold') st.foldTo3bet++
      }
      const pos = (s - result.button + n) % n
      const openerPos = (opener - result.button + n) % n
      if (raises === 1 && !calledOpen && !limped && pos === 2 &&
        (openerPos === 0 || openerPos === 1 || openerPos === n - 1)) {
        st.stealOpp++
        if (a.type === 'fold') st.foldToSteal++
      }
      const hole = result.holeCards[s]
      if (a.toCall > 0 && hole && (hole[0] >> 2) === (hole[1] >> 2) && (hole[0] >> 2) >= 11) {
        st.premiumOpp++
        if (a.type === 'fold') st.premiumFold++
      }
      if (a.type === 'raise') {
        raises++
        if (raises === 1) opener = s
      } else if (a.type === 'call' && raises === 1) {
        calledOpen = true
      } else if (a.type === 'call' && raises === 0) {
        limped = true
      }
    }
  }

  return {
    stats,
    record: (result) => {
      recordResponses(result)
      const voluntary = new Array(numPlayers).fill(false)
      const raisedPre = new Array(numPlayers).fill(false)
      const foldedPre = new Array(numPlayers).fill(false)

      for (const a of result.actions) {
        const s = a.seat
        const preflop = a.street === 'preflop'
        // AF is a postflop statistic: bets and raises over calls from the flop
        // on. Counting preflop actions too welded it to PFR -- a LAG that opened
        // fewer hands appeared to bet less after the flop, so the fit could not
        // tighten its preflop game without being told it had turned passive.
        if (a.type === 'raise') {
          if (!preflop) stats[s].bets++
          if (preflop) {
            raisedPre[s] = true
            voluntary[s] = true
          }
        } else if (a.type === 'call') {
          if (!preflop) stats[s].calls++
          if (preflop) voluntary[s] = true
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
      bb100: st.hands ? (st.chips / bigBlind / st.hands) * 100 : 0,
      threeBet: st.threeBetOpp ? (st.threeBet / st.threeBetOpp) * 100 : 0,
      foldTo3bet: st.foldTo3betOpp ? (st.foldTo3bet / st.foldTo3betOpp) * 100 : 0,
      foldToSteal: st.stealOpp ? (st.foldToSteal / st.stealOpp) * 100 : 0,
      premiumFold: st.premiumOpp ? (st.premiumFold / st.premiumOpp) * 100 : 0
    }))
  }
}

module.exports = {
  makePlayer, archetype, ARCHETYPES, DEFAULT_TRAITS, makeTracker, raiserRange,
  actionValues, applyTraits, choose, PARAMS, setParams, setArchetype
}
