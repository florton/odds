# odds

Card-game probability worked out from first principles, in plain Node with no
dependencies. A blackjack strategy solver, a simulator that measures what a strategy is
actually worth, a Texas Hold'em engine and measurement harness, and a Monty Hall sanity
check.

```bash
node odds.js                    # solve the strategy tables    -> output.json
node blackjack.js               # grade the real basic strategy over 10,000,000 hands
node blackjack.js output.json   # grade a table you just solved
node blackjack.js basic.json 1 0.5   # single deck, cut half way down
node blackjack.js basic.json 6 0.75 count   # count the shoe and spread the bet
node texas.js                   # deal a full Hold'em hand, betting rounds and all
node texas.js 100000            # measure a lineup, in bb/100 with error bars
node texas.js --players         # a field of personalities, and the stats it produces
node texas.js --test            # Hold'em engine invariants
node texas-eval.js --enumerate  # check the hand evaluator on all C(52,7) hands
node texas-equity.js            # what the players know about hand strength
node texas-equity.js --build    # regenerate equity.json (~2 min)
node texas-calibrate.js         # fit the player model to real population stats
node texas-calibrate.js --check # report the current fit without changing it
node texas-calibrate.js --noise # the noise floor of the calibration objective
node deal.js                    # Monty Hall, 10,000,000 runs
```

## Results

The solver's table agrees with published basic strategy on **268 of 270 cells (99.3%)**,
and the two are indistinguishable at the table:

| Strategy | Edge over 10M hands, 6-deck shoe |
|---|---|
| Published basic strategy | **-0.00960** (±0.00033) |
| Solved by `odds.js` | **-0.00943** (±0.00033) |

The solved table grades 0.00017 *better*, which is half a standard error. The honest
reading of that is "the same table", not "a better one". Both measured with splits
disabled, since the solver doesn't produce a splits table — see "What's left" below.

### Deck count

Dealing from a real shoe rather than with replacement reproduces the known deck effect,
measured here at 75% penetration:

| Decks | Edge |
|---|---|
| 1 | -0.00545 |
| 2 | -0.00786 |
| 4 | -0.00909 |
| 6 | -0.00909 |
| 8 | -0.00993 |
| infinite (with replacement) | -0.00973 |

Monotonic, flattening out, and converging on the with-replacement figure — which is what a
finite shoe should do. The spread from one deck to eight is **0.0045**, against a
real-world figure near 0.005. Most of the effect is spent by two decks.

The gap between eight decks and infinite is far smaller than the gap between one and two,
and at ~0.0003 it sits *below* this simulator's noise floor (see below) — it is visible as
a direction, not as a resolved measurement.

The 6-deck row here and the basic-strategy row in **Results** are independent runs of the
identical configuration, and they came out 0.0005 apart. That disagreement is not a mistake
in either one; it is the noise floor, showing up in the document itself.

### Counting the shoe

`count` turns on Hi-Lo with a 1-12 bet spread. **Nothing about how hands are played
changes** — same basic strategy table, same decisions, still no insurance and no count-based
deviations. The only thing that varies is how much money is on the table.

| Shoe | Penetration | Avg bet | Edge per $ | Units per round |
|---|---|---|---|---|
| 6 decks | 50% | 1.34 | -0.00503 | **-0.0067** |
| 6 decks | 75% | 1.74 | +0.00007 | **+0.0002** (±0.0003) |
| 2 decks | 90% | 2.89 | +0.01422 | **+0.0411** |

The outer rows are single 10M-hand runs, far enough from zero that one is enough. The
middle row is the average of **nine**, and it needed them — see below.

The series is really a series in **penetration**, and that is the whole story of the count:
a shallow shoe is dead no matter how well you count it, because the cards you learned about
get shuffled back before you can bet on them. Half a six-deck shoe still loses outright. The
double-deck game cut 90% deep is a different game — 90% is deeper than a casino would ever
cut, which is precisely why they don't.

