#include "gm_plugin_lvgl_api.h"
#include "gm_plugin_libc.h"
#include "hass_icons.h"

/* Paired with the "hass" phone app. The phone connects to a Home Assistant
 * instance over its websocket API, reads the Lovelace dashboards defined inside
 * Home Assistant, renders every Lovelace card to a GRAY_4 picture and pushes
 * one page per card (title, rows, picture) to this plugin. The wearer drives it
 * hands-free: turning the head left or right flips between pages, while raising
 * or lowering the head scrolls a card that is taller than the screen. Pressing
 * the primary button runs the action of the selected row: the glasses send the
 * row's action back to the phone, which calls the matching Home Assistant
 * service (toggle a light, a switch, run a scene...). The glasses never talk to
 * Home Assistant directly: all network and dashboard work stays on the phone.
 */

#define PAGES_CHANNEL UINT16_C(0x4A50)  /* 'JP': phone -> glasses */
/* Card pictures: the phone sends raw GRAY_4 tiles on this plugin channel and
 * the plugin assembles them into one LVGL indexed image. The public
 * display.updateImage path shares the framebuffer with LVGL, and any LVGL
 * redraw repaints over those pixels, so a picture sent that way never survives
 * on a plugin page. Payload: page:u16 x:u16 y:u16 width:u16 height:u16
 * stride:u16 then stride*height bytes, all big-endian. */
#define IMAGE_CHANNEL UINT16_C(0x4A52)  /* 'JR': phone -> glasses, raw tiles */
/* The same tiles, compressed, sent on this channel instead. Payload:
 * page:u16 x:u16 y:u16 width:u16 height:u16 stride:u16 decoded:u32 then one
 * raw LZ4 block (max 12 compressed bytes per source byte, the LZ4 bound). A
 * GRAY_4 card is mostly long runs of one nibble, so a block is several times
 * smaller than the pixels and a whole card fits in two or three messages
 * instead of six: the link carries it faster and the glass display task has
 * far fewer messages to consume. The phone falls back to raw tiles when a
 * block would not be smaller. */
#define IMAGE_LZ4_CHANNEL UINT16_C(0x4A54)  /* 'JT': phone -> glasses, LZ4 tiles */
/* The raw tile the LZ4 path rebuilds is handed to draw_tile straight from
 * lz4_input: the 12-byte header sits at the front and the decoded pixels are
 * written right behind it, so one buffer holds a complete raw tile with no
 * copy and no second spare. The phone cuts a 600 x 350 card into two
 * full-width tiles of 52 500 pixel bytes each, so the scratch must hold one of
 * those plus the header; the static RAM budget (100 KiB) has room for 64 KiB
 * once the page table is packed. */
#define LZ4_MAX_TILE ((uint32_t)64U * 1024U)
static uint8_t lz4_input[LZ4_MAX_TILE];
#define COMMAND_NOTIFY_CARD 3U
#define EVENT_CHANNEL UINT16_C(0x4A51)  /* 'JQ': glasses -> phone */
#define PROTOCOL_VERSION 2U

#define COMMAND_SET_PAGES 1U
#define COMMAND_CLEAR 2U

#define EVENT_PAGE_CHANGED UINT8_C(1)
#define EVENT_ACTION UINT8_C(2)
#define EVENT_REQUEST_CARD UINT8_C(3)
/* Retired in 1.0.13: head up/down no longer pans a card picture, it steps the
 * entity ring (EVENT_CARD_FOCUS). The id stays reserved so the phone can still
 * decode an event from an older build. */
#define EVENT_SCROLL UINT8_C(4)
/* Phone -> glasses: one command byte, answered with a page-changed event so the
 * phone's navigation panel can show where the wearer is. */
#define EVENT_NAV UINT8_C(5)
#define NAV_PAGE_PREV UINT8_C(1)
#define NAV_PAGE_NEXT UINT8_C(2)
#define NAV_ROW_UP UINT8_C(3)
#define NAV_ROW_DOWN UINT8_C(4)
#define NAV_ACTIVATE UINT8_C(5)
/* Phone -> glasses, added in 1.0.13: the phone's up/down arrows must do what
 * the head does. ROW_UP/ROW_DOWN pan a picture, so reusing them made the card
 * scroll instead of moving the entity ring. */
#define NAV_FOCUS_UP UINT8_C(6)
#define NAV_FOCUS_DOWN UINT8_C(7)
/* The wearer pressed the button on a card picture: ask the phone to fire the
 * action of the entity the phone has focused on that card. The phone owns the
 * entity list and the token, so the glasses only say "activate". */
#define EVENT_CARD_ACTIVATE UINT8_C(6)
/* Head up/down on a card picture: one step through the entities of the card,
 * as a signed delta. The entity list lives on the phone, so the glasses only
 * say which way the head moved. [version, EVENT_CARD_FOCUS, page, delta].
 *
 * Never reuse a navigation command id here: the phone sends EVENT_NAV on this
 * same channel and the handler below reads the last byte as a nav command.
 * While this was 7 (= NAV_FOCUS_DOWN) every head-up step looked like a "ring
 * down" command echoing back, and a 1.0.12 phone decoded it as an older build
 * event and ignored it: up/down did nothing at all. */
#define EVENT_CARD_FOCUS UINT8_C(8)
/* Diagnostic (1.0.16): the raw IMU gesture id the Host delivered, sent on every
 * activation BEFORE any cooldown or routing. The wearer cannot read the glasses
 * log, so the phone shows this id: it tells apart a head up/down that the Host
 * misclassified as LEFT/RIGHT (id 7/8) from one routed correctly (id 2/3), and
 * its mere absence proves an older plugin build is still running.
 * [version, EVENT_DEBUG_GESTURE, gesture, active, page]. */
#define EVENT_DEBUG_GESTURE UINT8_C(9)

/* A dashboard of two dozen pages is far more than the phone ever lists; the
 * page table is static, so every slot here is RAM spent before anything
 * renders. */
#define MAX_PAGES 16U
/* Rows buffered per page. The visible window is smaller; the rest is reachable
 * by scrolling with head up/down. The page table is static (24 pages), so this
 * also sets the static RAM bill: 24 rows still leave six screens of text per
 * page while the LZ4 tile scratch keeps its room. */
#define MAX_ROWS_PER_PAGE 24U
/* Upper bound on rows drawn at once; the actual count (hass.visible_rows) is
 * derived from the panel height at start and never exceeds this. */
#define MAX_VISIBLE_ROWS 8U
/* Per row: label <= 32 bytes, value <= 24 bytes, action <= 48 bytes (the entity
 * id echoed back to the phone when the row is activated). Per page title <= 32
 * bytes. */
#define MAX_LABEL_BYTES 32U
#define MAX_VALUE_BYTES 24U
#define MAX_TITLE_BYTES 32U
#define MAX_ACTION_BYTES 24U
/* No icon: the row is drawn without a glyph. Any other value is an index into
 * hass_icons[] (the phone sends the same order, see the hass app icons.js). */
#define NO_ICON 0xFFU
/* Number of glyphs in the icon table (must match the phone's ICON_NAMES,
 * see the hass app icons.js). */
#define HASS_ICON_COUNT 40U
/* Glyph used when a row has no usable icon id (text-box). */
#define HASS_ICON_FALLBACK (HASS_ICON_COUNT - 1U)
/* Width of the icon column, including the gap that separates the 16 px bitmap
 * from the entity name. */
#define ICON_CELL 34

/* version(1) + command(1) + page_count(2) */
#define MIN_SET_PAGES_PAYLOAD 4U

#define SCREEN_MARGIN 16
/* The value column is right-aligned; keep it clear of the right edge with a
 * slightly wider margin than the left so the reading never hugs the border. */
#define RIGHT_MARGIN 30
#define HEADER_HEIGHT 44
#define HINT_HEIGHT 28
#define ROW_MIN_HEIGHT 26

typedef struct {
    char label[MAX_LABEL_BYTES + 1U];
    char value[MAX_VALUE_BYTES + 1U];
    /* The action is only echoed back to the phone when the row is activated,
     * so it is stored as an entity id, not a payload; both sides cap it here
     * because the page table is static. */
    char action[MAX_ACTION_BYTES + 1U];
    uint8_t icon; /* index into hass_icons[], or NO_ICON */
} hass_row_t;

typedef struct {
    char title[MAX_TITLE_BYTES + 1U];
    hass_row_t rows[MAX_ROWS_PER_PAGE];
    uint8_t row_count;
    /* A card the phone cannot express as rows (gauge, markdown, thermostat...):
     * the page owns the screen and shows either its picture or a hint, and a
     * head nod asks the phone to (re)send that picture. */
    bool image;
} hass_page_t;

typedef struct {
    const gm_plugin_host_api_t *host;
    const gm_plugin_lvgl_api_t *ui;
    const gm_plugin_libc_extension_api_t *libc;
    gm_plugin_lvgl_obj_t *screen;
    gm_plugin_lvgl_obj_t *row_bg[MAX_VISIBLE_ROWS]; /* selection highlight */
    gm_plugin_lvgl_obj_t *row_icon[MAX_VISIBLE_ROWS]; /* bitmap icon left of the text */
    gm_plugin_lvgl_obj_t *row_label[MAX_VISIBLE_ROWS];
    gm_plugin_lvgl_obj_t *row_value[MAX_VISIBLE_ROWS];
    gm_plugin_lvgl_obj_t *hint_label;
    uint16_t page_count;
    uint16_t page_index;
    uint16_t scroll_offset; /* first visible row of the current page */
    uint16_t selected;      /* selected row index within the page */
    uint8_t visible_rows;   /* rows that fit on screen */
    int32_t row_height;
    int32_t icon_x;         /* left edge of the bitmap icon column */
    int32_t label_width;    /* label column width (left-aligned) */
    bool images_ok;         /* host can create/update bitmap images */
    int32_t label_x;        /* left edge of the label text */
    int32_t value_width;    /* value column width (right-aligned) */
    uint8_t language; /* 0=fr 1=en 2=es 3=it 4=de 5=zh-CN */
    uint32_t display_width;
    uint32_t display_height;
    /* A card picture fills the whole screen: the wearer asked for no title
     * band, so the picture covers the header row too. These stay at zero. */
    gm_plugin_lvgl_obj_t *band_panel;
    gm_plugin_lvgl_obj_t *band_label;
    bool connected; /* phone link state, mirrored from connection events */
    uint16_t image_page; /* page whose card picture is on screen, or NO_PAGE */
    /* Card picture, drawn as one LVGL indexed 4-bit image. Its pixels come
     * from the phone in GRAY_4 tiles and are copied here, so LVGL owns the
     * screen and no later redraw can repaint over it. */
    gm_plugin_lvgl_obj_t *picture;
    uint8_t *picture_alloc;  /* raw Host block, holds both offsets */
    uint8_t *picture_pixels; /* payload: palette then indexes, 4-aligned */
    uint8_t picture_slot;    /* 0 or 1: alternates every allocation */
    gm_plugin_lvgl_image_dsc_t picture_dsc;
    uint16_t picture_width;
    uint16_t picture_height;
    /* Rows copied so far, counted per received tile: it must not depend on the
     * tile coordinates, which may be in a different space than the buffer. */
    uint16_t picture_y;
    /* Source rows still expected for the picture being received. */
    uint16_t rows_pending;
    /* Page whose rows are being collected right now (NO_PAGE when idle): a
     * picture is only committed as pixels, never as a blank screen, so its
     * tiles may arrive while the wearer already moved to another page. */
    uint16_t tile_page;
    /* Page whose pixels the buffer holds right now (NO_PAGE when empty). A
     * picture can be assembled while the wearer is on another page, so this is
     * not the page on screen: that one is image_page. */
    uint16_t picture_page;
    /* Tiles copied into the buffer being assembled, for the diagnostic log. */
    uint16_t tiles_seen;
    /* The screen on display is the opaque placeholder of an image page. It has
     * to be rebuilt before a row page can show its rows again. */
    bool waiting_view;
    uint16_t waiting_page; /* image page whose placeholder is up, or NO_PAGE */
    /* Page title of the picture on screen, drawn in the band above it. */
    char picture_title[MAX_TITLE_BYTES + 1U];
    /* First card row the picture shows. The card's empty top margin is never
     * painted (it stays transparent), so its content is moved up to the panel
     * edge by the same amount: no dead band, nothing drawn twice. */
    uint16_t picture_offset;
    /* True while pixels are still landing for picture_page: the widget is then
     * bound through image_set_source() at the card size even though the bottom
     * half of the buffer is still empty. */
    bool picture_live;
    /* Time of the last accepted page change (head left/right). A lateral tilt
     * can settle through a couple of opposite readings, so page changes get a
     * longer guard than the generic cooldown: landing on a card must not be
     * followed by an automatic hop to the next one. */
    uint32_t last_page_gesture_ms;
} hass_t;

