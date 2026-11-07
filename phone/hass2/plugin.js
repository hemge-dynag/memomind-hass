import { createGMPlugin } from './vendor/gm-plugin-web-sdk.esm.js';
import {
  PAGES_CHANNEL,
  EVENT_CHANNEL,
  MAX_PAGES,
  MAX_ROWS,
  decodeEvent,
  encodeClear,
  encodeNav,
  encodeSetPages,
  EVENT_CHANNEL as EVENT_CHANNEL_CONST,
  NAV_ACTIVATE,
  NAV_FOCUS_DOWN,
  NAV_FOCUS_UP,
  NAV_PAGE_NEXT,
  NAV_PAGE_PREV,
} from './protocol.js';
import { detectLocale, getStrings, format } from './translations.js';
import {
  ICON_NAMES,
  defaultIconForDomain,
  iconId,
  iconNode,
  isKnownIcon,
} from './icons.js';
import {
  buildPages,
  callAction,
  cardEntityIds,
  entityEntry,
  fetchAllEntities,
  dashboardSummary,
  fetchLovelaceDashboard,
  fetchLovelaceDashboards,
  lovelacePagesToCards,
  REST_DASHBOARD_ID,
  fetchEntityState,
  fetchStates,
  attachForecasts,
  testConnection,
} from './ha.js';
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  PAN_STEP,
  cardScrollRows,
  cardToGray4,
  cardToGray4Window,
  cardFocusEntities,
  cardFocusActions,
  gridColumnCount,
  gridRowOf,
} from './cardrender.js';

import { presentGray4, presentGray4Patch } from './display.js';

/* A still card pans over the rows below the picture: six steps of PAN_STEP lead
 * to the bottom of the banner added under it. */
const MAX_PAN_STEPS = 6;

const S = getStrings(detectLocale());

const STORAGE_KEY = 'hass-config';
const DEFAULT_REFRESH_MINUTES = 10;
// Pre-filled Home Assistant connection, used until the user saves their own.
/* Dynag wants the glasses to show one dashboard only: the one they build
 * for Memo. Until they pick another one in the settings, every install starts
 * on it, so a fresh phone has something to send without any setup. */
const DEFAULT_DASHBOARD_ID = 'dashboard-memo';
const DEFAULT_URL = 'https://h.dynag.co';
const DEFAULT_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiIwZGY2ODNmMzM1ODc0MGUyOWFlNDJhOWMwOGRjNWRhNSIsImlhdCI6MTc5Mjc0MzA1MSwiZXhwIjoyMTA4MTAzMDUxfQ.my_M8xK1qQskLwz3puOgNWWcf6XBoYgoE6UgeT37IAI';

const gm = createGMPlugin();

const els = {
  // header
  title: document.querySelector('#app-title'),
  settingsButton: document.querySelector('#settings-button'),
  // main screen
  mainScreen: document.querySelector('#main-screen'),
  status: document.querySelector('#status'),
  gestureDebug: document.querySelector('#gesture-debug'),
  syncButton: document.querySelector('#sync-button'),
  dashboardsTitle: document.querySelector('#dashboards-title'),
  dashboardsHint: document.querySelector('#dashboards-hint'),
  dashboardsList: document.querySelector('#dashboards-list'),
  refreshDashboardsButton: document.querySelector('#refresh-dashboards-button'),
  cardsTitle: document.querySelector('#cards-title'),
  cardsHint: document.querySelector('#cards-hint'),
  cardsList: document.querySelector('#cards-list'),
  addCardButton: document.querySelector('#add-card-button'),
  glassesHint: document.querySelector('#glasses-hint'),
  navSection: document.querySelector('#nav-section'),
  navTitle: document.querySelector('#nav-title'),
  navHint: document.querySelector('#nav-hint'),
  navPrev: document.querySelector('#nav-prev'),
  navNext: document.querySelector('#nav-next'),
  navUp: document.querySelector('#nav-up'),
  navDown: document.querySelector('#nav-down'),
  navActivate: document.querySelector('#nav-activate'),
  navState: document.querySelector('#nav-state'),
  // settings screen
  settingsScreen: document.querySelector('#settings-screen'),
  settingsTitle: document.querySelector('#settings-title'),
  settingsHint: document.querySelector('#settings-hint'),
  backButton: document.querySelector('#back-button'),
  form: document.querySelector('#config-form'),
  url: document.querySelector('#ha-url'),
  token: document.querySelector('#ha-token'),
  autoRefresh: document.querySelector('#ha-autorefresh'),
  urlLabel: document.querySelector('#url-label'),
  tokenLabel: document.querySelector('#token-label'),
  tokenHint: document.querySelector('#token-hint'),
  autoRefreshLabel: document.querySelector('#autorefresh-label'),
  autoRefreshHint: document.querySelector('#autorefresh-hint'),
  testButton: document.querySelector('#test-button'),
  loadButton: document.querySelector('#load-button'),
  saveSettingsButton: document.querySelector('#save-settings-button'),
};

let config = emptyConfig();
let connected = false;
let autoRefreshTimer = null;
let allEntities = [];
let entitiesCache = new Map();
const expanded = new Set(); // open cards, keyed by page object
let editingPage = null; // card currently in edit mode, or null
let editSnapshot = null; // JSON snapshot of the card when editing started
let glassesDashboards = []; // dashboards listed by Home Assistant (Lovelace)
/* Debug navigation: head gestures are off on the glasses, so the phone shows
 * buttons that drive the same things a gesture used to (page, row, activate).
 * The cursor mirrors what the glasses hold: the page they report, the row the
 * user moved to. */
let navPage = 0; // page the glasses currently show
let navRow = 0; // selected row on a text page
const HINT_PAGE = -1; // the local "head gestures disabled" page on the glasses
let dashboardsError = ''; // non-empty when Home Assistant could not be asked
let remoteDashboards = new Map(); // url_path -> fetched Lovelace pages
let imagePages = []; // pages that carry a card picture, in glasses page order
let pushedPages = []; // every page last pushed to the glasses, by page index
let cardCanvas = null; // reused offscreen canvas for card rendering
/* Signature of the picture last pushed per page. The glasses hold one picture,
 * and a page request always means "pixels are not on screen", so `pushed` only
 * keeps the automatic refresh from resending a picture nothing has changed on. */
const pushedCards = new Map(); // page index -> card + states signature
let cardInFlight = null; // pending picture push (the phone sends one at a time)
// Page the glasses show right now, as last reported by a page-changed event.
// Pictures are only pushed for it: the glasses keep one card buffer and drop
// every tile that belongs to another page.
let visiblePage = 0;
const cardScroll = new Map(); // page index -> first visible row of a card picture
/* Which actionable entity of a card the wearer is on: page index -> position in
 * cardFocusEntities(card). Up/down moves it, the glasses' button triggers it.
 * Kept on the phone because a card picture is drawn here; the glasses only see
 * the ring the renderer paints into the frame. */
const cardFocus = new Map();
/* The picture really on the glasses: its page, the row offset it was rendered
 * at, and its pixels. A scroll may only send the rows that differ from *this*
 * frame. Diffing against the frame cache instead was the black-card bug: the
 * card of the page being turned to is already pre-rendered at offset 0, so a
 * request for offset 0 looked like "nothing moved" and sent no tile at all,
 * leaving the glasses on their loading screen. Cleared whenever the glasses
 * rebuild their screen (page change, sync). */
let onGlass = null; // { index, offset, frame }
/* The glasses hold the picture of the page on screen and nothing else. They
 * used to keep a ring of extra pictures, and every preload of a neighbour cost
 * the visible card its buffer, its lookups and a Bluetooth transfer the wearer
 * was waiting behind. What still runs ahead is local: every card is rendered
 * into the frame cache, so a page change only pays for the transfer itself. */

function emptyConfig() {
  return {
    url: DEFAULT_URL,
    token: DEFAULT_TOKEN,
    autoRefreshMinutes: DEFAULT_REFRESH_MINUTES,
    // '' = use the local cards; otherwise the id of the dashboard selected in
    // the MemoMind Glasses Home Assistant integration.
    dashboardId: DEFAULT_DASHBOARD_ID,
    pages: [{ title: '', entities: [] }],
  };
}

function setStatus(text, state = '') {
  els.status.textContent = text;
  els.status.className = `status ${state}`.trim();
}

// Diagnostic 1.0.16: names of the raw gesture ids the glasses report, so the
// wearer can read on the phone what the Host actually delivered. The ids match
// GlassSDK/include/gm_plugin.h (gm_plugin_imu_gesture_t).
const GESTURE_NAMES = {
  0: 'AUCUN', 1: 'NOD', 2: 'HAUT', 3: 'BAS', 4: 'SHAKE',
  5: 'HAUT (timeout)', 6: 'BAS (timeout)', 7: 'GAUCHE', 8: 'DROITE',
};

function showGestureDebug(gesture, active) {
  if (!els.gestureDebug) return;
  els.gestureDebug.hidden = false;
  const name = GESTURE_NAMES[gesture] || '?';
  els.gestureDebug.textContent = `GESTE BRUT : ${gesture} (${name})${active ? '' : ' · relâché'}`;
  els.gestureDebug.classList.remove('hit');
  // Restart the highlight so a repeated id still flashes.
  void els.gestureDebug.offsetWidth;
  els.gestureDebug.classList.add('hit');
}

// --- strings / i18n ---------------------------------------------------------