Two figures are reported because they answer different questions. **Per dollar** is the
bet-weighted edge: whether the money on the table is favoured. **Per round** is that times
the average bet, and it is the one that decides whether the seat is worth sitting in — an
edge you only get to bet a dollar into is not a living.

#### The six-deck game is genuinely too close to call

Flat betting that shoe pays **-0.0096** a round. Counting it pays **+0.0002**. But nine
10M-hand runs of that second number came out:

```
+0.00099  +0.00050  -0.00066  +0.00086  -0.00102
-0.00006  +0.00021  -0.00021  +0.00131
```

The sign changes five times. Mean +0.00021, standard error 0.00026 — **t = 0.8**, which is
no result at all. A bet spread multiplies the variance of the estimate along with the bet,
and the measured per-round standard deviation here is **2.4x** the flat-betting figure, so
90,000,000 hands buys less certainty than 10,000,000 did before. Resolving this at 3 SE
would take about **1.2 billion hands**.

Note carefully what *is* resolved. The difference between flat and counted is 0.0098 units
a round against a combined standard error near 0.0004 — that is a 25 SE result, and the
spread is unquestionably worth about a hundredth of a bet per hand. What is unresolved is
only whether that is quite enough to clear the house edge. **The value of counting is
measured; the sign of the outcome is not.** With no insurance and no playing deviations,
this configuration sits close enough to break-even that the simulator cannot say which side
of it the player is on, and the two rows on either side of it in the table are the ones
doing the actual talking.

### Can basic strategy be beaten?

That was the original question, and it turned out to have two halves.

**Looking for a better table: no.** Basic strategy *is* the EV-maximizing decision for every
(hand, up-card) pair when the remaining deck is unknown. It is the solution to that
optimization problem, so there is nothing above it to find. `odds.js` re-deriving 268 of
the 270 cells from scratch is that claim demonstrated rather than asserted: two independent
routes to the same table, because there is only one.

**Betting differently: yes, where the shoe allows it.** Note what the counted runs above do
*not* do — they never deviate from basic strategy by a single cell. Counting doesn't beat
basic strategy; it beats *flat betting*. Basic strategy is optimal given no information
about the remaining deck, and a real shoe is what hands you that information, which is why
the with-replacement version of this simulator could never have shown any of it. Whether it
is *enough* information is a property of the table, not the player: decisive on double-deck
cut 90% deep, too close to call on six decks at 75%, and worthless at 50%. The other lever,
composition-dependent play (using the specific cards making up your total rather than just
the total), is now representable for the same reason but isn't implemented; it is worth
~0.03%.

Which is also why the evolutionary search in `blackjack.js` was never going to work — it
was looking in the one place with nothing to find, and doing it below its own noise floor
besides. Three runs of the *same* table:

```
-0.01025375     -0.01032     -0.00998075
```

A spread of 0.00034 from identical strategy. Measured properly over six runs, the standard
deviation of the estimate at 10M hands is **0.00033**, which puts the per-hand standard
deviation at **σ ≈ 1.04**. Almost no single-cell mutation is worth more
than that, so the search cannot distinguish a real improvement from a lucky run, and it
accepts noise as progress.

Throwing hands at it barely helps, because resolving a difference `d` at 3 SE needs
`N > (3s/d)^2`:

| Difference to resolve | Hands needed per candidate | Time per candidate |
|---|---|---|
| 0.0005 | ~39,000,000 | ~2 min |
| 0.0001 | ~980,000,000 | ~55 min |
| 0.00005 | ~3,900,000,000 | ~3.7 hours |

Quadratic scaling, times the number of candidates in a generation, and a stricter
threshold still on top because testing thousands of mutations guarantees some clear 3 SE by
luck alone. Brute force loses.

Two better levers, if the search were worth rescuing:

- **Common random numbers.** Grade the baseline and the mutant against the *same* seeded
  shoe. A single-cell mutation only changes hands where that cell actually comes up — a
  few percent at most — and every other hand plays identically and cancels exactly. The
  paired difference then carries a small fraction of the variance of either estimate,
  typically worth a 30–100x reduction in hands needed.
