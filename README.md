# MemoMind HASS

Paire MemoMind **téléphone + lunettes** pour afficher sur les lunettes les
**dashboards composés dans Home Assistant** (Lovelace).

Cette version repart de zéro : elle ne réutilise plus l’ancienne app Home Assistant 1.0.1 (retirée du paquet). Elle a son **propre firmware lunettes**
(`hass.gmp`, id `com.dynag.hass.glass`) et son **propre protocole**
(`gm.hass` 1.0), sur des canaux distincts :

| usage | canal | sens |
|---|---|---|
| pages | `0x4A50` ('JP') | téléphone → lunettes |
| événements | `0x4A51` ('JQ') | lunettes → téléphone |
| tuiles GRAY_4 brutes | `0x4A52` ('JR') | téléphone → lunettes |
| tuiles GRAY_4 LZ4 | `0x4A54` ('JT') | téléphone → lunettes |

L'app téléphone (`com.dynag.hass2.phone`) et l'ancienne app HASS 1.0.1
(`com.dynag.hass.phone`, liée au plugin v95) peuvent coexister : identifiants,
stockage de configuration et plugin lunettes sont distincts.

## Architecture

```
Home Assistant (REST /api + websocket /api/websocket)
        ^
        |  Bearer <Long-Lived Token> + websocket
        |  lovelace/dashboards/list puis lovelace/config
        |
   Téléphone : app hass2 (gm-plugin-web)
        |
        |  gm.hass 1.0 (0x4A50/0x4A51/0x4A52/0x4A54)
        v
   Lunettes : plugin com.dynag.hass.glass (v15, hass.gmp)
```

Chaque carte Lovelace de premier niveau d'une vue devient une page image : le
téléphone lit la config via le websocket de HA, convertit les cartes en pages
(titre, lignes, action) puis rend chaque carte en GRAY_4, découpée en tuiles
LZ4 poussées aux lunettes. Les lunettes n'accèdent jamais au réseau.

Les dashboards en mode *strategy* (ex. « Aperçu »/`lovelace`, config sans
`views`) sont signalés comme non pris en charge plutôt que rendus vides.

## Contenu

```
phone/hass2/                  sources de l'app téléphone (11 fichiers + vendor)
builds/hass-1.0.29.mmpkg      paquet téléphone (minPluginVersion "15", gm.hass 1.0)
builds/hass.mmpkg             alias du même paquet
builds/hass.gmp               firmware lunettes (v15, abi 256, 23 152 o)
```

## Construction

Téléphone, depuis un dossier source **propre** (exactement les 11 fichiers
livrés — pas de `ha_icons.h`, pas de `plugin-host-shim.js`) :

```bash
node <PhoneSDK>/tools/build-mmpkg.mjs phone/hass2 builds/hass-1.0.29.mmpkg
```

Lunettes, depuis `GlassSDK/` :

```bash
export PYTHONPATH=<tooling>/pylib
export PATH=<tooling>/pylib/cmake/data/bin:<tooling>/pylib/bin:$PATH
python3 build.py build --example hass
# -> build-host/.build/hass/hass.gmp (+ hass.review.json, hass.review-source.enc)
```

Le builder officiel (`PhoneSDK/tools/build-mmpkg.mjs`) recalcule le bloc
`files` (sha256) et signe le paquet ; ne pas le remplacer par une archive
manuelle.

## Différences avec `memomind-hass` (HASS 1.0.1)

| | hass 1.0.1 (retiré) | hass2 1.0.1 (ce dépôt) |
|---|---|---|
| id téléphone | `com.dynag.hass.phone` | `com.dynag.hass2.phone` |
| plugin lunettes | `com.dynag.homeassistant.glass` v95 | `com.dynag.hass.glass` v1 |
| protocole | `gm.homeassistant` 2.2 | `gm.hass` 1.0 |
| canaux | `0x4841/0x4852/0x4853/0x4854` | `0x4A50/0x4A51/0x4A52/0x4A54` |
| lecture HA | websocket Lovelace | websocket Lovelace (inchangée) |

Le moteur de cartes (`cardrender.js`) et le client Lovelace (`ha.js`) sont
communs avec HASS 1.0.1 ; toute correction s'y reporte dans les deux dépôts.