function applyStrings() {
  document.documentElement.lang = detectLocale();
  els.title.textContent = S.appTitle;
  els.settingsButton.textContent = S.settingsButton;
  els.dashboardsTitle.textContent = S.dashboardsLabel;
  els.refreshDashboardsButton.textContent = S.refreshDashboards;
  els.cardsTitle.textContent = S.cardsLabel;
  els.cardsHint.textContent = S.cardsHint;
  els.addCardButton.textContent = S.addCard;
  els.glassesHint.textContent = S.glassesHint;
  els.settingsTitle.textContent = S.settingsTitle;
  els.settingsHint.textContent = S.settingsHint;
  els.backButton.textContent = S.backButton;
  els.urlLabel.textContent = S.urlLabel;
  els.url.placeholder = S.urlPlaceholder;
  els.tokenLabel.textContent = S.tokenLabel;
  els.token.placeholder = S.tokenPlaceholder;
  els.tokenHint.textContent = S.tokenHint;
  els.autoRefreshLabel.textContent = S.autoRefreshLabel;
  els.autoRefreshHint.textContent = S.autoRefreshHint;
  els.testButton.textContent = S.testButton;
  els.loadButton.textContent = S.loadEntities;
  els.saveSettingsButton.textContent = S.saveButton;
  els.navTitle.textContent = S.navTitle;
  els.navHint.textContent = S.navHint;
  els.navPrev.textContent = S.navPrev;
  els.navNext.textContent = S.navNext;
  els.navUp.textContent = S.navUp;
  els.navDown.textContent = S.navDown;
  els.navActivate.textContent = S.navActivate;
}

// --- persistence ------------------------------------------------------------

function normalizeMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_REFRESH_MINUTES;
  return Math.min(1440, Math.round(n));
}

function normalizePage(page) {
  return {
    title: typeof page?.title === 'string' ? page.title : '',
    entities: Array.isArray(page?.entities)
      ? page.entities.map(entityEntry).filter((e) => e.id)
      : [],
  };
}

let storageGetFailed = false;

async function loadConfig() {
  let result = null;
  try {
    result = await gm.storage.get(STORAGE_KEY);
  } catch (error) {
    storageGetFailed = true;
    console.warn('[hass2] storage.get a échoué, réglages par défaut', error);
  }
  const value = result?.value;
  if (value && typeof value === 'object') {
    config = {
      url: value.url || DEFAULT_URL,
      token: value.token || DEFAULT_TOKEN,
      autoRefreshMinutes: normalizeMinutes(value.autoRefreshMinutes),
      dashboardId: typeof value.dashboardId === 'string' ? value.dashboardId : DEFAULT_DASHBOARD_ID,
      pages: Array.isArray(value.pages) && value.pages.length
        ? value.pages.map(normalizePage)
        : [{ title: '', entities: [] }],
    };
  }
  els.url.value = config.url;
  els.token.value = config.token;
  els.autoRefresh.value = String(config.autoRefreshMinutes);
}

// Reads the settings form into `config` (url, token, refresh delay) and saves.
async function persistConfig() {
  config.url = els.url.value.trim();
  config.token = els.token.value.trim();
  config.autoRefreshMinutes = normalizeMinutes(els.autoRefresh.value);
  els.autoRefresh.value = String(config.autoRefreshMinutes);
  await gm.storage.set(STORAGE_KEY, config);
}

// Cards are persisted on their own (add/remove/reorder/rename/entities),
// without touching the settings fields.
async function persistCards() {
  await gm.storage.set(STORAGE_KEY, config);
}

function isConnectionReady() {
  return Boolean(config.url.trim() && config.token.trim());
}

function isConfigured() {
  if (!isConnectionReady()) return false;
  if (config.dashboardId) return true;
  return config.pages.some((p) => p.entities.length > 0);
}

function useRemoteDashboard() {
  return Boolean(config.dashboardId);
}

// --- entity helpers ---------------------------------------------------------

function friendlyLabel(id) {
  const found = allEntities.find((e) => e.id === id);
  return found ? found.label : id;
}

// The label shown for an entity entry: its custom name when set, else the
// friendly name resolved from Home Assistant (or the raw id as a fallback).
function entryLabel(entry) {
  return entry.name && entry.name.trim() ? entry.name.trim() : friendlyLabel(entry.id);
}

// The icon name an entry shows on the phone: its explicit choice when set,
// else the entity's own icon attribute, else the default for its domain.
function entryIconName(entry) {
  if (entry && isKnownIcon(entry.icon)) return entry.icon;
  const found = allEntities.find((e) => e.id === entry?.id);
  if (found && isKnownIcon(found.icon)) return found.icon;
  return defaultIconForDomain(domainOf(entry?.id));
}

function domainOf(id) {
  const dot = String(id || '').indexOf('.');
  return dot > 0 ? String(id).slice(0, dot) : '';
}

// Resolves the icon sent to the glasses: a known name -> its table index,
// otherwise the domain default (which always maps to a known icon, so the
// glasses never receive the "no icon" marker).
function resolveGlassesIcon(name, entityId) {
  if (isKnownIcon(name)) return iconId(name);
  return iconId(defaultIconForDomain(domainOf(entityId)));
}

// Icon node for an entity, sized for a compact row. Returns null when unknown.
function entryIconNode(entry, size = 18) {
  return iconNode(entryIconName(entry), size);
}

function labelForEntity(id) {
  for (const page of config.pages) {
    const found = (page.entities || []).find((e) => e.id === id);
    if (found) return entryLabel(found);
  }
  return friendlyLabel(id);
}

function entityMatchesFilter(entity, needle) {
  if (!needle) return true;
  return entity.label.toLowerCase().includes(needle) || entity.id.toLowerCase().includes(needle);
}

// --- drag & drop reordering -------------------------------------------------

let sortState = null;

// Makes the direct children of `container` (those carrying [data-sort-item])
// reorderable by dragging their `.drag-handle`. `onDrop` runs once the pointer
// is released. Pointer events are used so it works with both mouse and touch.
function attachSortable(container, onDrop) {
  container.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    const handle = event.target.closest('.drag-handle');
    if (!handle || !container.contains(handle)) return;
    const item = handle.closest('[data-sort-item]');
    if (!item || item.parentElement !== container) return;
    event.preventDefault();
    sortState = { container, item, onDrop };
    item.classList.add('dragging');
    window.addEventListener('pointermove', onSortMove);
    window.addEventListener('pointerup', onSortUp);
    window.addEventListener('pointercancel', onSortUp);
  });
}

function onSortMove(event) {
  if (!sortState) return;
  const { container, item } = sortState;
  event.preventDefault();
  const y = event.clientY;
  const items = directSortItems(container).filter((i) => i !== item);
  let before = null;
  for (const it of items) {
    const rect = it.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) { before = it; break; }
  }
  if (before) {
    if (before !== item.nextElementSibling) container.insertBefore(item, before);
  } else if (container.lastElementChild !== item) {
    container.appendChild(item);
  }
}

function onSortUp() {
  if (!sortState) return;
  const { container, item, onDrop } = sortState;
  item.classList.remove('dragging');
  window.removeEventListener('pointermove', onSortMove);
  window.removeEventListener('pointerup', onSortUp);
  window.removeEventListener('pointercancel', onSortUp);
  sortState = null;
  onDrop(container);
}

function directSortItems(container) {
  return [...container.children].filter((el) => el.hasAttribute('data-sort-item'));
}

// --- screens ----------------------------------------------------------------

function showMain() {
  cancelEdit();
  els.settingsScreen.hidden = true;
  els.mainScreen.hidden = false;
  els.settingsButton.hidden = false;
  renderDashboards();
}

function showSettings() {
  cancelEdit();
  els.mainScreen.hidden = true;
  els.settingsScreen.hidden = false;
  els.settingsButton.hidden = true;
  void refreshDashboards();
}

// --- dashboards (Home Assistant integration) -------------------------------

/* A failure has to name its cause where the user can read it: the settings
 * page showed only whatever the raw exception said, and a browser-refused
 * websocket surfaces as a bare "connexion WebSocket impossible" that says
 * nothing about what to fix. */
function describeHaError(error) {
  const text = String(error?.message || error || '').trim();
  if (/WebSocket indisponible/i.test(text)) {
    return format(S.haErrorNoWebSocket, { msg: text });
  }
  if (/WebSocket impossible|WebSocket fermée/i.test(text)) {
    return format(S.haErrorSocket, { msg: text });
  }
  if (/délai dépassé/i.test(text)) return format(S.haErrorTimeout, { msg: text });
  if (/401/i.test(text)) return format(S.haErrorAuth, { msg: text });
  return text || S.haErrorUnknown;
}

// Lists the dashboards the user built in Home Assistant itself (Lovelace
// storage dashboards). Called when the settings screen opens and when the user
// taps "Actualiser"; a failed connection leaves the local cards usable.
async function refreshDashboards({ quiet = false } = {}) {
  if (!isConnectionReady()) {
    glassesDashboards = [];
    remoteDashboards.clear();
    dashboardsError = '';
    if (!quiet) setStatus(S.noConnection, 'error');
    renderDashboards();
    return;
  }
  if (!quiet) setStatus(S.statusLoadingDashboards);
  try {
    glassesDashboards = await fetchLovelaceDashboards(config.url, config.token);
    remoteDashboards.clear();
    dashboardsError = '';
    // A dashboard deleted on the HA side silently falls back to local cards.
    if (config.dashboardId && !glassesDashboards.some((d) => d.id === config.dashboardId)) {
      config.dashboardId = '';
      await persistConfig();
    }
  } catch (error) {
    glassesDashboards = [];
    remoteDashboards.clear();
    dashboardsError = describeHaError(error);
    console.warn('[hass2] lecture des dashboards impossible', error);
  }
  const restMode = glassesDashboards.some((d) => d.rest);
  if (!quiet) {
    if (restMode) {
      setStatus(S.statusRestMode, 'ready');
    } else if (dashboardsError) {
      setStatus(format(S.statusError, { msg: dashboardsError }), 'error');
    } else {
      setStatus(format(S.statusDashboardsFound, { n: glassesDashboards.length }), 'ready');
    }
  }
  renderDashboards();
  // Page/row counts need the dashboard's views: fetch the picked one (or the
  // first) in the background so the list gains its meta without blocking.
  const target = config.dashboardId || glassesDashboards[0]?.id;
  if (target) void loadDashboardSummary(target);
}