- **Don't simulate at all.** `odds.js` already enumerates outcomes exactly. Scoring a
  complete strategy by the same enumeration gives its EV with *zero* sampling noise, which
  settles the question outright instead of chasing it with more hands. Most of the
  machinery for this already exists.

## Rules modelled

Dealer stands on soft 17, dealer takes a hole card and checks for a natural before play
continues (as a casino does), naturals pay 3:2, late surrender, double on any two cards,
one split with no resplit limit. **Insurance is absent.** For flat betting that costs
nothing — it is never correct without a count, and basic strategy never takes it. Once the
count is switched on it does cost something: insurance at a true count of +3 or better is
the single most valuable count-based deviation there is, and its absence is part of why the
six-deck counted result above lands so close to zero.

Cards come from a real shoe: `NUM_DECKS` decks of 52, Fisher-Yates shuffled, dealt without
replacement, with a cut card at `PENETRATION` of the way down. The cut card ends the shoe
at the end of the round it appears in, never mid-hand. Both are CLI arguments, defaulting
to six decks cut at 75%.

This models a **batch** shuffler, not a continuous one. A CSM returns cards to the shoe
after every round, which would put the game straight back to drawing with replacement.
Penetration is the single biggest lever on what counting is worth, which is why it is a
knob rather than a constant — and the table under "Counting the shoe" is what that knob
does.

## The scale everything is measured on

`compareOutcome` scores a win 1, a **push 0.5** and a loss 0, so `calcOdds` returns a
score `s`, not money. The conversion is exact, pushes included:

```
EV (in bet units) = 2s - 1
```

This matters because the payouts differ per action, and those factors are invisible in
`s`: doubling stakes two units, so `EV_double = 2 * (2*s - 1)`; surrender forfeits half of
one, a flat **-0.5**. Every decision in `odds.js` is made on the EV scale for that reason.

## odds.js — solving the tables

Recursively enumerates every way a hand can finish against every dealer up-card and scores
the result, rather than simulating and counting. Dealer outcome distributions, the
hit/stand tables and hand totals are all memoized, which is what makes a full enumeration
tractable.

Writes `output.json` (hard and soft tables). `basic.png` and `v1.1.png` are earlier
generated tables rendered as grids.

## blackjack.js — measuring the edge

Plays a strategy table hand by hand against the shoe and reports the edge as net units won
per hand. Positional arguments are strategy file, deck count, penetration, `count` to swap
flat betting for Hi-Lo, and hand count. With no arguments it grades `basic.json`, the real
published strategy, over 10,000,000 hands of a six-deck shoe cut at 75%.

Hi-Lo is a running count folded in as each card is dealt, divided by the decks still to be
dealt, feeding a 1-12 bet ramp that stays at the table minimum below a true count of +2.
The count is only ever read between rounds, and by then every card of the finished round has
been dealt regardless — so counting on deal is identical to counting on reveal, hole card
included, and no bet is ever placed with knowledge of a card the player hasn't seen.

Uncommenting `iterate()` runs an evolutionary search that mutates cells, keeps a mutation
only if it beats the baseline over millions of hands, and saves any improvement. It works,
but grading one generation costs a full simulation run, so it is slow enough to be
impractical.

## Bugs found and fixed

Four defects, worth recording because each one hid the next.

**1. Every push was scored as a loss.** `playerTied` was assigned `false` in the branch
that detects equal totals, so pushes fell through to the loss payout. Pushes are 8–9% of
hands, and the measured edge was **-0.0763** — about fifteen times the true figure —
against a strategy table known to be correct. Fixing it alone moved the edge to
**+0.0211**.

