# Changelog

Newest first. Figures quoted under each entry are the ones measured at the time of that
change. Later work has moved several of them, and the current numbers live in the
[README](README.md).

The write-ups are kept in full because most of what this project learned, it learned from
a bug. Nearly every entry below was found by measuring something and getting a number that
could not be right.

---

## Unreleased: finishing the Hold'em player model

### The constants were fitted for a different model

The field was too loose -- LAG 51.8 VPIP against a target of 32, station 61.7
against 45, maniac 71.3 against 62 -- and the reason was not any constant but
the file they lived in. `calibration.json` was written on 4 September, before
aggression split by street and before looseness and stickiness moved to their
own streets. Loaded into the new model, looseness values that had covered a
whole game now acted only before the flop, and everyone loose played far too
wide. Nothing was wrong with the search; it had honestly fitted a model that
no longer existed.

Refitting the current model took the objective from 0.25 to 0.023 and the
regulars to 23.9 VPIP / 2.5 AF / 26.0 WTSD against targets of 22 / 2.5 / 26.
The fit is stable across held-out seeds -- VPIP moves ±0.1 between them, and
the noise floor is the same ±0.1, so nothing below survives being re-measured
on fresh deals.

### A capped bias has no gradient

Two parameters pinned at their bounds, and the pins were load-bearing. With
`maxBias` at 1.2 the station's preflop call bias ran into the ceiling -- and a
trait whose bias is capped has zero gradient, so no single-coordinate move can
improve anything. Coordinate descent declares the fit done while the trait is
still unidentifiable. The tell is a trait parked near saturation while its
statistic sits far from target.

The escape is `--resume`, a new mode that continues the stage 2/3 cycles from
the current `calibration.json` without re-running stage 1, and accepts
`param=value` overrides to lift a parameter off its bound first. Lifting
`maxBias` to 2 freed the capped bias so the trait stage could walk it down --
which fixed the maniac. Lifting `pullStickiness` to 0.6 re-organised the whole
calling response and let the search walk `pullLooseness` from 1.96 down to
1.30, which is what finally landed the LAG at 34.2 against 32. Bounds on
`maxBias`, `callShadePre` and `pullLooseness` were widened after the first
refit pinned them; none of the final values rest on a bound.

Final field, measured against deals the search never saw: nit 13.8/13, tag
23.8/22, lag 34.2/32, maniac 59.6/62, and the station at 62.8/45 with WTSD
28.2/42. The station's last two targets fight each other -- playing 45% of
hands and showing down 42% of them asks the value model to accept prices it
was fitted on the regulars to refuse -- and the fit picks one. That is now
said in the README's Limitations instead of being chased further.

### The 300,000-hand results, and a maniac who wins

`results.json` was a 3,000-hand placeholder whose realism checks failed on
noise, and the README's results sections were still comment markers. The full
run (141 seconds) now fills both. The realistic table: lag **+90.8** bb/100,
two TAGs at +47.2 and +19.6, maniac +24.2, nit −29.8, station **−152.0**. A
5% rake capped at 3bb costs each seat 17.1 bb/100 and flips the maniac
negative. Eight of ten shape checks pass: button most profitable, both blinds
losing, position ordering, aces on top, the station clearly a loser.

The two failures are reported rather than hidden. The maniac genuinely wins in
this lineup (+24.2 ± 6.7), and the TAG does not clearly out-earn him. The
fitted maniac is sticky rather than bluffy -- behavioural targets constrain
how often a type acts, not how profitably -- so at the table it plays like a
LAG that started too many hands, not like a lottery player. Fixing that means
fitting to win rate, which is the expensive signal this whole design avoids.

### Watching a hand

`node texas.js --watch [n] [seed]` deals n hands to the fitted lineup
(nit/tag/lag/station/maniac/tag at their fitted proficiencies, 100bb, no rake,
button rotating) and prints every street. Two engine log lines that printed
names unpadded now pad to match the rest, so the fitted names align.