// Fetches one dashboard for the meta line. Failures are kept for that option.
async function loadDashboardSummary(id) {
  if (!id) return;
  // The REST dashboard has no Lovelace views on the HA side: its summary comes
  // from the pages built locally, so it costs nothing to compute again.
  if (id !== REST_DASHBOARD_ID && remoteDashboards.has(id)) return;
  try {
    const pages = await fetchLovelaceDashboard(config.url, config.token, id);
    remoteDashboards.set(id, dashboardSummary(pages));
  } catch (error) {
    remoteDashboards.set(id, { error: error.message || String(error) });
  }
  renderDashboards();
}

// The Lovelace pages of the picked dashboard, fetched once per selection.
async function loadRemoteDashboard(id) {
  if (!id) return null;
  const cached = remoteDashboards.get(id);
  if (cached && Array.isArray(cached.pages) && id !== REST_DASHBOARD_ID) return cached.pages;
  const pages = await fetchLovelaceDashboard(config.url, config.token, id);
  remoteDashboards.set(id, { ...dashboardSummary(pages), pages });
  return pages;
}

function renderDashboards() {
  els.dashboardsList.replaceChildren();
  els.dashboardsHint.textContent = glassesDashboards.some((d) => d.rest)
    ? S.dashboardsRestHint
    : dashboardsError
    ? format(S.dashboardsUnavailable, { msg: dashboardsError })
    : glassesDashboards.length
      ? S.dashboardsHint
      : S.dashboardsEmpty;

  const local = dashboardOption(null, S.dashboardsLocal, S.dashboardsLocalMeta);
  els.dashboardsList.append(local);
  for (const dashboard of glassesDashboards) {
    const summary = remoteDashboards.get(dashboard.id);
    const meta = summary?.error
      ? summary.error
      : summary
        ? format(S.dashboardsMeta, { pages: summary.pageCount, rows: summary.rowCount })
        : '';
    els.dashboardsList.append(
      dashboardOption(
        dashboard.id,
        dashboard.name || S.dashboardsUntitled,
        dashboard.rest && !summary ? S.dashboardsRestMeta : meta,
      ),
    );
    if (!summary) void loadDashboardSummary(dashboard.id);
  }
}

function dashboardOption(id, name, meta) {
  const label = document.createElement('label');
  label.className = `dashboard-option${(config.dashboardId || '') === (id || '') ? ' active' : ''}`;
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'glasses-dashboard';
  input.checked = (config.dashboardId || '') === (id || '');
  input.addEventListener('change', () => void selectDashboard(id || ''));
  const text = document.createElement('span');
  text.className = 'dashboard-name';
  text.textContent = name;
  const detail = document.createElement('span');
  detail.className = 'dashboard-meta';
  detail.textContent = meta || '';
  label.append(input, text, detail);
  return label;
}

// Persists the choice and pushes the matching pages straight away, so the
// wearer sees the new dashboard without waiting for the next auto-refresh.
async function selectDashboard(id) {
  config.dashboardId = id;
  await persistConfig();
  renderDashboards();
  if (id && !remoteDashboards.get(id)?.pages) void loadRemoteDashboard(id);
  if (connected) await syncPages();
}

// --- cards ------------------------------------------------------------------

// One DOM node per page, kept across renders: toggling a card, loading the
// entity list or saving no longer tears every card down and rebuilds it. The
// node is reused and only its header and body are refreshed in place, so an
// open editor keeps its inputs (and their focus) while the rest updates.
const cardNodes = new WeakMap(); // page object -> <article>

function renderCards() {
  const wanted = new Set(config.pages);
  // Drop cards that no longer exist (deleted pages).
  for (const node of Array.from(els.cardsList.children)) {
    if (!wanted.has(node._page)) {
      cardNodes.delete(node._page);
      node.remove();
    }
  }
  // Reuse an existing node per page, appending in order (appendChild moves an
  // existing child, so the order follows config.pages without recreating).
  config.pages.forEach((page) => {
    let article = cardNodes.get(page);
    if (!article) {
      article = document.createElement('article');
      article.setAttribute('data-sort-item', '');
      article._page = page;
      cardNodes.set(page, article);
    }
    updateCardNode(article, page);
    els.cardsList.append(article);
  });
}

// Refreshes one card in place. The header is cheap to rebuild; the body is only
// rebuilt when the card opened/closed or the editor started/stopped, because
// rebuilding a live editor would throw away what the wearer is typing.
function updateCardNode(article, page) {
  const isEditing = editingPage === page;
  const isOpen = expanded.has(page) || isEditing;
  const mode = isEditing ? 'edit' : (isOpen ? 'view' : 'closed');

  article.className = `card${isOpen ? ' open' : ''}`;

  // Header (drag handle + chevron + name + count). Rebuilt only when it did not
  // exist yet or its label/count changed.
  let head = article.querySelector(':scope > .card-head');
  const nameText = page.title && page.title.trim() ? page.title : S.cardTitlePlaceholder;
  const countText = String(page.entities.length);
  if (!head) {
    head = buildCardHead(page);
    article.prepend(head);
  }
  const nameEl = head.querySelector('.card-name');
  if (nameEl && nameEl.textContent !== nameText) nameEl.textContent = nameText;
  const countEl = head.querySelector('.card-count');
  if (countEl && countEl.textContent !== countText) countEl.textContent = countText;

  // Body: recreate only when the view mode changed.
  const body = article.querySelector(':scope > .card-body');
  if (article._mode === mode && body) return;
  if (body) body.remove();
  article._mode = mode;
  if (mode === 'closed') return;
  const fresh = document.createElement('div');
  fresh.className = 'card-body';
  if (mode === 'edit') renderCardEditor(fresh, page);
  else renderCardView(fresh, page);
  article.append(fresh);
}

function buildCardHead(page) {
  const head = document.createElement('div');
  head.className = 'card-head';
  const grip = document.createElement('span');
  grip.className = 'drag-handle';
  grip.textContent = '⠿';
  grip.title = S.cardsLabel;
  grip.addEventListener('click', (event) => event.stopPropagation());
  const chevron = document.createElement('span');
  chevron.className = 'card-chevron';
  chevron.textContent = '▸';
  const name = document.createElement('span');
  name.className = 'card-name';
  const count = document.createElement('span');
  count.className = 'card-count';
  head.append(grip, chevron, name, count);
  head.addEventListener('click', () => {
    if (editingPage === page) return;
    if (expanded.has(page)) expanded.delete(page);
    else expanded.add(page);
    renderCards();
  });
  return head;
}

function renderCardView(body, page) {
  if (page.entities.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'card-empty';
    empty.textContent = S.noEntities;
    body.append(empty);
  } else {
    const list = document.createElement('ul');
    list.className = 'entity-rows';
    for (const entry of page.entities) {
      const li = document.createElement('li');
      const info = document.createElement('span');
      info.className = 'ent-info';
      const icon = entryIconNode(entry);
      if (icon) {
        icon.classList.add('ent-icon');
        li.append(icon);
      }
      const nm = document.createElement('span');
      nm.className = 'ent-name';
      nm.textContent = entryLabel(entry);
      const id = document.createElement('span');
      id.className = 'ent-id';
      id.textContent = entry.id;
      info.append(nm, id);
      li.append(info);
      list.append(li);
    }
    body.append(list);
  }

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'small';
  editBtn.textContent = S.editCard;
  editBtn.addEventListener('click', () => startEdit(page));
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'small danger';
  delBtn.textContent = S.deleteCard;
  delBtn.addEventListener('click', () => deleteCard(page));
  actions.append(editBtn, delBtn);
  body.append(actions);
}

