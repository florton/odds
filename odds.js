const standOdds = {}
const hitOdds = {}
const winOdds = {}

const hands = [10,9,8,7,6,5,4,3,2,1]
const deckCards = [1,2,3,4,5,6,7,8,9,10,10,10,10]

// memoized strategy tables
const playerShouldHitHard = {}
const playerShouldHitSoft = {}

// memoized hand outcomes
const playerOutcomes = {}
const dealerOutcomes = {}

// does not factor cards in dealer & players hands combined
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

const calcHandOutcomes = (handCards, willHit, hitFirstTime = false, isPlayer = false) => {
  // if(isPlayer){
  //   console.log(handCards)
  // }
  let handOutcomes = []
  if (handCards.length === 1 || hitFirstTime || willHit(handCards)){
    if (isPlayer){
      console.log('Hit', handCards)
    }
    const deck = getDeck(handCards)
    for (nextCard of deck){
      handOutcomes = handOutcomes.concat(calcHandOutcomes([
        ...handCards,
        nextCard
      ], 
      willHit,
      false,
      isPlayer
      ))
    }
  } else {
    if (isPlayer){
      console.log('Stay', handCards)
    }
    const handTotal = calcTotal(handCards)
    handOutcomes.push(handTotal)
  }
  
  if (isPlayer){
    const countsP = {}

    for (const num of handOutcomes) {
      countsP[num] = countsP[num] ? countsP[num] + 1 : 1;
    }
  
    console.log(countsP)
  }

  return handOutcomes
}

const calcOdds = (playerOutcomes, dealerOutcomes) => {
  // console.log(playerOutcomes.length, dealerOutcomes.length)

  // const countsP = {}

  // for (const num of playerOutcomes) {
  //   countsP[num] = countsP[num] ? countsP[num] + 1 : 1;
  // }

  // const countsD = {}

  // for (const num of dealerOutcomes) {
  //   countsD[num] = countsD[num] ? countsD[num] + 1 : 1;
  // }

  // console.log(countsP)
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

  const total = winCount + pushCount + loseCount
  return (winCount + pushCount) / total
}

const processPlayerHand = (card1, card2) => {
  // hit
  const playerWillHit = (cards) => {
    const handTotal = calcTotal(cards)
    if (handTotal >= 21){
      return false
    } else {
      const isSoft = handIsSoft(cards)
      if (isSoft){
        return playerShouldHitSoft[handTotal]
      } else {
        return playerShouldHitHard[handTotal]
      }
    }
  }
  const logPlayerWillHit = (cards) => {
    const result = playerWillHit(cards)
    // console.log(cards, result)
    return result
  }
  const hitOutcomes = calcHandOutcomes([card1, card2], logPlayerWillHit, true, true)
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
  // player
  if (!playerOutcomes?.[card1]?.[card2]){
    // console.log(card1, card2)
    const outcomes = processPlayerHand(card1, card2)
    playerOutcomes[card1][card2] = outcomes
    playerOutcomes[card2][card1] = outcomes
  }

  // dealer
  if (!dealerOutcomes?.[dealerCard1]){
    const outcomes = processDealerHand(dealerCard1)
    dealerOutcomes[dealerCard1] = outcomes
  }

  const handTotal = calcTotal([card1, card2])

  // console.log([card1, card2, dealerCard1], playerOutcomes?.[card1]?.[card2].length, dealerOutcomes?.[dealerCard1].length)
  const standWinOrPushOdds = calcOdds([handTotal], dealerOutcomes?.[dealerCard1])
  const hitWinOrPushOdds = calcOdds(playerOutcomes?.[card1]?.[card2], dealerOutcomes?.[dealerCard1])

  // console.log(standWinOrPushOdds, hitWinOrPushOdds)

  const playerShouldHit = hitWinOrPushOdds > standWinOrPushOdds

  const correctMove = playerShouldHit ? 'H' : 'S'
  const correctOdds = playerShouldHit ? hitWinOrPushOdds : standWinOrPushOdds
  winOdds[card1 + ', ' + card2][dealerCard1] = [correctMove, correctOdds]

  if (handIsSoft([card1, card2])) {
    playerShouldHitSoft[handTotal] = playerShouldHit
  } else {
    playerShouldHitHard[handTotal] = playerShouldHit
  }

  // standOdds[card1 + ', ' + card2][dealerCard1] = standWinOrPushOdds
  // hitOdds[card1 + ', ' + card2][dealerCard1] = hitWinOrPushOdds
}

const main = () => {
  console.log('Calculating Odds:')

  for (card1 of hands){
    for (card2 of hands){
      // standOdds[card1 + ', ' + card2] = {}
      // hitOdds[card1 + ', ' + card2] = {}
      winOdds[card1 + ', ' + card2] = {}
      playerOutcomes[card1] = {}
      playerOutcomes[card2] = {}
      for (dealerCard1 of hands){
        processHand(card1, card2, dealerCard1)
      }
    }
  }

  // console.log(winOdds)

  // console.log('Stand')
  // console.log(standOdds)
  // console.log('Hit')
  // console.log(hitOdds)
}


main()