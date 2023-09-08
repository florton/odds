const numRuns = 10000000

const check = (c) => {
  return c.value ? 1 : 0
}

const keepChoice = (c, a) => {
  return check(c)
}

const changeChoice = (c, a) => {
  r = a.findIndex(x => !x.value && x.id !== c.id)
  b = a.filter((x, i) => i !== r && x.id !== c.id)
  return check(b[0])
}

const run = () => {
  let keepWins = 0
  let changeWins = 0

  let i = 0
  while (i < numRuns){
    let a = [
      {id: 0, value: false},
      {id: 1, value: false},
      {id: 2, value: false}
    ]
    a[Math.floor(Math.random()*a.length)].value = true
    let c = a[Math.floor(Math.random()*a.length)]

    keepWins += keepChoice(c, a)
    changeWins += changeChoice(c, a)
    i++
  }

  console.log("Total Iterations:", numRuns)
  console.log("Keep wins:", keepWins)
  console.log("Win percent:", keepWins / numRuns)
  console.log("Change wins:", changeWins)
  console.log("Win percent:", changeWins / numRuns)
}

run()