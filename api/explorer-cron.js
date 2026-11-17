// The Explorer: breeds new strategies from building blocks; graduates trade on paper.
import { step } from '../src/lib/lab.js'
import { EXPLORE, evolve } from '../src/lib/explorer.js'
import { labHandler } from './_lib/labrun.js'

export default labHandler({ sid: 'explorer', universe: EXPLORE.universe, pages: 2, stepFn: (s, m, now) => step(s, m, now, EXPLORE, { discover: evolve }) })
