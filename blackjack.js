const fs = require('fs')

// Which table to grade: `node blackjack.js` uses the real published basic
// strategy; `node blackjack.js output.json` grades a table solved by odds.js.
const strategyFile = process.argv[2] || 'basic.json'
const basic = require('./' + strategyFile.replace(/^\.\//, ''))

// ---------------------------------------------------------------- the shoe
//
// Cards are dealt from a real shoe rather than drawn with replacement, so the
// deck depletes as it is played. That matters: with replacement every hand
// comes from an identical deck, which makes counting impossible by
// construction and leaves no room for composition-dependent play.
//
// A batch shuffler with a cut card is modelled, not a continuous shuffler --
// a CSM returns cards after every round and would put us back at the
// with-replacement case. PENETRATION is how deep the shoe is played before
// the cut card appears; it is the single biggest lever on what counting is
// worth, so it is a knob.

// node blackjack.js [strategy] [decks] [penetration] [count] [hands]
//   node blackjack.js basic.json 6 0.75              six decks, cut 75% deep
//   node blackjack.js basic.json 1 0.5               single deck, half dealt
//   node blackjack.js basic.json 6 0.75 count        same shoe, counted and spread
//   node blackjack.js basic.json 6 0.75 count 1e8    and with the noise beaten down
const NUM_DECKS = Number(process.argv[3]) || 6
const PENETRATION = Number(process.argv[4]) || 0.75

// One deck: four suits of each rank, tens and all three face cards worth 10.
const rankValues = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10]

const buildShoe = (numDecks) => {
  const cards = []
  for (let d = 0; d < numDecks; d++) {
    for (let suit = 0; suit < 4; suit++) {
      for (const value of rankValues) {
        cards.push(value)
      }
    }
  }
  return cards
}

const shuffleShoe = (cards) => {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const swap = cards[i]
    cards[i] = cards[j]
    cards[j] = swap
  }
  return cards
}

let shoe = shuffleShoe(buildShoe(NUM_DECKS))
let dealIndex = 0
let cutIndex = Math.floor(shoe.length * PENETRATION)
// Everything a counter knows is wiped by the shuffle, so this resets with it.
let runningCount = 0

const reshuffle = () => {
  shoe = shuffleShoe(buildShoe(NUM_DECKS))
  dealIndex = 0
  cutIndex = Math.floor(shoe.length * PENETRATION)
  runningCount = 0
}

// The cut card ends the shoe at the end of the round it appears in, never
// mid-hand, so this is checked between hands.
const cutCardReached = () => dealIndex >= cutIndex

// ------------------------------------------------------------ card counting
//
// Hi-Lo. Low cards leaving the shoe are good for the player: what remains is
// richer in tens and aces, which means more naturals paid 3:2, more dealer
// busts off stiff hands, and doubles that land. So low cards count +1, tens
// and aces -1, and the middle of the deck counts nothing.
//
// A raw running count means nothing on its own -- +6 with five decks left is
// noise, +6 with one deck left is a live shoe -- so it is divided by the decks
// still to be dealt to get the true count.
//
// The edge does not come from playing hands better. It comes from betting more
// when the shoe is good, which is why this needs a finite shoe to exist at
// all: with replacement, every hand is dealt from the same deck and there is
// nothing to count.
const COUNTING = process.argv[5] === 'count'

const countValue = (card) => {
  if (card >= 2 && card <= 6) return 1
  if (card === 10 || card === 1) return -1
  return 0
}

const trueCount = () => {
  const decksRemaining = (shoe.length - dealIndex) / 52
  // Floored, so the last sliver of a shoe cannot divide the count into a
  // number that isn't there.
  return runningCount / Math.max(decksRemaining, 0.5)
}

// A 1-12 spread. It stays at the table minimum until the true count is at
// least +2, because a barely positive shoe has not yet paid for the house
// edge; most of a shoe is played at a disadvantage and the whole game is
// losing as little as possible on those hands.
const betRamp = (tc) => {
  if (tc < 2) return 1
  if (tc < 3) return 2
  if (tc < 4) return 4
  if (tc < 5) return 8
  return 12
}

const draw = () => {
  // Only reachable if a single round burns through the tail of the shoe.
  if (dealIndex >= shoe.length) {
    reshuffle()
  }
  const card = shoe[dealIndex++]
  // The count is only ever read between rounds, and by then every card of the
  // finished round has been dealt regardless, so counting cards as they are
  // dealt is the same as counting them as they are turned face up -- the hole
  // card included.
  runningCount += countValue(card)
  return card
}

// memo
const preCalcedTotals = {}

