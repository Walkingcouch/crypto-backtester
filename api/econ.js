// Economic calendar and central-bank news for the shares labs (US and Australia).
import { econAll } from './_lib/econ.js'

export default async function handler(req, res) {
  try {
    const out = await econAll()
    res.setHeader('cache-control', 'public, s-maxage=900, stale-while-revalidate=3600')
    res.status(200).json(out)
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) })
  }
}
