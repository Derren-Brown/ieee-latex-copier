async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToTab(message) {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error('No active tab');
  return chrome.tabs.sendMessage(tab.id, message);
}

function setStatus(text) {
  document.getElementById('status').textContent = text;
}

function setOutput(text) {
  document.getElementById('output').value = text || '';
}

async function handleFull(format, download = false) {
  try {
    const res = await sendToTab({ type: 'EXTRACT_FULL', format, download });
    setOutput(res.payload || '');
    setStatus(`已提取全文。作者 ${res.authors?.length || 0} 位，正文块 ${res.body?.length || 0} 段，参考文献 ${res.references?.length || 0} 条。${download ? (res.downloaded ? ' 文件已下载。' : ' 下载失败。') : (res.copied ? ' 已复制到剪贴板。' : '')}`);
  } catch (err) {
    setStatus('提取失败。请确认当前页面为 IEEE Xplore HTML 正文页。');
  }
}

document.getElementById('rescanBtn').addEventListener('click', async () => {
  try {
    const res = await sendToTab({ type: 'RESCAN' });
    setStatus(`已扫描，检测到 ${res.count} 个公式容器。`);
  } catch {
    setStatus('当前页面不是已注入的 IEEE Xplore 页面，或页面尚未加载完成。');
  }
});

document.getElementById('copyMdBtn').addEventListener('click', () => handleFull('markdown', false));
document.getElementById('copyTxtBtn').addEventListener('click', () => handleFull('text', false));
document.getElementById('downloadMdBtn').addEventListener('click', () => handleFull('markdown', true));
document.getElementById('downloadTxtBtn').addEventListener('click', () => handleFull('text', true));

document.getElementById('copyEqBtn').addEventListener('click', async () => {
  try {
    const res = await sendToTab({ type: 'COPY_ALL_EQUATIONS' });
    setOutput(res.content || '');
    setStatus(`已处理 ${res.total} 条公式；LaTeX ${res.latex} 条，MathML ${res.mathml} 条，纯文本回退 ${res.text} 条。${res.copied ? ' 已复制到剪贴板。' : ''}`);
  } catch {
    setStatus('导出公式失败。请确认当前页面为 IEEE Xplore HTML 正文页。');
  }
});

document.getElementById('panelBtn').addEventListener('click', async () => {
  try {
    await sendToTab({ type: 'SHOW_PANEL' });
    setStatus('已在页面中打开面板。');
  } catch {
    setStatus('无法打开页面面板。');
  }
});

(async () => {
  try {
    const res = await sendToTab({ type: 'PING' });
    setStatus(`当前页面可用：${new URL(res.url).hostname}`);
  } catch {
    setStatus('请先打开 IEEE Xplore 的 HTML 论文页面。');
  }
})();