**2. Any 21 was paid as a blackjack.** The natural check was `playerTotal === 21`, so a
hand *hit* to 21 collected 3:2, and the bonus was multiplied by the double multiplier.
A natural is 21 on the first two cards only, is never doubled, and doesn't apply to a hand
made after a split. The dealer also had no hole card, so a dealer natural could not be
detected at all. Naturals now settle before any surrender/double/hit decision, which is
also the real order of play. That took the edge to **-0.0103**, in range of the true
~0.005 for these rules.

**3. A solved table could not be graded at all.** `odds.js` writes `{hard, soft}` with no
`splits` key, but the simulator dereferenced `strategy.splits` unconditionally on any pair,
so pointing it at `output.json` threw a `TypeError`. A missing splits map now means "never
split" instead of a crash — which is what made the comparison in **Results** possible for
the first time.

Surrender and double were also being decided by comparing raw `s` values against 0.5.
That is the break-even point where EV is zero, not the point where an action's payout wins:
surrender needs `2s - 1 < -0.5`, i.e. **`s < 0.25`**, and doubling has to carry its `2x`
stake into the comparison instead of being tested as `doubleWinOdds > standWinOdds`. Both
now run on EV.

**4. The solver surrendered eleven cells instead of four.** Stand, hit and double EV were
each averaged over *every* possible dealer second card, including the ones that make a
natural. But the dealer peeks: by the time anyone is asked whether to surrender, a dealer
natural has already been settled and paid. Leaving those automatic losses in the tree drags
stand, hit and double down *together* — against a dealer ace that is 4 of the 13 branches —
while surrender pays a flat -0.5 no matter what the dealer is holding. So the drag pushed
every rival option below the one option it could not touch, and surrender won cells it had
no business winning: six against an ace, one against a ten, including surrendering hard 17
and hard 7.

Conditioning the dealer's outcome tree on "no natural" leaves exactly **15 vs 10, and 16 vs
9, 10 and A** — the published late-surrender table, cell for cell, and nothing else. It also
repaired 11 vs 10, which had been reading as a hit rather than a double because the drag on
a doubled bet is counted twice. Ten disagreements with the published table became two, and
the solved table went from grading 0.003 worse than basic strategy to grading the same.

## What's left

**Two cells still disagree: soft 12 and soft 13 against a dealer 5.** Both are marginal
doubles. Soft 12 is A,A, which a real table resolves as a split long before doubling comes
up, so there is really one cell in question. The likely cause is an order dependency in the
solver: `processPlayerHand` consults the hit/stand tables *while they are still being
filled in*, so a cell solved early can read `undefined` — falsy, i.e. "stand" — for totals
the loop hasn't reached yet. The hardcoded `handTotal < 12 -> always hit` is a patch over
the same hole. Solving totals from 20 downwards would remove the dependency instead of
papering over it.

**Splitting is barely modelled.** Each split hand recursively deals itself a fresh dealer
hand rather than sharing one, and split aces aren't restricted to a single card. Splitting
is worth about 0.007% here against roughly 0.5% in reality, so the split logic is close to
inert. The solver doesn't emit a splits table at all.

**The counter only varies its bet.** A real counter also deviates from basic strategy at
extreme counts — taking insurance at a true count of +3 is the single biggest one, and the
"Illustrious 18" covers the rest. Together they are worth roughly another 0.1–0.2%, and
none of it is here. Everything in the counted results comes from bet sizing alone.

**The solver still enumerates against an infinite deck.** `odds.js` draws from a flat
13-card distribution with replacement, so it solves the game the simulator *used* to deal.
That is the right table for a shoe deep enough not to care, and it is why the solved table
grades within noise of the published one, but it means the solver cannot express
composition-dependent play or a count-adjusted decision even in principle.

## Hold'em — `texas-eval.js`, `texas-engine.js`, `texas.js`

Rebuilt from the single-hand demo that was here before, which could deal and rank hands but
could not measure anything. Four defects in it were structural rather than cosmetic:

**Folded players won pots.** `folded` was local to the betting round and never returned, so
the showdown scored every hand at the table whether it had been folded or not. A player
could fold the flop and win on the river.

