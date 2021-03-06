'use strict';

import * as constants from './js/constants';
import * as utils from './js/utils';
import storage from './js/storage';

let errorLogs = [],
    options = {},
    _groups = [],
    _thumbnails = {},
    manifest = browser.runtime.getManifest(),
    manageTabsPageUrl = browser.extension.getURL(constants.MANAGE_TABS_URL);

let log = function(message = 'log', data = null, showNotification = true) {
    try {
        throw Error(message);
    } catch (e) {
        let prefix = browser.extension.getURL('');

        errorLogs.push({
            message: message,
            data: data,
            fromLine: e.stack.split('@').map(l => l.split(prefix).join('')),
        });

        if (showNotification) {
            utils.notify(browser.i18n.getMessage('whatsWrongMessage'))
                .then(() => browser.runtime.openOptionsPage());
        }
    }
};

let saveGroupsToStorageTimer = null;

async function saveGroupsToStorage(sendMessageToAll = false) {
    if (sendMessageToAll) {
        sendMessageGroupsUpdated();
    }

    if (saveGroupsToStorageTimer) {
        clearTimeout(saveGroupsToStorageTimer);
    }

    saveGroupsToStorageTimer = setTimeout(function() {
        storage.set({
            groups: _groups,
        });
    }, 500);
}

async function getWindow(windowId = browser.windows.WINDOW_ID_CURRENT) {
    return await browser.windows.get(windowId).catch(function() {});
}

async function createWindow(createData = {}) {
    let win = await browser.windows.create(createData);

    if ('normal' === win.type) {
        lastFocusedNormalWindow = win;
    }

    lastFocusedWinId = win.id;

    return win;
}

function setFocusOnWindow(windowId) {
    return browser.windows.update(windowId, {
        focused: true,
    });
}

async function getTabs(windowId = browser.windows.WINDOW_ID_CURRENT, status = 'v') { // v: visible, h: hidden, null: all
    let tabs = await browser.tabs.query({
        windowId: windowId,
        pinned: false,
    });

    if ('v' === status) {
        return tabs.filter(utils.isTabVisible);
    } else if ('h' === status) {
        return tabs.filter(utils.isTabHidden);
    } else if (!status) {
        return tabs;
    }
}

function getPinnedTabs(windowId = browser.windows.WINDOW_ID_CURRENT) {
    return browser.tabs.query({
        windowId: windowId,
        pinned: true,
    });
}

function mapTab(tab) {
    if (!tab.url || 'about:newtab' === tab.url) {
        tab.url = 'about:blank';
    }

    return {
        id: tab.id || null,
        title: tab.title || tab.url,
        url: tab.url,
        active: Boolean(tab.active),
        favIconUrl: tab.favIconUrl || '',
        cookieStoreId: tab.cookieStoreId || constants.DEFAULT_COOKIE_STORE_ID,
    };
}

function getTabFavIconUrl(tab) {
    let safedFavIconUrl = '',
        localUrls = ['moz-extension', 'about', 'data', 'view-source', 'javascript', 'chrome', 'file'];

    if (localUrls.some(url => tab.url.startsWith(url))) {
        safedFavIconUrl = tab.favIconUrl;
    } else if (options.useTabsFavIconsFromGoogleS2Converter) {
        safedFavIconUrl = 'https://www.google.com/s2/favicons?domain_url=' + encodeURIComponent(tab.url);
    } else {
        safedFavIconUrl = tab.favIconUrl;
    }

    if (!safedFavIconUrl) {
        safedFavIconUrl = '/icons/tab.svg';
    }

    return safedFavIconUrl;
}

function createGroup(id, windowId = null, groupIconViewType = null, title = null) {
    return {
        id: id,
        title: utils.createGroupTitle(title, id),
        iconColor: utils.randomColor(),
        iconUrl: null,
        iconViewType: groupIconViewType || options.defaultGroupIconViewType,
        tabs: [],
        catchTabRules: '',
        catchTabContainers: [],
        isSticky: false,
        muteTabsWhenGroupCloseAndRestoreWhenOpen: false,
        showTabAfterMovingItIntoThisGroup: false,
        windowId: windowId,
    };
}

async function addGroup(windowId, resetGroups = false, returnNewGroupIndex = true, withTabs = [], title) {
    let { lastCreatedGroupPosition } = await storage.get('lastCreatedGroupPosition');

    lastCreatedGroupPosition++;

    if (resetGroups) {
        _groups = [];
    }

    let newGroupIndex = _groups.length;

    _groups.push(createGroup(lastCreatedGroupPosition, windowId, undefined, title));

    if (0 === newGroupIndex) {
        let win = await getWindow(),
            tabs = await getTabs();

        windowId = win.id;

        _groups[0].windowId = windowId;
        _groups[0].tabs = tabs.map(mapTab);

        updateBrowserActionData(_groups[0].windowId);
    } else if (withTabs.length) {
        _groups[newGroupIndex].tabs = utils.clone(withTabs.map(mapTab)); // clone need for fix bug: dead object after close tab which create object
    }

    await storage.set({
        lastCreatedGroupPosition,
    });

    sendMessage({
        action: 'group-added',
        group: _groups[newGroupIndex],
    });

    sendExternalMessage({
        action: 'group-added',
        group: _mapGroupForAnotherExtension(_groups[newGroupIndex]),
    });

    updateMoveTabMenus(windowId);
    saveGroupsToStorage();

    return returnNewGroupIndex ? newGroupIndex : _groups[newGroupIndex];
}

async function updateGroup(groupId, updateData) {
    let groupIndex = _groups.findIndex(gr => gr.id === groupId);

    Object.assign(_groups[groupIndex], utils.clone(updateData)); // clone need for fix bug: dead object after close tab which create object

    sendMessage({
        action: 'group-updated',
        group: Object.assign(updateData, {
            id: groupId,
        }),
    });

    sendExternalMessage({
        action: 'group-updated',
        group: _mapGroupForAnotherExtension(_groups[groupIndex]),
    });

    saveGroupsToStorage();

    let win = await getWindow();

    if (['title', 'iconUrl', 'iconColor', 'iconViewType'].some(key => key in updateData)) {
        updateMoveTabMenus(win.id);
    }

    if (_groups[groupIndex].windowId && _groups[groupIndex].windowId === win.id) {
        updateBrowserActionData(win.id);
    }
}

function sendMessageGroupsUpdated() {
    sendMessage({
        action: 'groups-updated',
    });
}

function sendMessage(data) {
    browser.runtime.sendMessage(data);
}

function sendExternalMessage(data) {
    Object.keys(constants.EXTENSIONS_WHITE_LIST)
        .forEach(function(exId) {
            if (constants.EXTENSIONS_WHITE_LIST[exId].postActions.includes(data.action)) {
                data.isExternalMessage = true;
                browser.runtime.sendMessage(exId, data);
            }
        });
}

async function addUndoRemoveGroupItem(group) {
    browser.menus.create({
        id: constants.CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP + group.id,
        title: browser.i18n.getMessage('undoRemoveGroupItemTitle', group.title),
        contexts: ['browser_action'],
        icons: {
            16: utils.getGroupIconUrl(group),
        },
        onclick: function(info) {
            browser.menus.remove(info.menuItemId);

            group.windowId = null;
            group.tabs.forEach(tab => tab.id = null);

            _groups.push(group);

            updateMoveTabMenus();
            saveGroupsToStorage(true);
        },
    });
}

async function createTempActiveTab(windowId = browser.windows.WINDOW_ID_CURRENT, createPinnedTab = true) {
    let pinnedTabs = await getPinnedTabs(windowId);

    if (pinnedTabs.length) {
        if (!pinnedTabs.some(tab => tab.active)) {
            await browser.tabs.update(pinnedTabs[pinnedTabs.length - 1].id, {
                active: true,
            });
        }
    } else {
        return browser.tabs.create({
            url: 'about:blank',
            pinned: createPinnedTab,
            active: true,
            windowId: windowId,
        });
    }
}

