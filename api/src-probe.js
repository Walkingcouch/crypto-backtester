// temporary: which data sources can the server reach?
export default async function handler(req, res) {
  const out = {}
  const t = async (k, url, headers = {}) => {
    const t0 = Date.now()
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Backtester research contact@example.com', accept: '*/*', ...headers } })
      const txt = await r.text()
      out[k] = { status: r.status, ms: Date.now() - t0, len: txt.length, head: txt.slice(0, 400).replace(/\s+/g, ' ') }
    } catch (e) { out[k] = { error: String(e).slice(0, 200) } }
  }
  await Promise.all([
    t('houseClerkIndex', 'https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2026FD.zip'),
    t('houseClerkSearch', 'https://disclosures-clerk.house.gov/FinancialDisclosure'),
    t('senateEfd', 'https://efdsearch.senate.gov/search/home/'),
    t('secForm4Feed', 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=include&count=40&output=atom'),
    t('secFullIndex', 'https://www.sec.gov/Archives/edgar/daily-index/'),
    t('openinsider', 'http://openinsider.com/latest-cluster-buys'),
    t('asxAnn', 'https://asx.api.markitdigital.com/asx-research/1.0/markets/announcements?itemsPerPage=20&summaryCountsDate=&page=0'),
    t('trumpsTruthRss', 'https://www.trumpstruth.org/feed'),
    t('okxFunding', 'https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP'),
    t('okxOI', 'https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP'),
    t('bybitTickers', 'https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT'),
    t('binanceFapi', 'https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT'),
    t('aphRegister', 'https://www.aph.gov.au/Senators_and_Members/Members/Register'),
    t('capitolTrades', 'https://www.capitoltrades.com/trades'),
    t('politiciantradesAu', 'https://politiciantrades.au/'),
  ])
  res.json(out)
}
