// Kismet "reportgen" plugin - main UI module.
//
// Kismet loads plugin modules listed in manifest.conf with a dynamic
// `import()`, so this file must be a plain ES module.  It runs inside the
// main Kismet UI and only adds a sidebar entry that opens the report page.
//
// The report page itself lives in index.html / reportgen.page.js and does not
// depend on this file.

"use strict";

let local_uri_prefix = "";
if (typeof KISMET_URI_PREFIX !== "undefined")
    local_uri_prefix = KISMET_URI_PREFIX;


if (typeof kismet_ui_sidebar !== "undefined") {
    kismet_ui_sidebar.AddSidebarItem({
        id: "sidebar_reportgen",
        priority: 500,
        listTitle: '<i class="fa fa-file-text"></i> Wi-Fi Report',
        clickCallback: function () {
            window.open(`${local_uri_prefix}plugin/reportgen/`, "_blank");
        },
    });
} else {
    console.warn("reportgen: kismet_ui_sidebar not available, sidebar entry not added");
}

// "Wi-Fi Report" panel in the device details window of Wi-Fi access points,
// linking straight to a report for the SSID that AP beacons.
function beaconedSsid(data) {
    try {
        const ssid = data["dot11.device"]["dot11.device.last_beaconed_ssid_record"]["dot11.advertisedssid.ssid"];
        return typeof ssid === "string" ? ssid : "";
    } catch (e) {
        return "";
    }
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

if (typeof kismet_ui !== "undefined" && typeof kismet_ui.AddDeviceDetail === "function") {
    kismet_ui.AddDeviceDetail("reportgen", "Wi-Fi Report", 60, {
        filter: function (data) {
            return data["kismet.device.base.phyname"] === "IEEE802.11" && beaconedSsid(data) !== "";
        },
        draw: function (data, target) {
            const ssid = beaconedSsid(data);
            const url = `${local_uri_prefix}plugin/reportgen/?ssid=${encodeURIComponent(ssid)}`;

            target.html(
                '<div style="padding: 10px;">' +
                '<p>Build a report of every access point advertising <b>' + escapeHtml(ssid) + '</b>, ' +
                'their clients, and related networks (same radio or shared clients).</p>' +
                '<p><a class="reportgen-open" href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' +
                '<i class="fa fa-file-text"></i> Open Wi-Fi report for ' + escapeHtml(ssid) + '</a></p>' +
                '</div>');
        },
    });
}

export const load_complete = 1;