#define NO_PAGE 0xFFFFU
#define NO_OFFSET 0xFFFFFFFFU

/* The page payloads live in their own array (not inside hass_t): keeping the
 * hot scalar state in a small struct lets the compiler address it with compact
 * offsets, and keeps every cross-segment address materialization inside the
 * plugin's XIP image. */
static hass_page_t hass_pages[MAX_PAGES];

/* Picks the string for the detected UI locale. */
#define L(fr_str, en_str, es_str, it_str, de_str, zh_str) \
    (hass.language == 1U ? (en_str) : hass.language == 2U ? (es_str) : \
     hass.language == 3U ? (it_str) : hass.language == 4U ? (de_str) : \
     hass.language == 5U ? (zh_str) : (fr_str))

static hass_t hass;

static uint8_t ha_detect_language(const char *locale)
{
    if (locale[0] == 'e' && locale[1] == 'n') return 1U;
    if (locale[0] == 'e' && locale[1] == 's') return 2U;
    if (locale[0] == 'i' && locale[1] == 't') return 3U;
    if (locale[0] == 'd' && locale[1] == 'e') return 4U;
    if (locale[0] == 'z' && locale[1] == 'h') return 5U;
    return 0U;
}

#define number gm_plugin_lvgl_style_number
#define color gm_plugin_lvgl_style_color

static void set_style(gm_plugin_lvgl_obj_t *object,
                       gm_plugin_lvgl_style_prop_t property,
                       gm_plugin_lvgl_style_value_t value)
{
    hass.ui->style_set(object, property, value, GM_PLUGIN_LVGL_SELECTOR_MAIN);
}

static void style_panel(gm_plugin_lvgl_obj_t *object, uint8_t fill,
                         uint8_t border, uint8_t radius)
{
    set_style(object, GM_PLUGIN_LVGL_STYLE_BG_COLOR, color(fill));
    set_style(object, GM_PLUGIN_LVGL_STYLE_BG_OPA, number(255));
    set_style(object, GM_PLUGIN_LVGL_STYLE_BORDER_COLOR, color(0xA0));
    set_style(object, GM_PLUGIN_LVGL_STYLE_BORDER_OPA, number(255));
    set_style(object, GM_PLUGIN_LVGL_STYLE_BORDER_WIDTH, number(border));
    set_style(object, GM_PLUGIN_LVGL_STYLE_RADIUS, number(radius));
    hass.ui->obj_clear_flag(object, GM_PLUGIN_LVGL_FLAG_SCROLLABLE);
}

static gm_plugin_lvgl_obj_t *make_label(gm_plugin_lvgl_obj_t *parent,
                                         const char *text, uint8_t shade,
                                         bool align_left)
{
    gm_plugin_lvgl_obj_t *label = hass.ui->label_create(parent);
    if (label == 0) return 0;
    hass.ui->label_set_text(label, text);
    hass.ui->label_set_long_mode(label, GM_PLUGIN_LVGL_LABEL_DOT);
    set_style(label, GM_PLUGIN_LVGL_STYLE_TEXT_COLOR, color(shade));
    set_style(label, GM_PLUGIN_LVGL_STYLE_TEXT_ALIGN,
              number(align_left ? GM_PLUGIN_LVGL_TEXT_ALIGN_LEFT
                                : GM_PLUGIN_LVGL_TEXT_ALIGN_RIGHT));
    return label;
}

/* Keeps the bitmap icon of one row in sync with its wire icon id. The image
 * sits in the dedicated icon column, left of the text. It is only drawn when
 * the host can create/update bitmap images. */
static void show_row_icon(uint32_t slot, uint8_t icon)
{
    const gm_plugin_lvgl_image_dsc_t *dsc;

    if (slot >= MAX_VISIBLE_ROWS || hass.row_icon[slot] == 0) return;
    if (icon == NO_ICON) icon = HASS_ICON_FALLBACK;
    if (icon >= HASS_ICON_COUNT) icon = HASS_ICON_FALLBACK;
    dsc = &hass_icons_dsc[icon];
    (void)hass.ui->image_set_source(hass.row_icon[slot], dsc);
    if (!hass.images_ok) {
        set_style(hass.row_icon[slot], GM_PLUGIN_LVGL_STYLE_IMG_OPA, number(0));
        return;
    }
    set_style(hass.row_icon[slot], GM_PLUGIN_LVGL_STYLE_IMG_OPA, number(255));
    hass.ui->obj_set_size(hass.row_icon[slot], (int32_t)dsc->width,
                         (int32_t)dsc->height);
}

static void hide_row_icon(uint32_t slot)
{
    if (slot >= MAX_VISIBLE_ROWS || hass.row_icon[slot] == 0) return;
    set_style(hass.row_icon[slot], GM_PLUGIN_LVGL_STYLE_IMG_OPA, number(0));
}

static void refresh_page(void);
static gm_plugin_result_t build_ui(void);
static void set_screen_visible(bool visible);
static void run_action(void);
static bool change_page(int32_t delta);
static void request_card_image(void);
static void move_selection(int32_t delta);
static gm_plugin_result_t build_waiting_page(const char *message);
static void publish_picture(void);
static void send_page_changed(void);

/* Head gestures settle for this long after the last accepted one. The wearer
 * tilts their head, then brings it back to rest; the return can fire a second
 * gesture. It is NOT applied as a blanket gate before routing any more (that
 * swallowed deliberate steps of another kind); each case guards itself. */

/* A lateral tilt that changes page can bounce: the head settles through the
 * neutral position and the sensor reads the opposite direction for a moment.
 * Page changes therefore use their own window, so arriving on a card never
 * rolls into the next one by itself. 1.0.24 raised it to 2600 ms but armed it
 * on rejected gestures too, which locked every turn out under continuous head
 * motion. 1.0.25 arms it only on an accepted turn, so 1800 ms is enough to
 * swallow the settle re-trigger while a deliberate turn is never starved. */
#define PAGE_GESTURE_COOLDOWN_MS 1800U

/* Tells the phone which page the wearer is on. Sent on every page change and
 * before every picture request, so the phone's idea of the visible page cannot
 * lag behind the screen. */
static void send_page_changed(void)
{
    uint8_t payload[3];
    payload[0] = PROTOCOL_VERSION;
    payload[1] = EVENT_PAGE_CHANGED;
    payload[2] = (uint8_t)(hass.page_index & 0xFFU);
    (void)hass.host->bt_send(EVENT_CHANNEL, payload, sizeof(payload));
}

static void request_card_image(void)
{
    uint8_t payload[3];
    if (hass.page_count == 0U || !hass_pages[hass.page_index].image) return;
    /* No connection guard here: the plugin's own connection flag is fed by a
     * link event the Host does not always deliver, and a request that goes
     * nowhere is cheaper than a card that never loads. */
    payload[0] = PROTOCOL_VERSION;
    payload[1] = EVENT_REQUEST_CARD;
    payload[2] = (uint8_t)(hass.page_index & 0xFFU);
    /* The page on screen is always the first one the phone must serve: it is
     * sent ahead of the request so a phone that filters pictures by the page it
     * believes is visible can never drop the card of the page being looked at. */
    send_page_changed();
    hass.host->log("hass: request_card page=%u", (unsigned int)hass.page_index);
    (void)hass.host->bt_send(EVENT_CHANNEL, payload, sizeof(payload));
}

/* Asks the phone to slide the entity ring of the card picture on screen by one
 * step. The ring cannot be drawn here: the phone owns the entity list, so it
 * repaints the card with the ring moved and sends back only the tiles that
 * changed. The page is named for the same reason as request_card_activate. */
static void request_card_focus(int8_t delta)
{
    uint8_t payload[4];

    if (hass.page_count == 0U || !hass_pages[hass.page_index].image) return;
    payload[0] = PROTOCOL_VERSION;
    payload[1] = EVENT_CARD_FOCUS;
    payload[2] = (uint8_t)(hass.page_index & 0xFFU);
    payload[3] = (uint8_t)delta;
    hass.host->log("hass: focus_card page=%u delta=%d",
                  (unsigned int)hass.page_index, (int)delta);
    (void)hass.host->bt_send(EVENT_CHANNEL, payload, sizeof(payload));
}

/* Asks the phone to fire the action of the entity focused on the card picture
 * on screen. The phone holds the entity list and the HA token; the glasses
 * only name the page so a stale message cannot fire on another card. */
static void request_card_activate(void)
{
    uint8_t payload[3];

    if (hass.page_count == 0U || !hass_pages[hass.page_index].image) return;
    payload[0] = PROTOCOL_VERSION;
    payload[1] = EVENT_CARD_ACTIVATE;
    payload[2] = (uint8_t)(hass.page_index & 0xFFU);
    hass.host->log("hass: activate_card page=%u", (unsigned int)hass.page_index);
    (void)hass.host->bt_send(EVENT_CHANNEL, payload, sizeof(payload));
}

/* Reports the raw gesture the Host delivered so the phone can show it. Sent
 * before any cooldown or routing: the point is to see what actually arrived,
 * not what the plugin did with it. Never gated on a page: the wearer may look
 * up on a text page too. */
static void send_gesture_debug(uint16_t gesture, bool active)
{
    uint8_t payload[5];
    payload[0] = PROTOCOL_VERSION;
    payload[1] = EVENT_DEBUG_GESTURE;
    payload[2] = (uint8_t)(gesture & 0xFFU);
    payload[3] = active ? 1U : 0U;
    payload[4] = (uint8_t)(hass.page_index & 0xFFU);
    (void)hass.host->bt_send(EVENT_CHANNEL, payload, sizeof(payload));
}

static uint16_t read_u16(const uint8_t *data)
{
    return (uint16_t)((uint16_t)data[0] | ((uint16_t)data[1] << 8));
}

static uint16_t read_be16(const uint8_t *data)
{
    return (uint16_t)(((uint16_t)data[0] << 8) | (uint16_t)data[1]);
}