async function removeGroup(groupId) {
    let groupIndex = _groups.findIndex(gr => gr.id === groupId),
        group = _groups[groupIndex];

    _groups.splice(groupIndex, 1);

    if (group.windowId) {
        setLoadingToBrowserAction();
        await setWindowValue(group.windowId, 'groupId', null);
    }

    addUndoRemoveGroupItem(group);

    if (_groups.length) { // dont close tabs if remove last group
        let tabsIdsToRemove = group.tabs.filter(utils.keyId).map(utils.keyId);

        if (tabsIdsToRemove.length) {
            let tempEmptyTab = null;

            if (group.windowId) {
                tempEmptyTab = await createTempActiveTab(group.windowId, false);
            }

            await browser.tabs.remove(tabsIdsToRemove);

            if (tempEmptyTab) {
                let windows = await browser.windows.getAll({}),
                    otherWindow = windows.find(win => utils.isWindowAllow(win) && win.id !== group.windowId);

                if (otherWindow) {
                    await browser.tabs.remove(tempEmptyTab.id);
                    await setFocusOnWindow(otherWindow.id);
                }
            }
        }
    }

    updateMoveTabMenus();

    if (group.windowId) {
        updateBrowserActionData();
    }

    sendMessage({
        action: 'group-removed',
        groupId: groupId,
    });

    sendExternalMessage({
        action: 'group-removed',
        groupId: groupId,
    });

    saveGroupsToStorage();
}

async function moveGroup(groupId, position = 'up') {
    let groupIndex = _groups.findIndex(group => group.id === groupId);

    if ('up' === position) {
        if (0 === groupIndex) {
            return;
        }

        _groups.splice(groupIndex - 1, 0, _groups.splice(groupIndex, 1)[0]);
    } else if ('down' === position) {
        if (groupIndex === _groups.length - 1) {
            return;
        }

        _groups.splice(groupIndex + 1, 0, _groups.splice(groupIndex, 1)[0]);
    } else if ('number' === utils.type(position)) {
        _groups.splice(position, 0, _groups.splice(groupIndex, 1)[0]);
    }

    updateMoveTabMenus();
    saveGroupsToStorage(true);
}

let savingTabsInWindow = {};

async function saveCurrentTabs(windowId, excludeTabId, calledFuncStringName) {
    if (!windowId || savingTabsInWindow[windowId]) {
        return;
    }

    let group = _groups.find(gr => gr.windowId === windowId);

    if (!group) {
        return;
    }

    savingTabsInWindow[windowId] = true;

    if (calledFuncStringName) {
        console.info('saveCurrentTabs called from', calledFuncStringName);
    }

    let tabs = await getTabs(windowId);

    console.info('saving tabs ', { windowId, excludeTabId, calledFuncStringName }, utils.clone(tabs));

    group.tabs = tabs
        .filter(function(winTab) {
            if (excludeTabId) {
                return excludeTabId !== winTab.id;
            }

            // return true;
            return !_groups.filter(gr => gr.id !== group.id).some(gr => gr.tabs.some(tab => tab.id === winTab.id));
        })
        .map(function(winTab) {
            if ('loading' === winTab.status && utils.isUrlEmpty(winTab.url)) {
                let tab = group.tabs.find(t => t.id === winTab.id);

                if (tab) {
                    tab.active = winTab.active;
                    return tab;
                }
            }

            return mapTab(winTab);
        });

    sendMessage({
        action: 'group-updated',
        group: {
            id: group.id,
            tabs: group.tabs,
        },
    });

    saveGroupsToStorage();

    delete savingTabsInWindow[windowId];
}

async function addTab(groupId, cookieStoreId) {
    let group = _groups.find(gr => gr.id === groupId);

    if (group.windowId) {
        await browser.tabs.create({
            active: false,
            cookieStoreId,
            windowId: group.windowId,
        });
    } else {
        group.tabs.push({
            active: false,
            url: 'about:blank',
            cookieStoreId,
        });
        saveGroupsToStorage();
    }

    sendMessage({
        action: 'group-updated',
        group: {
            id: group.id,
            tabs: group.tabs,
        },
    });
}

async function removeTab(groupId, tabIndex) {
    let group = _groups.find(gr => gr.id === groupId),
        tabId = group.tabs[tabIndex].id;

    if (tabId) {
        let tab = await browser.tabs.get(tabId);

        if (utils.isTabHidden(tab)) {
            group.tabs.splice(tabIndex, 1);
            saveGroupsToStorage();
        } else {
            let pinnedTabs = await getPinnedTabs(tab.windowId),
                tabs = await getTabs(tab.windowId);

            if (!pinnedTabs.length && 1 === tabs.length) {
                await browser.tabs.create({
                    active: true,
                    windowId: tab.windowId,
                });
            }
        }

        await browser.tabs.remove(tabId);
    } else {
        group.tabs.splice(tabIndex, 1);

        sendMessage({
            action: 'group-updated',
            group: {
                id: group.id,
                tabs: group.tabs,
            },
        });

        saveGroupsToStorage();
    }
}

function setLoadingToBrowserAction() {
    browser.browserAction.setIcon({
        path: '/icons/animate-spinner.svg',
    });
}

async function setMuteTabs(windowId, setMute) {
    let tabs = await browser.tabs.query({
        pinned: false,
        [setMute ? 'audible' : 'muted']: true,
        windowId: windowId,
    });

    if (tabs.length) {
        await Promise.all(tabs.map(tab => browser.tabs.update(tab.id, {
            muted: Boolean(setMute),
        })));
    }
}

