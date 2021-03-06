'use strict';

const DEFAULT_COOKIE_STORE_ID = 'firefox-default';
const PRIVATE_COOKIE_STORE_ID = 'firefox-private';
const CONTEXT_MENU_PREFIX_GROUP = 'stg-move-group-id-';
const CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP = 'stg-undo-remove-group-id-';
const MANAGE_TABS_URL = '/manage/manage.html';

const groupIconViewTypes = [
    'main-squares',
    'circle',
    'squares',
    'old-tab-groups'
];

const EXTENSIONS_WHITE_LIST = {
    'stg-plugin-create-new-group@drive4ik': {
        postActions: [],
        getActions: [
            'add-new-group',
            'load-last-group',
        ],
    },
    'stg-plugin-load-custom-group@drive4ik': {
        postActions: [
            'i-am-back',
            'group-added',
            'group-updated',
            'group-removed',
        ],
        getActions: [
            'are-you-here',
            'get-groups-list',
            'load-custom-group',
        ],
    },
    'stg-plugin-manage-groups@drive4ik': {
        postActions: [],
        getActions: [
            'open-manage-groups',
        ],
    },
    '{506e023c-7f2b-40a3-8066-bc5deb40aebe}': {
        title: 'Gesturefy',
        url: 'https://addons.mozilla.org/firefox/addon/gesturefy/',
        postActions: [
            'i-am-back',
            'group-added',
            'group-updated',
            'group-removed',
        ],
        getActions: [
            'are-you-here',
            'add-new-group',
            'get-groups-list',
            'load-last-group',
            'load-first-group',
            'load-next-group',
            'load-prev-group',
            'load-custom-group',
            'delete-current-group',
            'open-manage-groups',
        ],
    },
};

const DEFAULT_OPTIONS = {
    version: '1.0',
    groups: [],
    lastCreatedGroupPosition: 0,
    thumbnails: {},

    // options
    discardTabsAfterHide: false,
    closePopupAfterChangeGroup: true,
    openGroupAfterChange: true,
    showNotificationAfterMoveTab: true,
    openManageGroupsInTab: true,
    showConfirmDialogBeforeGroupDelete: true,
    useTabsFavIconsFromGoogleS2Converter: false,
    createThumbnailsForTabs: true,

    defaultGroupIconViewType: groupIconViewTypes[0],

    hotkeys: [
        {
            ctrlKey: true,
            shiftKey: false,
            altKey: false,
            metaKey: false,
            key: '`',
            keyCode: 192,
            action: 'load-next-group',
        },
        {
            ctrlKey: true,
            shiftKey: true,
            altKey: false,
            metaKey: false,
            key: '`',
            keyCode: 192,
            action: 'load-prev-group',
        },
    ],
};

const onlyBoolOptionsKeys = (function() {
    return Object.keys(DEFAULT_OPTIONS).filter(key => 'boolean' === typeof DEFAULT_OPTIONS[key]);
})();

const allOptionsKeys = onlyBoolOptionsKeys.concat(['hotkeys', 'defaultGroupIconViewType']);

export {
    DEFAULT_COOKIE_STORE_ID,
    PRIVATE_COOKIE_STORE_ID,
    CONTEXT_MENU_PREFIX_GROUP,
    CONTEXT_MENU_PREFIX_UNDO_REMOVE_GROUP,
    MANAGE_TABS_URL,
    EXTENSIONS_WHITE_LIST,
    DEFAULT_OPTIONS,
    onlyBoolOptionsKeys,
    allOptionsKeys,
    groupIconViewTypes,
};