function renderCardEditor(body, page) {
  // Title
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'card-title-input';
  titleInput.maxLength = 32;
  titleInput.placeholder = S.cardTitlePlaceholder;
  titleInput.value = page.title;
  titleInput.addEventListener('input', () => { page.title = titleInput.value; });
  body.append(titleInput);

  // Selected entities list (kept in place while editing).
  const selectedList = document.createElement('ul');
  selectedList.className = 'entity-rows';
  body.append(selectedList);

  // Add-entity box: search + available entity list.
  const addBox = document.createElement('div');
  addBox.className = 'add-box';
  const addTitle = document.createElement('h3');
  addTitle.className = 'column-title';
  addTitle.textContent = S.addEntity;
  addBox.append(addTitle);

  let search = null;
  let availableList = null;
  if (allEntities.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = S.loadFirst;
    addBox.append(hint);
  } else {
    search = document.createElement('input');
    search.type = 'search';
    search.autocomplete = 'off';
    search.spellcheck = false;
    search.className = 'add-search';
    search.placeholder = S.searchPlaceholder;
    availableList = document.createElement('ul');
    availableList.className = 'available-list';
    addBox.append(search, availableList);
  }
  body.append(addBox);

  // Save / cancel
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'small';
  saveBtn.textContent = S.saveButton;
  saveBtn.addEventListener('click', () => void saveEdit());
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'small ghost';
  cancelBtn.textContent = S.cancelEdit;
  cancelBtn.addEventListener('click', cancelEdit);
  actions.append(saveBtn, cancelBtn);
  body.append(actions);

  // --- live updates --------------------------------------------------------
  const updateCount = () => {
    const countEl = body.closest('.card')?.querySelector('.card-count');
    if (countEl) countEl.textContent = String(page.entities.length);
  };

  const refreshAvailable = () => {
    if (!availableList) return;
    const needle = search.value.trim().toLowerCase();
    const chosen = new Set(page.entities.map((e) => e.id));
    availableList.replaceChildren();
    const items = allEntities.filter(
      (e) => !chosen.has(e.id) && entityMatchesFilter(e, needle));
    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = S.noAvailableEntities;
      availableList.append(li);
      return;
    }
    for (const entity of items) {
      const li = document.createElement('li');
      const info = document.createElement('span');
      info.className = 'ent-info';
      const icon = iconNode(entity.icon || defaultIconForDomain(entity.domain), 20);
      if (icon) {
        icon.classList.add('ent-icon');
        li.append(icon);
      }
      const nm = document.createElement('span');
      nm.className = 'ent-name';
      nm.textContent = entity.label;
      const id = document.createElement('span');
      id.className = 'ent-id';
      id.textContent = entity.id;
      info.append(nm, id);
      const plus = document.createElement('span');
      plus.className = 'add-plus';
      plus.textContent = '+';
      li.append(info, plus);
      li.addEventListener('click', () => {
        page.entities.push({ id: entity.id, name: '', icon: '' });
        updateCount();
        refreshSelected();
        refreshAvailable();
      });
      availableList.append(li);
    }
  };

  const refreshSelected = () => {
    selectedList.replaceChildren();
    if (page.entities.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'card-empty';
      empty.textContent = S.noEntities;
      selectedList.append(empty);
      return;
    }
    page.entities.forEach((entry) => {
      const li = document.createElement('li');
      li.setAttribute('data-sort-item', '');
      li._entry = entry;
      const grip = document.createElement('span');
      grip.className = 'drag-handle';
      grip.textContent = '⠿';
      grip.addEventListener('click', (event) => event.stopPropagation());
      const field = document.createElement('div');
      field.className = 'ent-edit';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.maxLength = 32;
      nameInput.placeholder = entryLabel(entry);
      nameInput.value = entry.name || '';
      nameInput.addEventListener('input', () => { entry.name = nameInput.value; });
      const id = document.createElement('span');
      id.className = 'ent-id';
      id.textContent = entry.id;
      field.append(nameInput, id);

      // Icon button: current glyph, opens the picker. `entry.icon` holds the
      // explicit choice; "" means automatic (entity icon, else domain default).
      const iconBtn = document.createElement('button');
      iconBtn.type = 'button';
      iconBtn.className = 'icon-button';
      iconBtn.title = S.chooseIconTitle;
      iconBtn.setAttribute('aria-label', S.chooseIconTitle);
      const paintIconBtn = () => {
        iconBtn.replaceChildren();
        const glyph = entryIconNode(entry, 20);
        if (glyph) iconBtn.append(glyph);
        iconBtn.classList.toggle('auto', !entry.icon);
      };
      paintIconBtn();
      iconBtn.addEventListener('click', () => {
        openIconPicker(entry, () => {
          paintIconBtn();
          if (editingPage) void persistCards();
        });
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.textContent = S.removeEntity;
      remove.addEventListener('click', () => {
        const at = page.entities.indexOf(entry);
        if (at >= 0) page.entities.splice(at, 1);
        updateCount();
        refreshSelected();
        refreshAvailable();
      });
      li.append(grip, iconBtn, field, remove);
      selectedList.append(li);
    });
  };

  attachSortable(selectedList, (container) => {
    page.entities = directSortItems(container).map((el) => el._entry);
  });

  refreshSelected();
  if (availableList) {
    search.addEventListener('input', refreshAvailable);
    refreshAvailable();
  }
}

// --- icon picker ------------------------------------------------------------

let iconPicker = null;

// Opens a modal grid of every known icon plus "Automatic". Selecting an icon
// writes `entry.icon` and refreshes the caller's button. The node is built once
// (lazily) and reused: the grid is static, only the selected highlight moves.
function ensureIconPicker() {
  if (iconPicker) return iconPicker;

  const overlay = document.createElement('div');
  overlay.className = 'icon-picker-overlay';
  overlay.hidden = true;

  const dialog = document.createElement('div');
  dialog.className = 'icon-picker';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const head = document.createElement('div');
  head.className = 'icon-picker-head';
  const heading = document.createElement('h3');
  heading.textContent = S.chooseIconTitle;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ghost small';
  closeBtn.textContent = S.backButton;
  head.append(heading, closeBtn);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = S.iconHint;

  const grid = document.createElement('div');
  grid.className = 'icon-grid';

  dialog.append(head, hint, grid);
  overlay.append(dialog);
  document.body.append(overlay);

  const close = () => {
    overlay.hidden = true;
    iconPicker.current = null;
  };
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });

  iconPicker = { overlay, grid, heading, hint, close, current: null };
  return iconPicker;
}

function openIconPicker(entry, onChange) {
  const picker = ensureIconPicker();
  picker.heading.textContent = S.chooseIconTitle;
  picker.hint.textContent = S.iconHint;
  picker.current = { entry, onChange };
  picker.grid.replaceChildren();

  const makeCell = (name, label) => {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'icon-cell';
    cell.title = label;
    cell.setAttribute('aria-label', label);
    if (name && isKnownIcon(name)) {
      const glyph = iconNode(name, 24);
      if (glyph) cell.append(glyph);
    } else {
      const auto = document.createElement('span');
      auto.className = 'icon-auto';
      auto.textContent = 'A';
      cell.append(auto);
    }
    const selected = name ? entry.icon === name : !entry.icon;
    if (selected) cell.classList.add('selected');
    cell.addEventListener('click', () => {
      entry.icon = name || '';
      picker.close();
      onChange();
    });
    return cell;
  };

  picker.grid.append(makeCell('', S.iconAuto));

  for (const name of ICON_NAMES) {
    picker.grid.append(makeCell(name, name));
  }

  picker.overlay.hidden = false;
}

function startEdit(page) {
  editingPage = page;
  editSnapshot = JSON.stringify(page);
  renderCards();
}

function cancelEdit() {
  if (editingPage && editSnapshot !== null) {
    Object.assign(editingPage, JSON.parse(editSnapshot));
  }
  editingPage = null;
  editSnapshot = null;
  renderCards();
}

async function saveEdit() {
  editingPage = null;
  editSnapshot = null;
  await persistCards();
  setStatus(S.statusSaved, 'ready');
  renderCards();
  if (isConfigured() && connected) await syncPages();
}

function addCard() {
  if (config.pages.length >= MAX_PAGES) return;
  const page = { title: '', entities: [] };
  config.pages.push(page);
  expanded.add(page);
  void persistCards();
  renderCards();
}

function deleteCard(page) {
  expanded.delete(page);
  if (editingPage === page) {
    editingPage = null;
    editSnapshot = null;
  }
  if (config.pages.length <= 1) {
    const fresh = { title: '', entities: [] };
    config.pages[0] = fresh;
    expanded.clear();
  } else {
    const at = config.pages.indexOf(page);
    if (at >= 0) config.pages.splice(at, 1);
  }
  void persistCards();
  renderCards();
}

// --- sync to glasses --------------------------------------------------------

async function syncPages(options = {}) {
  // A timed refresh keeps the warm frame cache: only the cards whose state
  // signature changed are re-rendered, so a resync after the delay costs a
  // fetch and nothing more when nothing moved.
  const refreshOnly = options.refresh === true;
  if (!isConfigured()) {
    /* The connection may be perfectly valid and still have nothing to send:
     * no dashboard picked and no local card filled. Saying "enter the URL and
     * token" there sent the wearer to the settings form for nothing. */
    setStatus(isConnectionReady() ? S.noTarget : S.statusNotConfigured, 'error');
    return;
  }
  try {
    setStatus(S.statusPushing);
    entitiesCache = await fetchStates(config.url, config.token);
    /* A sync just fetched the whole state list: the card on screen must not
     * fetch it again a moment later. */
    statesFetchedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let source = config.pages;
    if (useRemoteDashboard()) {
      /* The HASS app paints the user's own Lovelace dashboard, never the
       * memomind_glasses component: its views are fetched over HA's websocket
       * API and each top-level card becomes a picture page. */
      const pages = await loadRemoteDashboard(config.dashboardId);
      source = lovelacePagesToCards(pages);
    }
    const pages = buildPages(source, entitiesCache, {
      maxRows: MAX_ROWS,
      resolveIcon: resolveGlassesIcon,
    });
    await pushToGlasses(pages);
    pushedPages = pages;
    /* A picture page is the one that carries a card: `buildPages` sets
     * `page.card`, the wire flag is derived from it, and nothing sets
     * `page.image` any more. Filtering on `.image` emptied this list and no
     * card picture was ever pushed. */
    imagePages = pages.filter((page) => page.card);
    navPage = 0;
    navRow = 0;
    navShowState();
    if (refreshOnly) refreshCardImages();
    else requestAllCardImages();
  } catch (error) {
    setStatus(format(S.statusError, { msg: describeHaError(error) }), 'error');
  }
}

async function pushToGlasses(pages) {
  if (!connected) {
    setStatus(S.statusDisconnected, 'error');
    return;
  }
  if (pages.length === 0) {
    imagePages = [];
    pushedCards.clear();
    await gm.plugin.sendMessage(PAGES_CHANNEL, encodeClear());
    setStatus(S.statusSaved);
    return;
  }
  const payload = encodeSetPages(pages.slice(0, MAX_PAGES));
  await gm.plugin.sendMessage(PAGES_CHANNEL, payload);
  const titles = pages.slice(0, 3).map((p) => p.title).join(', ');
  setStatus(format(S.statusPushed, { n: pages.length, titles }), 'ready');
}

