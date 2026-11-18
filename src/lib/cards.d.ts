export interface Card { edge: string; fails: string }
export const CARDS: Record<string, Card>
export function cardFor(kind: string | undefined): Card | null