### Six times faster, same answers

Profiling a calibration check showed the hand evaluator taking 75% of all runtime, almost
all of it inside `boardStrength`. That function enumerates all 1,081 hands an opponent
could hold on a flop and evaluates each one. Without a flush, though, a hand's score
depends only on its ranks, and on a fixed board the opponent contributes just two of them:
at most 91 distinct rank pairs. Now each rank pair is evaluated once, and only holdings
that could make a flush are evaluated one by one.

Checked against the old code on 9,000 spots, flush-heavy boards included: **zero
mismatches**. `texas-calibrate.js --check` went from **23s to 3.6s** and printed identical
output.

### The calling station was noisy, not unsticky

The last fit ended with the calling station reaching showdown on 19.4% of flops against
a target of 42. Its stickiness was fitted to 0.98, hard against the ceiling. The obvious
reading was that one global trait scale couldn't serve five types, and the proposed fix
was per-archetype scales, at five times the parameters.

A direct test said otherwise. Played with the *same traits* at proficiency 0.85 instead of
0.35, the station's WTSD went from **19 to 40** and its PFR from **12 to 0.1**. The model
could already express a calling station; it just couldn't make a *low-skill* one. Softmax
temperature rose linearly as proficiency fell, so at 0.35 the station folded flops at
random and raised hands at random. No stickiness scale can fix noise.

Temperature now follows a fitted curve pivoting on the regulars' proficiency (0.85). The
curve changes how erratic weaker and stronger players are and leaves the regulars exactly
where they were. Stage 1's fit is structurally untouched: its error stayed at 0.0033
through 221 evaluations of the refit.

### Aggression split by street

The LAG was playing 51.8% of hands against a target of 32, and it wasn't a looseness
problem. Cutting its looseness from 0.65 to 0.02 only moved VPIP to 35.8. PFR stayed at
35.5, so it was raising nearly every hand it played, and AF climbed to 21.8. Lowering
aggression to fix PFR dragged its postflop AF down to 1.0 with it.

It was the same welding that `looseness` and `stickiness` once had, and the same fix.
`preflopAggression` is now its own trait. It falls back to `aggression` when not given, so
unfitted types behave exactly as before. The four traits now map one-to-one onto the four
statistics being fitted:

| Trait | Statistic it drives |
|---|---|
| `looseness` | VPIP, flat calls before the flop |
| `preflopAggression` | PFR |
| `aggression` | AF, betting after the flop |
| `stickiness` | WTSD |

That costs 5 parameters where per-archetype scales would have cost 20.

### AF was measured over the wrong streets

The new trait worked in isolation: `preflopAggression` from 0.73 to 0.61 took the LAG's PFR
from 33.6 to 21.8. But the same test showed its AF falling from 2.56 to 1.82, and a preflop
trait has no business moving a postflop statistic.

The tracker was counting preflop raises and calls into AF. Conventionally AF is postflop
only, and the 2.5 target is a postflop figure. As measured, it rewarded opening more
hands, so any move that fixed the LAG's preflop game looked like it broke its postflop
one. The first refit with the new trait stalled on exactly that: no single move improved
the error on its first pass. It was stopped and restarted once AF counted only the flop
onwards.

Measured correctly, the previous fit was nowhere near its AF targets. The table of regulars
"fitted to 2.6" was really at **5.1**, the TAG at **9.9** and the LAG at **9.1**. The field
was betting after the flop at two to four times a real rate, and folding to those bets
often enough to make it pay. Averaging preflop flat calls into the statistic had hidden
all of it.

It is the WTSD lesson again, one statistic later. The number was named correctly and
computed as something else, so it gave the search wrong instructions.

### `texas-results.js`: who actually wins

This is the first file that asks the calibrated field a question instead of fitting it. It
runs four experiments, all dealt in duplicate with error bars clustered on the deck (see
the README), and checks the output against orderings known from real tracked games.

