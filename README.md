# odds

Blackjack and Texas Hold'em, worked out from first principles and measured with error
bars. Plain Node.js, no dependencies.

The project started with one question, *can blackjack basic strategy be beaten?*, and grew
into a broader one: **how do you measure a strategy honestly when the signal is smaller
than the noise?** Every result below comes with a standard error, and most of the
interesting engineering is about making those errors small enough to say something.

## Highlights

- **A blackjack solver that re-derives published basic strategy** on 268 of 270 cells, by
  exact enumeration rather than simulation. Its table plays within half a standard error
  of the published one over 10M hands.
- **Card counting, measured rather than assumed.** A Hi-Lo bet spread is worth about a
  hundredth of a bet per hand, a 25-standard-error result. Whether that beats the house
  depends on the shoe: decisive on a deep-cut double deck, too close to call on six decks.
- **A Hold'em hand evaluator verified against all 133,784,560 seven-card hands**, matching
  the published category frequencies exactly.
- **A full no-limit engine**: blinds, side pots, min-raise rules and rake, checked for chip
  conservation on 20,000 random hands with random stacks.
- **Poker players fitted to real population statistics.** A personality × skill model
  whose constants are fitted until a simulated table reproduces how real players are
  measured to play.
- **Variance reduction that makes comparisons feasible.** Common random numbers cut
  error bars by up to **29.7x**, and duplicate dealing cancels card luck.
- **A Hold'em field fitted to real population statistics, then asked who wins.**
  Five archetypes whose constants are fitted until the simulated table
  reproduces tracked VPIP/PFR/AF/WTSD; at the fitted table the money is
  nearly even -- two TAGs win, the calling station is a marginal loser -- and
  at fixed style every step of proficiency from 0.25 to 1.0 is worth more
  money than the one before.

## Quick start

Requires Node.js 14 or later. Nothing to install.

```bash
node odds.js                       # solve blackjack strategy tables   -> output.json
node blackjack.js                  # grade published basic strategy over 10M hands
node blackjack.js output.json      # grade the table you just solved
node blackjack.js basic.json 6 0.75 count   # count a 6-deck shoe cut at 75%

node texas.js                      # deal and print one Hold'em hand
node texas.js --watch 5            # watch 5 hands dealt to the fitted personalities
node texas.js --test               # engine invariant checks
node texas-eval.js --enumerate     # verify the evaluator on all 133M seven-card hands
node texas-calibrate.js --check    # how well the players match real statistics
node texas-results.js              # who wins, with error bars   -> results.json

node deal.js                       # Monty Hall, 10M runs
```

## Blackjack

### The solver matches published basic strategy

`odds.js` recursively enumerates every way a hand can finish against every dealer up-card,
and picks each action by expected value. Its table agrees with published basic strategy on
**268 of 270 cells (99.3%)**. Played for real, the two are indistinguishable:

| Strategy | Edge over 10M hands, 6-deck shoe |
|---|---|
| Published basic strategy | **−0.00960** (±0.00033) |
| Solved by `odds.js` | **−0.00943** (±0.00033) |

The solved table grades 0.00017 better, which is half a standard error. The honest reading
is "the same table", not "a better one".

### Deck count

Cards are dealt from a real shoe with a cut card, which reproduces the known effect of
deck count on the house edge (75% penetration):

| Decks | 1 | 2 | 4 | 6 | 8 | infinite |
|---|---|---|---|---|---|---|
| Edge | −0.00545 | −0.00786 | −0.00909 | −0.00909 | −0.00993 | −0.00973 |

The spread from one deck to eight is **0.0045**, against a real-world figure near 0.005,
and it converges on the with-replacement figure as a finite shoe should.

### Card counting

Hi-Lo with a 1–12 bet spread. **No playing decision changes**; only the bet size does.

