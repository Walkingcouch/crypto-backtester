// The Lab: fixed menu of 39 swing rules, re-tested weekly on up to ~5.5 years of daily bars, traded on paper. See api/_lib/labrun.js.
import { LAB, step } from '../src/lib/lab.js'
import { labHandler } from './_lib/labrun.js'

export default labHandler({ sid: 'main', universe: LAB.universe, pages: 2, stepFn: (s, m, now) => step(s, m, now, LAB) })
