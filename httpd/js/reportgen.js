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

export const load_complete = 1;
