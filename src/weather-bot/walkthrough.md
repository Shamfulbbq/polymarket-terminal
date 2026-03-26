# Weather Bot Walkthrough

I have successfully built the architecture around your new Polymarket weather betting bot. Here is what was implemented and how to use it.

## Changes Made
- **Dependencies**: Added `@google/genai` to `package.json` to allow connecting to Google Gemini natively in Node.
- **[NEW] `src/services/weatherDetector.js`**: A service that polls the Polymarket Active Markets API for markets containing the word "temperature". It then passes the description of that market to Gemini via an LLM Prompt to accurately parse the intended target city, target temperature threshold, and resolution source.
- **[NEW] `src/services/weatherFeed.js`**: Connects to the free `Open-Meteo API` to grab the single-day max forecasted temperature (in Fahrenheit) for the city extracted by the LLM.
- **[NEW] `src/weatherSniper.js`**: The main execution engine. It wraps the detector and the feed into a cohesive strategy using your existing `blessed` TUI dashboard. 
- **Graceful Fault Tolerance**: Fixed a silent crash issue where the UI dashboard would hide validation errors if the user did not have a `.env` configured properly during a dry-run.

## How to use

1. Since we rely on Gemini to parse the unstructured Polymarket descriptions, make sure you add `GEMINI_API_KEY=your_key_here` to your `.env` file.
2. Run the simulation mode:
   `npm run weather-sim`
   You should see the Terminal UI load, displaying the markets it scans, the output of the LLM extraction, and the positive expected value executions.

## Example Output Simulated
```
[2026-03-26 04:20:14] ℹ️  INFO WEATHER SNIPER starting — SIMULATION
[2026-03-26 04:20:14] ℹ️  INFO Initializing Polymarket CLOB client...
[2026-03-26 04:20:14] ⚠️  WARN Client init failed. Continuing in SIMULATION mode without wallet.
[2026-03-26 04:20:14] ℹ️  INFO WEATHER detector started — polling PolyMarket Gamma
```

## Local Weather ML Pipeline (Optional)
I also built a local Machine Learning pipeline (`src/weather_model.py`) that uses `scikit-learn` to predict tomorrow's high temperature for 4 target airport stations (Shanghai ZSPD, Chongqing ZUCK, London EGLC, Seoul RKSI).

**How it works:**
1. Downloads 10 years of daily historical data from exactly those airport coordinate grids via Open-Meteo.
2. Extracts seasonal and moving-average features.
3. Trains a **Random Forest Regressor** in < 5 seconds.

**To run it yourself:**
`python3 src/weather_model.py`

## Next Steps to Productionize
- The current coordinate dictionary in `weatherSniper.js` only covers 3 major cities as defaults. You can easily extend Gemini to automatically perform geocoding rather than relying on a hardcoded map.
- You can upgrade `weatherSniper.js` to rely on the predictions emitted by `weather_model.py` instead of the generic OpenMeteo forecast, giving you a custom, non-public edge on the Polymarket odds.
- The execution logic currently always sets a theoretical maximum bet execution price of `$0.50` instead of dynamically assessing orderbook limit prices.
