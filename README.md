# Kismet Wi-Fi report generator plugin

A web-only [Kismet](https://www.kismetwireless.net/) plugin that builds a
report for one or more SSIDs: every access point (BSSID) advertising the SSID
and every client Kismet has seen associated with each of those access points.

The report is shown as a sortable table grouped by SSID > BSSID and can be
downloaded as CSV or PDF.

## Requirements

* A current Kismet release (tested with 2025.09).  The plugin uses the
  device views, field simplification and regex filtering of the current REST
  API, and the ES-module plugin loader of the current web UI, so it will not
  work with the 2018/2019-era Kismet the original version targeted.
* A modern browser (the same requirement as the Kismet web UI itself).

## Installation

System-wide (Kismet installed from packages or `make install`):

```bash
sudo make install
```

Per-user, into `~/.kismet/plugins/` (no root needed; use this for a Kismet
that runs as your user):

```bash
make userinstall
```

Restart Kismet afterwards.  `make uninstall` / `make useruninstall` remove the
plugin again.

If Kismet's `pkg-config` file is not on your system the Makefile falls back to
`/usr/local/lib/kismet`; override with `make install plugindir=/path/to/plugins`.

## Usage

Log in to the Kismet web UI as usual, then either:

* pick **Wi-Fi Report** from the Kismet sidebar menu, or
* open `http://localhost:2501/plugin/reportgen/` directly (the trailing `/`
  matters).

The report page uses the login session of the Kismet UI, so log in there
first if it reports that you are not logged in.

1. Type an SSID, or pick one from the drop-down of SSIDs Kismet has seen
   advertised, and press **Add**.  Repeat for as many SSIDs as you like.
2. Press **Run Report**.
3. Use **Download CSV** / **Download PDF** to export the table.

SSIDs can also be pre-filled through the URL, e.g.
`/plugin/reportgen/?ssid=MyNetwork&ssid=GuestNetwork`.

### Related networks

With **Include related networks** ticked (the default), the report also
pulls in networks that belong to the same installation as the SSIDs you
asked for, using two signals and repeating until nothing new turns up:

* **Same radio** - virtual access points broadcast from one radio share its
  BSS timestamp clock, so their "clock start" (beacon time minus BSS
  timestamp) matches to within Kismet's `dot11_related_bss_window` (10 s).
  This links e.g. a corporate SSID with the guest SSID on the same access
  point, including hidden SSIDs, which are reported as `(hidden SSID)`.
* **Shared clients** - a client (or a wired device seen behind the access
  point) that has associated with access points in two networks links them.
  This is what ties together different physical access points of one site.

The **Found via** column says why each access point is in the report.
Untick the box for a strict report: shared hotspot radios (for example
`xfinitywifi`) sit on every neighbour's gateway, so with the box ticked a
report for such an SSID legitimately includes all of those private networks.

Reports for networks with many access points and clients can take a little
while; the status line shows progress.

## How it works

1. `POST /devices/views/phydot11_accesspoints/devices.json` with a regex on
   `dot11.device.advertised_ssid_map` to find the access points advertising
   the selected SSIDs, requesting only the fields the report needs.
2. `POST /phy/phy80211/clients-of/[KEY]/clients.json` for each access point
   (a few at a time) to fetch its associated clients, including each
   client's `dot11.device.client_map` of BSSIDs it has used.
3. With related networks enabled, one more `phydot11_accesspoints` query
   for a light index of every access point (key, MAC, SSID, BSS timestamp)
   to group them by radio, then `POST /devices/multikey/as-object/devices.json`
   for the full records of any related access points found.
4. `POST /phy/phy80211/ssids/views/ssids.json` to populate the SSID
   drop-down (falls back to the access point view if the SSID tracker is
   disabled).

## Layout

* `manifest.conf` - Kismet plugin manifest; registers `httpd/js/reportgen.js`
  as a web UI module.
* `httpd/js/reportgen.js` - loaded by the main Kismet UI; adds the sidebar
  entry.
* `httpd/index.html`, `httpd/js/reportgen.page.js`, `httpd/css/reportgen.css`
  - the report page.  It uses Kismet's bundled Tabulator library and follows
  the light/dark theme chosen in the Kismet UI.
* `httpd/js/jspdf.umd.min.js`, `httpd/js/jspdf.plugin.autotable.min.js` -
  bundled jsPDF 4.2.1 and jsPDF-AutoTable 5.0.8 (both MIT) for PDF export.

## Development

Point Kismet at a checkout with `make userinstall` and reload the page after
editing; there is no build step.
