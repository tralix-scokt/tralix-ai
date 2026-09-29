import { fetchJson } from '../http.js';
import { ProviderError } from '../types.js';

/** Real weather data from Open-Meteo (https://open-meteo.com) — free, no API key. */

const WMO: Record<number, string> = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Heavy freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Heavy freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light rain showers', 81: 'Rain showers', 82: 'Violent rain showers', 85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Severe thunderstorm with hail',
};
const cond = (c: number) => WMO[c] ?? 'Unknown conditions';
const f = (c: number) => Math.round((c * 9) / 5 + 32);
const t = (c: number) => `${Math.round(c)}°C / ${f(c)}°F`;

export interface WeatherReport {
  text: string;
  place: string;
  url: string;
}

export async function getWeather(location: string, timeoutMs: number, signal?: AbortSignal): Promise<WeatherReport> {
  const geo = await fetchJson<{ results?: any[] }>(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`,
    { timeoutMs, label: 'Weather service', signal },
  );
  const g = geo.results?.[0];
  if (!g) throw new ProviderError('bad_request', `Could not find a place called "${location}".`, false);

  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.searchParams.set('latitude', String(g.latitude));
  u.searchParams.set('longitude', String(g.longitude));
  u.searchParams.set('current', 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m');
  u.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
  u.searchParams.set('forecast_days', '3');
  u.searchParams.set('timezone', 'auto');
  const w = await fetchJson<any>(u.toString(), { timeoutMs, label: 'Weather service', signal });
  const c = w.current;
  const d = w.daily;
  const place = [g.name, g.admin1, g.country].filter(Boolean).join(', ');
  const lines = [
    `Weather for ${place} (local time ${c.time}, timezone ${w.timezone}):`,
    `Now: ${cond(c.weather_code)}, ${t(c.temperature_2m)} (feels like ${t(c.apparent_temperature)}), humidity ${c.relative_humidity_2m}%, wind ${Math.round(c.wind_speed_10m)} km/h, precipitation ${c.precipitation} mm.`,
    'Forecast:',
    ...d.time.map(
      (day: string, i: number) =>
        `- ${day}: ${cond(d.weather_code[i])}, high ${t(d.temperature_2m_max[i])}, low ${t(d.temperature_2m_min[i])}, precipitation chance ${d.precipitation_probability_max[i] ?? 'n/a'}%`,
    ),
  ];
  return { text: lines.join('\n'), place, url: 'https://open-meteo.com/' };
}
