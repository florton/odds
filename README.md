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

<!-- HOLDEM-HIGHLIGHT -->

## Quick start

Requires Node.js 14 or later. Nothing to install.

```bash
node odds.js                       # solve blackjack strategy tables   -> output.json
node blackjack.js                  # grade published basic strategy over 10M hands
node blackjack.js output.json      # grade the table you just solved
node blackjack.js basic.json 6 0.75 count   # count a 6-deck shoe cut at 75%

node texas.js                      # deal and print one Hold'em hand
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

<!-- CALIBRATION-RESULTS -->

### Who wins

<!-- WIN-RATE-RESULTS -->

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

<!-- LIMITATIONS -->

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
