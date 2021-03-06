'use strict';

import storage from '../js/storage';

let hotkeys = [],
    foundHotKey = false;

function changeHotkeysListener(request, sender) {
    if (sender.tab && sender.tab.incognito) {
        unsubscribeFromAllEvents();
        return;
    }

    if (request.action === 'update-hotkeys') {
        reloadHotKeys().then(init);
    }
};

browser.runtime.onMessage.addListener(changeHotkeysListener);

async function reloadHotKeys() {
    let options = await storage.get('hotkeys');

    hotkeys = options.hotkeys;
}

reloadHotKeys().then(init);

function init() {
    resetWindowEvents();

    if (hotkeys.length) {
        addWindowEvents();
    }
}

function resetWindowEvents() {
    window.removeEventListener('keydown', checkKey, false);
    window.removeEventListener('keyup', resetFoundHotKey, false);
}

function addWindowEvents() {
    window.addEventListener('keydown', checkKey, false);
    window.addEventListener('keyup', resetFoundHotKey, false);
}

function unsubscribeFromAllEvents() {
    resetWindowEvents();
    browser.runtime.onMessage.removeListener(changeHotkeysListener);
}

function resetFoundHotKey() {
    foundHotKey = false;
}

function checkKey(e) {
    if (foundHotKey || !e.isTrusted || [KeyEvent.DOM_VK_SHIFT, KeyEvent.DOM_VK_CONTROL, KeyEvent.DOM_VK_ALT, KeyEvent.DOM_VK_META].includes(e.keyCode)) { // not track only auxiliary keys
        return;
    }

    hotkeys.some(function(hotkey) {
        if (hotkey.ctrlKey === e.ctrlKey &&
            hotkey.shiftKey === e.shiftKey &&
            hotkey.altKey === e.altKey &&
            hotkey.metaKey === e.metaKey &&
            (
                (hotkey.keyCode && hotkey.keyCode === e.keyCode) ||
                (!hotkey.keyCode && !e.keyCode && hotkey.key.toUpperCase() === e.key.toUpperCase())
            )
        ) {
            foundHotKey = true;

            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            browser.runtime.sendMessage({
                    action: hotkey.action,
                    groupId: hotkey.groupId,
                })
                .then(function(response) {
                    foundHotKey = false;

                    if (response && response.unsubscribe) {
                        unsubscribeFromAllEvents();
                    }
                });

            return true;
        }
    });
}