| Shoe | Penetration | Avg bet | Units won per round |
|---|---|---|---|
| 6 decks | 50% | 1.34 | **−0.0067** |
| 6 decks | 75% | 1.74 | **+0.0002** (±0.0003) |
| 2 decks | 90% | 2.89 | **+0.0411** |

The value of counting is clearly measured. Against flat betting it gains **0.0098 units a
round**, a 25-SE result. The *sign* on six decks at 75% is not measured: nine 10M-hand
runs changed sign five times, and settling it at 3 SE would take about 1.2 billion hands.
Penetration is the real story. A shallow shoe is dead however well it's counted, because
the cards you learned about get shuffled away before you can bet on them.

### Can basic strategy be beaten?

**By a better table: no.** Basic strategy is the EV-maximizing decision for every hand
when the remaining deck is unknown. There is nothing above it to find, and the solver
reaching the same table independently is that claim demonstrated.

**By betting differently: yes, where the shoe allows.** Counting doesn't beat basic
strategy; it beats *flat betting*, using information that only exists in a finite shoe.

That also explains why this project's first approach, an evolutionary search over strategy
tables, never worked. The noise in a 10M-hand estimate (σ ≈ 0.00033) is larger than almost
any single-cell improvement, so the search accepted luck as progress. Resolving a
0.00005 difference would take 3.9 billion hands per candidate. The fix is to avoid
brute-forcing the noise at all, and that idea drives everything in the Hold'em half.

### Rules and conventions

Dealer stands on soft 17 and peeks for blackjack. Naturals pay 3:2. Late surrender, double
on any two cards, splits allowed. No insurance. Cards come from a Fisher–Yates-shuffled
shoe (batch shuffler, not a continuous one) with a cut card at a configurable penetration.

The solver scores a win 1, a push 0.5 and a loss 0, so every decision is converted to
expected value (`EV = 2s − 1`) before comparison. Actions pay differently, so comparing raw
win scores silently compares the wrong quantities, and that exact mistake was one of the
bugs fixed along the way (see the [changelog](CHANGELOG.md)).

## Texas Hold'em

### How it's built

| File | What it does |
|---|---|
| `texas-eval.js` | Ranks any 5–7 card hand into a single comparable integer. Verified on all 133,784,560 seven-card hands. |
| `texas-engine.js` | Plays one no-limit hand: blinds, betting rounds, side pots, rake. Deals are seeded and replayable, and strategies see only what a player at the table could see. |
| `texas-equity.js` | Hand strength the way a player estimates it: exact preflop equities for all 169 starting hands, board-aware strength postflop, outs by the 2×/4× rule. |
| `texas-players.js` | The player model: personality traits × proficiency. |
| `texas-calibrate.js` | Fits the model's constants to real population statistics. |
| `texas-results.js` | The experiments below. |
| `texas.js` | Measurement harness: bb/100 with standard errors, paired comparison, duplicate dealing, engine tests. |

**Personality and skill are separate dials.** Personality biases the value of each action
through five traits: looseness, preflop aggression, postflop aggression, stickiness and
bluffiness. Proficiency controls two separate things: how accurately a player reads their
hand, and how reliably they pick the action they rate best. A weak player isn't a good
player with noise added. They miscount outs, misprice multiway pots and overvalue made
hands, the specific mistakes real weak players make.

### Fitting the players to real statistics

None of the model's constants can be derived. How much a half-pot bet makes people fold is
an empirical fact about people. So the constants are **fitted**, by coordinate descent,
until simulated tables reproduce the standard tracking statistics (VPIP, PFR, AF, WTSD)
quoted for real 6-max cash games.

Fitting to *behaviour* instead of win rate is what makes this search work where the
blackjack one failed. VPIP over 8,000 hands has a standard deviation of 0.07; bb/100 over
the same hands has a standard error near 20. Every candidate is also graded on identical
seeded deals, so two parameter sets that play the same score the same to the bit.

The fit lands close enough to name the types, measured over 8,000-hand samples
on deals the search never optimised against (stable across seeds -- VPIP moves
only ±0.1 between them):