/* Height of the incoming picture in the phone's space, used to know when every
 * tile has landed. */
static uint16_t picture_src_height;

/* Grayscale palette shared by every card picture: 16 shades, index 0 black to
 * index 15 white. The phone sends GRAY_4 nibbles, which are already indexes
 * into this exact ramp, so a tile maps 1:1 onto the image payload.
 *
 * The empty area of a card (its background) is index 0 and is made fully
 * transparent: the wearer asked for the drawn elements on the panel's own
 * background, never for a filled rectangle. Every other shade is opaque. */
#define HA_PICTURE_PALETTE_BYTES 64U
static const uint8_t ha_picture_palette[HA_PICTURE_PALETTE_BYTES] = {
    /* Index 0 is the card's empty background: transparent, so the panel's own
     * black shows through. A GRAY_4 card was painted as "black everywhere, then
     * the widgets": a full black card meant every pixel of it had to travel,
     * and it covered the rest of the screen. With entry 0 transparent only the
     * inked pixels matter, the card is an overlay, and much of it compresses to
     * nothing. */
    0x00U, 0x00U, 0x00U, 0x00U, 0x11U, 0x11U, 0x11U, 0xFFU,
    0x22U, 0x22U, 0x22U, 0xFFU, 0x33U, 0x33U, 0x33U, 0xFFU,
    0x44U, 0x44U, 0x44U, 0xFFU, 0x55U, 0x55U, 0x55U, 0xFFU,
    0x66U, 0x66U, 0x66U, 0xFFU, 0x77U, 0x77U, 0x77U, 0xFFU,
    0x88U, 0x88U, 0x88U, 0xFFU, 0x99U, 0x99U, 0x99U, 0xFFU,
    0xAAU, 0xAAU, 0xAAU, 0xFFU, 0xBBU, 0xBBU, 0xBBU, 0xFFU,
    0xCCU, 0xCCU, 0xCCU, 0xFFU, 0xDDU, 0xDDU, 0xDDU, 0xFFU,
    0xEEU, 0xEEU, 0xEEU, 0xFFU, 0xFFU, 0xFFU, 0xFFU, 0xFFU,
};

/* Frees the picture widget and its pixel buffer. The buffer is only borrowed
 * by the Host, so the object goes first. */
static void destroy_picture(void)
{
    if (hass.picture != 0) hass.ui->obj_delete(hass.picture);
    hass.picture = 0;
    if (hass.picture_alloc != 0) {
        hass.host->free(hass.picture_alloc);
        hass.picture_alloc = 0;
    }
    hass.picture_pixels = 0;
    hass.picture_width = 0U;
    hass.picture_height = 0U;
    hass.picture_y = 0U;
    hass.tile_page = NO_PAGE;
    hass.picture_page = NO_PAGE;
    hass.picture_live = false;
    picture_src_height = 0U;
}

/* Allocates the pixel buffer for a width x height picture if it does not exist
 * yet. It lives on the Host heap because a full-size card costs far more than
 * the plugin's static budget allows.
 *
 * The payload sits at one of two 4-byte-aligned offsets and the choice
 * alternates for every new picture: LVGL caches decoded images by source
 * pointer, so reusing one address for new pixels can serve the previous
 * picture forever. */
static bool ensure_picture(uint16_t width, uint16_t height)
{
    uint32_t stride = ((uint32_t)width + 1U) / 2U;
    uint32_t size = HA_PICTURE_PALETTE_BYTES + stride * (uint32_t)height;

    if (hass.picture_alloc != 0 && hass.picture_width == width &&
        hass.picture_height == height)
        return true;
    destroy_picture();
    hass.picture_alloc = (uint8_t *)hass.host->alloc(size + 4U);
    if (hass.picture_alloc == 0) {
        hass.host->log("hass: picture alloc failed %u bytes",
                      (unsigned int)(size + 4U));
        return false;
    }
    hass.picture_pixels = hass.picture_alloc + (hass.picture_slot != 0U ? 4U : 0U);
    hass.picture_slot = (uint8_t)((hass.picture_slot + 1U) & 1U);
    (void)hass.libc->memset(hass.picture_pixels, 0, size);
    (void)hass.libc->memcpy(hass.picture_pixels, ha_picture_palette,
                          HA_PICTURE_PALETTE_BYTES);
    hass.picture_dsc.struct_size = (uint16_t)sizeof(gm_plugin_lvgl_image_dsc_t);
    hass.picture_dsc.width = width;
    hass.picture_dsc.height = height;
    hass.picture_dsc.format = GM_PLUGIN_LVGL_IMAGE_INDEXED_4BIT;
    hass.picture_dsc.reserved = 0U;
    hass.picture_dsc.data = hass.picture_pixels;
    hass.picture_dsc.data_size = size;
    hass.picture_width = width;
    hass.picture_height = height;
    hass.picture_y = 0U;
    hass.tile_page = NO_PAGE;
    hass.picture_page = NO_PAGE;
    hass.picture_live = false;
    hass.host->log("hass: picture buffer %ux%u %u bytes",
                  (unsigned int)width, (unsigned int)height,
                  (unsigned int)size);
    return true;
}

static bool tile_row_is_empty(const uint8_t *row, uint32_t bytes)
{
    uint32_t i;
    for (i = 0U; i < bytes; i++) {
        if (row[i] != 0U) return false;
    }
    return true;
}

/* Decodes one raw LZ4 block (no frame header, as LZ4_compress_default writes)
 * into `size` bytes of `out`. Returns false on any malformed sequence or when
 * the block would overrun either of the two explicit limits. */
static bool lz4_decompress_block(const uint8_t *in, uint32_t in_len,
                                 uint8_t *out, uint32_t size)
{
    uint32_t src = 0U;
    uint32_t dst = 0U;

    while (src < in_len) {
        uint32_t token = in[src++];
        uint32_t literals = token >> 4;
        uint32_t match;
        uint32_t offset;
        uint32_t copy;

        if (literals == 15U) {
            uint8_t extra;
            do {
                if (src >= in_len) return false;
                extra = in[src++];
                literals += extra;
            } while (extra == 255U);
        }
        if (literals > in_len - src || literals > size - dst) return false;
        (void)hass.libc->memcpy(out + dst, in + src, literals);
        src += literals;
        dst += literals;
        /* The last sequence of a block carries literals only. */
        if (src >= in_len) break;
        if (in_len - src < 2U) return false;
        offset = (uint32_t)in[src] | ((uint32_t)in[src + 1U] << 8);
        src += 2U;
        if (offset == 0U || offset > dst) return false;
        match = token & 0x0FU;
        if (match == 15U) {
            uint8_t extra;
            do {
                if (src >= in_len) return false;
                extra = in[src++];
                match += extra;
            } while (extra == 255U);
        }
        match += 4U;
        if (match > size - dst) return false;
        /* Overlapping runs are legal and must be copied byte by byte. */
        for (copy = 0U; copy < match; copy++)
            out[dst + copy] = out[dst + copy - offset];
        dst += match;
    }
    return dst == size;
}


/* Copies one GRAY_4 tile into the picture's pixel buffer. Tiles carry whole
 * rows of the picture, top part first, so each lands at picture_y. Once the
 * last row is in, the image widget is (re)pointed at the buffer and LVGL paints
 * it like any other widget.
 *
 * This is the only picture path that survives: a picture written through the
 * public display channels goes to the framebuffer, and the next LVGL redraw
 * (the title band, a page change) paints over it. */
static void draw_rows(uint16_t page, uint16_t y, uint16_t width,
                      uint16_t height, uint16_t stride, const uint8_t *rows)
{
    uint32_t stride_px;
    uint32_t row;
    uint8_t *base;

    if (width == 0U || height == 0U ||
        stride != (uint16_t)((width + 1U) / 2U)) {
        hass.host->log("hass: tile rejected header");
        return;
    }
    if (y != 0U && (hass.picture_alloc == 0 ||
                    (uint32_t)y + height > hass.display_height)) {
        /* Rows are counted in the phone's space (0..card height), not in the
         * shrunken buffer: when the top band is dropped the buffer is
         * `display_height - top` tall, and comparing against it rejected the
         * last tile of every card that had a top margin, so those pictures
         * never completed. */
        hass.host->log("hass: tile skipped y=%u have=%u",
                      (unsigned int)y, (unsigned int)hass.picture_y);
        return;
    }

    stride_px = ((uint32_t)hass.picture_width + 1U) / 2U;
    base = hass.picture_pixels + HA_PICTURE_PALETTE_BYTES;
    /* The card is a fixed card-height picture split into equal tiles, and the
     * buffer may be shorter once its top band is dropped: completion is
     * counted against the source height (display_height), never the buffer. */
    picture_src_height = hass.picture_height;
    for (row = 0U; row < height; row++) {
        uint32_t copy = stride;
        int32_t out_y;
        uint8_t *dst;
        const uint8_t *src = rows + (uint32_t)row * stride;

        /* Rows are counted as `-(int32_t)picture_offset` on purpose: the
         * subtraction of two uint16_t values promotes to int, so it is signed
         * and can never wrap when the frame starts at row zero. It used to be
         * compared as an unsigned value against the top margin, so every row
         * of a card with no blank band (out_y = 0, offset = 0) was skipped and
         * the picture stayed empty. */
        out_y = (int32_t)(hass.picture_y + row) - (int32_t)hass.picture_offset;
        /* Above the first inked row: the buffer is one source screen tall, so
         * there is room and the row lands at index 0; skipping it left those
         * bytes zero because nothing was ever painted there. */
        if (out_y < 0) out_y = 0;
        if ((uint32_t)out_y >= (uint32_t)hass.display_height) break;
        dst = base + (uint32_t)out_y * stride_px;
        if (copy > stride_px) copy = stride_px;
        (void)hass.libc->memcpy(dst, src, copy);
    }
    /* Every source row is copied, so nothing has to be painted over and the
     * top margin is simply the same canvas shown from row zero. Completion is
     * counted against the card height, not the buffer. */
    hass.picture_y = (uint16_t)(hass.picture_y + height);
    hass.rows_pending = (uint16_t)(hass.rows_pending + height);
    hass.tiles_seen = (uint16_t)(hass.tiles_seen + 1U);
    hass.host->log("hass: picture rows=%u/%u tiles=%u top=%u drawn_rows=%u",
                  (unsigned int)hass.rows_pending,
                  (unsigned int)hass.display_height,
                  (unsigned int)hass.tiles_seen,
                  (unsigned int)hass.picture_offset,
                  (unsigned int)hass.picture_height);
    if (hass.picture_alloc == 0) return;
    if (hass.rows_pending < hass.display_height) {
        /* First rows of a frame whose top margin is already known, and the
         * screen is still this page's placeholder: show them now rather than
         * keep the "nod down" hint up for the whole transfer. The widget is
         * rebound through image_set_source() on every later tile, so a live
         * image never costs a re-creation. */
        hass.picture_page = page;
        if (hass.waiting_view && hass.waiting_page == hass.page_index &&
            hass.screen != 0 && page == hass.page_index)
            publish_picture();
        return;
    }

    /* Every row is in. The pixels now belong to `page`. Only the page on
     * screen keeps them: the glasses hold one picture, and a background
     * assembly (a page being preloaded) cost the visible card its buffer or
     * sat on screen as the wrong card. The page asks for its own picture when
     * the wearer goes there, so dropping one costs nothing. */
    hass.picture_page = page;
    hass.tile_page = NO_PAGE;
    hass.host->log("hass: picture complete page=%u on_screen=%u",
                  (unsigned int)page, (unsigned int)(page == hass.page_index));
    if (hass.screen == 0 || page != hass.page_index) {
        destroy_picture();
        return;
    }
    publish_picture();
}

