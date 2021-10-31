const standOdds = {}
const hitOdds = {}
const winOdds = {}

const hands = [10,9,8,7,6,5,4,3,2,1]
const deckCards = [1,2,3,4,5,6,7,8,9,10,10,10,10]

// memoized strategy tables
const playerShouldHitHard = {}
const playerShouldHitSoft = {}

// memoized hand outcomes
const dealerOutcomes = {}

// // does not factor cards in dealer & players hands combined
// const NUMBER_OF_DECKS = 4

// const getDeck = (cards) => {
//   const counts = {}

//   for (const num of cards) {
//     counts[num] = counts[num] ? counts[num] + 1 : 1;
//   }

//   return deckCards.filter(c => !counts[c] || counts[c] < NUMBER_OF_DECKS * 4)
// }

const calcTotal = (cards) => {
  const reducer = (previousValue, currentValue, currentIndex, array) => {
    let nextValue = currentValue
    if (currentValue === 1 && currentIndex == array.length - 1) {
      if (previousValue + 11 <= 21){
        nextValue = 11
      }
    }
    return previousValue + nextValue
  }
  const result = [...cards].sort().reverse().reduce(reducer)
  return result
}

const handIsSoft = (cards) => {
  const numberOfAces = cards.filter(c => c == 1).length
  if (numberOfAces > 0){
    const sum = (previousValue, currentValue) => previousValue + currentValue

    const handTotal = calcTotal(cards)
    const naiveTotal = cards.reduce(sum)

    return handTotal > naiveTotal
  } else {
    return false
  }
}

const calcHandOutcomes = (handCards, willHit, hitFirstTime = false, dealerCard = null) => {
  let handOutcomes = []
  if (handCards.length === 1 || hitFirstTime || willHit(handCards, dealerCard)){
    // const deck = getDeck(handCards)
    for (nextCard of deckCards){
      handOutcomes = handOutcomes.concat(calcHandOutcomes([
        ...handCards,
        nextCard
      ], 
      willHit,
      false,
      dealerCard
      ))
    }
  } else {
    const handTotal = calcTotal(handCards)
    handOutcomes.push(handTotal)
  }

  return handOutcomes
}

const calcOdds = (playerOutcomes, dealerOutcomes) => {
  // const countsP = {}

  // for (const num of playerOutcomes) {
  //   countsP[num] = countsP[num] ? countsP[num] + 1 : 1;
  // }

  // const countsD = {}

  // for (const num of dealerOutcomes) {
  //   countsD[num] = countsD[num] ? countsD[num] + 1 : 1;
  // }

  // console.log(countsP, countsD)

  ////////// -----------------------------

  let winCount = 0
  let pushCount = 0
  let loseCount = 0

  for (playerTotal of playerOutcomes){
    for (dealerTotal of dealerOutcomes){
      if (playerTotal > 21){
        loseCount++
      } else if (dealerTotal > 21){
        winCount++
      } else if (playerTotal === dealerTotal){
        pushCount++
      } else if (playerTotal > dealerTotal){
        winCount++
      } else {
        loseCount++
      }
    }
  }

  // console.log(winCount, pushCount, loseCount)

  const total = winCount + loseCount
  // const total = winCount + pushCount + loseCount
  return winCount / total
  // return (winCount + pushCount) / total
}

const processPlayerHand = (card1, card2, dealerCard1) => {
  // hit
  const playerWillHit = (cards, dealerCard) => {
    const handTotal = calcTotal(cards)
    if (handTotal >= 21){
      return false
    } else {
      const isSoft = handIsSoft(cards)
      if (isSoft){
        return playerShouldHitSoft[handTotal][dealerCard]
      } else {
        return playerShouldHitHard[handTotal][dealerCard]
      }
    }
  }
  const hitOutcomes = calcHandOutcomes([card1, card2], playerWillHit, true, dealerCard1)
  return hitOutcomes
}

const processDealerHand = () => {
  const dealerWillHit = (cards) => {
    const choice = calcTotal(cards) < 17
    return choice
  }
  const dealerOutcomes = calcHandOutcomes([dealerCard1], dealerWillHit)
  return dealerOutcomes
}

const processHand = (card1, card2, dealerCard1) => {
  // dealer
  if (!dealerOutcomes?.[dealerCard1]){
    const outcomes = processDealerHand(dealerCard1)
    dealerOutcomes[dealerCard1] = outcomes
  }

  const playerOutcomes = processPlayerHand(card1, card2, dealerCard1)

  const handTotal = calcTotal([card1, card2])

  // console.log([card1, card2], dealerCard1)
  const standWinOrPushOdds = calcOdds([handTotal], dealerOutcomes?.[dealerCard1])
  const hitWinOrPushOdds = calcOdds(playerOutcomes, dealerOutcomes?.[dealerCard1])

  // console.log(standWinOrPushOdds, hitWinOrPushOdds)

  const isSoft = handIsSoft([card1, card2])
  const softString = isSoft ? 'Soft' : 'Hard'
  const playerShouldHit = hitWinOrPushOdds > standWinOrPushOdds

  if (!playerShouldHitSoft[handTotal]){
    playerShouldHitSoft[handTotal] = {}
  }
  if (!playerShouldHitHard[handTotal]){
    playerShouldHitHard[handTotal] = {}
  }

  // console.log(softString, handTotal, dealerCard1, playerShouldHit)

  if (isSoft) {
    playerShouldHitSoft[handTotal][dealerCard1] = playerShouldHit
  } else {
    playerShouldHitHard[handTotal][dealerCard1] = playerShouldHit
  }

  const correctMove = playerShouldHit ? 'H' : 'S'
  const correctOdds = playerShouldHit ? hitWinOrPushOdds : standWinOrPushOdds
  if (!winOdds[softString + ': ' + handTotal]){
    winOdds[softString + ': ' + handTotal] = {}
  }

  winOdds[softString + ': ' + handTotal][dealerCard1] = [correctMove, correctOdds]

  // standOdds[card1 + ', ' + card2][dealerCard1] = standWinOrPushOdds
  // hitOdds[card1 + ', ' + card2][dealerCard1] = hitWinOrPushOdds
}

const main = () => {
  console.log('Calculating Odds:')

  for (card1 of hands){
    for (card2 of hands){
      // standOdds[card1 + ', ' + card2] = {}
      // hitOdds[card1 + ', ' + card2] = {}
      // winOdds[card1 + ', ' + card2] = {}
      for (dealerCard1 of hands){
        processHand(card1, card2, dealerCard1)
      }
    }
  }

  const sortObject = o => Object.keys(o).sort().reduce((r, k) => (r[k] = o[k], r), {})

  console.log(sortObject(winOdds))

  const allProbabilities = []
  Object.values(winOdds).forEach(total => Object.values(total).forEach(decison => allProbabilities.push(decison[1])))

  const average = (array) => array.reduce((a, b) => a + b) / array.length;

  console.log('Theoretical Edge = ', (average(allProbabilities) - 0.5))

  // console.log('Stand')
  // console.log(standOdds)
  // console.log('Hit')
  // console.log(hitOdds)
}


main()