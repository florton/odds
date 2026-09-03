# odds

Card-game probability worked out from first principles, in plain Node with no
dependencies. Four programs: a blackjack strategy solver, a simulator that measures what
a strategy is actually worth, a Texas Hold'em engine, and a Monty Hall sanity check.

```bash
node odds.js                    # solve the strategy tables    -> output.json
node blackjack.js               # grade the real basic strategy over 10,000,000 hands
node blackjack.js output.json   # grade a table you just solved
node texas.js                   # deal a full Hold'em hand, betting rounds and all
node deal.js                    # Monty Hall, 10,000,000 runs
```

## Results

The solver's table agrees with published basic strategy on **260 of 270 cells (96.3%)**,
and the two grade almost the same at the table:

| Strategy | Edge over 10M hands |
|---|---|
| Published basic strategy | **-0.0103** (±0.0004) |
| Solved by `odds.js` | **-0.0132** (±0.0004) |

Both measured with splits disabled, since the solver doesn't produce a splits table — see
"What's left" below.

### Can basic strategy be beaten?

That was the original question, and the answer is **no** — not in this game, and not by
searching. Basic strategy *is* the EV-maximizing decision for every (hand, up-card) pair
when the remaining deck is unknown. It is the solution to that optimization problem, so
there is nothing above it to find. Only extra *information* beats it: composition-dependent
play (using the specific cards making up your total, worth ~0.03%) or counting a finite
shoe and spreading bets. An infinite shoe, as simulated here, destroys both by
construction — every hand is drawn from an identical deck.

Which makes the evolutionary search in `blackjack.js` unwinnable for a second, sharper
reason: **it is searching below its own noise floor.** Three runs of the *same* table:

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

Two better levers:

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
one split with no resplit limit. **Insurance is deliberately absent** — it is never correct
without counting, and basic strategy never takes it, so omitting it costs the simulation
nothing. The shoe is infinite (see "What's left").

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

Plays a strategy table hand by hand against an infinite shoe and reports the edge as net
units won per hand. Pass a filename to grade a different table; with no argument it grades
`basic.json`, the real published strategy.

Uncommenting `iterate()` runs an evolutionary search that mutates cells, keeps a mutation
only if it beats the baseline over millions of hands, and saves any improvement. It works,
but grading one generation costs a full simulation run, so it is slow enough to be
impractical.

## Bugs found and fixed

Three defects, worth recording because each one hid the next.

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

## What's left

**The solver over-surrenders against an ace.** It finds all four true surrender cells
(16 vs 9/10/A and 15 vs 10) and seven false ones — six of them against a dealer ace, the
seventh against a ten. The cause is that stand/hit EV is computed *unconditionally*,
including the outcomes where the dealer has a natural. Under late-surrender rules the
dealer checks for blackjack first, so surrender is only ever exercised on hands where the
dealer *doesn't* have one; conditioning the dealer's outcome distribution on "not a
natural" for ace and ten up-cards should close it. This accounts for seven of the ten
cells where the solver disagrees with the published table. The other three are marginal
doubles (11 vs 10, soft 12 vs 5, soft 13 vs 5).

**Splitting is barely modelled.** Each split hand recursively deals itself a fresh dealer
hand rather than sharing one, and split aces aren't restricted to a single card. Splitting
is worth about 0.007% here against roughly 0.5% in reality, so the split logic is close to
inert. The solver doesn't emit a splits table at all.

**The shoe is infinite** — cards are drawn with replacement, so there is no depletion and
no counting.

Because the evolutionary search grades against this simulator, it should stay parked until
the surrender conditioning is fixed.

## texas.js — Hold'em

A complete Texas Hold'em hand: deck, Fisher-Yates shuffle, hole cards, flop/turn/river,
five-card hand ranking, four betting rounds with fold/call/raise decisions driven by hand
strength, and pot payout across the winners. Prints the hand as it plays.

## deal.js — Monty Hall

Ten million runs of stay-vs-switch, as a check that the harness reports what theory
predicts. It does: **switching wins 66.65%**, staying 33.35%.