// --- debug navigation --------------------------------------------------------

/* Why this exists: the glasses run with head gestures disabled while we debug
 * "only entities show", so nothing on the device can change page. The phone
 * therefore shows buttons that do what a gesture used to do, and reads the
 * resulting state from the events the glasses already send.
 *
 * Page arrows republish the dashboard starting at the next card. The glasses'
 * own page list is fixed at sync time, so rotating it is the only way to land
 * on another page from the phone. Row up/down and Action act on the page the
 * glasses report, which is the one the wearer is looking at. */

function navTotalPages() {
  return Math.min(Math.max(config.pages.length, 0), MAX_PAGES);
}

/* What the arrows really work on: the glasses' own page list, as built by the
 * last sync. A dashboard sent by the Home Assistant integration is not in
 * config.pages (that only holds the local cards), so counting config.pages said
 * "1 page" and the arrows did nothing. `pushedPages` is the list actually sent,
 * text pages included, so page N here is page N on the glasses. */
function navList() {
  return pushedPages.length ? pushedPages : [];
}

function navTitleOf(entry) {
  if (!entry) return S.navUntitled;
  const title = entry.title || entry.card?.title || entry.card?.config?.name || '';
  return String(title).trim() || S.navUntitled;
}

/* The glasses land on page 0 after every set_pages, so the phone's cursor for
 * the arrows is the index into the list it last pushed. `navPage` follows the
 * page-changed events from there. */
function navShowState() {
  if (!els.navState) return;
  const list = navList();
  if (!list.length) {
    els.navState.textContent = navTotalPages() ? S.navNoSync : S.navNoPages;
    return;
  }
  /* The glasses report the page through page-changed; their index is the
   * truth. The picture list is only a fallback title: a text page may be on
   * screen while this list skips it, so never label the row from it when the
   * indexes disagree. */
  const total = Math.max(list.length, navTotalPages(), (navPage || 0) + 1);
  const at = Math.min(Math.max(navPage, 0), total - 1);
  const entry = at < list.length ? list[at] : null;
  const rows = totalNavRows(at);
  const state = format(S.navState, {
    n: at + 1, total, title: navTitleOf(entry), row: navRow + 1,
  });
  if (rows > 0) {
    els.navState.textContent = state;
    return;
  }
  /* A card picture with triggerable entities shows which one the ring sits on,
   * so the wearer knows what the glasses' button will do. */
  const focus = entry?.card ? focusList(entry.card) : [];
  if (focus.length) {
    const pos = Math.min(Math.max(cardFocus.get(at) || 0, 0), focus.length - 1);
    els.navState.textContent = `${state} · ${S.navPicture} · ${format(S.navFocus, {
      name: labelForEntity(focus[pos]), n: pos + 1, total: focus.length,
    })}`;
    return;
  }
  els.navState.textContent = `${state} · ${S.navPicture}`;
}

/* Rows the glasses hold for a page: the pushed list is the only source, and a
 * page missing from it is a picture page (the one that gets pushed). */
function totalNavRows(at) {
  if (Array.isArray(pushedPages)) {
    const page = pushedPages[at];
    if (page) return Array.isArray(page.rows) ? page.rows.length : 0;
  }
  const entry = navList()[at];
  return Array.isArray(entry?.rows) ? entry.rows.length : 0;
}

/* Nav commands are handled on the device: they call exactly the code the head
 * gestures used to, so a page turn there is the same page turn the wearer saw
 * before. Republishing the page list from here looked simpler but never moved
 * the glasses (an integration dashboard is not in config.pages at all), so the
 * arrows did nothing. */
async function sendNav(command) {
  if (!connected) { setStatus(S.statusDisconnected, 'error'); return; }
  const payload = encodeNav(command);
  try {
    await gm.plugin.sendMessage(EVENT_CHANNEL, payload);
  } catch (error) {
    setStatus(format(S.statusError, { msg: describeHaError(error) }), 'error');
  }
  navShowState();
}

async function navRotate(step) {
  if (navList().length < 2) {
    setStatus(S.navNeedsSync, 'error');
    navShowState();
    return;
  }
  await sendNav(step > 0 ? NAV_PAGE_NEXT : NAV_PAGE_PREV);
}

function navEntryRows(entry) {
  return Array.isArray(entry?.rows) ? entry.rows : [];
}

async function navUpDown(delta) {
  const list = navList();
  if (!list.length) { navShowState(); return; }
  const at = Math.min(Math.max(navPage, 0), list.length - 1);
  const entry = list[at];
  /* A card picture with triggerable entities: the arrows step the ring on the
   * phone itself. The glasses do not hold the entity list, so borrowing their
   * row cursor (the old pan path) could not name a tile; the cursor lives here
   * and the ring is painted into the frame this phone pushes. */
  if (entry?.card && focusList(entry.card).length) {
    focusCardImage(delta);
    return;
  }
  /* A card picture without actionable entities has no ring to step: it is
   * left alone, exactly like the head gesture on the glasses. */
  if (entry?.card) { navShowState(); return; }
  if (!navEntryRows(entry).length) { navShowState(); return; }
  await sendNav(delta < 0 ? NAV_FOCUS_UP : NAV_FOCUS_DOWN);
}

async function navActivate() {
  const list = navList();
  if (!list.length) { navShowState(); return; }
  const at = Math.min(Math.max(navPage, 0), list.length - 1);
  const entry = list[at];
  /* A card picture is triggered from the phone too: run the focused entity
   * straight away, no round trip through the glasses. */
  if (entry?.card && focusedEntity(entry.card)) {
    await activateFocus();
    return;
  }
  if (!navEntryRows(entry).length) return;
  await sendNav(NAV_ACTIVATE);
}

/* Steps the card cursor by `delta`, wraps at the ends so the wearer never gets
 * stuck, and repaints just the card with the ring moved. The frame is rendered
 * with the new focus and diffed against the one on the glasses, so only the two
 * tiles that changed travel. */
function focusCardImage(delta) {
  const card = currentCard();
  const list = focusList(card);
  if (!list.length) return;
  const size = list.length;
  const at = Math.min(Math.max(cardFocus.get(visiblePage) || 0, 0), size - 1);
  let next = at + delta;
  if (next < 0) next = size - 1;
  if (next >= size) next = 0;
  if (next === at) return;
  cardFocus.set(visiblePage, next);
  /* A grid shows only its first rows: stepping the ring onto a hidden entity
   * brings its row into the window, the same way a text page scrolls to the
   * cursor. Cards that fit on the panel never change the offset. */
  const rows = cardScrollRows(card);
  if (rows > 0) {
    const picture = pictureIndexAt(visiblePage);
    const row = focusTileRow(card, next);
    const start = Math.min(row, Math.max(0, row - rows + 1));
    if (start !== (cardScroll.get(picture) || 0)) cardScroll.set(picture, start);
  }
  rerenderCard();
  navShowState();
}

/* Head up/down from the glasses: step the ring of the card shown there by
 * one, wrapping at the ends. `index` is a glasses page index; a text page has
 * no ring, and a card with nothing to trigger is left alone. */
function focusHeaderCard(index, delta) {
  if (index !== visiblePage) return;
  const card = currentCard();
  /* Logged on every head step: the wearer side (glasses gesture, page index)
   * and the phone side (which card, how many triggerable entities) have to be
   * seen together to tell "no ring" from "no gesture". */
  console.info('[ha-phone] card-focus page=%d delta=%d visible=%d card=%s focus=%d',
    index, delta, visiblePage, Boolean(card), card ? focusList(card).length : 0);
  if (!card || !focusList(card).length) return;
  focusCardImage(delta);
}

/* Runs the action for the entity under the ring. Shared by the phone's Action
 * button and the glasses' primary button (which sends EVENT_CARD_ACTIVATE). */
async function activateFocus() {
  const card = currentCard();
  const entityId = focusedEntity(card);
  if (!entityId) { setStatus(S.navNoAction, 'error'); return; }
  await onAction(entityId, focusedAction(card));
}

// --- card pictures ----------------------------------------------------------

// One reusable canvas: the browser then keeps a single backing store for every
// card instead of allocating one per refresh.
function getCardCanvas() {
  if (!cardCanvas) {
    cardCanvas = document.createElement('canvas');
    cardCanvas.width = CARD_WIDTH;
    cardCanvas.height = CARD_HEIGHT;
  }
  return cardCanvas;
}

// Fetches just the states the picture needs, reusing the values already loaded
// when the whole dashboard was fetched a moment ago. `/api/states` returns the
// whole instance: one round trip per card (one per head turn, one per sync)
// is the wait the wearer feels. The cache is shared for a few seconds, so a
// burst of work — a sync followed by the first picture, a scroll — costs one
// request.
const STATES_TTL_MS = 2000;
let statesFetchedAt = 0;
let statesInFlight = null;

async function sharedStates() {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (now - statesFetchedAt < STATES_TTL_MS) return entitiesCache;
  if (statesInFlight) return statesInFlight;
  statesInFlight = (async () => {
    let states = entitiesCache;
    try {
      states = await fetchStates(config.url, config.token);
      entitiesCache = states;
      statesFetchedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    } catch {
      states = entitiesCache;
    }
    try {
      return await attachForecasts(config.url, config.token, states);
    } catch {
      return states;
    }
  })();
  try {
    return await statesInFlight;
  } finally {
    statesInFlight = null;
  }
}

