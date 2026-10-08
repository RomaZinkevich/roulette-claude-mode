export type Pick = 'red' | 'black' | 'green'

export type Bet = number | 'all'

export type Spin = {
  pick: Pick
  stake: number
  result: number
  from: number
  distance: number
  frame: number
}

export type Outcome = { result: number; pick: Pick; stake: number; delta: number }

export type Game = {
  balance: number
  bet: Bet
  pointer: number
  spin: Spin | null
  last: Outcome | null
  isBust: boolean
}

// Death mode: no money, red or black, one guess. It is all bluff — a wrong
// guess plays a fake "deleting everything" scene and touches nothing.
// 'armed' waits for the guess, 'spinning' turns the wheel, 'wrong' reveals a
// losing colour, 'doom' runs the fake deletion, 'reprieve' owns up to it,
// 'survived' is the clean win.
export type DeathPhase =
  | 'armed'
  | 'spinning'
  | 'wrong'
  | 'doom'
  | 'reprieve'
  | 'survived'

export type Death = {
  phase: DeathPhase
  pick: Pick | null
  // The pocket the wheel lands on (red or black, never green); null unspun.
  result: number | null
  // Where the wheel starts and how far it turns, like a normal spin.
  from: number
  distance: number
  frame: number
}

declare module 'claude-code' {
  interface PluginState {
    roulette: { game: Game; isMuted: boolean; death: Death | null }
  }
}