let loadingGroupInWindow = {}; // windowId: true;
async function loadGroup(windowId, groupIndex, activeTabIndex = -1) {
    if (!windowId || 1 > windowId) { // if click on notification after moving tab to window which is now closed :)
        throw Error('loadGroup: windowId not set');
    }

    let group = _groups[groupIndex];

    if (!group) {
        throw Error('group index not found ' + groupIndex);
    }

    if (loadingGroupInWindow[windowId]) {
        return;
    }

    console.log('loadGroup', { groupId: group.id, windowId, activeTabIndex });

    // try to fix bug invalid tab id
    function _fixTabsIds(tabs) {
        return Promise.all(tabs.filter(utils.keyId).map(tab => browser.tabs.get(tab.id).catch(() => tab.id = null)));
    }

    try {
        if (group.windowId) {
            if (-1 !== activeTabIndex) {
                await browser.tabs.update(group.tabs[activeTabIndex].id, {
                    active: true,
                });
            }

            setFocusOnWindow(group.windowId);
        } else {
            // magic

            let tmpWin = await getWindow(windowId);
            if (tmpWin.incognito) {
                throw 'Error: Does\'nt support private windows';
            }

            let winTabs = await getTabs(windowId),
                oldGroup = _groups.find(gr => gr.windowId === windowId);

            if (oldGroup && winTabs.some(utils.isTabCanNotBeHidden)) {
                throw browser.i18n.getMessage('notPossibleSwitchGroupBecauseSomeTabShareMicrophoneOrCamera');
            }

            loadingGroupInWindow[windowId] = true;

            setLoadingToBrowserAction();

            removeEvents();

            let pinnedTabs = await getPinnedTabs(windowId),
                pinnedTabsLength = pinnedTabs.length;

            // group.windowId = windowId;
            group.tabs = group.tabs.filter(tab => tab.id || utils.isUrlAllowToCreate(tab.url)); // remove unsupported tabs

            if (!group.tabs.length && !pinnedTabsLength && oldGroup) {
                group.tabs.push({
                    url: 'about:blank',
                    active: true,
                    cookieStoreId: constants.DEFAULT_COOKIE_STORE_ID,
                });
            }

            let tempEmptyTab = await createTempActiveTab(windowId); // create empty tab (for quickly change group and not blinking)

            if (tempEmptyTab) {
                pinnedTabsLength++;
            }

            // hide tabs
            if (oldGroup) {
                if (oldGroup.tabs.length) {
                    await _fixTabsIds(oldGroup.tabs);

                    let oldTabIds = oldGroup.tabs.filter(utils.keyId).map(utils.keyId);

                    if (oldTabIds.length) {
                        if (oldGroup.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
                            await setMuteTabs(oldGroup.windowId, true);
                        }

                        await browser.tabs.hide(oldTabIds);

                        if (options.discardTabsAfterHide) {
                            browser.tabs.discard(oldTabIds);
                        }
                    }
                }
            } else {
                if (winTabs.length) {
                    let syncedTabs = [];

                    group.tabs
                        .filter(tab => !tab.id)
                        .forEach(function(tab) {
                            let winTab = winTabs.find(function(t) {
                                if (!syncedTabs.includes(t.id)) {
                                    return t.url === tab.url;
                                }
                            });

                            if (winTab) {
                                tab.id = winTab.id;
                                syncedTabs.push(winTab.id);
                            }
                        });

                    let tabIdsToHide = winTabs.filter(winTab => !group.tabs.some(tab => tab.id === winTab));

                    if (tabIdsToHide.length) {
                        await browser.tabs.hide(tabIdsToHide.map(utils.keyId));
                    }
                }
            }

            // show tabs
            if (group.tabs.length) {
                await _fixTabsIds(group.tabs);

                let containers = await utils.loadContainers(),
                    hiddenTabsIds = group.tabs.filter(utils.keyId).map(utils.keyId);

                if (hiddenTabsIds.length) {
                    await browser.tabs.move(hiddenTabsIds, {
                        index: pinnedTabsLength,
                        windowId: windowId,
                    });

                    await browser.tabs.show(hiddenTabsIds);

                    if (group.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
                        await setMuteTabs(windowId, false);
                    }
                }

                await Promise.all(group.tabs.map(async function(tab, tabIndex) {
                    if (tab.id) {
                        return;
                    }

                    let isTabActive = -1 === activeTabIndex ? Boolean(tab.active) : tabIndex === activeTabIndex;

                    let newTab = await browser.tabs.create({
                        active: isTabActive,
                        index: pinnedTabsLength + tabIndex,
                        url: tab.url,
                        windowId: windowId,
                        cookieStoreId: utils.normalizeCookieStoreId(tab.cookieStoreId, containers),
                    });

                    tab.id = newTab.id;
                }));

                // set active tab
                group.tabs.some(function(tab, tabIndex) {
                    let isTabActive = -1 === activeTabIndex ? Boolean(tab.active) : tabIndex === activeTabIndex;

                    if (isTabActive) {
                        browser.tabs.update(tab.id, {
                            active: true,
                        });
                        return true;
                    }
                });
            }

            if (tempEmptyTab) {
                await browser.tabs.remove(tempEmptyTab.id);
            }

            if (oldGroup) {
                oldGroup.windowId = null;

                oldGroup.tabs = oldGroup.tabs.filter(function(tab) {
                    if (tab.id && tab.url === manageTabsPageUrl) {
                        browser.tabs.remove(tab.id);
                        return false;
                    }

                    return true;
                });
            }

            group.windowId = windowId;
            await setWindowValue(windowId, 'groupId', group.id);

            await saveCurrentTabs(windowId, undefined, 'loadGroup');

            updateMoveTabMenus(windowId);

            updateBrowserActionData(windowId);

            addEvents();

            delete loadingGroupInWindow[windowId];
        }

        sendMessage({
            action: 'group-loaded',
            group: group,
        });

    } catch (e) {
        delete loadingGroupInWindow[windowId];
        utils.notify(e);
        throw String(e);
    }
}

function isCatchedUrl(url, group) {
    if (!group.catchTabRules) {
        return false;
    }

    return group.catchTabRules
        .trim()
        .split(/\s*\n\s*/)
        .map(regExpStr => regExpStr.trim())
        .filter(Boolean)
        .some(function(regExpStr) {
            try {
                return new RegExp(regExpStr).test(url);
            } catch (e) {};
        });
}

async function updateTabThumbnail(tab, force = false) {
    if (!options.createThumbnailsForTabs || !tab || !tab.url) {
        return;
    }

    let tabUrl = tab.url.split('#', 1).shift();

    if (!force && _thumbnails[tabUrl]) {
        return;
    }

    let tabId = null;

    if (tab.id) {
        let rawTab = await browser.tabs.get(tab.id);

        if (!rawTab.discarded) {
            tabId = tab.id;
        }
    }

    if (!tabId) {
        let tabs = await browser.tabs.query({
            url: tabUrl,
            discarded: false,
        });

        if (tabs.length) {
            tabId = tabs[0].id;
        }
    }

    if (!tabId) {
        if (force) {
            utils.notify(browser.i18n.getMessage('cantMakeThumbnailTabWasDiscarded'), 10000, 'cantMakeThumbnailTabWasDiscarded');
        }

        return;
    }

    let thumbnail = null;

    try {
        let thumbnailBase64 = await browser.tabs.captureTab(tabId);

        thumbnail = await new Promise(function(resolve, reject) {
            let img = new Image();

            img.onload = function() {
                resolve(utils.resizeImage(img, 192, Math.floor(img.width * 192 / img.height), false));
            };

            img.onerror = reject;

            img.src = thumbnailBase64;
        });
    } catch (e) {

    }

    if (thumbnail) {
        _thumbnails[tabUrl] = thumbnail;
    } else {
        delete _thumbnails[tabUrl];
    }

    sendMessage({
        action: 'thumbnail-updated',
        url: tabUrl,
        thumbnail: thumbnail,
    });

    await storage.set({
        thumbnails: _thumbnails,
    });
}

async function onActivatedTab({ tabId, windowId }) {
    console.log('onActivatedTab', { tabId, windowId });

    let group = _groups.find(gr => gr.windowId === windowId);

    if (!group) {
        return;
    }

    group.tabs.forEach(function(tab) {
        tab.active = tab.id === tabId;

        if (tab.active) {
            updateTabThumbnail(tab);
        }
    });

    sendMessage({
        action: 'group-updated',
        group: {
            id: group.id,
            tabs: group.tabs,
        },
    });

    saveGroupsToStorage();
}

async function onCreatedTab(tab) {
    console.log('onCreatedTab', tab);

    let group = _groups.find(gr => gr.windowId === tab.windowId);

    if (group) {
        group.tabs.push(mapTab(tab));
        saveCurrentTabs(group.windowId, undefined, 'onCreatedTab');
    }

    console.log('onCreatedTab FINISH', tab);
}

async function onUpdatedTab(tabId, changeInfo, rawTab) {
    let tab = null,
        tabIndex = -1,
        group = null,
        groupIndex = -1;

    if (utils.isTabIncognito(rawTab) ||
        'isArticle' in changeInfo || // not supported reader mode now
        'discarded' in changeInfo || // not supported discard tabs now
        (utils.isTabPinned(rawTab) && undefined === changeInfo.pinned)) { // pinned tabs are not supported
        return;
    }

    _groups.some(function(gr, grIndex) {
        tabIndex = gr.tabs.findIndex(t => t.id === tabId);

        if (-1 !== tabIndex) {
            groupIndex = grIndex;
            tab = gr.tabs[tabIndex];
            group = gr;
            return true;
        }
    });

    if ('hidden' in changeInfo) { // if other programm hide or show tabs
        if (changeInfo.hidden) {
            saveCurrentTabs(rawTab.windowId, undefined, 'onUpdatedTab tab make hidden');
        } else { // show tab
            if (-1 === tabIndex) {
                saveCurrentTabs(rawTab.windowId, undefined, 'onUpdatedTab tab make visible');
            } else {
                loadGroup(rawTab.windowId, groupIndex, tabIndex);
            }
        }

        return;
    }

    if (-1 === tabIndex) {
        if ('favIconUrl' in changeInfo) {
            favIconUrl.favIconUrl = 'favIconUrl';
        }

        console.warn('saving tab by update was canceled: tab not found', tabId, JSON.stringify(changeInfo) + '\n', JSON.stringify({
            status: rawTab.status,
            url: rawTab.url,
            title: rawTab.title,
        }));
        return;
    }

    console.log('onUpdatedTab\n tabId:', tabId, JSON.stringify(changeInfo) + '\n', JSON.stringify({
        status: rawTab.status,
        url: rawTab.url,
        title: rawTab.title,
    }));

    if ('pinned' in changeInfo) {
        saveCurrentTabs(rawTab.windowId, undefined, 'onUpdatedTab change pinned tab');

        return;
    }

    if ('loading' === changeInfo.status && changeInfo.url) {
        if (!group.isSticky && utils.isUrlAllowToCreate(changeInfo.url) && !utils.isUrlEmpty(changeInfo.url)) {
            let destGroup = _groups.find(function(gr) {
                if (gr.catchTabContainers.includes(rawTab.cookieStoreId)) {
                    return true;
                }

                if (isCatchedUrl(changeInfo.url, gr)) {
                    return true;
                }
            });

            if (destGroup && destGroup.id !== group.id) {
                Object.assign(tab, mapTab(rawTab));

                moveTabToGroup(tabIndex, undefined, group.id, destGroup.id, undefined, undefined, destGroup.showTabAfterMovingItIntoThisGroup);
            }
        }
    } else if ('complete' === rawTab.status) {
        Object.assign(tab, mapTab(rawTab));

        sendMessage({
            action: 'group-updated',
            group: {
                id: group.id,
                tabs: group.tabs,
            },
        });

        saveGroupsToStorage();

        updateTabThumbnail(rawTab);
    }
}