async function cardStates(card, hint = null) {
  const ids = cardEntityIds(card);
  /* `states` may be handed over: a scroll renders another window of the very
   * same card, and the values it is drawn from did not change between two head
   * movements. Only a fresh request fetches them. */
  if (hint) return hint;
  if (ids.length === 0) return entitiesCache;
  return sharedStates();
}

/* Pictures the phone has already rendered, kept so a page can be put on the
 * glasses without waiting for cardStates() (a network round trip) and the
 * canvas pass again. `frame` is the GRAY_4 image itself, so only a handful of
 * cards are kept: the one on screen and the two next to it. The entry also
 * holds the offset its window was rendered at, so a scroll can reuse the
 * states it was drawn from instead of fetching them again. */
const frameCache = new Map(); // page index -> { signature, frame, offset, states }
/* Every card of the dashboard is rendered up front so turning to it is instant,
 * so the cache has to keep them all: one entry per page, never evicted while the
 * dashboard is loaded. */
const CACHE_KEEP = MAX_PAGES;

/* How long the values a card was drawn from stay good enough to paint at
 * once. Frames are rendered ahead of the wearer, so without this every head
 * turn waited on /api/states again for a card that had already been drawn. */
const FRAME_STATES_TTL_MS = 60000;

function cacheFrame(index, signature, frame, offset = 0, states = null,
                    renderedAt = 0) {
  frameCache.delete(index);
  frameCache.set(index, {
    signature,
    frame,
    offset,
    states,
    at: renderedAt || (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  });
  while (frameCache.size > CACHE_KEEP) {
    frameCache.delete(frameCache.keys().next().value);
  }
}

function cachedFrame(index, signature) {
  const entry = frameCache.get(index);
  if (!entry || entry.signature !== signature) return null;
  // Refresh the recency order so the card on screen is the last to go.
  frameCache.delete(index);
  frameCache.set(index, entry);
  return entry.frame;
}

function cardSignature(card, index, offset, states, focusId = '') {
  return JSON.stringify({
    index,
    offset,
    focus: focusId,
    card,
    states: cardEntityIds(card).map((id) => {
      const state = states.get(id);
      const days = state?.attributes?.forecast?.length ?? 0;
      return state ? `${state.state}|${days}` : '';
    }),
  });
}

function renderCardFrame(card, states, offset, focusId = '') {
  try {
    const rows = cardScrollRows(card);
    if (rows > 0) {
      return cardToGray4(card, states, getCardCanvas(), CARD_WIDTH, CARD_HEIGHT, offset, focusId);
    }
    /* A card that does not scroll by rows is panned by the head instead. */
    return cardToGray4Window(card, states, getCardCanvas(), CARD_WIDTH, CARD_HEIGHT,
      offset * PAN_STEP, focusId);
  } catch (error) {
    /* A card this renderer cannot paint must not leave a black page on the
     * glasses: fall back to the plain value, and say so in the status. */
    console.error('[ha-phone] card render failed', card, error);
    setStatus(format(S.statusError, { msg: describeHaError(error) }), 'error');
    return cardToGray4(
      { cardtype: 'sensor', config: { type: 'sensor', entity: firstCardEntity(card) } },
      states,
      getCardCanvas(),
      CARD_WIDTH,
      CARD_HEIGHT,
      0,
      focusId,
    );
  }
}

/* Repaints the card on the glasses at its current offset and focus, diffing
 * against the frame already up: moving the ring only sends the two tiles that
 * changed. Used by the arrows, which never leave the page. */
function rerenderCard() {
  const picture = pictureIndexAt(visiblePage);
  const page = imagePages[picture];
  if (!page || !page.card || picture < 0) return;
  const focusId = focusedEntity(page.card);
  const known = frameCache.get(picture);
  const offset = cardScroll.get(picture) || 0;
  cardInFlight = (cardInFlight || Promise.resolve())
    .then(() => pushCardImage(page.card, picture, false, true, offset,
      known?.states || null, focusId))
    /* A failed repaint used to vanish: the ring stayed where it was and the
     * wearer saw nothing move. Say it in the status and in the console. */
    .catch((error) => {
      console.warn('[ha-phone] card repaint failed', error);
      setStatus(format(S.statusError, { msg: describeHaError(error) }), 'error');
    });
}

/* Picture page index -> glasses page index. Everything pushed with a card is
 * an image page there (buildPages sets the flag), so this is a plain map; an
 * unknown entry falls back to the bare index. */
function pictureAt(index) {
  const page = imagePages[index];
  if (!page) return -1;
  const at = pushedPages.indexOf(page);
  return at >= 0 ? at : -1;
}

function pictureIndexAt(pageIndex) {
  return imagePages.findIndex((page) => pushedPages[pageIndex] === page);
}

function pageTitle(index) {
  const page = imagePages[index];
  const title = page?.title || page?.card?.title || page?.card?.config?.name || '';
  return String(title).trim();
}

/* The picture page `step` pages away from `index`, wrapping like the glasses
 * do. Returns -1 when there is no other picture page. */
function pageForStep(index, step) {
  const total = pushedPages.length;
  let at = pushedPages.indexOf(imagePages[index]);
  if (total < 2 || at < 0) return -1;
  for (let hop = 0; hop < total; hop += 1) {
    at = (at + step + total) % total;
    const page = pushedPages[at];
    if (page?.card) return pictureIndexAt(at);
  }
  return -1;
}

// Renders one card and pushes it to the glasses as GRAY_4 tiles. Pictures are
// drawn edge to edge: the glasses show the card full screen. Only the page on
// screen is ever pushed: the glasses hold a single picture and drop the tiles
// of any other page, so a batch for the whole dashboard (or a request that
// arrived after the wearer moved on) would bury the picture of the page they
// are looking at.
async function pushCardImage(card, index, cached = false, scroll = false,
                             offsetHint = null, statesHint = null, focusId = null) {
  /* `index` is a picture page index, `visiblePage` a glasses page index: map
   * before comparing, otherwise every picture page after the first row page
   * was refused and the card never travelled. */
  if (!connected || !card || index !== pictureIndexAt(visiblePage)) {
    console.info('[ha-phone] push skipped: connected=%s card=%s index=%d visible=%d picture=%d',
      connected, Boolean(card), index, visiblePage, pictureIndexAt(visiblePage));
    return;
  }
  const page = pictureAt(index);
  if (page < 0) {
    console.info('[ha-phone] push skipped: no glasses page for picture %d (pushed=%d images=%d)',
      index, pushedPages.length, imagePages.length);
    return;
  }
  console.info('[ha-phone] picture page=%d type=%s entities=%d requested=%d',
    page, card.cardtype || '', cardEntityIds(card).length, visiblePage);
  const offset = scroll ? (cardScroll.get(index) || 0) : 0;
  if (offsetHint !== null) cardScroll.set(index, offsetHint);
  const wanted = offsetHint !== null ? offsetHint : offset;
  /* Tell the wearer the work started: the glasses put their own loading
   * screen up, and the phone status shows the same state. A scroll reuses the
   * values of the picture on screen, so it starts drawing at once. */
  if (!scroll) setStatus(S.statusLoadingPicture, 'busy');
  /* Diff base: only the picture actually on the glasses, and only when it
   * belongs to this page. A retargeted page or a rebuilt screen has none. */
  const shown = onGlass && onGlass.index === index ? onGlass : null;
  const previous = frameCache.get(index);
  const states = statesHint || (scroll ? previous?.states || null : null)
    || await cardStates(card);
  /* `focusId === null` means "not a focus repaint": use the cursor as it stands
   * for this page so a plain reload keeps the ring where the wearer left it. */
  const focus = focusId !== null ? focusId : (pushedPages[page] && pushedPages[page].card
    ? focusedEntity(pushedPages[page].card) : '');
  const signature = cardSignature(card, index, wanted, states, focus);
  /* A picture the phone believes it sent is not on the glasses any more (a
   * sync clears it, the screen may have been rebuilt): every explicit request,
   * and every dashboard sync, pushes the pixels again. Only the automatic
   * refresh passes `cached`, so a timer tick costs nothing when nothing moved. */
  if (cached && pushedCards.get(index) === signature) return;
  // The wearer may have moved on while the states were being fetched.
  if (index !== pictureIndexAt(visiblePage)) return;
  const frame = cachedFrame(index, signature)
    || renderCardFrame(card, states, wanted, focus);
  const renderedAt = frame && cachedFrame(index, signature) === frame
    ? frameCache.get(index)?.at : undefined;
  if (!frame || !frame.length) {
    console.info('[ha-phone] push skipped: empty frame for page %d', page);
    return;
  }
  cacheFrame(index, signature, frame, wanted, states, renderedAt);
  try {
    /* A scroll only overlaps the picture on screen: the rows in common stay,
     * only the strip that moved travels. It needs the frame the glasses hold
     * *and* a different window: a request for the offset already on screen
     * (a reload, a fresh page whose card was pre-rendered) always sends the
     * whole picture, otherwise a diff against identical pixels would travel
     * as zero tiles and leave the page black. */
    if (scroll && shown?.frame && shown.offset !== wanted) {
      await presentGray4Patch(gm, frame, shown.frame,
        CARD_WIDTH, CARD_HEIGHT, page);
    } else {
      await presentGray4(gm, frame, CARD_WIDTH, CARD_HEIGHT, page);
    }
    onGlass = { index, offset: wanted, frame };
    pushedCards.set(index, signature);
    if (index === visiblePage) {
      const name = pageTitle(index);
      setStatus(name ? format(S.statusPictureReady, { name }) : S.statusConnected, 'ready');
    }
    prefetchNeighbourCards(index);
  } catch (error) {
    setStatus(format(S.statusError, { msg: describeHaError(error) }), 'error');
  }
}

/* Warms the cache for the picture pages either side of `index`: the head turn
 * is when the wearer waits, and by then the pixels (and the states they were
 * drawn from) are ready. Renders run one at a time so they never race for the
 * shared canvas. */
let prefetchQueue = [];
let prefetchChain = null;

function prefetchNeighbourCards(index) {
  if (!connected || imagePages.length < 2) return;
  prefetchQueue = [1, -1]
    .map((step) => pageForStep(index, step))
    .filter((next, at, list) => next !== -1 && next !== index && list.indexOf(next) === at);
  if (prefetchChain) return;
  prefetchChain = warmPrefetchQueue().catch(() => {}).finally(() => {
    prefetchChain = null;
  });
}

async function warmPrefetchQueue() {
  while (prefetchQueue.length > 0) {
    const index = prefetchQueue.shift();
    if (!connected || index === visiblePage) continue;
    const page = imagePages[index];
    if (!page || !page.card) continue;
    const offset = cardScroll.get(index) || 0;
    let states;
    try {
      states = await cardStates(page.card);
    } catch {
      continue;
    }
    const signature = cardSignature(page.card, index, offset, states);
    const known = frameCache.get(index);
    if (known && known.signature === signature) continue;
    cacheFrame(index, signature, renderCardFrame(page.card, states, offset),
      offset, states);
  }
}

/* The glasses tell which page they show before every picture request. Taking
 * the reported page over only when it differs keeps a request queued behind
 * another from cancelling its own card: the page on screen cannot change
 * without a new request. */
function showPage(index) {
  if (index === visiblePage) return;
  visiblePage = index;
  /* A fresh page starts its card on the first entity: a cursor carried over
   * from another card would point at a tile this one does not have. */
  if (!cardFocus.has(index)) cardFocus.set(index, 0);
  pushedCards.clear();
  /* The glasses rebuilt their screen for another page: their buffer no longer
   * holds the frame we sent, so the next picture must go out whole. */
  onGlass = null;
}

function firstCardEntity(card) {
  const ids = cardEntityIds(card);
  return ids.length ? ids[0] : '';
}

/* The card on the glasses right now, or null when it shows a text page. `at` is
 * the glasses page index (navPage / visiblePage), which is what the arrows and
 * the glasses' button report. */
function currentCard() {
  const at = pushedPages[visiblePage];
  return at && at.card ? at.card : null;
}

function focusList(card) {
  return card ? cardFocusEntities(card) : [];
}

/* Drawn row of the ring's Nth entry: a grid lays one cell per row (two per row
 * for a two-column grid), in the same order cardFocusEntities walks it. */
function focusTileRow(card, at) {
  return gridRowOf(at, gridColumnCount(card));
}

/* The entity the ring sits on for this card, or '' when the card has nothing to
 * trigger. Clamped so a dashboard edit that drops the entity cannot leave the
 * cursor past the end. */
function focusedEntity(card) {
  const list = focusList(card);
  if (!list.length) return '';
  const at = Math.min(Math.max(cardFocus.get(visiblePage) || 0, 0), list.length - 1);
  return list[at];
}

/* The tile's own tap_action for the entity the ring sits on, or null to let
 * the domain default run. Kept aligned with focusedEntity by using the same
 * clamped index into the parallel list. */
function focusedAction(card) {
  const actions = cardFocusActions(card || {});
  if (!actions.length) return null;
  const at = Math.min(Math.max(cardFocus.get(visiblePage) || 0, 0), actions.length - 1);
  return actions[at] || null;
}

// Runs one picture push at a time: a nod right after the pages arrive must not
// interleave its tiles with the sync's own push. `cached` stays off for a
// request coming from the glasses: the glasses only ask when their screen has
// no picture, so a signature that says "already sent" would leave them blank.
function requestCardImage(index, cached = false, offset = null) {
  /* `index` may come from either space: the glasses send glasses page indexes,
   * the local calls below pass picture page indexes. */
  const at = pushedPages[index]?.card ? index : pictureAt(index);
  const picture = pushedPages[index]?.card ? pictureIndexAt(index) : index;
  showPage(at);
  const page = imagePages[picture];
  if (!page || !page.card) {
    console.info('[ha-phone] request ignored: no picture page %d (images=%d pushed=%d)',
      picture, imagePages.length, pushedPages.length);
    return;
  }
  if (picture !== pictureIndexAt(visiblePage)) {
    console.info('[ha-phone] request ignored: picture %d not on glasses (visible=%d)',
      picture, visiblePage);
    return;
  }
  /* Protocol 2.1: the glasses name the first row of the window they want. A
   * plain request (no offset byte) keeps the row already held for this page. */
  const wanted = offset !== null ? offset : (cardScroll.get(picture) || 0);
  const known = frameCache.get(picture);
  if (offset !== null && offset === (cardScroll.get(picture) || 0) &&
      known && known.offset === offset) {
    cardInFlight = (cardInFlight || Promise.resolve())
      .then(() => pushCardImage(page.card, picture, cached, true, offset,
        known.states))
      .catch(() => {});
    return;
  }
  /* The picture for a request carries every row of the card, in tiles. An
   * instant paint from a cached frame would put the card up first and then be
   * overwritten by this push, i.e. the card would vanish until the tiles land.
   * One path, one picture: the fresh frame is cached and pushed while the
   * values are re-fetched after it. */
  cardInFlight = (cardInFlight || Promise.resolve())
    .then(() => pushCardImage(page.card, picture, cached, offset !== null, offset))
    .catch(() => {});
}

// Head up/down on a card picture: renders the next window and sends only the
// rows that changed. The offset stays free to move over the whole picture: a
// card whose renderer ignores it simply produces the same frame, and
// presentGray4Patch then finds nothing to send.
function scrollCardImage(index, delta) {
  const picture = pictureIndexAt(index);
  const page = imagePages[picture];
  if (!page || !page.card || index !== visiblePage) return;
  const max = cardScrollRows(page.card) || MAX_PAN_STEPS;
  const next = Math.max(0, (cardScroll.get(picture) || 0) + delta);
  if (next > max) return;
  if (next === (cardScroll.get(picture) || 0)) return;
  cardScroll.set(picture, next);
  const known = frameCache.get(picture);
  cardInFlight = (cardInFlight || Promise.resolve())
    .then(() => pushCardImage(page.card, picture, false, true, next,
      known?.states || null))
    .catch(() => {});
}

// A synced dashboard lands on page 0 with an empty screen: that picture is
// pushed at once, and every other card of the dashboard is rendered into the
// frame cache in the background so turning to it needs no render at all.
function requestAllCardImages() {
  pushedCards.clear();
  frameCache.clear();
  onGlass = null;
  cardScroll.clear();
  prefetchQueue = [];
  visiblePage = 0;
  /* Render page 0 before pulling its tiles: the transfer then starts with the
   * pixels already in hand instead of after the render. */
  precacheAllCards();
  const first = pictureIndexAt(visiblePage);
  cardInFlight = (cardInFlight || Promise.resolve())
    .then(() => pushCardImage(imagePages[first]?.card, first, true))
    .catch(() => {});
}

// Renders every picture page of the dashboard into an offscreen frame, one at a
// time so the shared canvas is never raced. Cards already cached with the same
// signature are skipped. Runs behind the push of the page on screen.
let precacheChain = null;

function precacheAllCards() {
  if (!connected || imagePages.length === 0) return;
  if (precacheChain) return;
  precacheChain = warmAllCards().catch(() => {}).finally(() => {
    precacheChain = null;
  });
}

// The card on screen changed values: render its new frame and push it, one
// push at a time like every other picture. Never while the sync's own push is
// in flight, so a timer tick cannot paint black over a card arriving.
function refreshVisibleCard() {
  if (!connected) return;
  const picture = pictureIndexAt(visiblePage);
  const page = imagePages[picture];
  if (!page || !page.card) return;
  cardInFlight = (cardInFlight || Promise.resolve())
    .then(() => pushCardImage(page.card, picture, true))
    .catch(() => {});
}

// A resync after the delay: the dashboard structure is the same, so the cache
// is kept and only the cards whose data moved are re-rendered. Nothing is
// pushed from here: the card on screen is refreshed by `refreshVisibleCard`
// once its new frame is ready, and every other card only updates its cache.
function refreshCardImages() {
  precacheAllCards();
  refreshVisibleCard();
}

async function warmAllCards() {
  const total = imagePages.length;
  if (!total) return;
  /* Page on screen first, then the two neighbours (the next head turn is what
   * the wearer waits for), then the rest of the dashboard. */
  const first = pictureIndexAt(visiblePage);
  const order = [first, 1, -1]
    .map((step) => (step === first ? step : pageForStep(first, step)))
    .filter((at, pos, list) => at >= 0 && list.indexOf(at) === pos);
  for (let at = 0; at < total; at += 1) {
    if (!order.includes(at)) order.push(at);
  }
  for (const index of order) {
    if (!connected) return;
    const page = imagePages[index];
    if (!page || !page.card) continue;
    const offset = cardScroll.get(index) || 0;
    let states;
    try {
      states = await cardStates(page.card);
    } catch {
      continue;
    }
    if (!connected) return;
    const signature = cardSignature(page.card, index, offset, states);
    const known = frameCache.get(index);
    if (known && known.signature === signature) continue;
    cacheFrame(index, signature, renderCardFrame(page.card, states, offset),
      offset, states);
  }
}

// --- events -----------------------------------------------------------------

async function onTest() {
  await persistConfig();
  if (!isConnectionReady()) {
    setStatus(S.statusNotConfigured, 'error');
    return;
  }
  try {
    setStatus(S.statusTesting);
    await testConnection(config.url, config.token);
    setStatus(S.statusOk, 'ready');
  } catch (error) {
    setStatus(format(S.statusError, { msg: describeHaError(error) }), 'error');
  }
}

async function onSaveSettings() {
  await persistConfig();
  setStatus(S.statusSaved, 'ready');
  scheduleAutoRefresh();
  if (isConfigured() && connected) await syncPages();
}

async function onLoadEntities() {
  await persistConfig();
  if (!isConnectionReady()) {
    setStatus(S.noConnection, 'error');
    return;
  }
  try {
    setStatus(S.statusLoadingEntities);
    allEntities = await fetchAllEntities(config.url, config.token);
    entitiesCache = new Map();
    setStatus(format(S.statusEntitiesLoaded, { n: allEntities.length }), 'ready');
    // Re-render so an open editor picks up the freshly loaded entities.
    renderCards();
  } catch (error) {
    setStatus(format(S.statusError, { msg: describeHaError(error) }), 'error');
  }
}

function scheduleAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  const ms = normalizeMinutes(config.autoRefreshMinutes) * 60000;
  if (connected && isConfigured()) {
    autoRefreshTimer = setInterval(() => void syncPages({ refresh: true }), ms);
  }
}

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  void onSaveSettings();
});

