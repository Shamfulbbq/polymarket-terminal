import logger from '../utils/logger.js';

/**
 * Fetches the forecasted high temperature for a given latitude and longitude
 * for today, using the free Open-Meteo API.
 */
export async function getDailyHighTemperature(lat, lon) {
    try {
        // Fetch daily max temperature in Fahrenheit
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max&temperature_unit=fahrenheit&timezone=America%2FNew_York&forecast_days=1`;
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Open-Meteo API returned ${response.status}`);
        }
        
        const data = await response.json();
        const maxTemp = data?.daily?.temperature_2m_max?.[0];
        
        if (maxTemp == null) {
            throw new Error('Temperature data missing from response');
        }
        
        return maxTemp;
    } catch (err) {
        logger.error(`WeatherFeed error: ${err.message}`);
        return null;
    }
}