**There were no blinds.** If folding is free, folding everything is a break-even strategy
and it beats every losing one. Blinds are what make the game a game.

**Kickers did not exist.** The evaluator returned `[category, oneValue]`, which is not an
ordering: two pair compared only the higher pair, a flush only its top card, and AK and AQ
chopped on an ace-high board.

**No all-ins and no side pots**, so a short stack calling a big bet either won chips nobody
had put in or lost chips it never owed.

### texas-eval.js — hand ranking

Packs the category and all five ranks into one integer, so comparing two hands is a single
integer comparison with the kickers already in it. No combination enumeration and no
allocation, which is what makes millions of hands per run tractable.

`node texas-eval.js` runs 40 unit checks; `--enumerate` scores **all 133,784,560 seven-card
hands** and matches the published category frequencies to four decimal places on every
category. That is the same enumerate-don't-sample approach `odds.js` takes, and it is a
proof rather than an estimate.

### texas-engine.js — the table

Blinds and button (reversed heads-up), correct action order, min-raise rules including the
short all-in that does not reopen betting, side pots built in layers, uncalled bets
returned, odd chips to the first seat left of the button, and rake with a cap and
no-flop-no-drop.

Two things in it are there for what comes next rather than for playing a hand:

- **The deal is seeded and replayable.** A pre-shuffled deck can be handed in, which is what
  makes it possible to play the same cards against two different strategies.
- **Strategies see a view, never the table.** `act(view)` is handed that seat's own cards
  and the public betting record, and nothing else. It is structurally impossible to read an
  opponent's hole cards — or any label describing what kind of opponent it is.

### texas.js — measurement

Reports **bb/100 with a standard error**, because the lesson from the blackjack search is
that a win rate without one is not a measurement.

`compare(a, b, field)` sits two candidates in the same seat, against the same opponents, on
the same deck, and differences the results hand by hand. Hands where the two would have
played identically cancel to exactly zero and contribute no noise, so only genuine
disagreements cost anything. This is the common random numbers idea from the blackjack
post-mortem, finally implemented.

How much it is worth depends entirely on how often the change changes a hand:

| Change | Hands it altered | SE unpaired | SE paired | Reduction |
|---|---|---|---|---|
| Postflop calling threshold | 0.11% | 63.69 | 2.14 | **29.7x** |
| Preflop calling range | 39.63% | 83.05 | 54.04 | **1.5x** |

Which is the useful lesson for iterating: **small surgical changes are cheap to evaluate,
sweeping ones are not.** A strategy compared against itself differences to exactly zero with
no error bar at all, which is the check that the pairing is real.

`--test` verifies the engine on 20,000 random hands with random stacks — chips in equals
chips out plus rake, no folded player ever wins, no stack goes negative, every raise is a
full raise or an all-in — and 19,703 of those hands built side pots, so the side-pot code is
genuinely exercised rather than nominally present.

### texas-equity.js — how strong is my hand

Rolling out equity at every decision is both expensive (measured at about a hundredfold)
and wrong as a model — nobody at a table runs Monte Carlo in their head. So the split is
between what a player has genuinely internalised, computed exactly, and what they work out
at the table, approximated with the shortcuts they actually use:

- **Preflop** all 169 starting hands are solved against 1–8 opponents and cached, because a
  competent player really does know these. The table reproduces the published figures: AA
  85.2% heads up, KK 82.7%, QQ 80.1%, AKs 67.2%, AKo 65.6%, and AA 49.0% six-handed.
- **Postflop** hand strength is a percentile read off the **exact** distribution of all
  133,784,560 seven-card hands (4,824 distinct values), and draws are priced with the 2×/4×
  rule that every player at every level uses.

That makes proficiency mean something sharper than noise on a perfect answer: a weak player
**miscounts their outs, misprices a multiway pot, and overvalues their made hand**. The
ceiling is a good human rather than a solver, which is the right ceiling for a cash game.

### texas-players.js — personality and proficiency