function onRemovedTab(tabId, { isWindowClosing, windowId }) {
    console.log('onRemovedTab', arguments);

    if (isWindowClosing) {
        return;
    }

    _groups.some(function(group) {
        let tabIndex = group.tabs.findIndex(tab => tab.id === tabId);

        if (-1 !== tabIndex) {
            group.tabs.splice(tabIndex, 1);

            sendMessage({
                action: 'group-updated',
                group: {
                    id: group.id,
                    tabs: group.tabs,
                },
            });

            return true;
        }
    });
}

function onMovedTab(tabId, { windowId }) {
    console.log('onMovedTab', tabId, { windowId });

    saveCurrentTabs(windowId, undefined, 'onMovedTab');
}

function onAttachedTab(tabId, { newWindowId }) {
    console.log('onAttachedTab', tabId, { newWindowId });

    saveCurrentTabs(newWindowId, undefined, 'onAttachedTab');
}

function onDetachedTab(tabId, { oldWindowId }) { // notice: call before onAttached
    console.log('onDetachedTab', tabId, { oldWindowId });

    let group = _groups.find(gr => gr.windowId === oldWindowId);

    if (!group) {
        return;
    }

    let tabIndex = group.tabs.findIndex(tab => tab.id === tabId);

    if (-1 === tabIndex) { // if tab is not allowed
        return;
    }

    group.tabs.splice(tabIndex, 1);

    sendMessage({
        action: 'group-updated',
        group: {
            id: group.id,
            tabs: group.tabs,
        },
    });

    saveGroupsToStorage();
}

let lastFocusedWinId = null,
    lastFocusedNormalWindow = null; // fix bug with browser.windows.getLastFocused({windowTypes: ['normal']}), https://bugzilla.mozilla.org/show_bug.cgi?id=1419132

async function onFocusChangedWindow(windowId) {
    console.log('onFocusChangedWindow', windowId);

    if (browser.windows.WINDOW_ID_NONE === windowId) {
        return;
    }

    let win = await getWindow(windowId);

    if (win.incognito) {
        browser.browserAction.disable();
        resetBrowserActionData();
        removeMoveTabMenus();
    } else if (!lastFocusedWinId || lastFocusedWinId !== windowId) {
        browser.browserAction.enable();
        updateBrowserActionData(windowId);
        updateMoveTabMenus(windowId);
    }

    if (utils.isWindowAllow(win)) {
        lastFocusedNormalWindow = win;
    }

    lastFocusedWinId = windowId;
}

// if oldGroupId === null, move tab from current window without group
async function moveTabToGroup(oldTabIndex, newTabIndex = -1, oldGroupId = null, newGroupId, showNotificationAfterMoveTab = true, sendMessageAction = true, showTabAfterMoving = false) {
    console.log('moveTabToGroup', {oldTabIndex, newTabIndex, oldGroupId, newGroupId, showNotificationAfterMoveTab, sendMessageAction, showTabAfterMoving});

    let oldGroup = null,
        newGroup = _groups.find(gr => gr.id === newGroupId),
        tab = null,
        rawTab = null,
        pushToEnd = -1 === newTabIndex,
        newTabRealIndex = null;

    if (pushToEnd) {
        newTabIndex = newGroup.tabs.length;
    }

    if (newGroup.windowId) {
        let pinnedTabs = await getPinnedTabs(newGroup.windowId);
        newTabRealIndex = pushToEnd ? -1 : (pinnedTabs.length + newTabIndex);
    }

    if (oldGroupId) {
        oldGroup = _groups.find(gr => gr.id === oldGroupId);
        tab = oldGroup.tabs[oldTabIndex];
    } else {
        let tabId = oldTabIndex;
        rawTab = await browser.tabs.get(tabId);
        tab = mapTab(rawTab);
    }

    if (oldGroupId === newGroupId) { // if it's same group
        if (newGroup.windowId) {
            await browser.tabs.move(tab.id, {
                index: newTabRealIndex,
            });
        } else {
            if (newTabIndex !== oldTabIndex) {
                newGroup.tabs.splice(newTabIndex, 0, newGroup.tabs.splice(oldTabIndex, 1)[0]);
            }
        }
    } else { // if it's different group
        if (tab.id) {
            if (!rawTab) {
                rawTab = await browser.tabs.get(tab.id);
            }

            if (!newGroup.windowId && !utils.isTabCanBeHidden(rawTab)) {
                utils.notify(browser.i18n.getMessage('thisTabCanNotBeHidden'));
                return;
            }
        } else {
            if (!utils.isUrlAllowToCreate(tab.url)) {
                utils.notify(browser.i18n.getMessage('thisTabIsNotSupported'));
                return;
            }
        }

        if (oldGroup) {
            oldGroup.tabs.splice(oldTabIndex, 1);
        }

        if (tab.id) {
            newGroup.tabs.splice(newTabIndex, 0, tab);

            if (newGroup.windowId) {
                await browser.tabs.move(tab.id, {
                    index: newTabRealIndex,
                    windowId: newGroup.windowId,
                });
                await browser.tabs.show(tab.id);
            } else {
                let tabInGroup = newGroup.tabs.find(utils.keyId);

                if (tabInGroup) {
                    let rawTabInGroup = await browser.tabs.get(tabInGroup.id);

                    if (rawTabInGroup.windowId !== rawTab.windowId) {
                        await browser.tabs.move(tab.id, {
                            index: -1,
                            windowId: rawTabInGroup.windowId,
                        });
                        // await browser.tabs.show(tab.id);

                        rawTab = await browser.tabs.get(tab.id);
                    }
                }

                if (utils.isTabVisible(rawTab)) {
                    let tempEmptyTab = null;

                    if (rawTab.active) {
                        let tabs = await getTabs(rawTab.windowId),
                            activeIndex = tabs.findIndex(t => t.id === tab.id),
                            tabIdToMakeActive = null;

                        if (tabs[activeIndex + 1]) {
                            tabIdToMakeActive = tabs[activeIndex + 1].id;
                        } else if (activeIndex - 1 >= 0) {
                            tabIdToMakeActive = tabs[activeIndex - 1].id;
                        } else {
                            tempEmptyTab = await createTempActiveTab(rawTab.windowId);
                        }

                        if (tabIdToMakeActive) {
                            await browser.tabs.update(tabIdToMakeActive, {
                                active: true,
                            });
                        }
                    }

                    await browser.tabs.hide(tab.id);

                    if (tempEmptyTab) {
                        await browser.tabs.remove(tempEmptyTab.id);
                    }
                }
            }
        } else {
            // add tab
            if (newGroup.windowId) {
                let containers = await utils.loadContainers();

                await browser.tabs.create({
                    active: false,
                    url: tab.url,
                    index: newTabRealIndex,
                    windowId: newGroup.windowId,
                    cookieStoreId: utils.normalizeCookieStoreId(tab.cookieStoreId, containers),
                });
            } else {
                newGroup.tabs.splice(newTabIndex, 0, tab);
            }
        }
    }

    if (sendMessageAction) {
        if (oldGroup && oldGroup !== newGroup) {
            sendMessage({
                action: 'group-updated',
                group: {
                    id: oldGroup.id,
                    tabs: oldGroup.tabs,
                },
            });
        }

        sendMessage({
            action: 'group-updated',
            group: {
                id: newGroup.id,
                tabs: newGroup.tabs,
            },
        });
    }

    saveGroupsToStorage();

    if (showTabAfterMoving) {
        let winId = newGroup.windowId || lastFocusedNormalWindow.id;

        await loadGroup(winId, _groups.findIndex(group => group.id === newGroup.id), newTabIndex);

        return;
    }

    if (!showNotificationAfterMoveTab || !options.showNotificationAfterMoveTab) {
        return;
    }

    let tabTitle = utils.sliceText(tab.title),
        message = browser.i18n.getMessage('moveTabToGroupMessage', [newGroup.title, tabTitle]);

    utils.notify(message).then(async function(newGroupId, newTabIndex) {
        let groupIndex = _groups.findIndex(group => group.id === newGroupId);

        if (-1 !== groupIndex && _groups[groupIndex] && _groups[groupIndex].tabs[newTabIndex]) {
            await setFocusOnWindow(lastFocusedNormalWindow.id);
            loadGroup(lastFocusedNormalWindow.id, groupIndex, newTabIndex);
        }
    }.bind(null, newGroup.id, newTabIndex));
}