/* First row of the assembled picture that is not empty background. The phone
 * crops the blank band above its widgets, but a widget may still sit a few rows
 * down, and those rows are pure transparent index 0. Skipping them puts the
 * first element on the top edge instead of keeping an empty band there. */
static uint16_t picture_first_ink(void)
{
    uint32_t stride;
    uint32_t row;
    const uint8_t *base;

    if (hass.picture_alloc == 0 || hass.picture_pixels == 0) return 0U;
    stride = ((uint32_t)hass.picture_width + 1U) / 2U;
    base = hass.picture_pixels + HA_PICTURE_PALETTE_BYTES;
    for (row = 0U; row < hass.picture_height; row++) {
        if (!tile_row_is_empty(base + row * stride, stride))
            return (uint16_t)row;
    }
    return 0U;
}

static void draw_tile(const uint8_t *data, uint32_t length)
{
    uint16_t page;
    uint16_t x;
    uint16_t y;
    uint16_t width;
    uint16_t height;
    uint16_t stride;

    if (length < 12U) return;
    page = read_be16(data);
    x = read_be16(data + 2);
    y = read_be16(data + 4);
    width = read_be16(data + 6);
    height = read_be16(data + 8);
    stride = read_be16(data + 10);
    hass.host->log("hass: tile page=%u x=%u y=%u w=%u h=%u stride=%u len=%u",
                  (unsigned int)page, (unsigned int)x, (unsigned int)y,
                  (unsigned int)width, (unsigned int)height,
                  (unsigned int)stride, (unsigned int)length);
    if (width == 0U || height == 0U ||
        stride != (uint16_t)((width + 1U) / 2U) ||
        (uint32_t)stride * height != length - 12U) {
        hass.host->log("hass: tile rejected header");
        return;
    }
    if (x != 0U || (uint32_t)y + height > 4096U) {
        hass.host->log("hass: tile rejected geometry");
        return;
    }
    /* Only the page on screen is drawn. Every page asks the phone for its
     * picture when the wearer arrives; a page that never preloads simply
     * starts painting a moment later. */
    if (page != hass.page_index) {
        hass.host->log("hass: tile ignored page=%u current=%u",
                      (unsigned int)page, (unsigned int)hass.page_index);
        return;
    }
    /* Rows of another page cannot be folded into the picture being assembled;
     * a y=0 tile of this page starts a new picture and replaces it. */
    if (hass.tile_page != NO_PAGE && hass.tile_page != page && y != 0U) {
        hass.host->log("hass: tile ignored page=%u current=%u",
                      (unsigned int)page, (unsigned int)hass.tile_page);
        return;
    }
    if (y == 0U) {
        hass.tile_page = page;
        hass.tiles_seen = 0U;
        hass.picture_y = 0U;
        hass.picture_offset = 0U;
        picture_src_height = 0U;
        hass.rows_pending = 0U;
        /* Never paint black while pixels are landing: the opaque waiting body
         * is torn down so the rows of the page stay readable until the card
         * replaces them in one shot. */
        if (hass.waiting_view) {
            hass.waiting_view = false;
            hass.waiting_page = NO_PAGE;
            if (build_ui() != GM_PLUGIN_OK) return;
        }
        /* The buffer is the whole card; its top margin is only known once
         * every row is in (a LZ4 tile may be the whole card in one message). */
        if (!ensure_picture(width, hass.display_height)) return;
        draw_rows(page, y, width, height, stride, data + 12U);
        return;
    }
    draw_rows(page, y, width, height, stride, data + 12U);
    /* A first tile may still have been blank: the margin is only known for
     * certain once a tile carry ink, and the rows are placed by it. */
    if (hass.picture_offset == 0U) hass.picture_offset = picture_first_ink();
}

/* One LZ4 tile: the same header as a raw tile plus the decoded byte count, then
 * one raw LZ4 block. It is decoded into static scratch and handed to the raw
 * path, so both channels share every check and both give the same picture. */
static void draw_lz4_tile(const uint8_t *data, uint32_t length)
{
    uint32_t decoded;
    uint16_t width;
    uint16_t height;
    uint16_t stride;
    uint32_t i;

    if (length < 16U) return;
    width = read_be16(data + 6);
    height = read_be16(data + 8);
    stride = read_be16(data + 10);
    decoded = ((uint32_t)data[12] << 24) | ((uint32_t)data[13] << 16) |
              ((uint32_t)data[14] << 8) | (uint32_t)data[15];
    if (width == 0U || height == 0U ||
        stride != (uint16_t)((width + 1U) / 2U) ||
        decoded != (uint32_t)stride * height || decoded > LZ4_MAX_TILE) {
        hass.host->log("hass: lz4 tile rejected header");
        return;
    }
    if (length - 16U > LZ4_MAX_TILE - 12U) {
        hass.host->log("hass: lz4 tile rejected size");
        return;
    }
    /* Decode twelve bytes into the buffer, leaving room in front for the header
     * draw_tile expects. Writing the header *over* the first decoded bytes (as
     * an earlier version did) destroyed the first twelve pixels of every tile,
     * and handing draw_tile the bare decoded count made its
     * `stride * height == length - 12` check reject every tile. */
    for (i = 0U; i < 12U; i++) lz4_input[i] = data[i];
    if (!lz4_decompress_block(data + 16U, length - 16U, lz4_input + 12U, decoded)) {
        hass.host->log("hass: lz4 tile decode failed");
        return;
    }
    hass.host->log("hass: lz4 tile page=%u h=%u in=%u out=%u",
                  (unsigned int)read_be16(data),
                  (unsigned int)height, (unsigned int)(length - 16U),
                  (unsigned int)decoded);
    draw_tile(lz4_input, decoded + 12U);
}

/* True when the pixels in the buffer are the card of the page on screen and
 * their own page armed that assembly. Without the second half, pixels pushed
 * for the sync (which lands while page 0 is shown, but sends every page's card
 * in a row) could be shown by whichever page happened to be on screen. */
static bool picture_ready_for_screen(void)
{
    return hass.screen != 0 && hass.picture_page == hass.page_index &&
           hass.tile_page == NO_PAGE && hass.picture_title[0] != '\0' &&
           hass.picture_alloc != 0 && hass.rows_pending > 0U;
}

/* Publishes the assembled buffer as an LVGL image on the page on screen. The
 * waiting page already holds the band and the title, so the picture only adds
 * itself between the body and the band. */
static void publish_picture(void)
{
    if (!picture_ready_for_screen()) return;
    set_screen_visible(false);
    if (hass.picture != 0 && hass.image_page == hass.picture_page && hass.picture_live) {
        /* The picture of this very page is already on screen, still being
         * filled: only move LVGL to the rows that landed since the last call.
         * Re-creating the widget here was what failed: a refreshed descriptor
         * whose payload had been memmove'd under a live object is refused by
         * the Host, and the placeholder stayed up for ever. */
        gm_plugin_result_t moved = hass.ui->image_set_source(hass.picture, &hass.picture_dsc);
        hass.ui->obj_invalidate(hass.picture);
        hass.host->log("hass: picture rows=+%u live set_source=%d %ux%u top=%u",
                      (unsigned int)hass.rows_pending, (int)moved,
                      (unsigned int)hass.picture_width,
                      (unsigned int)hass.picture_height,
                      (unsigned int)hass.picture_offset);
        return;
    }
    if (hass.picture != 0) {
        hass.ui->obj_delete(hass.picture);
        hass.picture = 0;
    }
    hass.picture_live = false;
    /* The payload keeps every source row and the top margin is not moved any
     * more: rows are written at `row - offset`, so no memmove runs under a
     * live image and the descriptor always describes exactly the Host block
     * allocated for it (one source screen tall, `display_height`). */
    hass.picture_height = (uint16_t)hass.display_height;
    hass.picture_dsc.width = hass.picture_width;
    hass.picture_dsc.height = hass.picture_height;
    hass.picture_dsc.data_size = HA_PICTURE_PALETTE_BYTES +
        ((uint32_t)hass.picture_width + 1U) / 2U * (uint32_t)hass.picture_height;
    hass.picture_dsc.data = hass.picture_pixels;
    /* Created at its own size, exactly as the Host expects when decoding an
     * INDEXED_4BIT source. A widget taller than the panel is refused and the
     * wearer keeps the "nod your head" placeholder. */
    /* Parented to the root, not to the list screen: the waiting page adds an
     * opaque black body above the screen, and a later sibling paints above an
     * earlier one. Created now, the picture lands on top of that body; the
     * title band is created right after it and stays on top. */
    hass.picture = hass.ui->image_create(hass.ui->root_get(), &hass.picture_dsc);
    if (hass.picture == 0) {
        hass.host->log("hass: picture widget create failed %ux%u size=%u",
                      (unsigned int)hass.picture_width,
                      (unsigned int)hass.picture_height,
                      (unsigned int)hass.picture_dsc.data_size);
        return;
    }
    hass.picture_live = true;
    hass.ui->obj_set_size(hass.picture, (int32_t)hass.picture_width,
                         (int32_t)hass.picture_height);
    /* Pinned to the top-left corner of the root. obj_set_pos() is only honoured
     * by LVGL for a widget whose default alignment is TOP_LEFT; the default is
     * CENTER, so a picture left unaligned sits centred, i.e. half of a 350-row
     * card hangs below a 350-row panel. */
    hass.ui->obj_align(hass.picture, GM_PLUGIN_LVGL_ALIGN_TOP_LEFT, 0, 0);
    hass.ui->obj_set_pos(hass.picture, 0, 0);
    hass.ui->obj_clear_flag(hass.picture, GM_PLUGIN_LVGL_FLAG_SCROLLABLE);
    hass.ui->obj_invalidate(hass.picture);
    /* No title band over a card: the picture owns the whole screen. */
    hass.image_page = hass.picture_page;
    hass.host->log("hass: picture drawn %ux%u top=%u screen=%ux%u rows=%u",
                  (unsigned int)hass.picture_width,
                  (unsigned int)hass.picture_height,
                  (unsigned int)hass.picture_offset,
                  (unsigned int)hass.display_width,
                  (unsigned int)hass.display_height,
                  (unsigned int)hass.rows_pending);
}

/* Builds the label shown for one row: just the entity name. The bitmap icon
 * lives in its own column to the left, so the text starts after a gap and never
 * crowds it. */
/* When the panel shares the root with the LVGL screen object, the card is
 * painted by a widget of its own and the screen itself has to be hidden: its
 * background would otherwise cover the picture. The plugin only knows one
 * "screen" object, so it is left empty and transparent while a card is shown.
 * On a panel where the screen is the root there is nothing to hide. */
static void set_screen_visible(bool visible)
{
    if (hass.screen == 0 || hass.screen == hass.ui->root_get()) return;
    if (visible) hass.ui->obj_clear_flag(hass.screen, GM_PLUGIN_LVGL_FLAG_HIDDEN);
    else hass.ui->obj_add_flag(hass.screen, GM_PLUGIN_LVGL_FLAG_HIDDEN);
}