Two dials, deliberately independent:

**Personality** is what a player wants to do — it biases the chip value of each action.
Aggression makes betting look better, stickiness makes calling look better, bluffiness makes
betting look better *specifically when the hand is weak*.

**Proficiency** is how well they do it, and it acts in two separate places: how accurate
their read is, and how reliably they pick the action they themselves rate highest (a softmax
temperature).

Keeping them separate is the point. Raising proficiency does not turn an aggressive player
passive — it turns a *wild* aggressive player into a *disciplined* one. The same LAG
archetype at three proficiencies, 25,000 hands:

| LAG at | VPIP | PFR | AF | WTSD | bb/100 |
|---|---|---|---|---|---|
| 0.15 | 67.1 | 46.7 | 1.36 | 17.6 | −374 |
| 0.50 | 63.3 | 44.4 | 1.48 | 20.5 | −78 |
| 0.90 | 41.6 | 34.0 | 3.66 | 25.5 | +961 |

Which also answers a question worth not guessing at: for a fixed personality, **higher
proficiency narrows the range and raises the aggression factor.** Range width is not a
parameter here — it falls out of the traits and the proficiency and is *measured*
afterwards, because asserting it would beg the question the simulation exists to answer.

Nothing a strategy under test can see reveals which archetype it is facing. Only the betting
record.

### Two modelling errors worth recording

Both were found by measuring the field rather than by reading the code, and both are the
same mistake in different clothes: **pricing an action off unconditional equity.**

**A raise got more attractive the more it had been called.** Fold equity was a term
`foldsOut × pot`, and since every raise grows the pot, each raise looked better than the
last. The field settled into an unbounded re-raise war — **15.4 preflop raises per hand**,
ending 91% of hands heads-up and all-in before the flop. Fold equity now decays with how
committed the opponents already are *and* with how many times the pot has already been
raised, read off the betting history — which is where a real player gets it. Preflop raises
fell to 1.56 per hand and the showdown rate from 97% to 63%.

**Being called is bad news.** Equity is measured against random hands, but somebody putting
chips in is not holding a random hand, and the bigger the bet the less random it is. Calls
and raises are now shaded by the price being laid.

### texas-calibrate.js — fitting the model to real players

None of the constants in the player model are derivable. How much fold equity a half-pot bet
really has, how far to discount a call for the news that somebody bet into you, how random an
unskilled player is — these are empirical facts about people, and the only honest way to set
them is to fit them until the simulated field reproduces behaviour measured on real ones.

**This is the search blackjack.js couldn't run.** That one graded candidates on win rate and
drowned: σ ≈ 1.04 per hand meant resolving a 0.0001 edge took a billion hands, and it accepted
noise as progress for as long as it ran. Calibration escapes that by not fitting to a win rate
at all. Fitting to *behaviour* is three orders of magnitude cheaper:

| Statistic | sd over 8,000 hands | Target |
|---|---|---|
| VPIP | 0.066 | 22 |
| PFR | 0.098 | 18 |
| AF | 0.004 | 2.5 |
| endsPreflop | 0.403 | 60 |

against a standard error near **20** for bb/100 over the same hands. Every candidate is also
graded on the same seeded deals, so two parameter sets that behave identically score
identically to the bit — the common random numbers idea again, and the reason 384 evaluations
suffice where ten million hands per candidate did not.

The fit runs in two stages, which is possible because of an exact property of the model:
**with neutral traits every personality term multiplies by zero.** So a homogeneous table of
neutral players measures the value model alone, with the trait scales unable to affect it
even in principle. Stage 1 fits the value model there; stage 2 fits the archetypes.

A table of regulars now reproduces **every** statistic it is graded on:

| | Uncalibrated | Fitted | Target |
|---|---|---|---|
| VPIP | 39.3 | **23.9** | 22 |
| PFR | 17.3 | **16.4** | 18 |
| AF | 1.1 | **2.6** | 2.5 |
| WTSD | 89.2 | **26.5** | 26 |
| Hands ending preflop | 13.0 | **60.2** | 60 |