let moveTabToGroupMenusIds = [];

async function updateMoveTabMenus(windowId) {
    await removeMoveTabMenus();
    await createMoveTabMenus(windowId);
}

async function removeMoveTabMenus() {
    if (!moveTabToGroupMenusIds.length) {
        return;
    }

    await Promise.all(moveTabToGroupMenusIds.map(id => browser.menus.remove(id)));

    moveTabToGroupMenusIds = [];
}

async function createMoveTabMenus(windowId) {
    if (!windowId) {
        let win = await getWindow();
        windowId = win.id;
    }

    let currentGroup = _groups.find(gr => gr.windowId === windowId);

    moveTabToGroupMenusIds.push(browser.menus.create({
        id: 'stg-set-tab-icon-as-group-icon',
        title: browser.i18n.getMessage('setTabIconAsGroupIcon'),
        enabled: Boolean(currentGroup),
        icons: {
            16: '/icons/image.svg',
        },
        contexts: ['tab'],
        onclick: function(info, tab) {
            if (utils.isTabIncognito(tab)) {
                utils.notify(browser.i18n.getMessage('privateAndPinnedTabsAreNotSupported'));
                return;
            }

            let group = _groups.find(gr => gr.windowId === tab.windowId);

            if (!group) {
                return;
            }

            group.iconUrl = getTabFavIconUrl(tab);

            updateBrowserActionData(group.windowId);
            updateMoveTabMenus(group.windowId);

            sendMessage({
                action: 'group-updated',
                group: {
                    id: group.id,
                    iconUrl: group.iconUrl,
                },
            });

            saveGroupsToStorage();
        }
    }));

    moveTabToGroupMenusIds.push(browser.menus.create({
        id: 'stg-move-tab-helper',
        title: browser.i18n.getMessage('moveTabToGroupDisabledTitle'),
        enabled: false,
        contexts: ['tab'],
    }));

    await Promise.all(_groups.map(function(group) {
        moveTabToGroupMenusIds.push(browser.menus.create({
            id: constants.CONTEXT_MENU_PREFIX_GROUP + group.id,
            title: group.title,
            enabled: currentGroup ? group.id !== currentGroup.id : true,
            icons: {
                16: utils.getGroupIconUrl(group),
            },
            contexts: ['tab'],
            onclick: async function(destGroupId, info, tab) {
                if (utils.isTabIncognito(tab) || utils.isTabPinned(tab)) {
                    utils.notify(browser.i18n.getMessage('privateAndPinnedTabsAreNotSupported'));
                    return;
                }

                let oldTabIndex,
                    oldGroupId,
                    oldGroup = _groups.find(gr => gr.windowId === tab.windowId);

                if (oldGroup) {
                    oldTabIndex = oldGroup.tabs.findIndex(t => t.id === tab.id);
                    oldGroupId = oldGroup.id;
                } else {
                    oldTabIndex = tab.id;
                }

                moveTabToGroup(oldTabIndex, undefined, oldGroupId, destGroupId);
            }.bind(null, group.id),
        }));
    }));

    moveTabToGroupMenusIds.push(browser.menus.create({
        id: 'stg-move-tab-new-group',
        contexts: ['tab'],
        title: browser.i18n.getMessage('createNewGroup'),
        icons: {
            16: '/icons/group-new.svg',
        },
        onclick: async function(info, tab) {
            if (utils.isTabIncognito(tab) || utils.isTabPinned(tab)) {
                utils.notify(browser.i18n.getMessage('privateAndPinnedTabsAreNotSupported'));
                return;
            }

            let oldTabIndex,
                oldGroupId,
                newGroup = await addGroup(undefined, undefined, false),
                oldGroup = _groups.find(gr => gr.windowId === tab.windowId);

            if (oldGroup) {
                oldTabIndex = oldGroup.tabs.findIndex(t => t.id === tab.id);
                oldGroupId = oldGroup.id;
            } else {
                oldTabIndex = tab.id;
            }

            moveTabToGroup(oldTabIndex, undefined, oldGroupId, newGroup.id);
        },
    }));
}

function setBrowserActionData(currentGroup) {
    if (!currentGroup) {
        resetBrowserActionData();
        return;
    }

    browser.browserAction.setTitle({
        title: currentGroup.title + ' - ' + browser.i18n.getMessage('extensionName'),
    });

    browser.browserAction.setIcon({
        path: utils.getGroupIconUrl(currentGroup),
    });
}

function resetBrowserActionData() {
    browser.browserAction.setTitle({
        title: manifest.browser_action.default_title,
    });

    browser.browserAction.setIcon({
        path: utils.getGroupIconUrl(),
    });
}

async function updateBrowserActionData(windowId) {
    if (!windowId) {
        let win = await getWindow();
        windowId = win.id;
    }

    setBrowserActionData(_groups.find(gr => gr.windowId === windowId));
}

async function onRemovedWindow(windowId) {
    let group = _groups.find(gr => gr.windowId === windowId);

    if (group) {
        group.windowId = null;
        group.tabs.forEach(tab => tab.id = null); // reset tab id in func onRemovedTab

        sendMessage({
            action: 'group-updated',
            group: {
                id: group.id,
                windowId: null,
                tabs: group.tabs,
            },
        });

        saveGroupsToStorage();
    }

    if (lastFocusedNormalWindow.id === windowId) {
        lastFocusedNormalWindow = await getWindow();
    }
}

function addEvents() {
    browser.tabs.onCreated.addListener(onCreatedTab);
    browser.tabs.onActivated.addListener(onActivatedTab);
    browser.tabs.onMoved.addListener(onMovedTab);
    browser.tabs.onUpdated.addListener(onUpdatedTab);
    browser.tabs.onRemoved.addListener(onRemovedTab);

    browser.tabs.onAttached.addListener(onAttachedTab);
    browser.tabs.onDetached.addListener(onDetachedTab);

    browser.windows.onFocusChanged.addListener(onFocusChangedWindow);
    browser.windows.onRemoved.addListener(onRemovedWindow);
}

function removeEvents() {
    browser.tabs.onCreated.removeListener(onCreatedTab);
    browser.tabs.onActivated.removeListener(onActivatedTab);
    browser.tabs.onMoved.removeListener(onMovedTab);
    browser.tabs.onUpdated.removeListener(onUpdatedTab);
    browser.tabs.onRemoved.removeListener(onRemovedTab);

    browser.tabs.onAttached.removeListener(onAttachedTab);
    browser.tabs.onDetached.removeListener(onDetachedTab);

    browser.windows.onFocusChanged.removeListener(onFocusChangedWindow);
    browser.windows.onRemoved.removeListener(onRemovedWindow);
}

