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
  reproduces tracked frequencies *and* the statistics that show money moving
  (fold to a c-bet, W$SD, fold to a 3-bet); the fish lose to the regulars at
  tens of bb/100, and at fixed style every step of proficiency from 0.25 to
  1.0 is worth more money than the one before.
- **A preflop rule solver** that answers in the form a player carries --
  "raise the top X% from this seat" -- with the noise on every cutoff. Its
  main result so far is diagnostic: each exploit it found was a hole in the
  field the fit statistics had missed.

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
node texas-strategy.js             # solve preflop rules vs the realistic field -> rules.json
node texas-strategy.js --agree --cross   # compare saved fields' rules, replay each in the others

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
| `texas-strategy.js` | Solves preflop rules ("raise the top X% from this seat") as a best response to a fitted field, by forced replays on common random numbers. |
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

Frequencies alone turned out not to be enough. A field fitted only to how often
players act paid off everything after the flop -- aces won half a stack each
time they were dealt -- so the fit also carries the statistics that show money
moving: c-bet, fold to a c-bet and to a turn c-bet, fold when a bet is raised,
W$SD (won money at showdown), the preflop responses (3-bet, fold to a 3-bet or
4-bet, fold to a steal), and a loose win-rate band for the two fish. Most are
bands rather than points, because published figures for them vary by site and
stake. The [changelog](CHANGELOG.md) has how each one was found missing.

The neutral regulars the value model is fitted on, measured on deals the
search never saw:

| VPIP | PFR | AF | WTSD | C-bet | Fold to c-bet | Fold to turn c-bet | W$SD | 3-bet | Fold to 3-bet |
|---|---|---|---|---|---|---|---|---|---|
| 22.3 / 22 | 15.6 / 18 | 2.4 / 2.5 | 21.7 / 26 | 50.5 / 55-75 | 41.6 / 38-55 | 45.7 / 35-50 | 51.2 / 48-56 | 5.9 / 5-9 | 56.2 / 45-65 |

They open-limp 1.5% of hands, fold to a 4-bet 66% of the time and to a steal
59%, and 62% of hands end before a flop. What misses: c-bets run a few points
short, and they fold a raised bet 28% of the time against a band of 35-60.

The named types, averaged over three held-out seeds:

| Type | VPIP | PFR | AF | WTSD | Fold to c-bet | W$SD | Fold to 3-bet | bb/100 |
|---|---|---|---|---|---|---|---|---|
| nit | 16.2 / 13 | 10.2 / 10 | 2.1 / 2.2 | 20.0 / 24 | 37.8 / 50-70 | 59.6 / 52-62 | 88.8 / 55-75 | +7.7 |
| tag | 23.8 / 22 | 18.0 / 19 | 2.4 / 2.6 | 20.9 / 26 | 51.7 / 38-55 | 55.7 / 48-56 | 52.5 / 45-65 | +31.8 |
| lag | 25.2 / 32 | 16.5 / 25 | 3.3 / 3.2 | 20.0 / 29 | 35.9 / 33-50 | 50.1 / 46-54 | 41.1 / 35-55 | +22.1 |
| station | 38.3 / 45 | 5.2 / 6 | 0.9 / 0.6 | 20.0 / 42 | 41.1 / 20-35 | 48.6 / 40-48 | 8.7 / 20-45 | −55.9 |
| maniac | 42.4 / 62 | 27.6 / 38 | 3.4 / 2.4 | 17.9 / 36 | 40.7 / 25-45 | 42.1 / 40-50 | 6.5 / 20-45 | −37.5 |

*measured / target*

The TAG is the best-fitted type it has ever been. The fish are not: they lose
realistic amounts, but after the flop they fold like regulars, and the maniac
plays 42% of hands against 62. A fit that made them call down like fish
(station WTSD 32, fold to c-bet 17) had them losing 124-143 bb/100 and the TAG
winning 138 -- see Limitations for that trade and why this one was kept.

### Who wins

300,000 hands per experiment, duplicate-dealt with the lineup rotated so every
player meets every set of cards from every seat. Error bars are clustered on
the deck, and a claim needs three standard errors.

**1. Personality at equal skill.** All six seats at proficiency 0.85, so the
only difference between them is style:

| Player | bb/100 | ± SE |
|---|---|---|
| lag | +31.5 | 2.8 |
| tag | +23.8 | 2.1 |
| neutral | +11.3 | 2.1 |
| nit | +4.7 | 1.4 |
| station | −33.5 | 2.8 |
| maniac | −37.8 | 3.6 |

Aggressive regular styles win at equal execution, and both fish lose even when
they execute as well as everyone else; 17.6% of hands reach showdown. Before
the money statistics entered the fit, the maniac *won* this table by +130.1
bb/100: it was fitted on how often it acted, and it acted like a strong LAG.

**2. Skill at equal personality.** Six neutral players differing only in
proficiency:

| Proficiency | 0.25 | 0.40 | 0.55 | 0.70 | 0.85 | 1.00 |
|---|---|---|---|---|---|---|
| bb/100 | −61.0 | −29.4 | −19.9 | +11.7 | +41.9 | +56.7 |

± ~2.5 each. Monotone at every step, and the best player clearly beats the
worst; one proficiency step is worth roughly 20-30 bb/100 around the middle of
the ladder.

**3. The realistic table.** The fitted types at the proficiencies they were
fitted at (nit .68, tag .81, lag .60, station .54, maniac .49), no rake:

| Player | bb/100 | ± SE |
|---|---|---|
| tag | +50.1 | 2.5 |
| tag (2) | +32.9 | 2.3 |
| lag | +28.5 | 3.2 |
| nit | +2.9 | 1.6 |
| maniac | −56.8 | 3.8 |
| station | −57.7 | 3.2 |

The same table raked 5% capped at 3bb costs each seat **10.0 bb/100**: tag
+42.3, tag (2) +24.8, lag +10.4, nit −4.2, maniac −65.4, station −67.6. The
money now flows the way it does at a real table, from the two fish to the
regulars, and at rates of tens of bb/100 rather than the hundreds the fish
lost before the money statistics were fitted.

**4. Where the money comes from.** Both blinds lose (SB −80.4, BB −83.6),
later position earns more (CO +51.2 > HJ +38.5 > UTG +26.0), and aces are
the most profitable starting hand, then KK QQ JJ AKs. The fish lose from the
blinds above all (station −183 and −174, maniac −197 and −150).

Nine of the eleven checks pass. The two that fail: the button (+48.3 ± 4.8)
is not clearly ahead of the cutoff (+51.2 ± 3.7), and aces win **15.6 bb a
hand**, where tracked databases put them at a few. That is down from 26.9 at
the first refit and far down from the half-stack aces won before, but it is
still the field paying off, and mostly the fish doing it: the TAGs' aces make
about 25 bb a hand at the mixed table, the fish's own 7-15.

### Preflop rules, and what they found

`texas-strategy.js` asks the question a player asks: given this table, what
should I do with this hand from this seat? It answers in the form a player can
carry -- "raise the top X% from this seat, call the next Y%, fold the rest",
for each seat and situation -- solved on 21 bands of the hand ranking by
replaying each deal with the hero forced into each action on the same cards
and the same random draws. Each cutoff comes with the stretch of the ranking
where it is within noise, and each rule with what it costs against playing
every band its own best action.

The rules it solves are **not advice yet**, and the reason is the finding.
Solved against the fitted field they limp a third to two thirds of hands,
re-raise 25-50% of hands when raised, and beat the plain fitted TAG by
+77 to +158 bb/100 depending on the field -- and every field's rules win about
as much in the other fields. Real edges over a competent regular are a few
bb/100, so these are exploits of the model, and the solver found each one
faster than any statistic did. Decomposed, most of the edge is one line:
limp, and re-raise whoever isolates, with a hand the TAG would fold. The
isolator folds 59% of the time -- inside the published fold-to-3-bet band --
and when called, the junk loses only about a big blind after the flop. A
real table would adapt to a player who limp-reraised half their hands inside
an orbit; this field never adapts, and a best response to a static field
exploits the fact. The earlier exploits it found (a TAG type that folded to
3-bets 80% of the time, a station that called pot-sized river bets with
nothing) were fixed in the model; this one is a limit of solving against a
field that does not learn.

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

**Hold'em.** The fish either look like fish or lose like fish, not both. In
the fit kept here they lose realistic amounts (station −57.7, maniac −56.8 at
the realistic table) but fold after the flop like regulars -- the station
shows down 20% of the flops it sees against a target of 42 -- and the maniac
plays 42% of hands against 62. A resumed fit that weighted each type's four
defining statistics as half its error, started from a stickier station and a
looser maniac (`--resume maxBias=0.9` with station `stickinessScale` 3 and
maniac `looseness` 0.98), made them call down like fish (station WTSD 32,
fold to a c-bet 17) and immediately had them losing 124-143 bb/100 with the
TAG winning 138. Calling down in this model is badly aimed, so a fish that
does it loses far faster than a real one; the fit that keeps the money
realistic was kept. Aces still win 15.6 bb a hand, a few times the real
figure, and the button does not clearly out-earn the cutoff.

The preflop rules solved against this field exploit it rather than describe
good play (see above): a static field that never adapts can be limp-reraised
forever, and no statistic in the fit says otherwise. Behavioural targets --
even money ones -- constrain what a field does on average; a best response
finds whatever the averages leave out, and has found something new after
every refit so far.

The traits and pulls are a coordinate-descent optimum, so the answer depends
on the path: four refits in a row landed in different places on the same
targets, and parameters have repeatedly sat where no single-coordinate move
helps until lifted off by hand (`node texas-calibrate.js --resume`). Each
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