static void fill_row_text(char *out, size_t capacity, const char *label)
{
    size_t used = 0U;
    while (label[0] != '\0' && used + 1U < capacity) out[used++] = *label++;
    out[used] = '\0';
}

/* Reads the panel size once and derives the row geometry from it. Called at
 * start and whenever the list widgets are rebuilt. */
static gm_plugin_result_t layout(void)
{
    gm_plugin_display_info_t display;
    int32_t rows_area_height;

    if (hass.host->display_get_info(&display) != GM_PLUGIN_OK ||
        display.width <= SCREEN_MARGIN * 2U)
        return GM_PLUGIN_ESTATE;

    rows_area_height = (int32_t)display.height - HINT_HEIGHT - SCREEN_MARGIN;
    /* Fit as many rows as the panel allows, capped by MAX_VISIBLE_ROWS. Rows
     * beyond that stay in the page buffer and are reached by scrolling. Each
     * drawn row is sized from this area so the window always fits between the
     * header and the hint instead of overrunning the hint. */
    hass.visible_rows = (uint8_t)(rows_area_height / ROW_MIN_HEIGHT);
    if (hass.visible_rows > MAX_VISIBLE_ROWS) hass.visible_rows = MAX_VISIBLE_ROWS;
    if (hass.visible_rows == 0U) return GM_PLUGIN_ESTATE;
    hass.row_height = rows_area_height / (int32_t)hass.visible_rows;
    if (hass.row_height < ROW_MIN_HEIGHT) return GM_PLUGIN_ESTATE;
    /* Rows fill rows_area_height exactly; anchor them just under the header. */
    rows_area_height = (int32_t)hass.visible_rows * hass.row_height;
    hass.display_width = display.width;
    hass.display_height = display.height;

    hass.host->log("hass: display %ux%u visible_rows=%u row_height=%d area=%d",
                  (unsigned int)display.width, (unsigned int)display.height,
                  (unsigned int)hass.visible_rows, (int)hass.row_height,
                  (int)rows_area_height);
    return GM_PLUGIN_OK;
}

/* Creates the screen and the navigation hint. Shared by the list view and by
 * the overlay that sits on top of a card picture. Row pages carry no header
 * band: the page title from the dashboard is not shown on the glasses. */
static gm_plugin_result_t build_frame(void)
{
    gm_plugin_lvgl_obj_t *root;
    int32_t width;

    if (layout() != GM_PLUGIN_OK) return GM_PLUGIN_ESTATE;
    width = (int32_t)hass.display_width;
    root = hass.ui->root_get();
    if (root == 0) return GM_PLUGIN_ESTATE;

    hass.screen = hass.ui->obj_create(root);
    if (hass.screen == 0) return GM_PLUGIN_ENOMEM;
    hass.ui->obj_set_size(hass.screen, width, (int32_t)hass.display_height);
    hass.ui->obj_align(hass.screen, GM_PLUGIN_LVGL_ALIGN_CENTER, 0, 0);
    style_panel(hass.screen, 0x00, 0, 0);

    /* Navigation hints were removed at the wearer's request: the head gestures
     * are discoverable on their own and the text crowded the rows. The label is
     * kept (empty) so the layout stays unchanged. */
    hass.hint_label = make_label(hass.screen, "", 0x70, false);
    if (hass.hint_label == 0) return GM_PLUGIN_ENOMEM;
    hass.ui->obj_set_size(hass.hint_label, width - SCREEN_MARGIN * 2U, HINT_HEIGHT);
    hass.ui->obj_align(hass.hint_label, GM_PLUGIN_LVGL_ALIGN_BOTTOM_MID, 0, 0);
    return GM_PLUGIN_OK;
}

/* Creates every row widget for the list view. */
static gm_plugin_result_t build_rows(void)
{
    uint32_t row;
    int32_t width = (int32_t)hass.display_width;

    for (row = 0U; row < hass.visible_rows; row++) {
        /* Absolute placement via obj_set_pos (top-left in logical pixels) keeps
         * the rows inside the area below the header without depending on the
         * alignment point's origin. Two fixed columns: label hugs the left
         * margin, value stops before the right margin. Sizing both from a single
         * split point guarantees a long label can never push the value off the
         * screen; the label clips with "..." via LABEL_DOT. A background
         * rectangle sits behind each row and is made opaque only for the
         * selected row, drawing the selection cursor. */
        int32_t top_y = SCREEN_MARGIN / 2 + (int32_t)row * hass.row_height;

        /* The highlight rectangle is created first so the label text draws
         * above the selected-row bar. */
        hass.row_bg[row] = hass.ui->obj_create(hass.screen);
        if (hass.row_bg[row] == 0) return GM_PLUGIN_ENOMEM;
        hass.ui->obj_set_size(hass.row_bg[row], width - SCREEN_MARGIN - RIGHT_MARGIN,
                             hass.row_height - 2);
        hass.ui->obj_set_pos(hass.row_bg[row], SCREEN_MARGIN, top_y);
        set_style(hass.row_bg[row], GM_PLUGIN_LVGL_STYLE_BG_COLOR, color(0x38));
        set_style(hass.row_bg[row], GM_PLUGIN_LVGL_STYLE_BG_OPA, number(0));
        set_style(hass.row_bg[row], GM_PLUGIN_LVGL_STYLE_RADIUS, number(6));
        /* No outline around the highlight: only a flat filled bar. */
        set_style(hass.row_bg[row], GM_PLUGIN_LVGL_STYLE_BORDER_WIDTH, number(0));
        set_style(hass.row_bg[row], GM_PLUGIN_LVGL_STYLE_BORDER_OPA, number(0));
        hass.ui->obj_clear_flag(hass.row_bg[row], GM_PLUGIN_LVGL_FLAG_SCROLLABLE);

        /* Bitmap icon in its own column, behind the text so the selected-row
         * bar still shows through around it. */
        hass.row_icon[row] = hass.ui->image_create(hass.screen, &hass_icons_dsc[HASS_ICON_FALLBACK]);
        if (hass.row_icon[row] == 0) return GM_PLUGIN_ENOMEM;
        hass.ui->obj_set_pos(hass.row_icon[row], hass.icon_x,
                           top_y + (hass.row_height - 2 - (int32_t)HASS_ICON_SIZE) / 2);
        set_style(hass.row_icon[row], GM_PLUGIN_LVGL_STYLE_IMG_OPA, number(0));

        /* The label starts right of the icon column. */
        hass.row_label[row] = make_label(hass.screen, "", 0xD0, true);
        if (hass.row_label[row] == 0) return GM_PLUGIN_ENOMEM;
        hass.ui->obj_set_size(hass.row_label[row], hass.label_width, hass.row_height - 2);
        hass.ui->obj_set_pos(hass.row_label[row], hass.label_x, top_y);

        hass.row_value[row] = make_label(hass.screen, "", 0xF0, false);
        if (hass.row_value[row] == 0) return GM_PLUGIN_ENOMEM;
        hass.ui->obj_set_size(hass.row_value[row], hass.value_width, hass.row_height - 2);
        hass.ui->obj_set_pos(hass.row_value[row],
                           width - RIGHT_MARGIN - hass.value_width, top_y);
    }
    return GM_PLUGIN_OK;
}

static void reset_widgets(void)
{
    uint32_t slot;
    for (slot = 0U; slot < MAX_VISIBLE_ROWS; slot++) {
        hass.row_bg[slot] = 0;
        hass.row_icon[slot] = 0;
        hass.row_label[slot] = 0;
        hass.row_value[slot] = 0;
    }
    hass.screen = 0;
    hass.hint_label = 0;
    /* build_ui() cleans the root, which takes every root-level picture and
     * band with it: keeping those pointers would mean deleting them twice. */
    hass.picture = 0;
    hass.band_panel = 0;
    hass.band_label = 0;
}

/* Creates the full list view: panel, title, hint and every row. */
static gm_plugin_result_t build_ui(void)
{
    gm_plugin_result_t result;
    int32_t usable, gap;
    gm_plugin_lvgl_obj_t *root = hass.ui->root_get();

    /* The list is rebuilt on every page change and every gesture: releasing the
     * previous tree first keeps the object count flat instead of stacking one
     * opaque screen per refresh. */
    if (root != 0) hass.ui->obj_clean(root);
    hass.band_panel = 0;
    hass.band_label = 0;
    reset_widgets();
    hass.waiting_view = false;
    hass.waiting_page = NO_PAGE;
    result = build_frame();
    if (result != GM_PLUGIN_OK) {
        /* A frame failure leaves no hint_label, and the page loop would then
         * fault on it: report the real code so a refusal is not mistaken for
         * the "no root yet" ESTATE. */
        hass.host->log("hass: build_frame failed %d", (int)result);
        return result;
    }

    /* Split the usable width into a label column and a value column with a
     * fixed gap between them. The value gets a fixed share so long numeric
     * readings stay whole; the label takes the rest and truncates. The value
     * column stops short of the right edge (RIGHT_MARGIN) so it never hugs the
     * border. */
    usable = (int32_t)hass.display_width - SCREEN_MARGIN - RIGHT_MARGIN;
    gap = usable / 12;
    hass.value_width = usable * 2 / 5;
    hass.label_width = usable - hass.value_width - gap;
    if (hass.label_width < 0) hass.label_width = 0;

    /* A dedicated icon column holds the bitmap icon; the label starts after
     * ICON_CELL so there is a clear gap between icon and name. */
    hass.icon_x = SCREEN_MARGIN;
    hass.label_x = SCREEN_MARGIN + ICON_CELL;
    hass.label_width -= ICON_CELL;
    if (hass.label_width < 0) hass.label_width = 0;
    hass.host->log("hass: icon_x=%d label_x=%d label_w=%d value_w=%d",
                  (int)hass.icon_x, (int)hass.label_x, (int)hass.label_width,
                  (int)hass.value_width);

    result = build_rows();
    if (result != GM_PLUGIN_OK)
        hass.host->log("hass: build_rows failed %d visible=%u",
                      (int)result, (unsigned int)hass.visible_rows);
    return result;
}

/* Image page before its picture lands: title band, an opaque black body, and
 * one centred hint. The black body is what makes room for the tiles: with the
 * list merely cleared, LVGL leaves the panel at "invalid" and the screen keeps
 * whatever the previous page painted - which is why the hint used to sit on a
 * black page forever. */
static gm_plugin_result_t build_waiting_page(const char *message)
{
    gm_plugin_lvgl_obj_t *root = hass.ui->root_get();
    gm_plugin_lvgl_obj_t *body;
    int32_t width, body_height;

    if (root == 0) return GM_PLUGIN_ESTATE;
    /* The waiting page is about to clean the root, which also removes the
     * picture widget; release its pixels so a later tile starts fresh. */
    destroy_picture();
    hass.image_page = NO_PAGE;
    /* A card picture has no title band: the black body covers the header row
     * as well, exactly the area the picture will fill. */
    {
        gm_plugin_result_t built = build_ui();
        if (built != GM_PLUGIN_OK) return built;
    }
    width = (int32_t)hass.display_width;
    body_height = (int32_t)hass.display_height;

    /* Created last so it covers the empty row widgets. */
    body = hass.ui->obj_create(hass.screen != 0 ? hass.screen : root);
    if (body == 0) return GM_PLUGIN_ENOMEM;
    hass.ui->obj_set_pos(body, 0, 0);
    hass.ui->obj_set_size(body, width, body_height);
    set_style(body, GM_PLUGIN_LVGL_STYLE_BG_COLOR, color(0x00));
    set_style(body, GM_PLUGIN_LVGL_STYLE_BG_OPA, number(255));
    set_style(body, GM_PLUGIN_LVGL_STYLE_BORDER_WIDTH, number(0));
    set_style(body, GM_PLUGIN_LVGL_STYLE_RADIUS, number(0));
    hass.ui->obj_clear_flag(body, GM_PLUGIN_LVGL_FLAG_SCROLLABLE);

    if (hass.hint_label != 0) {
        hass.ui->label_set_text(hass.hint_label, message);
        set_style(hass.hint_label, GM_PLUGIN_LVGL_STYLE_TEXT_OPA, number(255));
    }
    hass.waiting_view = true;
    hass.waiting_page = hass.page_index;
    /* The waiting hint and its black body live under the screen object, which a
     * published card hides: without this the placeholder of the next page is
     * invisible and the wearer stares at a black panel. */
    set_screen_visible(true);
    return GM_PLUGIN_OK;
}

