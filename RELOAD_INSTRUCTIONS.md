# Reloading the Extension

After making changes to the extension code, you **must** reload it in Chrome for the changes to take effect.

## Quick reload steps:

1. Open **chrome://extensions** in your browser
2. Find "Limitly" in the list
3. Click the **↻ reload** button (circular arrow icon)
4. Close and reopen any popup windows
5. Refresh any blocked pages

## Common issues:

- **"Unknown message" error**: The service worker hasn't picked up new message handlers → Reload the extension
- **Changes not appearing**: Browser cached the old code → Hard reload with Ctrl+Shift+R (or Cmd+Shift+R on Mac)
- **Service worker errors**: Check the "Errors" section on chrome://extensions and reload

## Development tip:

Keep chrome://extensions open in a pinned tab during development for quick reloads.