const calcTotal = (cards) => {
  if (preCalcedTotals[cards.toString()]) {
    return preCalcedTotals[cards.toString()]
  }

  const reducer = (previousValue, currentValue, currentIndex, array) => {
    let nextValue = currentValue
    if (currentValue === 1 && currentIndex == array.length - 1) {
      if (previousValue + 11 <= 21) {
        nextValue = 11
      }
    }
    return previousValue + nextValue
  }

  const result = [...cards].sort().reverse().reduce(reducer)

  preCalcedTotals[cards.toString()] = result
  return result
}

const handIsSoft = (cards) => {
  const numberOfAces = cards.filter(c => c == 1).length
  if (numberOfAces > 0) {
    const sum = (previousValue, currentValue) => previousValue + currentValue

    const handTotal = calcTotal(cards)
    const naiveTotal = cards.reduce(sum)

    return handTotal > naiveTotal
  } else {
    return false
  }
}

const dealerWillHit = (cards) => {
  const choice = calcTotal(cards) < 17
  return choice
}

const playerWillHit = (cards, dealerCard, strategy) => {
  const handTotal = calcTotal(cards)
  if (handTotal >= 21) {
    return false
  } else {
    const isSoft = handIsSoft(cards)
    if (isSoft) {
      return strategy.soft[handTotal][dealerCard]
    } else {
      return strategy.hard[handTotal][dealerCard]
    }
  }
}

// Total staked across a run, which is not handCount * bet once doubles,
// splits and a bet spread are in play.
let totalWagered = 0

const playHand = (playerChips, betAmmount, strategy, splitCard = null) => {
  // A split hand keeps one card of the pair, so only its partner is drawn.
  const playerHand = [splitCard || draw(), draw()]
  const dealerHand = [draw(), draw()]
  let multiplyer = 1

  const allowSplits = true
  if (allowSplits && playerHand[0] === playerHand[1]) {
    // odds.js solves hard/soft only, so a generated table has no splits map.
    // Treat that as "never split" rather than throwing, so any solved table
    // can actually be graded here.
    if (strategy.splits && strategy.splits[playerHand[0]] === 'SPLIT') {
      return playHand(
        playHand(playerChips, betAmmount, strategy, playerHand[0]),
        betAmmount, strategy, playerHand[0]
      )
    }
  }

  // Counted here rather than at the top because the split branch above throws
  // away what it dealt and re-enters this function twice, so each real hand
  // books its own stake exactly once.
  totalWagered += betAmmount

  // Naturals settle immediately, before any surrender/double/hit decision.
  const playerNatural = !splitCard && calcTotal(playerHand) === 21
  const dealerNatural = calcTotal(dealerHand) === 21

  if (playerNatural || dealerNatural) {
    if (playerNatural && dealerNatural) {
      return playerChips
    } else if (playerNatural) {
      return playerChips + (betAmmount * 1.5)
    } else {
      return playerChips - betAmmount
    }
  }

  if (playerWillHit(playerHand, dealerHand[0], strategy) === 'SURRENDER') {
    // console.log(playerHand, dealerHand)
    // console.log('Surrender')
    return playerChips - (betAmmount / 2)
  } else if (playerWillHit(playerHand, dealerHand[0], strategy) === 'DOUBLE') {
    playerHand.push(draw())
    totalWagered += betAmmount
    multiplyer = 2
  } else {
    while (playerWillHit(playerHand, dealerHand[0], strategy)) {
      playerHand.push(draw())
    }
  }

  while (dealerWillHit(dealerHand)) {
    dealerHand.push(draw())
  }

  const playerTotal = calcTotal(playerHand)
  const dealerTotal = calcTotal(dealerHand)

  // console.log(playerHand, dealerHand)
  // console.log(playerTotal, dealerTotal)

  let playerWon = false
  let playerTied = false

  if (playerTotal > 21) {
    playerWon = false
  } else if (dealerTotal > 21) {
    playerWon = true
  } else if (playerTotal === dealerTotal) {
    playerTied = true
  } else if (playerTotal > dealerTotal) {
    playerWon = true
  } else {
    playerWon = false
  }

  if (multiplyer === 2) {
    // console.log('Double')
  }

  if (playerWon) {
    // console.log('Win!')
    return playerChips + (betAmmount * multiplyer)
  } else if (playerTied) {
    // console.log('Push')
    return playerChips
  } else {
    // console.log('Lose')
    return playerChips - (betAmmount * multiplyer)
  }
}