static void ensure_selection_visible(void)
{
    /* Image pages have no rows: there is nothing to scroll. */
    if (hass.screen == 0) return;
    if (hass.selected < hass.scroll_offset) {
        hass.scroll_offset = hass.selected;
    } else if ((uint32_t)hass.selected >=
               (uint32_t)hass.scroll_offset + hass.visible_rows) {
        hass.scroll_offset = (uint16_t)(hass.selected - hass.visible_rows + 1U);
    }
}

/* Moves the selection cursor by delta rows, clamped to the current page, and
 * scrolls so the cursor stays visible. No-op when the gesture would not move. */
static void move_selection(int32_t delta)
{
    const hass_page_t *page;
    int32_t next;

    if (hass.page_count == 0U) return;
    page = &hass_pages[hass.page_index];
    if (page->row_count == 0U) return;

    next = (int32_t)hass.selected + delta;
    if (next < 0) next = 0;
    if (next >= (int32_t)page->row_count) next = (int32_t)page->row_count - 1;
    if ((uint16_t)next == hass.selected) return;
    hass.selected = (uint16_t)next;
    ensure_selection_visible();
    refresh_page();
}

/* Sends the selected row's action (entity id) to the phone so it can run the
 * matching Home Assistant service. Ignored when the row carries no action. */
static void run_action(void)
{
    const hass_page_t *page;
    const char *action;
    uint8_t payload[3U + MAX_ACTION_BYTES];
    uint8_t len = 0U;

    if (hass.page_count == 0U) return;
    page = &hass_pages[hass.page_index];
    if (page->image || hass.selected >= page->row_count) return;

    action = page->rows[hass.selected].action;
    while (action[len] != '\0' && len < MAX_ACTION_BYTES) {
        payload[3U + len] = (uint8_t)action[len];
        len++;
    }
    if (len == 0U) return;

    payload[0] = PROTOCOL_VERSION;
    payload[1] = EVENT_ACTION;
    payload[2] = len;
    hass.host->log("hass: action row=%u len=%u",
                  (unsigned int)hass.selected, (unsigned int)len);
    (void)hass.host->bt_send(EVENT_CHANNEL, payload, 3U + len);
}

/* Loops through pages in both directions so navigation never sticks at the
 * ends. Only fires when there is more than one page. Resets the selection to
 * the first row of the newly shown page. */
static bool change_page(int32_t delta)
{
    /* Only a real move counts as a handled page change: the caller starts the
     * gesture cooldown on it, and a no-op must not swallow the next gesture. */
    if (hass.page_count < 2U) return false;
    if (delta == 0) return false;
    {
        int32_t wrapped = ((int32_t)hass.page_index + delta) % (int32_t)hass.page_count;
        if (wrapped < 0) wrapped += (int32_t)hass.page_count;
        hass.page_index = (uint16_t)wrapped;
    }
    hass.scroll_offset = 0U;
    hass.selected = 0U;
    /* The phone keeps the wearer's row offset of a card picture. Coming back
     * to a picture page therefore shows that offset's pixels, so the picture
     * on screen is stale the moment the page changes: it is dropped here
     * instead of staying up under the new page's band. */
    if (hass.image_page != NO_PAGE || hass.picture != 0) {
        hass.image_page = NO_PAGE;
        hass.picture_title[0] = '\0';
        destroy_picture();
    }
    /* The opaque band and the waiting body are root-level widgets: leaving the
     * card picture must take them away, otherwise they cover the rows of a
     * plain page. build_ui() inside refresh_page restores a clean list. */
    if (hass.band_panel != 0 || hass.waiting_view) {
        hass.band_panel = 0;
        hass.band_label = 0;
        hass.waiting_view = false;
        hass.waiting_page = NO_PAGE;
        if (build_ui() != GM_PLUGIN_OK) return false;
    }
    /* Tell the phone the new page before anything else: a picture request for
     * the page being looked at is only served once the phone knows about it. */
    send_page_changed();
    refresh_page();
    /* Landing on a picture page asks for its picture straight away: the plugin
     * keeps at most one card in its buffer, so this page's pixels have to be
     * sent again. */
    if (hass_pages[hass.page_index].image)
        request_card_image();
    return true;
}


static gm_plugin_result_t hass_start(void *context)
{
    char locale[GM_PLUGIN_LOCALE_TAG_MAX];
    gm_plugin_lvgl_obj_t *root;
    gm_plugin_result_t built;
    gm_plugin_result_t imu;

    (void)context;

    /* Start-time refusals are logged one by one: the Host only reports the
     * code, and ESTATE (-7) has three different origins here. */
    root = hass.ui->root_get();
    hass.host->log("hass: start root=%s lvgl_struct=%u api=%u.%u images_ok=%u",
                  root != 0 ? "ok" : "null",
                  (unsigned int)hass.ui->struct_size,
                  (unsigned int)(hass.ui->api_version >> 8),
                  (unsigned int)(hass.ui->api_version & 0xFFU),
                  (unsigned int)(hass.images_ok ? 1U : 0U));
    if (root == 0) return GM_PLUGIN_ESTATE;

    hass.connected = false;
    hass.image_page = NO_PAGE;
    hass.waiting_page = NO_PAGE;
    hass.band_panel = 0;
    hass.band_label = 0;
    hass.picture = 0;
    hass.picture_alloc = 0;
    hass.picture_pixels = 0;
    hass.picture_width = 0U;
    hass.picture_height = 0U;
    hass.picture_y = 0U;
    hass.rows_pending = 0U;
    hass.tiles_seen = 0U;
    hass.tile_page = NO_PAGE;
    hass.picture_page = NO_PAGE;
    hass.picture_live = false;
    hass.picture_title[0] = '\0';
    hass.language = 0U;
    if (hass.host->locale_get != 0 &&
        hass.host->locale_get(locale) == GM_PLUGIN_OK)
        hass.language = ha_detect_language(locale);

    /* A failed UI build is not an out-of-memory condition: the real code (a
     * refused display query, a refused object) is what has to reach the Host
     * and the log, otherwise every start failure reads as -4. */
    built = build_ui();
    if (built != GM_PLUGIN_OK) {
        hass.host->log("hass: build_ui failed at start=%d", (int)built);
        return built;
    }

    hass.page_count = 0U;
    hass.page_index = 0U;
    hass.scroll_offset = 0U;
    hass.selected = 0U;
    refresh_page();

    /* Head left/right turns the page: the dashboard is a sequence of card
     * pages. Up/down no longer navigates (1.0.18: the button steps and
     * activates entities). The phone's navigation panel still sends the same
     * moves as EVENT_NAV commands. */
    imu = hass.host->imu_enable(GM_PLUGIN_IMU_ENABLE_GESTURES);
    if (imu != GM_PLUGIN_OK) {
        hass.host->log("hass: imu_enable=%d, gestures unavailable",
                      (int)imu);
    }
    hass.host->log("hass: gestures enabled (imu_enable=%d)", (int)imu);
    return GM_PLUGIN_OK;
}

/* Renders the current page: title with an "i/n" position marker, the visible
 * slice of label/value rows starting at scroll_offset, and a navigation hint.
 * Rows past the page's row_count are blanked so a shorter page never shows
 * stale entries. An image page is drawn by the phone instead: this function
 * only keeps the title and, until the picture arrives, one hint line. */
