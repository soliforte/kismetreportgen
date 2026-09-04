// Kismet "reportgen" plugin - report page logic.
//
// Served at /plugin/reportgen/ by the Kismet web server.  Talks to the Kismet
// REST API (relative to the page, so it works behind a reverse proxy prefix)
// and renders a grouped SSID > BSSID > client table with CSV / PDF export.
//
// Kismet REST references:
//   /devices/views/phydot11_accesspoints/devices.json  (POST: fields, regex)
//   /phy/phy80211/clients-of/[KEY]/clients.json        (POST: fields)
//   /phy/phy80211/ssids/views/ssids.json               (POST: fields)
//   /session/check_session

"use strict";

(function () {
    // The page is homed at /plugin/reportgen/, so Kismet's API is two levels up.
    const KISMET = "../../";

    // How many clients-of requests to keep in flight at once.
    const CLIENT_FETCH_CONCURRENCY = 4;

    // Related-network discovery: how many expansion rounds to run at most,
    // and how close (microseconds) two access points' BSS clocks must be to
    // count as the same radio.  10 s matches Kismet's own
    // dot11_related_bss_window default.
    const MAX_RELATED_HOPS = 4;
    const BSS_CLOCK_WINDOW_USEC = 10 * 1000 * 1000;

    const HIDDEN_SSID_LABEL = "(hidden SSID)";
    const VIA_REQUESTED = "Requested";

    // Field simplification: [path, alias].  Aliases become the keys in the
    // returned objects.  Unknown / missing fields come back as the integer 0.
    const COMMON_FIELDS = [
        ["kismet.device.base.key", "key"],
        ["kismet.device.base.macaddr", "mac"],
        ["kismet.device.base.commonname", "name"],
        ["kismet.device.base.type", "type"],
        ["kismet.device.base.manuf", "manuf"],
        ["kismet.device.base.crypt", "crypt"],
        ["kismet.device.base.channel", "channel"],
        ["kismet.device.base.frequency", "frequency"],
        ["kismet.device.base.signal/kismet.common.signal.last_signal", "signal"],
        ["kismet.device.base.first_time", "first_time"],
        ["kismet.device.base.last_time", "last_time"],
    ];

    // The advertised SSID map and the last-beaconed SSID record share the
    // same underlying objects in Kismet, so aliasing the nested SSID field
    // would rename it inside the map too.  Request both unaliased; they come
    // back under their final path names (see LAST_SSID_KEY / SSID_MAP_KEY).
    const AP_FIELDS = COMMON_FIELDS.concat([
        ["dot11.device/dot11.device.num_associated_clients", "num_clients"],
        "dot11.device/dot11.device.advertised_ssid_map",
        "dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid",
    ]);

    const SSID_MAP_KEY = "dot11.device.advertised_ssid_map";
    const SSID_KEY = "dot11.advertisedssid.ssid";

    const CLIENT_FIELDS = COMMON_FIELDS.concat([
        ["dot11.device/dot11.device.last_bssid", "last_bssid"],
        // Every BSSID this client has associated with, with per-association
        // DHCP / IP / EAP details; also used to link access points that
        // share clients.
        "dot11.device/dot11.device.client_map",
        // SSIDs this client has probed for.
        "dot11.device/dot11.device.probed_ssid_map",
    ]);

    // Lightweight record for every access point Kismet knows, used to find
    // related networks without pulling full device records.
    const AP_INDEX_FIELDS = [
        ["kismet.device.base.key", "key"],
        ["kismet.device.base.macaddr", "mac"],
        "dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid",
        ["dot11.device/dot11.device.bss_timestamp", "bss_timestamp"],
        ["dot11.device/dot11.device.last_beacon_timestamp", "last_beacon_time"],
    ];

    const CLIENT_MAP_KEY = "dot11.device.client_map";
    const CLIENT_BSSID_KEY = "dot11.client.bssid_key";
    const PROBED_MAP_KEY = "dot11.device.probed_ssid_map";

    // Time window choices (seconds; 0 = no limit), matching #time-window.
    const TIME_WINDOWS = {
        "0": "any time",
        "900": "the last 15 minutes",
        "3600": "the last hour",
        "21600": "the last 6 hours",
        "86400": "the last 24 hours",
    };

    const ADVERTISED_SSID_PATH =
        "dot11.device/dot11.device.advertised_ssid_map/dot11.advertisedssid.ssid";

    // ---------------------------------------------------------------- state

    // SSIDs the user has queued for the report (ordered, unique).
    let ssids = [];
    let running = false;
    let table = null;

    const $ = (sel) => document.querySelector(sel);

    // ------------------------------------------------------------- helpers

    class AuthError extends Error {
        constructor() {
            super("Not logged in to Kismet");
            this.name = "AuthError";
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

    // Escape a literal string for use inside a PCRE regex.
    function escapeRegex(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
    }

    function isObject(v) {
        return v !== null && typeof v === "object";
    }

    function formatTime(t) {
        if (!t) return "";
        return new Date(t * 1000).toLocaleString();
    }

    function isoTime(t) {
        if (!t) return "";
        return new Date(t * 1000).toISOString();
    }

    function formatSignal(v) {
        // Kismet reports 0 when it has no signal data.
        if (!v) return "";
        return `${v} dBm`;
    }

    function formatFrequency(khz) {
        if (!khz) return "";
        return `${Math.round(khz / 1000)} MHz`;
    }

    function setStatus(msg, kind) {
        const el = $("#status");
        el.textContent = msg;
        el.className = kind || "";
    }

    // Kismet commands are sent as a form-encoded `json=` dictionary.
    async function kismetPost(path, cmd) {
        const resp = await fetch(KISMET + path, {
            method: "POST",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
            },
            body: "json=" + encodeURIComponent(JSON.stringify(cmd)),
        });

        if (resp.status === 401)
            throw new AuthError();

        if (!resp.ok) {
            const text = (await resp.text()).trim();
            throw new Error(`${path}: HTTP ${resp.status}${text ? " - " + text : ""}`);
        }

        return resp.json();
    }

    // Run fn over items with at most `limit` concurrent invocations.
    async function mapLimit(items, limit, fn) {
        const results = new Array(items.length);
        let next = 0;

        async function worker() {
            while (next < items.length) {
                const i = next++;
                results[i] = await fn(items[i], i);
            }
        }

        const workers = [];
        for (let i = 0; i < Math.min(limit, items.length); i++)
            workers.push(worker());

        await Promise.all(workers);
        return results;
    }

    function includeRelated() {
        return $("#include-related").checked;
    }

    // Selected time window in seconds; 0 means no limit.
    function timeWindow() {
        const v = Number($("#time-window").value);
        return Number.isFinite(v) && v > 0 ? v : 0;
    }

    function timeWindowLabel() {
        return TIME_WINDOWS[String(timeWindow())] || "any time";
    }

    // Settings are remembered in the browser through Kismet's storage helper.
    function rememberSetting(key, value) {
        try {
            if (typeof Storages !== "undefined")
                Storages.localStorage.set(key, value);
        } catch (e) {
            // Storage unavailable - not persisted.
        }
    }

    function recallSetting(key, fallback) {
        try {
            if (typeof Storages !== "undefined" && Storages.localStorage.isSet(key))
                return Storages.localStorage.get(key);
        } catch (e) {
            // Keep the default.
        }
        return fallback;
    }

    function restoreSettings() {
        $("#include-related").checked = Boolean(recallSetting("reportgen.include_related", true));

        const win = String(recallSetting("reportgen.time_window", "0"));
        if (win in TIME_WINDOWS)
            $("#time-window").value = win;
    }

    // ------------------------------------------------------------- session

    async function checkSession() {
        const resp = await fetch(KISMET + "session/check_session", {
            credentials: "same-origin",
        });

        if (resp.status === 401)
            throw new AuthError();
    }

    function showLoginNotice() {
        const notice = $("#login-notice");
        notice.hidden = false;
        setStatus("Not logged in.", "error");
    }

    // ----------------------------------------------------------- SSID list

    function renderSsidChips() {
        const area = $("#ssid-chips");
        area.innerHTML = "";

        if (ssids.length === 0) {
            const hint = document.createElement("span");
            hint.className = "hint";
            hint.textContent = "No SSIDs selected.";
            area.appendChild(hint);
        }

        ssids.forEach((ssid, index) => {
            const chip = document.createElement("span");
            chip.className = "chip";

            const label = document.createElement("span");
            label.textContent = ssid;
            chip.appendChild(label);

            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "chip-remove";
            remove.title = `Remove ${ssid}`;
            remove.setAttribute("aria-label", `Remove ${ssid}`);
            remove.textContent = "×";
            remove.addEventListener("click", () => {
                ssids.splice(index, 1);
                renderSsidChips();
            });
            chip.appendChild(remove);

            area.appendChild(chip);
        });

        $("#run-report").disabled = running || ssids.length === 0;
    }

    function addSsid(value) {
        const ssid = String(value);
        if (ssid.length === 0)
            return false;

        if (!ssids.includes(ssid))
            ssids.push(ssid);

        renderSsidChips();
        return true;
    }

    function addSsidFromInput() {
        const input = $("#ssid-input");
        if (addSsid(input.value))
            input.value = "";
        input.focus();
    }

    // Populate the <datalist> with SSIDs Kismet has seen advertised, so the
    // user can pick from a list instead of typing.  The SSID tracker may be
    // disabled in kismet.conf, so fall back to the access point view.
    async function loadKnownSsids() {
        let known = [];

        try {
            const groups = await kismetPost("phy/phy80211/ssids/views/ssids.json", {
                fields: [
                    ["dot11.ssidgroup.ssid", "ssid"],
                    ["dot11.ssidgroup.advertising_devices_len", "advertisers"],
                ],
            });

            if (Array.isArray(groups)) {
                known = groups
                    .filter((g) => typeof g.ssid === "string" && g.ssid.length > 0 && g.advertisers > 0)
                    .map((g) => g.ssid);
            }
        } catch (e) {
            if (e instanceof AuthError) throw e;
            console.warn("reportgen: SSID tracker unavailable, using access point view", e);
        }

        if (known.length === 0) {
            const aps = await kismetPost("devices/views/phydot11_accesspoints/devices.json", {
                fields: [["dot11.device/dot11.device.last_beaconed_ssid_record/dot11.advertisedssid.ssid", "ssid"]],
            });

            if (Array.isArray(aps))
                known = aps.map((d) => d.ssid).filter((s) => typeof s === "string" && s.length > 0);
        }

        known = Array.from(new Set(known)).sort((a, b) => a.localeCompare(b));

        const list = $("#ssid-list");
        list.innerHTML = "";
        for (const ssid of known) {
            const opt = document.createElement("option");
            opt.value = ssid;
            list.appendChild(opt);
        }

        $("#ssid-count").textContent =
            known.length === 1 ? "1 known SSID" : `${known.length} known SSIDs`;
    }

    // -------------------------------------------------------------- report

    // All SSIDs an access point record advertises.  Kismet serializes the
    // map as either an object or an array depending on version.
    function advertisedSsids(ap) {
        const out = [];
        const map = ap[SSID_MAP_KEY];
        if (isObject(map)) {
            for (const rec of Object.values(map)) {
                if (isObject(rec) && typeof rec[SSID_KEY] === "string")
                    out.push(rec[SSID_KEY]);
            }
        }
        return out;
    }

    // Pick the SSID this AP is reported under: the most recently beaconed one
    // if it was requested, otherwise the first requested SSID it advertises.
    function reportSsidFor(ap, wanted) {
        const last = typeof ap[SSID_KEY] === "string" ? ap[SSID_KEY] : "";

        if (wanted.has(last))
            return last;

        for (const ssid of advertisedSsids(ap)) {
            if (wanted.has(ssid))
                return ssid;
        }

        // Kismet matched the regex, so this should not happen; fall back to
        // whatever name Kismet gives the device rather than dropping it.
        return last || ap.name || "";
    }

    function deviceRow(dev, extra) {
        return Object.assign({
            key: dev.key,
            mac: dev.mac,
            // Kismet uses the MAC as the common name when it knows nothing
            // better; leave the name blank in that case.
            name: dev.name === dev.mac ? "" : dev.name,
            type: dev.type,
            manuf: dev.manuf,
            crypt: dev.crypt,
            channel: dev.channel,
            frequency: dev.frequency,
            signal: dev.signal,
            first_time: dev.first_time,
            last_time: dev.last_time,
        }, extra);
    }

    // Access point view, restricted server-side to the selected time window.
    function accessPointViewPath() {
        const win = timeWindow();
        return "devices/views/phydot11_accesspoints/" +
            (win > 0 ? `last-time/-${win}/` : "") + "devices.json";
    }

    // Kismet's clock, so client activity is judged against the server's
    // idea of "now" rather than the browser's.
    async function serverTime() {
        const resp = await fetch(KISMET + "system/timestamp.json", { credentials: "same-origin" });
        if (resp.status === 401)
            throw new AuthError();
        if (!resp.ok)
            return Math.floor(Date.now() / 1000);
        const data = await resp.json();
        const sec = Number(data["kismet.system.timestamp.sec"]);
        return sec > 0 ? sec : Math.floor(Date.now() / 1000);
    }

    async function fetchAccessPoints(wanted) {
        const alternatives = Array.from(wanted).map(escapeRegex).join("|");

        const aps = await kismetPost(accessPointViewPath(), {
            fields: AP_FIELDS,
            regex: [[ADVERTISED_SSID_PATH, `^(?:${alternatives})$`]],
        });

        return Array.isArray(aps) ? aps : [];
    }

    async function fetchClients(ap) {
        const clients = await kismetPost(
            `phy/phy80211/clients-of/${encodeURIComponent(ap.key)}/clients.json`,
            { fields: CLIENT_FIELDS });

        return Array.isArray(clients) ? clients : [];
    }

    // Full records for access points found through the related-network
    // search, keyed by device key.
    async function fetchAccessPointDetails(keys) {
        if (keys.length === 0)
            return {};

        const devs = await kismetPost("devices/multikey/as-object/devices.json", {
            devices: keys,
            fields: AP_FIELDS,
        });

        return isObject(devs) ? devs : {};
    }

    // Build an index of every access point Kismet knows, grouped by radio.
    //
    // Virtual access points broadcast from one radio share that radio's TSF
    // clock, so "clock start = beacon time - BSS timestamp" is (nearly) the
    // same for all of them.  Access points whose clock starts fall within
    // BSS_CLOCK_WINDOW_USEC of each other are treated as one radio.
    async function loadAccessPointIndex() {
        const list = await kismetPost(accessPointViewPath(), {
            fields: AP_INDEX_FIELDS,
        });

        const byKey = new Map();
        const timed = [];

        for (const ap of (Array.isArray(list) ? list : [])) {
            if (typeof ap.key !== "string")
                continue;

            byKey.set(ap.key, ap);

            const bssts = Number(ap.bss_timestamp);
            const beacon = Number(ap.last_beacon_time);
            if (bssts > 0 && beacon > 0)
                timed.push({ key: ap.key, start: beacon * 1e6 - bssts });
        }

        timed.sort((a, b) => a.start - b.start);

        // Walk the sorted clock starts and cut a new group wherever the gap
        // exceeds the window.
        const groupOf = new Map();
        const groups = [];
        let current = null;
        let previous = null;

        for (const t of timed) {
            if (current === null || t.start - previous.start > BSS_CLOCK_WINDOW_USEC) {
                current = [];
                groups.push(current);
            }
            current.push(t.key);
            groupOf.set(t.key, current);
            previous = t;
        }

        return {
            byKey: byKey,
            radioMates: (key) => (groupOf.get(key) || []).filter((k) => k !== key),
        };
    }

    // The client's association record for a given BSSID (Kismet keys the map
    // by BSSID, or serializes it as an array), or null.
    function associationRecord(client, bssid) {
        const cmap = client[CLIENT_MAP_KEY];
        if (!isObject(cmap))
            return null;

        if (!Array.isArray(cmap) && isObject(cmap[bssid]))
            return cmap[bssid];

        for (const rec of Object.values(cmap)) {
            if (isObject(rec) && rec["dot11.client.bssid"] === bssid)
                return rec;
        }
        return null;
    }

    function probedSsids(client) {
        const pmap = client[PROBED_MAP_KEY];
        if (!isObject(pmap))
            return [];

        const out = new Set();
        for (const rec of Object.values(pmap)) {
            const ssid = isObject(rec) ? rec["dot11.probedssid.ssid"] : undefined;
            if (typeof ssid === "string" && ssid.length > 0)
                out.add(ssid);
        }
        return Array.from(out).sort((a, b) => a.localeCompare(b));
    }

    // Hostname, IP address and EAP identity Kismet learned for this client on
    // this BSSID.  These only exist when Kismet saw decrypted traffic.
    function clientDetails(client, bssid) {
        const rec = associationRecord(client, bssid);
        const details = { hostname: "", ip: "", identity: "", dhcp_vendor: "" };

        if (rec === null)
            return details;

        if (typeof rec["dot11.client.dhcp_host"] === "string")
            details.hostname = rec["dot11.client.dhcp_host"];
        if (typeof rec["dot11.client.dhcp_vendor"] === "string")
            details.dhcp_vendor = rec["dot11.client.dhcp_vendor"];
        if (typeof rec["dot11.client.eap_identity"] === "string")
            details.identity = rec["dot11.client.eap_identity"];

        const ip = rec["dot11.client.ipdata"];
        if (isObject(ip)) {
            const addr = ip["kismet.common.ipdata.address"];
            if (typeof addr === "string" && addr !== "" && addr !== "0.0.0.0")
                details.ip = addr;
        }

        return details;
    }

    function apLabel(entry) {
        return `${entry.ssid} (${entry.mac})`;
    }

    async function runReport() {
        if (running || ssids.length === 0)
            return;

        running = true;
        setRunningUi(true);

        const wanted = new Set(ssids);
        const related = includeRelated();
        const win = timeWindow();

        try {
            setStatus("Querying access points…");
            // Clients seen before this are left out; APs are filtered by the
            // server through the last-time view.
            const cutoff = win > 0 ? (await serverTime()) - win : 0;
            const seed = await fetchAccessPoints(wanted);

            if (seed.length === 0) {
                table.setData([]);
                showRelatedInfo([]);
                setStatus(`No access points advertising the selected SSID(s) seen ${timeWindowLabel()}.`, "warn");
                return;
            }

            // Access points in the report, keyed by Kismet device key.
            const aps = new Map();

            for (const ap of seed) {
                aps.set(ap.key, {
                    key: ap.key,
                    mac: ap.mac,
                    ssid: reportSsidFor(ap, wanted),
                    via: VIA_REQUESTED,
                    dev: ap,
                    clients: [],
                });
            }

            const index = related ? await loadAccessPointIndex() : null;

            const addRelated = (key, via) => {
                const light = index.byKey.get(key);
                if (light === undefined || aps.has(key))
                    return false;

                const lastSsid = typeof light[SSID_KEY] === "string" ? light[SSID_KEY] : "";

                aps.set(key, {
                    key: key,
                    mac: light.mac,
                    ssid: lastSsid || HIDDEN_SSID_LABEL,
                    via: via,
                    dev: null,
                    clients: [],
                });
                return true;
            };

            // Fetch clients for each new access point; with related-network
            // discovery on, each round can reveal more access points (same
            // radio, or shared clients), which are then processed next round.
            let pending = Array.from(aps.keys());
            let hop = 0;

            while (pending.length > 0) {
                const batch = pending;
                pending = [];
                let done = 0;

                await mapLimit(batch, CLIENT_FETCH_CONCURRENCY, async (key) => {
                    const entry = aps.get(key);
                    try {
                        entry.clients = (await fetchClients(entry))
                            .filter((c) => cutoff === 0 || Number(c.last_time) >= cutoff);
                    } catch (e) {
                        if (e instanceof AuthError) throw e;
                        console.error(`reportgen: failed to fetch clients of ${entry.mac}`, e);
                    }
                    done += 1;
                    setStatus(`${aps.size} access point(s); fetching clients (${done}/${batch.length})` +
                        (hop > 0 ? ` - related round ${hop}` : "") + "…");
                });

                if (!related || hop >= MAX_RELATED_HOPS)
                    continue;

                for (const key of batch) {
                    const entry = aps.get(key);

                    for (const mate of index.radioMates(key)) {
                        if (addRelated(mate, `Same radio as ${apLabel(entry)}`))
                            pending.push(mate);
                    }

                    for (const client of entry.clients) {
                        const cmap = client[CLIENT_MAP_KEY];
                        if (!isObject(cmap))
                            continue;

                        for (const rec of Object.values(cmap)) {
                            const other = isObject(rec) ? rec[CLIENT_BSSID_KEY] : undefined;
                            if (typeof other === "string" &&
                                    addRelated(other, `Shared client ${client.mac} with ${apLabel(entry)}`))
                                pending.push(other);
                        }
                    }
                }

                hop += 1;
            }

            // Related access points were only indexed lightly; fetch their
            // full records for the table.
            const missing = Array.from(aps.values()).filter((e) => e.dev === null).map((e) => e.key);
            if (missing.length > 0) {
                setStatus(`Fetching details for ${missing.length} related access point(s)…`);
                const details = await fetchAccessPointDetails(missing);
                for (const key of missing) {
                    const entry = aps.get(key);
                    entry.dev = isObject(details[key]) ? details[key] : { key: key, mac: entry.mac };
                }
            }

            const rows = [];
            let clientTotal = 0;
            let relatedCount = 0;

            for (const entry of aps.values()) {
                if (entry.via !== VIA_REQUESTED)
                    relatedCount += 1;

                rows.push(deviceRow(entry.dev, {
                    ssid: entry.ssid,
                    bssid: entry.mac,
                    role: "AP",
                    clients: Number(entry.dev.num_clients) || 0,
                    via: entry.via,
                    hostname: "",
                    ip: "",
                    identity: "",
                    dhcp_vendor: "",
                    probed: "",
                }));

                for (const client of entry.clients) {
                    const details = clientDetails(client, entry.mac);
                    rows.push(deviceRow(client, {
                        ssid: entry.ssid,
                        bssid: entry.mac,
                        role: "Client",
                        clients: null,
                        via: "",
                        hostname: details.hostname,
                        ip: details.ip,
                        identity: details.identity,
                        dhcp_vendor: details.dhcp_vendor,
                        probed: probedSsids(client).join(", "),
                    }));
                }

                clientTotal += entry.clients.length;
            }

            table.setData(rows);
            showRelatedInfo(Array.from(aps.values()).filter((e) => e.via !== VIA_REQUESTED));

            const apSummary = relatedCount > 0
                ? `${aps.size} access point(s) (${aps.size - relatedCount} requested, ${relatedCount} related)`
                : `${aps.size} access point(s)`;
            setStatus(`Report complete: ${apSummary}, ${clientTotal} client(s) seen ${timeWindowLabel()}.`, "ok");
        } catch (e) {
            console.error("reportgen: report failed", e);
            if (e instanceof AuthError)
                showLoginNotice();
            else
                setStatus(`Report failed: ${e.message}`, "error");
        } finally {
            running = false;
            setRunningUi(false);
        }
    }

    // Summarize which extra networks the related-network search pulled in.
    function showRelatedInfo(relatedEntries) {
        const el = $("#related-info");

        if (relatedEntries.length === 0) {
            el.hidden = true;
            el.textContent = "";
            return;
        }

        const counts = new Map();
        for (const entry of relatedEntries)
            counts.set(entry.ssid, (counts.get(entry.ssid) || 0) + 1);

        const parts = Array.from(counts.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([ssid, n]) => `${ssid} (${n} BSSID${n === 1 ? "" : "s"})`);

        el.textContent = "Related networks included: " + parts.join(", ");
        el.hidden = false;
    }

    function setRunningUi(isRunning) {
        $("#run-report").disabled = isRunning || ssids.length === 0;
        $("#download-csv").disabled = isRunning;
        $("#download-pdf").disabled = isRunning;
        document.body.classList.toggle("busy", isRunning);
    }

    // --------------------------------------------------------------- table

    // Column definitions shared by the on-screen table and the exports.
    const COLUMNS = [
        { title: "SSID", field: "ssid", visible: false, download: true },
        { title: "BSSID", field: "bssid", visible: false, download: true },
        { title: "Role", field: "role", width: 80 },
        { title: "MAC", field: "mac", width: 150 },
        { title: "Name", field: "name", minWidth: 120 },
        { title: "Hostname", field: "hostname", minWidth: 110, tooltip: true },
        { title: "IP", field: "ip", width: 120 },
        { title: "Identity", field: "identity", minWidth: 110, tooltip: true },
        { title: "Manufacturer", field: "manuf", minWidth: 120 },
        { title: "Type", field: "type", minWidth: 100 },
        { title: "Encryption", field: "crypt", minWidth: 140 },
        { title: "Channel", field: "channel", hozAlign: "right", width: 90 },
        { title: "Frequency", field: "frequency", hozAlign: "right", width: 100,
            formatter: (cell) => formatFrequency(cell.getValue()),
            accessorDownload: (value) => (value ? Math.round(value / 1000) : "") },
        { title: "Signal", field: "signal", hozAlign: "right", width: 90,
            formatter: (cell) => formatSignal(cell.getValue()),
            accessorDownload: (value) => (value ? value : "") },
        { title: "Probed SSIDs", field: "probed", minWidth: 150, tooltip: true },
        { title: "Found via", field: "via", minWidth: 200 },
        { title: "DHCP vendor", field: "dhcp_vendor", visible: false, download: true },
        { title: "Clients", field: "clients", hozAlign: "right", width: 80,
            formatter: (cell) => (cell.getValue() === null ? "" : cell.getValue()),
            accessorDownload: (value) => (value === null ? "" : value) },
        { title: "First seen", field: "first_time", width: 170,
            formatter: (cell) => formatTime(cell.getValue()),
            accessorDownload: (value) => isoTime(value) },
        { title: "Last seen", field: "last_time", width: 170,
            formatter: (cell) => formatTime(cell.getValue()),
            accessorDownload: (value) => isoTime(value) },
    ];

    function buildTable() {
        table = new Tabulator("#report-table", {
            // Fill the container so large reports scroll inside the table
            // (virtual DOM) instead of growing the page.
            height: "100%",
            layout: "fitColumns",
            // Exports flatten the groups into plain rows (the SSID and BSSID
            // columns carry that information), so tell Tabulator not to warn.
            downloadConfig: { rowGroups: false },
            placeholder: "Add one or more SSIDs and run the report.",
            groupBy: ["ssid", "bssid"],
            groupStartOpen: true,
            groupHeader: [
                (value, count, data) => {
                    const requested = data.some((r) => r.role === "AP" && r.via === VIA_REQUESTED);
                    return `SSID: <strong>${escapeHtml(value)}</strong> ` +
                        `<span class="group-count">${count} device(s)${requested ? "" : ", related network"}</span>`;
                },
                (value, count) => `BSSID: ${escapeHtml(value)} <span class="group-count">${count} device(s)</span>`,
            ],
            // Tabulator treats the last sorter as the primary sort: AP rows
            // first within each BSSID group, then clients by MAC.
            initialSort: [
                { column: "mac", dir: "asc" },
                { column: "role", dir: "asc" },
            ],
            columns: COLUMNS,
        });
    }

    function reportFilename(ext) {
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        return `kismet-wifi-report-${stamp}.${ext}`;
    }

    function downloadCsv() {
        table.download("csv", reportFilename("csv"));
    }

    // Rows in the same order the table groups them, with values rendered as
    // strings for the PDF.
    function exportRows() {
        const rows = table.getData("active").slice();

        rows.sort((a, b) =>
            a.ssid.localeCompare(b.ssid) ||
            a.bssid.localeCompare(b.bssid) ||
            a.role.localeCompare(b.role) ||
            a.mac.localeCompare(b.mac));

        return rows.map((r) => ({
            ssid: r.ssid,
            bssid: r.bssid,
            role: r.role,
            mac: r.mac,
            name: r.name,
            manuf: r.manuf,
            type: r.type,
            crypt: r.crypt,
            channel: r.channel,
            frequency: formatFrequency(r.frequency),
            signal: formatSignal(r.signal),
            via: r.via,
            hostname: r.hostname,
            ip: r.ip,
            identity: r.identity,
            dhcp_vendor: r.dhcp_vendor,
            probed: r.probed,
            clients: r.clients === null ? "" : String(r.clients),
            first_time: formatTime(r.first_time),
            last_time: formatTime(r.last_time),
        }));
    }

    function downloadPdf() {
        // jsPDF 2+ exposes window.jspdf.jsPDF; jspdf-autotable adds
        // doc.autoTable() to it when both scripts are loaded.
        const JsPdf = window.jspdf && window.jspdf.jsPDF;
        if (typeof JsPdf !== "function" || typeof JsPdf.API.autoTable !== "function") {
            setStatus("PDF export unavailable: jsPDF / autoTable not loaded.", "error");
            return;
        }

        const rows = exportRows();
        if (rows.length === 0) {
            setStatus("Nothing to export yet - run a report first.", "warn");
            return;
        }

        const doc = new JsPdf({ orientation: "landscape", unit: "pt", format: "a4" });

        doc.setFontSize(14);
        doc.text("Kismet Wi-Fi report", 40, 40);
        doc.setFontSize(9);
        doc.text(`SSIDs: ${ssids.join(", ")}`, 40, 56);
        doc.text(`Generated: ${new Date().toLocaleString()}  |  Devices seen ${timeWindowLabel()}  |  ` +
            `Related networks ${includeRelated() ? "included" : "excluded"}`, 40, 68);

        const pdfColumns = COLUMNS.filter((c) => c.field !== "dhcp_vendor");

        doc.autoTable({
            head: [pdfColumns.map((c) => c.title)],
            body: rows.map((r) => pdfColumns.map((c) => r[c.field])),
            startY: 80,
            margin: { left: 40, right: 40 },
            styles: { fontSize: 7, overflow: "linebreak", cellPadding: 2 },
            headStyles: { fillColor: [60, 60, 60] },
        });

        doc.save(reportFilename("pdf"));
    }

    // ---------------------------------------------------------------- init

    function applyTheme() {
        // Follow the theme selected in the main Kismet UI (defaults to dark).
        let theme = "dark";
        try {
            if (typeof Storages !== "undefined" && Storages.localStorage.isSet("kismet.ui.theme"))
                theme = Storages.localStorage.get("kismet.ui.theme");
        } catch (e) {
            // Storage unavailable - keep the default.
        }

        if (theme !== "light")
            theme = "dark";

        document.documentElement.setAttribute("data-theme", theme);

        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = KISMET + (theme === "dark" ? "css/tabulator_midnight.min.css" : "css/tabulator.min.css");
        document.head.appendChild(link);
    }

    function prefillFromUrl() {
        const params = new URLSearchParams(window.location.search);
        for (const ssid of params.getAll("ssid"))
            addSsid(ssid);
    }

    async function init() {
        applyTheme();
        buildTable();

        $("#add-ssid").addEventListener("click", addSsidFromInput);
        $("#ssid-input").addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") {
                ev.preventDefault();
                addSsidFromInput();
            }
        });
        $("#run-report").addEventListener("click", runReport);
        $("#download-csv").addEventListener("click", downloadCsv);
        $("#download-pdf").addEventListener("click", downloadPdf);
        restoreSettings();
        $("#include-related").addEventListener("change", () =>
            rememberSetting("reportgen.include_related", includeRelated()));
        $("#time-window").addEventListener("change", () =>
            rememberSetting("reportgen.time_window", String(timeWindow())));
        $("#refresh-ssids").addEventListener("click", () => {
            loadKnownSsids().catch(handleInitError);
        });

        prefillFromUrl();
        renderSsidChips();

        try {
            await checkSession();
            setStatus("Loading known SSIDs…");
            await loadKnownSsids();
            setStatus("Ready.");
        } catch (e) {
            handleInitError(e);
        }
    }

    function handleInitError(e) {
        if (e instanceof AuthError) {
            console.warn("reportgen: no Kismet session, login required");
            showLoginNotice();
        } else {
            console.error("reportgen:", e);
            setStatus(`Could not load SSID list: ${e.message}`, "error");
        }
    }

    document.addEventListener("DOMContentLoaded", init);
})();
