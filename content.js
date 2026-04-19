(() => {
  const BADGE_CLASS = 'ieee-latex-copier-badge';
  const PROCESSED_ATTR = 'data-ieee-latex-copier-processed';
  const COPY_STATE_ATTR = 'data-ieee-latex-copier-copy-state';
  const NOISE_SELECTOR = [
    'script:not([type^="math/"])', 'style', 'noscript', 'iframe', 'canvas', 'svg',
    'button', 'input', 'select', 'textarea', 'form',
    'nav', 'header[role="banner"]', 'footer',
    '[aria-hidden="true"]', '[hidden]',
    `.${BADGE_CLASS}`,
    '#ieee-paper-extractor-panel',
    '.cookie-banner', '.cookie-notice', '.advertisement', '.ads',
    '.toolbar', '.tools', '.utility', '.utility-nav', '.nav', '.navigation', '.menu', '.sidebar', '.sticky',
    '.metrics', '.metrics-container', '.article-actions', '.publication-actions', '.stats-document-abstract-publisher',
    '.document-banner', '.rights-and-permissions', '.permissions', '.copyright', '.xplore-header', '.xplore-footer',
    '.recommended-articles', '.recommendedForYou', '[class*="recommend"]', '[id*="recommend"]',
    '.document-banner', '.document-actions', '.stats-document-lh-action-container', '.doc-actions',
    '.article-tools', '.article-metrics', '.authors-info', '.article-header__actions'
  ].join(',');

  function isVisible(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.closest(NOISE_SELECTOR)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  }

  function normalizeWhitespace(text) {
    return (text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function normalizeTex(tex) {
    if (!tex || typeof tex !== 'string') return '';
    return tex
      .replace(/^\s*\\\(|\\\)\s*$/g, '')
      .replace(/^\s*\\\[|\\\]\s*$/g, '')
      .replace(/^\s*\$\$?|\$\$?\s*$/g, '')
      .replace(/\u00a0/g, ' ')
      .trim();
  }

  function serializeMathML(node) {
    try {
      return new XMLSerializer().serializeToString(node);
    } catch {
      return '';
    }
  }

  function textFromNode(node) {
    return normalizeWhitespace(node?.innerText || node?.textContent || '');
  }

  function unique(items) {
    return [...new Set(items.filter(Boolean))];
  }

  function slugify(text) {
    return (text || 'paper')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'paper';
  }

  function canonicalChunk(text) {
    return normalizeWhitespace(text)
      .replace(/^[-*+]\s+/gm, '')
      .replace(/^#+\s*/gm, '')
      .replace(/^\*Caption:\*\s*/gm, 'caption: ')
      .replace(/^abstract:\s*/i, '')
      .replace(/^section\s+[ivxlcdm]+\.?\s*/i, '')
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .trim();
  }

  function dedupeParagraphs(chunks) {
    const seen = new Set();
    const out = [];
    for (const chunk of chunks) {
      const key = canonicalChunk(chunk);
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(chunk);
    }
    return out;
  }

  function isProbablyMathContainer(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName.toLowerCase();
    const cls = typeof el.className === 'string' ? el.className : '';
    return (
      tag === 'mjx-container' ||
      tag === 'math' ||
      cls.includes('MathJax') ||
      el.querySelector('mjx-container, mjx-assistive-mml, math, script[type^="math/"]') !== null
    );
  }

  function uniqueByIdentity(nodes) {
    const seen = new Set();
    return nodes.filter((n) => {
      if (!n || seen.has(n)) return false;
      seen.add(n);
      return true;
    });
  }

  function extractFromScripts(scope) {
    const scripts = scope.querySelectorAll('script[type^="math/"]');
    for (const script of scripts) {
      const text = normalizeTex(script.textContent || '');
      if (text) return { format: script.type.includes('mml') ? 'mathml' : 'latex', source: text };
    }
    return null;
  }

  function extractFromAttributes(scope) {
    const attrs = ['data-tex', 'data-latex', 'data-mathml', 'aria-label', 'alt'];
    for (const el of [scope, ...scope.querySelectorAll('*')]) {
      for (const attr of attrs) {
        const value = el.getAttribute?.(attr);
        if (!value) continue;
        const trimmed = value.trim();
        if (!trimmed) continue;
        if (attr === 'data-mathml') return { format: 'mathml', source: trimmed };
        if (/[\\^_{}]|\\frac|\\sum|\\int|\\left|\\right/.test(trimmed)) {
          return { format: 'latex', source: normalizeTex(trimmed) };
        }
      }
    }
    return null;
  }

  function extractFromAssistiveMathML(scope) {
    const math = scope.querySelector('mjx-assistive-mml math, math');
    if (math) {
      const xml = serializeMathML(math);
      if (xml) return { format: 'mathml', source: xml };
    }
    return null;
  }

  function extractFromMathJaxV2(scope) {
    try {
      if (!window.MathJax || !window.MathJax.Hub || typeof window.MathJax.Hub.getAllJax !== 'function') return null;
      const jax = window.MathJax.Hub.getAllJax();
      for (const item of jax) {
        const srcEl = item.SourceElement?.();
        if (!srcEl) continue;
        if (scope.contains(srcEl) || srcEl.contains(scope) || scope === srcEl.previousElementSibling || scope === srcEl.parentElement) {
          const original = normalizeTex(item.originalText || srcEl.textContent || '');
          if (original) return { format: 'latex', source: original };
        }
      }
    } catch {}
    return null;
  }

  function extractFromMathJaxV3(scope) {
    try {
      const mj = window.MathJax;
      const getter = mj?.startup?.document?.getMathItemsWithin;
      if (typeof getter !== 'function') return null;
      const items = getter.call(mj.startup.document, [scope]);
      for (const item of items || []) {
        const candidates = [item.math, item.inputData?.originalText, item.start?.node?.textContent, item.root?.toString?.()];
        for (const candidate of candidates) {
          if (typeof candidate === 'string') {
            const text = normalizeTex(candidate);
            if (text && /[\\^_{}]|\\frac|\\sum|\\int|\\left|\\right/.test(text)) {
              return { format: 'latex', source: text };
            }
          }
        }
      }
    } catch {}
    return null;
  }

  function extractEquationSource(scope) {
    const methods = [extractFromScripts, extractFromAttributes, extractFromAssistiveMathML, extractFromMathJaxV2, extractFromMathJaxV3];
    for (const method of methods) {
      const result = method(scope);
      if (result?.source) return result;
    }

    const clone = scope.cloneNode(true);
    clone.querySelectorAll(`.${BADGE_CLASS}, button, script, style, noscript, mjx-assistive-mml`).forEach((n) => n.remove());
    const plainText = textFromNode(clone)
      .replace(/\bTeX\b/g, '')
      .replace(/\[Equation\]/gi, '')
      .trim();
    if (plainText) return { format: 'text', source: plainText };
    return { format: 'unknown', source: '' };
  }

  async function copyText(text) {
    await navigator.clipboard.writeText(text);
  }

  function setBadgeState(badge, state) {
    badge.setAttribute(COPY_STATE_ATTR, state);
    badge.textContent = state === 'copied' ? '已复制' : state === 'failed' ? '失败' : 'TeX';
  }

  function attachBadge(container) {
    if (container.getAttribute(PROCESSED_ATTR) === '1') return;
    container.setAttribute(PROCESSED_ATTR, '1');

    const badge = document.createElement('button');
    badge.className = BADGE_CLASS;
    badge.type = 'button';
    badge.textContent = 'TeX';
    badge.title = '复制该公式的 LaTeX / MathML 源';

    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(badge);

    badge.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const result = extractEquationSource(container);
      try {
        const payload = result.format === 'mathml' ? `<!-- MathML -->\n${result.source}` : result.source;
        if (!payload) throw new Error('No source extracted');
        await copyText(payload);
        setBadgeState(badge, 'copied');
        window.dispatchEvent(new CustomEvent('ieee-paper-extractor:last-copy', { detail: result }));
      } catch (err) {
        console.error('[IEEE Paper Extractor] copy failed:', err);
        setBadgeState(badge, 'failed');
      }
      setTimeout(() => setBadgeState(badge, 'idle'), 1200);
    });
  }

  function findEquationContainers(root = document) {
    const direct = [
      ...root.querySelectorAll('mjx-container'),
      ...root.querySelectorAll('.MathJax'),
      ...root.querySelectorAll('math')
    ];
    const wrappers = [];
    for (const el of direct) {
      const wrapper = el.closest('figure, .equation, .formula, .formula-container, .stats-math') || el;
      wrappers.push(wrapper);
    }
    return uniqueByIdentity(wrappers.filter(isProbablyMathContainer));
  }

  function rescan() {
    findEquationContainers().forEach(attachBadge);
  }

  function scoreRoot(node) {
    if (!node || !isVisible(node)) return 0;
    const text = textFromNode(node);
    const paragraphs = node.querySelectorAll('p').length;
    const headings = node.querySelectorAll('h1,h2,h3,h4').length;
    const figures = node.querySelectorAll('figure, figcaption, .figcaption').length;
    const refs = node.querySelectorAll('.reference-container, .references, #ref_wrap, .ref').length;
    const articleHints = /abstract|introduction|references|conclusion|system model|results/i.test(text.slice(0, 5000)) ? 1200 : 0;
    const noisePenalty = /(ieee xplore|create account|personal sign in|recommended for you|alerts manage content alerts)/i.test(text.slice(0, 2000)) ? 1800 : 0;
    return text.length + paragraphs * 400 + headings * 120 + figures * 60 + refs * 50 + articleHints - noisePenalty;
  }


  function detectMainRoot() {
    const preferredSelectors = [
      '#article',
      '#full-text-section #article',
      '.document-text.show-full-text #article',
      '.document-text #article',
      '#full-text-section .document-text',
      '.document-text.show-full-text',
      '.document-text',
      '#full-text-section',
      '.document-full-text-content',
      '.stats-document-container-fullTextSection',
      '#BodyWrapper .ArticlePage #article'
    ];

    const preferred = uniqueByIdentity(preferredSelectors
      .map((selector) => document.querySelector(selector))
      .filter((node) => node && isVisible(node)));

    if (preferred.length) {
      let best = preferred[0];
      let bestScore = -Infinity;
      for (const node of preferred) {
        const text = textFromNode(node);
        const score =
          (node.id === 'article' ? 500000 : 0) +
          (/(^|\\b)(introduction|system model|problem formulation|simulation results|conclusion|references)(\\b|$)/i.test(text.slice(0, 3000)) ? 8000 : 0) +
          scoreRoot(node);
        if (score > bestScore) {
          best = node;
          bestScore = score;
        }
      }
      return best;
    }

    const candidates = uniqueByIdentity([
      document.querySelector('article'),
      document.querySelector('main'),
      document.querySelector('#BodyWrapper'),
      document.querySelector('#Body'),
      document.querySelector('.ArticlePage'),
      document.querySelector('[class*="article"]'),
      document.querySelector('[id*="article"]'),
      document.querySelector('[class*="document"]'),
      document.querySelector('[id*="document"]'),
      ...Array.from(document.querySelectorAll('div, section')).filter((el) => scoreRoot(el) > 5000)
    ].filter(Boolean));

    let best = document.body;
    let bestScore = 0;
    for (const candidate of candidates) {
      const s = scoreRoot(candidate);
      if (s > bestScore) {
        best = candidate;
        bestScore = s;
      }
    }
    return best;
  }


  function extractMetaList(name) {
    return unique(Array.from(document.querySelectorAll(`meta[name="${name}"]`)).map((m) => normalizeWhitespace(m.content)));
  }

  function extractTitle() {
    return normalizeWhitespace(
      document.querySelector('meta[name="citation_title"]')?.content ||
      document.querySelector('meta[property="og:title"]')?.content ||
      document.querySelector('h1')?.textContent ||
      document.title.replace(/^IEEE Xplore\s*[-:|]\s*/i, '')
    );
  }

  function extractAuthors() {
    const metaAuthors = extractMetaList('citation_author');
    if (metaAuthors.length) return metaAuthors;
    const domAuthors = unique(Array.from(document.querySelectorAll('#authorData, .authors .author, [class*="author-name"], [data-testid*="author"]'))
      .map((el) => normalizeWhitespace(el.textContent))
      .filter((x) => x && x.length < 150));
    return domAuthors;
  }

  function extractAbstract() {
    const candidates = [
      document.querySelector('meta[name="citation_abstract"]')?.content,
      document.querySelector('meta[name="description"]')?.content,
      document.querySelector('meta[name="dc.Description"]')?.content,
      document.querySelector('p.abstract')?.textContent,
      document.querySelector('.abstract')?.textContent,
      document.querySelector('[class*="abstract"] p')?.textContent
    ].map(normalizeWhitespace).filter(Boolean);
    let best = '';
    for (const item of candidates) {
      if (item.length > best.length) best = item;
    }
    return best.replace(/^Abstract:\s*/i, '').trim();
  }

  function shouldSkipText(text, abstract = '') {
    const t = normalizeWhitespace(text);
    if (!t) return true;
    if (t.length <= 1 && !/^[A-Za-z0-9]+$/.test(t)) return true;
    if (abstract) {
      const ct = canonicalChunk(t);
      const ca = canonicalChunk(abstract);
      if (ct === ca || ct === `abstract: ${ca}` || ct.startsWith(`abstract: ${ca}`)) return true;
    }
    if (/^(ieee\.org|ieee xplore|ieee sa|ieee spectrum|more sites|donate|cart|create account|personal sign in)$/i.test(t)) return true;
    if (/^alerts(?:\s*alerts)?(?: manage content alerts add to citation alerts)?$/i.test(t)) return true;
    if (/^recommended for you/i.test(t)) return true;
    if (/^source:\s*https?:\/\//i.test(t)) return false;
    if (/^(published in:|date of publication:|issn information:?|doi:|funding agency:?|page\(s\):)/i.test(t)) return true;
    if (/^authorized licensed use limited to:/i.test(t)) return true;
    if (/^\d{4}-\d{4}\s+©\s*\d{4}\s+ieee/i.test(t)) return true;
    if (/rights? (and|&) permissions/i.test(t)) return true;
    if (/restrictions apply\.?$/i.test(t)) return true;
    if (/^download(ed)?\b/i.test(t) && t.length < 120) return true;
    return false;
  }

  function cleanInlineText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(NOISE_SELECTOR).forEach((n) => n.remove());
    clone.querySelectorAll(`.${BADGE_CLASS}`).forEach((n) => n.remove());
    clone.querySelectorAll('mjx-container, .MathJax, math').forEach((mathNode) => {
      mathNode.replaceWith(document.createTextNode(' '));
    });
    return normalizeWhitespace(clone.innerText || clone.textContent || '');
  }

  function splitStructuralText(text) {
    let t = normalizeWhitespace(text);
    if (!t) return [];

    t = t
      .replace(/Abstract:\s*/gi, '')
      .replace(/Published in:.*?(?=(?:SECTION\s+[IVXLC]+|[A-Z]\.\s+[A-Z]|##|###|$))/gi, '')
      .replace(/Date of Publication:.*?(?=(?:SECTION\s+[IVXLC]+|[A-Z]\.\s+[A-Z]|##|###|$))/gi, '')
      .replace(/ISSN Information:?.*?(?=(?:SECTION\s+[IVXLC]+|[A-Z]\.\s+[A-Z]|##|###|$))/gi, '')
      .replace(/DOI:.*?(?=(?:SECTION\s+[IVXLC]+|[A-Z]\.\s+[A-Z]|##|###|$))/gi, '')
      .replace(/Funding Agency:?.*?(?=(?:SECTION\s+[IVXLC]+|[A-Z]\.\s+[A-Z]|##|###|$))/gi, '')
      .replace(/(SECTION\s+[IVXLC]+)\.?\s*([A-Z][A-Za-z\- ]{2,80}?)(?=[A-Z][a-z])/g, '\n\n## $2\n\n')
      .replace(/([.!?])\s*([A-Z]\.\s+[A-Z][A-Za-z\- ]{2,80}?)(?=[A-Z][a-z])/g, '$1\n\n### $2\n\n')
      .replace(/^([A-Z]\.\s+[A-Z][A-Za-z\- ]{2,80}?)(?=[A-Z][a-z])/g, '### $1\n\n')
      .replace(/([a-z0-9\]\)])([A-Z]\.\s+[A-Z])/g, '$1\n\n### $2')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const parts = t.split(/\n{2,}/).map(normalizeWhitespace).filter(Boolean);
    return parts;
  }

  function extractOrderedBody(root, abstract = '') {
    const pieces = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (!isVisible(node)) return NodeFilter.FILTER_REJECT;
        if (node.closest(NOISE_SELECTOR)) return NodeFilter.FILTER_REJECT;
        const tag = node.tagName?.toLowerCase();
        const keep = ['h1','h2','h3','h4','h5','h6','p','li','figcaption','caption','blockquote','pre','table'];
        if (keep.includes(tag)) return NodeFilter.FILTER_ACCEPT;
        if (isProbablyMathContainer(node)) return NodeFilter.FILTER_ACCEPT;
        if (tag === 'div' && /figcaption|caption|reference-item|reference\b/i.test(node.className || '')) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      }
    });

    let node;
    while ((node = walker.nextNode())) {
      if (node.closest('figure figcaption, .figcaption') && node.tagName?.toLowerCase() !== 'figcaption' && !/figcaption/i.test(node.className || '')) continue;

      const tag = node.tagName.toLowerCase();

      if (isProbablyMathContainer(node)) {
        if (node.parentElement?.closest('mjx-container, .MathJax, math')) continue;
        const eq = extractEquationSource(node);
        const src = (eq.source || '').trim();
        const isMeaningfulDisplayEq = eq.format === 'latex' && src.length >= 8 && /(?:=|\\frac|\\sum|\\int|\\log|\\min|\\max|\\mathcal|\\mathbf|\\begin|\\approx|\\leq|\\geq|\^|_)/.test(src);
        if (isMeaningfulDisplayEq) pieces.push(`$$\n${src}\n$$`);
        continue;
      }

      if (tag === 'table') {
        const rows = Array.from(node.querySelectorAll('tr'))
          .map((tr) => Array.from(tr.children).map((c) => cleanInlineText(c)).join(' | '))
          .filter(Boolean);
        if (rows.length) pieces.push(rows.join('\n'));
        continue;
      }

      let text = cleanInlineText(node);
      if (!text) continue;
      if (canonicalChunk(text) === canonicalChunk(document.title.replace(/^IEEE Xplore\s*[-:|]\s*/i, ''))) continue;
      if (shouldSkipText(text, abstract)) continue;

      if (/^h[1-6]$/.test(tag)) {
        const level = Number(tag.slice(1));
        pieces.push(`${'#'.repeat(Math.min(level + 1, 6))} ${text}`);
      } else if (tag === 'li') {
        pieces.push(`- ${text}`);
      } else if (tag === 'figcaption' || /figcaption/i.test(node.className || '') || tag === 'caption') {
        pieces.push(`*Caption:* ${text}`);
      } else {
        pieces.push(text);
      }
    }

    const split = pieces.flatMap((piece) => {
      if (/^\$\$[\s\S]*\$\$$/.test(piece) || /^\*Caption:\*/.test(piece) || /^[-#]/.test(piece)) return [piece];
      return splitStructuralText(piece);
    }).filter((piece) => !shouldSkipText(piece, abstract));

    return dedupeParagraphs(split);
  }




  function hasClassToken(el, token) {
    return !!(el && el.classList && el.classList.contains(token));
  }

  function isDisplayFormulaElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName.toLowerCase();
    const cls = typeof el.className === 'string' ? el.className : '';
    return (
      tag === 'disp-formula' ||
      hasClassToken(el, 'display-formula') ||
      tag === 'mjx-container' && el.getAttribute('display') === 'true' ||
      tag === 'math' && el.getAttribute('display') === 'block' ||
      cls.includes('MathJax_Display')
    );
  }

  function isInlineFormulaElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName.toLowerCase();
    const cls = typeof el.className === 'string' ? el.className : '';
    return (
      tag === 'inline-formula' ||
      hasClassToken(el, 'inline-formula') ||
      (tag === 'tex-math' && !!el.closest('inline-formula, .inline-formula')) ||
      (cls.includes('MathJax') && !!el.closest('inline-formula, .inline-formula'))
    );
  }

  function isFormulaNoiseElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName.toLowerCase();
    const cls = typeof el.className === 'string' ? el.className : '';
    if (tag === 'script' && /^math\//i.test(el.type || '')) return true;
    if (hasClassToken(el, 'MathJax_Preview')) return true;
    if (tag === 'span' && hasClassToken(el, 'formula')) return true;
    if (tag === 'span' && hasClassToken(el, 'link') && !!el.closest('disp-formula, .display-formula')) return true;
    if (tag === 'img') {
      const alt = `${el.getAttribute('alt') || ''} ${el.getAttribute('title') || ''}`.trim();
      if (/right-click on figure|mathml|additional features|icon\.support/i.test(alt)) return true;
    }
    return false;
  }

  function serializeRichInline(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const el = node;
    if (el.closest(NOISE_SELECTOR)) return '';
    if (isFormulaNoiseElement(el)) return '';

    const tag = el.tagName.toLowerCase();

    if (isDisplayFormulaElement(el)) {
      const src = normalizeTex(extractEquationSource(el).source || '');
      return src ? `\n\n$$\n${src}\n$$\n\n` : '';
    }

    if (isInlineFormulaElement(el)) {
      const src = normalizeTex(extractEquationSource(el).source || '');
      return src ? ` $${src}$ ` : '';
    }

    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'button' || tag === 'svg' || tag === 'canvas' || tag === 'iframe') {
      return '';
    }

    if (tag === 'br') return '\n';

    if (tag === 'img') {
      const alt = normalizeWhitespace(el.getAttribute('alt') || el.getAttribute('title') || '');
      return alt ? ` ${alt} ` : '';
    }

    if (tag === 'a') {
      return Array.from(el.childNodes).map(serializeRichInline).join('') || normalizeWhitespace(el.textContent || '');
    }

    return Array.from(el.childNodes).map(serializeRichInline).join('');
  }

  function normalizeMixedMarkdown(text) {
    if (!text) return '';
    const blocks = [];
    const placeholder = (idx) => `@@IEEE_EQ_${idx}@@`;

    let t = text.replace(/\n\s*\$\$[\s\S]*?\$\$\s*\n/g, (match) => {
      const cleaned = match
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      blocks.push(cleaned);
      return ` ${placeholder(blocks.length - 1)} `;
    });

    t = normalizeWhitespace(t)
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .replace(/\[\s*(\d+)\s*\]/g, '[$1]')
      .replace(/View Source/gi, '')
      .replace(/Right-click on figure for MathML and additional features\.?/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    for (let i = 0; i < blocks.length; i++) {
      t = t.replace(placeholder(i), `\n\n${blocks[i]}\n\n`);
    }

    return t
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .trim();
  }

  function blockNodeToMarkdown(node) {
    const tag = node.tagName.toLowerCase();

    if (tag === 'table') {
      const rows = Array.from(node.querySelectorAll('tr'))
        .map((tr) => Array.from(tr.children).map((cell) => normalizeMixedMarkdown(serializeRichInline(cell))).filter(Boolean).join(' | '))
        .filter(Boolean);
      return rows.join('\n');
    }

    return normalizeMixedMarkdown(serializeRichInline(node));
  }

  function extractBodyStructured(root, abstract = '', title = '') {
    const selector = 'h1,h2,h3,h4,h5,h6,p,li,figcaption,caption,blockquote,pre,table';
    const nodes = Array.from(root.querySelectorAll(selector)).filter((node) => {
      if (!isVisible(node)) return false;
      if (node.closest(NOISE_SELECTOR)) return false;
      if (node.closest('#ref_wrap, .references, [class*="reference"], .glance-references')) return false;
      if (node.tagName.toLowerCase() !== 'figcaption' && node.closest('figcaption')) return false;
      if (node.tagName.toLowerCase() !== 'caption' && node.closest('caption')) return false;
      return true;
    });

    const out = [];
    for (const node of nodes) {
      const tag = node.tagName.toLowerCase();
      let text = blockNodeToMarkdown(node);
      if (!text) continue;
      if (canonicalChunk(text) === canonicalChunk(title)) continue;
      if (shouldSkipText(text, abstract)) continue;

      if (/^h[1-6]$/.test(tag)) {
        const level = Number(tag.slice(1));
        out.push(`${'#'.repeat(Math.min(level + 1, 6))} ${text}`);
      } else if (tag === 'li') {
        out.push(`- ${text}`);
      } else if (tag === 'figcaption' || tag === 'caption') {
        out.push(`*Caption:* ${text}`);
      } else {
        out.push(text);
      }
    }

    return dedupeParagraphs(out).filter((chunk) => !shouldSkipText(chunk, abstract));
  }

  function extractReferences(root) {
    const refs = unique([
      ...Array.from(root.querySelectorAll('#ref_wrap .ref, .references li, [class*="reference"] li, [class*="reference-item"]')),
      ...Array.from(root.querySelectorAll('.glance-references .ref'))
    ]);
    const texts = refs.map((ref) => cleanInlineText(ref)).filter(Boolean).filter((t) => !shouldSkipText(t));
    return dedupeParagraphs(texts);
  }



  function isDisplayMathNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    const cls = typeof node.className === 'string' ? node.className : '';
    return node.getAttribute('display') === 'true' || /display/i.test(cls) || !!node.closest('figure, .equation, .formula, .stats-math');
  }

  function replaceMathInClone(cloneRoot) {
    const nodes = Array.from(cloneRoot.querySelectorAll('mjx-container, .MathJax, math'));
    for (const node of nodes) {
      if (node.parentElement?.closest('mjx-container, .MathJax, math')) continue;
      const eq = extractEquationSource(node);
      const src = normalizeTex(eq.source || '');
      if (!src) {
        node.replaceWith(document.createTextNode(' '));
        continue;
      }
      const replacement = isDisplayMathNode(node) ? `\n\n$$\n${src}\n$$\n\n` : `$${src}$`;
      node.replaceWith(document.createTextNode(replacement));
    }
  }

  function cleanupCloneForReadableText(root) {
    const clone = root.cloneNode(true);
    clone.querySelectorAll(NOISE_SELECTOR).forEach((n) => n.remove());
    clone.querySelectorAll(`.${BADGE_CLASS}, #ieee-paper-extractor-panel`).forEach((n) => n.remove());
    clone.querySelectorAll('button, svg, canvas, iframe, style, noscript').forEach((n) => n.remove());
    clone.querySelectorAll('img').forEach((img) => {
      const alt = normalizeWhitespace(img.getAttribute('alt') || img.getAttribute('title') || '');
      if (/right-click on figure|mathml|additional features|icon.support/i.test(alt)) {
        img.remove();
      } else if (!alt) {
        img.remove();
      } else {
        img.replaceWith(document.createTextNode(` ${alt} `));
      }
    });
    clone.querySelectorAll('a').forEach((a) => {
      const txt = normalizeWhitespace(a.textContent || '');
      a.replaceWith(document.createTextNode(txt ? ` ${txt} ` : ' '));
    });
    replaceMathInClone(clone);
    clone.querySelectorAll('script, mjx-assistive-mml').forEach((n) => n.remove());
    return clone;
  }

  function lineShouldSkip(line, abstract = '', title = '') {
    const t = normalizeWhitespace(line);
    if (!t) return true;
    if (shouldSkipText(t, abstract)) return true;
    if (title && canonicalChunk(t) === canonicalChunk(title)) return true;
    if (/^view source$/i.test(t)) return true;
    if (/right-click on figure.*mathml.*additional features/i.test(t)) return true;
    if (/^javascript:void/i.test(t)) return true;
    if (/^\[\d+\]$/.test(t)) return true;
    return false;
  }

  function postProcessReadableLines(lines) {
    const out = [];
    let prev = '';
    for (let line of lines) {
      line = normalizeWhitespace(line)
        .replace(/\s*\[\s*(\d+)\s*\]\s*/g, ' [$1] ')
        .replace(/View Source/gi, '')
        .replace(/Right-click on figure for MathML and additional features\.?/gi, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/\(\s+/g, '(')
        .replace(/\s+\)/g, ')')
        .trim();
      if (!line) continue;
      const key = canonicalChunk(line);
      if (key === canonicalChunk(prev)) continue;
      prev = line;
      out.push(line);
    }
    return out;
  }

  function extractBodyFaithful(root, abstract = '', title = '') {
    const clone = cleanupCloneForReadableText(root);
    let raw = normalizeWhitespace(clone.innerText || clone.textContent || '');
    raw = raw
      .replace(/\n?View Source\n?/gi, '\n')
      .replace(/Right-click on figure for MathML and additional features\.?/gi, '')
      .replace(/\n{3,}/g, '\n\n');

    let lines = raw.split('\n').map((x) => normalizeWhitespace(x)).filter(Boolean);
    lines = lines.filter((line) => !lineShouldSkip(line, abstract, title));
    lines = postProcessReadableLines(lines);

    const blocks = [];
    let current = [];
    const flush = () => {
      const txt = normalizeWhitespace(current.join(' '));
      if (txt) blocks.push(txt);
      current = [];
    };

    for (const line of lines) {
      const isHeading = /^(section\s+[ivxlcdm]+\.?\s+|[A-Z]\.\s+|[IVXLC]+\.\s+|\d+\.\s+)/i.test(line) || /^#+\s/.test(line);
      const isDisplayEq = /^\$\$/.test(line) || /^\\begin\{/.test(line) || /^\{?\{?\\mathbf/.test(line);
      if (isHeading || isDisplayEq) {
        flush();
        blocks.push(line);
      } else if (/^[•\-]/.test(line)) {
        flush();
        blocks.push(line.replace(/^[•]\s*/, '- '));
      } else {
        current.push(line);
      }
    }
    flush();

    return dedupeParagraphs(blocks).filter((x) => !lineShouldSkip(x, abstract, title));
  }


  function buildMarkdown() {
    const root = detectMainRoot();
    const title = extractTitle();
    const authors = extractAuthors();
    const abstract = extractAbstract();
    let body = extractBodyStructured(root, abstract, title);
    body = body.filter((chunk) => canonicalChunk(chunk) !== canonicalChunk(title));
    const references = extractReferences(root);
    const url = location.href;
    const sections = [
      title ? `# ${title}` : '# Untitled IEEE Paper',
      `Source: ${url}`
    ];
    if (authors.length) sections.push(`Authors: ${authors.join('; ')}`);
    if (abstract) sections.push(`## Abstract\n\n${abstract}`);
    if (body.length) sections.push(`## Body\n\n${body.join('\n\n')}`);
    if (references.length) sections.push(`## References\n\n${references.map((x, i) => `${i + 1}. ${x}`).join('\n')}`);

    return {
      title,
      authors,
      abstract,
      body,
      references,
      markdown: normalizeWhitespace(sections.join('\n\n')),
      text: normalizeWhitespace(sections.join('\n\n').replace(/^#+\s/gm, '').replace(/^\*Caption:\*\s/gm, 'Caption: '))
    };
  }


  async function downloadFile(filename, content, mime = 'text/plain;charset=utf-8') {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    try {
      await chrome.runtime.sendMessage({ type: 'DOWNLOAD_BLOB', url, filename });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 15000);
    }
  }

  function copyAllEquations() {
    const nodes = findEquationContainers();
    const extracted = nodes.map((node, idx) => ({ idx: idx + 1, ...extractEquationSource(node) })).filter((x) => x.source);
    const content = [
      `% IEEE Paper Extractor formula export`,
      `% URL: ${location.href}`,
      `% Extracted: ${new Date().toISOString()}`,
      '',
      ...extracted.flatMap((x) => x.format === 'latex'
        ? [`% Equation ${x.idx}`, `\\[`, x.source, `\\]`, '']
        : [`% Equation ${x.idx} (${x.format})`, x.source, ''])
    ].join('\n');
    return {
      total: extracted.length,
      latex: extracted.filter((x) => x.format === 'latex').length,
      mathml: extracted.filter((x) => x.format === 'mathml').length,
      text: extracted.filter((x) => x.format === 'text').length,
      content
    };
  }

  function showPanel() {
    if (document.getElementById('ieee-paper-extractor-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'ieee-paper-extractor-panel';
    panel.innerHTML = `
      <div class="header">
        <strong>IEEE Paper Extractor</strong>
        <button type="button" class="close-btn" aria-label="Close">×</button>
      </div>
      <div class="toolbar">
        <button type="button" class="rescan-btn">重新扫描</button>
        <button type="button" class="copyall-btn">复制全文 Markdown</button>
        <button type="button" class="copyeq-btn">复制公式</button>
      </div>
      <pre class="output">等待操作…</pre>
    `;
    document.body.appendChild(panel);

    panel.querySelector('.close-btn').addEventListener('click', () => panel.remove());
    panel.querySelector('.rescan-btn').addEventListener('click', () => {
      rescan();
      panel.querySelector('.output').textContent = '已重新扫描页面。';
    });
    panel.querySelector('.copyall-btn').addEventListener('click', async () => {
      const result = buildMarkdown();
      try {
        await copyText(result.markdown);
        panel.querySelector('.output').textContent = result.markdown;
      } catch {
        panel.querySelector('.output').textContent = result.markdown;
      }
    });
    panel.querySelector('.copyeq-btn').addEventListener('click', async () => {
      const result = copyAllEquations();
      try {
        await copyText(result.content);
        panel.querySelector('.output').textContent = result.content;
      } catch {
        panel.querySelector('.output').textContent = result.content;
      }
    });

    window.addEventListener('ieee-paper-extractor:last-copy', (ev) => {
      const d = ev.detail;
      panel.querySelector('.output').textContent = d.format === 'mathml' ? `<!-- MathML -->\n${d.source}` : d.source;
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'PING') {
      sendResponse({ ok: true, url: location.href });
    } else if (msg.type === 'RESCAN') {
      rescan();
      sendResponse({ ok: true, count: findEquationContainers().length });
    } else if (msg.type === 'COPY_ALL_EQUATIONS') {
      const result = copyAllEquations();
      copyText(result.content)
        .then(() => sendResponse({ ok: true, ...result, copied: true }))
        .catch(() => sendResponse({ ok: true, ...result, copied: false }));
      return true;
    } else if (msg.type === 'EXTRACT_FULL') {
      const result = buildMarkdown();
      const baseName = slugify(result.title || 'ieee-paper');
      const payload = msg.format === 'text' ? result.text : result.markdown;
      if (msg.download) {
        downloadFile(`${baseName}.${msg.format === 'text' ? 'txt' : 'md'}`, payload)
          .then(() => sendResponse({ ok: true, ...result, payload, downloaded: true }))
          .catch((err) => sendResponse({ ok: false, error: String(err), ...result, payload, downloaded: false }));
        return true;
      }
      copyText(payload)
        .then(() => sendResponse({ ok: true, ...result, payload, copied: true }))
        .catch(() => sendResponse({ ok: true, ...result, payload, copied: false }));
      return true;
    } else if (msg.type === 'SHOW_PANEL') {
      showPanel();
      sendResponse({ ok: true });
    }
  });

  const observer = new MutationObserver(() => {
    window.clearTimeout(observer.__t);
    observer.__t = window.setTimeout(rescan, 400);
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  rescan();
})();
