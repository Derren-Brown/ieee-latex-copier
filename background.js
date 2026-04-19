chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'DOWNLOAD_BLOB' && msg.url && msg.filename) {
    chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: true }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true, downloadId });
      }
    });
    return true;
  }
});
