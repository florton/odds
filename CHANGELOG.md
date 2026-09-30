# Changelog

Newest first. Figures quoted under each entry are the ones measured at the time of that
change. Later work has moved several of them, and the current numbers live in the
[README](README.md).

The write-ups are kept in full because most of what this project learned, it learned from
a bug. Nearly every entry below was found by measuring something and getting a number that
could not be right.

---

## Unreleased: the money after the flop, and rules instead of charts

The last entry ended with the field paying off: the solved charts valued aces
under the gun at +40 bb a hand and said to limp them, and the fish lost
200-290 bb/100. This one went after the money, and found most of it in two
places nobody had measured.

### Every hand on every flop was a draw

A diagnostic counting what happens after the flop found regulars folding
22-26% of flop bets against a real ~45%, the station and maniac 11%, a third
of the mixed table's hands ending in a pot of 100bb or more, and the TAG
winning **+50 bb every time it was dealt aces**. The station lost 50bb or more
in 13% of its hands, often holding no pair at all.

The cause was the outs count. `countOuts` counted any card that raised the
hand's category, and a card that pairs the board raises everybody's: on a
random flop a hand with no pair averaged **16.6 outs**, which the rule of four
reads as 66% equity, and that beat its real strength (0.30) every single time.
Nobody ever folded two unpaired cards on a flop, and no read of the bettor
could reach them, because the draw term was not priced against anyone. Outs
are now what a player counts: a card has to gain on the board, and going from
nothing to a pair counts only for an overcard. The nut flush draw with two
overcards is 15, two undercards 0, top pair 5, a set 7, and a no-pair hand
averages 3.1. `node texas.js --test` checks eight such hands.

### A bet now says something

A bet was a flat 20% discount on equity, the same on every street and at every
raise, so top pair treated a flop bet, a turn bet, a raise and a shove alike.
Players now read a line the way they read a preflop raise: each bet narrows
the bettor to the top `postRange` of holdings on this board, a raise over a
bet counts `postRaiseWeight` bets, a call `postCallWeight`, and a hand's
equity is the share of that range it beats -- (0.85 - 0.45) / 0.55 = 73% for a
hand that beats 85% of holdings against one bet. Weak players believe it less,
as before the flop.

And the preflop raiser now expects a continuation bet to fold out more than
the price alone says (`initiative`), because the caller misses most flops.
Without it the fitted regulars c-bet 38% of flops against a real 60-70, and
the only lever the search had -- more fold equity for every bet -- made
everybody raise more and fold less.

### What the fit could not see

The calibration gained the statistics that show money moving: c-bet, fold to
a c-bet and to a turn c-bet, fold when a bet is raised, W$SD, open-limp and
fold to a 4-bet for the regulars; fold to a c-bet and W$SD for every type, in
bands that give each its shape; and a loose win-rate band for the two fish.
Each refit then showed the next thing nothing measured:

- **Refit 1** found regulars folding a raised bet a quarter of the time (a
  raise had drifted to reading as barely more than a bet) and hitting PFR by
  open-limping 9% of hands. Fold-to-raise and limp bands went in.
- **Refit 2** put the regulars on 13 of 15 targets, but pooled over everyone
  dealt them, aces still won **26.9 bb a hand** at the realistic table. The
  station's stickiness was a flat bonus in pots, and a pot counts the bet
  being faced, so for the fitted station the bonus was larger than the price
  of calling a pot-sized bet: it called river bets holding nothing. After the
  flop stickiness is now a discount on the price of a call -- weak made hands
  call, air does not profit.
- The rule solver, run on refit 2, found that the fitted TAG and nit folded to
  a 3-bet 78-80% of the time against a real 50-60: only the neutral regulars
  had carried that band. Its best rules limped most hands and re-raised
  whoever raised, for +100 to +270 bb/100 over the plain TAG. Every type now
  carries 3-bet, fold-to-3-bet and fold-to-steal bands.

Two things in the search were wrong along the way. Its steps are multiples of
the current value, so a parameter at zero could never move: `handOvervalue`
sat at 0.000 through every fit since it was added, and the entry that says the
fit "declined" it was reading a search that never tried. Zero now steps by a
fraction of the parameter's range. And once each type carried a dozen bands,
VPIP was one term in thirteen, and the fit let the maniac play 42% of hands
against 62 to buy fractions of a point inside bands. A type's four defining
statistics and its bands are now weighted half and half.

### Where it landed

The kept fit is the third. Measured on deals the search never saw, the
regulars sit at 22.3/15.6 with AF 2.4, fold to a c-bet 41.6%, to a turn c-bet
45.7%, W$SD 51.2, fold to a 3-bet 56 and to a 4-bet 66, and open-limp 1.5% of
hands; c-bets run a few points short (50.5) and they fold a raised bet 28% of
the time against a band of 35-60. The TAG type is 23.8/18.0 and folds to a
3-bet 52.5% of the time. At the realistic table the money flows from the fish
to the regulars at realistic rates: TAGs +50.1 and +32.9, LAG +28.5, nit +2.9,
maniac **−56.8**, station **−57.7** -- against 200-290 lost before. After the
flop 6.9% of the mixed table's hands end in a 100bb pot, against a third.
Aces still win **15.6 bb a hand**, a few times the real figure; the new check
in `texas-results.js` fails on it and says so.