async function loadGroupPosition(textPosition) {
    if (1 === _groups.length) {
        return;
    }

    let win = await getWindow(),
        groupIndex = _groups.findIndex(group => group.windowId === win.id);

    if (-1 === groupIndex) {
        return;
    }

    let nextGroupIndex = utils.getNextIndex(groupIndex, _groups.length, textPosition);

    if (false === nextGroupIndex) {
        return;
    }

    await loadGroup(_groups[groupIndex].windowId, nextGroupIndex);

    return true;
}

function sortGroups(vector = 'asc') {
    if (!['asc', 'desc'].includes(vector)) {
        return;
    }

    _groups = _groups.sort(function(a, b) {
        if ('asc' === vector) {
            return utils.compareStrings(a.title, b.title);
        } else if ('desc' === vector) {
            return utils.compareStrings(b.title, a.title);
        }
    });

    updateMoveTabMenus();
    saveGroupsToStorage(true);
}

async function openManageGroups() {
    if (options.openManageGroupsInTab) {
        let tabs = await browser.tabs.query({
            windowId: browser.windows.WINDOW_ID_CURRENT,
            url: manageTabsPageUrl,
            // pinned: false,
            // hidden: false,
        });

        if (tabs.length) { // if manage tab is found
            await browser.tabs.update(tabs[0].id, {
                active: true,
            });
        } else {
            await browser.tabs.create({
                active: true,
                url: manageTabsPageUrl,
            });
        }
    } else {
        let allWindows = await browser.windows.getAll({
            populate: true,
            windowTypes: ['popup'],
        });

        let isFoundWindow = allWindows.some(function(win) {
            if ('popup' === win.type && 1 === win.tabs.length && manageTabsPageUrl === win.tabs[0].url) { // if manage popup is now open
                setFocusOnWindow(win.id);
                return true;
            }
        });

        if (isFoundWindow) {
            return;
        }

        await createWindow({
            url: manageTabsPageUrl,
            type: 'popup',
            left: Number(window.localStorage.manageGroupsWindowLeft) || 100,
            top: Number(window.localStorage.manageGroupsWindowTop) || 100,
            width: Number(window.localStorage.manageGroupsWindowWidth) || 1000,
            height: Number(window.localStorage.manageGroupsWindowHeight) || 700,
        });
    }
}

async function clearTabsThumbnails() {
    await storage.set({
        thumbnails: {},
    });

    _thumbnails = {};

    sendMessage({
        action: 'thumbnails-updated',
    });
}

browser.menus.create({
    id: 'openSettings',
    title: browser.i18n.getMessage('openSettings'),
    onclick: () => browser.runtime.openOptionsPage(),
    contexts: ['browser_action'],
    icons: {
        16: '/icons/settings.svg',
    },
});

browser.runtime.onMessage.addListener(async function(request, sender) {
    if (!utils.isAllowSender(request, sender)) {
        return {
            unsubscribe: true,
        };
    }

    if (request.action) {
        runAction(request);
    }
});

browser.runtime.onMessageExternal.addListener(function(request, sender, sendResponse) {
    let extensionRules = {};

    if (!utils.isAllowExternalRequestAndSender(request, sender, extensionRules)) {
        sendResponse({
            ok: false,
            error: '[STG] Your extension/action does not in white list. If you want to add your extension/action to white list - please contact with me.',
            yourExtentionRules: extensionRules,
        });
        return;
    }

    if (request.action) {
        sendResponse(runAction(request, sender.id));
    } else {
        sendResponse({
            ok: false,
            error: 'unknown action',
        });
    }
});

function _mapGroupForAnotherExtension(group) {
    return {
        id: group.id,
        title: group.title,
        iconUrl: utils.getGroupIconUrl(group),
    };
}

async function runAction(data, externalExtId) {
    let result = {
            ok: false,
        },
        loadOk = null;

    if (!data.action) {
        result.error = '[STG] Action or it\'s id is empty';
        return result;
    }

    async function getCurrentWindow() {
        let currentWindow = await getWindow();

        if (!utils.isWindowAllow(currentWindow)) {
            throw Error('This window is not supported');
        }

        return currentWindow;
    }

    async function getCurrentGroup() {
        let currentWindow = await getCurrentWindow();

        return _groups.find(gr => gr.windowId === currentWindow.id);
    }

    try {
        switch (data.action) {
            case 'are-you-here':
                result.ok = true;
                break;
            case 'options-updated':
                options = await storage.get(constants.allOptionsKeys);

                if (data.optionsUpdated.includes('hotkeys')) {
                    let tabs = await browser.tabs.query({
                        discarded: false,
                        pinned: false,
                        windowType: 'normal',
                    });

                    tabs
                        .filter(utils.isTabNotIncognito)
                        .forEach(function(tab) {
                            browser.tabs.sendMessage(tab.id, {
                                action: 'update-hotkeys',
                            });
                        });
                }

                break;
            case 'get-groups-list':
                result.groupsList = _groups.map(_mapGroupForAnotherExtension);
                result.ok = true;
                break;
            case 'load-next-group':
                loadOk = await loadGroupPosition('next');

                if (loadOk) {
                    result.ok = true;
                }
                break;
            case 'load-prev-group':
                loadOk = await loadGroupPosition('prev');

                if (loadOk) {
                    result.ok = true;
                }
                break;
            case 'load-first-group':
                if (_groups[0]) {
                    let currentWindow = await getCurrentWindow();
                    await loadGroup(currentWindow.id, 0);
                    result.ok = true;
                }
                break;
            case 'load-last-group':
                if (_groups.length > 0) {
                    let currentWindow = await getCurrentWindow();
                    await loadGroup(currentWindow.id, _groups.length - 1);
                    result.ok = true;
                }
                break;
            case 'load-custom-group':
                let groupIndex = _groups.findIndex(gr => gr.id === data.groupId);

                if (-1 === groupIndex) {
                    throw Error(`Group id '${data.groupId}' type: '${typeof data.groupId}' not found. Need exists int group id.`);
                } else {
                    let currentWindow = await getCurrentWindow();
                    await loadGroup(currentWindow.id, groupIndex);
                    result.ok = true;
                }
                break;
            case 'add-new-group':
                await addGroup();
                result.ok = true;
                break;
            case 'delete-current-group':
                let currentGroup = await getCurrentGroup();

                if (currentGroup) {
                    await removeGroup(currentGroup.id);

                    if (externalExtId) {
                        utils.notify(browser.i18n.getMessage('groupRemovedByExtension', [currentGroup.title, utils.getSupportedExternalExtensionName(externalExtId)]));
                    }

                    result.ok = true;
                }
                break;
            case 'open-manage-groups':
                await openManageGroups();
                result.ok = true;
                break;
            default:
                throw Error(`Action '${data.action}' is wrong`);
                break;
        }

    } catch (e) {
        result.error = '[STG] ' + String(e);
        console.error(result.error);
    }

    return result;
}

window.background = {
    inited: false,

    log,
    getLogs: () => utils.clone(errorLogs),

    openManageGroups,

    getGroups: () => utils.clone(_groups),

    createWindow,
    getWindow,

    getTabs,
    moveTabToGroup,

    updateMoveTabMenus,
    clearTabsThumbnails,

    updateBrowserActionData,
    setFocusOnWindow,
    getLastFocusedNormalWindow: () => utils.clone(lastFocusedNormalWindow),

    sortGroups,
    loadGroup,

    sendMessageGroupsUpdated,

    mapTab,
    getTabFavIconUrl,
    updateTabThumbnail,

    getThumbnails: () => utils.clone(_thumbnails),

    addTab,
    removeTab,

    createGroup,
    moveGroup,
    addGroup,
    updateGroup,
    removeGroup,

    runMigrateForData,
};

