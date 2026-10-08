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

declare module 'claude-code' {
  interface PluginState {
    roulette: { game: Game }
  }
}
