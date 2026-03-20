// Enable side panel only on calendar.google.com
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!tab.url) return;
  const isCalendar = tab.url.startsWith("https://calendar.google.com");
  chrome.sidePanel.setOptions({ tabId, enabled: isCalendar });
});

// Relay event clicks from content script to side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "EVENT_CLICKED") {
    // Forward to all extension pages (side panel will pick it up)
    chrome.runtime.sendMessage({ type: "SHOW_DETAIL", data: message.data });
  }
});