---

## 2026-09-04: Personality types and calibration

`texas-players.js` and `texas-calibrate.js`.

### The player model

Two independent dials. **Personality** biases the chip value of each action: aggression,
looseness, stickiness, bluffiness. **Proficiency** sets how accurate a player's read is
and how reliably they pick the action they rate highest. Raising proficiency turns a wild
aggressive player into a disciplined one rather than a passive one. The LAG archetype at
three proficiencies, 25,000 hands:

| LAG at | VPIP | PFR | AF | WTSD | bb/100 |
|---|---|---|---|---|---|
| 0.15 | 67.1 | 46.7 | 1.36 | 17.6 | −374 |
| 0.50 | 63.3 | 44.4 | 1.48 | 20.5 | −78 |
| 0.90 | 41.6 | 34.0 | 3.66 | 25.5 | +961 |

### Fitting it to real players

None of the model's constants are derivable. How much fold equity a half-pot bet has, or
how far to discount a call because somebody bet into you, are facts about people. They
were fitted until a simulated table reproduces the standard tracking statistics.

This is the search `blackjack.js` couldn't run. Grading on win rate drowns in variance, but
behaviour is about three orders of magnitude cheaper to measure:

| Statistic | sd over 8,000 hands | Target |
|---|---|---|
| VPIP | 0.066 | 22 |
| PFR | 0.098 | 18 |
| AF | 0.004 | 2.5 |
| endsPreflop | 0.403 | 60 |

Compare a standard error near **20** for bb/100 over the same hands. Every candidate is
also graded on the same seeded deals, so identical behaviour scores identically to the
bit.

The fit is staged around an exact property of the model: with neutral traits, every
personality term multiplies by zero. A table of neutral regulars therefore fits the value
model alone (stage 1). Archetype traits (stage 2) and trait scales (stage 3) are fitted
afterwards, and neither can disturb stage 1.

A table of regulars reproduced every statistic it was graded on:

| | Uncalibrated | Fitted | Target |
|---|---|---|---|
| VPIP | 39.3 | **23.9** | 22 |
| PFR | 17.3 | **16.4** | 18 |
| AF | 1.1 | **2.6** | 2.5 |
| WTSD | 89.2 | **26.5** | 26 |
| Hands ending preflop | 13.0 | **60.2** | 60 |

The named types were only partly there: nit and TAG on target, the looser three too loose.

| Type | VPIP | PFR | AF | WTSD |
|---|---|---|---|---|
| nit | 13.3 / 13 | 9.5 / 10 | 2.0 / 2.2 | 17.7 / 24 |
| tag | 22.6 / 22 | 14.7 / 19 | 2.9 / 2.6 | 25.8 / 26 |
| lag | 51.8 / 32 | 34.1 / 25 | 2.6 / 3.2 | 30.6 / 29 |
| station | 61.7 / 45 | 11.3 / 6 | 0.3 / 0.6 | 19.4 / 42 |
| maniac | 71.3 / 62 | 42.5 / 38 | 1.6 / 2.4 | 24.4 / 36 |

### The bug that mattered most was in the measurement

`wtsd` divided showdowns by **every hand dealt**. The published statistic is "went to
showdown *when saw flop*". A player who enters 22% of hands can't show down 26% of them,
so the target was unreachable by construction, and five calibration runs failed to move
it.

Worse, it pointed the wrong way. Read as 17 against 26, it said players folded too much
after the flop, and two rounds of work went into loosening them. Measured correctly, WTSD
was **89.2%**. Players facing a flop bet folded **10.2%** of the time against a real 50–60%,
and there were 4.6 raises per flop. A wrong statistic is worse than a missing one: a
missing one is silent, and a wrong one gives instructions.

Two levers fixed it:

- **`callShadePostBase`** is a flat discount on any postflop call, because a bet is bad
  news whatever its size. The price-scaled discount alone couldn't do it: a 60%-pot bet has
  a price of only 0.375.
