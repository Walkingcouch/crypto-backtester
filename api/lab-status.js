// Which labs have a saved record, and when each last saved (for checking the schedules).
import { sb } from './_lib/forecaster.js'

export default async function handler(req, res) {
  const r = await sb('/rest/v1/lab_state?select=id,updated_at&order=id')
  res.setHeader('cache-control', 'no-store')
  res.status(r.status).json(await r.json())
}
