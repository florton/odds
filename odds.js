const standOdds = {}
const hitOdds = {}

const hands = [10,9,8,7,6,5,4,3,2,1]
const deckCards = [1,2,3,4,5,6,7,8,9,10,10,10,10]

// memoized strategy tables
const playerShouldHitHard = {}
const playerShouldHitSoft = {}

const NUMBER_OF_DECKS = 4
const getDeck = (cards) => {
  const counts = {}

  for (const num of cards) {
    counts[num] = counts[num] ? counts[num] + 1 : 1;
  }

  return deckCards.filter(c => !counts[c] || counts[c] < NUMBER_OF_DECKS * 4)
}

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
  return cards.sort().reverse().reduce(reducer)
}

const handIsSoft = (cards) => {
  let sortedCards = [...cards].sort().reverse()
  if (!sortedCards[sortedCards.length - 1] === 1){
    return false
  } else {
    let total = calcTotal(sortedCards)
    sortedCards.pop()
    let total2 = calcTotal(sortedCards)
    return total - total2 === 11
  }
}

const calcHandOutcomes = (handCards, willHit, hitFirstTime = false, index = 0) => {
  let handOutcomes = []
  if (handCards.length === 1 || willHit(handCards) || hitFirstTime){
    const deck = getDeck(handCards)
    for (nextCard of deck){
      handOutcomes = handOutcomes.concat(calcHandOutcomes([
        ...handCards,
        nextCard
      ], 
      willHit,
      false,
      index+1
      ))
    }
  } else {
    const handTotal = calcTotal(handCards)
    handOutcomes.push(handTotal)
  }
  return handOutcomes
}

const calcOdds = (playerOutcomes, dealerOutcomes) => {
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

  const total = winCount + pushCount + loseCount
  return (winCount + pushCount) / total
}

const processHand = (card1, card2, dealerCard1) => {
  // console.log(card1, card2, 'D: ', dealerCard1)

  // stand
  const standTotal = calcTotal([card1, card2])
  const isSoft = handIsSoft([card1, card2])

  // hit
  const playerWillHit = (cards) => {
    const handTotal = calcTotal(cards)
    if (handTotal >= 21){
      return false
    } else {
      const isSoft = handIsSoft(cards)
      // console.log('T', isSoft, playerShouldHitSoft[handTotal], playerShouldHitHard[handTotal])
      if (isSoft){
        return playerShouldHitSoft[handTotal]
      } else {
        return playerShouldHitHard[handTotal]
      }
    }
  }
  const hitOutcomes = calcHandOutcomes([card1, card2], playerWillHit, true)

  // console.log('H', hitOutcomes)

  // double
  // todo

  // dealer
  const dealerWillHit = (cards) => {
    return calcTotal(cards) < 17
  }
  const dealerOutcomes = calcHandOutcomes([dealerCard1], dealerWillHit)

  const standWinOrPushOdds = calcOdds([standTotal], dealerOutcomes)
  const hitWinOrPushOdds = calcOdds(hitOutcomes, dealerOutcomes)

  const playerShouldHit = hitWinOrPushOdds > standWinOrPushOdds
  if (isSoft) {
    playerShouldHitSoft[standTotal] = playerShouldHit
  } else {
    playerShouldHitHard[standTotal] = playerShouldHit
  }

  standOdds[card1][card2] = standWinOrPushOdds
  hitOdds[card1][card2] = hitWinOrPushOdds
}

const main = () => {
  for (card1 of hands){
    standOdds[card1] = {}
    hitOdds[card1] = {}
    for (card2 of hands){
      for (dealerCard1 of hands){
        processHand(card1, card2, dealerCard1)
      }
    }
  }

  console.log('Stand')
  console.log(standOdds)
  console.log('Hit')
  console.log(hitOdds)
}

main()