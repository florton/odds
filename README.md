# odds

An attempt to generate blackjack basic strategy mathematically (got pretty close, check v1.1.png)

As well as a blackjack simulator to test the actual house edge

And an attempt to use an evolutionary algoritm to improve (too slow to be productive)

`node odds.js` to generate strategy json

`node blackjack.js` to run blackjack simulation to calculate strategy edge (basic strategy by default,but you can change the import) (to run evolutionary algorithm to attempt to improve on it, uncomment last line `
// iterate()`)

`node deal.js` to run monty hall problem simulation