els.settingsButton.addEventListener('click', showSettings);
els.backButton.addEventListener('click', showMain);
els.testButton.addEventListener('click', () => void onTest());
els.loadButton.addEventListener('click', () => void onLoadEntities());
els.syncButton.addEventListener('click', () => void syncPages());
els.refreshDashboardsButton.addEventListener('click', () => void refreshDashboards());
els.addCardButton.addEventListener('click', addCard);
if (els.navPrev) els.navPrev.addEventListener('click', () => void navRotate(-1));
if (els.navNext) els.navNext.addEventListener('click', () => void navRotate(1));
if (els.navUp) els.navUp.addEventListener('click', () => void navUpDown(-1));
if (els.navDown) els.navDown.addEventListener('click', () => void navUpDown(1));
if (els.navActivate) els.navActivate.addEventListener('click', () => void navActivate());

// Reordering the cards rewrites config.pages from the new DOM order.
attachSortable(els.cardsList, (container) => {
  config.pages = directSortItems(container).map((el) => el._page);
  void persistCards();
});

const offMessages = gm.plugin.onMessage((message) => {
  if (message.channel !== EVENT_CHANNEL) return;
  const event = decodeEvent(message.data);
  if (!event) return;
  if (event.type === 'action') void onAction(event.action);
  if (event.type === 'page-changed') {
    showPage(event.index);
    if (event.index !== HINT_PAGE) {
      /* Row-up/down must not reset the cursor: the glasses echo their page on
       * every nav command, so a reset here would undo the step just taken. */
      if (event.index !== navPage) navRow = 0;
      navPage = event.index;
    }
    navShowState();
  }
  if (event.type === 'request-card') requestCardImage(event.index, false, event.offset ?? null);
  if (event.type === 'scroll-card') scrollCardImage(event.index, event.delta);
  /* The glasses' primary button on a card picture: trigger the entity the phone
   * focuses. The glasses cannot name it, the cursor lives here. */
  if (event.type === 'card-activate') void activateFocus();
  /* A head up/down on a card picture steps the entity ring: the cursor lives
   * here, so the phone moves it and repaints just that card. The glasses name
   * the page they are on so a stale message cannot move another card. */
  if (event.type === 'card-focus') focusHeaderCard(event.index, event.delta);
  if (event.type === 'gesture-debug') showGestureDebug(event.gesture, event.active);
});

