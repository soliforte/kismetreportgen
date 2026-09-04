# Kismet Wi-Fi report generator plugin

A web-only [Kismet](https://www.kismetwireless.net/) plugin that builds a
report for one or more SSIDs: every access point (BSSID) advertising the SSID
and every client Kismet has seen associated with each of those access points.

The report is shown as a sortable table grouped by SSID > BSSID and can be
downloaded as CSV or PDF.

## Features

* **SSID picker** - a drop-down of every SSID Kismet has seen advertised, or
  type any SSID; several can be reported at once.
* **Related networks** - other SSIDs of the same installation are found
  automatically from access points that share a radio or share clients,
  including hidden SSIDs, with a **Found via** column explaining each one.
* **Time window** - restrict the report to devices seen in the last 15
  minutes, hour, 6 hours or 24 hours, judged by Kismet's clock.
* **Client details** - per client: name, manufacturer, type, encryption,
  channel, frequency, signal, first/last seen, plus DHCP hostname, IP
  address, EAP identity, probed SSIDs and DHCP vendor where Kismet has them.
* **Exports** - CSV (all columns, ISO timestamps) and a landscape PDF whose
  header records the SSIDs, time window and related-network setting.
* **Kismet integration** - a **Wi-Fi Report** entry in the sidebar menu and a
  **Wi-Fi Report** panel in every Wi-Fi access point's details window that
  opens a report for that access point's SSID; the page follows Kismet's
  light/dark theme and login session.
* **Settings are remembered** - the time window and related-network choice
  persist in the browser.

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

Notes:

* `make install` only forces root ownership of the files when Kismet's own
  `Makefile.inc` is available (`KIS_SRC_DIR`); into a user-writable plugin
  directory such as a Homebrew prefix it works without `sudo`.
* Kismet looks for per-user plugins in the home directory of the user it
  *runs as*.  If you start it with `sudo kismet`, that is root's home
  (`/var/root/.kismet/plugins/` on macOS), not yours, so use `make install`
  in that case.
* Kismet logs `Plugin 'reportgen' loaded...` at startup when the plugin is
  found, and `/plugin/reportgen/` returns 404 until it has been restarted.

## Usage

Log in to the Kismet web UI as usual, then either:

* pick **Wi-Fi Report** from the Kismet sidebar menu, or
* open `http://localhost:2501/plugin/reportgen/` directly (the trailing `/`
  matters).

The report page uses the login session of the Kismet UI, so log in there
first if it reports that you are not logged in.

1. Type an SSID, or pick one from the drop-down of SSIDs Kismet has seen
   advertised, and press **Add**.  Repeat for as many SSIDs as you like.
2. Optionally limit **Seen within** to devices active in the last 15 minutes,
   hour, 6 hours or 24 hours (judged by Kismet's clock), so a long-running
   Kismet does not report every client it has ever seen.
3. Press **Run Report**.
4. Use **Download CSV** / **Download PDF** to export the table.

The report also appears as a **Wi-Fi Report** panel in the device details
window of any Wi-Fi access point in the main Kismet UI, with a link that opens
a report for the SSID that access point beacons.

Client rows include what Kismet has learned about each client on that
BSSID: DHCP hostname, IP address and EAP identity (only present when Kismet
saw decrypted traffic, i.e. open networks or networks whose key it has), the
SSIDs the client has probed for, and the DHCP vendor string in the CSV.

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

### Good to know

* **Hostname / IP / Identity** are only known to Kismet when it decoded the
  client's traffic: open networks, or WPA networks whose key is configured
  in Kismet.  On encrypted networks those columns stay empty; **Probed
  SSIDs** and the rest are available regardless.
* **Time window** uses Kismet's clock (`/system/timestamp.json`), not the
  browser's, so it stays correct when the two disagree.
* **Background tabs** - browsers pause rendering in hidden tabs, so a report
  started in a background tab fills the table as soon as the tab is shown.
  The data is complete; the CSV and PDF exports do not depend on rendering.
* A client that roamed between several BSSIDs is listed under each of them;
  the **Found via** entry "Shared client" names such clients.

## How it works

1. `POST /devices/views/phydot11_accesspoints/devices.json` (or its
   `last-time/-N/` variant when a time window is set) with a regex on
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
  entry and the device-details panel.
* `httpd/index.html`, `httpd/js/reportgen.page.js`, `httpd/css/reportgen.css`
  - the report page.  It uses Kismet's bundled Tabulator library and follows
  the light/dark theme chosen in the Kismet UI.
* `httpd/js/jspdf.umd.min.js`, `httpd/js/jspdf.plugin.autotable.min.js` -
  bundled jsPDF 4.2.1 and jsPDF-AutoTable 5.0.8 (both MIT) for PDF export.

## Development

Point Kismet at a checkout with `make userinstall` and reload the page after
editing; there is no build step.
