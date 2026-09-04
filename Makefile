# Kismet "reportgen" web-only plugin.
#
# There is no code to compile; installing copies manifest.conf and the httpd/
# directory into the Kismet plugin directory.

# Our plugin directory name when we install.  This must match the path used in
# manifest.conf (plugin/reportgen/...).
PLUGIN_NAME ?= reportgen

# Look for the kismet source in /usr/src/kismet by default
KIS_SRC_DIR ?= /usr/src/kismet
KIS_INC_DIR ?= $(KIS_SRC_DIR)

# Try to include the base config from a Kismet source tree, if present
-include $(KIS_SRC_DIR)/Makefile.inc

INSTALL ?= install

# Only force file ownership when Kismet's Makefile.inc (or the caller) says
# who should own the files; plain "make install" as a normal user into a
# user-writable plugin directory (e.g. Homebrew) then just works.
ifneq ("$(INSTUSR)", "")
INSTOWN = -o $(INSTUSR) -g $(INSTGRP)
endif

# Without a source tree, ask pkg-config where an installed Kismet keeps plugins
plugindir ?= $(shell pkg-config --variable=plugindir kismet 2>/dev/null)
ifeq ("$(plugindir)", "")
	plugindir := /usr/local/lib/kismet
	plugindirgeneric := 1
endif

SYSDIR  = $(DESTDIR)$(plugindir)/$(PLUGIN_NAME)
USERDIR = $(HOME)/.kismet/plugins/$(PLUGIN_NAME)

.PHONY: all install userinstall uninstall useruninstall clean

all:	manifest.conf

# System-wide install (usually needs root)
install:
ifeq ("$(plugindirgeneric)", "1")
	@echo "No kismet install found in pkgconfig, assuming $(plugindir)"
endif
	mkdir -p $(SYSDIR)
	$(INSTALL) $(INSTOWN) -m 444 manifest.conf $(SYSDIR)/manifest.conf
	mkdir -p $(SYSDIR)/httpd
	cp -r httpd/* $(SYSDIR)/httpd
	chmod -R a+rX $(SYSDIR)/httpd

# Per-user install into ~/.kismet/plugins/ (no root required)
userinstall:
	@echo "Installing to this user's home directory ($(HOME))"
	mkdir -p $(USERDIR)
	$(INSTALL) -m 444 manifest.conf $(USERDIR)/manifest.conf
	mkdir -p $(USERDIR)/httpd
	cp -r httpd/* $(USERDIR)/httpd

uninstall:
	rm -rf $(SYSDIR)

useruninstall:
	rm -rf $(USERDIR)

clean:
	@echo "Nothing to clean"