- **`futureCost`** charges a call for the streets still to come.

### What a pinned parameter was telling us

`callShade` sat on its bound across three fits. One number was being asked to price two
different pieces of news. A preflop raise is a narrow, honest range, while a postflop bet
is a weak signal, since continuation bets are made with most of a range. Split in two, it
fitted to **0.487** (pre) and **0.275** (post), neither near a bound.

Two more of the same kind:

- **Equity realisation was being charged twice.** It forecasts the streets to come, so it
  belongs preflop. Applied on every street, it folded so many flops that showdowns fell to
  6%. Given a separate postflop weight, the fit set it to **0.042**.
- **`looseness` and `stickiness` were welded together.** Applied on every street, the only
  calling station the model could build limped every hand. Split by street, the station's
  showdown rate went from 20.5 to **37.6**.

### Three things the calibration found

- **The model had no concept of position.** The small blind limped anything clearing raw
  pot odds. Equity realisation by distance from the button fitted to 0.46, and it moved
  hands ending preflop from 13% to 36%.
- **Trait scales and archetype traits are the same degree of freedom.** Doubling a pull
  and halving every trait's distance from neutral gives an identical player. Fitting both
  pinned three parameters to their bounds. With pulls held fixed, stage 2 error fell from
  0.42 to 0.077.
- **Averaging one error across five archetypes let the search trade them off.** It bought
  an accurate nit by driving the station to 85% VPIP. Each type is now graded only against
  its own targets.

A parameter resting on a bound is reported `AT BOUND`. That marks a constrained fit rather
than a converged one, and usually a missing term. That is how the position gap surfaced.

### Search bugs

- **Stage 1 quit after two passes** with two parameters never moved. Fixed-size steps stop
  where no coarse move helps, which is not a minimum. Shrinking the step instead took
  stage 1 from error 0.091 to **0.036**.
- **Coordinate descent is greedy.** The same change made stage 2 slightly worse (0.0489
  against 0.0419) by landing it in a different local optimum. Stage 2 now runs from three
  displaced starts and reports the spread.
- **Stages 2 and 3 have to alternate.** Run once each, stage 3 pushed `pullLooseness` from
  0.5 to 1.21 and left the LAG playing 59.6% of hands. Cycling took archetype error from
  **0.405 to 0.159 to 0.127**.

---

## 2026-09-02 – 09-03: Texas Hold'em rebuilt

`texas-eval.js`, `texas-engine.js`, `texas.js`, `texas-equity.js`. Rebuilt from the
single-hand demo, which could deal and rank hands but not measure anything.

### Four structural defects in the old demo

- **Folded players won pots.** `folded` was local to the betting round, so the showdown
  scored every hand at the table.
- **There were no blinds.** If folding is free, folding everything breaks even and beats
  every losing strategy.
- **Kickers didn't exist.** The evaluator returned `[category, oneValue]`, so AK and AQ
  chopped on an ace-high board.
- **No all-ins and no side pots.**

### What replaced it

- **Evaluator:** category and five ranks packed into one integer. Verified against all
  **133,784,560** seven-card hands, matching published category frequencies to four
  decimal places.
- **Engine:** blinds and button (reversed heads-up), min-raise rules including the short
  all-in that doesn't reopen betting, layered side pots, uncalled bets returned, odd chips,
  rake with a cap and no-flop-no-drop. Deals are seeded and replayable, and strategies see
  a view, never the table. `--test` verifies it on 20,000 random hands.
- **Measurement:** bb/100 with a standard error. `compare` differences two strategies hand
  by hand on the same cards:

| Change | Hands it altered | SE unpaired | SE paired | Reduction |
|---|---|---|---|---|
| Postflop calling threshold | 0.11% | 63.69 | 2.14 | **29.7x** |
| Preflop calling range | 39.63% | 83.05 | 54.04 | **1.5x** |

