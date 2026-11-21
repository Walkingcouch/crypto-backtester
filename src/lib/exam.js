// The sealed exam. A fixed stretch of recent history that NOTHING is chosen or tuned on: every
// lab's training, held-back check, professional checks, walk-forward and the Explorer's breeding
// only ever use trades that finished before the seal starts. A rule that passes all of those then
// sits the exam ONCE: its trades inside the sealed window are scored and the result is recorded for
// good (state.exams). A later re-test never re-scores it, so the exam can't be "studied for".
// Passing needs at least 10 trades in the window and a profit after costs.
export const SEAL = { start: Date.UTC(2026, 6, 1), end: Date.UTC(2026, 10, 21) }   // 1 Jul – 21 Nov 2026
export const EXAM_MIN = 10

/** Trades that were finished before the seal: the only ones any choosing may use. */
export const preSeal = (ev, seal = SEAL) => ev.filter(e => e.exitT <= seal.start)
/** "Now", as far as choosing is concerned. */
export const sealedLast = (data, seal = SEAL) => Math.min(seal.start, Math.max(...data.coins.map(c => c.t[c.t.length - 1])))

/** The one-time exam: returns the stored result, or sits it now and stores it. */
export function sitExam(state, id, evAll, netOf, now, seal = SEAL) {
  const exams = (state.exams ||= {})
  if (exams[id]) return exams[id]
  const x = evAll.filter(e => e.t >= seal.start && e.exitT <= seal.end).map(netOf).filter(Number.isFinite)
  const n = x.length, mean = n ? x.reduce((a, b) => a + b, 0) / n : 0
  const sd = n > 1 ? Math.sqrt(x.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : 0
  return (exams[id] = { n, mean: +mean.toFixed(5), t: sd > 0 ? +(mean / (sd / Math.sqrt(n))).toFixed(2) : 0, at: now, window: [seal.start, seal.end], passed: n >= EXAM_MIN && mean > 0 })
}