static void refresh_page(void)
{
    char title[64];
    char row_text[MAX_LABEL_BYTES + 4U];
    uint32_t slot;

    if (hass.ui->root_get() == 0) {
        hass.host->log("hass: refresh skipped (no UI cycle)");
        return;
    }
    if (hass.page_count == 0U) {
        if (hass.screen == 0 && build_ui() != GM_PLUGIN_OK) return;
        for (slot = 0U; slot < hass.visible_rows; slot++) {
            hass.ui->label_set_text(hass.row_label[slot], "");
            hass.ui->label_set_text(hass.row_value[slot], "");
            hide_row_icon(slot);
            set_style(hass.row_bg[slot], GM_PLUGIN_LVGL_STYLE_BG_OPA, number(0));
        }
        hass.ui->label_set_text(hass.hint_label,
            L("En attente du telephone...", "Waiting for the phone...", "Esperando al teléfono...", "In attesa del telefono...", "Warte auf das Telefon...", "正在等待手机..."));
        hass.image_page = NO_PAGE;
        /* A card picture hides the screen object to let its own widget show:
         * coming back to a page that has no card must bring the list back. */
        set_screen_visible(true);
        return;
    }

    {
        const hass_page_t *page = &hass_pages[hass.page_index];
        uint16_t total_rows = page->row_count;
        uint16_t max_offset;
        uint32_t pos = (uint32_t)(hass.page_index + 1U);
        uint32_t total = (uint32_t)hass.page_count;
        int written = 0;
        const char *src = page->title;

        /* The list may have been cleared by a previous picture: rebuild it
         * before touching the row widgets. Image pages build their own view
         * further down, once the title is composed. Picture widgets are parented
         * to the root (they outlive the list), so a picture page clears them
         * first: without that, the previous page's card would stay on screen
         * under the new band until the phone pushed this page's pixels. */
        if (page->image) {
            /* Only a picture that belongs to another page is cleared here. The
             * card of the page on screen is kept: an auto-refresh re-sends the
             * dashboard without new tiles when nothing moved, and destroying
             * the picture turned a displayed card black for good. */
            if (hass.image_page != NO_PAGE && hass.image_page != hass.page_index) {
                hass.image_page = NO_PAGE;
                hass.picture_title[0] = '\0';
                destroy_picture();
                if (build_ui() != GM_PLUGIN_OK) return;
            } else if (hass.band_panel != 0 && hass.image_page == NO_PAGE) {
                if (build_ui() != GM_PLUGIN_OK) return;
            }
            hass.waiting_page = NO_PAGE;
        } else if (hass.screen == 0) {
            hass.image_page = NO_PAGE;
            if (build_ui() != GM_PLUGIN_OK) return;
        }

        /* Keep the window inside the page after a refresh that shortened it. */
        max_offset = (total_rows > hass.visible_rows)
            ? (uint16_t)(total_rows - hass.visible_rows) : 0U;
        if (hass.scroll_offset > max_offset) hass.scroll_offset = max_offset;

        /* Title then "i/n" kept only as a label for the logs: nothing of it
         * is drawn on the glasses any more. */
        while (*src != '\0' && written < 48) title[written++] = *src++;
        title[written++] = ' ';
        title[written++] = ' ';
        if (pos >= 10U) title[written++] = (char)('0' + (pos / 10U) % 10U);
        title[written++] = (char)('0' + pos % 10U);
        title[written++] = '/';
        if (total >= 10U) title[written++] = (char)('0' + (total / 10U) % 10U);
        title[written++] = (char)('0' + total % 10U);
        /* Scroll position marker when the page overflows the screen. */
        if (total_rows > hass.visible_rows) {
            uint16_t last = (uint16_t)(hass.scroll_offset + hass.visible_rows);
            title[written++] = ' ';
            if (last >= 10U) title[written++] = (char)('0' + (last / 10U) % 10U);
            title[written++] = (char)('0' + last % 10U);
            title[written++] = '/';
            if (total_rows >= 10U) title[written++] = (char)('0' + (total_rows / 10U) % 10U);
            title[written++] = (char)('0' + total_rows % 10U);
        }
        title[written] = '\0';

        if (page->image) {
            /* An image page shows the card picture as an LVGL image widget,
             * created by draw_tile() once every tile has landed. The waiting
             * view (black body + hint) stays up until then; the picture view
             * already owns the screen, so a refresh never destroys its pixels.
             * The picture covers the whole screen: no title band. */
            if (hass.screen != 0 && hass.image_page == hass.page_index) return;
            /* A live image of this page survives the refresh (its pixels are in
             * the buffer); rebinding it costs nothing and never tears it down
             * under a redraw. */
            if (hass.picture != 0 && hass.picture_live &&
                hass.picture_page == hass.page_index) {
                hass.picture_title[0] = '\0';
                {
                    size_t t = 0U;
                    while (title[t] != '\0' && t + 1U < sizeof(hass.picture_title)) {
                        hass.picture_title[t] = title[t];
                        t++;
                    }
                    hass.picture_title[t] = '\0';
                }
                publish_picture();
                return;
            }
            /* A refresh that arrives while the placeholder of this very page is
             * up must not rebuild it: the pixels may already be in the buffer,
             * and a rebuild costs a flash of black. */
            if (hass.screen != 0 && hass.waiting_view &&
                hass.waiting_page == hass.page_index) {
                hass.host->log("hass: waiting page already shown page=%u",
                              (unsigned int)hass.page_index);
                publish_picture();
                return;
            }
            /* The title only labels the placeholder for the log; nothing of it
             * is drawn. It is still required for publish_picture to accept the
             * assembled pixels. */
            hass.picture_title[0] = '\0';
            {
                size_t t = 0U;
                while (title[t] != '\0' && t + 1U < sizeof(hass.picture_title)) {
                    hass.picture_title[t] = title[t];
                    t++;
                }
                hass.picture_title[t] = '\0';
            }
            if (build_waiting_page(
                    L("Inclinez la tete vers le bas pour charger l'image.",
                      "Nod down to load the picture.",
                      "Inclina la cabeza hacia abajo para cargar la imagen.",
                      "Inclina la testa verso il basso per caricare l'immagine.",
                      "Kopf nach unten neigen, um das Bild zu laden.",
                      "向下点头以加载图像。")) != GM_PLUGIN_OK) return;
            /* The pixels of this very page may already be in the buffer (a
             * nudge back and forth re-arms the page): show them instead of
             * waiting for a push the phone would not make. */
            publish_picture();
            return;
        }

        /* A row page took the screen back from a picture. */
        if (hass.image_page != NO_PAGE) {
            hass.image_page = NO_PAGE;
            hass.picture_title[0] = '\0';
            destroy_picture();
            if (build_ui() != GM_PLUGIN_OK) return;
        }

        /* This is the bug that made every entity-only page a black panel:
         * publish_picture() adds HIDDEN to the screen object (so the card
         * widget, a child of the root, is not covered by the screen's black
         * background) and nothing ever cleared it again. Every row widget of a
         * list page is a child of that screen, so the rows were parsed,
         * positioned and painted into a hidden object: the wearer saw a black
         * panel while the card pages - root children - kept working. */
        set_screen_visible(true);

        for (slot = 0U; slot < hass.visible_rows; slot++) {
            uint32_t row = (uint32_t)hass.scroll_offset + slot;
            bool is_selected = (row < page->row_count) && ((uint16_t)row == hass.selected);
            if (row < page->row_count) {
                fill_row_text(row_text, sizeof(row_text),
                              page->rows[row].label);
                hass.ui->label_set_text(hass.row_label[slot], row_text);
                hass.ui->label_set_text(hass.row_value[slot], page->rows[row].value);
                show_row_icon(slot, page->rows[row].icon);
            } else {
                hass.ui->label_set_text(hass.row_label[slot], "");
                hass.ui->label_set_text(hass.row_value[slot], "");
                hide_row_icon(slot);
            }
            /* Highlight the selected row; the others keep a transparent
             * background so the highlight follows the cursor. */
            set_style(hass.row_bg[slot], GM_PLUGIN_LVGL_STYLE_BG_OPA,
                      number(is_selected ? 255 : 0));
        }

        /* Navigation hints were removed at the wearer's request: the head
         * gestures are discoverable on their own and the text crowded the
         * rows. The label is kept (empty) so the layout stays unchanged. */
        hass.ui->label_set_text(hass.hint_label, "");
    }
}

static void handle_set_pages(const uint8_t *data, uint32_t length)
{
    uint32_t offset;
    uint32_t flags_offset;
    uint16_t requested_pages;
    uint16_t p;
    /* A dashboard is re-sent on every auto-refresh and on every reconnect, yet
     * its page list usually did not move. Recording the list before the parse
     * lets an identical payload keep the picture on screen: wiping it here left
     * the wearer on the waiting page, and the phone's cached push then had
     * nothing new to send, so the card stayed black. */
    uint16_t previous_count = hass.page_count;
    uint8_t previous_image[MAX_PAGES];
    bool same_structure;

    if (length < MIN_SET_PAGES_PAYLOAD || data[0] != PROTOCOL_VERSION) return;

    if (data[1] == COMMAND_CLEAR) {
        hass.page_count = 0U;
        hass.page_index = 0U;
        hass.scroll_offset = 0U;
        hass.selected = 0U;
        refresh_page();
        return;
    }
    if (data[1] != COMMAND_SET_PAGES) return;

    for (p = 0U; p < previous_count && p < MAX_PAGES; p++)
        previous_image[p] = hass_pages[p].image ? 1U : 0U;

    requested_pages = read_u16(&data[2]);
    if (requested_pages > MAX_PAGES) requested_pages = MAX_PAGES;

    flags_offset = NO_OFFSET;
    offset = 4U;
    for (p = 0U; p < requested_pages; p++) {
        hass_page_t *page = &hass_pages[p];
        uint8_t title_len;
        uint16_t requested_rows;
        uint16_t r;

        if (offset + 1U > length) break;
        title_len = data[offset++];
        if (title_len > MAX_TITLE_BYTES || offset + title_len > length) break;
        hass.libc->memcpy(page->title, &data[offset], title_len);
        page->title[title_len] = '\0';
        offset += title_len;

        if (offset + 2U > length) break;
        requested_rows = read_u16(&data[offset]);
        offset += 2U;
        if (requested_rows > MAX_ROWS_PER_PAGE) requested_rows = MAX_ROWS_PER_PAGE;

        for (r = 0U; r < requested_rows; r++) {
            uint8_t label_len;
            uint8_t value_len;
            uint8_t action_len;
            if (offset + 1U > length) break;
            page->rows[r].icon = data[offset++];
            if (offset + 1U > length) break;
            label_len = data[offset++];
            if (label_len > MAX_LABEL_BYTES || offset + label_len > length) break;
            hass.libc->memcpy(page->rows[r].label, &data[offset], label_len);
            page->rows[r].label[label_len] = '\0';
            offset += label_len;

            if (offset + 1U > length) break;
            value_len = data[offset++];
            if (value_len > MAX_VALUE_BYTES || offset + value_len > length) break;
            hass.libc->memcpy(page->rows[r].value, &data[offset], value_len);
            page->rows[r].value[value_len] = '\0';
            offset += value_len;

            if (offset + 1U > length) break;
            action_len = data[offset++];
            if (action_len > MAX_ACTION_BYTES || offset + action_len > length) break;
            hass.libc->memcpy(page->rows[r].action, &data[offset], action_len);
            page->rows[r].action[action_len] = '\0';
            offset += action_len;
        }
        page->row_count = (uint8_t)r;
        page->image = false;
    }
    hass.page_count = p;
    /* Trailer: exactly one flag byte per page, right at the end. */
    if (p == requested_pages && length >= offset &&
        length - offset == (uint32_t)requested_pages)
        flags_offset = offset;
    for (p = 0U; p < hass.page_count; p++) {
        if (flags_offset != NO_OFFSET && data[flags_offset + p] == 1U)
            hass_pages[p].image = true;
    }
    if (hass.page_index >= hass.page_count) hass.page_index = 0U;
    hass.scroll_offset = 0U;
    hass.selected = 0U;
    same_structure = (previous_count == hass.page_count);
    if (same_structure) {
        for (p = 0U; p < hass.page_count; p++) {
            if (previous_image[p] != (hass_pages[p].image ? 1U : 0U)) {
                same_structure = false;
                break;
            }
        }
    }
    /* A picture of the page on screen survives an unchanged dashboard: the
     * tiles in the buffer are still its pixels, and the phone only re-pushes a
     * card whose data actually moved. Rebuilding a new dashboard (or a page
     * list that gained/lost a card page) invalidates every picture instead,
     * because the phone pushes fresh tiles right after this payload. */
    if (!same_structure) {
        hass.image_page = NO_PAGE;
        hass.waiting_page = NO_PAGE;
        hass.picture_title[0] = '\0';
        destroy_picture();
    } else if (hass.picture != 0 && hass.image_page == hass.page_index) {
        hass.waiting_page = NO_PAGE;
    }
    hass.host->log("hass: set_pages count=%u page0_rows=%u visible=%u",
                  (unsigned int)hass.page_count,
                  (unsigned int)(hass.page_count ? hass_pages[0].row_count : 0U),
                  (unsigned int)hass.visible_rows);
    /* Every page of the payload: a dashboard that arrives split in two (or
     * with an unexpected image flag) then shows in the log instead of being
     * guessed from what the screen paints. Kept on purpose while the card
     * rendering is being tuned. */
    for (p = 0U; p < hass.page_count; p++) {
        hass.host->log("hass: page%u image=%u rows=%u title=\"%s\"",
                      (unsigned int)p,
                      (unsigned int)(hass_pages[p].image ? 1U : 0U),
                      (unsigned int)hass_pages[p].row_count,
                      hass_pages[p].title);
    }
    /* First icon ids of page 0, to tell a phone that sends no icon (ff) from
     * an unexpected id. */
    for (p = 0U; p < 4U && p < hass_pages[0].row_count; p++)
        hass.host->log("hass: row%u icon=%u",
                      (unsigned int)p, (unsigned int)hass_pages[0].rows[p].icon);
    refresh_page();
}

