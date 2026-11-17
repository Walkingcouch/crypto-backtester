// temporary: raw text of a recent House PTR, to tune the parser
import { unzipSync, strFromU8 } from 'fflate'
import { extractText, getDocumentProxy } from 'unpdf'
export default async function handler(req, res) {
  const y = new Date().getUTCFullYear()
  const z = unzipSync(new Uint8Array(await (await fetch(`https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${y}FD.zip`)).arrayBuffer()))
  const rows = strFromU8(z[`${y}FD.txt`]).split(/\r?\n/).map(l => l.split('\t')).filter(c => c[4] === 'P' && /^2\d{7}$/.test(c[8]))
  const pick = rows.slice(-Number(new URL(req.url, 'http://x').searchParams.get('n') || 3))[0]
  const pdf = new Uint8Array(await (await fetch(`https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${y}/${pick[8]}.pdf`)).arrayBuffer())
  const { text } = await extractText(await getDocumentProxy(pdf), { mergePages: true })
  res.json({ who: pick, text: text.slice(0, 3500) })
}
