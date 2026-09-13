const { spawnSync } = require('child_process')
const { join } = require('path')

const subject = process.argv[2]
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'))
const root = join(__dirname, '..')

const seedPath = join(__dirname, 'seed.js')
const run = (args) => spawnSync('node', ['-r', seedPath, ...args], { cwd: root, encoding: 'utf8', timeout: 120000 })

const parseEdge = (out) => {
  const m = out.match(/edge:\s*([-\d.eE+]+)/)
  return m ? Number(m[1]) : null
}

const band = (value, lo, hi) => value !== null && value >= lo && value <= hi

const checkBasicEdge = () => {
  const hands = input.hands || 300000
  const r = run(['blackjack.js', 'basic.json', '6', '0.75', 'flat', String(hands)])
  const edge = parseEdge(r.stdout)
  if (r.status !== 0) return { pass: false, reason: `simulator exited ${r.status}: ${r.stderr || r.stdout}`.trim() }
  if (edge === null) return { pass: false, reason: 'no edge reported' }
  if (!band(edge, -0.03, 0.015)) {
    return { pass: false, reason: `flat-bet edge against published basic strategy is ${edge.toFixed(4)}, outside [-0.03, 0.015]` }
  }
  return { pass: true, reason: `edge ${edge.toFixed(4)}` }
}

const checkSolverGrade = () => {
  const hands = input.hands || 300000
  const r = run(['blackjack.js', 'output.json', '1', '0.5', 'flat', String(hands)])
  const edge = parseEdge(r.stdout)
  if (r.status !== 0) return { pass: false, reason: `grading a solved table threw: ${(r.stderr || r.stdout).trim().split('\n').pop()}` }
  if (edge === null) return { pass: false, reason: 'no edge reported' }
  if (!band(edge, -0.03, 0.01)) {
    return { pass: false, reason: `solved table grades at ${edge.toFixed(4)}, outside [-0.03, 0.01]` }
  }
  return { pass: true, reason: `solved table grades at ${edge.toFixed(4)}` }
}

const checkMontyHall = () => {
  const r = run(['deal.js'])
  if (r.status !== 0) return { pass: false, reason: `monty hall sim exited ${r.status}` }
  const percents = [...r.stdout.matchAll(/Win percent:\s*([0-9.]+)/g)].map(m => Number(m[1]))
  if (percents.length < 2) return { pass: false, reason: 'no win percents reported' }
  const [keep, change] = percents
  if (!band(keep, 0.32, 0.35)) return { pass: false, reason: `keep win rate ${keep.toFixed(4)} outside [0.32, 0.35] (theory 1/3)` }
  if (!band(change, 0.65, 0.68)) return { pass: false, reason: `switch win rate ${change.toFixed(4)} outside [0.65, 0.68] (theory 2/3)` }
  if (change <= keep) return { pass: false, reason: `switching does not beat keeping (${change.toFixed(4)} vs ${keep.toFixed(4)})` }
  return { pass: true, reason: `keep ${keep.toFixed(4)}, switch ${change.toFixed(4)}` }
}

const checkTexas = () => {
  const r = run(['texas.js'])
  if (r.status !== 0) {
    const fails = (r.stdout.match(/^FAIL.*$/gm) || []).join('; ')
    return { pass: false, reason: `texas self-check failed (${fails || r.stderr})` }
  }
  return { pass: true, reason: 'all texas self-checks passed' }
}

const subjects = {
  'basic-edge': checkBasicEdge,
  'solver-grade': checkSolverGrade,
  'monty-hall': checkMontyHall,
  'texas-selfcheck': checkTexas
}

if (!subjects[subject]) {
  console.error(`unknown subject: ${subject}`)
  process.exit(2)
}

const result = subjects[subject]()
console.log(result.pass ? 'OK' : result.reason)
process.exit(result.pass ? 0 : 1)
