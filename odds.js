const fs = require('fs')
const winOdds = {}

const hands = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
const deckCards = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10]

// memoized strategy tables
const playerShouldHitHard = {}
const playerShouldHitSoft = {}

// memoized hand outcomes
const dealerOutcomes = {}

// // does not factor cards in dealer & players hands combined
// const NUMBER_OF_DECKS = 4

const sortObject = o => Object.keys(o).sort().reduce((r, k) => (r[k] = o[k], r), {})
const average = (array) => array.reduce((a, b) => a + b) / array.length

// const getDeck = (cards) => {
//   const counts = {}

//   for (const num of cards) {
//     counts[num] = counts[num] ? counts[num] + 1 : 1;
//   }

//   return deckCards.filter(c => !counts[c] || counts[c] < NUMBER_OF_DECKS * 4)
// }
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

const calcHandOutcomes = (handCards, willHit, hitFirstTime = false, dealerCard = null) => {
  const handOutcomes = []
  if (handCards.length === 1 || hitFirstTime || willHit(handCards, dealerCard)) {
    // const deck = getDeck(handCards)
    for (let nextCard of deckCards) {
      const result = calcHandOutcomes([
        ...handCards,
        nextCard
      ],
      willHit,
      false,
      dealerCard
      )
      handOutcomes.push(result)
    }
  } else {
    const handTotal = calcTotal(handCards)
    handOutcomes.push(handTotal)
  }

  return handOutcomes
}

const compareOutcome = (playerTotal, dealerTotal) => {
  let result = 0

  if (playerTotal > 21) {
    result = 0
  } else if (dealerTotal > 21) {
    result = 1
  } else if (playerTotal === dealerTotal) {
    result = 0.5
  } else if (playerTotal > dealerTotal) {
    result = 1
  } else {
    result = 0
  }

  return result
}

const calcOdds = (playerOutcomes, dealerOutcomes) => {
  const results = []

  for (let playerTotal of playerOutcomes) {
    for (let dealerTotal of dealerOutcomes) {
      if (!Array.isArray(playerTotal) && !Array.isArray(dealerTotal)) {
        results.push(compareOutcome(playerTotal, dealerTotal))
      } else {
        results.push(calcOdds(
          playerTotal.length ? playerTotal : [playerTotal],
          dealerTotal.length ? dealerTotal : [dealerTotal]
        ))
      }
    }
  }

  return (average(results))
}

const processPlayerHand = (card1, card2, dealerCard1) => {
  // hit
  const playerWillHit = (cards, dealerCard) => {
    const handTotal = calcTotal(cards)
    if (handTotal >= 21) {
      return false
    } else if (handTotal < 12) {
      return true
    } else {
      const isSoft = handIsSoft(cards)
      if (isSoft) {
        return playerShouldHitSoft[handTotal][dealerCard]
      } else {
        return playerShouldHitHard[handTotal][dealerCard]
      }
    }
  }
  const hitOutcomes = calcHandOutcomes([card1, card2], playerWillHit, true, dealerCard1)
  return hitOutcomes
}

const processPlayerDouble = (card1, card2) => {
  const playerWillHit = () => false
  const hitOutcomes = calcHandOutcomes([card1, card2], playerWillHit, true)
  return hitOutcomes
}

const processDealerHand = (dealerCard1) => {
  const dealerWillHit = (cards) => {
    const choice = calcTotal(cards) < 17
    return choice
  }
  const dealerOutcomes = calcHandOutcomes([dealerCard1], dealerWillHit)
  return dealerOutcomes
}

