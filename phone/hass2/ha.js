// Minimal Home Assistant REST client + entity-to-page mapping.
//
// Talks to the user's Home Assistant instance over its HTTP REST API using a
// long-lived access token. The plugin never sends the token to the glasses: it
// stays on the phone, in this plugin's private storage and Authorization
// header only.

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

// Builds the API endpoint for a given path, e.g. '/api/states'.
function apiUrl(baseUrl, path) {
  return `${normalizeBaseUrl(baseUrl)}${path}`;
}

async function haFetch(baseUrl, token, path, { timeoutMs = 8000, method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(apiUrl(baseUrl, path), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    if (response.status === 401) throw new Error('HTTP 401 (jeton invalide)');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('délai dépassé');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Picks the Home Assistant service that "activates" an entity, based on its
// domain. Toggle drives lights, switches, fans, covers, ...; scenes and scripts
// are turned on; buttons are pressed. Unknown domains fall back to toggle.
function actionService(domain) {
  if (domain === 'scene' || domain === 'script' || domain === 'automation') return 'turn_on';
  if (domain === 'button') return 'press';
  return 'toggle';
}

// Runs the action bound to a glasses row: POSTs to the matching domain service
// for that entity id. The token stays on the phone.
//
// The POST answers with the list of states the call changed (HA >= 2023.8).
// That is the fastest way to know the new value: for most integrations the
// change has landed by the time the answer arrives, so the caller can repaint
// the card without polling — and without refetching the whole instance. An
// empty list is meaningful too: it means nothing moved yet (a slow device) or
// nothing will (a scene, a script), so the caller falls back to a bounded poll.
export async function callAction(baseUrl, token, entityId, { timeoutMs = 8000, action = null } = {}) {
  const id = String(entityId || '').trim();
  const dot = id.indexOf('.');
  if (dot <= 0) throw new Error('entité invalide');
  const domain = id.slice(0, dot);
  /* A tile can bind its press to a specific service (the dashboard's own
   * `tap_action`, e.g. "TV" runs script.regarder_tv). When it does, that service
   * is what the wearer sees the tile do; the entity id is still passed so a
   * call that runs on it (turn_on) still targets it. Otherwise the domain
   * default (toggle, press, turn_on for scenes/scripts) applies. */
  const wanted = action && typeof action.service === 'string' ? action.service.trim() : '';
  const override = wanted && wanted.indexOf('.') > 0 ? wanted : '';
  const callDomain = override ? override.slice(0, override.indexOf('.')) : domain;
  const service = override ? override.slice(override.indexOf('.') + 1) : actionService(domain);
  const body = override && action.data && typeof action.data === 'object'
    ? { ...action.data }
    : {};
  if (body.entity_id === undefined && !(override && String(callDomain).startsWith('script'))) {
    body.entity_id = id;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(apiUrl(baseUrl, `/api/services/${callDomain}/${service}`), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.status === 401) throw new Error('HTTP 401 (jeton invalide)');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const changed = await readChangedStates(response);
    const moved = changed.find((state) => state.entity_id === id) || null;
    return { entity: moved, changed };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('délai dépassé');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// The bodies HA returns for a service call, from the oldest to the newest:
// [] (2022.x), [{entity_id, state, attributes, ...}] (2023.8+),
// {changed_states: [...]} (2024.x+). All three are read so an older instance
// still gives us the new value instead of forcing a poll.
async function readChangedStates(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    return [];
  }
  const list = Array.isArray(body) ? body : body?.changed_states;
  if (!Array.isArray(list)) return [];
  return list.filter((state) => state && typeof state.entity_id === 'string');
}

// Verifies the URL + token pair by requesting the API root.
export async function testConnection(baseUrl, token) {
  if (!normalizeBaseUrl(baseUrl) || !token) throw new Error('configuration incomplète');
  await haFetch(baseUrl, token, '/api/');
  return true;
}

// Fetches all entity states and indexes them by entity_id.
export async function fetchStates(baseUrl, token) {
  const states = await haFetch(baseUrl, token, '/api/states');
  if (!Array.isArray(states)) throw new Error('réponse inattendue');
  const byId = new Map();
  for (const state of states) {
    if (state && typeof state.entity_id === 'string') byId.set(state.entity_id, state);
  }
  return byId;
}

// Reads one entity's state after a service call. The POST to /api/services
// answers as soon as Home Assistant accepted it; the integration then updates
// the entity a moment later, so the state read straight after may still be the
// old one. Reading the single entity is one small request, and the caller can
// retry it instead of refetching the whole instance.
export async function fetchEntityState(baseUrl, token, entityId,
  { timeoutMs = 8000 } = {}) {
  const id = String(entityId || '').trim();
  if (!id) throw new Error('entité invalide');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(apiUrl(baseUrl, `/api/states/${encodeURIComponent(id)}`), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 401) throw new Error('HTTP 401 (jeton invalide)');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const state = await response.json();
    return state && typeof state.entity_id === 'string' ? state : null;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('délai dépassé');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Attaches daily forecasts to weather entities. `/api/states` only carries the
// current condition, so each weather entity needs an explicit service call to
// get its forecast. HA 2024+ exposes `weather.get_forecasts` (plural, answer
// wrapped in `service_response`); older builds only know the singular name.
const FORECAST_DAYS = 4;

export async function attachForecasts(baseUrl, token, states) {
  const weatherIds = [];
  for (const [id, state] of states) {
    if (id.startsWith('weather.') && !Array.isArray(state?.attributes?.forecast)) {
      weatherIds.push(id);
    }
  }
  if (!weatherIds.length) return states;
  for (const id of weatherIds) {
    let forecast = null;
    for (const service of ['weather/get_forecasts', 'weather/get_forecast']) {
      try {
        const result = await haFetch(baseUrl, token, `/api/services/${service}?return_response`, {
          method: 'POST',
          body: { entity_id: id, type: 'daily' },
          timeoutMs: 6000,
        });
        const payload = result?.service_response ?? result;
        const entry = payload?.[id] ?? payload;
        const list = Array.isArray(entry) ? entry : entry?.forecast;
        if (Array.isArray(list) && list.length) {
          forecast = list;
          break;
        }
      } catch {
        // Try the next service name, then fall back to the bare state.
      }
    }
    const state = states.get(id);
    if (forecast) {
      states.set(id, { ...state, attributes: { ...state.attributes, forecast: forecast.slice(0, FORECAST_DAYS) } });
    }
  }
  return states;
}

// Fetches every entity as a flat, display-ready list sorted by friendly label,
// for the searchable picker. Each item carries its domain (the part before the
// dot) and its icon name (from attributes.icon, e.g. "mdi:lightbulb" ->
// "lightbulb"), so the UI can group by type and show the matching glyph.
export async function fetchAllEntities(baseUrl, token) {
  const states = await fetchStates(baseUrl, token);
  const list = [];
  for (const [entityId, state] of states) {
    const dot = entityId.indexOf('.');
    list.push({
      id: entityId,
      label: entityLabel(state, entityId),
      domain: dot >= 0 ? entityId.slice(0, dot) : '',
      icon: entityIconName(state),
    });
  }
  list.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  return list;
}

// --- Lovelace dashboards (native Home Assistant) ---------------------------
//
// The HASS app reads the dashboards the user already built in Home Assistant
// itself, through HA's own websocket API — not through the MemoMind Glasses
// custom component. Two commands are enough:
//   lovelace/dashboards/list -> every storage dashboard (url_path, title)
//   lovelace/config {url_path} -> the raw Lovelace config of one dashboard
// The config views carry the CARDS exactly the way Lovelace writes them, which
// is the shape cardrender.js already understands.

const WS_TIMEOUT_MS = 10000;

function wsUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl).replace(/^http/i, 'ws')}/api/websocket`;
}

// Opens an authenticated websocket to HA, runs `run(send)` and always closes.
// `send(type, payload)` returns a promise resolved with the command result.
async function withWebSocket(baseUrl, token, run) {
  const WebSocketImpl = typeof WebSocket !== 'undefined' ? WebSocket : null;
  if (!WebSocketImpl) throw new Error('WebSocket indisponible');
  return await new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(wsUrl(baseUrl));
    const pending = new Map();
    let nextId = 1;
    let settled = false;
    const timer = setTimeout(() => finish(new Error('délai dépassé')), WS_TIMEOUT_MS);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve(value);
    }
    const send = (type, payload = {}) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      socket.send(JSON.stringify({ id, type, ...payload }));
    });
    socket.onmessage = async (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'auth_required') {
        socket.send(JSON.stringify({ type: 'auth', access_token: token }));
        return;
      }
      if (message.type === 'auth_invalid') {
        finish(new Error('HTTP 401 (jeton invalide)'));
        return;
      }
      if (message.id && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.success) entry.res(message.result);
        else entry.rej(new Error(message.error?.message || 'erreur Home Assistant'));
        return;
      }
      if (message.type !== 'auth_ok') return;
      try {
        const result = await run(send);
        finish(null, result);
      } catch (error) {
        finish(error);
      }
    };
    socket.onerror = () => finish(new Error('connexion WebSocket impossible'));
    /* The socket also closes right after `finish` succeeded; once settled the
     * close is expected and must not turn into a rejection. */
    socket.onclose = () => {
      if (!settled) finish(new Error('connexion WebSocket fermée'));
    };
  });
}

// The dashboard this app generates from the entity list alone, for hosts where
// Home Assistant's websocket is unreachable (a sandboxed webview blocks it).
// It is not a Lovelace dashboard: it has no url_path on the HA side.
export const REST_DASHBOARD_ID = 'rest-auto';

function isRestDashboard(id) {
  return String(id || '') === REST_DASHBOARD_ID;
}

// Every dashboard HA knows about, in sidebar order. `url_path` is the id the
// glasses use to pick one; the overview dashboard ("lovelace") always exists.
export async function fetchLovelaceDashboards(baseUrl, token) {
  let raw;
  try {
    raw = await withWebSocket(baseUrl, token, async (send) => {
      const list = await send('lovelace/dashboards/list');
      return Array.isArray(list) ? list : [];
    });
  } catch (error) {
    if (!/WebSocket/i.test(String(error?.message || error))) throw error;
    /* The websocket is the only way HA exposes its dashboards, and this host
     * refuses it. The REST API still answers, so the app can build its own
     * dashboard from the entities instead of showing nothing. */
    return [{ id: REST_DASHBOARD_ID, name: 'Automatique (REST)', rest: true }];
  }
  const out = [];
  const seen = new Set();
  const push = (urlPath, title) => {
    const id = String(urlPath || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, name: String(title || '').trim() || id });
  };
  for (const item of raw) push(item?.url_path, item?.title);
  // The default overview dashboard is not part of dashboards/list.
  push('lovelace', 'Aperçu');
  return out;
}

// Flattens one Lovelace view's cards into the flat card list the glasses paint.
// Sections views nest their cards under sections[]; masonry views keep them
// under cards[]. A card with visible children (grid/stack) is kept whole so
// cardrender can lay the cells out; a card without one is skipped rather than
// pushing a blank page.
function childrenOf(card) {
  if (!card || typeof card !== 'object') return [];
  const list = Array.isArray(card.cards) ? card.cards : [];
  if (list.length) return list;
  if (card.card && typeof card.card === 'object') return [card.card];
  return [];
}

function leavesOf(card, out = []) {
  if (!card || typeof card !== 'object') return out;
  const children = childrenOf(card);
  if (children.length) {
    for (const child of children) leavesOf(child, out);
    return out;
  }
  out.push(card);
  return out;
}
const GRAPH_TYPES = new Set(['statistics-graph', 'energy-usage-graph', 'history-graph', 'sensor-graph']);

function hasContent(card) {
  if (!card || typeof card !== 'object') return false;
  const type = String(card.type || '').toLowerCase();
  if (type === 'heading' || type === 'glance') return false;
  /* Graph cards draw their series from the recorder, not from a per-card
   * entity: the Energy dashboard's card names none in its config at all, yet
   * it still paints a chart. Keep it as content. */
  if (GRAPH_TYPES.has(type)) return true;
  if (typeof card.entity === 'string' && card.entity.trim()) return true;
  if (Array.isArray(card.entities) && card.entities.length) return true;
  if (typeof card.content === 'string' && card.content.trim()) return true;
  return childrenOf(card).some((child) => hasContent(child));
}

// Views of the picked dashboard, each one a page of cards. Computed page/row
// counts live on the object the settings list renders.
export async function fetchLovelaceDashboard(baseUrl, token, urlPath) {
  if (isRestDashboard(urlPath)) {
    const states = await fetchStates(baseUrl, token);
    return buildRestDashboard(states);
  }
  const config = await withWebSocket(baseUrl, token, async (send) => {
    const result = await send('lovelace/config', { url_path: String(urlPath || '').trim() || null });
    return result && typeof result === 'object' ? result : null;
  });
  if (!config) throw new Error('dashboard introuvable');
  // A strategy dashboard (auto-generated) has no views to paint.
  if (!Array.isArray(config.views)) {
    throw new Error(config.strategy ? 'dashboard généré automatiquement' : 'dashboard sans vue');
  }
  const pages = [];
  for (const view of config.views) {
    const cards = [];
    const viewCards = Array.isArray(view?.cards) ? view.cards : [];
    for (const card of viewCards) if (hasContent(card)) cards.push(card);
    const sections = Array.isArray(view?.sections) ? view.sections : [];
    for (const section of sections) {
      const sectionCards = Array.isArray(section?.cards) ? section.cards : [];
      for (const card of sectionCards) if (hasContent(card)) cards.push(card);
    }
    if (!cards.length) continue;
    pages.push({
      title: typeof view?.title === 'string' ? view.title : '',
      cards,
      leaves: cards.flatMap((card) => leavesOf(card)),
    });
  }
  return pages;
}

// --- REST-only dashboard ---------------------------------------------------
//
// Reads the entity list over REST (which the sandboxed host does allow) and
// lays out three pages the way a Lovelace dashboard would: weather, the
// house's key readings, and the availability of the hosts. Nothing is
// configured by the user: a reading is picked by what its attributes carry,
// so it follows the instance rather than a fixed entity id.

const REST_TEMPERATURE_UNITS = new Set(['°c', '°f']);
const REST_UNITS_PERCENT = new Set(['%']);
const REST_UNAVAILABLE = new Set(['unavailable', 'unknown', '']);

function restUnit(state) {
  const unit = state?.attributes?.unit_of_measurement;
  return typeof unit === 'string' ? unit.trim() : '';
}

function restNumber(state) {
  if (!state || REST_UNAVAILABLE.has(String(state.state).trim().toLowerCase())) return NaN;
  return Number(state.state);
}

// A device battery, as opposed to a station's forecast page: the reading is a
// percentage whose icon or class says so.
function restIsBattery(id, state) {
  return (id.startsWith('sensor.') && /battery|batterie/.test(id)) || state?.attributes?.device_class === 'battery';
}

function restTile(id) {
  return { type: 'tile', entity: id, name: '', icon: '' };
}

function restGrid(title, ids, columns) {
  const cards = (ids || []).map((id) => (typeof id === 'object' ? id : restTile(id)));
  return { type: 'grid', title, columns, cards };
}

function restFamilyName(label) {
  return String(label || '').replace(/\s*\(.*\)\s*$/, '').trim();
}

function buildRestDashboard(states) {
  const byId = states instanceof Map ? states : new Map();
  const list = [...byId.entries()];

  const weatherIds = list
    .filter(([id, state]) => id.startsWith('weather.') && !REST_UNAVAILABLE.has(String(state?.state).toLowerCase()))
    .map(([id]) => id);
  // The house station first when it names itself as such, else HA's order.
  weatherIds.sort((a, b) => {
    const score = (id) => (/maison|home|interieur/i.test(id) ? 0 : 1);
    return score(a) - score(b);
  });

  /* Room readings, not every thermometer: a box, a phone or a station's
   * forecast page also reports a temperature in a sensor, and at two cells a
   * page it would push the house's own rooms off the screen. */
  const temperatures = list.filter(([id, state]) => id.startsWith('sensor.')
    && REST_TEMPERATURE_UNITS.has(restUnit(state).toLowerCase())
    && Number.isFinite(restNumber(state))
    && Number(restNumber(state)) > -20 && Number(restNumber(state)) < 45
    && !/cc_|cpu|processor|processeur|nas|disque|disk|four|oven|phone|pixel|watch|tablet|tab_|iphone|android|station|meteo|forecast|server|ssd|gpu|altitude|latitude|longitude/i
      .test(`${id} ${state?.attributes?.friendly_name || ''}`.toLowerCase()));

  const humidities = list.filter(([id, state]) => id.startsWith('sensor.')
    && restUnit(state) === '%'
    && Number.isFinite(restNumber(state))
    && /humid/.test(`${id} ${state?.attributes?.friendly_name || ''}`.toLowerCase()));

  const batteries = list
    .filter(([id, state]) => REST_UNITS_PERCENT.has(restUnit(state)) && restIsBattery(id, state)
      && Number.isFinite(restNumber(state)))
    .sort((a, b) => restNumber(a[1]) - restNumber(b[1]));

  const power = list.filter(([id, state]) => id.startsWith('sensor.')
    && /^(w|kw)$/i.test(restUnit(state))
    && Number.isFinite(restNumber(state))
    && /power|puissance|watt/.test(`${id} ${state?.attributes?.friendly_name || ''}`.toLowerCase()));

  const pages = [];

  const weatherCards = weatherIds.slice(0, 2).map((id) => ({
    type: 'weather-forecast',
    entity: id,
    entities: [entityEntry(id)],
  }));
  pages.push({
    title: 'Météo',
    cards: weatherCards,
    leaves: weatherCards,
  });

  const houseCards = [];
  if (temperatures.length) {
    const picks = [];
    const seen = new Set();
    for (const [id, state] of temperatures) {
      const name = restFamilyName(state?.attributes?.friendly_name || id);
      const key = name.toLowerCase().slice(0, 12);
      if (seen.has(key)) continue;
      seen.add(key);
      picks.push(id);
      if (picks.length >= 6) break;
    }
    houseCards.push(restGrid('Températures', picks, 2));
  }
  if (humidities.length) {
    houseCards.push(restGrid('Humidité', humidities.slice(0, 4).map(([id]) => id), 2));
  }
  if (batteries.length) {
    houseCards.push(restGrid('Batteries', batteries.slice(0, 4).map(([id]) => id), 2));
  }
  if (houseCards.length) {
    pages.push({ title: 'Maison', cards: houseCards, leaves: houseCards.flatMap((card) => childrenOf(card)) });
  }

  if (power.length) {
    const grid = restGrid('Consommation', power.slice(0, 4).map(([id]) => id), 2);
    pages.push({ title: 'Énergie', cards: [grid], leaves: childrenOf(grid) });
  }

  return pages;
}

// Summary for the settings list: how many pages and how many row-usable
// entities, without running the full renderer.
export function dashboardSummary(pages) {
  let pageCount = 0;
  let rowCount = 0;
  for (const page of pages || []) {
    pageCount += 1;
    for (const leaf of page.leaves || []) {
      const ids = cardEntityIds(leaf);
      rowCount += ids.length || 1;
    }
  }
  return { pageCount, rowCount };
}

// Adapts a Lovelace page to the flat "cards" list buildPages already maps:
// one entry per top-level card, dropped onto the glasses as a picture. All the
// entities a card touches (its children included) are sent with it so the
// renderer can resolve every state.
export function lovelacePagesToCards(pages) {
  const out = [];
  for (const page of pages || []) {
    (page.cards || []).forEach((card, index) => {
      const entityIds = cardEntityIds(card);
      out.push({
        title: page.title && (page.cards || []).length === 1
          ? page.title
          : page.title
            ? `${page.title} ${index + 1}`
            : '',
        cardtype: String(card?.type || ''),
        config: card && typeof card === 'object' ? card : {},
        entities: entityIds.map((id) => ({ id, name: '', icon: '' })),
      });
    });
  }
  return out;
}

// Every entity id a card depends on, in wire order: the card's explicit
// entity/entities plus its row list. Used to fetch just the states one card
// picture needs (the image path does not need the whole instance).
export function cardEntityIds(card) {
  const ids = [];
  const push = (value) => {
    const id = typeof value === 'string' ? value : value?.entity;
    if (typeof id === 'string' && id.trim() && !ids.includes(id.trim())) ids.push(id.trim());
  };
  const fromCard = (raw) => {
    if (!raw || typeof raw !== 'object') return;
    const config = raw.config && typeof raw.config === 'object' ? raw.config : raw;
    const value = config?.entity ?? config?.entities;
    for (const item of Array.isArray(value) ? value : value ? [value] : []) push(item);
    for (const entry of Array.isArray(raw?.entities) ? raw.entities : []) push(entry?.id ?? entry);
    // Composite cards (grid, stack, custom:*) only name their entities through
    // their children, so walk those too.
    for (const child of Array.isArray(config?.cards) ? config.cards : []) fromCard(child);
  };
  fromCard(card);
  return ids;
}

// Friendly label: prefer the entity's friendly_name attribute, otherwise the
// entity_id with its domain stripped.
export function entityLabel(state, entityId) {
  const friendly = state?.attributes?.friendly_name;
  if (typeof friendly === 'string' && friendly.trim()) return friendly.trim();
  const dot = entityId.indexOf('.');
  return dot >= 0 ? entityId.slice(dot + 1) : entityId;
}

// Extracts the MDI icon name from an entity's attributes.icon ("mdi:lightbulb"
// -> "lightbulb"). Returns "" when the entity does not expose one.
export function entityIconName(state) {
  const icon = state?.attributes?.icon;
  if (typeof icon !== 'string') return '';
  const colon = icon.indexOf(':');
  const name = colon >= 0 ? icon.slice(colon + 1) : icon;
  return name.trim();
}

// Compact value: unit_of_measurement appended when present, otherwise the raw
// state. Kept short because the glasses row value is limited to 24 bytes.
export function entityValue(state) {
  if (!state) return '—';
  const raw = state.state === undefined || state.state === null ? '?' : String(state.state);
  const unit = state.attributes?.unit_of_measurement;
  const value = typeof unit === 'string' && unit ? `${raw} ${unit}` : raw;
  return value.length > 24 ? `${value.slice(0, 23)}…` : value;
}

// Reads an entity entry, which may be a legacy bare id ("light.salon") or the
// current { id, name, icon } object. `name` is the user-chosen display label
// and overrides the entity's friendly_name when present. `icon` is the chosen
// MDI icon name ("" = automatic: the entity's own icon attribute, else a
// default derived from its domain).
export function entityEntry(entry) {
  if (typeof entry === 'string') return { id: entry.trim(), name: '', icon: '' };
  if (entry && typeof entry === 'object') {
    return {
      id: String(entry.id || '').trim(),
      name: typeof entry.name === 'string' ? entry.name : '',
      icon: typeof entry.icon === 'string' ? entry.icon : '',
    };
  }
  return { id: '', name: '', icon: '' };
}

// Maps the user-defined cards (pages) to the wire format. Each card keeps its
// own title and ordered entity list; unknown ids still render (as "—") so a
// temporarily-unavailable entity does not silently shift the layout. Cards
// without any entity are dropped. Right now a card can hold up to maxRows
// rows; the glasses scroll within a card when there are more than fit.
// These card types are painted as a bitmap instead of a row list (see
// cardrender.js), even when the integration attached entities to them: their
// entity list is only there so a bare "sensor.x" config can resolve its state.
// An entities card left empty on the HA side is still skipped.
const IMAGE_CARD_TYPES = new Set([
  'gauge', 'markdown', 'thermostat', 'climate', 'sensor', 'statistics',
  'history-graph', 'picture', 'picture-entities', 'media-control', 'weather-forecast',
  'bar', 'input_number', 'number', 'progress', 'tile', 'alarm-panel',
]);

// Known types are always pictures; any other non-entities type is treated as
// one too, so an unknown card still shows its entity instead of a blank page.
function isImageCard(page) {
  const type = String(page?.cardtype || page?.config?.type || 'entities').toLowerCase();
  return IMAGE_CARD_TYPES.has(type) || (type !== 'entities' && Boolean(page?.config?.type || page?.cardtype));
}

// A card whose only entity comes from its own config ("entity: sensor.x") is
// painted as a picture too: listing that single entity would be a downgrade of
// what the card shows. A card the user filled with explicit rows stays a list.
function isConfigDrivenCard(entries, config) {
  if (entries.length !== 1) return false;
  const raw = config?.entity ?? config?.entities;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const first = list.length ? (typeof list[0] === 'string' ? list[0] : list[0]?.entity) : '';
  return typeof first === 'string' && first.trim() === entries[0].id;
}

export function buildPages(pages, statesById, { maxRows = 32, resolveIcon = null } = {}) {
  const out = [];
  for (const page of pages || []) {
    const entries = (page.entities || []).map(entityEntry).filter((e) => e.id);
    /* A card the row list cannot express becomes a picture: no rows, the card
     * type and raw config for cardrender.js, and the entities the integration
     * attached so a bare "sensor.x" config still resolves its state. */
    if (isImageCard(page) || isConfigDrivenCard(entries, page.config)) {
      const index = out.length;
      out.push({
        title: page.title || `Card ${index + 1}`,
        rows: [],
        card: {
          /* The dashboard page title is not part of the card: sending it made
           * cardrender draw it as the card name inside the picture. */
          cardtype: page.cardtype || page.config?.type || '',
          config: page.config || {},
        },
        entities: entries,
      });
      continue;
    }
    if (entries.length === 0) continue;
    const rows = [];
    for (const entry of entries.slice(0, maxRows)) {
      const state = statesById.get(entry.id);
      const label = entry.name && entry.name.trim() ? entry.name.trim() : entityLabel(state, entry.id);
      // Icon resolution: explicit choice > the entity's own icon attribute >
      // the domain default. `resolveIcon` is injected by the caller so this
      // module stays free of the icon tables.
      const icon = entry.icon || entityIconName(state);
      rows.push({
        label,
        value: entityValue(state),
        action: entry.id,
        icon: resolveIcon ? resolveIcon(icon, entry.id) : icon,
      });
    }
    const index = out.length;
    const title = page.title || `Card ${index + 1}`;
    out.push({ title, rows });
  }
  return out;
}

// --- history / statistics for graph cards ------------------------------------
//
// `history-graph`, `statistics-graph` and the Energy dashboard's
// `energy-usage-graph` all paint a time series, which the card's own state can
// never carry: the values live in HA's recorder, not in `/api/states`. The
// graphs are therefore drawn from a plain series of numbers fetched here, and
// that series rides with the card as `card.history` (see plugin.js) so
// cardrender.js can paint it without touching the network.
//
// The recorder is read over REST (`/api/history/period`), which the sandboxed
// webview does allow. The statistics websocket command
// (`recorder/statistics_during_period`) is the better source for long ranges
// (hourly/daily buckets instead of hundreds of raw points), so it is tried
// first; when the socket is unavailable the REST history path is used instead.


export function isGraphCardType(type) {
  return GRAPH_TYPES.has(String(type || '').toLowerCase());
}

// Maps a Lovelace duration ("24h", "7d", "1h30m", "60") to hours. The graph
// cards ask for `hours_to_show` (a number of hours) or a duration string on the
// Energy card; both end up here so the window matches what the card asked for.
function hoursOf(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 0;
  const re = /(\d+(?:\.\d+)?)\s*(d|j|h|m|s)?/g;
  let total = 0;
  let match;
  while ((match = re.exec(text))) {
    const amount = Number(match[1]);
    const unit = match[2] || 'h';
    if (unit === 'd' || unit === 'j') total += amount * 24;
    else if (unit === 'h') total += amount;
    else if (unit === 'm') total += amount / 60;
    else if (unit === 's') total += amount / 3600;
  }
  return total;
}

/* Time window a graph card asks for. HA's statistics-graph carries the span as
 * `days_to_show` (a 30-day card says 30) or `hours_to_show`; the `period` key
 * is a *bucket* name ("day", "hour", …), never a duration, so it must not be
 * read as hours (reading "day" as a number yielded a 1-hour window and a 30-day
 * card collapsed to an hour). A fixed `start_time`/`end_time` pair is honoured. */
export function graphWindow(config) {
  const daysToShow = Number(config?.days_to_show);
  const hoursToShow = Number(config?.hours_to_show);
  const durToShow = hoursOf(config?.hours_to_show);
  let hours = 24;
  if (Number.isFinite(daysToShow) && daysToShow > 0) hours = daysToShow * 24;
  else if (durToShow) hours = durToShow;
  else if (Number.isFinite(hoursToShow) && hoursToShow > 0) hours = hoursToShow;
  /* Statistics graphs routinely span weeks or a month (the Energy card's
   * 7-day view, a 30-day cost bar chart): keep the requested window rather
   * than clipping it, so the axis and the bucket match the card. */
  if (hours > 24 * 366) hours = 24 * 366;
  const end = Date.now();
  const start = end - hours * 3600 * 1000;
  /* Bucket: honour the card's own `period` when it names a real statistics
   * bucket; otherwise pick from the span (sub-hour for a couple of hours,
   * hourly for two days, daily beyond) so a week renders seven columns and a
   * month thirty. */
  const askedPeriod = String(config?.period || config?.statistics?.period || '').toLowerCase();
  const isBucket = /^(5minute|minute|hour|day|week|month)$/.test(askedPeriod);
  const bucket = isBucket
    ? askedPeriod
    : (hours <= 2 ? '5minute' : hours <= 48 ? 'hour' : 'day');
  return { start: new Date(start), end: new Date(end), hours, bucket };
}

// Entity ids a graph card draws: one `entity` (History graph's single line), an
// `entities` list ("sensor.power" or { entity: ... }), or the Energy card's
// `collection_key`/`stat_cfg` — which normally names none at all, so the caller
// passes the energy sensors it found as `fallbackIds`.
function graphEntityIds(config, fallbackIds = []) {
  const ids = [];
  const push = (value) => {
    const id = typeof value === 'string' ? value : value?.entity ?? value?.stat_consumption;
    if (typeof id === 'string' && id.trim() && !ids.includes(id.trim())) ids.push(id.trim());
  };
  const raw = config?.entity ?? config?.entities ?? config?.stat_cfg;
  for (const item of Array.isArray(raw) ? raw : raw ? [raw] : []) push(item);
  if (!ids.length) for (const id of fallbackIds || []) push(id);
  return ids;
}

// Energy sensors to plot for an Energy card that names none: the same kind of
// reading HA's Energy dashboard charts. Instantaneous power (W/kW) shows the
// usage shape best, so power sensors are preferred; a card with only energy
// meters falls back to the daily one (a monotonic weekly/monthly odometer draws
// a near-flat rising line, the least useful graph). Unavailable readings are
// skipped. At most two series, as the card has room for.
export function energySensorIds(states) {
  if (!states || typeof states.forEach !== 'function') return [];
  const power = [];
  const daily = [];
  const energy = [];
  for (const [id, state] of states) {
    if (!id.startsWith('sensor.')) continue;
    const raw = String(state?.state ?? '').toLowerCase();
    if (!raw || raw === 'unavailable' || raw === 'unknown') continue;
    const unit = String(state?.attributes?.unit_of_measurement || '').toLowerCase();
    const cls = String(state?.attributes?.device_class || '').toLowerCase();
    const isPower = cls === 'power' || ['w', 'kw'].includes(unit);
    const isEnergy = cls === 'energy' || ['kwh', 'wh', 'mwh'].includes(unit);
    if (isPower) power.push(id);
    else if (isEnergy && /dai|jour/.test(id)) daily.push(id);
    else if (isEnergy) energy.push(id);
  }
  return [...power, ...daily, ...energy].slice(0, 2);
}

function numericFromState(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Raw recorder history for one entity over the window, reduced to
// `{ t, y }` points (ms epoch, number). `/api/history/period` answers with a
// list of lists (one per entity id), oldest first.
async function fetchHistoryPoints(baseUrl, token, id, window) {
  const start = window.start.toISOString();
  const end = window.end.toISOString();
  const path = `/api/history/period/${encodeURIComponent(start)}`
    + `?filter_entity_id=${encodeURIComponent(id)}`
    + `&end_time=${encodeURIComponent(end)}`
    + '&minimal_response&no_attributes';
  let raw;
  try {
    raw = await haFetch(baseUrl, token, path, { timeoutMs: 12000 });
  } catch (error) {
    if (/HTTP 4\d\d/.test(String(error?.message || ''))) return [];
    throw error;
  }
  const list = Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : (Array.isArray(raw) ? raw : []);
  const points = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const y = numericFromState(entry.state);
    const stamp = Date.parse(entry.last_changed || entry.last_updated || '');
    if (y === null || !Number.isFinite(stamp)) continue;
    points.push({ t: stamp, y });
  }
  return bucketize(points, window);
}

/* Raw recorder history is every state change (hundreds over a month), which a
 * bar chart cannot show as one column each. Reduce the points into the card's
 * statistics buckets (5minute/hour/day/week/month): each bucket keeps its last
 * reading (the sampled `state`), so a 30-day daily card becomes 30 bars and a
 * 24-hour hourly card 24, the same shape HA's statistics graph draws. Points
 * already coarse enough (<= 1.5 buckets' worth) are kept as-is. */
const BUCKET_MS = {
  '5minute': 5 * 60 * 1000,
  minute: 60 * 1000,
  hour: 3600 * 1000,
  day: 86400 * 1000,
  week: 7 * 86400 * 1000,
  month: 30 * 86400 * 1000,
};

function bucketize(points, window) {
  if (points.length <= 2) return points;
  const size = BUCKET_MS[window.bucket];
  if (!size) return points;
  const span = window.end - window.start;
  const slots = Math.max(1, Math.round(span / size));
  if (points.length <= slots * 1.5) return points;
  const startMs = window.start.getTime();
  const bySlot = new Map();
  for (const p of points) {
    const slot = Math.floor((p.t - startMs) / size);
    if (slot < 0 || slot >= slots) continue;
    bySlot.set(slot, p); // last reading in the slot wins
  }
  const out = [];
  for (let i = 0; i < slots; i += 1) {
    const p = bySlot.get(i);
    if (p) out.push({ t: startMs + i * size + size / 2, y: p.y });
  }
  return out.length ? out : points;
}

// Statistics buckets for one entity, reduced to `{ t, y }` points. The
// websocket returns `{ [entity_id]: [{ start, end, mean, min, max, state, sum }] }`;
// the plotted value is the mean (the way HA's own statistics graph draws a
// measurement) and, for a `total_increasing` meter (Energy's kWh sensors), the
// summed change, so bars show consumption per bucket rather than a rising
// odometer.
function statisticsRowsToPoints(result, id) {
  const rows = result && typeof result === 'object' ? (result[id] || []) : [];
  if (!Array.isArray(rows)) return [];
  const points = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    /* `recorder/statistics_during_period` answers `start`/`end` as epoch
     * milliseconds (numbers), not ISO strings: `Date.parse(1791496800000)`
     * is NaN, which silently dropped every row and left the card on the
     * REST fallback (a handful of raw history points). Accept both shapes. */
    const raw = row.start ?? row.end;
    const t = typeof raw === 'number' ? raw
      : (raw instanceof Date ? raw.getTime() : Date.parse(String(raw ?? '')));
    const y = numericFromState(row.mean ?? row.state ?? row.max);
    if (!Number.isFinite(t) || y === null) continue;
    const change = numericFromState(row.change);
    points.push({ t, y, change });
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

async function statisticsRequest(baseUrl, token, id, start, end, bucket) {
  return await withWebSocket(baseUrl, token, async (send) => {
    return await send('recorder/statistics_during_period', {
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      statistic_ids: [id],
      period: bucket,
      types: ['mean', 'min', 'max', 'state', 'change'],
    });
  });
}

/* The last successful statistics answer per entity/window is kept on the phone
 * so a transient websocket failure (or the host closing it mid-dashboard) does
 * not drop a 30-day card back to the 10-day REST history — which is exactly
 * what a card showing "10 bars, 29/10→08/11, some empty" looks like. */
const STATS_CACHE_MS = 7 * 24 * 3600 * 1000;

function statsCacheKey(id, window) {
  const hours = Math.round((window.end - window.start) / 3600000);
  return `ha-stats:${id}:${window.bucket}:${hours}`;
}

function readStatsCache(key) {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value || !Array.isArray(value.points) || !value.points.length) return null;
    if (!Number.isFinite(value.at) || Date.now() - value.at > STATS_CACHE_MS) return null;
    return value.points.filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.y));
  } catch {
    return null;
  }
}

function writeStatsCache(key, points) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), points }));
  } catch { /* storage full or disabled: the cache is only an optimisation */ }
}

async function fetchStatisticsPoints(baseUrl, token, id, window) {
  const key = statsCacheKey(id, window);
  let points = [];
  try {
    points = statisticsRowsToPoints(
      await statisticsRequest(baseUrl, token, id, window.start, window.end, window.bucket),
      id,
    );
  } catch {
    points = [];
  }
  /* A long range can be refused or cut short by the recorder; retry in
   * smaller slices and stitch them together, oldest first. */
  if (!points.length) {
    try {
      const sliceMs = 7 * 86400 * 1000;
      const stitched = [];
      for (let s = window.start.getTime(); s < window.end.getTime(); s += sliceMs) {
        const e = Math.min(s + sliceMs, window.end.getTime());
        stitched.push(...statisticsRowsToPoints(
          await statisticsRequest(baseUrl, token, id, new Date(s), new Date(e), window.bucket),
          id,
        ));
      }
      if (stitched.length) points = stitched.sort((a, b) => a.t - b.t);
    } catch {
      points = [];
    }
  }
  const cached = readStatsCache(key);
  /* Fresh data wins, but never lose a longer history to a short answer:
   * prefer whichever set covers more buckets. */
  if (cached && cached.length > points.length) points = cached;
  if (points.length) writeStatsCache(key, points);
  return points;
}

/* Series for every entity a graph card draws, in card order, as
 * [{ id, points: [{ t, y }] }]. A statistics/energy card uses the statistics
 * websocket; a plain history graph, or any card whose instance refuses the
 * socket, falls back to the recorder history REST endpoint. Failures are
 * per-entity and never throw: a graph with one empty line still paints the
 * other, and an all-empty graph is drawn as "no data" by cardrender. */
export async function fetchCardSeries(baseUrl, token, config, type = '', fallbackIds = []) {
  const ids = graphEntityIds(config, fallbackIds);
  if (!ids.length) return [];
  const wantStatistics = /statistics-graph|energy-usage-graph/.test(String(type || '').toLowerCase());
  const window = graphWindow(config);
  const out = [];
  for (const id of ids.slice(0, 4)) {
    let points = [];
    if (wantStatistics) {
      try {
        points = await fetchStatisticsPoints(baseUrl, token, id, window);
      } catch {
        points = [];
      }
    }
    if (!points.length) {
      try {
        points = await fetchHistoryPoints(baseUrl, token, id, window);
      } catch {
        points = [];
      }
    }
    /* The raw history only reaches back as far as the recorder keeps it
     * (10 days by default), so a short statistics answer plus a longer drawn
     * history is stitched by bucket: statistics win on the days they cover. */
    if (wantStatistics && points.length) {
      try {
        const history = await fetchHistoryPoints(baseUrl, token, id, window);
        if (history.length > points.length) {
          const bySlot = new Map();
          for (const p of history) bySlot.set(p.t, p);
          for (const p of points) bySlot.set(p.t, p);
          const merged = [...bySlot.values()].sort((a, b) => a.t - b.t);
          if (merged.length > points.length) points = merged;
        }
      } catch { /* the statistics answer stays as is */ }
    }
    out.push({ id, points });
  }
  return out;
}