static bool hass_event(void *context, const gm_plugin_event_t *event)
{
    (void)context;
    if (event == 0) return false;

    if (event->type == GM_PLUGIN_EVENT_CONNECTION) {
        hass.host->log("hass: phone connected=%u",
                      (unsigned int)event->data.connection.connected);
        hass.connected = event->data.connection.connected;
        if (hass.connected && hass.page_count != 0U) refresh_page();
        return true;
    }

    if (event->type == GM_PLUGIN_EVENT_BT_MESSAGE) {
        if (event->data.bt.data == 0) return false;
        /* Card pictures arrive as raw tiles on a private channel: the plugin
         * assembles them into an LVGL image and paints it like any widget. */
        if (event->data.bt.channel == IMAGE_CHANNEL) {
            draw_tile(event->data.bt.data, event->data.bt.length);
            return true;
        }
        if (event->data.bt.channel == IMAGE_LZ4_CHANNEL) {
            draw_lz4_tile(event->data.bt.data, event->data.bt.length);
            return true;
        }
        /* Debug navigation from the phone (see EVENT_NAV): the wearer cannot
         * turn their head to change page while gestures are off. */
        if (event->data.bt.channel == EVENT_CHANNEL) {
            uint8_t command;
            if (event->data.bt.length < 1U) return true;
            command = event->data.bt.data[event->data.bt.length - 1U];
            if (hass.page_count == 0U) return true;
            /* A message carrying a plugin event (our own page-changed echo, or
             * an event the phone sent us) must not be read as a nav command:
             * its last byte is a page index or a delta, not a command. Every
             * nav payload is [version, EVENT_NAV, command], so the second byte
             * is the discriminator. */
            if (event->data.bt.length > 1U &&
                event->data.bt.data[1] != EVENT_NAV) {
                hass.host->log("hass: event on channel ignored len=%u type=%u",
                              (unsigned int)event->data.bt.length,
                              (unsigned int)event->data.bt.data[1]);
                return true;
            }
            hass.host->log("hass: nav command=%u page=%u sel=%u",
                          (unsigned int)command, (unsigned int)hass.page_index,
                          (unsigned int)hass.selected);
            switch (command) {
            case NAV_PAGE_PREV:
                change_page(-1);
                break;
            case NAV_PAGE_NEXT:
                change_page(1);
                break;
            case NAV_ROW_UP:
                /* A picture page pans; a text page moves the cursor. Same split
                 * the head gestures used to make. Pictures are panned through
                 * NAV_FOCUS_*: the arrows follow the head (entity ring). */
                if (hass_pages[hass.page_index].image) request_card_focus(-1);
                else move_selection(-1);
                break;
            case NAV_ROW_DOWN:
                if (hass_pages[hass.page_index].image) request_card_focus(1);
                else move_selection(1);
                break;
            case NAV_FOCUS_UP:
            case NAV_FOCUS_DOWN: {
                /* Phone arrows: step the ring on a picture, move the row
                 * cursor on a text page. Never a focus request for a page with
                 * no picture: it could not be honoured. */
                int8_t step = command == NAV_FOCUS_UP ? -1 : 1;
                if (hass_pages[hass.page_index].image) request_card_focus(step);
                else move_selection(step);
                break;
            }
            case NAV_ACTIVATE:
                run_action();
                break;
            default:
                return true;
            }
            send_page_changed();
            return true;
        }
        if (event->data.bt.channel != PAGES_CHANNEL) return true;
        if (event->data.bt.length == 3U &&
            event->data.bt.data[0] == PROTOCOL_VERSION &&
            event->data.bt.data[1] == COMMAND_NOTIFY_CARD) {
            /* Label of a card picture: it only says which page the next tiles
             * belong to. The tiles carry the page themselves, so nothing is
             * drawn here; the label just arms the page on screen. */
            return true;
        }
        handle_set_pages(event->data.bt.data, event->data.bt.length);
        return true;
    }

    if (hass.page_count == 0U) return false;

    if (event->type == GM_PLUGIN_EVENT_BUTTON &&
        event->data.button.button == GM_PLUGIN_BUTTON_PRIMARY) {
        /* 1.0.18: the button drives the entities. A single press steps to the
         * next actionable entity, a double press activates the one in focus.
         * On a card picture the entity ring lives on the phone (it holds the
         * entity list), so the glasses only report the step or the activate
         * and let the phone move the ring / fire the action. On a text page the
         * glasses own the rows: a single press moves the row cursor, a double
         * press runs the selected row's action. */
        if (event->data.button.action == GM_PLUGIN_BUTTON_ACTION_SINGLE) {
            if (hass_pages[hass.page_index].image) request_card_focus(1);
            else move_selection(1);
            send_page_changed();
            return true;
        }
        if (event->data.button.action == GM_PLUGIN_BUTTON_ACTION_DOUBLE) {
            if (hass_pages[hass.page_index].image) {
                request_card_activate();
                send_page_changed();
                return true;
            }
            run_action();
            return true;
        }
    }

    if (event->type == GM_PLUGIN_EVENT_IMU_GESTURE &&
        event->data.imu_gesture.active) {
        uint32_t now = hass.host->monotonic_ms();
        hass.host->log("hass: gesture=%u active=%u page=%u image=%u rows=%u visible=%u scroll=%u sel=%u",
                      (unsigned int)event->data.imu_gesture.gesture,
                      (unsigned int)event->data.imu_gesture.active,
                      (unsigned int)hass.page_index,
                      (unsigned int)(hass_pages[hass.page_index].image ? 1U : 0U),
                      (unsigned int)(hass.page_count ? hass_pages[hass.page_index].row_count : 0U),
                      (unsigned int)hass.visible_rows,
                      (unsigned int)hass.scroll_offset,
                      (unsigned int)hass.selected);
        /* Report the raw id before anything can drop it: the phone shows it,
         * which is the only way to see, on real glasses without logs, whether
         * up/down arrives as HEAD_RAISE/LOWER or is misclassified as LEFT/RIGHT
         * by the Host. */
        send_gesture_debug(event->data.imu_gesture.gesture, event->data.imu_gesture.active);
        /* The generic cooldown that used to run here applied to *every* gesture
         * before the switch, so a head step inside a previous gesture's window
         * was silently swallowed. Each case now owns its own guard: LEFT/RIGHT
         * use the page cooldown below, a nod uses none. */
        switch (event->data.imu_gesture.gesture) {
        case GM_PLUGIN_IMU_GESTURE_RIGHT:
        case GM_PLUGIN_IMU_GESTURE_LEFT: {
            /* A page change that follows another one too closely is the head
             * settling after a tilt, not a second deliberate turn: drop it so
             * a freshly shown card is not skipped.
             *
             * 1.0.25: the window is armed ONLY on an accepted turn. Earlier
             * builds also armed it on a rejected gesture, which made every
             * wobble push the deadline forward -- under continuous head motion
             * no turn could ever pass (Dynag: "plus du tout les mouvements").
             * A rejected gesture now leaves the timers untouched, so the next
             * real turn is measured against the last *accepted* one. The
             * window is still armed even when change_page() finds nothing to
             * do (single-page dashboard), so a refused turn is not retried on
             * every jitter. */
            if (hass.last_page_gesture_ms != 0U &&
                (uint32_t)(now - hass.last_page_gesture_ms) < PAGE_GESTURE_COOLDOWN_MS) {
                hass.host->log("hass: navigation gesture ignored (page cooldown %u ms)",
                              (unsigned int)(now - hass.last_page_gesture_ms));
                return true;
            }
            change_page(event->data.imu_gesture.gesture == GM_PLUGIN_IMU_GESTURE_RIGHT ? 1 : -1);
            /* change_page() already told the phone. */
            hass.last_page_gesture_ms = now ? now : 1U;
            return true;
        }
        case GM_PLUGIN_IMU_GESTURE_HEAD_RAISE:
        case GM_PLUGIN_IMU_GESTURE_HEAD_RAISE_TIMEOUT:
        case GM_PLUGIN_IMU_GESTURE_HEAD_LOWER:
        case GM_PLUGIN_IMU_GESTURE_HEAD_LOWER_TIMEOUT:
            /* 1.0.18: head up/down no longer navigates. Entity stepping and
             * activation are the button's job now (single = next, double =
             * activate). These ids are ignored so a stray head tilt cannot
             * change page or move the ring. */
            hass.host->log("hass: head up/down gesture %u ignored (button drives entities)",
                          (unsigned int)event->data.imu_gesture.gesture);
            return true;
        case GM_PLUGIN_IMU_GESTURE_NOD:
            /* A plain nod refreshes the picture on screen; the button does the
             * same, so a card can be reloaded without a dashboard sync. */
            if (!hass_pages[hass.page_index].image) return false;
            request_card_image();
            refresh_page();
            break;
        default:
            return false;
        }
        /* A nod only refreshes the picture. */
        return true;
    }
    return false;
}

static void hass_stop(void *context)
{
    gm_plugin_lvgl_obj_t *root;
    uint32_t row;
    (void)context;
    root = hass.ui->root_get();
    (void)hass.host->imu_enable(GM_PLUGIN_IMU_ENABLE_NONE);
    if (root != 0) hass.ui->obj_clean(root);
    destroy_picture();
    hass.image_page = NO_PAGE;
    hass.picture_title[0] = '\0';
    hass.band_panel = 0;
    hass.band_label = 0;
    hass.screen = 0;
    for (row = 0U; row < MAX_VISIBLE_ROWS; row++) {
        hass.row_bg[row] = 0;
        hass.row_icon[row] = 0;
        hass.row_label[row] = 0;
        hass.row_value[row] = 0;
    }
    hass.hint_label = 0;
    hass.page_count = 0U;
    hass.page_index = 0U;
    hass.scroll_offset = 0U;
    hass.selected = 0U;
    hass.visible_rows = 0U;
}

gm_plugin_result_t gm_plugin_entry(const gm_plugin_host_api_t *host,
                                    gm_plugin_descriptor_t *plugin)
{
    const gm_plugin_capabilities_t required =
        GM_PLUGIN_CAP_BLUETOOTH | GM_PLUGIN_CAP_BUTTON | GM_PLUGIN_CAP_IMU_EVENTS;

    if (host == 0 || plugin == 0 || host->log == 0 || host->bt_send == 0 ||
        host->display_get_info == 0 || host->graphics.lvgl == 0 ||
        host->imu_enable == 0 ||
        !GM_PLUGIN_VERSION_COMPATIBLE(host->abi_version,
                                      GM_PLUGIN_ABI_MIN_VERSION) ||
        host->struct_size < GM_PLUGIN_HOST_API_MIN_SIZE ||
        plugin->struct_size < GM_PLUGIN_DESCRIPTOR_MIN_SIZE ||
        (host->capabilities & required) != required)
        return GM_PLUGIN_ENOTSUP;

    hass.host = host;
    hass.ui = host->graphics.lvgl;
    hass.images_ok = hass.ui->struct_size >= GM_PLUGIN_LVGL_API_1_1_SIZE &&
        GM_PLUGIN_VERSION_COMPATIBLE(hass.ui->api_version,
                                     GM_PLUGIN_VERSION(1U, 1U)) &&
        hass.ui->image_create != 0 && hass.ui->image_set_source != 0;
    if (gm_plugin_libc_get(host, &hass.libc) != GM_PLUGIN_OK)
        return GM_PLUGIN_ENOTSUP;
    plugin->abi_version = GM_PLUGIN_ABI_MIN_VERSION;
    plugin->context = &hass;
    plugin->on_start = hass_start;
    plugin->on_event = hass_event;
    plugin->on_stop = hass_stop;
    return GM_PLUGIN_OK;
}