const processHand = (card1, card2, dealerCard1) => {
  // dealer
  if (!dealerOutcomes?.[dealerCard1]) {
    const outcomes = processDealerHand(dealerCard1)
    dealerOutcomes[dealerCard1] = outcomes
  }

  const playerHitOutcomes = processPlayerHand(card1, card2, dealerCard1)
  const playerDoubleOutcomes = processPlayerDouble(card1, card2)

  const handTotal = calcTotal([card1, card2])

  // console.log([card1, card2], dealerCard1)
  const standWinOdds = calcOdds([handTotal], dealerOutcomes?.[dealerCard1])
  const hitWinOdds = calcOdds(playerHitOutcomes, dealerOutcomes?.[dealerCard1])
  const doubleWinOdds = calcOdds(playerDoubleOutcomes, dealerOutcomes?.[dealerCard1])

  // console.log(standWinOdds, hitWinOdds)

  const isSoft = handIsSoft([card1, card2])
  const softString = isSoft ? 'Soft' : 'Hard'

  // calcOdds scores a win 1, a push 0.5 and a loss 0, so its result `s` is not
  // money. Converting is exact, pushes included: EV = 2s - 1, in bet units.
  // Every decision below has to be made on that scale, because the payouts
  // differ per action -- doubling stakes two units, surrender forfeits half of
  // one -- and those factors are invisible in `s`.
  const standEV = 2 * standWinOdds - 1
  const hitEV = 2 * hitWinOdds - 1
  const doubleEV = 2 * (2 * doubleWinOdds - 1)

  const playerShouldHit = hitEV > standEV
  const playerShouldDouble = doubleEV > Math.max(standEV, hitEV)

  // Surrender pays a flat -0.5, so it wins only when every line you could
  // actually play is worth less than that.
  const shouldSurrender = Math.max(standEV, hitEV, doubleEV) < -0.5

  if (!playerShouldHitSoft[handTotal]) {
    playerShouldHitSoft[handTotal] = {}
  }
  if (!playerShouldHitHard[handTotal]) {
    playerShouldHitHard[handTotal] = {}
  }

  // console.log(softString, handTotal, dealerCard1, playerShouldHit)

  const playedMove = playerShouldDouble ? 'D' : (playerShouldHit ? 'H' : 'S')
  const correctMove = shouldSurrender ? 'R>' + playedMove : playedMove
  const incorrectMove = playerShouldHit ? 'S' : 'H'
  // Reported in EV now, so the numbers are comparable across actions.
  const correctOdds = shouldSurrender
    ? -0.5
    : (playerShouldDouble ? doubleEV : (playerShouldHit ? hitEV : standEV))
  const incorrectOdds = playerShouldHit ? standEV : hitEV

  const moveValue = shouldSurrender
    ? 'SURRENDER'
    : (playerShouldDouble ? 'DOUBLE' : playerShouldHit)

  if (isSoft) {
    playerShouldHitSoft[handTotal][dealerCard1] = moveValue
  } else {
    playerShouldHitHard[handTotal][dealerCard1] = moveValue
  }

  if (!winOdds[softString + ': ' + handTotal]) {
    winOdds[softString + ': ' + handTotal] = {}
  }

  winOdds[softString + ': ' + handTotal][dealerCard1] = [correctMove, correctOdds, incorrectMove, incorrectOdds]
}

const main = () => {
  console.log('Calculating Odds:')

  for (let card1 of hands) {
    for (let card2 of hands) {
      for (let dealerCard1 of hands) {
        processHand(card1, card2, dealerCard1)
      }
    }
  }

  console.log(sortObject(winOdds))

  // const allProbabilities = []
  // Object.values(winOdds).forEach(total => Object.values(total).forEach(decison => allProbabilities.push(decison[1])))

  // console.log('Theoretical Edge = ', (average(allProbabilities) - 0.5))

  const output = {
    hard: playerShouldHitHard,
    soft: playerShouldHitSoft
  }

  const jsonContent = JSON.stringify(output)
  fs.writeFile('output.json', jsonContent, 'utf8', function (err) {
    if (err) {
      console.log('An error occured while writing JSON Object to File.')
      return console.log(err)
    }

    console.log('JSON file has been saved.')
  })
}

main()
