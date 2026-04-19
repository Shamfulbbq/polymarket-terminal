with open('/home/ubuntu/polymarket-terminal/src/btc5m/bot.mjs', 'r') as f:
    src = f.read()

old = "    Object.assign(_active, { slug, market, upBids: upRungs, dnBids: dnRungs,\n        upOrderIds: collectedUpIds, dnOrderIds: collectedDnIds, signalMode: rec.mode });"
new = "    Object.assign(_active, { slug, market, upBids: upRungs, dnBids: dnRungs,\n        upOrderIds: collectedUpIds, dnOrderIds: collectedDnIds, signalMode: rec.mode,\n        initialPred: pred, lastMidInferTs: 0 });"

assert old in src, "FAIL: _active assignment not found"
src = src.replace(old, new)

with open('/home/ubuntu/polymarket-terminal/src/btc5m/bot.mjs', 'w') as f:
    f.write(src)
print('done')
