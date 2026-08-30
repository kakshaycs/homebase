/* Open-Meteo — no API key, no account, no tracking. */

const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const TTL = 15 * 60 * 1000;
const cache = new Map();   // panelId -> { at, data }

/* WMO weather codes → [label, icon, night icon] */
const CODES = {
  0:  ['Clear', '☀️', '🌙'],
  1:  ['Mainly clear', '🌤️', '🌙'],
  2:  ['Partly cloudy', '⛅', '☁️'],
  3:  ['Overcast', '☁️', '☁️'],
  45: ['Fog', '🌫️', '🌫️'],
  48: ['Rime fog', '🌫️', '🌫️'],
  51: ['Light drizzle', '🌦️', '🌧️'],
  53: ['Drizzle', '🌦️', '🌧️'],
  55: ['Heavy drizzle', '🌧️', '🌧️'],
  56: ['Freezing drizzle', '🌧️', '🌧️'],
  57: ['Freezing drizzle', '🌧️', '🌧️'],
  61: ['Light rain', '🌦️', '🌧️'],
  63: ['Rain', '🌧️', '🌧️'],
  65: ['Heavy rain', '🌧️', '🌧️'],
  66: ['Freezing rain', '🌧️', '🌧️'],
  67: ['Freezing rain', '🌧️', '🌧️'],
  71: ['Light snow', '🌨️', '🌨️'],
  73: ['Snow', '🌨️', '🌨️'],
  75: ['Heavy snow', '❄️', '❄️'],
  77: ['Snow grains', '🌨️', '🌨️'],
  80: ['Showers', '🌦️', '🌧️'],
  81: ['Showers', '🌧️', '🌧️'],
  82: ['Violent showers', '⛈️', '⛈️'],
  85: ['Snow showers', '🌨️', '🌨️'],
  86: ['Snow showers', '❄️', '❄️'],
  95: ['Thunderstorm', '⛈️', '⛈️'],
  96: ['Thunderstorm', '⛈️', '⛈️'],
  99: ['Thunderstorm', '⛈️', '⛈️']
};

export function describe(code, isDay = true) {
  const entry = CODES[code] || ['—', '❓', '❓'];
  return { label: entry[0], icon: isDay ? entry[1] : entry[2] };
}

/** City name → { label, lat, lon }. Throws if nothing matches. */
export async function geocode(name) {
  const url = `${GEO}?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding failed (HTTP ${res.status})`);
  const data = await res.json();
  const hit = (data.results || [])[0];
  if (!hit) throw new Error(`No place called “${name}”`);
  return {
    label: [hit.name, hit.country_code].filter(Boolean).join(', '),
    lat: hit.latitude,
    lon: hit.longitude
  };
}

export async function fetchWeather(panel, { force = false } = {}) {
  const cfg = panel.weather || {};
  if (cfg.lat == null || cfg.lon == null) throw new Error('No location set');

  const hit = cache.get(panel.id);
  if (!force && hit && Date.now() - hit.at < TTL) return hit.data;

  const unit = cfg.units === 'imperial' ? 'fahrenheit' : 'celsius';
  const url = `${FORECAST}?latitude=${cfg.lat}&longitude=${cfg.lon}`
    + '&current=temperature_2m,weather_code,is_day,apparent_temperature'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min'
    + `&temperature_unit=${unit}&timezone=auto&forecast_days=6`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather failed (HTTP ${res.status})`);
  const raw = await res.json();

  const days = (raw.daily?.time || []).map((iso, i) => ({
    iso,
    day: new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' }),
    code: raw.daily.weather_code[i],
    max: Math.round(raw.daily.temperature_2m_max[i]),
    min: Math.round(raw.daily.temperature_2m_min[i])
  })).slice(1, 6);   // skip today — the big number already covers it

  const data = {
    label: cfg.label || '',
    temp: Math.round(raw.current.temperature_2m),
    feels: Math.round(raw.current.apparent_temperature),
    code: raw.current.weather_code,
    isDay: raw.current.is_day === 1,
    unit: unit === 'fahrenheit' ? '°F' : '°C',
    days
  };
  cache.set(panel.id, { at: Date.now(), data });
  return data;
}

export function invalidate(panelId) {
  if (panelId) cache.delete(panelId); else cache.clear();
}
