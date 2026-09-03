const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
const ranks = [
  '2', '3', '4', '5', '6', '7', '8', '9', '10',
  'J', 'Q', 'K', 'A'
];

// Create a deck of 52 cards
function createDeck() {
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

// Shuffle the deck using Fisher-Yates algorithm
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Deal cards to players
function deal(deck, numPlayers, cardsPerPlayer) {
  const hands = Array.from({ length: numPlayers }, () => []);
  for (let i = 0; i < cardsPerPlayer; i++) {
    for (let j = 0; j < numPlayers; j++) {
      if (deck.length === 0) break;
      hands[j].push(deck.pop());
    }
  }
  return hands;
}

function dealCommunityCards(deck) {
  // Burn one card before flop, turn, river
  deck.pop(); // burn
  const flop = [deck.pop(), deck.pop(), deck.pop()];
  deck.pop(); // burn
  const turn = deck.pop();
  deck.pop(); // burn
  const river = deck.pop();
  return { flop, turn, river };
}

// Helper functions for hand evaluation
function cardValue(card) {
  return ranks.indexOf(card.rank);
}

function countRanks(cards) {
  const counts = {};
  for (const card of cards) {
    counts[card.rank] = (counts[card.rank] || 0) + 1;
  }
  return counts;
}

function countSuits(cards) {
  const counts = {};
  for (const card of cards) {
    counts[card.suit] = (counts[card.suit] || 0) + 1;
  }
  return counts;
}

function isStraight(values) {
  values = Array.from(new Set(values)).sort((a, b) => a - b);
  for (let i = 0; i <= values.length - 5; i++) {
    let straight = true;
    for (let j = 0; j < 4; j++) {
      if (values[i + j] + 1 !== values[i + j + 1]) {
        straight = false;
        break;
      }
    }
    if (straight) return values[i + 4];
  }
  // Special case: A-2-3-4-5
  if (values.includes(12) && values.slice(0, 4).join() === '0,1,2,3') return 3;
  return false;
}

function isFlush(cards) {
  const suitsCount = countSuits(cards);
  for (const suit in suitsCount) {
    if (suitsCount[suit] >= 5) {
      return cards.filter(card => card.suit === suit)
        .sort((a, b) => cardValue(b) - cardValue(a))
        .slice(0, 5);
    }
  }
  return false;
}

function getHandRank(cards) {
  // cards: array of 7 cards
  // Returns: [rank, highCardValue]
  // rank: 9=Royal Flush, 8=Straight Flush, 7=Four of a Kind, 6=Full House, 5=Flush, 4=Straight, 3=Three of a Kind, 2=Two Pair, 1=Pair, 0=High Card

  // Generate all 5-card combinations
  function combinations(arr, k) {
    if (k === 0) return [[]];
    if (arr.length === 0) return [];
    const [first, ...rest] = arr;
    const withFirst = combinations(rest, k - 1).map(comb => [first, ...comb]);
    const withoutFirst = combinations(rest, k);
    return withFirst.concat(withoutFirst);
  }

  let bestRank = 0;
  let bestValue = 0;
  let name = '';

  const comboSize = cards.length === 2 ? 2 : 5;
  for (const combo of combinations(cards, comboSize)) {
    const values = combo.map(cardValue).sort((a, b) => b - a);
    const ranksCount = countRanks(combo);
    const suitsCount = countSuits(combo);

    const isFlushHand = Object.values(suitsCount).some(c => c === 5);
    const straightHigh = isStraight(values);


    // Royal Flush
    if (isFlushHand && straightHigh === 12 && values.includes(8) && values.includes(9) && values.includes(10) && values.includes(11)) {
      if (9 > bestRank || (9 === bestRank && 12 > bestValue)) {
        bestRank = 9;
        bestValue = 12;
        name = 'Royal Flush';
        continue;
      }
    }
    // Straight Flush
    if (isFlushHand && straightHigh !== false) {
      if (8 > bestRank || (8 === bestRank && straightHigh > bestValue)) {
        bestRank = 8;
        bestValue = straightHigh;
        name = 'Straight Flush';
        continue;
      }
    }
    // Four of a Kind
    if (Object.values(ranksCount).includes(4)) {
      const quadRank = ranks.indexOf(Object.keys(ranksCount).find(r => ranksCount[r] === 4));
      if (7 > bestRank || (7 === bestRank && quadRank > bestValue)) {
        bestRank = 7;
        bestValue = quadRank;
        name = 'Four of a Kind';
        continue;
      }
    }
    // Full House
    if (Object.values(ranksCount).includes(3) && Object.values(ranksCount).includes(2)) {
      const tripleRank = ranks.indexOf(Object.keys(ranksCount).find(r => ranksCount[r] === 3));
      if (6 > bestRank || (6 === bestRank && tripleRank > bestValue)) {
        bestRank = 6;
        bestValue = tripleRank;
        name = 'Full House';
        continue;
      }
    }
    // Flush
    if (isFlushHand) {
      if (5 > bestRank || (5 === bestRank && values[0] > bestValue)) {
        bestRank = 5;
        bestValue = values[0];
        name = 'Flush';
        continue;
      }
    }
    // Straight
    if (straightHigh !== false) {
      if (4 > bestRank || (4 === bestRank && straightHigh > bestValue)) {
        bestRank = 4;
        bestValue = straightHigh;
        name = 'Straight';
        continue;
      }
    }
    // Three of a Kind
    if (Object.values(ranksCount).includes(3)) {
      const tripleRank = ranks.indexOf(Object.keys(ranksCount).find(r => ranksCount[r] === 3));
      if (3 > bestRank || (3 === bestRank && tripleRank > bestValue)) {
        bestRank = 3;
        bestValue = tripleRank;
        name = 'Three of a Kind';
        continue;
      }
    }
    // Two Pair
    const pairs = Object.keys(ranksCount).filter(r => ranksCount[r] === 2).map(r => ranks.indexOf(r));
    if (pairs.length === 2) {
      const highPair = Math.max(...pairs);
      if (2 > bestRank || (2 === bestRank && highPair > bestValue)) {
        bestRank = 2;
        bestValue = highPair;
        name = 'Two Pair';
        continue;
      }
    }
    // One Pair
    if (pairs.length === 1) {
      if (1 > bestRank || (1 === bestRank && pairs[0] > bestValue)) {
        bestRank = 1;
        bestValue = pairs[0];
        name = 'One Pair';
        continue;
      }
    }
    // High Card
    // Adjust bestRank to be fractional between 0-1 by card rank (highest card value / 12)
    const fractionalRank = values[0] / 12;
    if (fractionalRank > bestRank || (fractionalRank === bestRank && values[0] > bestValue)) {
      bestRank = fractionalRank.toPrecision(2);
      bestValue = values[0];
      name = 'High Card';
      continue;
    }
  }
  return [bestRank, bestValue, name];
}

function getHandValue(hand, community) {
  const allCards = hand.concat(community.flop, community.turn, community.river);
  return getHandRank(allCards.filter(card => card !== null));
}

// Simulate betting round with call, raise, or fold logic
function bettingRound(roundName, hands, communityCards) {
  console.log(`--- ${roundName} Betting Round ---`);
  let activePlayers = [0, 1, 2, 3];
  let currentBet = 0;
  let roundBets = [0, 0, 0, 0];
  let folded = [false, false, false, false];
  let actionTaken = true;

  while (actionTaken) {
    actionTaken = false;
    for (let i = 0; i < playerNames.length; i++) {
      if (folded[i]) continue;
      // Evaluate hand strength
      const [rank, value] = getHandValue(hands[i], communityCards);

      // Decide action based on expected value and current bet
      let action;
      // Calculate expected value: rank normalized (0-1), plus high card bonus
      let expectedValue = Number(rank) / 9 + value / 12;

      // Track if player has raised this round
      if (!bettingRound.hasRaised) bettingRound.hasRaised = [false, false, false, false];

      // Skip betting if player has already folded
      if (folded[i]) {
        continue;
      }

      // Pre-Flop: only call/raise with above-average hands, otherwise fold if bet is high
      if (roundName === 'Pre-Flop') {
        if (expectedValue < 0.35 && currentBet > 0) {
          action = 'fold';
        } else if (
          expectedValue > 0.6 &&
          chips[i] > currentBet - roundBets[i] + 50 &&
          !bettingRound.hasRaised[i]
        ) {
          action = 'raise';
          bettingRound.hasRaised[i] = true;
        } else {
          action = 'call';
        }
      } else {
        // Post-Flop/Turn/River: require much stronger hands to call/raise
        if (expectedValue < 0.7 && currentBet > 0) {
          action = 'fold';
        } else if (
          expectedValue > 0.85 &&
          chips[i] > currentBet - roundBets[i] + 50 &&
          !bettingRound.hasRaised[i]
        ) {
          action = 'raise';
          bettingRound.hasRaised[i] = true;
        } else {
          action = 'call';
        }
      }

      if (action === 'fold') {
        folded[i] = true;
        activePlayers = activePlayers.filter(idx => idx !== i);
        console.log(`${playerNames[i]} folds.`);
        actionTaken = true;
      } else if (action === 'raise') {
        let raiseAmount = currentBet + 50;
        let bet = Math.min(raiseAmount - roundBets[i], chips[i]);
        chips[i] -= bet;
        roundBets[i] += bet;
        bets[i] += bet;
        pot.total += bet;
        currentBet = roundBets[i];
        console.log(`${playerNames[i]} raises to ${currentBet} (hand: ${rank}, value: ${value})`);
        actionTaken = true;
      } else if (action === 'call') {
        let callAmount = currentBet - roundBets[i];
        let bet = Math.min(callAmount, chips[i]);
        chips[i] -= bet;
        roundBets[i] += bet;
        bets[i] += bet;
        pot.total += bet;
        console.log(`${playerNames[i]} calls ${currentBet} (hand: ${rank}, value: ${value})`);
      }
    }
  }
  console.log('Bets:', bets);
  console.log('Pot:', pot.total);
  console.log('Folded:', folded);
}

// Showdown and payout
function showdown(hands, communityCards) {
  const scores = hands.map(hand => getHandValue(hand, communityCards));
  // Compare by rank, then by high card
  const maxRank = Math.max(...scores.map(s => s[0]));
  const candidates = scores
    .map((score, idx) => (score[0] === maxRank ? idx : -1))
    .filter(idx => idx !== -1);

  let maxValue = Math.max(...candidates.map(idx => scores[idx][1]));
  const winners = candidates.filter(idx => scores[idx][1] === maxValue);

  const payout = Math.floor(pot.total / winners.length);
  winners.forEach(idx => {
    chips[idx] += payout;
    console.log(`${playerNames[idx]} wins ${payout} chips!`);
    console.log(`${playerNames[idx]}'s hand:`, scores[idx][2]);
  });
  console.log('Final chip counts:', chips);
}

const playerNames = ['Alice', 'Bob', 'Charlie', 'Diana'];
const chips = [1000, 1000, 1000, 1000];
const bets = [0, 0, 0, 0];
const pot = { total: 0 };

function startGame() {
  const deck = shuffle(createDeck());
  const hands = deal(deck, 4, 2); // 4 players, 2 cards each
  const communityCards = { flop: [], turn: null, river: null };

  console.log('Player Hands:', hands.map((hand, idx) => ({ name: playerNames[idx], ...hand })));

  // Pre-flop betting
  bettingRound('Pre-Flop', hands, communityCards);

  // Flop
  deck.pop(); // burn
  communityCards.flop = [deck.pop(), deck.pop(), deck.pop()];
  console.log('Flop:', communityCards.flop);
  bettingRound('Flop', hands, communityCards);

  // Turn
  deck.pop(); // burn
  communityCards.turn = deck.pop();
  console.log('Turn:', communityCards.turn);
  bettingRound('Turn', hands, communityCards);

  // River
  deck.pop(); // burn
  communityCards.river = deck.pop();
  console.log('River:', communityCards.river);
  bettingRound('River', hands, communityCards);

  // Showdown
  showdown(hands, communityCards);
}

startGame();