async function runMigrateForData(data) {
    // reset tab ids
    data.groups = data.groups.map(function(group) {
        group.windowId = null;
        group.tabs = group.tabs.filter(Boolean).map(function(tab) {
            tab.id = null;
            return tab;
        });

        return group;
    });

    let currentVersion = manifest.version;

    if (data.version === currentVersion) {
        return data;
    }

    if (data.version === constants.DEFAULT_OPTIONS.version) {
        data.version = currentVersion;
        return data;
    }

    if (1 === utils.compareStrings(data.version, currentVersion)) {
        throw 'Please, update addon to latest version';
    }

    // start migration
    let keysToRemoveFromStorage = [];

    function removeKeys(...keys) {
        keys.forEach(function(key) {
            delete data[key];
            keysToRemoveFromStorage.push(key);
        });
    }

    function ifVersionInDataLessThan(version) {
        return -1 === utils.compareStrings(data.version, version);
    }

    if (ifVersionInDataLessThan('1.8.1')) {
        data.groups = data.groups.map(function(group) {
            group.windowId = data.windowsGroup[win.id] === group.id ? win.id : null;

            group.catchTabRules = group.moveNewTabsToThisGroupByRegExp || '';
            delete group.moveNewTabsToThisGroupByRegExp;

            delete group.classList;
            delete group.colorCircleHtml;
            delete group.isExpanded;

            if (group.iconColor === undefined || group.iconColor === 'undefined') { // fix missed group icons :)
                group.iconColor = utils.randomColor();
            }

            return group;
        });

        removeKeys('windowsGroup');
    }

    if (ifVersionInDataLessThan('2.2')) {
        if ('showGroupCircleInSearchedTab' in data) {
            data.showGroupIconWhenSearchATab = data.showGroupCircleInSearchedTab;
            removeKeys('showGroupCircleInSearchedTab');
        }
    }

    if (ifVersionInDataLessThan('2.3')) {
        data.groups = data.groups.map(function(group) {
            group.tabs = group.tabs.filter(Boolean);
            return group;
        });

        removeKeys('enableKeyboardShortcutLoadNextPrevGroup', 'enableKeyboardShortcutLoadByIndexGroup');
    }

    if (ifVersionInDataLessThan('2.4')) {
        data.groups = data.groups.map(function(group) {
            if (!group.catchTabContainers) {
                group.catchTabContainers = [];
            }

            return group;
        });
    }

    if (ifVersionInDataLessThan('2.4.5')) {
        data.groups = data.groups.map(function(group) {
            if (!group.iconColor.trim()) {
                group.iconColor = 'transparent';
            }

            group.iconViewType = 'main-squares';

            return group;
        });
    }

    if (ifVersionInDataLessThan('3.0')) {
        data.doRemoveSTGNewTabUrls = true;

        removeKeys('enableFastGroupSwitching', 'enableFavIconsForNotLoadedTabs', 'createNewGroupAfterAttachTabToNewWindow');
        removeKeys('individualWindowForEachGroup', 'openNewWindowWhenCreateNewGroup', 'showNotificationIfGroupsNotSyncedAtStartup');
        removeKeys('showGroupIconWhenSearchATab', 'showUrlTooltipOnTabHover');

        data.groups.forEach(group => group.title = utils.unSafeHtml(group.title));
    }

    if (ifVersionInDataLessThan('3.0.9')) {
        data.hotkeys.forEach(hotkey => 'metaKey' in hotkey ? null : hotkey.metaKey = false);
        data.groups.forEach(group => delete group.isExpanded);
    }

    if (ifVersionInDataLessThan('3.0.10')) {
        data.hotkeys.forEach(function(hotkey) {
            if (hotkey.action.groupId) {
                hotkey.groupId = hotkey.action.groupId;
            }

            hotkey.action = hotkey.action.id;
        });

        removeKeys('browserActionIconColor');
    }

    if (ifVersionInDataLessThan('3.1')) {
        if (!data.thumbnails) {
            data.thumbnails = {};
        }

        data.groups.forEach(function(group) {
            group.muteTabsWhenGroupCloseAndRestoreWhenOpen = false;
            group.showTabAfterMovingItIntoThisGroup = false;

            group.tabs.forEach(function(tab) {
                if (tab.thumbnail && tab.url && !data.thumbnails[tab.url]) {
                    data.thumbnails[tab.url] = tab.thumbnail;
                }

                delete tab.thumbnail;
            });
        });
    }


    data.version = currentVersion;

    if (keysToRemoveFromStorage.length) {
        await storage.remove(keysToRemoveFromStorage);
    }
    // end migration

    return data;
}

const NEW_TAB_URL = '/stg-newtab/newtab.html';

async function removeSTGNewTabUrls(windows) {
    function isStgNewTabUrl(url) {
        return url.startsWith('moz-extension') && url.includes(NEW_TAB_URL);
    }

    function revokeStgNewTabUrl(url) {
        return new URL(url).searchParams.get('url');
    }

    return Promise.all(
        windows
            .map(async function(win) {
                await Promise.all(
                    win.tabs
                        .map(async function(tab) {
                            if (isStgNewTabUrl(tab.url)) {
                                tab.url = revokeStgNewTabUrl(tab.url);

                                await browser.tabs.update(tab.id, {
                                    url: tab.url,
                                    loadReplace: true,
                                });
                            }
                        })
                );

                return win;
            })
    );
}

// { reason: "update", previousVersion: "3.0.1", temporary: true }
// { reason: "install", temporary: true }
// browser.runtime.onInstalled.addListener(console.info.bind(null, 'onInstalled'));

// fix FF bug on browser.windows.getAll ... function not return all windows
async function getAllWindows() {
    let allTabs = await browser.tabs.query({
        pinned: false,
        windowType: 'normal',
    });

    let windows = await Promise.all(
        allTabs
            .reduce((acc, tab) => acc.includes(tab.windowId) ? acc : acc.concat([tab.windowId]), [])
            .map(async function(winId) {
                let win = await browser.windows.get(winId);

                if (!utils.isWindowAllow(win)) {
                    return false;
                }

                win.tabs = allTabs.filter(tab => tab.windowId === win.id);
                win.session = await getSessionDataFromWindow(win.id);

                return win;
            })
    );

    return windows.filter(Boolean);
}

async function setWindowValue(windowId, key, value = null) {
    return browser.sessions.setWindowValue(windowId, key, value);
}

async function getWindowValue(windowId, key) {
    return await browser.sessions.getWindowValue(windowId, key).catch(utils.notify) || null;
}

async function getSessionDataFromWindow(windowId) {
    return {
        groupId: await getWindowValue(windowId, 'groupId'),
    };
}

