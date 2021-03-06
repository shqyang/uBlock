/*******************************************************************************

    µBlock - a Chromium browser extension to block requests.
    Copyright (C) 2014 The µBlock authors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

/* global µBlock, SafariBrowserTab */
// For background page

/******************************************************************************/

(function() {

'use strict';

/******************************************************************************/

self.vAPI = self.vAPI || {};

vAPI.safari = true;

/******************************************************************************/

var xhr = new XMLHttpRequest;
xhr.overrideMimeType('application/x-javascript;charset=utf-8');
xhr.open('GET', 'Info.plist', false);
xhr.send();
xhr = xhr.responseText;

vAPI.app = {
    name: xhr.match(/DisplayName<\S+[^>]+>([^<]+)/)[1],
    version: xhr.match(/ShortVersionString<\S+[^>]+>([^<]+)/)[1]
};

/******************************************************************************/

vAPI.app.restart = function() {
};

/******************************************************************************/

// addContentScriptFromURL allows whitelisting,
// so load sitepaching this way, instead of adding it to the Info.plist

safari.extension.addContentScriptFromURL(
    safari.extension.baseURI + 'js/sitepatch-safari.js',
    [
        'http://www.youtube.com/*',
        'https://www.youtube.com/*',
        'http://www.youtube-nocookie.com/*',
        'https://www.youtube-nocookie.com/*'
    ]
);

/******************************************************************************/

safari.extension.settings.addEventListener('change', function(e) {
    if (e.key === 'open_prefs') {
        vAPI.tabs.open({url: 'dashboard.html', active: true});
    }
}, false);

/******************************************************************************/

vAPI.storage = {
    _storage: safari.extension.settings,
    QUOTA_BYTES: 52428800, // copied from Info.plist
    get: function(keys, callback) {
        if (typeof callback !== 'function') {
            return;
        }

        var i, value, result = {};

        if (keys === null) {
            for (i in this._storage) {
                value = this._storage[i];

                if (typeof value === 'string') {
                    result[i] = JSON.parse(value);
                }
            }
        }
        else if (typeof keys === 'string') {
            value = this._storage[keys];

            if (typeof value === 'string') {
                result[keys] = JSON.parse(value);
            }
        }
        else if (Array.isArray(keys)) {
            for ( i = 0; i < keys.length; ++i) {
                value = this._storage[i];

                if (typeof value === 'string') {
                    result[keys[i]] = JSON.parse(value);
                }
            }
        }
        else if (typeof keys === 'object') {
            for (i in keys) {
                value = this._storage[i];

                if (typeof value === 'string') {
                    result[i] = JSON.parse(value);
                }
                else {
                    result[i] = keys[i];
                }
            }
        }

        callback(result);
    },
    set: function(details, callback) {
        for (var key in details) {
            this._storage.setItem(key, JSON.stringify(details[key]));
        }

        if (typeof callback === 'function') {
            callback();
        }
    },
    remove: function(keys) {
        if (typeof keys === 'string') {
            keys = [keys];
        }

        for (var i = 0; i < keys.length; ++i) {
            this._storage.removeItem(keys[i]);
        }
    },
    clear: function(callback) {
        this._storage.clear();
        callback();
    },
    getBytesInUse: function(keys, callback) {
        if (typeof callback !== 'function') {
            return;
        }

        var key, size = 0;

        if (keys === null) {
            for (key in this._storage) {
                size += (this._storage[key] || '').length;
            }
        }
        else {
            if (typeof keys === 'string') {
                keys = [keys];
            }

            for (key = 0; key < keys.length; ++key) {
                size += (this._storage[keys[key]] || '').length;
            }
        }

        callback(size);
    }
};

/******************************************************************************/

vAPI.tabs = {
    stack: {},
    stackID: 1
};

/******************************************************************************/

vAPI.tabs.registerListeners = function() {
    var onNavigation = this.onNavigation;

    if (typeof onNavigation === 'function') {
        this.onNavigation = function(e) {
            // e.url is not present for local files or data URIs,
            // or probably for those URLs which we don't have access to
            if (!e.target || !e.target.url) {
                return;
            }

            onNavigation({
                frameId: 0,
                tabId: vAPI.tabs.getTabId(e.target),
                url: e.target.url
            });
        };

        safari.application.addEventListener('navigate', this.onNavigation, true);
    }

    // onClosed handled in the main tab-close event
    // onUpdated handled via monitoring the history.pushState on web-pages
    // onPopup is handled in window.open on web-pages
};

/******************************************************************************/

vAPI.tabs.getTabId = function(tab) {
    for (var i in vAPI.tabs.stack) {
        if (vAPI.tabs.stack[i] === tab) {
            return +i;
        }
    }

    return -1;
};

/******************************************************************************/

vAPI.tabs.get = function(tabId, callback) {
    var tab;

    if (tabId === null) {
        tab = safari.application.activeBrowserWindow.activeTab;
        tabId = this.getTabId(tab);
    }
    else {
        tab = this.stack[tabId];
    }

    if (!tab) {
        callback();
        return;
    }

    callback({
        id: tabId,
        index: tab.browserWindow.tabs.indexOf(tab),
        windowId: safari.application.browserWindows.indexOf(tab.browserWindow),
        active: tab === tab.browserWindow.activeTab,
        url: tab.url,
        title: tab.title
    });
};

/******************************************************************************/

// properties of the details object:
//   url: 'URL', // the address that will be opened
//   tabId: 1, // the tab is used if set, instead of creating a new one
//   index: -1, // undefined: end of the list, -1: following tab, or after index
//   active: false, // opens the tab in background - true and undefined: foreground
//   select: true // if a tab is already opened with that url, then select it instead of opening a new one

vAPI.tabs.open = function(details) {
    if (!details.url) {
        return null;
    }
    // extension pages
    if (!/^[\w-]{2,}:/.test(details.url)) {
        details.url = vAPI.getURL(details.url);
    }

    var curWin, tab;

    if (details.select) {
        tab = safari.application.browserWindows.some(function(win) {
            var rgxHash = /#.*/;
            // this is questionable
            var url = details.url.replace(rgxHash, '');

            for (var i = 0; i < win.tabs.length; ++i) {
                if (win.tabs[i].url.replace(rgxHash, '') === url) {
                    win.tabs[i].activate();
                    return true;
                }
            }
        });

        if (tab) {
            return;
        }
    }

    if (details.active === undefined) {
        details.active = true;
    }

    curWin = safari.application.activeBrowserWindow;

    // it must be calculated before opening a new tab,
    // otherwise the new tab will be the active tab here
    if (details.index === -1) {
        details.index = curWin.tabs.indexOf(curWin.activeTab) + 1;
    }

    tab = details.tabId && this.stack[details.tabId]
        || curWin.openTab(details.active ? 'foreground' : 'background');

    if (details.index !== undefined) {
        curWin.insertTab(tab, details.index);
    }

    tab.url = details.url;
};

/******************************************************************************/

vAPI.tabs.remove = function(tabIds) {
    if (tabIds instanceof SafariBrowserTab) {
        tabIds = this.getTabId(tabIds);
    }

    if (!Array.isArray(tabIds)) {
        tabIds = [tabIds];
    }

    for (var i = 0; i < tabIds.length; i++) {
        if (this.stack[tabIds[i]]) {
            this.stack[tabIds[i]].close();
        }
    }
};

/******************************************************************************/

vAPI.tabs.injectScript = function(tabId, details, callback) {
    var tab;

    if (tabId) {
        tab = this.stack[tabId];
    }
    else {
        tab = safari.application.activeBrowserWindow.activeTab;
    }

    if (details.file) {
        var xhr = new XMLHttpRequest;
        xhr.overrideMimeType('application/x-javascript;charset=utf-8');
        xhr.open('GET', details.file, false);
        xhr.send();
        details.code = xhr.responseText;
    }

    tab.page.dispatchMessage('broadcast', {
        portName: 'vAPI',
        msg: {
            cmd: 'runScript',
            details: details
        }
    });

    if (typeof callback === 'function') {
        setTimeout(callback, 13);
    }
};

/******************************************************************************/

// bind tabs to unique IDs

(function() {
    var wins = safari.application.browserWindows, i = wins.length, j;
    var tabs = [];

    while (i--) {
        j = wins[i].tabs.length;

        while (j--) {
            tabs.push(wins[i].tabs[j]);
        }
    }

    return tabs;
})().forEach(function(tab) {
    vAPI.tabs.stack[vAPI.tabs.stackID++] = tab;
});

/******************************************************************************/

safari.application.addEventListener('open', function(e) {
    // ignore windows
    if (e.target instanceof SafariBrowserTab) {
        vAPI.tabs.stack[vAPI.tabs.stackID++] = e.target;
    }
}, true);

/******************************************************************************/

safari.application.addEventListener('close', function(e) {
    // ignore windows
    if (!(e.target instanceof SafariBrowserTab)) {
        return;
    }

    var tabId = vAPI.tabs.getTabId(e.target);

    if (tabId > -1) {
        // to not add another listener, put this here
        // instead of vAPI.tabs.registerListeners
        if (typeof vAPI.tabs.onClosed === 'function') {
            vAPI.tabs.onClosed(tabId);
        }

        delete vAPI.tabIcons[tabId];
        delete vAPI.tabs.stack[tabId];
    }
}, true);

/******************************************************************************/

// update badge when tab is activated
safari.application.addEventListener('activate', function(e) {
    // hide popover, since in some cases won't close by itself
    var items = safari.extension.toolbarItems;

    for (var i = 0; i < items.length; ++i) {
        if (items[i].browserWindow === safari.application.activeBrowserWindow) {
            if (items[i].popover) {
                items[i].popover.hide();
            }

            break;
        }
    }

    // ignore windows
    if (!(e.target instanceof SafariBrowserTab)) {
        return;
    }

    // update the badge, when tab is selected
    vAPI.setIcon();
}, true);

/******************************************************************************/

// reload the popup when that is opened
safari.application.addEventListener('popover', function(e) {
    e.target.contentWindow.document.body.textContent = '';
    e.target.contentWindow.location.reload();
}, true);

/******************************************************************************/

vAPI.tabIcons = { /*tabId: {badge: 0, img: dict}*/ };
vAPI.setIcon = function(tabId, img, badge) {
    var curTabId = vAPI.tabs.getTabId(
        safari.application.activeBrowserWindow.activeTab
    );

    // from 'activate' event
    if (tabId === undefined) {
        tabId = curTabId;
    }
    else {
        vAPI.tabIcons[tabId] = {
            badge: badge || 0/*,
            img: img*/
        };
    }

    if (tabId !== curTabId) {
        return;
    }

    // if the selected tab has the same ID, then update the badge too,
    // or always update it when changing tabs ('activate' event)
    var items = safari.extension.toolbarItems, i = items.length;

    while (i--) {
        if (items[i].browserWindow === safari.application.activeBrowserWindow) {
            if (vAPI.tabIcons[tabId]) {
                items[i].badge = vAPI.tabIcons[tabId].badge;
                // items[i].img = vAPI.tabIcons[tabId].img;
            }
            else {
                items[i].badge = 0;
            }

            return;
        }
    }
};

/******************************************************************************/

vAPI.messaging = {
    listeners: {},
    defaultHandler: null,
    NOOPFUNC: function(){},
    UNHANDLED: 'vAPI.messaging.notHandled'
};

/******************************************************************************/

vAPI.messaging.listen = function(listenerName, callback) {
    this.listeners[listenerName] = callback;
};

/******************************************************************************/

vAPI.messaging.onMessage = function(request) {
    var callback = vAPI.messaging.NOOPFUNC;
    if ( request.message.requestId !== undefined ) {
        callback = function(response) {
            request.target.page.dispatchMessage(
                request.name,
                {
                    requestId: request.message.requestId,
                    portName: request.message.portName,
                    msg: response !== undefined ? response : null
                }
            );
        };
    }

    var sender = {
        tab: {
            id: vAPI.tabs.getTabId(request.target)
        }
    };

    // Specific handler
    var r = vAPI.messaging.UNHANDLED;
    var listener = vAPI.messaging.listeners[request.message.portName];
    if ( typeof listener === 'function' ) {
        r = listener(request.message.msg, sender, callback);
    }
    if ( r !== vAPI.messaging.UNHANDLED ) {
        return;
    }

    // Default handler
    r = vAPI.messaging.defaultHandler(request.message.msg, sender, callback);
    if ( r !== vAPI.messaging.UNHANDLED ) {
        return;
    }

    console.error('µBlock> messaging > unknown request: %o', request.message);

    // Unhandled:
    // Need to callback anyways in case caller expected an answer, or
    // else there is a memory leak on caller's side
    callback();
};

/******************************************************************************/

vAPI.messaging.setup = function(defaultHandler) {
    // Already setup?
    if ( this.defaultHandler !== null ) {
        return;
    }

    if ( typeof defaultHandler !== 'function' ) {
        defaultHandler = function(){ return vAPI.messaging.UNHANDLED; };
    }
    this.defaultHandler = defaultHandler;

    // the third parameter must stay false (bubbling), so later
    // onBeforeRequest will use true (capturing), where we can invoke
    // stopPropagation() (this way this.onMessage won't be fired)
    safari.application.addEventListener('message', this.onMessage, false);
};

/******************************************************************************/

vAPI.messaging.broadcast = function(message) {
    message = {
        broadcast: true,
        msg: message
    };

    for (var tabId in vAPI.tabs.stack) {
        vAPI.tabs.stack[tabId].page.dispatchMessage('broadcast', message);
    }
};

/******************************************************************************/

safari.application.addEventListener('beforeNavigate', function(e) {
    if (!vAPI.tabs.expectPopUpFrom || e.url === 'about:blank') {
        return;
    }

    var details = {
        url: e.url,
        tabId: vAPI.tabs.getTabId(e.target),
        sourceTabId: vAPI.tabs.expectPopUpFrom
    };

    vAPI.tabs.expectPopUpFrom = null;

    if (vAPI.tabs.onPopup(details)) {
        e.preventDefault();

        if (vAPI.tabs.stack[details.sourceTabId]) {
            vAPI.tabs.stack[details.sourceTabId].activate();
        }
    }
}, true);

/******************************************************************************/

vAPI.net = {}

vAPI.net.registerListeners = function() {
    var onBeforeRequest = this.onBeforeRequest;

    if (typeof onBeforeRequest.callback === 'function') {
        if (!Array.isArray(onBeforeRequest.types)) {
            onBeforeRequest.types = [];
        }

        onBeforeRequest = onBeforeRequest.callback;
        this.onBeforeRequest.callback = function(e) {
            var block;

            if (e.name !== 'canLoad') {
                return;
            }

            // no stopPropagation if it was called from beforeNavigate event
            if (e.stopPropagation) {
                e.stopPropagation();
            }

            if (e.message.isWhiteListed) {
                block = µBlock.URI.hostnameFromURI(e.message.isWhiteListed);
                block = µBlock.URI.domainFromHostname(block) || block;
                e.message = !!µBlock.netWhitelist[block];
                return e.message;
            }

            // when the URL changes, but the document doesn't
            if (e.message.type === 'popstate') {
                vAPI.tabs.onUpdated(
                    vAPI.tabs.getTabId(e.target),
                    {url: e.message.url},
                    {url: e.message.url}
                );
                return;
            }
            // blocking unwanted pop-ups
            else if (e.message.type === 'popup') {
                if (e.message.url === 'about:blank') {
                    vAPI.tabs.expectPopUpFrom = vAPI.tabs.getTabId(e.target);
                    e.message = true;
                    return;
                }

                e.message = !vAPI.tabs.onPopup({
                    url: e.message.url,
                    tabId: 0,
                    sourceTabId: vAPI.tabs.getTabId(e.target)
                });
                return;
            }

            block = vAPI.net.onBeforeRequest;

            if (block.types.indexOf(e.message.type) < 0) {
                return true;
            }

            e.message.tabId = vAPI.tabs.getTabId(e.target);
            block = onBeforeRequest(e.message);

            // truthy return value will allow the request,
            // except when redirectUrl is present
            if (block && typeof block === 'object') {
                if (block.cancel === true) {
                    e.message = false;
                }
                else if (e.message.type === 'script'
                    && typeof block.redirectUrl === "string") {
                    e.message = block.redirectUrl;
                }
                else {
                    e.message = true;
                }
            }
            else {
                e.message = true;
            }

            return e.message;
        };

        safari.application.addEventListener(
            'message',
            this.onBeforeRequest.callback,
            true
        );
    }
};

/******************************************************************************/

vAPI.contextMenu = {};

/******************************************************************************/

vAPI.contextMenu.create = function(details, callback) {
    var contexts = details.contexts;
    var menuItemId = details.id;
    var menuTitle = details.title;

    if (Array.isArray(contexts) && contexts.length) {
        contexts = contexts.indexOf('all') === -1 ? contexts : null;
    }
    else {
        // default in Chrome
        contexts = ['page'];
    }

    this.onContextMenu = function(e) {
        var uI = e.userInfo;

        if (uI && /^https?:\/\//i.test(uI.pageUrl)) {
            if (contexts) {
                var invalidContext = true;

                for (var i = 0; i < contexts.length; ++i) {
                    if (contexts[i] === 'frame') {
                        if (uI.insideFrame) {
                            invalidContext = false;
                            break;
                        }
                    }
                    else if (contexts[i] === 'link') {
                        if (uI.linkHref) {
                            invalidContext = false;
                            break;
                        }
                    }
                    else if (contexts[i] === 'image') {
                        if (uI.srcUrl) {
                            invalidContext = false;
                            break;
                        }
                    }
                    else if (contexts[i] === 'audio'
                        || contexts[i] === 'video') {
                        if (uI.srcUrl && uI.tagName === contexts[i]) {
                            invalidContext = false;
                            break;
                        }
                    }
                    else if (contexts[i] === 'editable') {
                        if (uI.editable) {
                            invalidContext = false;
                            break;
                        }
                    }
                    else if (contexts[i] === 'page') {
                        if (!(uI.insideFrame || uI.linkHref
                            || uI.mediaType || uI.editable)) {
                            invalidContext = false;
                            break;
                        }
                    }
                }

                if (invalidContext) {
                    return;
                }
            }

            e.contextMenu.appendContextMenuItem(menuItemId, menuTitle);
        }
    };

    this.onContextMenuCmd = function(e) {
        if (e.command === menuItemId) {
            var tab = e.currentTarget.activeBrowserWindow.activeTab;
            e.userInfo.menuItemId = menuItemId;
            callback(e.userInfo, tab ? {
                id: vAPI.tabs.getTabId(tab),
                url: tab.url
            } : undefined);
        }
    };

    safari.application.addEventListener('contextmenu', this.onContextMenu);
    safari.application.addEventListener("command", this.onContextMenuCmd);
};

/******************************************************************************/

vAPI.contextMenu.remove = function() {
    safari.application.removeEventListener('contextmenu', this.onContextMenu);
    safari.application.removeEventListener("command", this.onContextMenuCmd);
    this.onContextMenu = null;
    this.onContextMenuCmd = null;
};

/******************************************************************************/

vAPI.lastError = function() {
    return null;
};

/******************************************************************************/

// This is called only once, when everything has been loaded in memory after
// the extension was launched. It can be used to inject content scripts
// in already opened web pages, to remove whatever nuisance could make it to
// the web pages before uBlock was ready.

vAPI.onLoadAllCompleted = function() {
};

/******************************************************************************/

})();