// Runs the action of the row selected on the glasses: calls the matching Home
// Assistant service, then refreshes the dashboard values so the change shows up.
async function onAction(entityId, action = null) {
  if (!isConnectionReady()) {
    setStatus(S.statusNotConfigured, 'error');
    return;
  }
  try {
    setStatus(format(S.statusActionSent, { name: labelForEntity(entityId) }));
    const before = entitiesCache.get(entityId)?.state;
    const result = await callAction(config.url, config.token, entityId, { action });
    /* Three cases, measured on the live instance (2 993 entities):
     *  - the answer lists the changed state (HA >= 2023.8, most integrations,
     *    measured 190 ms for a TRADFRI light): the new value is already here,
     *    zero extra request;
     *  - the answer is an empty list because the device lands a few ms after
     *    the service returned (measured: the Zigbee switches here flip 15-30 ms
     *    after the POST): one single-entity read, ~25 ms median on this
     *    instance, against ~113 ms for the whole 1,4 Mo state list;
     *  - the entity still reads its old value after that (a scene or a script
     *    that never changes its own state, a slow device): the full sync below,
     *    which is also what refreshes every other card.
     * One attempt, never a poll loop: the wearer must get the card back. */
    const answer = result?.entity;
    const fresh = answer && answer.state !== before
      ? answer
      : await fetchEntityState(config.url, config.token, entityId).catch(() => null);
    /* Every changed state goes into the cache, not just the target: a dashboard
     * often shows a group or a companion entity that moved with it. */
    for (const state of result?.changed || []) {
      if (state.entity_id !== entityId) entitiesCache.set(state.entity_id, state);
    }
    const moved = fresh && fresh.state !== before;
    if (moved) {
      entitiesCache.set(entityId, fresh);
      // The values just replaced in the cache are newer than the card frames
      // drawn from them: say so, or sharedStates() and the frame cache keep
      // repainting the old picture.
      statesFetchedAt = 0;
      if (currentCard() && focusList(currentCard()).includes(entityId)) {
        refreshActedCard(entityId);
        return;
      }
    }
    // Nothing visible moved yet, or the entity is not on the card on screen
    // (a row page action, a group member): refresh everything, keeping the
    // warm frames so only the cards whose values moved are re-rendered.
    await syncPages({ refresh: true });
  } catch (error) {
    setStatus(format(S.statusActionFailed, { msg: error.message || String(error) }), 'error');
  }
}

/* Repaints the card the action was run from, keeping the focus ring on the
 * entity that was just triggered: the frame is re-rendered from the refreshed
 * states and diffed against the one on the glasses, so only the tiles whose
 * pixels moved travel. The caller checks the entity is on this card; a row
 * page (no picture) cannot be repainted this way and takes the full sync. */
function refreshActedCard(entityId) {
  const page = pushedPages[visiblePage];
  if (!page || !page.card) return;
  const list = focusList(page.card);
  const at = list.indexOf(entityId);
  if (at >= 0) cardFocus.set(visiblePage, at);
  const picture = pictureIndexAt(visiblePage);
  const known = frameCache.get(picture);
  /* rerenderCard() would hand the frame cache's old states back to the
   * renderer, and the signature built from them is unchanged: nothing would be
   * repainted. Throwing the stale frame away makes the next push draw from
   * `entitiesCache`, which now holds the value HA just published. */
  if (known) frameCache.delete(picture);
  rerenderCard();
  navShowState();
  /* The other cards drawn from the same values (a dashboard can show one
   * entity twice) are stale now: rebuild their frames in the background. */
  precacheAllCards();
}

async function start() {
  try {
    await gm.ready();
    await loadConfig();
    applyStrings();
    renderCards();
    renderDashboards();
    showMain();
    navShowState();
    const info = await gm.device.getInfo();
    connected = Boolean(info.connected);
    setStatus(connected ? S.statusConnected : S.statusDisconnected, connected ? 'ready' : 'error');
    /* A fresh install: the URL and token are valid but no dashboard is picked
     * and no local card exists, so the glasses stay blank. Say what is
     * missing instead of leaving "connected" on screen. */
    if (!isConfigured() && isConnectionReady()) setStatus(S.noTarget, 'error');
    scheduleAutoRefresh();
    await gm.device.subscribeEvents(['connection', 'imuGesture']);
    /* Listing the dashboards needs the phone's websocket, and that is also
     * what tells the user whether Home Assistant can be read at all: without
     * it the settings page stayed empty with no explanation. */
    if (isConnectionReady()) void refreshDashboards({ quiet: true });
    if (storageGetFailed) {
      console.warn('[hass2] réglages non relus depuis le stockage : URL et jeton par défaut');
    }
    // A dashboard selected on the phone shows up as soon as the glasses are
    // there, without waiting for a manual sync or the auto-refresh timer.
    if (connected && isConfigured()) void syncPages();
    gm.device.onConnection((event) => {
      connected = Boolean(event.connected);
      setStatus(connected ? S.statusConnected : S.statusDisconnected, connected ? 'ready' : 'error');
      if (connected && isConfigured()) void syncPages();
      scheduleAutoRefresh();
    });
  } catch (error) {
    setStatus(error.message || String(error), 'error');
  }
}

/* Head up/down in the Studio preview: the model mirrors what the glasses
 * firmware does — rows move on a text page, a card picture steps the entity
 * ring. It must not pan the picture: on the device up/down never scrolls. */
const offHeadGesture = gm.device.onGesture((event) => {
  if (!event || !event.active) return;
  if (event.gesture !== 'headRaise' && event.gesture !== 'headLower') return;
  const page = imagePages[visiblePage];
  if (!page) return;
  const delta = event.gesture === 'headRaise' ? -1 : 1;
  if (page.card) focusHeaderCard(visiblePage, delta);
});

window.addEventListener('pagehide', () => {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  offHeadGesture();
  offMessages();
  gm.close();
});

void start();