and the table-level showdown rate lands at **25.9%** against a real 25–30%, having been
between 65% and 92% in every run before it. **No parameter rests on a bound**, so this is a
converged fit rather than a constrained one.

The named types are partly there. Nit and TAG hit their marks; the looser three are still
too loose:

| Type | VPIP | PFR | AF | WTSD |
|---|---|---|---|---|
| nit | **13.3** / 13 | **9.5** / 10 | **2.0** / 2.2 | 17.7 / 24 |
| tag | **22.6** / 22 | 14.7 / 19 | **2.9** / 2.6 | **25.8** / 26 |
| lag | 51.8 / 32 | 34.1 / 25 | 2.6 / 3.2 | **30.6** / 29 |
| station | 61.7 / 45 | 11.3 / 6 | **0.3** / 0.6 | 19.4 / 42 |
| maniac | 71.3 / 62 | 42.5 / 38 | 1.6 / 2.4 | 24.4 / 36 |

### What a pinned parameter was telling us

`callShade` sat on its bound across three separate fits. That turned out to mean the model
was missing a distinction, not that the constant was too small: **one number was being asked
to price two different pieces of news.** A preflop raise is a narrow, honest range — almost
nobody opens trash from early position — so it should be believed. A postflop bet is a much
weaker signal, since continuation bets are made with most of a range whether they connected
or not. Fitting one constant, the search drove it high enough to make preflop tight, and that
same shade then folded every flop, which is exactly why showdowns were reached on 15.8% of
hands against a real 26%.

Split in two, `callShadePre` fitted to **0.487** and `callShadePost` to **0.275** — neither
anywhere near a bound. The pin was a symptom of a missing term, as the bound check exists to
suggest.

Two more of the same kind:

**Equity realisation is a forecast, and was being charged twice.** It prices what will happen
on the streets still to come, so it belongs preflop; once those streets arrive the
disadvantage is already being paid in the action order itself. Applying it every street folded
so many flops that showdowns fell to 6%. Given a separate postflop weight to fit, the search
set it to **0.042** — essentially zero, independently confirming the argument.

**`looseness` and `stickiness` had to be separated by street**, which is what their names
always meant: looseness is playing too many hands, stickiness is refusing to release the ones
you played. Applied together everywhere they were welded, so the only calling station the
model could build also limped every hand. Separated — and once the station's targets included
the WTSD that actually defines one — its showdown rate went from 20.5 to **37.6** against a
target of 42.

### The bug that mattered most was in the measurement

`wtsd` divided showdowns by **every hand dealt**. The published statistic is "Went To
ShowDown *when Saw Flop*" — the denominator is hands that reached a flop. A player who enters
22% of hands cannot show down 26% of them, so **the target was unreachable by construction**,
and five consecutive calibration runs duly failed to move it however the model changed.

Worse than not moving, it pointed the wrong way. Read as 17 against 26 it said the players
were folding too much after the flop, and two rounds of work went into loosening them.
Measured correctly the truth was the reverse: **WTSD was 89.2%**, players facing a flop bet
folded **10.2%** of the time against a real 50–60%, and there were 4.6 raises per flop.
Nothing was ever won without a showdown, because nobody could be made to let go.

The lesson is the cheap one to state and the expensive one to learn: a wrong statistic is
worse than a missing one, because a missing one is silent and a wrong one gives instructions.

Two levers fixed it. `callShadePostBase` is a flat discount on any postflop call — the
price-scaled term alone cannot do the job, since a 60%-pot bet has a price of only 0.375, so
even a maximal coefficient leaves a hand that beats half the field calling comfortably. But a
bet is bad news whatever its size. `futureCost` charges a call for the streets still to come,
since calling a flop bet buys a turn that has to be paid for again; it turned out to be the
weaker of the two, which is worth knowing.

### A search bug worth recording