- **Equity:** all 169 starting hands solved against 1–8 opponents (AA 85.2% heads up,
  AA 49.0% six-handed). Postflop strength comes from the exact seven-card distribution,
  draws are priced with the 2×/4× rule, and low proficiency miscounts outs and misprices
  multiway pots.

### Two modelling errors

Both were the same mistake: pricing an action off unconditional equity.

- **A raise got more attractive the more it had been called.** Fold equity grew with the
  pot, so the field fought unbounded re-raise wars: **15.4 preflop raises per hand**, 91%
  of hands all-in before the flop. Fold equity now decays with commitment and with raises
  already made. Preflop raises fell to 1.56 per hand.
- **Being called is bad news.** Somebody putting chips in isn't holding a random hand.
  Calls and raises are now shaded by the price being laid.

---

## 2026-09-02: Blackjack, four bugs fixed, a real shoe, and counting

Commits `94405eb`, `bf8bb22`, `48562a2`.

### Four bugs, each hiding the next

1. **Every push was scored as a loss.** `playerTied` was assigned `false` in the branch
   that detects a tie. Pushes are 8–9% of hands, and the measured edge was **−0.0763**,
   about fifteen times the true figure. Fixing it alone moved the edge to **+0.0211**.
2. **Any 21 was paid as a blackjack.** A hand *hit* to 21 collected 3:2, even when doubled
   or after a split, and the dealer had no hole card. Naturals now settle first, as at a
   real table. That took the edge to **−0.0103**.
3. **A solved table couldn't be graded at all.** `odds.js` writes no `splits` key, and the
   simulator dereferenced it unconditionally. A missing splits map now means "never split".
   Surrender and double were also decided on raw win scores instead of EV: surrender needs
   `s < 0.25`, not `s < 0.5`.
4. **The solver surrendered eleven cells instead of four.** EV was averaged over dealer
   second cards that make a natural, but the dealer peeks, so those losses have already
   been settled. They dragged stand, hit and double down together, while surrender pays a
   flat −0.5. Conditioning on "no natural" leaves exactly the published late-surrender
   table: **15 v 10, 16 v 9, 10, A**. Disagreements with published basic strategy fell from
   ten to two.

### A real shoe

Cards used to be drawn with replacement. They now come from `NUM_DECKS` decks with a cut
card at `PENETRATION`, which reproduces the known deck-count effect and made card counting
representable for the first time.

### Hi-Lo counting

A running count, a true count and a 1–12 bet ramp, with no change to playing decisions.

---

## 2025-08-19: First Texas Hold'em demo

`d329872`. A single-hand deal-and-rank demo, later replaced (see above).

## 2023-09-07: Monty Hall host fix

`562c2a4`, `61a9920`. The host now opens a door that is neither the player's pick nor the
car, as the problem requires.

## 2023-03-15: Monty Hall

`726f779`. `deal.js`, ten million runs of stay versus switch.

## 2021-11: Splits and a corrected basic-strategy table

`97a0352`, `8f2af8b`. Wrong double and surrender cells in `basic.json` were corrected, a
splits table was added, the simulator was taught to use it, and the first README was
written.

## 2021-10-26 – 11-03: v1.0 – v1.2, the blackjack solver

The recursive EV solver in `odds.js`, the simulator in `blackjack.js`, and an evolutionary
search over strategy tables. `basic.png` and `v1.1.png` are tables from this period
rendered as grids.

The evolutionary search never worked, and the reason became one of this project's
recurring lessons. Three runs of the *same* table:

```
-0.01025375     -0.01032     -0.00998075
```

The per-hand standard deviation is **σ ≈ 1.04**, so the estimate's noise at 10M hands is
**0.00033**. That is larger than almost any single-cell improvement, so the search accepted
noise as progress. Resolving a difference `d` at 3 SE needs `N > (3σ/d)²` hands per
candidate: about 39M for 0.0005, and 3.9 **billion** for 0.00005.