| Type | VPIP | PFR | AF | WTSD |
|---|---|---|---|---|
| nit | 11.7 / 13 | 10.5 / 10 | 2.2 / 2.2 | 23.4 / 24 |
| tag | 24.0 / 22 | 18.2 / 19 | 2.5 / 2.6 | 27.5 / 26 |
| lag | 31.4 / 32 | 24.8 / 25 | 3.0 / 3.2 | 31.4 / 29 |
| station | 49.5 / 45 | 5.8 / 6 | 0.6 / 0.6 | 37.9 / 42 |
| maniac | 67.8 / 62 | 40.0 / 38 | 2.1 / 2.4 | 31.2 / 36 |

*measured / target*

The neutral regulars the value model was fitted on land at 23.9/17.2 VPIP/PFR
against 22/18, aggression 2.5 on 2.5, WTSD 26.0 on 26, and 64% of hands end
before a flop against a real ~60%. The calling station -- the type every
earlier fit failed -- now lands at 49.5/45 with AF on target and WTSD 37.9
against 42, and holds on fresh seeds: 50.3/50.4 VPIP, WTSD 36.6-37.1. What is
left -- station WTSD still 4 short, the maniac 6 VPIP loose -- is said plainly
in Limitations.

### Who wins

300,000 hands per experiment, duplicate-dealt with the lineup rotated so every
player meets every set of cards from every seat. Error bars are clustered on
the deck, and a claim needs three standard errors.

**1. Personality at equal skill.** All six seats at proficiency 0.85, so the
only difference between them is style:

| Player | bb/100 | ± SE |
|---|---|---|
| maniac | +130.1 | 7.8 |
| neutral | −5.1 | 4.9 |
| lag | −13.9 | 5.1 |
| tag | −26.1 | 4.3 |
| nit | −26.6 | 2.0 |
| station | −58.5 | 6.6 |

Loose-aggressive styles win at equal execution and passive ones pay for them;
34.5% of hands reach showdown. The honest caveat: this is what the *fitted*
styles do -- the fit constrained how often they act, not how profitably, and
the fitted maniac is sticky rather than bluffy, which at high proficiency
plays like a strong LAG rather than a lottery player (see Limitations).

**2. Skill at equal personality.** Six neutral players differing only in
proficiency:

| Proficiency | 0.25 | 0.40 | 0.55 | 0.70 | 0.85 | 1.00 |
|---|---|---|---|---|---|---|
| bb/100 | −84.2 | −49.1 | −16.2 | +21.2 | +59.0 | +69.2 |

± ~4.7 each. Monotone at every step, and the best player clearly beats the
worst; one proficiency step is worth roughly 20 bb/100 around the middle of
the ladder.

**3. The realistic table.** The fitted types at the proficiencies they were
fitted at (nit .70, tag .85, lag .64, station .63, maniac .49), no rake:

| Player | bb/100 | ± SE |
|---|---|---|
| tag (2) | +43.0 | 4.4 |
| maniac | +24.6 | 7.0 |
| tag | +18.5 | 4.1 |
| station | −8.3 | 6.1 |
| lag | −35.0 | 5.1 |
| nit | −42.9 | 2.4 |

The same table raked 5% capped at 3bb costs each seat **16.9 bb/100**: tag (2)
+27.0, maniac +16.2, tag +7.9, nit −46.0, lag −47.0, station −59.9. The
earlier version of this table had the station losing −152 bb/100 and the lag
winning +90.8; closing the station's over-folding leak removed the money both
numbers were made of, and the field's edges compress to a few bb/100 around
two winning TAGs.

**4. Where the money comes from.** The button is the most profitable seat
(+136.5 bb/100) and both blinds lose (SB −110.4, BB −80.4); later position
earns more, CO > HJ > UTG; aces are the most profitable starting hand
(+1015 bb/100 when dealt) and the top five are AA KK QQ JJ 99. Everyone loses
from the blinds, and the station loses from every seat, worst of all the small
blind (−123 bb/100).

