const playerMoves = require('./output.json')

const deckCards = [1,2,3,4,5,6,7,8,9,10,10,10,10]
const rand = (items) => items[Math.floor(Math.random()*items.length)]

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

const dealerWillHit = (cards) => {
  const choice = calcTotal(cards) < 17
  return choice
}

const playerWillHit = (cards, dealerCard) => {
  const handTotal = calcTotal(cards)
  if (handTotal >= 21){
    return false
  } else {
    const isSoft = handIsSoft(cards)
    if (isSoft){
      return playerMoves.soft[handTotal][dealerCard]
    } else {
      return playerMoves.hard[handTotal][dealerCard]
    }
  }
}

const playHand = (playerChips, betAmmount) => {
  const playerHand = [rand(deckCards), rand(deckCards)]
  const dealerHand = [rand(deckCards)]

  while (playerWillHit(playerHand, dealerHand[0])){
    playerHand.push(rand(deckCards))
  }

  while (dealerWillHit(dealerHand)){
    dealerHand.push(rand(deckCards))
  }

  const playerTotal = calcTotal(playerHand)
  const dealerTotal = calcTotal(dealerHand)

  console.log(playerHand, dealerHand)
  console.log(playerTotal, dealerTotal)
  
  let playerWon = false
  let playerTied = false
  let isBlackjack = false

  if (playerTotal === 21 && dealerTotal !== 21){
    isBlackjack = true
  }

  if (playerTotal > 21){
    playerWon = false
  } else if (dealerTotal > 21){
    playerWon = true
  } else if (playerTotal === dealerTotal){
    playerTied = false
  } else if (playerTotal > dealerTotal){
    playerWon = true
  } else {
    playerWon = false
  }

  if (isBlackjack){
    console.log('Blackjack!')
    return playerChips + (betAmmount * 1.5)
  } else if (playerWon){
    console.log('Win!')
    return playerChips + betAmmount
  } else if (playerTied) {
    console.log('Push')
    return playerChips
  } else {
    console.log('Lose')
    return playerChips - betAmmount
  }

}

const main = () => {
  let startingChips = 500
  let chips = startingChips
  let max = chips
  let min = chips
  let wins = 0
  let total = 0

  let maxHands = 1000
  let count = maxHands

  // let goal = 100

  // while (chips > 0 && chips <= startingChips + goal) {
  // while (chips > 0) {
  while (count > 0) {
    console.log(chips)
    const result = playHand(chips, 25)
    if (result > chips){
      wins++
      total++
    }
    if (result < chips){
      total++
    }
    chips = result
    if (chips > max){
      max = chips
    }
    if (chips < min){
      min = chips
    }
    count--
  }

  console.log(chips)

  console.log('hands: ', maxHands)
  console.log('start: ', startingChips)
  console.log('end: ', chips)
  console.log('max: ', max)
  console.log('min: ', min)
  console.log('edge: ', (((wins / total) * 2) - 1))
}

main()