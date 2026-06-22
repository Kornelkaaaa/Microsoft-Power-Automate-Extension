// Flow Finder service worker.
// Clicking the toolbar action opens the side panel. No network, no host access.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('Flow Finder: setPanelBehavior failed', err));
});