The price is the fish. They lose like fish but fold after the flop like
regulars -- the station shows down 20% of its flops against a target of 42 --
and the maniac plays 42% of hands against 62. The fourth, resumed fit, with
the core statistics weighted up and the station and maniac started stickier
and looser, made them call down like fish, and they immediately lost 124-143
bb/100 with the TAG type winning 138: in this model a fish that calls down
aims its calls badly enough to lose several times what a real one does. The
third fit keeps the money honest and was kept; how to reproduce the fourth is
in the README's Limitations.

### Rules instead of charts

`texas-strategy.js` now solves the rule a player carries rather than a
169-hand chart: "raise the top X% from this seat, call the next Y%, fold the
rest", per seat and situation, on 21 bands of the hand ranking (a point wide
at the top, fifteen at the bottom). Each band pools about eight hands'
deals, and every pass the hero plays the best rule of that shape, so the rule
is what is solved rather than something read off a noisy chart afterwards.
Each cutoff is printed with the stretch of the ranking where the actions
either side of it are within two standard errors, and each rule with its cost
against playing every band its own best action -- including how much of that
cost is clear at 2 SE, because the best of several noisy estimates always
looks better than it is. The old chart is `--chart`; `--agree --cross` replays
every field's rules in every other field.

Solved against the kept field, the rules are not advice. They limp a third to
two thirds of hands, re-raise a quarter to half of them when raised, and beat
the plain TAG by **+77** (tough field), **+127** (realistic) and **+158**
(soft) bb/100, and each field's rules win +46 to +175 in the others. A
decomposition of the tough-field edge by preflop line put two thirds of it on
one line: limp, then re-raise whoever isolates, with a hand the TAG would have
folded -- +3.5 bb every time. The isolator folds 59% of the time, inside the
published fold-to-3-bet band, and when it calls, the junk loses only a big
blind after the flop. A real table adapts to that inside an orbit; this one
never adapts, and a best response to a static field finds it. The two earlier
exploits it found were holes in the fit and were closed; this one is a limit
of solving against a field that does not learn.

## Unreleased: a strategy solver, and the preflop model it broke

### A solver that found the field's leak in one run

`texas-strategy.js` is the blackjack solver's idea applied to Hold'em: a
preflop chart (seat x situation x hand -> fold/call/raise, with sizings a person
uses without thinking), valued one decision at a time. Each deal is played as
the chart says, then replayed from the same deck and the same random draws for
everybody with the hero forced into each other action at one decision. Every
replay forced back to the chart's own action reproduced the original result
exactly (3,537 of 3,537), so the difference between replays is the value of the
decision and nothing else.

Its first chart beat the plain fitted TAG by **+625 bb/100** on fresh deals, and
told you to 4-bet 72o. A strategy that wins 6 big blinds a hand has found a
bug, not a strategy.

### The fitted field folded aces

Asked directly, the fitted TAG in the big blind folded AA to a 3bb open 45% of
the time and to an all-in 100% of the time; the nit folded AA to an open 72%
of the time. The cause was `callShadePre`, which discounted preflop equity by
`callShadePre x price` and which the fit had run to 3.48: at any real raise the
discounted equity is negative, so no fitted player ever just called a raise,
with anything. VPIP, PFR, AF and WTSD all came out on target, because they
count how often a player acts and not with what. What is not measured is not
constrained -- the same lesson as the TAG with an aggression factor of 8.5,
from the other side.

Removing it showed the constant had been covering for the whole preflop
valuation. Priced as a one-shot bet -- equity times pot, as if the hand went
quietly to showdown -- a raise with aces under the gun was worth under half a
big blind, because the value of aces is in streets that model never sees. With
the constant gone the regulars limped 38% of hands and checked them down
(WTSD 58 against 26), and even at near-zero decision noise they folded AA/KK
8-11% of the time. Patches uncovered more holes than they closed: an
expected-opponent count fed into the fold-equity term made every steal work
half the time.

### Preflop is now played the way people play it

Before the flop the players now do what a person does:

- **Unopened**, they know roughly where their hand ranks among the 169 and how
  wide they open from this seat, and compare the two. Weak players rank hands
  partly by heads-up equity against a random hand, the ranking that rates A2o
  above 76s.
- **Facing a raise**, they read the raiser's range from the number and size
  of raises ("an open is about the top 21%, a 3-bet a third of that") and do
  the pot-odds sum against it, charged for position and for being squeezed --
  except when the money is all in, where neither applies. Equity against the
  top X% of hands is a new table in `equity.json`
  (`node texas-equity.js --build-ranges`).
- Personality and proficiency act on these values exactly as before, and
  after the flop nothing changed.

The calibration gained four statistics, as bands rather than points because
published figures for them vary more by site and stake: 3-bet 5-9%, fold to a
3-bet 45-65%, big blind folds to a steal 45-70%, and AA/KK folded to a bet
0-1% (0-2% for every named type). The refit puts the regulars inside all four,
the TAG holds AA and KK against any raise, and the sizing check -- the same
TAG with a person's standard raise sizes -- no longer moves the win rate.