Six of the ten shape checks pass. The four that fail, reported here and in
Limitations rather than hidden: the top five starting hands are AA KK QQ JJ
99, with 99 vs TT a coin flip (+451 ± 44 against +430 ± 42) and AKs sixth;
the calling station's win rate is negative but does not clear the three-
standard-error bar (−8.3 ± 6.1); the maniac's win rate is genuinely above
zero (+24.6 ± 7.0); and a TAG does not clearly out-earn him, though the TAG
does clearly beat the station (a 26.8 bb/100 gap against 22.1 needed).

## Measuring honestly

A few techniques carry this whole project, and each one is there because an earlier
attempt without it failed:

- **Every estimate has a standard error**, and a difference is only claimed when it clears
  three combined standard errors.
- **Common random numbers.** Two strategies are compared on the *same* cards, in the same
  seat, against the same opponents, and differenced hand by hand. Hands they play
  identically cancel exactly. A change that touches 0.11% of hands is measured with a
  **29.7x** smaller error bar than two independent runs would give.
- **Duplicate dealing.** Each deck is replayed once per seat with the players rotated, so
  everyone gets every set of cards from every position.
- **Clustered error bars.** Rotations of one deck aren't independent, so the deck is the
  sampling unit. Treating hands as independent would make error bars look far tighter than
  they are.
- **Fit to cheap signals.** Behavioural statistics resolve in thousands of hands; win
  rates need millions.
- **Test the measurement, not just the model.** Two of the most expensive bugs here were
  statistics that were named correctly and computed wrongly (WTSD's denominator, and AF
  counting preflop actions). Each sent the search confidently in the wrong direction.

## Limitations

**Hold'em.** The calling station is fitted now, but not for free. It lands at
49.5/45 with WTSD 37.9 against 42, and getting there required the fit to make
it bet: aggression from 0.10 to 0.33, bluffiness from 0.22 to 0.57, and a
steadier hand (skill 0.63, fitted, now above the maniac's 0.49 -- a
WTSD-42 calling station cannot be noisy in this model, because noise folds
hands). A station that bets its made hands stops being a cash source: at the
realistic table it is a marginal loser whose rate (−8.3 ± 6.1) does not clear
the three-standard-error bar the shape checks demand. The WTSD residual
(−4.1) and the price paid for the improvement -- the maniac traded loose,
67.8/62 -- are left in the tables above rather than smoothed over, which is
the honest record of an equal-weight objective. Behavioural targets do not
pin down win rate, either: they constrain how often a type acts, not how
profitably, and the fitted maniac -- sticky rather than bluffy -- wins at
equal skill (+130.1) and at the realistic table (+24.6) where a real one
would bleed. The old LAG figure is the same lesson from the other side:
+90.8 bb/100 was funded by the station's excess folds and collapsed to
−35.0 the moment the leak closed. The traits and pulls are a
coordinate-descent optimum, so the answer depends on the path: two parameters
(maxBias, pullStickiness) sat at values that made further improvement
impossible until lifted off them mid-fit (`node texas-calibrate.js --resume`),
and the maniac overshoot is the latest instance of the same myopia. Each
player has one sizing habit and no concept of balance, adaptation or
exploitation, and the game is cash-only: no tournaments, buy-ins or ICM, so
"stakes" enter only through the fitted constants and the rake settings.

**Blackjack.** Two solver cells still disagree with published strategy (soft 12 and 13 v
5, both marginal doubles). Splits are barely modelled. The counter varies only its bet,
with no insurance or index plays. The solver assumes an infinite deck, so it can't express
composition-dependent play.

## Monty Hall

`deal.js` runs ten million games as a sanity check on the harness: switching wins
**66.65%**, staying 33.35%.

## History

The [changelog](CHANGELOG.md) records how each piece got here, including every bug found
along the way and what it taught.
