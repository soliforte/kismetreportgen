**Usage**

cd into this directory and type:
sudo make install

Start kismet.

In browser, navigate to http://localhost:2501/plugin/reportgen/

The trailing '/' is very important.

This tool generates a report for a specific SSID. Enter and SSID, press the "add" button, and then select "run report".

The tool will then query kismet and build a sortable table that groups clients based on: SSID > BSSID.

This data is exportable as PDF and CSV.

You can run multiple SSID's at a time, but be warned it may take awhile if the network(s) have a lot of clients.