Stage 1 was quitting after two passes with two parameters never moved from their defaults,
landing a fit measurably worse than an earlier run had reached. Fixed-size steps stop at the
first point where no single coarse move helps, which is not a minimum — it is the resolution
running out. Shrinking the step instead of halting took stage 1 from 63 evaluations and error
0.091 to 397 evaluations and error **0.036**.

The same change applied to stage 2 made it slightly *worse* — 0.0489 against 0.0419 — because
coordinate descent is greedy and a different step schedule drops it into a different local
optimum. More search is not automatically a better fit, and the stage-2 objective has several
optima within about 15% of each other. Stage 2 now runs from three displaced starts and keeps
the best, reporting the spread between them so the run says for itself how much to trust the
answer.

**The stages have to alternate.** Stage 2 fits the archetype traits against whatever the trait
scales currently are, and stage 3 then moves those scales, invalidating the traits it was just
handed. Run once each, it pushed `pullLooseness` from 0.5 to 1.21 and left the LAG — whose
traits had been fitted for 0.5 — playing 59.6% of hands against a target of 32. Cycling them
took the archetype error from **0.405 to 0.159 to 0.127**.

Neither stage can disturb the table of regulars, because both move only quantities multiplied
by a trait's distance from neutral, and the regulars sit at neutral. The stage 1 fit is
structurally protected from everything that follows it — the same zero-multiplication property
that made splitting the fit possible in the first place.

### Three things the calibration found

**The model had no concept of position.** Every seat priced a hand identically, so the small
blind — getting 1-to-call into a 3-chip pot — limped anything clearing the raw pot odds. Real
players fold most of those despite the price, because the price is not the whole cost: they
act first on every later street. Equity realisation by distance from the button is now in the
model, and it fitted to 0.46 — a large effect, and the single change that moved hands ending
preflop from 13% to 36%.

**The trait scales and the archetype traits are the same degree of freedom.** Doubling a pull
and halving every trait's distance from neutral gives back an identical player, so fitting
both is over-parameterised — and a search asked to do it exhausts the cheaper knob, which is
what pinned three parameters to their bounds across two runs. The pulls are now held fixed and
the traits are what gets fitted. Stage-2 error fell from 0.42 to 0.077.

**Averaging one error across five archetypes lets the search trade them off.** It bought an
accurate nit by driving the calling station to 85% VPIP. Each type is now graded only against
its own targets.

A parameter resting on a bound is reported as `AT BOUND`, because that is a *constrained* fit
rather than a converged one, and it usually means the model is missing a term rather than that
a constant is wrong. That is how the position gap surfaced.

### What's left

**Three of the five named types are still too loose.** The LAG plays 51.8% of hands against a
target of 32, and the calling station reaches showdown on 19.4% of its flops against 42 — the
one stat that most defines it. Its stickiness is fitted to 0.98, hard against the ceiling, and
the fit still chose a *low* `pullStickiness` of 0.39, because raising it to help the station
would push the TAG and the nit off their marks.

That is the real limit now: **one global scale per trait has to serve five types whose needs
conflict.** Per-archetype scales would resolve it, at the cost of five times the parameters —
or the traits themselves need to be more expressive than a single number per axis.

**Nothing above is a claim about poker yet.** The field reproduces the behaviour it was fitted
to, which is exactly as much as can be said: reproducing VPIP, PFR, AF and showdown rates is
evidence the players act like players, not that the win rates between them are right. Those
have not been validated against anything.

**No opponent modelling.** The view carries the full action history and `observe()` is called
after every hand, so a strategy *could* build a read. Nothing does yet.

**No scenario sweep and no distillation.** `playHand` returns a complete hand record — every
action with pot size, price and stack — and nothing reads it except the chip deltas. Turning
those records into win rates by circumstance is the original goal and has not been started.


## deal.js — Monty Hall

Ten million runs of stay-vs-switch, as a check that the harness reports what theory
predicts. It does: **switching wins 66.65%**, staying 33.35%.
