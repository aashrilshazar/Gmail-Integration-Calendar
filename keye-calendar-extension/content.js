// Detect clicks on Google Calendar event chips and extract the event title.
// Google Calendar uses [data-eventid] on event elements and renders a detail
// popover/dialog when an event is clicked.

(function () {
  let lastTitle = "";

  // Extract text from an element, stripping hidden/aria content
  function getText(el) {
    return (el?.textContent || "").trim();
  }

  // When a popover/dialog appears after clicking an event, extract the title
  function extractFromPopover() {
    // Google Calendar event detail popover: look for the heading inside
    // a dialog or bubble. The title is usually the first prominent text.
    const dialogs = document.querySelectorAll(
      '[role="dialog"], [data-eventid], .ecFOse, .pPTZAe'
    );
    for (const dialog of dialogs) {
      // Try known heading patterns
      const heading =
        dialog.querySelector('[data-eventid] span') ||
        dialog.querySelector('[data-eventchip] span') ||
        dialog.querySelector('span[role="heading"]') ||
        dialog.querySelector('span[data-eventid]');
      if (heading) {
        const title = getText(heading);
        if (title && title !== lastTitle) {
          lastTitle = title;
          return title;
        }
      }
    }
    return null;
  }

  // Observe DOM for popover appearance
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        // Check if this is or contains a dialog/popover
        if (
          node.matches?.('[role="dialog"]') ||
          node.querySelector?.('[role="dialog"]')
        ) {
          // Small delay for DOM to fully render
          setTimeout(() => {
            const title = extractFromPopover();
            if (title) {
              chrome.runtime.sendMessage({
                type: "EVENT_CLICKED",
                data: { eventTitle: title },
              });
            }
          }, 200);
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Also listen for clicks directly on event chips
  document.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-eventchip], [data-eventid]");
    if (!chip) return;

    // Try to get title from the chip itself
    const spans = chip.querySelectorAll("span");
    for (const span of spans) {
      const text = getText(span);
      // Event titles are usually longer than time labels
      if (text && text.length > 3 && !/^\d{1,2}(:\d{2})?\s*(am|pm)?$/i.test(text)) {
        if (text !== lastTitle) {
          lastTitle = text;
          chrome.runtime.sendMessage({
            type: "EVENT_CLICKED",
            data: { eventTitle: text },
          });
        }
        break;
      }
    }
  });
})();