What it cost is written into Limitations: every type now plays about 6 VPIP
looser than its target, and the fish lose far faster than real fish do.

## Earlier: finishing the Hold'em player model

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
was fitted on the regulars to refuse -- and the fit picks one. That went to
the README's Limitations as the stopping point. The next entry took the chase
back up.

### One global scale cannot fit five types

The resume escape put every VPIP within reach, but the station's WTSD stayed
at 28.2 against 42 and its stickiness went back to the ceiling, 0.98. The
argument for holding the pulls global -- halve every trait's distance from
neutral and double the pull, same player -- has one hole: a trait bounded on
[0.02, 0.98] saturates, and a saturated trait's bias can only grow through
the pull. Saturated, the station was buying 0.48 x 0.56 x 2 = 0.54 pots of
call bias, and WTSD 42 wants closer to twice that.

Two per-archetype additions break the tie. `stickinessScale` multiplies one
type's stickiness pull, searched on [0.25, 4]; `skill` frees the proficiency
each type is fitted at, so the realistic table plays them where the fit put
them rather than where they were hand-assigned. The joint refit took the
objective from 0.038 to **0.0108** and the station to **51.2/45** VPIP with
WTSD **32.8** -- VPIP error cut from +17.8 to +6.2, WTSD up from 28.2 --
while everyone else stayed on target: nit 14.1/13, tag 22.1/22, lag 29.8/32,
maniac 61.2/62. The fitted skills landed at nit .60, tag .75, lag .54,
station .49, maniac .39: the station needed a steadier hand, not a louder
bias -- at 0.35 its softmax was folding flops at random, and no bias survives
its own coin flips. Held out on fresh seeds it holds: station 51.4/51.7 VPIP,
WTSD 30.2/31.3 against the fit seed's 32.8, which is that statistic's usual
wobble over 8,000 hands; VPIP and PFR stay within a point and a half
everywhere.

The residual the search would not eat says why it stopped where it did. The
station's AF target is 0.6 and it sits at 0.5; stickiness only adds value to
calls, so every showdown bought with more stickiness is paid for in
bets-per-call. A real station calls down *and bets its made hands* -- its
calls and bets rise together -- and that joint movement is exactly what a
pure call bias cannot make. Giving the model a way to make it is the next
entry.

### The lever the fit declined

The diagnosis pointed at AF: the station's WTSD climb kept dragging its
bets-per-call below target, and a real station calls down *and* bets its
made hands. So a `handOvervalue` parameter was built -- a flat equity bonus
postflop when holding a pair or better, scaled by a trait's distance from
neutral so the stage-1 regulars cannot see it (they sit at exactly 0.5), and
fitted alongside the personality scales. A paired-seed probe confirmed it
does what it claims: at 0.5, a station-like player's folds fall **9.3% ->
5.1%** and its raises *rise* **8.3% -> 14.6%** on a made hand, while an
ace-high view is bit-identical.

The search tried it through every stage-3 pass and kept it at **0.000**.
*(Correction, later: it did not. The search steps are multiples of the current
value, and zero times any multiple is zero -- the parameter was never moved,
so nothing below says the fit preferred anything to it. See "Unreleased: the
money after the flop".)* It
had found a blunter instrument it liked better: raise the station's own
aggression (0.10 -> 0.33) and skill (0.49 -> 0.63). The refit took the
objective from 0.0108 to **0.00519** and the station to **49.5/45** with
WTSD **37.9** and AF on target at 0.6; held out, it holds at 50.3/50.4 VPIP
and WTSD 36.6-37.1. The cost, under the equal-weight objective, is the
maniac: **67.8/62**, where the previous fit had it at 61.2. The parameter
stays in the model at 0 -- fitted infrastructure the run turned out not to
need, which is itself the finding: the AF bind was real, but it unbinds
through the aggression trait long before it needs a new mechanism.

### The table, re-measured

Fitter stations move money. The 300,000-hand rerun (137s) finds the station
at **−8.3 ± 6.1** bb/100 at the realistic table against **−152.0** before,
and the LAG at **−35.0** against +90.8 -- that edge was never the LAG's own,
it was the station's excess folds, and it closed when the leak did. The
field compresses around two winning TAGs (+43.0, +18.5); the maniac still
wins (+24.6, raked +16.2, no longer flipped negative by the rake). The skill
ladder reproduces the previous run to the decimal -- neutral players never
see the traits -- which is the harness agreeing with itself.

Six of ten shape checks pass, against eight before, and the two new failures
are the point. The station loses money but cannot prove it at three standard
errors; a fitted station that bets its made hands is a marginal loser, and
"the station clearly bleeds" was a symptom of the misfit, not a fact about
stations. The top-five starting hands miss (AA KK QQ JJ 99, AKs sixth) is a
coin flip: 99 +451 ± 44 over TT +430 ± 42. The maniac and TAG-gap failures
carry over unchanged.

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