async function init() {
    let data = await storage.get(null);

    if (!Array.isArray(data.groups)) {
        utils.notify(browser.i18n.getMessage('ffFailedAndLostDataMessage'));
        data.groups = [];
    }

    data = await runMigrateForData(data); // run migration for data

    constants.allOptionsKeys.forEach(key => options[key] = key in data ? data[key] : utils.clone(constants.DEFAULT_OPTIONS[key])); // reload options

    let windows = await getAllWindows();

    if (!windows.length) {
        utils.notify(browser.i18n.getMessage('nowFoundWindowsAddonStoppedWorking'));
        return;
    }

    if (!data.doRemoveSTGNewTabUrls) {
        data.doRemoveSTGNewTabUrls = windows.some(win => win.tabs.some(tab => tab.url.startsWith('moz-extension') && tab.url.includes(NEW_TAB_URL)));
    }

    if (data.doRemoveSTGNewTabUrls) {
        windows = await removeSTGNewTabUrls(windows);
    }

    delete data.doRemoveSTGNewTabUrls;

    lastFocusedNormalWindow = windows.find(win => win.focused) || windows[0];
    lastFocusedWinId = lastFocusedNormalWindow && lastFocusedNormalWindow.id;

    let loadingRawTabs = {}; // window id : tabs that were in the loading state

    windows.forEach(function(win) {
        loadingRawTabs[win.id] = win.tabs.filter(winTab => utils.isTabVisible(winTab) && winTab.status === 'loading');
    });

    let tryCount = 0,
        tryTime = 250, // ms
        showNotificationMessageForLongTimeLoading = 90; // sec

    // waiting all tabs to load
    await new Promise(function(resolve) {
        async function checkTabs() {
            let loadingTabs = await browser.tabs.query({
                pinned: false,
                hidden: false,
                status: 'loading',
                windowType: 'normal',
            });

            if (loadingTabs.length) {
                tryCount++;

                if (Math.floor(tryCount % (1000 / tryTime * showNotificationMessageForLongTimeLoading)) === 0) {
                    utils.notify(browser.i18n.getMessage('waitingToLoadAllTabs'), undefined, 'loading-tab-message');
                }

                setTimeout(checkTabs, tryTime);
            } else {
                resolve();
            }
        }

        checkTabs();
    });

    browser.notifications.clear('loading-tab-message');

    windows = await getAllWindows();

    if (!windows.length) {
        utils.notify(browser.i18n.getMessage('nowFoundWindowsAddonStoppedWorking'));
        return;
    }

    // update saved loading tabs
    windows.forEach(function(win) {
        if (loadingRawTabs[win.id]) {
            loadingRawTabs[win.id] = loadingRawTabs[win.id]
                .map(oldTab => win.tabs.find(t => t.id === oldTab.id))
                .filter(Boolean);
        } else {
            loadingRawTabs[win.id] = [];
        }
    });

    let containers = await utils.loadContainers(),
        syncedGroupsIds = [],
        syncedTabsIds = [];

    await Promise.all(windows.map(async function(win) {
        let group = null;

        // find group which was synced with window
        if (win.session.groupId) {
            group = data.groups.find(group => group.id === win.session.groupId);
        }

        if (!group) {
            win.session.groupId = null;
            await setWindowValue(win.id, 'groupId', null);
            return;
        }

        group.windowId = win.id;
        syncedGroupsIds.push(group.id);

        if (!group.tabs.length && !loadingRawTabs[win.id].length) {
            let tabsToHide = win.tabs.filter(utils.isTabVisible).map(utils.keyId);

            if (tabsToHide.length) {
                await createTempActiveTab(win.id, false);
                await browser.tabs.hide(tabsToHide);
            }

            return;
        }

        let tempSyncedTabIds = [];

        // синхронизируем вкладки, пытаемся найти вкладки что есть в группе чтоб не создавать заново
        group.tabs.forEach(function(groupTab) {
            win.tabs.some(function(winTab) {
                if (!tempSyncedTabIds.includes(winTab.id) && winTab.url === groupTab.url) {
                    tempSyncedTabIds.push(winTab.id);
                    groupTab.id = winTab.id;
                    return true;
                }
            });
        });

        group.tabs = group.tabs.filter(tab => tab.id || utils.isUrlAllowToCreate(tab.url)); // remove missed unsupported tabs

        await Promise.all(group.tabs.filter(tab => !tab.id).map(async function(tab) {
            let newTab = await browser.tabs.create({
                active: Boolean(tab.active),
                url: tab.url,
                windowId: win.id,
                cookieStoreId: utils.normalizeCookieStoreId(tab.cookieStoreId, containers),
            });

            win.tabs.push(newTab);

            tab.id = newTab.id;
        }));

        // add loading tabs to current group
        if (loadingRawTabs[win.id].length) {
            let tabsToConcatWithGroupTabs = loadingRawTabs[win.id].filter(tab => !group.tabs.some(t => t.id === tab.id));

            if (tabsToConcatWithGroupTabs.length) {
                group.tabs = group.tabs.concat(tabsToConcatWithGroupTabs.map(mapTab));

                let loadedActiveTab = tabsToConcatWithGroupTabs.find(tab => tab.active);

                if (loadedActiveTab) {
                    group.tabs.forEach(tab => tab.active = tab.id === loadedActiveTab.id);
                }
            }
        }

        syncedTabsIds = syncedTabsIds.concat(group.tabs.map(utils.keyId));

        await showHideAndSortTabsInWindow(win, group.tabs);
    }));

    async function showHideAndSortTabsInWindow(win, groupTabs) {
        let tabsToShow = [],
            tabsToHide = [],
            groupTabsIds = groupTabs.map(utils.keyId);

        win.tabs.forEach(function(winTab) {
            if (groupTabsIds.includes(winTab.id)) {
                if (utils.isTabHidden(winTab)) {
                    tabsToShow.push(winTab);
                } else {
                    // do nothing: tab found and it's visible
                }
            } else {
                if (utils.isTabVisible(winTab)) {
                    tabsToHide.push(winTab);
                } else {
                    // do nothing: tab not found in group and it's hidden
                }
            }
        });

        if (tabsToShow.length) {
            await browser.tabs.show(tabsToShow.map(utils.keyId));
        }

        let pinnedTabs = await getPinnedTabs(win.id);

        await browser.tabs.move(groupTabsIds, {
            windowId: win.id,
            index: pinnedTabs.length,
        });

        if (tabsToHide.length) {
            let tmpTab = null,
                activeTab = groupTabs.find(tab => tab.active);

            if (activeTab) {
                if (win.tabs.some(winTab => winTab.id === activeTab.id && !winTab.active)) {
                    await browser.tabs.update(activeTab.id, {
                        active: true,
                    });
                }
            } else if (tabsToHide.some(tab => tab.active)) {
                tmpTab = await createTempActiveTab(win.id, false);
            }

            await browser.tabs.hide(tabsToHide.map(utils.keyId));

            if (tmpTab) {
                await browser.tabs.remove(tmpTab.id);
            }
        }
    }

    // find all tabs in group and in window and sync this tabs
    let missedGroupsForSync = data.groups.filter(group => !syncedGroupsIds.includes(group.id) && group.tabs.length);

    for (let group of missedGroupsForSync) {
        for (let win of windows) {
            let tempSyncedTabIds = [];

            let isAllTabsFinded = group.tabs.every(function(groupTab) {
                return win.tabs.some(function(winTab) {
                    if (!tempSyncedTabIds.includes(winTab.id) && !syncedTabsIds.includes(winTab.id) && winTab.url === groupTab.url) {
                        groupTab.id = winTab.id; // temporary set tab id
                        tempSyncedTabIds.push(winTab.id);
                        return true;
                    }
                });
            });

            if (isAllTabsFinded) {
                syncedGroupsIds.push(group.id);
                syncedTabsIds = syncedTabsIds.concat(group.tabs.map(utils.keyId));

                if (!win.session.groupId) { // sync group with window if all tabs found but window was not synchronized
                    group.windowId = win.id;
                    win.session.groupId = group.id;
                    await setWindowValue(win.id, 'groupId', group.id);

                    await showHideAndSortTabsInWindow(win, group.tabs);
                }

                break;
            }

            // if not found all tabs - clear tab ids
            group.tabs.forEach(tab => tab.id = null);
        }
    }

    // sync other tabs by max tab matches in window
    data.groups
        .filter(group => !syncedGroupsIds.includes(group.id) && group.tabs.length)
        .forEach(function(group) {
            let tabsMatches = {}; // matches: win tabs

            windows.forEach(function(win) {
                let tempSyncedTabIds = [];

                let matches = group.tabs
                    .filter(function(groupTab) {
                        return win.tabs.some(function(winTab) {
                            if (!tempSyncedTabIds.includes(winTab.id) && !syncedTabsIds.includes(winTab.id) && winTab.url === groupTab.url) {
                                tempSyncedTabIds.push(winTab.id);
                                return true;
                            }
                        });
                    })
                    .length;

                if (!tabsMatches[matches]) {
                    tabsMatches[matches] = win.tabs;
                }
            });

            let maxMatches = Math.max.apply(Math, Object.keys(tabsMatches));

            if (maxMatches) {
                group.tabs.forEach(function(groupTab) {
                    let winTab = tabsMatches[maxMatches].find(winTab => !syncedTabsIds.includes(winTab.id) && winTab.url === groupTab.url);

                    if (winTab) {
                        groupTab.id = winTab.id;
                        syncedTabsIds.push(winTab.id);
                    }
                });
            }
        });

    _groups = data.groups;

    _thumbnails = data.thumbnails;

    await storage.set(data);

    updateBrowserActionData();
    createMoveTabMenus();

    browser.browserAction.enable();

    addEvents();

    window.background.inited = true;
}

browser.browserAction.setTitle({
    title: browser.i18n.getMessage('waitingToLoadAllTabs'),
});
browser.browserAction.disable();

setLoadingToBrowserAction();

init()
    .then(function() {
        // send message for addon plugins
        sendExternalMessage({
            action: 'i-am-back',
        });
    })
    .catch(utils.notify);