const run = (strategy, handCount = 1000000, startingChips = 500, bet = 25) => {
  let chips = startingChips
  // let max = chips
  // let min = chips
  let count = handCount
  totalWagered = 0
  // Each run starts on a fresh shoe so runs do not inherit each other's count.
  reshuffle()

  // let goal = 100

  // while (chips > 0 && chips <= startingChips + goal) {
  // while (chips > 0) {
  while (count > 0) {
    // console.log(chips)
    // Between rounds only: a shoe is never reshuffled mid-hand.
    if (cutCardReached()) {
      reshuffle()
    }
    // The bet goes out before the cards do, off the count as it stood at the
    // end of the previous round.
    const wager = COUNTING ? bet * betRamp(trueCount()) : bet
    chips = playHand(chips, wager, strategy)
    // if (chips > max){
    //   max = chips
    // }
    // if (chips < min){
    //   min = chips
    // }
    count--
  }

  // console.log(chips)
  const profit = chips - startingChips
  // Table minimums won per round. With a flat bet this is the house edge
  // negated; with a spread it is what the seat is actually worth per hand.
  const edge = (profit / bet) / handCount

  if (COUNTING) {
    // Per round and per dollar are different questions once the ramp is on.
    // Per dollar is the bet-weighted edge: whether the money actually on the
    // table is favoured. Per round is that times the average bet, so it is the
    // larger number, and it is the one that decides whether the seat is worth
    // sitting in -- an edge you only get to bet a dollar on is not a living.
    console.log('avg bet: ', (totalWagered / handCount / bet).toFixed(3), 'units')
    console.log('per $:   ', (profit / totalWagered).toFixed(6))
  }

  // console.log('hands: ', handCount)
  // console.log('start: ', startingChips)
  // console.log('end: ', chips)
  // console.log('max: ', max)
  // console.log('min: ', min)
  console.log('edge: ', edge)

  return edge
}

const saveFile = async (filename, strategy) => {
  const jsonContent = JSON.stringify(strategy)
  await fs.promises.writeFile('evolutions/' + filename + '.json', jsonContent, 'utf8', (err) => {
    if (err) {
      console.log('An error occured while writing JSON Object to File.')
      return console.log(err)
    }
  })

  console.log('JSON file has been saved.')
}

const randomItem = (array) => array[Math.floor((Math.random() * array.length))]

// A spread multiplies the variance of the estimate along with the bet, so a
// counted run needs more hands than a flat one to say anything. Hence a knob.
const baselineCount = Number(process.argv[6]) || 10000000
const basicStrategy = JSON.parse(JSON.stringify(basic))
console.log('Shoe: ' + NUM_DECKS + ' decks, cut at ' + Math.round(PENETRATION * 100) + '%')
console.log('Bet:  ' + (COUNTING ? 'Hi-Lo, 1-12 spread' : 'flat'))
console.log('Establishing baseline')
const baselineEdge = run(basicStrategy, baselineCount)
console.log('baseline: ', baselineEdge)

const main = async (mutationLimit = 100, movesCountA = 500000, movesCountB = 1000000) => {
  let newBest = baselineEdge

  const moves = [true, false, 'DOUBLE', 'SURENDER']

  let currentGeneration = basicStrategy
  let changeWasMade = false

  for (let i = 0; i < mutationLimit; i++) {
    // pick random mutation
    const rand1 = Math.random() < 0.5 ? 'hard' : 'soft'
    const rand2 = randomItem(Object.keys(currentGeneration[rand1]))
    const rand3 = randomItem(Object.keys(currentGeneration[rand1][rand2]))

    let nextGeneration = currentGeneration

    for (let ii = 0; ii < moves.length; ii++) {
      if (currentGeneration[rand1][rand2][rand3] === moves[ii]) {
        // dont try same move thats already set
        continue
      }

      const movesCopy = JSON.parse(JSON.stringify(currentGeneration))
      console.log(rand1, rand2, rand3, movesCopy[rand1][rand2][rand3], '->', moves[ii])
      movesCopy[rand1][rand2][rand3] = moves[ii]

      // run simulation
      const edge = run(movesCopy, movesCountA)
      if (edge > newBest) {
        // edge must still be better after movesCountB hands for the mutation to pass
        const edge2 = run(movesCopy, movesCountB)

        if (edge2 > newBest) {
          changeWasMade = true
          nextGeneration = movesCopy
          newBest = edge2
          console.log('New best:', edge2)
        }
      }
    }
    currentGeneration = nextGeneration
    console.log(i)

    if (i === mutationLimit - 1 && !changeWasMade) {
      i = 0
    }
  }

  const finalEdge = run(currentGeneration, baselineCount)
  console.log('Starting edge: ' + baselineEdge)
  console.log('Ending edge: ' + finalEdge)

  if (finalEdge > baselineEdge) {
    await saveFile(finalEdge, currentGeneration)
  }
}

const iterate = async () => {
  const totalCount = 1000

  for (let j = 0; j < totalCount; j++) {
    // await main(100, 500000, 3000000)
    await main(5, 1000000, 5000000)
  }
}

// iterate()
