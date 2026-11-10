// News & chatter for the Predictions page. Cached 10 minutes at Vercel's edge.
import { collect } from './_lib/chatter.js'

export default async function handler(req, res) {
  try {
    const data = await collect()
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'public, s-maxage=600, stale-while-revalidate=1800')
    res.status(200).send(JSON.stringify(data))
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) })
  }
}
