import { GoogleGenAI } from '@google/genai';
import config from '../config/index.js';
import logger from '../utils/logger.js';

let aiClient = null;
if (process.env.GEMINI_API_KEY) {
    aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

const seenConditionIds = new Set();
let pollTimer = null;
let onWeatherMarketCb = null;

/**
 * Uses Gemini to parse the market question and description to extract target city and temperature.
 */
async function parseMarketWithLLM(market) {
    if (!aiClient) {
        logger.warn('No GEMINI_API_KEY found. Skipping LLM parsing.');
        return null;
    }

    const prompt = `
    You are a data extraction bot for Polymarket weather betting.
    Analyze the following market question and description.
    Extract the Target City (and state/country if available) and the Target Temperature (in Fahrenheit) that serves as the threshold for this market.
    
    Market Question: "${market.question}"
    Market Description: "${market.description}"
    
    Respond STRICTLY with a JSON object in the following format, nothing else:
    {
      "city": "Name of City",
      "targetTemperature": "integer or float",
      "resolutionSource": "source mentioned e.g. NOAA or AccuWeather (if any)"
    }
    `;

    try {
        const response = await aiClient.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                responseMimeType: "application/json",
            }
        });
        
        const text = response.text;
        return JSON.parse(text);
    } catch (err) {
        logger.error(`LLM Parse error: ${err.message}`);
        return null;
    }
}

function extractMarketData(market) {
    const conditionId = market.conditionId || market.condition_id || '';
    if (!conditionId) return null;

    let tokenIds = market.clobTokenIds ?? market.clob_token_ids;
    if (typeof tokenIds === 'string') {
        try { tokenIds = JSON.parse(tokenIds); } catch { tokenIds = null; }
    }

    let yesTokenId, noTokenId;
    if (Array.isArray(tokenIds) && tokenIds.length >= 2) {
        [yesTokenId, noTokenId] = tokenIds;
    }

    if (!yesTokenId || !noTokenId) return null;

    return {
        conditionId,
        question: market.question || market.title || '',
        description: market.description || '',
        endTime: market.endDate || market.end_date_iso,
        yesTokenId: String(yesTokenId),
        noTokenId: String(noTokenId),
    };
}

async function findWeatherMarkets() {
    try {
        // Query gamma for active markets mentioning "temperature"
        const resp = await fetch(`${config.gammaHost}/markets?active=true&limit=20`); // Simplify for demo, ideally search params
        if (!resp.ok) return;
        const markets = await resp.json();
        
        const weatherMarkets = markets.filter(m => m.question?.toLowerCase().includes('temperature') || m.question?.toLowerCase().includes('degrees'));

        for (const m of weatherMarkets) {
            const data = extractMarketData(m);
            if (!data) continue;
            if (seenConditionIds.has(data.conditionId)) continue;
            
            seenConditionIds.add(data.conditionId);
            logger.info(`WEATHER: New weather market found: ${data.question}`);
            
            // Pass to LLM
            const parsedData = await parseMarketWithLLM(m);
            if (parsedData) {
                logger.success(`WEATHER: LLM parsed target - City: ${parsedData.city}, Temp: ${parsedData.targetTemperature}F, Source: ${parsedData.resolutionSource}`);
                if (onWeatherMarketCb) onWeatherMarketCb({ ...data, parsedData });
            } else {
                logger.warn(`WEATHER: Failed to parse market data via LLM for: ${data.question}`);
            }
        }
    } catch (err) {
        logger.error(`WEATHER Detector poll error: ${err.message}`);
    }
}

export function startWeatherDetector(onNewMarket) {
    onWeatherMarketCb = onNewMarket;
    seenConditionIds.clear();

    findWeatherMarkets();
    pollTimer = setInterval(findWeatherMarkets, 60_000); // Check every minute
    
    logger.info(`WEATHER detector started — polling PolyMarket Gamma`);
}

export function stopWeatherDetector() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}
