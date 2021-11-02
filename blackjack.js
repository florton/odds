const fs = require('fs')

// const playerMoves = require('./output.json')
// const playerMoves = require('./outputS.json')
const basic = require('./basic.json')

let playerMoves = null

const deckCards = [1,2,3,4,5,6,7,8,9,10,10,10,10]
const rand = (items) => items[Math.floor(Math.random()*items.length)]

// memo
const preCalcedTotals = {}

const calcTotal = (cards) => {
  if (preCalcedTotals[cards.toString()]){
    return preCalcedTotals[cards.toString()]
  }

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

  preCalcedTotals[cards.toString()] = result
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
  let multiplyer = 1

  if (playerWillHit(playerHand, dealerHand[0]) === 'SURRENDER') {
    // console.log(playerHand, dealerHand)
    // console.log('Surrender')
    return playerChips - (betAmmount / 2)
  } else if (playerWillHit(playerHand, dealerHand[0]) === 'DOUBLE') {
    playerHand.push(rand(deckCards))
    multiplyer = 2
  } else {
    while (playerWillHit(playerHand, dealerHand[0])){
      playerHand.push(rand(deckCards))
    }
  }

  while (dealerWillHit(dealerHand)){
    dealerHand.push(rand(deckCards))
  }

  const playerTotal = calcTotal(playerHand)
  const dealerTotal = calcTotal(dealerHand)

  // console.log(playerHand, dealerHand)
  // console.log(playerTotal, dealerTotal)
  
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

  if(multiplyer === 2){
    // console.log('Double')
  }

  if (isBlackjack){
    // console.log('Blackjack!')
    return playerChips + (betAmmount * 1.5 * multiplyer)
  } else if (playerWon){
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

const run = (handCount = 1000000, startingChips = 500, bet = 25) => {
  let chips = startingChips
  // let max = chips
  // let min = chips
  let count = handCount

  // let goal = 100

  // while (chips > 0 && chips <= startingChips + goal) {
  // while (chips > 0) {
  while (count > 0) {
    // console.log(chips)
    const result = playHand(chips, bet)
    chips = result
    // if (chips > max){
    //   max = chips
    // }
    // if (chips < min){
    //   min = chips
    // }
    count--
  }

  // console.log(chips)
  const edge = ((chips - startingChips) / bet)/ handCount

  // console.log('hands: ', handCount)
  // console.log('start: ', startingChips)
  // console.log('end: ', chips)
  // console.log('max: ', max)
  // console.log('min: ', min)
  console.log('edge: ', edge)

  return edge
}

const saveFile = (filename, strategy) => {
  const jsonContent = JSON.stringify(strategy);
  fs.writeFile('evolutions/' + filename + ".json", jsonContent, 'utf8', function (err) {
    if (err) {
        console.log("An error occured while writing JSON Object to File.");
        return console.log(err);
    }
 
    console.log("JSON file has been saved.");
  })
}

const randomItem = (array) => array[Math.floor((Math.random()*array.length))]

const main = (mutationLimit = 100, movesCountA = 500000, movesCountB = 3000000) => {
  playerMoves = basic
  const baseline = run()
  let newBest = baseline

  const moves = [true, false, 'DOUBLE', 'SURENDER']

  for (i=0; i<mutationLimit; i++) {
    let currentGeneration = playerMoves
    // pick random mutation
    const rand1 = Math.random() < 0.5 ? 'hard' : 'soft'
    const rand2 = randomItem(Object.keys(currentGeneration[rand1]))
    const rand3 = randomItem(Object.keys(currentGeneration[rand1][rand2]))
   
    let nextGeneration = currentGeneration

    for(ii=0; ii<moves.length; ii++){
      const movesCopy = JSON.parse(JSON.stringify(currentGeneration))
      console.log(rand1, rand2, rand3, movesCopy[rand1][rand2][rand3], '->', moves[ii])
      movesCopy[rand1][rand2][rand3] = moves[ii]

      // run simulation
      let edge = run(movesCountA)
      if (edge > newBest){
        // edge must still be better after movesCountB hands for the mutation to pass
        const edge2 = run(movesCountB)

        if (edge2 > newBest){
          nextGeneration = movesCopy
          newBest = edge
          console.log('New best:', edge)
        }
      }      
    }
    playerMoves = nextGeneration
    console.log(i)
  }

  const finalEdge = run(10000000)
  saveFile(finalEdge, playerMoves)

  console.log('Starting edge: ' + baseline)
  console.log('Ending edge: ' + finalEdge)

}

main()