const assert = require('assert')
const { execFile } = require('child_process')
const { createServer } = require('http')
const { existsSync } = require('fs')
const { mkdtemp, readFile, rm } = require('fs/promises')
const { tmpdir } = require('os')
const path = require('path')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)
const root = path.resolve(__dirname, '..')

function findChrome() {
  const executableNames = process.platform === 'win32'
    ? ['chrome.exe', 'msedge.exe', 'chromium.exe']
    : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']
  let pathCandidate
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue
    for (const name of executableNames) {
      const candidate = path.join(directory, name)
      if (existsSync(candidate)) {
        pathCandidate = candidate
        break
      }
    }
    if (pathCandidate) break
  }
  const candidates = [
    process.env.CHROME_BIN,
    process.platform === 'win32'
      ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
      : undefined,
    process.platform === 'win32'
      ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
      : undefined,
    process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined,
    process.platform === 'darwin'
      ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
      : undefined,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    pathCandidate,
  ]
  return candidates.find((candidate) => candidate && existsSync(candidate))
}

function testPage() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="/main.css">
  <style>body{margin:0}#vmd-test-result{position:fixed;z-index:99999}</style>
</head>
<body>
  <div id="vmd-test-result">pending</div>
  <div id="app"></div>
  <script>
    window.__vmdMessages = [];
    window.__vmdCodeCopyAttempts = 0;
    window.__vmdClipboardText = '';
    window.__vmdForceDeleteFailure = false;
    const nativeExecCommand = document.execCommand.bind(document);
    document.execCommand = (command, ...args) => {
      if (command === 'copy') {
        window.__vmdCodeCopyAttempts += 1;
        window.__vmdClipboardText = document.activeElement?.value || '';
        return true;
      }
      if (command === 'delete' && window.__vmdForceDeleteFailure) return false;
      return nativeExecCommand(command, ...args);
    };
    window.__vmdInstalledExecCommand = document.execCommand;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(value) {
          window.__vmdClipboardText = String(value);
          return Promise.resolve();
        },
      },
    });
    window.acquireVsCodeApi = () => ({ postMessage(message) { window.__vmdMessages.push(message); } });
    window.addEventListener('error', (event) => {
      window.__vmdRuntimeError = event.error && event.error.stack
        ? event.error.stack
        : event.message;
      document.body.dataset.vmdTest = 'failed';
      document.getElementById('vmd-test-result').textContent = 'runtime: ' + window.__vmdRuntimeError;
    });
    window.addEventListener('unhandledrejection', (event) => {
      window.__vmdRuntimeError = event.reason && event.reason.stack
        ? event.reason.stack
        : String(event.reason);
      document.body.dataset.vmdTest = 'failed';
      document.getElementById('vmd-test-result').textContent = 'rejection: ' + window.__vmdRuntimeError;
    });
  </script>
  <script src="/main.js"></script>
  <script>
    const result = document.getElementById('vmd-test-result');
    const wait = (predicate, timeout = 5000) => new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      const check = () => {
        if (predicate()) return resolve();
        if (Date.now() >= deadline) {
          return reject(new Error(
            'Timed out waiting for editor state at ' + testCheckpoint
          ));
        }
        setTimeout(check, 10);
      };
      check();
    });
    const pause = (milliseconds = 20) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const root = () => document.querySelector('.vditor-wysiwyg .vditor-reset');
    const textNode = (element, minimumLength = 1) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && node.textContent.length < minimumLength) {
        node = walker.nextNode();
      }
      if (!node) throw new Error('Expected a text node');
      return node;
    };
    const select = (startNode, startOffset, endNode, endOffset) => {
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const atomicBlockSelector = [
      '.vditor-wysiwyg__block[data-type="code-block"]',
      '.vditor-wysiwyg__block[data-type="math-block"]',
      '.vditor-wysiwyg__block[data-type="html-block"]',
    ].join(', ');
    const atomicGapPoint = (block, side) => {
      const rect = block.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      for (let distance = 1; distance <= 32; distance += 1) {
        const y = side === 'above' ? rect.top - distance : rect.bottom + distance;
        const hit = document.elementFromPoint(x, y);
        const pointRange = document.caretRangeFromPoint?.(x, y);
        const pointElement = pointRange?.startContainer instanceof Element
          ? pointRange.startContainer
          : pointRange?.startContainer?.parentElement;
        if (
          hit &&
          pointElement?.closest(atomicBlockSelector) === block &&
          !block.contains(hit)
        ) {
          return { hit, x, y };
        }
      }
      return null;
    };
    const selectTextOccurrence = (element, query, collapseAtEnd = false) => {
      const nodes = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
      const joined = nodes.map((node) => node.textContent).join('');
      const start = joined.indexOf(query);
      if (start < 0) throw new Error('Could not select text occurrence: ' + query);
      const end = collapseAtEnd ? start + query.length : start + query.length;
      const position = (offset) => {
        let remaining = offset;
        for (const node of nodes) {
          if (remaining <= node.textContent.length) return [node, remaining];
          remaining -= node.textContent.length;
        }
        const last = nodes[nodes.length - 1];
        return [last, last.textContent.length];
      };
      const [startNode, startOffset] = position(collapseAtEnd ? end : start);
      const [endNode, endOffset] = position(end);
      select(startNode, startOffset, endNode, endOffset);
      return startNode;
    };
    const listButton = () => document.querySelector('.vditor-toolbar [data-type="list"]');
    const orderedListButton = () => document.querySelector('.vditor-toolbar [data-type="ordered-list"]');
    const selectedTableCell = () => {
      const range = window.getSelection().getRangeAt(0);
      const element = range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement;
      return element.closest('td, th');
    };
    let hostGeneration = 1;
    const switchMode = async (mode) => {
      if (window.vditor.vditor.currentMode === mode) return;
      const savedModesBefore = window.__vmdMessages.filter(
        (message) => message.command === 'save-options'
      ).length;
      const modeControl = document.querySelector(
        '.vditor-toolbar [data-type="vmd-edit-mode"]'
      );
      expect(modeControl, 'the toolbar editing-mode control is missing');
      modeControl.click();
      await pause();
      document.querySelector(
        '.vditor-toolbar [data-type="vmd-mode-' + mode + '"]'
      ).click();
      await wait(() => window.vditor.vditor.currentMode === mode).catch(() => {
        throw new Error(
          'toolbar mode switch timed out: expected=' + mode +
            ', actual=' + window.vditor.vditor.currentMode
        );
      });
      await pause(80);
      const savedModes = window.__vmdMessages.filter(
        (message) => message.command === 'save-options'
      );
      expect(
        savedModes.length === savedModesBefore + 1 &&
          savedModes[savedModes.length - 1].options?.mode === mode,
        'toolbar mode switching did not persist exactly one validated mode'
      );
      expect(
        document.querySelector(
          '.vditor-toolbar [data-type="vmd-mode-' + mode + '"]'
        ).getAttribute('aria-pressed') === 'true',
        'the toolbar did not mark the switched mode as selected'
      );
    };
    const setMarkdown = async (markdown) => {
      window.vditor.setValue(markdown);
      await pause();
    };
    const expect = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const lines = (...values) => values.join(String.fromCharCode(10));
    const hasLocalizedDefaultAlert = (value, before, after = '') => {
      const normalized = value.replace(/\\n+$/, '');
      const start = before + '\\n\\n> [!NOTE]\\n> ';
      const end = after ? '\\n\\n' + after : '';
      if (!normalized.startsWith(start) || (end && !normalized.endsWith(end))) {
        return false;
      }
      const bodyEnd = end ? normalized.length - end.length : normalized.length;
      const body = normalized.slice(start.length, bodyEnd);
      return !!body.trim() && !body.includes('\\n');
    };
    const removedModeName = ['i', 'r'].join('');

    let testCheckpoint = 'startup';
    (async () => {
      try {
        testCheckpoint = 'waiting for Webview ready';
        await wait(() => window.__vmdMessages.some((message) => message.command === 'ready'));
        testCheckpoint = 'waiting for initial Vditor root';
        window.dispatchEvent(new MessageEvent('message', {
          data: {
            command: 'update',
            type: 'init',
            content: 'initial',
            documentVersion: 1,
            editorGeneration: hostGeneration,
            theme: 'light',
            options: {
              mode: removedModeName,
              frontMatterDisplay: 'table',
              undoDelay: 0,
              preview: { delay: 0 },
              lang: 'en_US',
              toolbarShortcuts: { bold: 'Mod+B' },
              // cdn only covers renderers Vditor loads on demand, and is pinned
              // at the local origin so a test can never reach the network. The
              // parser path and the locale bundle are deliberately NOT set here:
              // the whole suite boots on the production defaults from main.ts.
              cdn: location.origin,
            },
          },
        }));
        await wait(() => root());
        testCheckpoint = 'waiting for initial editor baseline';
        await wait(() => window.__vmdMessages.some((message) => message.command === 'editor-baseline'));
        testCheckpoint = 'startup';
        expect(
          window.vditor.vditor.currentMode === 'wysiwyg',
          'an unsupported initialization mode did not fall back to visual editing'
        );
        expect(
          Object.prototype.hasOwnProperty.call(window.vditor.vditor, removedModeName),
          'the pinned official Vditor runtime was physically stripped'
        );
        const unusedModeElement = document.querySelector('.vditor-' + removedModeName);
        expect(
          unusedModeElement && getComputedStyle(unusedModeElement).display === 'none',
          'the unused editor mode became visible despite the WYSIWYG fallback'
        );
        expect(
          Object.prototype.hasOwnProperty.call(window.VditorI18n, 'instant' + 'Rendering'),
          'the official locale bundle was physically stripped'
        );
        const modeControl = document.querySelector(
          '.vditor-toolbar [data-type="vmd-edit-mode"]'
        );
        expect(modeControl, 'the toolbar editing-mode control was not rendered');
        modeControl.click();
        await pause();
        const modeButtons = Array.from(
          document.querySelectorAll('.vditor-toolbar [data-type^="vmd-mode-"]')
        );
        expect(
          modeButtons.map((button) => button.dataset.type).join(',') ===
            'vmd-mode-wysiwyg,vmd-mode-sv',
          'the mode menu did not expose exactly visual and split editing'
        );
        expect(
          modeButtons[0].classList.contains('vditor-menu--current') &&
            modeButtons[0].getAttribute('aria-pressed') === 'true' &&
            modeButtons[1].getAttribute('aria-pressed') === 'false',
          'the initial visual mode was not marked as selected'
        );
        const modePanel = modeControl.parentElement.querySelector('.vditor-hint');
        expect(modePanel?.style.display === 'block', 'clicking the mode control did not open its menu');
        modeControl.classList.add('vditor-tooltipped--hover');
        expect(
          modeControl.classList.contains('vmd-toolbar-menu-open') &&
            getComputedStyle(modeControl, '::after').display === 'none',
          'opening the mode menu did not suppress its overlapping tooltip'
        );
        modeControl.classList.remove('vditor-tooltipped--hover');
        modeControl.click();
        await pause();
        expect(modePanel.style.display === 'none', 'clicking the mode control again did not close its menu');
        modeControl.classList.add('vditor-tooltipped--hover');
        expect(
          modeControl.classList.contains('vditor-tooltipped') &&
            !!modeControl.getAttribute('aria-label') &&
            getComputedStyle(modeControl, '::after').display !== 'none',
          'the toolbar tooltip was not restored after the mode menu closed'
        );
        modeControl.classList.remove('vditor-tooltipped--hover');
        const initialBaselines = window.__vmdMessages.filter((message) => message.command === 'editor-baseline');
        expect(initialBaselines.length === 1, 'initial Vditor projection did not emit exactly one baseline');
        expect(
          initialBaselines[0].documentVersion === 1 &&
          initialBaselines[0].generation === hostGeneration &&
          initialBaselines[0].projectionSerial === 1 &&
          initialBaselines[0].content.replace(/\\n+$/, '') === 'initial',
          'initial editor baseline was not paired with the init snapshot'
        );
        expect(
          document.execCommand === window.__vmdInstalledExecCommand,
          'the Webview replaced the browser execCommand implementation'
        );

        // Reaching this point already proves the parser loaded from the bundled
        // copy, since nothing set _lutePath. Assert the wiring too, so a
        // regression names the cause instead of failing as a generic timeout.
        const luteScript = document.getElementById('vditorLuteScript');
        expect(luteScript, 'Vditor never injected its parser script');
        expect(
          luteScript.src === new URL('lute.min.js', document.querySelector('script[src$="main.js"]').src).toString(),
          'the parser did not load from the copy bundled next to main.js: ' + luteScript.src
        );
        expect(!/unpkg|cdn\./.test(luteScript.src), 'the parser was fetched from a CDN');
        expect(window.Lute, 'the bundled parser did not initialize');
        // The locale is inlined at build time, so Vditor must not request one.
        expect(
          window.VditorI18n && window.VditorI18n.bold,
          'the inlined locale bundle did not populate window.VditorI18n'
        );
        expect(
          !document.querySelector('script[id^="vditorI18nScript"]'),
          'Vditor fetched a locale script despite the inlined bundle'
        );
        // Lute renders a handful of shortcodes as images rather than Unicode.
        // :octocat: is ordinary GitHub-flavored Markdown, so it must resolve to
        // the copy shipped in media/dist and not to the CDN.
        await setMarkdown('before consecutive blanks');
        const consecutiveBlankText = textNode(root().querySelector(':scope > p'));
        select(
          consecutiveBlankText,
          consecutiveBlankText.textContent.length,
          consecutiveBlankText,
          consecutiveBlankText.textContent.length
        );
        document.execCommand('insertParagraph', false);
        document.execCommand('insertParagraph', false);
        await pause(80);
        const consecutiveBlankParagraphs = root().querySelectorAll(':scope > p');
        expect(
          consecutiveBlankParagraphs.length === 3 &&
            !consecutiveBlankParagraphs[1].textContent.replace(/\\u200b/g, '').trim() &&
            !consecutiveBlankParagraphs[2].textContent.replace(/\\u200b/g, '').trim(),
          'two insertParagraph calls did not create two consecutive blank paragraphs'
        );
        select(consecutiveBlankParagraphs[2], 0, consecutiveBlankParagraphs[2], 0);
        document.querySelector('.vditor-toolbar [data-type="vmd-alert"]').click();
        await pause(80);
        expect(
          hasLocalizedDefaultAlert(
            window.vditor.getValue(),
            'before consecutive blanks'
          ),
          'Alert on consecutive blank paragraphs converted the previous content: ' +
            JSON.stringify(window.vditor.getValue())
        );


        await setMarkdown('emoji :octocat: check');
        const emojiImage = root().querySelector('img');
        expect(emojiImage, ':octocat: did not render as an image');
        expect(
          emojiImage.src === new URL('emoji/octocat.png', document.querySelector('script[src$="main.js"]').src).toString(),
          'the emoji image did not resolve next to main.js: ' + emojiImage.src
        );
        expect(!/unpkg|cdn\./.test(emojiImage.src), 'the emoji image was fetched from a CDN');

        // WYSIWYG gutter markers: the "</>" and "$$" block symbols are hidden,
        // while the heading labels stay. Removing them has to take the marker
        // out of layout, because Vditor's rule floats it with a negative margin.
        const markerFence = String.fromCharCode(96).repeat(3);
        await setMarkdown('# Heading\\n\\n' + markerFence + 'js\\nconst a = 1;\\n' + markerFence + '\\n\\n$$\\nx^2\\n$$\\n');
        await pause(120);
        const blockMarkerDisplay = (selector) => {
          const element = root().querySelector(selector);
          if (!element) return 'missing';
          return window.getComputedStyle(element, '::before').display;
        };
        expect(
          blockMarkerDisplay('.vditor-wysiwyg__block[data-type="code-block"]') === 'none',
          'the code-block "</>" marker is still laid out: ' + blockMarkerDisplay('.vditor-wysiwyg__block[data-type="code-block"]')
        );
        const mathBlock = root().querySelector('.vditor-wysiwyg__block[data-type="math-block"]');
        expect(mathBlock, 'the math block fixture did not render');
        expect(
          window.getComputedStyle(mathBlock, '::before').display === 'none',
          'the math-block "$$" marker is still laid out'
        );
        const mathSource = mathBlock.querySelector(':scope > pre:first-child');
        const mathPreview = mathBlock.querySelector(':scope > .vditor-wysiwyg__preview');
        const mathRender = mathPreview.querySelector('.language-math');
        expect(
          getComputedStyle(mathPreview).backgroundColor === 'rgba(0, 0, 0, 0)' &&
            getComputedStyle(mathRender).backgroundColor === 'rgba(0, 0, 0, 0)',
          'display formula renderers did not inherit the document background'
        );
        expect(getComputedStyle(mathSource).display === 'none', 'formula source was initially exposed');
        mathPreview.click();
        await pause(60);
        let sourcePopover = document.querySelector('.vditor-wysiwyg > .vmd-source-popover');
        expect(
          sourcePopover?.style.display !== 'block' &&
            getComputedStyle(mathSource).display === 'none',
          'ordinary display-formula clicking opened or exposed source'
        );
        mathPreview.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 80,
          clientY: 80,
        }));
        await pause();
        const mathContextEdit = document.querySelector(
          '#vmd-block-context-menu button[data-type="edit-block-source"]'
        );
        expect(mathContextEdit, 'the display-formula context menu has no explicit edit action');
        mathContextEdit.click();
        await pause(60);
        sourcePopover = document.querySelector('.vditor-wysiwyg > .vmd-source-popover');
        let sourcePopoverRect = sourcePopover.getBoundingClientRect();
        const wysiwygElement = sourcePopover.parentElement;
        const visibleMathBounds = () => {
          const rect = wysiwygElement.getBoundingClientRect();
          return {
            left: rect.left + 8,
            right: rect.left + wysiwygElement.clientWidth - 8,
            top: Math.max(rect.top, 0) + 8,
            bottom: Math.min(rect.top + wysiwygElement.clientHeight, window.innerHeight) - 8,
          };
        };
        const renderedMathTarget = () =>
          mathPreview.querySelector('.katex-display > .katex') || mathPreview;
        const isLeftOfMath = () => {
          const formulaRect = renderedMathTarget().getBoundingClientRect();
          const bounds = visibleMathBounds();
          const expectedTop = Math.max(
            bounds.top,
            Math.min(
              formulaRect.top + formulaRect.height / 2,
              bounds.bottom - sourcePopoverRect.height
            )
          );
          return Math.abs(sourcePopoverRect.right - (formulaRect.left - 6)) <= 3 &&
            Math.abs(sourcePopoverRect.top - expectedTop) <= 3 &&
            sourcePopoverRect.left >= bounds.left - 2 &&
            sourcePopoverRect.bottom <= bounds.bottom + 2;
        };
        const initialMathBounds = visibleMathBounds();
        const initialMathPositioned = sourcePopover.dataset.vmdPosition === 'left'
          ? isLeftOfMath()
          : ['above', 'below'].includes(sourcePopover.dataset.vmdPosition) &&
            sourcePopoverRect.left >= initialMathBounds.left - 2 &&
            sourcePopoverRect.right <= initialMathBounds.right + 2 &&
            sourcePopoverRect.top >= initialMathBounds.top - 2 &&
            sourcePopoverRect.bottom <= initialMathBounds.bottom + 2;
        expect(
          getComputedStyle(mathSource).display === 'none' &&
            sourcePopover.style.display === 'block' &&
            sourcePopover.querySelector('[name="source"]')?.value === 'x^2' &&
            initialMathPositioned,
          'the block formula popover was not aligned with the rendered formula'
        );
        const mathSourceInput = sourcePopover.querySelector('[name="source"]');
        mathSourceInput.style.height = (mathSourceInput.getBoundingClientRect().height + 30) + 'px';
        await pause(100);
        sourcePopoverRect = sourcePopover.getBoundingClientRect();
        const resizedMathBounds = visibleMathBounds();
        expect(
          sourcePopover.dataset.vmdPosition === 'left'
            ? isLeftOfMath()
            : sourcePopoverRect.left >= resizedMathBounds.left - 2 &&
              sourcePopoverRect.right <= resizedMathBounds.right + 2 &&
              sourcePopoverRect.top >= resizedMathBounds.top - 2 &&
              sourcePopoverRect.bottom <= resizedMathBounds.bottom + 2,
          'resizing a multiline field moved its popover outside the editor or away from the formula'
        );
        mathSourceInput.value = 'x'.repeat(180);
        mathSourceInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
        await pause(160);
        sourcePopoverRect = sourcePopover.getBoundingClientRect();
        const wideFormulaRect = renderedMathTarget().getBoundingClientRect();
        const wideBounds = visibleMathBounds();
        const expectedWideLeft = Math.max(
          wideBounds.left,
          Math.min(
            wideFormulaRect.left + wideFormulaRect.width / 2 - sourcePopoverRect.width / 2,
            wideBounds.right - sourcePopoverRect.width
          )
        );
        expect(
          wideFormulaRect.left - 6 - wideBounds.left < 320 &&
            ['above', 'below'].includes(sourcePopover.dataset.vmdPosition) &&
            Math.abs(sourcePopoverRect.left - expectedWideLeft) <= 3 &&
            sourcePopoverRect.left >= wideBounds.left - 2 &&
            sourcePopoverRect.right <= wideBounds.right + 2 &&
            sourcePopoverRect.top >= wideBounds.top - 2 &&
            sourcePopoverRect.bottom <= wideBounds.bottom + 2,
          'a wide formula did not move its centered popover above or below inside the editor'
        );
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }));
        expect(
          getComputedStyle(mathSource).display === 'none' &&
            sourcePopover.style.display === 'none',
          'Escape exposed formula source or failed to close its popover'
        );

        const gapCodeBlock = root().querySelector(
          '.vditor-wysiwyg__block[data-type="code-block"]'
        );
        const gapCaretContainer = root();
        const gapCaretOffset = 0;
        const testedAtomicGapSides = new Set();
        for (const [label, block] of [
          ['code', gapCodeBlock],
          ['display formula', mathBlock],
        ]) {
          let testedBlockGaps = 0;
          for (const side of ['above', 'below']) {
            const point = atomicGapPoint(block, side);
            if (!point) continue;
            testedBlockGaps += 1;
            testedAtomicGapSides.add(side);
            select(
              gapCaretContainer,
              gapCaretOffset,
              gapCaretContainer,
              gapCaretOffset
            );
            const gapPointerDown = new PointerEvent('pointerdown', {
              bubbles: true,
              cancelable: true,
              button: 0,
              clientX: point.x,
              clientY: point.y,
              pointerType: 'mouse',
            });
            point.hit.dispatchEvent(gapPointerDown);
            const gapClick = new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              button: 0,
              clientX: point.x,
              clientY: point.y,
            });
            point.hit.dispatchEvent(gapClick);
            const gapRange = window.getSelection()?.getRangeAt(0);
            expect(
              gapPointerDown.defaultPrevented &&
                gapClick.defaultPrevented &&
                gapRange?.collapsed &&
                gapRange.startContainer === gapCaretContainer &&
                gapRange.startOffset === gapCaretOffset &&
                getComputedStyle(
                  block.querySelector(':scope > pre:not(.vditor-wysiwyg__preview)')
                ).display === 'none',
              'clicking the ' + side + ' ' + label +
                ' gap changed the caret or exposed source: ' + JSON.stringify({
                  pointerPrevented: gapPointerDown.defaultPrevented,
                  clickPrevented: gapClick.defaultPrevented,
                  rangeContainer: gapRange?.startContainer.parentElement?.outerHTML?.slice(0, 300),
                  rangeOffset: gapRange?.startOffset,
                  expectedOffset: gapCaretOffset,
                  sourceDisplay: getComputedStyle(
                    block.querySelector(':scope > pre:not(.vditor-wysiwyg__preview)')
                  ).display,
                  point: { x: point.x, y: point.y, target: point.hit.outerHTML?.slice(0, 300) },
                })
            );
          }
          expect(
            testedBlockGaps > 0,
            'the fixture exposed no external gap for the ' + label + ' block'
          );
        }
        expect(
          testedAtomicGapSides.has('above') && testedAtomicGapSides.has('below'),
          'the atomic gap fixtures did not cover both vertical sides'
        );

        let codeBlock = root().querySelector(
          '.vditor-wysiwyg__block[data-type="code-block"]'
        );
        let codeSource = codeBlock.querySelector(':scope > pre:not(.vditor-wysiwyg__preview)');
        let codePreview = codeBlock.querySelector(':scope > .vditor-wysiwyg__preview');
        let codePreviewCode = codePreview.querySelector(':scope > code');
        let codeLanguageLabel = codeBlock.querySelector('.vmd-code-language');
        const codeToolbar = codeBlock.querySelector('.vmd-code-toolbar');
        const codeActions = codeToolbar?.querySelector('.vmd-code-toolbar__actions');
        const codeEditButton = codeActions?.querySelector('.vmd-source-edit-button');
        const codeToolbarCopy = codeActions?.querySelector('.vditor-copy');
        const codeToolbarCopyControl = codeToolbarCopy?.querySelector('.vditor-tooltipped');
        expect(
          codeBlock.classList.contains('vmd-code-block--ordinary') &&
            codeLanguageLabel?.tagName === 'SPAN' &&
            codeLanguageLabel.textContent.includes('js') &&
            getComputedStyle(codeLanguageLabel, '::after').content === 'none' &&
            codeEditButton &&
            codeToolbarCopy &&
            codeEditButton.getBoundingClientRect().left <
              codeToolbarCopy.getBoundingClientRect().left &&
            Math.abs(
              codeEditButton.getBoundingClientRect().width -
                codeToolbarCopyControl.getBoundingClientRect().width
            ) <= 1 &&
            codeActions.getBoundingClientRect().right <=
              codeToolbar.getBoundingClientRect().right,
          'the ordinary code block did not receive its static language and right-aligned edit/copy controls: ' +
            codeBlock.outerHTML.slice(0, 2000)
        );
        expect(
          getComputedStyle(codeSource).display === 'none' &&
            getComputedStyle(codePreviewCode).display !== 'none' &&
            getComputedStyle(codePreview).cursor === 'text',
          'the idle ordinary code block did not show its preview with a text cursor'
        );

        codeLanguageLabel.click();
        codePreviewCode.click();
        const codePreviewText = textNode(codePreviewCode);
        select(codePreviewText, 2, codePreviewText, 2);
        codePreviewCode.dispatchEvent(new KeyboardEvent('keyup', {
          key: 'ArrowRight',
          bubbles: true,
          cancelable: true,
        }));
        // Arrow-key default handling can move Selection into a preview while
        // keyup still targets the paragraph/root where keydown began.
        gapCaretContainer.dispatchEvent(new KeyboardEvent('keyup', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        }));
        await pause();
        sourcePopover = document.querySelector('.vditor-wysiwyg > .vmd-source-popover');
        const guardedCodeRange = window.getSelection()?.getRangeAt(0);
        expect(
          sourcePopover?.style.display !== 'block' &&
            getComputedStyle(codeSource).display === 'none' &&
            guardedCodeRange?.collapsed &&
            codePreviewCode.contains(guardedCodeRange.startContainer),
          'ordinary code interaction or arrow-key release exposed source'
        );
        const codeBlockRectBeforePopover = codeBlock.getBoundingClientRect();
        codeEditButton.click();
        await pause();
        const codeLanguageInput = sourcePopover.querySelector('[name="language"]');
        const codeContentInput = sourcePopover.querySelector('[name="content"]');
        const codePopoverRect = sourcePopover.getBoundingClientRect();
        expect(
          sourcePopover.style.display === 'block' &&
            sourcePopover.dataset.vmdPosition === 'code-overlay' &&
            sourcePopover.classList.contains('vmd-source-popover--code-overlay') &&
            Math.abs(codePopoverRect.left - codeBlockRectBeforePopover.left) <= 2 &&
            Math.abs(codePopoverRect.top - codeBlockRectBeforePopover.top) <= 2 &&
            Math.abs(codePopoverRect.width - codeBlockRectBeforePopover.width) <= 2 &&
            Math.abs(codePopoverRect.height - codeBlockRectBeforePopover.height) <= 2 &&
            sourcePopover.querySelectorAll('.vmd-source-popover__field').length === 2 &&
            codeLanguageInput.value === 'js' &&
            codeContentInput.value === 'const a = 1;' &&
            document.activeElement === codeContentInput,
          'the ordinary code edit button did not open an exact in-place editor: ' + JSON.stringify({
            display: sourcePopover?.style.display,
            position: sourcePopover?.dataset.vmdPosition,
            block: codeBlockRectBeforePopover,
            popover: codePopoverRect,
            fields: sourcePopover?.querySelectorAll('.vmd-source-popover__field').length,
            language: codeLanguageInput?.value,
            content: codeContentInput?.value,
            active: document.activeElement?.getAttribute('name'),
            html: sourcePopover?.outerHTML.slice(0, 1200),
          })
        );
        const compactPopoverStyle = getComputedStyle(sourcePopover);
        const compactContentStyle = getComputedStyle(codeContentInput);
        const compactContentMetrics = {
          fontSize: compactContentStyle.fontSize,
          lineHeight: compactContentStyle.lineHeight,
          fontFamily: compactContentStyle.fontFamily,
        };
        expect(
          compactPopoverStyle.display === 'grid' &&
            compactPopoverStyle.maxHeight === 'none' &&
            codeContentInput.clientHeight > 0 &&
            Number.parseFloat(compactContentStyle.fontSize) <= 12 &&
            Number.parseFloat(compactContentStyle.lineHeight) /
              Number.parseFloat(compactContentStyle.fontSize) <= 1.31,
          'the in-place code editor did not preserve compact typography and usable content space: ' +
            JSON.stringify({
              display: compactPopoverStyle.display,
              maxHeight: compactPopoverStyle.maxHeight,
              clientHeight: codeContentInput.clientHeight,
              fontSize: compactContentStyle.fontSize,
              lineHeight: compactContentStyle.lineHeight,
            })
        );
        codeLanguageInput.value = 'python';
        codeLanguageInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'python' }));
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }));
        await pause(100);
        expect(
          sourcePopover.style.display === 'none' &&
            getComputedStyle(codeSource).display === 'none' &&
            window.vditor.getValue().includes(markerFence + 'python\\nconst a = 1;') &&
            codeSource.querySelector('code').classList.contains('language-python'),
          'Escape did not preserve the popover language edit while keeping source hidden'
        );
        window.vditor.vditor.undo.undo(window.vditor.vditor);
        await pause(100);
        expect(
          window.vditor.getValue().includes(markerFence + 'js\\nconst a = 1;'),
          'the popover code-language change could not be undone in one step'
        );

        // Heading labels are real controls rather than non-interactive pseudo text.
        const heading = root().querySelector('h1');
        const headingLevelButton = heading?.querySelector('.vmd-heading-level-button');
        expect(heading && headingLevelButton, 'the heading level control was not rendered');
        expect(
          window.getComputedStyle(heading, '::before').display === 'none' &&
            headingLevelButton.dataset.label === 'H1' &&
            headingLevelButton.textContent === '' &&
            headingLevelButton.getAttribute('aria-haspopup') === 'menu',
          'the heading pseudo label was not replaced by an accessible level control'
        );
        const headingText = Array.from(heading.childNodes).find(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent.includes('Heading')
        );
        select(headingText, 3, headingText, 3);
        headingLevelButton.click();
        await pause();
        const headingLevelMenu = document.getElementById('vmd-heading-level-menu');
        expect(
          headingLevelMenu?.style.display === 'block' &&
            headingLevelMenu.querySelector('[data-heading-level="1"]').getAttribute('aria-checked') === 'true',
          'clicking the heading gutter control did not open an H1-H6 menu'
        );
        headingLevelMenu.querySelector('[data-heading-level="3"]').click();
        await pause(100);
        const changedHeading = root().querySelector('h3');
        const changedSelection = window.getSelection();
        expect(
          changedHeading?.textContent === 'Heading' &&
            window.vditor.getValue().includes('### Heading') &&
            !window.vditor.getValue().includes('vmd-heading') &&
            changedSelection?.rangeCount &&
            changedHeading.contains(changedSelection.getRangeAt(0).startContainer),
          'changing the gutter heading level lost text, caret, or leaked controls into Markdown: ' +
            JSON.stringify({
              value: window.vditor.getValue(),
              heading: changedHeading?.outerHTML,
              selection: changedSelection?.rangeCount
                ? {
                    node: changedSelection.getRangeAt(0).startContainer.parentElement?.outerHTML,
                    offset: changedSelection.getRangeAt(0).startOffset,
                  }
                : null,
            })
        );
        window.vditor.vditor.undo.undo(window.vditor.vditor);
        await pause(100);
        expect(
          root().querySelector('h1 .vmd-heading-level-button') &&
            window.vditor.getValue().includes('# Heading'),
          'the heading-level change could not be undone in one step'
        );

        const keyboardHeadingButton = root().querySelector(
          'h1 .vmd-heading-level-button'
        );
        keyboardHeadingButton.click();
        await pause();
        const keyboardHeadingMenu = document.getElementById('vmd-heading-level-menu');
        const headingArrowDown = new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        });
        document.dispatchEvent(headingArrowDown);
        expect(
          headingArrowDown.defaultPrevented &&
            document.activeElement?.dataset.headingLevel === '1',
          'ArrowDown did not enter the heading menu at its first item'
        );
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'End',
          bubbles: true,
          cancelable: true,
        }));
        expect(
          document.activeElement?.dataset.headingLevel === '6',
          'End did not focus the last heading menu item'
        );
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Home',
          bubbles: true,
          cancelable: true,
        }));
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        }));
        const headingSpace = new KeyboardEvent('keydown', {
          key: ' ',
          bubbles: true,
          cancelable: true,
        });
        document.activeElement.dispatchEvent(headingSpace);
        await pause(100);
        expect(
          headingSpace.defaultPrevented &&
            keyboardHeadingMenu.style.display === 'none' &&
            root().querySelector('h2')?.textContent === 'Heading' &&
            window.vditor.getValue().includes('## Heading'),
          'shared menu keyboard navigation did not apply the selected heading level'
        );

        await setMarkdown(markerFence + 'math\\nx^2\\n' + markerFence);
        await pause(80);
        const richCodeBlock = root().querySelector(
          '.vditor-wysiwyg__block[data-type="code-block"]'
        );
        const richCodeSource = richCodeBlock.querySelector(':scope > pre:not(.vditor-wysiwyg__preview)');
        const richEditButton = richCodeBlock.querySelector('.vmd-source-edit-button');
        expect(
          richCodeBlock.classList.contains('vmd-code-block--rich') &&
            richCodeBlock.querySelector('.vmd-code-toolbar') &&
            richEditButton &&
            getComputedStyle(richCodeSource).display === 'none',
          'a rich-render code block did not receive its hover editor while hiding source'
        );
        richCodeBlock.querySelector('.language-math')?.click();
        await pause();
        expect(
          document.querySelector('.vmd-source-popover')?.style.display !== 'block',
          'clicking a rich renderer opened source without its hover edit button'
        );
        richEditButton.click();
        await pause();
        const richSourcePopover = document.querySelector('.vmd-source-popover');
        expect(
          richSourcePopover?.querySelector('[name="language"]')?.value === 'math' &&
            richSourcePopover.dataset.vmdPosition !== 'code-overlay' &&
            !richSourcePopover.classList.contains('vmd-source-popover--code-overlay') &&
            getComputedStyle(richCodeSource).display === 'none',
          'the rich renderer changed to the ordinary in-place code editor'
        );
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        // Formula, HTML block, inline HTML, and entities all use the same
        // popover while serializer-owned source remains out of layout.
        await setMarkdown(
          '# <p align="center">Centered title</p>\\n\\n' +
            '<p align="center">Selectable HTML <a href="https://example.com/raw" target="_blank"><img src="assets/raw.png" alt="raw"></a><button type="button">Action</button></p>\\n\\n' +
            'Inline $x$ and &copy; and <span>word</span>.'
        );
        await pause(160);
        const centeredHeading = root().querySelector('h1');
        const htmlBlock = root().querySelector(
          '.vditor-wysiwyg__block[data-type="html-block"]'
        );
        const htmlSource = htmlBlock.querySelector(':scope > pre:not(.vditor-wysiwyg__preview)');
        const htmlPreview = htmlBlock.querySelector(':scope > .vditor-wysiwyg__preview');
        const htmlBlockRect = htmlBlock.getBoundingClientRect();
        const htmlTopGap = atomicGapPoint(htmlBlock, 'above');
        expect(htmlTopGap, 'the raw HTML fixture exposed no upper block gap');
        const htmlGapCaretContainer = root();
        select(htmlGapCaretContainer, 0, htmlGapCaretContainer, 0);
        const htmlGapPointerDown = new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: htmlTopGap.x,
          clientY: htmlTopGap.y,
          pointerType: 'mouse',
        });
        htmlTopGap.hit.dispatchEvent(htmlGapPointerDown);
        const htmlGapClick = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: htmlTopGap.x,
          clientY: htmlTopGap.y,
        });
        htmlTopGap.hit.dispatchEvent(htmlGapClick);
        const htmlGapRange = window.getSelection()?.getRangeAt(0);
        expect(
          htmlGapPointerDown.defaultPrevented &&
            htmlGapClick.defaultPrevented &&
            htmlGapRange?.collapsed &&
            htmlGapRange.startContainer === htmlGapCaretContainer &&
            htmlGapRange.startOffset === 0 &&
            getComputedStyle(htmlSource).display === 'none',
          'clicking the raw HTML upper gap changed the caret or exposed source'
        );
        expect(
          centeredHeading.classList.contains('vmd-html-align-center') &&
            Array.from(centeredHeading.querySelectorAll('code[data-type="html-inline"]')).every(
              (token) => getComputedStyle(token).display === 'none'
            ) &&
            getComputedStyle(htmlSource).display === 'none' &&
            getComputedStyle(htmlPreview).backgroundColor === 'rgba(0, 0, 0, 0)' &&
            getComputedStyle(htmlPreview).cursor === 'text' &&
            !htmlPreview.querySelector(':scope > .vmd-source-edit-button'),
          'HTML presentation did not project alignment, transparency, direct editing, and hidden source: ' + JSON.stringify({
            heading: centeredHeading?.outerHTML,
            html: htmlBlock?.outerHTML.slice(0, 1800),
            source: htmlSource ? getComputedStyle(htmlSource).display : 'missing',
            background: htmlPreview ? getComputedStyle(htmlPreview).backgroundColor : 'missing',
          })
        );
        const htmlParagraph = htmlPreview.querySelector('p') || htmlPreview;
        const htmlSelectableText = textNode(htmlParagraph);
        select(htmlSelectableText, 0, htmlSelectableText, 'Selectable HTML'.length);
        const htmlPointerDown = new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: htmlBlockRect.left + htmlBlockRect.width / 2,
          clientY: htmlBlockRect.top + htmlBlockRect.height / 2,
          pointerType: 'mouse',
        });
        htmlParagraph.dispatchEvent(htmlPointerDown);
        const htmlSelectionBeforeClick = window.getSelection()?.toString();
        const htmlCopyTransfer = new DataTransfer();
        const htmlCopy = new ClipboardEvent('copy', {
          bubbles: true,
          cancelable: true,
          clipboardData: htmlCopyTransfer,
        });
        htmlSelectableText.dispatchEvent(htmlCopy);
        htmlParagraph.click();
        await pause();
        const htmlSelectionAfterClick = window.getSelection();
        const htmlRangeAfterClick = htmlSelectionAfterClick?.rangeCount === 1
          ? htmlSelectionAfterClick.getRangeAt(0)
          : null;
        sourcePopover = document.querySelector('.vditor-wysiwyg > .vmd-source-popover');
        expect(
          !htmlPointerDown.defaultPrevented &&
            sourcePopover?.style.display !== 'block' &&
            htmlSelectionBeforeClick === 'Selectable HTML' &&
            htmlSelectionAfterClick?.toString() === 'Selectable HTML' &&
            htmlRangeAfterClick &&
            htmlPreview.contains(htmlRangeAfterClick.startContainer) &&
            !htmlSource.contains(htmlRangeAfterClick.startContainer) &&
            htmlCopy.defaultPrevented &&
            htmlCopyTransfer.getData('text/plain').includes('Selectable HTML'),
          'HTML preview text selection was intercepted by direct source editing: ' +
            JSON.stringify({
              prevented: htmlPointerDown.defaultPrevented,
              popover: sourcePopover?.style.display,
              selectionBefore: htmlSelectionBeforeClick,
              selectionAfter: htmlSelectionAfterClick?.toString(),
              rangeContainer: htmlRangeAfterClick?.startContainer.parentElement?.outerHTML?.slice(0, 300),
              copied: htmlCopyTransfer.getData('text/plain'),
              preview: htmlPreview?.outerHTML.slice(0, 1500),
            })
        );
        const rawHtmlButton = htmlPreview.querySelector('button');
        let rawHtmlButtonClicks = 0;
        rawHtmlButton.addEventListener('click', () => {
          rawHtmlButtonClicks += 1;
        });
        rawHtmlButton.click();
        await pause();
        expect(
          rawHtmlButtonClicks === 1 &&
            getComputedStyle(htmlSource).display === 'none' &&
            document.querySelector('.vmd-source-popover')?.style.display !== 'block',
          'blocking Vditor preview clicks also blocked an HTML control or exposed source'
        );

        const htmlRightEdge = new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: htmlBlockRect.right - 2,
          clientY: htmlBlockRect.top + htmlBlockRect.height / 2,
          pointerType: 'mouse',
        });
        htmlPreview.dispatchEvent(htmlRightEdge);
        const htmlRightRange = window.getSelection()?.getRangeAt(0);
        const htmlBlockIndex = Array.from(htmlBlock.parentNode.childNodes).indexOf(htmlBlock);
        expect(
          htmlRightEdge.defaultPrevented &&
            htmlRightRange?.collapsed &&
            htmlRightRange.startContainer === htmlBlock.parentNode &&
            htmlRightRange.startOffset === htmlBlockIndex + 1,
          'clicking the HTML block right edge did not place the caret after the block: ' +
            JSON.stringify({
              prevented: htmlRightEdge.defaultPrevented,
              button: htmlRightEdge.button,
              block: htmlBlock.outerHTML.slice(0, 1000),
              previewConnected: htmlPreview.isConnected,
              rect: htmlBlockRect,
              range: htmlRightRange && {
                container: htmlRightRange.startContainer.nodeName,
                offset: htmlRightRange.startOffset,
                expectedOffset: htmlBlockIndex + 1,
                parentMatches: htmlRightRange.startContainer === htmlBlock.parentNode,
              },
            })
        );

        htmlParagraph.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 45,
          clientY: 45,
        }));
        await pause();
        const htmlContextMenu = document.getElementById('vmd-block-context-menu');
        const htmlEditSource = htmlContextMenu?.querySelector(
          'button[data-type="edit-block-source"]'
        );
        const htmlDeleteBlock = htmlContextMenu?.querySelector(
          'button[data-type="delete-block"]'
        );
        const visibleHtmlActions = Array.from(
          htmlContextMenu?.querySelectorAll('button[data-type]') || []
        ).filter((button) => getComputedStyle(button).display !== 'none');
        expect(
          htmlContextMenu?.dataset.kind === 'html-block' &&
            getComputedStyle(htmlContextMenu).display !== 'none' &&
            visibleHtmlActions.length === 2 &&
            !!htmlEditSource?.textContent.trim() &&
            !!htmlDeleteBlock?.textContent.trim(),
          'the HTML context menu did not expose complete edit and delete actions: ' +
            JSON.stringify(visibleHtmlActions.map((button) => button.textContent.trim()))
        );
        htmlEditSource.click();
        await pause();
        sourcePopover = document.querySelector('.vditor-wysiwyg > .vmd-source-popover');
        const htmlInput = sourcePopover.querySelector('[name="source"]');
        const htmlPopoverRect = sourcePopover.getBoundingClientRect();
        const htmlPreviewRect = htmlPreview.getBoundingClientRect();
        expect(
          htmlInput?.value.includes('<p align="center">') &&
            sourcePopover.dataset.vmdPosition === 'below' &&
            Math.abs(htmlPopoverRect.left - htmlPreviewRect.left) <= 2 &&
            Math.abs(htmlPopoverRect.top - htmlPreviewRect.bottom - 6) <= 2 &&
            sourcePopover.scrollHeight <= sourcePopover.clientHeight + 1 &&
            getComputedStyle(htmlSource).display === 'none',
          'the HTML context-menu action did not use the larger lower area without clipping: ' +
            JSON.stringify({
              position: sourcePopover?.dataset.vmdPosition,
              popover: htmlPopoverRect,
              preview: htmlPreviewRect,
              clientHeight: sourcePopover?.clientHeight,
              scrollHeight: sourcePopover?.scrollHeight,
            })
        );
        const rightAlignedHtmlSource = htmlInput.value.replace(
          'align="center"',
          'align="right"'
        );
        const longScrollableHtmlSource = lines(
          '<div>',
          ...Array.from(
            { length: 32 },
            (_, index) => '<span>HTML source line ' + index + '</span>'
          ),
          '</div>'
        );
        htmlInput.value = longScrollableHtmlSource;
        htmlInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'long source' }));
        await pause(80);
        const htmlInputScrollRange = htmlInput.scrollHeight - htmlInput.clientHeight;
        htmlInput.scrollTop = htmlInput.scrollHeight;
        expect(
          sourcePopover.dataset.vmdPosition === 'below' &&
            getComputedStyle(htmlInput).overflowY === 'auto' &&
            htmlInputScrollRange > 0 &&
            htmlInput.scrollTop > 0 &&
            htmlPreview.textContent.includes('HTML source line 31'),
          'a long HTML source editor could not scroll downward while refreshing its preview: ' +
            JSON.stringify({
              position: sourcePopover?.dataset.vmdPosition,
              overflow: getComputedStyle(htmlInput).overflowY,
              clientHeight: htmlInput?.clientHeight,
              scrollHeight: htmlInput?.scrollHeight,
              scrollTop: htmlInput?.scrollTop,
            })
        );
        htmlInput.value = rightAlignedHtmlSource;
        htmlInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'right' }));
        await pause(80);
        expect(
          htmlPreview.querySelector('p')?.getAttribute('align') === 'right' &&
            getComputedStyle(htmlSource).display === 'none',
          'editing raw HTML did not refresh its sanitized preview'
        );
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await pause(80);
        expect(
          window.vditor.getValue().includes('<p align="right">') &&
            !window.vditor.getValue().includes('vmd-source-edit-button'),
          'closing the HTML popover lost source or serialized its hover control'
        );

        const inlineMath = root().querySelector('span[data-type="math-inline"]');
        const inlineMathSource = inlineMath.querySelector(':scope > code');
        const inlineMathPreview = inlineMath.querySelector('.vditor-wysiwyg__preview');
        const inlineMathRect = inlineMath.getBoundingClientRect();
        const inlineMathRightEdge = new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: inlineMathRect.right - 1,
          clientY: inlineMathRect.top + inlineMathRect.height / 2,
          pointerType: 'mouse',
        });
        inlineMathPreview.dispatchEvent(inlineMathRightEdge);
        const inlineMathRightRange = window.getSelection()?.getRangeAt(0);
        const inlineMathIndex = Array.from(inlineMath.parentNode.childNodes).indexOf(inlineMath);
        expect(
          inlineMathRightEdge.defaultPrevented &&
            inlineMathRightRange?.collapsed &&
            inlineMathRightRange.startContainer === inlineMath.parentNode &&
            inlineMathRightRange.startOffset === inlineMathIndex + 1,
          'clicking the inline-formula right side did not place the caret after it'
        );
        inlineMathPreview.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: inlineMathRect.left + inlineMathRect.width / 2,
          clientY: inlineMathRect.top + inlineMathRect.height / 2,
          pointerType: 'mouse',
        }));
        inlineMathPreview.click();
        await pause();
        sourcePopover = document.querySelector('.vditor-wysiwyg > .vmd-source-popover');
        const inlineMathInput = sourcePopover.querySelector('[name="source"]');
        const inlineMathInputStyle = getComputedStyle(inlineMathInput);
        expect(
          inlineMathInputStyle.fontSize === compactContentMetrics.fontSize &&
            inlineMathInputStyle.lineHeight === compactContentMetrics.lineHeight &&
            inlineMathInputStyle.fontFamily === compactContentMetrics.fontFamily,
          'inline and block/source editing popovers do not share one input style: ' +
            JSON.stringify({
              inline: {
                font: inlineMathInputStyle.fontSize,
                line: inlineMathInputStyle.lineHeight,
                family: inlineMathInputStyle.fontFamily,
              },
              block: {
                font: compactContentMetrics.fontSize,
                line: compactContentMetrics.lineHeight,
                family: compactContentMetrics.fontFamily,
              },
            })
        );
        inlineMathInput.value = 'y';
        inlineMathInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'y' }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await pause(80);
        expect(
          getComputedStyle(inlineMathSource).display === 'none' &&
            window.vditor.getValue().includes('$y$'),
          'inline formula popover did not save while keeping source hidden'
        );

        const htmlEntity = root().querySelector('span[data-type="html-entity"]');
        const entitySource = htmlEntity.querySelector(':scope > code');
        const entityPreview = htmlEntity.querySelector('.vditor-wysiwyg__preview');
        const entityRect = htmlEntity.getBoundingClientRect();
        entityPreview.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: entityRect.left + 1,
          clientY: entityRect.top + entityRect.height / 2,
          pointerType: 'mouse',
        }));
        const entityLeftRange = window.getSelection()?.getRangeAt(0);
        const entityIndex = Array.from(htmlEntity.parentNode.childNodes).indexOf(htmlEntity);
        expect(
          entityLeftRange?.collapsed &&
            entityLeftRange.startContainer === htmlEntity.parentNode &&
            entityLeftRange.startOffset === entityIndex,
          'clicking the HTML-entity left side did not place the caret before it'
        );
        entityPreview.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: entityRect.left + entityRect.width / 2,
          clientY: entityRect.top + entityRect.height / 2,
          pointerType: 'mouse',
        }));
        entityPreview.click();
        await pause();
        sourcePopover = document.querySelector('.vditor-wysiwyg > .vmd-source-popover');
        const entityInput = sourcePopover.querySelector('[name="source"]');
        entityInput.value = '&reg;';
        entityInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: '&reg;' }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await pause(80);
        expect(
          getComputedStyle(entitySource).display === 'none' &&
            window.vditor.getValue().includes('&reg;'),
          'HTML entity popover did not save while keeping source hidden'
        );
        const inlineHtmlParagraph = Array.from(root().querySelectorAll('p')).find(
          (paragraph) => paragraph.textContent.includes('word')
        );
        expect(
          !root().querySelector('.vmd-inline-source-control') &&
            Array.from(root().querySelectorAll('code[data-type="html-inline"]')).every(
              (token) => getComputedStyle(token).display === 'none'
            ),
          'inline HTML kept its old hover edit controls or exposed serializer source'
        );
        inlineHtmlParagraph.click();
        await pause();
        expect(
          document.querySelector('.vmd-source-popover [name="source"]')?.value.startsWith('<'),
          'clicking rendered inline HTML content did not open the nearest token editor'
        );
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        const rawLinkedImage = root().querySelector(
          '.vditor-wysiwyg__block[data-type="html-block"] a img'
        );
        const rawOpenBefore = window.__vmdMessages.filter(
          (message) => message.command === 'open-link'
        ).length;
        rawLinkedImage.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
        }));
        expect(
          window.__vmdMessages.filter((message) => message.command === 'open-link').length === rawOpenBefore &&
            document.querySelector('.vmd-url-popover--image')?.style.display !== 'block',
          'plain-clicking a raw HTML linked image escaped or opened a Markdown image editor'
        );
        const rawPrimaryClick = /Mac|iPhone|iPad/.test(navigator.platform)
          ? { metaKey: true }
          : { ctrlKey: true };
        rawLinkedImage.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          ...rawPrimaryClick,
        }));
        expect(
          window.__vmdMessages.filter((message) => message.command === 'open-link').length === rawOpenBefore + 1 &&
            window.__vmdMessages.filter((message) => message.command === 'open-link').at(-1).href === 'https://example.com/raw',
          'exact Ctrl/Cmd+click did not open the raw HTML linked image exactly once'
        );

        rawLinkedImage.dispatchEvent(new MouseEvent('dblclick', {
          bubbles: true,
          cancelable: true,
        }));
        await pause();
        const vditorImageViewer = document.querySelector('.vditor-img');
        const vditorImageViewerClose = vditorImageViewer?.querySelector(
          '.vditor-img__bar .vditor-img__btn:not([data-deg])'
        );
        expect(
          vditorImageViewer && vditorImageViewerClose &&
            document.body.style.overflow === 'hidden',
          'double-clicking a raw HTML image did not open Vditor image preview'
        );
        // VS Code's Webview CSP blocks Vditor's inline onclick close handler.
        vditorImageViewerClose.removeAttribute('onclick');
        vditorImageViewerClose.click();
        expect(
          !vditorImageViewer.isConnected && document.body.style.overflow === '',
          'the CSP-safe image-preview close handler did not remove the viewer'
        );

        await setMarkdown('- Formula at line end $x$');
        await pause(80);
        const terminalFormula = root().querySelector(
          'span.vditor-wysiwyg__block[data-type="math-inline"]'
        );
        const terminalFormulaSource = terminalFormula.querySelector(':scope > code');
        const terminalFormulaPreview = terminalFormula.querySelector(
          ':scope > .vditor-wysiwyg__preview'
        );
        const terminalFormulaPreviewText = textNode(terminalFormulaPreview);
        select(
          terminalFormulaPreviewText,
          terminalFormulaPreviewText.textContent.length,
          terminalFormulaPreviewText,
          terminalFormulaPreviewText.textContent.length
        );
        const terminalFormulaRect = terminalFormula.getBoundingClientRect();
        terminalFormula.closest('li').dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: terminalFormulaRect.right + 24,
          clientY: terminalFormulaRect.top + terminalFormulaRect.height / 2,
        }));
        await pause();
        const terminalFormulaSelection = window.getSelection();
        const terminalFormulaRange = terminalFormulaSelection?.rangeCount === 1
          ? terminalFormulaSelection.getRangeAt(0)
          : null;
        expect(
          terminalFormulaRange?.collapsed &&
            terminalFormulaPreview.contains(terminalFormulaRange.startContainer) &&
            !terminalFormulaSource.contains(terminalFormulaRange.startContainer) &&
            document.querySelector('.vmd-source-popover')?.style.display !== 'block',
          'clicking after a terminal inline formula moved the caret into hidden source: ' +
            JSON.stringify({
              container: terminalFormulaRange?.startContainer.parentElement?.outerHTML?.slice(0, 500),
              source: terminalFormulaSource.outerHTML,
            })
        );

        await setMarkdown(
          '<p align="center"><img src="assets/raw.png" alt="raw image"></p>'
        );
        await pause(80);
        const imageOnlyHtmlBlock = root().querySelector(
          ':scope > .vditor-wysiwyg__block[data-type="html-block"]'
        );
        const imageOnlyHtmlSource = imageOnlyHtmlBlock.querySelector(
          ':scope > pre:not(.vditor-wysiwyg__preview)'
        );
        const imageOnlyHtmlPreview = imageOnlyHtmlBlock.querySelector(
          ':scope > .vditor-wysiwyg__preview'
        );
        const imageOnlyHtmlParagraph = imageOnlyHtmlPreview.querySelector('p');
        const imageCaretRange = document.createRange();
        imageCaretRange.selectNodeContents(imageOnlyHtmlParagraph);
        imageCaretRange.collapse(false);
        const imageCaretSelection = window.getSelection();
        imageCaretSelection.removeAllRanges();
        imageCaretSelection.addRange(imageCaretRange);
        imageOnlyHtmlParagraph.click();
        await pause();
        const preservedImageSelection = window.getSelection();
        const preservedImageRange = preservedImageSelection?.rangeCount === 1
          ? preservedImageSelection.getRangeAt(0)
          : null;
        expect(
          preservedImageRange?.collapsed &&
            imageOnlyHtmlPreview.contains(preservedImageRange.startContainer) &&
            !imageOnlyHtmlSource.contains(preservedImageRange.startContainer),
          'clicking after an HTML image moved the caret into hidden source'
        );
        root().dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Backspace',
          bubbles: true,
          cancelable: true,
        }));
        expect(
          imageOnlyHtmlBlock.classList.contains('vmd-code-block--selected'),
          'Backspace from an HTML-preview caret did not select the complete block'
        );
        root().dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }));

        // Plain link clicks edit the raw href; only Ctrl/Cmd+click follows it.
        await setMarkdown('before [visible **link**](relative/path.md?x=1#part "old title") after');
        let renderedLink = root().querySelector('a');
        const renderedStrong = renderedLink.querySelector('strong');
        const linkText = textNode(renderedStrong);
        select(linkText, 2, linkText, 2);
        const openLinksBeforePlainClick = window.__vmdMessages.filter(
          (message) => message.command === 'open-link'
        ).length;
        renderedStrong.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
        }));
        const initialUrlPopover = document.querySelector(
          '.vditor-wysiwyg > .vmd-url-popover'
        );
        expect(
          initialUrlPopover?.style.display === 'block',
          'the custom link popover was delayed beyond the click event'
        );
        expect(
          getComputedStyle(initialUrlPopover).visibility === 'hidden',
          'the link popover exposed its provisional position before moving above the target'
        );
        await Promise.resolve();
        const firstPositionedPopoverRect = initialUrlPopover.getBoundingClientRect();
        const firstPositionedTargetRect = renderedLink.getBoundingClientRect();
        expect(
          getComputedStyle(initialUrlPopover).visibility === 'visible' &&
            initialUrlPopover.dataset.vmdPosition === 'above' &&
            firstPositionedPopoverRect.bottom <= firstPositionedTargetRect.top - 3,
          'the link popover was not visible above its target at the first microtask checkpoint'
        );
        // Keep the previous debounce window available for unrelated lazy Vditor
        // renderers; first-paint positioning was asserted above.
        await pause(220);
        expect(
          window.__vmdMessages.filter((message) => message.command === 'open-link').length ===
            openLinksBeforePlainClick,
          'a plain WYSIWYG link click still opened the target'
        );
        let urlPopover = document.querySelector('.vditor-wysiwyg > .vmd-url-popover');
        let linkUrlInput = urlPopover.querySelector('.vmd-url-popover__url-input');
        expect(
          linkUrlInput.value === 'relative/path.md?x=1#part',
          'the link popover did not expose the raw Markdown href'
        );
        expect(
          document.activeElement !== linkUrlInput,
          'plain-clicking an existing link stole its text caret into the URL input'
        );
        const hiddenLinkFields = Array.from(
          urlPopover.querySelectorAll('.vmd-url-popover__hidden-field input')
        );
        expect(
          hiddenLinkFields.length === 2 &&
            hiddenLinkFields.every((input) => input.isConnected) &&
            Array.from(urlPopover.querySelectorAll(':scope > span')).filter(
              (field) => getComputedStyle(field).display !== 'none'
            ).length === 1,
          'the link popover did not reduce to one visible URL row while retaining native fields'
        );
        await pause();
        const linkPopoverRect = urlPopover.getBoundingClientRect();
        const linkTargetRect = renderedLink.getBoundingClientRect();
        expect(
          getComputedStyle(urlPopover).visibility === 'visible' &&
            getComputedStyle(urlPopover).opacity === '1' &&
            getComputedStyle(urlPopover).backgroundColor !== 'rgba(0, 0, 0, 0)' &&
            urlPopover.dataset.vmdPosition === 'above' &&
            linkPopoverRect.bottom <= linkTargetRect.top - 3,
          'the link popover was translucent or overlapped its target: popover=' + JSON.stringify({top: linkPopoverRect.top, bottom: linkPopoverRect.bottom, left: linkPopoverRect.left, height: linkPopoverRect.height, opacity: getComputedStyle(urlPopover).opacity, background: getComputedStyle(urlPopover).backgroundColor, inlineTop: urlPopover.style.top, position: urlPopover.dataset.vmdPosition}) + '; target=' + JSON.stringify({top: linkTargetRect.top, bottom: linkTargetRect.bottom})
        );
        root().dispatchEvent(new Event('scroll'));
        await Promise.resolve();
        expect(
          urlPopover.getBoundingClientRect().bottom <= renderedLink.getBoundingClientRect().top - 3,
          'Vditor scroll positioning moved the link popover back over its target'
        );
        window.dispatchEvent(new Event('resize'));
        await Promise.resolve();
        expect(
          urlPopover.dataset.vmdPosition === 'above' &&
            urlPopover.getBoundingClientRect().bottom <=
              renderedLink.getBoundingClientRect().top - 3,
          'resizing did not retain the link popover above its target'
        );
        linkUrlInput.value = 'docs/edited.md?from=popover#target';
        linkUrlInput.dispatchEvent(new Event('input', { bubbles: true }));
        await pause();
        expect(
          window.vditor.getValue().includes('docs/edited.md?from=popover#target'),
          'editing the link URL popover did not update Markdown'
        );
        const linkCopyButton = urlPopover.querySelector('.vmd-popover-copy-url');
        const linkCloseButton = urlPopover.querySelector('.vmd-popover-close');
        expect(
          linkCloseButton?.getAttribute('aria-label') &&
            urlPopover.classList.contains('vmd-url-popover--persistent'),
          'the persistent link popover did not expose an accessible close button'
        );
        linkUrlInput.focus();
        linkUrlInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        }));
        expect(document.activeElement === linkCopyButton, 'Tab did not reach the visible link copy button');
        linkCopyButton.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        }));
        expect(document.activeElement === linkCloseButton, 'Tab did not reach the visible link close button');
        linkCloseButton.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }));
        expect(document.activeElement === linkCopyButton, 'Shift+Tab did not return from close to copy');
        linkCopyButton.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }));
        expect(document.activeElement === linkUrlInput, 'Shift+Tab did not return to the visible link URL input');
        linkCopyButton.click();
        await pause();
        expect(
          window.__vmdClipboardText === 'docs/edited.md?from=popover#target',
          'the link URL copy button did not copy the current edited href'
        );

        const linkParagraph = root().querySelector('p');
        const outsideLinkText = textNode(linkParagraph);
        select(outsideLinkText, 1, outsideLinkText, 1);
        linkParagraph.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
        }));
        await pause();
        expect(
          urlPopover.style.display === 'none' &&
            !urlPopover.classList.contains('vmd-url-popover--persistent'),
          'clicking outside did not close the persistent link popover'
        );
        select(linkText, 2, linkText, 2);
        renderedStrong.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
        }));
        await Promise.resolve();
        urlPopover = document.querySelector('.vditor-wysiwyg > .vmd-url-popover');
        const linkEscape = new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        });
        document.dispatchEvent(linkEscape);
        expect(
          urlPopover.style.display === 'none' &&
            !urlPopover.classList.contains('vmd-url-popover--persistent'),
          'Escape did not close only the active link popover: ' + JSON.stringify({
            display: urlPopover?.style.display,
            persistent: urlPopover?.classList.contains('vmd-url-popover--persistent'),
            html: urlPopover?.outerHTML.slice(0, 600),
          })
        );

        renderedLink = root().querySelector('a');
        const reopenedLinkText = textNode(renderedLink.querySelector('strong'));
        select(reopenedLinkText, 1, reopenedLinkText, 1);
        renderedLink.querySelector('strong').dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
        }));
        await Promise.resolve();
        urlPopover = document.querySelector('.vditor-wysiwyg > .vmd-url-popover');
        urlPopover.querySelector('.vmd-popover-close').click();
        expect(
          urlPopover.style.display === 'none' &&
            !urlPopover.classList.contains('vmd-url-popover--persistent'),
          'the link close button did not dismiss the persistent popover'
        );
        renderedLink = root().querySelector('a');
        expect(getComputedStyle(renderedLink).cursor === 'text', 'an unmodified link did not use the text cursor');
        const primaryKey = /Mac|iPhone|iPad/.test(navigator.platform)
          ? { key: 'Meta', metaKey: true }
          : { key: 'Control', ctrlKey: true };
        document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...primaryKey }));
        expect(getComputedStyle(renderedLink).cursor === 'pointer', 'the exact primary modifier did not enable the link pointer');
        document.dispatchEvent(new KeyboardEvent('keydown', {
          bubbles: true,
          ...primaryKey,
          shiftKey: true,
        }));
        expect(getComputedStyle(renderedLink).cursor === 'text', 'a wrong modifier combination enabled the link pointer');
        document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift', ...primaryKey }));
        expect(getComputedStyle(renderedLink).cursor === 'pointer', 'releasing the wrong modifier did not restore exact-primary state');
        window.dispatchEvent(new Event('blur'));
        expect(getComputedStyle(renderedLink).cursor === 'text', 'window blur left the link pointer state stuck');
        const openLinksBeforeModifiedClick = window.__vmdMessages.filter(
          (message) => message.command === 'open-link'
        ).length;
        const primaryClick = /Mac|iPhone|iPad/.test(navigator.platform)
          ? { metaKey: true }
          : { ctrlKey: true };
        renderedLink.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          ...primaryClick,
          shiftKey: true,
        }));
        expect(
          window.__vmdMessages.filter((message) => message.command === 'open-link').length ===
            openLinksBeforeModifiedClick,
          'a primary+Shift click opened a link despite requiring the exact modifier'
        );
        renderedLink.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          ...primaryClick,
        }));
        expect(
          window.__vmdMessages.filter((message) => message.command === 'open-link').length ===
            openLinksBeforeModifiedClick + 1 &&
            window.__vmdMessages.filter((message) => message.command === 'open-link').at(-1).href ===
              'docs/edited.md?from=popover#target',
          'the platform Ctrl/Cmd+click did not open the current raw href exactly once'
        );

        await setMarkdown('insert link here');
        testCheckpoint = 'waiting for link insertion fixture';
        await wait(() => root().querySelector(':scope > p'));
        testCheckpoint = 'startup';
        const insertionText = textNode(root().querySelector(':scope > p'));
        select(insertionText, insertionText.textContent.length, insertionText, insertionText.textContent.length);
        root().dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await pause(240);
        const linkToolbarButton = document.querySelector('.vditor-toolbar [data-type="link"]');
        linkToolbarButton.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
        }));
        linkToolbarButton.click();
        testCheckpoint = 'waiting for empty link insertion popover';
        await wait(() => {
          const candidate = document.querySelector('.vditor-wysiwyg > .vmd-url-popover');
          return candidate?.style.display === 'block' &&
            candidate.querySelectorAll('input').length === 3 &&
            document.activeElement === candidate.querySelector('.vmd-url-popover__url-input');
        }).catch(() => {
          const candidate = document.querySelector('.vditor-wysiwyg > .vmd-url-popover');
          throw new Error('empty link insertion did not retain controls and redirect focus to URL: active=' + document.activeElement?.outerHTML?.slice(0, 160) + '; popover=' + candidate?.outerHTML?.slice(0, 400));
        });
        testCheckpoint = 'startup';

        // Image popovers share the wide URL editor/copy action, hide alt text,
        // and retain title editing without discarding the existing alt value.
        await setMarkdown('before ![kept alt](assets/a-very-long-image-file-name.png "Old title") after');
        const renderedImage = root().querySelector('img');
        renderedImage.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
        }));
        testCheckpoint = 'waiting for image popover';
        await wait(() => {
          const candidate = document.querySelector('.vditor-wysiwyg > .vmd-url-popover--image');
          return candidate?.style.display === 'block';
        });
        testCheckpoint = 'startup';
        urlPopover = document.querySelector('.vditor-wysiwyg > .vmd-url-popover--image');
        const imageUrlInput = urlPopover.querySelector('.vmd-url-popover__url-input');
        const imageTitleInput = urlPopover.querySelector('.vmd-url-popover__title input');
        expect(
          imageUrlInput.value === 'assets/a-very-long-image-file-name.png' &&
            imageTitleInput?.value === 'Old title',
          'the image popover did not retain its URL and title fields'
        );
        expect(
          urlPopover.querySelectorAll('.vmd-url-popover__hidden-field').length === 1 &&
            imageUrlInput.getBoundingClientRect().width > 250,
          'the image alt field remained visible or its URL editor remained too narrow'
        );
        await pause();
        const imagePopoverRect = urlPopover.getBoundingClientRect();
        const imageTargetRect = renderedImage.getBoundingClientRect();
        expect(
          getComputedStyle(urlPopover).opacity === '1' &&
            getComputedStyle(urlPopover).backgroundColor !== 'rgba(0, 0, 0, 0)' &&
            imagePopoverRect.bottom <= imageTargetRect.top - 3,
          'the image popover was translucent or overlapped its target: popover=' + JSON.stringify({top: imagePopoverRect.top, bottom: imagePopoverRect.bottom, left: imagePopoverRect.left, height: imagePopoverRect.height, opacity: getComputedStyle(urlPopover).opacity, background: getComputedStyle(urlPopover).backgroundColor, inlineTop: urlPopover.style.top, position: urlPopover.dataset.vmdPosition}) + '; target=' + JSON.stringify({top: imageTargetRect.top, bottom: imageTargetRect.bottom})
        );
        imageUrlInput.value = 'assets/edited-image.png';
        imageUrlInput.dispatchEvent(new Event('input', { bubbles: true }));
        imageTitleInput.value = 'Changed title';
        imageTitleInput.dispatchEvent(new Event('input', { bubbles: true }));
        await pause();
        expect(
          window.vditor.getValue().includes('![kept alt](assets/edited-image.png "Changed title")'),
          'editing image URL/title lost the hidden alt text or failed to update Markdown'
        );
        const imageCopyButton = urlPopover.querySelector('.vmd-popover-copy-url');
        const imageCloseButton = urlPopover.querySelector('.vmd-popover-close');
        expect(
          imageCloseButton?.getAttribute('aria-label') &&
            urlPopover.classList.contains('vmd-url-popover--persistent'),
          'the persistent image popover did not expose an accessible close button'
        );
        imageUrlInput.focus();
        imageUrlInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        }));
        expect(document.activeElement === imageCopyButton, 'Tab did not reach the image copy button');
        imageCopyButton.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        }));
        expect(document.activeElement === imageCloseButton, 'Tab did not reach the image close button');
        imageCloseButton.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        }));
        expect(document.activeElement === imageTitleInput, 'Tab did not reach the image title input');
        imageCopyButton.click();
        await pause();
        expect(
          window.__vmdClipboardText === 'assets/edited-image.png',
          'the image URL copy button did not copy the current source path'
        );
        const imageParagraph = root().querySelector('img').closest('p');
        const outsideImageText = textNode(imageParagraph);
        select(outsideImageText, 1, outsideImageText, 1);
        imageParagraph.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
        }));
        await pause();
        expect(
          urlPopover.style.display === 'none' &&
            !urlPopover.classList.contains('vmd-url-popover--persistent'),
          'clicking outside did not close the persistent image popover'
        );
        renderedImage.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
        }));
        await wait(() => urlPopover.style.display === 'block');
        urlPopover.querySelector('.vmd-popover-close').click();
        expect(
          urlPopover.style.display === 'none' &&
            !urlPopover.classList.contains('vmd-url-popover--persistent'),
          'the image close button did not dismiss the persistent popover'
        );

        await setMarkdown('[![linked alt](assets/linked.png "Image title")](target.md)');
        const linkedImage = root().querySelector('a img');
        const linkedOpenCount = window.__vmdMessages.filter(
          (message) => message.command === 'open-link'
        ).length;
        linkedImage.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
        }));
        testCheckpoint = 'waiting for linked image popover';
        await wait(() => {
          const candidate = document.querySelector('.vditor-wysiwyg > .vmd-url-popover--image');
          return candidate?.style.display === 'block';
        }).catch(() => {
          throw new Error('linked image popover timed out');
        });
        testCheckpoint = 'startup';
        expect(
          window.__vmdMessages.filter((message) => message.command === 'open-link').length ===
            linkedOpenCount &&
            document.querySelector('.vmd-url-popover--image .vmd-url-popover__url-input').value ===
              'assets/linked.png',
          'plain-clicking a linked image opened its anchor or failed to edit the image URL'
        );
        linkedImage.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          ...primaryClick,
        }));
        expect(
          window.__vmdMessages.filter((message) => message.command === 'open-link').length ===
            linkedOpenCount + 1 &&
            window.__vmdMessages.filter((message) => message.command === 'open-link').at(-1).href ===
              'target.md',
          'Ctrl/Cmd+clicking a linked image did not open its enclosing link'
        );
        await pause(120);
        const latestTodoEdit = window.__vmdMessages.filter(
          (message) => message.command === 'edit'
        ).at(-1);
        if (latestTodoEdit) {
          window.dispatchEvent(new MessageEvent('message', {
            data: {
              command: 'edit-ack',
              seq: latestTodoEdit.seq,
              documentVersion: 1,
              content: latestTodoEdit.content,
              generation: hostGeneration,
            },
          }));
          await pause();
        }

        // Vditor reports a trailing newline that the document may not have, so an
        // unchanged host snapshot must still count as already loaded. Host updates
        // are now silent: no external-change notice is ever created.
        const sendHostSnapshot = async (content, documentVersion) => {
          window.dispatchEvent(new MessageEvent('message', {
            data: {
              command: 'update',
              type: 'update',
              content: content,
              documentVersion: documentVersion,
              editorGeneration: hostGeneration,
            },
          }));
          await pause(120);
        };
        for (const blankish of ['', 'no trailing newline']) {
          await setMarkdown(blankish);
          window.dispatchEvent(new Event('focus'));
          await pause(60);
          const editsBefore = window.__vmdMessages.filter((message) => message.command === 'edit').length;
          await sendHostSnapshot(blankish, 1);
          expect(
            !document.getElementById('vmd-host-update-notice'),
            'an external-change notice was created for ' + JSON.stringify(blankish)
          );
          expect(
            window.__vmdMessages.filter((message) => message.command === 'edit').length === editsBefore,
            'treating the snapshot as already loaded still posted an edit for ' + JSON.stringify(blankish)
          );
        }

        await setMarkdown('line one\\nline two');
        const crlfEquivalentEdits = window.__vmdMessages.filter((message) => message.command === 'edit').length;
        await sendHostSnapshot('line one\\r\\nline two', 2);
        expect(
          window.vditor.getValue().replace(/\\n+$/, '') === 'line one\\nline two',
          'an LF/CRLF-equivalent host snapshot rebuilt the editor content'
        );
        expect(
          window.__vmdMessages.filter((message) => message.command === 'edit').length === crlfEquivalentEdits,
          'an LF/CRLF-equivalent host snapshot posted a false editor change'
        );
        const crlfBaseline = window.__vmdMessages.filter(
          (message) => message.command === 'editor-baseline' && message.documentVersion === 2
        ).pop();
        expect(
          crlfBaseline && crlfBaseline.content.replace(/\\n+$/, '') === 'line one\\nline two',
          'an equivalent LF/CRLF snapshot did not advance the projection baseline'
        );

        // A genuine host update applies while the editor is focused. setValue()
        // rebuilds the DOM, so the caret must be restored by its visible-text anchor.
        await setMarkdown('alpha caret target omega');
        const focusedRoot = root();
        focusedRoot.focus();
        const focusedText = textNode(focusedRoot.querySelector(':scope > p'));
        const targetEnd = focusedText.textContent.indexOf('target') + 'target'.length;
        select(focusedText, targetEnd, focusedText, targetEnd);
        window.dispatchEvent(new Event('focus'));
        await pause(20);
        await sendHostSnapshot('external prefix alpha caret target omega', 99);
        expect(
          window.vditor.getValue().includes('external prefix alpha caret target omega'),
          'a focused host update was not applied automatically'
        );
        expect(
          !document.getElementById('vmd-host-update-notice'),
          'a genuine host update created the removed external-change notice'
        );
        const restoredSelection = window.getSelection();
        expect(
          restoredSelection.rangeCount === 1 && restoredSelection.getRangeAt(0).collapsed,
          'the focused host update did not restore a collapsed caret'
        );
        const restoredRange = restoredSelection.getRangeAt(0);
        const visibleBeforeCaret = document.createRange();
        visibleBeforeCaret.selectNodeContents(root());
        visibleBeforeCaret.setEnd(restoredRange.startContainer, restoredRange.startOffset);
        expect(
          visibleBeforeCaret.toString().endsWith('caret target'),
          'the caret anchor moved during a focused host update: ' + visibleBeforeCaret.toString()
        );
        const focusedBaseline = window.__vmdMessages.filter(
          (message) => message.command === 'editor-baseline' && message.documentVersion === 99
        ).pop();
        expect(
          focusedBaseline && focusedBaseline.generation === hostGeneration &&
          focusedBaseline.content.includes('external prefix alpha caret target omega'),
          'focused host setValue did not report its final projection baseline'
        );

        // A reconciliation-only acknowledgement stays in editor space and must
        // not rebuild Vditor or create an edit loop.
        const rootBeforeFastAck = root();
        const fastAckContent = window.vditor.getValue();
        const fastAckSeq = window.__vmdPostDocumentCommand('edit', fastAckContent);
        const editsBeforeFastAck = window.__vmdMessages.filter((message) => message.command === 'edit').length;
        window.dispatchEvent(new MessageEvent('message', {
          data: {
            command: 'edit-ack',
            seq: fastAckSeq,
            documentVersion: 100,
            content: fastAckContent,
            merged: false,
            generation: hostGeneration,
          },
        }));
        await pause(80);
        expect(root() === rootBeforeFastAck, 'editor-space acknowledgement rebuilt Vditor');
        expect(
          window.__vmdMessages.filter((message) => message.command === 'edit').length === editsBeforeFastAck,
          'editor-space acknowledgement created an edit loop'
        );
        expect(
          window.__vmdMessages.some(
            (message) => message.command === 'editor-baseline' && message.documentVersion === 100
          ),
          'editor-space acknowledgement did not report its acknowledged baseline'
        );

        const repeatedText = 'a'.repeat(61);
        await setMarkdown(repeatedText);
        const repeatedRoot = root();
        repeatedRoot.focus();
        const repeatedNode = textNode(repeatedRoot.querySelector(':scope > p'));
        select(repeatedNode, repeatedNode.textContent.length, repeatedNode, repeatedNode.textContent.length);
        window.dispatchEvent(new Event('focus'));
        await sendHostSnapshot('prefix ' + repeatedText, 100);
        const repeatedSelection = window.getSelection().getRangeAt(0);
        const repeatedBeforeCaret = document.createRange();
        repeatedBeforeCaret.selectNodeContents(root());
        repeatedBeforeCaret.setEnd(repeatedSelection.startContainer, repeatedSelection.startOffset);
        expect(
          repeatedBeforeCaret.toString() === 'prefix ' + repeatedText,
          'an overlapping repeated-text anchor restored before the true caret: ' + repeatedBeforeCaret.toString().length
        );

        await setMarkdown('sync boundary');
        const syncText = textNode(root().querySelector(':scope > p'));
        select(syncText, syncText.textContent.length, syncText, syncText.textContent.length);
        const editCountBeforeBurst = window.__vmdMessages.filter((message) => message.command === 'edit').length;
        window.vditor.insertValue(' pending');
        await pause(30);
        expect(
          window.__vmdMessages.filter((message) => message.command === 'edit').length === editCountBeforeBurst,
          'typing burst posted a full-document edit before the coalescing window elapsed'
        );
        await pause(100);
        expect(
          window.__vmdMessages.filter((message) => message.command === 'edit').length === editCountBeforeBurst + 1,
          'the coalesced typing burst was not synchronized'
        );

        await setMarkdown('flush boundary');
        const flushText = textNode(root().querySelector(':scope > p'));
        select(flushText, flushText.textContent.length, flushText, flushText.textContent.length);
        const editCountBeforeBlur = window.__vmdMessages.filter((message) => message.command === 'edit').length;
        window.vditor.insertValue(' pending');
        await pause(10);
        window.dispatchEvent(new Event('blur'));
        await pause(20);
        expect(
          window.__vmdMessages.filter((message) => message.command === 'edit').length === editCountBeforeBlur + 1,
          'a pending edit was not flushed when the webview lost focus'
        );

        const outdentButton = document.querySelector('.vditor-toolbar [data-type="outdent"]');
        const indentButton = document.querySelector('.vditor-toolbar [data-type="indent"]');
        expect(outdentButton.getAttribute('aria-label').includes('Shift+Tab'), 'outdent does not advertise Shift+Tab');
        expect(indentButton.getAttribute('aria-label').includes('(Tab)'), 'indent does not advertise Tab');
        const configuredToolbar = window.vditor.vditor.options.toolbar;
        expect(configuredToolbar.find((item) => item.name === 'outdent').hotkey === '', "outdent retained Vditor's unrelated shortcut");
        expect(configuredToolbar.find((item) => item.name === 'indent').hotkey === '', "indent retained Vditor's unrelated shortcut");
        const codeToolbarIndex = configuredToolbar.findIndex((item) => item.name === 'code');
        const mathInlineIndex = configuredToolbar.findIndex((item) => item.name === 'math-inline');
        expect(
          configuredToolbar[codeToolbarIndex + 1]?.name === 'inline-code' &&
          configuredToolbar[codeToolbarIndex + 2]?.name === 'math-block' &&
          configuredToolbar[codeToolbarIndex + 3]?.name === 'math-inline' &&
          configuredToolbar[mathInlineIndex + 1]?.name === 'details',
          'formula and collapsible-section controls are not in the expected order'
        );
        expect(
          !configuredToolbar.some((item) => item.name === 'find') &&
          !document.querySelector('.vditor-toolbar [data-type="find"]'),
          'the search control is still present in the top toolbar'
        );
        const moreToolbar = configuredToolbar.find((item) => item.name === 'more')?.toolbar || [];
        const normalizeToolbarItem = moreToolbar.find(
          (item) => item.name === 'normalize-formatting'
        );
        expect(
          normalizeToolbarItem,
          'the confirmed normalize-formatting escape hatch is missing from More'
        );
        const normalizeMessageCount = () => window.__vmdMessages.filter(
          (message) => message.command === 'normalize-formatting'
        ).length;
        const normalizeBeforeConfirmation = normalizeMessageCount();
        normalizeToolbarItem.click();
        testCheckpoint = 'waiting for normalize cancel dialog';
        await wait(() => document.querySelector('.vmd-confirm-dialog[open]'));
        testCheckpoint = 'startup';
        document.querySelector(
          '.vmd-confirm-dialog [data-action="cancel"]'
        ).click();
        await pause(80);
        expect(
          normalizeMessageCount() === normalizeBeforeConfirmation &&
            !document.querySelector('.vmd-confirm-dialog'),
          'canceling normalization posted a destructive command or left its dialog open'
        );

        normalizeToolbarItem.click();
        testCheckpoint = 'waiting for normalize confirm dialog';
        await wait(() => document.querySelector('.vmd-confirm-dialog[open]'));
        testCheckpoint = 'startup';
        document.querySelector(
          '.vmd-confirm-dialog [data-action="confirm"]'
        ).click();
        testCheckpoint = 'waiting for normalize command';
        await wait(() => normalizeMessageCount() === normalizeBeforeConfirmation + 1);
        testCheckpoint = 'startup';
        expect(
          normalizeMessageCount() === normalizeBeforeConfirmation + 1,
          'confirming normalization did not post exactly one command'
        );
        const topToolbarControls = Array.from(
          document.querySelectorAll('.vditor-toolbar__item > .vditor-tooltipped')
        );
        expect(
          topToolbarControls.length > 0 &&
            topToolbarControls.every((control) =>
              !!control.getAttribute('aria-label') &&
              Array.from(control.classList).some((name) =>
                /^vditor-tooltipped__(?:s|se|sw)$/.test(name)
              )
            ),
          'a top toolbar control is missing a downward tooltip label/direction'
        );
        const toolbarIconSizes = Array.from(
          document.querySelectorAll('.vditor-toolbar .vditor-tooltipped > svg')
        ).map((icon) => [getComputedStyle(icon).width, getComputedStyle(icon).height]);
        expect(
          toolbarIconSizes.length > 0 && toolbarIconSizes.every(([width, height]) => width === '15px' && height === '15px'),
          'toolbar icons do not share the standard 15px size'
        );
        const customIcon = (type) => document.querySelector('.vditor-toolbar [data-type="' + type + '"] > svg');
        const customIconTypes = ['outline', 'save', 'math-block', 'math-inline', 'details', 'vmd-edit-mode'];
        for (const type of customIconTypes) {
          const svg = customIcon(type);
          expect(svg, 'missing custom toolbar icon: ' + type);
          const bounds = svg.getBBox();
          const viewBox = svg.viewBox.baseVal;
          const widthOccupancy = bounds.width / viewBox.width;
          const heightOccupancy = bounds.height / viewBox.height;
          expect(
            widthOccupancy >= 0.9 && heightOccupancy >= 0.75,
            type + ' glyph still leaves excessive viewBox whitespace: ' + widthOccupancy + ' x ' + heightOccupancy
          );
          expect(
            bounds.x >= viewBox.x && bounds.y >= viewBox.y &&
            bounds.x + bounds.width <= viewBox.x + viewBox.width &&
            bounds.y + bounds.height <= viewBox.y + viewBox.height,
            type + ' glyph geometry is clipped by its viewBox'
          );
        }
        const outlineButton = document.querySelector('.vditor-toolbar .vmd-outline-toggle');
        const outlineStyle = getComputedStyle(outlineButton);
        const outlineControlStyle = getComputedStyle(outlineButton.querySelector('.vditor-tooltipped'));
        expect(
          (outlineStyle.display === 'inline-flex' || outlineStyle.display === 'flex') &&
          (outlineControlStyle.display === 'inline-flex' || outlineControlStyle.display === 'flex') &&
          outlineControlStyle.alignItems === 'center' && outlineControlStyle.justifyContent === 'center',
          'the outline control no longer uses flex centering'
        );
        const saveSvg = customIcon('save');
        expect(
          saveSvg?.getAttribute('viewBox') === '85 85 854 854' &&
          !saveSvg?.hasAttribute('width') && !saveSvg?.hasAttribute('height'),
          'the save glyph was not cropped to unclipped visual bounds'
        );

        await setMarkdown('first\\n\\nsecond\\n\\nthird');
        for (let index = 0; index < 3; index += 1) {
          const block = root().querySelector(':scope > p');
          const text = textNode(block);
          select(text, 0, text, 0);
          listButton().click();
          await pause();
        }
        const unorderedRegions = Array.from(root().querySelectorAll(':scope > ul[data-block="0"]'));
        expect(unorderedRegions.length === 3, 'independently formatted unordered items did not remain separate lists');
        expect(unorderedRegions.every((list) => getComputedStyle(list).outlineStyle === 'solid'), 'unordered list regions do not have visible outlines');

        await setMarkdown('first\\n\\nsecond\\n\\nthird');
        for (let index = 0; index < 3; index += 1) {
          const block = root().querySelector(':scope > p');
          const text = textNode(block);
          select(text, 0, text, 0);
          orderedListButton().click();
          await pause();
        }
        const orderedRegions = Array.from(root().querySelectorAll(':scope > ol[data-block="0"]'));
        expect(orderedRegions.length === 3, 'independently formatted ordered items did not remain separate lists');
        expect(orderedRegions.every((list) => getComputedStyle(list).outlineStyle === 'solid'), 'ordered list regions do not have visible outlines');

        await setMarkdown('- top\\n  - nested\\n    1. deep\\n- tail');
        const nestedLists = Array.from(root().querySelectorAll('ul, ol'));
        expect(nestedLists.length === 3, 'the nested-list fixture did not render three list levels');
        expect(
          getComputedStyle(nestedLists[0]).outlineStyle === 'solid' &&
            nestedLists.slice(1).every((list) => getComputedStyle(list).outlineStyle === 'none'),
          'nested list levels still draw their own outer borders'
        );

        await setMarkdown('plain Tab target');
        const plainText = textNode(root().querySelector(':scope > p'));
        select(plainText, 2, plainText, 2);
        const plainTabEvent = new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        });
        root().dispatchEvent(plainTabEvent);
        expect(plainTabEvent.defaultPrevented, 'Tab outside a list or table was allowed to move focus');
        const plainShiftTabEvent = new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        });
        root().dispatchEvent(plainShiftTabEvent);
        expect(plainShiftTabEvent.defaultPrevented, 'Shift+Tab outside a list or table was allowed to move focus');

        // Suppressing Tab traps keyboard focus in the editor (WCAG 2.1.2), so
        // Ctrl+M must release it the way VS Code's own Tab-moves-focus toggle
        // does, and must restore the structural behaviour when toggled back.
        const focusToggle = (options) => {
          const event = new KeyboardEvent('keydown', Object.assign({
            key: 'm',
            bubbles: true,
            cancelable: true,
          }, options));
          root().dispatchEvent(event);
          return event;
        };
        const tabAfterToggle = () => {
          const event = new KeyboardEvent('keydown', {
            key: 'Tab',
            bubbles: true,
            cancelable: true,
          });
          root().dispatchEvent(event);
          return event;
        };
        const enableToggle = focusToggle({ ctrlKey: true });
        expect(enableToggle.defaultPrevented, 'Ctrl+M did not claim the focus-mode toggle');
        expect(!tabAfterToggle().defaultPrevented, 'Tab stayed trapped after Ctrl+M released it');
        focusToggle({ ctrlKey: true });
        expect(tabAfterToggle().defaultPrevented, 'structural Tab handling did not resume after toggling back');
        // Escape must stay with Vditor: it owns hint dismissal and the esc option.
        const shiftM = focusToggle({ ctrlKey: true, shiftKey: true });
        expect(!shiftM.defaultPrevented, 'Ctrl+Shift+M was swallowed by the focus-mode toggle');

        await setMarkdown('first\\n\\nsecond\\n\\nthird');
        let blocks = Array.from(root().querySelectorAll(':scope > p'));
        select(textNode(blocks[0]), 0, textNode(blocks[1]), textNode(blocks[1]).textContent.length);
        listButton().click();
        await pause();
        expect(root().querySelectorAll(':scope > ul').length === 1, 'selected paragraphs were not grouped into one list');
        expect(root().querySelector(':scope > ul').querySelectorAll(':scope > li').length === 2, 'the list does not contain both selected paragraphs');
        expect(root().querySelector(':scope > p').textContent.trim() === 'third', 'an unselected paragraph was changed');
        const multiListMarkdown = window.vditor.getValue();
        expect(multiListMarkdown.includes('* first') && multiListMarkdown.includes('* second'), 'multi-line list conversion was not serialized to Markdown');

        await setMarkdown('task one\\n\\ntask two');
        blocks = Array.from(root().querySelectorAll(':scope > p'));
        select(textNode(blocks[0]), 0, textNode(blocks[1]), textNode(blocks[1]).textContent.length);
        document.querySelector('.vditor-toolbar [data-type="check"]').click();
        await pause();
        expect(window.vditor.getValue().includes('[ ] task one') && window.vditor.getValue().includes('[ ] task two'), 'selected task-list conversion was not serialized to Markdown');

        await setMarkdown('> first\\n>\\n> second');
        const quote = root().querySelector(':scope > blockquote');
        const quotedBlocks = Array.from(quote.querySelectorAll(':scope > p'));
        select(textNode(quotedBlocks[0]), 0, textNode(quotedBlocks[1]), textNode(quotedBlocks[1]).textContent.length);
        listButton().click();
        await pause();
        expect(!!root().querySelector(':scope > blockquote'), 'list conversion removed the blockquote');
        expect(root().querySelector(':scope > blockquote > ul > li')?.textContent.includes('first'), 'list conversion did not preserve the blockquote contents');

        await setMarkdown('- first\\n- second\\n- third');
        let items = Array.from(root().querySelectorAll(':scope > ul > li'));
        const secondText = textNode(items[1]);
        select(secondText, 1, secondText, 1);
        listButton().click();
        await pause();
        const children = Array.from(root().children);
        expect(children.length === 3, 'single-list-item toggle changed more than one item');
        expect(children[0].tagName === 'UL' && children[0].textContent.includes('first'), 'the first item did not remain a list item');
        expect(children[1].tagName === 'P' && children[1].textContent.includes('second'), 'the current list item was not unlisted');
        expect(children[2].tagName === 'UL' && children[2].textContent.includes('third'), 'the final item did not remain a list item');

        await setMarkdown('- first\\n- second\\n- third');
        items = Array.from(root().querySelectorAll(':scope > ul > li'));
        const tabText = textNode(items[1]);
        select(tabText, 2, tabText, 2);
        const tabEvent = new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        });
        root().dispatchEvent(tabEvent);
        expect(tabEvent.defaultPrevented, 'Tab was not intercepted by the WYSIWYG list handler');
        await pause(40);
        const nestedItem = root().querySelector(':scope > ul > li:first-child > ul > li');
        expect(
          nestedItem?.textContent.includes('second'),
          'Tab did not indent a list item when the caret was inside its text'
        );
        const nestedText = textNode(nestedItem);
        select(nestedText, 1, nestedText, 1);
        const shiftTabEvent = new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        });
        root().dispatchEvent(shiftTabEvent);
        expect(shiftTabEvent.defaultPrevented, 'Shift+Tab was not intercepted by the list handler');
        await pause(40);
        const restoredItems = Array.from(root().querySelector(':scope > ul').children);
        expect(
          restoredItems.length === 3 && restoredItems[1].textContent.includes('second'),
          'Shift+Tab did not outdent the nested list item'
        );

        // A selection boundary can land directly inside the UL between two
        // items. The rebuild only carries LI children into the replacement, so
        // the discarded container takes that marker with it; the markers must
        // still be cleaned up rather than left to serialize into the document.
        await setMarkdown('- first\\n- second\\n\\nafter');
        const markerList = root().querySelector(':scope > ul');
        const trailingText = textNode(root().querySelector(':scope > p'));
        select(markerList, 1, trailingText, trailingText.textContent.length);
        listButton().click();
        await pause(40);
        expect(
          !root().querySelector('[data-vmd-list-selection]'),
          'a list selection marker survived in the editor DOM'
        );
        expect(
          !window.vditor.getValue().includes('vmd-list-selection'),
          'a list selection marker leaked into the serialized Markdown'
        );
        const markerChildren = Array.from(root().children).map((child) => child.tagName);
        expect(
          markerChildren.join(',') === 'UL,P,UL',
          'the toggle did not run on a boundary inside the list container: ' + markerChildren.join(',')
        );

        await setMarkdown('| First | Second |\\n| --- | --- |\\n| one | two |');
        const firstTableCell = root().querySelector('th, td');
        const secondTableCell = firstTableCell.nextElementSibling;
        const firstCellText = textNode(firstTableCell);
        select(firstCellText, 0, firstCellText, firstCellText.textContent.length);
        const tableTabEvent = new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        });
        root().dispatchEvent(tableTabEvent);
        expect(tableTabEvent.defaultPrevented, 'Tab did not stay inside the table');
        expect(selectedTableCell() === secondTableCell, 'Tab did not select the next table cell');
        const tableShiftTabEvent = new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        });
        root().dispatchEvent(tableShiftTabEvent);
        expect(tableShiftTabEvent.defaultPrevented, 'Shift+Tab did not stay inside the table');
        expect(selectedTableCell() === firstTableCell, 'Shift+Tab did not select the previous table cell');

        await setMarkdown(
          '<details data-open="yes" class="open expanded">\\n<summary>Attribute title</summary>' +
            '\\n\\nAttribute body\\n\\n</details>'
        );
        const attributeOpener = root().querySelector('.vmd-details-opener');
        expect(
          attributeOpener &&
            !attributeOpener.querySelector('details').open &&
            attributeOpener.nextElementSibling.classList.contains('vmd-details-content--hidden'),
          'data-open or an open class was mistaken for the native open attribute'
        );



        await setMarkdown('<details>\\n<summary>Title</summary>\\n\\nHidden body\\n\\n</details>\\n\\noutside tail');
        const detailsOpener = Array.from(root().children).find(
          (element) =>
            element.classList.contains('vditor-wysiwyg__block') &&
            element.getAttribute('data-type') === 'html-block' &&
            element.textContent.includes('<details>')
        );
        expect(!!detailsOpener, 'details opening block was not rendered');
        const detailsBody = detailsOpener.nextElementSibling;
        expect(!!detailsBody, 'details has no editable body');
        expect(detailsBody.classList.contains('vmd-details-content--hidden'), 'closed details content is visible');
        const detailsCloser = detailsBody.nextElementSibling;
        expect(detailsCloser.classList.contains('vmd-details-closer'), 'details closing marker was not recognized');
        expect(getComputedStyle(detailsCloser).display === 'none', 'details closing marker still occupies a blank line');
        expect(!/<details\\s+[^>]*\\bopen/.test(window.vditor.getValue()), 'closed details unexpectedly serialized an open attribute');
        const detailsSummary = detailsOpener.querySelector('summary');
        const detailsSource = detailsOpener.querySelector(':scope > pre:not(.vditor-wysiwyg__preview)');
        const collapsedSummaryStyle = getComputedStyle(detailsSummary);
        const collapsedToggle = detailsSummary.querySelector('.vmd-details-toggle');
        const collapsedToggleTransform = getComputedStyle(collapsedToggle).transform;
        const detailsTitleButton = detailsOpener.querySelector('.vmd-details-title-button');
        expect(
          detailsSummary.contentEditable === 'false' && !detailsSummary.isContentEditable,
          'the rendered details summary still accepts a text caret'
        );
        expect(
          collapsedSummaryStyle.fontSize !== '0px' &&
            collapsedSummaryStyle.color !== 'rgba(0, 0, 0, 0)' &&
            detailsSummary.textContent.includes('Title'),
          'closed details did not show its read-only title text'
        );
        expect(
          getComputedStyle(detailsSource).display === 'none',
          'closed details exposed its raw HTML source'
        );
        expect(
          detailsTitleButton?.getAttribute('aria-label') &&
            getComputedStyle(detailsTitleButton).display !== 'none' &&
            !detailsOpener.querySelector('.vmd-details-title-edit'),
          'closed details did not provide the separate title popover control'
        );
        collapsedToggle.click();
        await pause(100);
        expect(getComputedStyle(detailsSource).display === 'none', 'opening details revealed its raw HTML source');
        expect(!detailsBody.classList.contains('vmd-details-content--hidden'), 'clicking the details arrow did not open the body');
        expect(
          detailsSummary.textContent.includes('Title') &&
            getComputedStyle(detailsSummary).fontSize !== '0px' &&
            getComputedStyle(collapsedToggle).transform !== collapsedToggleTransform,
          'open details did not retain its title or rotate its arrow downward'
        );
        const summaryTextLeft = detailsSummary.getBoundingClientRect().left +
          Number.parseFloat(getComputedStyle(detailsSummary).paddingLeft);
        const bodyTextLeft = detailsBody.getBoundingClientRect().left +
          Number.parseFloat(getComputedStyle(detailsBody).paddingLeft);
        expect(
          Math.abs(summaryTextLeft - bodyTextLeft) <= 1,
          'expanded details body text is not aligned with the summary text: summary=' +
            summaryTextLeft + ', body=' + bodyTextLeft
        );
        expect(
          !detailsOpener.querySelector('.vmd-details-title-edit'),
          'opening details created the removed inline title editor'
        );

        detailsSummary.click();
        await pause();
        expect(
          detailsBody.classList.contains('vmd-details-content--hidden') &&
            detailsSummary.textContent.includes('Title'),
          'clicking the open title did not close the body while keeping the title visible'
        );

        detailsTitleButton.click();
        await Promise.resolve();
        const detailsTitlePopover = document.querySelector(
          '.vditor-wysiwyg > .vmd-source-popover'
        );
        const detailsTitleInput = detailsTitlePopover?.querySelector(
          '[name="title"]'
        );
        expect(
          detailsBody.classList.contains('vmd-details-content--hidden') &&
            detailsTitlePopover?.style.display === 'block' &&
            ['above', 'below', 'viewport'].includes(
              detailsTitlePopover.dataset.vmdPosition
            ) &&
            detailsTitleInput?.value === 'Title',
          'the title edit button toggled details or did not open the shared custom popover: ' +
            JSON.stringify({
              hidden: detailsBody.classList.contains('vmd-details-content--hidden'),
              display: detailsTitlePopover?.style.display,
              position: detailsTitlePopover?.dataset.vmdPosition,
              value: detailsTitleInput?.value,
            })
        );
        const detailsCloseButton = detailsTitlePopover.querySelector('.vmd-popover-close');
        expect(
          detailsCloseButton?.getAttribute('aria-label') &&
            detailsTitlePopover.classList.contains('vmd-url-popover--persistent'),
          'the persistent details title popover did not expose an accessible close button'
        );
        detailsTitleInput.focus();
        detailsTitleInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        }));
        expect(document.activeElement === detailsCloseButton, 'Tab did not reach the details close button');
        detailsCloseButton.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }));
        expect(document.activeElement === detailsTitleInput, 'Shift+Tab did not return to the details title input');
        const imeConfirmEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(imeConfirmEvent, 'isComposing', { value: true });
        detailsTitleInput.dispatchEvent(imeConfirmEvent);
        expect(
          document.activeElement === detailsTitleInput &&
            detailsTitlePopover.style.display === 'block',
          'IME confirmation Enter closed the details title popover'
        );
        detailsTitleInput.value = 'Renamed $1 <&> title';
        detailsTitleInput.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: 'Renamed $1 <&> title',
        }));
        detailsTitleInput.blur();
        await pause(80);
        expect(
          window.vditor.getValue().includes(
            '<summary>Renamed $1 &lt;&amp;&gt; title</summary>'
          ),
          'editing the details title popover did not update its hidden HTML source safely: ' + JSON.stringify(window.vditor.getValue())
        );
        const renamedDetailsSummary = detailsOpener.querySelector('summary');
        const renamedDetailsSource = detailsOpener.querySelector(
          ':scope > pre:not(.vditor-wysiwyg__preview)'
        );
        expect(
          renamedDetailsSummary.textContent.includes('Renamed $1 <&> title') &&
            getComputedStyle(renamedDetailsSource).display === 'none' &&
            !detailsOpener.querySelector('.vmd-details-title-edit'),
          'the popover edit did not refresh the visible title or exposed another editor'
        );
        expect(
          !window.vditor.getValue().includes('vmd-details-toggle') &&
            !window.vditor.getValue().includes('vmd-details-title-button') &&
            !window.vditor.getValue().includes('vmd-source-popover'),
          'details editing controls leaked into Markdown'
        );
        expect(!/<details\\s+[^>]*\\bopen/.test(window.vditor.getValue()), 'opening details changed the Markdown source');

        const detailsOutsideBlock = root().lastElementChild;
        const detailsOutsideText = textNode(detailsOutsideBlock);
        select(detailsOutsideText, 1, detailsOutsideText, 1);
        detailsOutsideBlock.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
        }));
        await pause(260);
        expect(
          detailsTitlePopover.style.display === 'block' &&
            detailsTitlePopover.classList.contains('vmd-url-popover--persistent') &&
            detailsTitleInput.isConnected,
          'clicking outside replaced or dismissed the persistent details title popover'
        );
        detailsCloseButton.click();
        expect(
          detailsTitlePopover.style.display === 'none' &&
            !detailsTitlePopover.classList.contains('vmd-url-popover--persistent'),
          'the details close button did not dismiss the persistent popover'
        );

        const renamedTitleButton = detailsOpener.querySelector('.vmd-details-title-button');
        renamedTitleButton.click();
        await Promise.resolve();
        const reopenedDetailsPopover = document.querySelector(
          '.vditor-wysiwyg > .vmd-source-popover'
        );
        const detailsEscape = new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        });
        document.dispatchEvent(detailsEscape);
        expect(
          detailsEscape.defaultPrevented &&
            reopenedDetailsPopover.style.display === 'none' &&
            !reopenedDetailsPopover.classList.contains('vmd-url-popover--persistent'),
          'Escape did not close the persistent details title popover'
        );

        const renamedToggle = renamedDetailsSummary.querySelector('.vmd-details-toggle');
        renamedToggle.click();
        await pause();
        expect(
          !detailsBody.classList.contains('vmd-details-content--hidden') &&
            renamedDetailsSummary.textContent.includes('Renamed $1 <&> title') &&
            getComputedStyle(renamedDetailsSource).display === 'none',
          'reopening details did not retain its title bar or kept the raw source visible'
        );

        // Manual open state is held in a WeakMap keyed on the opener element, so
        // it only survives while that element does. Editing a different block
        // must not reset the disclosure the user just opened.
        const tailBlock = root().lastElementChild;
        expect(
          tailBlock.tagName === 'P' && tailBlock.textContent.includes('outside tail'),
          'expected a plain paragraph after the closing details tag, got ' + tailBlock.tagName
        );
        expect(
          !tailBlock.classList.contains('vmd-details-content--hidden'),
          'a paragraph after the closing tag was hidden with the details group'
        );
        const detailsTail = textNode(tailBlock);
        select(detailsTail, detailsTail.textContent.length, detailsTail, detailsTail.textContent.length);
        window.vditor.insertValue(' edited');
        await pause(60);
        const reopenedOpener = Array.from(root().children).find(
          (element) =>
            element.classList.contains('vditor-wysiwyg__block') &&
            element.getAttribute('data-type') === 'html-block' &&
            element.textContent.includes('<details>')
        );
        expect(!!reopenedOpener, 'details opening block disappeared after an unrelated edit');
        expect(
          !reopenedOpener.nextElementSibling.classList.contains('vmd-details-content--hidden'),
          'an unrelated edit collapsed the details the user had opened'
        );

        await setMarkdown(
          '<details>\\n<summary><strong>Rich title</strong></summary>\\n\\nRich body\\n\\n</details>'
        );
        const richDetailsOpener = root().querySelector('.vmd-details-opener');
        richDetailsOpener.querySelector('.vmd-details-title-button').click();
        await Promise.resolve();
        const richTitleInput = document.querySelector(
          '.vmd-source-popover [name="title"]'
        );
        richTitleInput.blur();
        await pause();
        const richTitlePopover = document.querySelector('.vmd-source-popover');
        expect(
          richTitlePopover.style.display === 'block' &&
            richTitlePopover.classList.contains('vmd-url-popover--persistent'),
          'blurring an unchanged details title unexpectedly closed its popover'
        );
        richTitlePopover.querySelector('.vmd-popover-close').click();
        expect(
          window.vditor.getValue().includes('<summary><strong>Rich title</strong></summary>'),
          'opening and closing the title popover flattened an unchanged rich summary'
        );

        // Openers and closers are paired positionally with a stack, so nesting
        // is the case that exercises it: the inner closer belongs to the outer
        // group's contents, the outer closer belongs to no group.
        await setMarkdown(
          '<details>\\n<summary>Outer</summary>\\n\\n<details>\\n<summary>Inner</summary>' +
          '\\n\\ninner body\\n\\n</details>\\n\\n</details>'
        );
        const nested = Array.from(root().children);
        const hidden = (element) => element.classList.contains('vmd-details-content--hidden');
        expect(nested.length === 5, 'nested details did not render as five blocks, got ' + nested.length);
        expect(nested[0].classList.contains('vmd-details-opener'), 'outer details was not marked an opener');
        expect(nested[1].classList.contains('vmd-details-opener'), 'inner details was not marked an opener');
        expect(nested[3].classList.contains('vmd-details-closer'), 'inner closing tag was not marked a closer');
        expect(nested[4].classList.contains('vmd-details-closer'), 'outer closing tag was not marked a closer');
        expect(hidden(nested[1]) && hidden(nested[2]) && hidden(nested[3]),
          'a closed outer details did not hide the nested group');
        expect(!hidden(nested[4]), "the outer group hid its own closing tag");
        nested[0].querySelector('.vmd-details-toggle').click();
        await pause(40);
        expect(!hidden(nested[1]) && !hidden(nested[3]),
          'opening the outer details did not reveal the nested opener and closer');
        expect(hidden(nested[2]),
          'opening the outer details also revealed content the inner details still hides');

        await setMarkdown(
          '<details>\\n<summary>Continuous border</summary>\\n\\nparagraph body' +
            '\\n\\n### Heading inside details' +
            '\\n\\n- first list item\\n- second list item\\n\\n> quote body' +
            '\\n\\n| A | B |\\n| --- | --- |\\n| one | two |' +
            '\\n\\ntail paragraph\\n\\n</details>'
        );
        const borderOpener = root().querySelector('.vmd-details-opener');
        borderOpener.querySelector('summary').click();
        await pause(80);
        const borderedBlocks = Array.from(
          root().querySelectorAll(':scope > .vmd-details-content--open')
        );
        expect(
          borderedBlocks.length === 6,
          'the mixed details fixture did not expose all six content blocks'
        );
        const borderRects = borderedBlocks.map((block) =>
          block.getBoundingClientRect()
        );
        for (let index = 0; index < borderedBlocks.length; index += 1) {
          const style = getComputedStyle(borderedBlocks[index]);
          expect(
            style.boxSizing === 'border-box' &&
              Number.parseFloat(style.marginTop) === 0 &&
              Number.parseFloat(style.marginBottom) === 0,
            'details content blocks do not share one margin-free border box'
          );
          expect(
            Math.abs(borderRects[index].left - borderRects[0].left) <= 0.5 &&
              Math.abs(borderRects[index].right - borderRects[0].right) <= 0.5,
            'details borders are not horizontally aligned at block ' + index
          );
          if (index > 0) {
            expect(
              Math.abs(borderRects[index].top - borderRects[index - 1].bottom) <= 0.5,
              'details border is discontinuous between blocks ' +
                (index - 1) + ' and ' + index
            );
          }
        }
        expect(
          Number.parseFloat(getComputedStyle(borderedBlocks[0]).borderTopWidth) === 1 &&
            Number.parseFloat(
              getComputedStyle(borderedBlocks[borderedBlocks.length - 1]).borderBottomWidth
            ) === 1,
          'the continuous details boundary lost its top or bottom edge'
        );
        const virtualHeading = borderedBlocks.find(
          (block) => block.tagName === 'H3'
        );
        const virtualHeadingStyle = getComputedStyle(virtualHeading);
        const virtualHeadingMarker = getComputedStyle(
          virtualHeading,
          '::before'
        );
        expect(
          virtualHeadingMarker.content.replace(/["']/g, '') === 'H3' &&
            Number.parseFloat(virtualHeadingStyle.paddingLeft) +
              Number.parseFloat(virtualHeadingMarker.marginLeft) >= -0.5,
          'the H3 level marker crosses the virtual details boundary'
        );
        expect(
          Math.abs(
            Number.parseFloat(virtualHeadingStyle.paddingLeft) -
              Number.parseFloat(getComputedStyle(borderedBlocks[0]).paddingLeft)
          ) <= 0.5,
          'heading text does not use the details virtual-document gutter'
        );
        const virtualList = borderedBlocks.find(
          (block) => block.tagName === 'UL'
        );
        const virtualListRect = virtualList.getBoundingClientRect();
        const virtualListStyle = getComputedStyle(virtualList);
        const outlineExtent =
          Number.parseFloat(virtualListStyle.outlineWidth) +
          Number.parseFloat(virtualListStyle.outlineOffset);
        expect(
          virtualListRect.left - outlineExtent >= borderRects[0].left - 0.5 &&
            virtualListRect.right + outlineExtent <= borderRects[0].right + 0.5,
          'the list outline exceeds the details virtual-document boundary'
        );

        // Details now uses the same one-session source editor as other hidden
        // serializer-owned content, so multiple input events commit once.
        await setMarkdown(
          '<details>\\n<summary>Undo title</summary>\\n\\nUndo body\\n\\n</details>'
        );
        root().querySelector('.vmd-details-title-button').click();
        await Promise.resolve();
        const undoTitlePopover = document.querySelector('.vmd-source-popover');
        const undoTitleInput = undoTitlePopover.querySelector('[name="title"]');
        undoTitleInput.value = 'Undo title first';
        undoTitleInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
        undoTitleInput.value = 'Undo title final';
        undoTitleInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
        undoTitlePopover.querySelector('.vmd-popover-close').click();
        await pause(80);
        expect(
          window.vditor.getValue().includes('<summary>Undo title final</summary>'),
          'the unified Details source session did not commit its final draft'
        );
        window.vditor.vditor.undo.undo(window.vditor.vditor);
        await pause(100);
        expect(
          window.vditor.getValue().includes('<summary>Undo title</summary>'),
          'multiple Details title inputs were not grouped into one undo step'
        );

        // Reproduce an actual blank WYSIWYG line through Vditor's Enter path.
        // Clicking Alert there must replace the empty source line, not the
        // previous paragraph whose visible length happens to share its offset.
        await setMarkdown('previous alert line');
        const previousAlertText = textNode(root().querySelector(':scope > p'));
        select(
          previousAlertText,
          previousAlertText.textContent.length,
          previousAlertText,
          previousAlertText.textContent.length
        );
        document.execCommand('insertParagraph', false);
        await pause(80);
        const blankAlertParagraph = root().lastElementChild;
        expect(
          blankAlertParagraph !== root().firstElementChild &&
            !blankAlertParagraph.textContent.replace(/\\u200b/g, '').trim(),
          'Enter did not create a real blank WYSIWYG paragraph: ' + root().innerHTML
        );
        select(blankAlertParagraph, 0, blankAlertParagraph, 0);
        document.querySelector('.vditor-toolbar [data-type="vmd-alert"]').click();
        await pause(80);
        expect(
          hasLocalizedDefaultAlert(
            window.vditor.getValue(),
            'previous alert line'
          ),
          'Alert on a blank line converted the previous line: ' +
            JSON.stringify(window.vditor.getValue())
        );

        await setMarkdown('before blank alert\\n\\nafter blank alert');
        const beforeBlankAlertParagraph = root().querySelectorAll(':scope > p')[0];
        const beforeBlankAlertText = textNode(beforeBlankAlertParagraph);
        select(
          beforeBlankAlertText,
          beforeBlankAlertText.textContent.length,
          beforeBlankAlertText,
          beforeBlankAlertText.textContent.length
        );
        document.execCommand('insertParagraph', false);
        await pause(80);
        const middleBlankAlertParagraph = root().querySelectorAll(':scope > p')[1];
        expect(
          middleBlankAlertParagraph &&
            !middleBlankAlertParagraph.textContent.replace(/\\u200b/g, '').trim(),
          'insertParagraph did not create a blank paragraph between content lines'
        );
        select(middleBlankAlertParagraph, 0, middleBlankAlertParagraph, 0);
        document.querySelector('.vditor-toolbar [data-type="vmd-alert"]').click();
        await pause(80);
        expect(
          hasLocalizedDefaultAlert(
            window.vditor.getValue(),
            'before blank alert',
            'after blank alert'
          ),
          'Alert on a middle blank line changed adjacent content: ' +
            JSON.stringify(window.vditor.getValue())
        );

        await setMarkdown('bold target');
        const boldText = textNode(root().querySelector(':scope > p'));
        root().focus();
        select(boldText, 0, boldText, boldText.textContent.length);
        let boldReachedDocument = false;
        const onBold = (event) => {
          if (event.key.toLowerCase() === 'b' && event.ctrlKey) boldReachedDocument = true;
        };
        document.addEventListener('keydown', onBold, { once: true });
        root().dispatchEvent(new KeyboardEvent('keydown', {
          key: 'b',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }));
        await pause();
        expect(!boldReachedDocument, 'Ctrl+B bubbled beyond the Vditor editor');
        expect(!!root().querySelector('strong, b'), 'Ctrl+B did not apply bold formatting');
        const boldToolbarButton = document.querySelector(
          '.vditor-toolbar [data-type="bold"]'
        );
        expect(
          boldToolbarButton.getAttribute('aria-keyshortcuts') === 'Control+B' &&
            boldToolbarButton.getAttribute('aria-label').includes('Ctrl+B'),
          'the configured shortcut was not exposed by the toolbar label'
        );

        window.dispatchEvent(new MessageEvent('message', {
          data: {
            command: 'toolbar-shortcuts',
            shortcuts: { 'heading-3': 'Mod+Alt+3' },
          },
        }));
        await setMarkdown('shortcut heading');
        const shortcutHeadingText = textNode(root().querySelector(':scope > p'));
        select(shortcutHeadingText, 2, shortcutHeadingText, 2);
        const headingShortcutEvent = new KeyboardEvent('keydown', {
          key: '3',
          code: 'Digit3',
          ctrlKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true,
        });
        root().dispatchEvent(headingShortcutEvent);
        await pause(80);
        expect(
          headingShortcutEvent.defaultPrevented &&
            root().querySelector('h3') &&
            window.vditor.getValue().includes('### shortcut heading'),
          'a live heading shortcut did not trigger exactly the toolbar action'
        );

        window.dispatchEvent(new MessageEvent('message', {
          data: {
            command: 'toolbar-shortcuts',
            shortcuts: { bold: 'Mod+Alt+Q', italic: 'Mod+Alt+Q' },
          },
        }));
        await setMarkdown('conflict target');
        const conflictText = textNode(root().querySelector(':scope > p'));
        select(conflictText, 0, conflictText, conflictText.textContent.length);
        const conflictEvent = new KeyboardEvent('keydown', {
          key: 'q',
          code: 'KeyQ',
          ctrlKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true,
        });
        root().dispatchEvent(conflictEvent);
        await pause();
        expect(
          !conflictEvent.defaultPrevented && !root().querySelector('strong, em'),
          'conflicting toolbar shortcuts were resolved by an implicit winner'
        );

        window.dispatchEvent(new MessageEvent('message', {
          data: {
            command: 'toolbar-shortcuts',
            shortcuts: { bold: 'Mod+C' },
          },
        }));
        const reservedEvent = new KeyboardEvent('keydown', {
          key: 'c',
          code: 'KeyC',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        });
        root().dispatchEvent(reservedEvent);
        expect(
          !root().querySelector('strong'),
          'a reserved editor shortcut was reassigned to a toolbar action'
        );
        window.dispatchEvent(new MessageEvent('message', {
          data: {
            command: 'toolbar-shortcuts',
            shortcuts: { bold: 'Mod+B' },
          },
        }));

        const selectAlertType = async (alert, type) => {
          const title = alert.querySelector(':scope > .vmd-alert-title');
          expect(title?.tagName === 'BUTTON', 'the Alert type marker is not a button');
          title.click();
          await pause();
          const menu = document.getElementById('vmd-alert-type-menu');
          expect(
            menu && getComputedStyle(menu).display !== 'none',
            'clicking the Alert marker did not open its in-place type menu'
          );
          expect(
            menu.querySelector('.vmd-alert-type-menu__current')?.dataset.alertType ===
              alert.dataset.vmdAlert,
            'the Alert type menu did not mark the active type'
          );
          const item = menu.querySelector('button[data-alert-type="' + type + '"]');
          expect(item, 'the Alert type menu is missing ' + type);
          item.click();
          await pause(80);
          expect(
            getComputedStyle(menu).display === 'none',
            'selecting an Alert type did not close the in-place menu'
          );
        };

        const alertTypes = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'];
        const alertMarkdown = alertTypes.map((type) => '> [!' + type + ']\\n> ' + type.toLowerCase() + ' body').join('\\n\\n');
        await setMarkdown(alertMarkdown);
        await pause(80);
        const renderedAlerts = Array.from(root().querySelectorAll(':scope > blockquote.vmd-alert'));
        expect(renderedAlerts.length === alertTypes.length, 'not all five GitHub Alert types rendered');
        for (const [index, alert] of renderedAlerts.entries()) {
          expect(alert.dataset.vmdAlert === alertTypes[index], 'GitHub Alert type was decorated incorrectly');
          const title = alert.querySelector('.vmd-alert-title');
          const expectedTitle = alertTypes[index][0] + alertTypes[index].slice(1).toLowerCase();
          expect(title?.textContent === expectedTitle, 'GitHub Alert title is missing');
          expect(
            title?.getAttribute('aria-haspopup') === 'menu',
            'GitHub Alert title does not expose its type menu'
          );
          expect(getComputedStyle(alert.querySelector('.vmd-alert-marker')).display === 'none', 'GitHub Alert source marker is visible');
        }
        const serializedAlerts = window.vditor.getValue();
        expect(
          alertTypes.every((type) => serializedAlerts.includes('[!' + type + ']')) &&
            !serializedAlerts.includes('vmd-alert'),
          'GitHub Alert rendering changed or polluted the Markdown source'
        );
        renderedAlerts[0].querySelector('.vmd-alert-title').click();
        await pause();
        const alertTypeMenu = document.getElementById('vmd-alert-type-menu');
        expect(
          getComputedStyle(alertTypeMenu).display !== 'none',
          'the Alert type menu was not visible before its Escape check'
        );
        const alertArrowDown = new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        });
        document.dispatchEvent(alertArrowDown);
        expect(
          alertArrowDown.defaultPrevented &&
            document.activeElement?.dataset.alertType === 'NOTE',
          'ArrowDown did not enter the Alert menu at its first item'
        );
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'End',
          bubbles: true,
          cancelable: true,
        }));
        expect(
          document.activeElement?.dataset.alertType === 'CAUTION',
          'End did not focus the last Alert menu item'
        );
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }));
        expect(
          getComputedStyle(alertTypeMenu).display === 'none' &&
            window.vditor.getValue() === serializedAlerts,
          'Escape did not close the Alert type menu without changing Markdown'
        );

        await setMarkdown('> [!NOTE] 自定义标题\\n> custom title body');
        await pause(80);
        let customTitleAlert = root().querySelector(':scope > blockquote.vmd-alert');
        expect(
          customTitleAlert?.dataset.vmdAlert === 'NOTE' &&
            customTitleAlert.querySelector(':scope > .vmd-alert-title')?.textContent === '自定义标题' &&
            customTitleAlert.querySelector('.vmd-alert-marker')?.textContent.includes('自定义标题') &&
            window.vditor.getValue().includes('[!NOTE] 自定义标题'),
          'the custom Alert title did not replace the default type title without changing Markdown: ' +
            JSON.stringify({
              alert: customTitleAlert?.outerHTML,
              markdown: window.vditor.getValue(),
              root: root().innerHTML,
            })
        );
        customTitleAlert.querySelector(':scope > .vmd-alert-title').click();
        await pause();
        const customTitleMenu = document.getElementById('vmd-alert-type-menu');
        const customTitleInput = customTitleMenu.querySelector(
          '.vmd-alert-type-menu__custom-title-input'
        );
        expect(
          customTitleInput?.value === '自定义标题' &&
            customTitleInput.placeholder &&
            customTitleMenu.querySelectorAll('[aria-checked="true"]').length === 1,
          'the Alert menu did not expose a plain custom-title input beside one checked type'
        );
        customTitleInput.value = '可视化标题';
        customTitleInput.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          data: '可视化标题',
        }));
        expect(
          customTitleAlert.querySelector(':scope > .vmd-alert-title')?.textContent === '可视化标题' &&
            window.vditor.getValue().includes('[!NOTE] 可视化标题'),
          'typing in the Alert custom-title input did not update the title immediately'
        );
        customTitleInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }));
        await pause(80);
        expect(
          getComputedStyle(customTitleMenu).display === 'none' &&
            window.vditor.getValue().includes('[!NOTE] 可视化标题'),
          'Escape discarded the current Alert custom title'
        );
        window.vditor.vditor.undo.undo(window.vditor.vditor);
        await pause(100);
        customTitleAlert = root().querySelector(':scope > blockquote.vmd-alert');
        expect(
          window.vditor.getValue().includes('[!NOTE] 自定义标题') &&
            customTitleAlert.querySelector(':scope > .vmd-alert-title')?.textContent === '自定义标题',
          'the live Alert title edit was not grouped into one undo step'
        );
        await selectAlertType(customTitleAlert, 'WARNING');
        customTitleAlert = root().querySelector(':scope > blockquote.vmd-alert');
        expect(
          customTitleAlert?.dataset.vmdAlert === 'WARNING' &&
            customTitleAlert.querySelector(':scope > .vmd-alert-title')?.textContent === '自定义标题' &&
            window.vditor.getValue().includes('[!WARNING] 自定义标题'),
          'switching an Alert type did not preserve its custom title'
        );
        customTitleAlert.querySelector(':scope > .vmd-alert-title').click();
        await pause();
        const clearCustomTitleInput = document.querySelector(
          '#vmd-alert-type-menu .vmd-alert-type-menu__custom-title-input'
        );
        clearCustomTitleInput.value = '';
        clearCustomTitleInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
        expect(
          customTitleAlert.querySelector(':scope > .vmd-alert-title')?.textContent === 'Warning' &&
            !window.vditor.getValue().includes('[!WARNING] 自定义标题'),
          'clearing the custom-title input did not restore the default Alert title'
        );
        clearCustomTitleInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }));
        await pause(80);

        await setMarkdown(
          '>[!note]\\n>lowercase body\\n\\n' +
            '> [!WaRnInG]\\n> mixed-case body\\n\\n' +
            '   >    [!TiP]\\n   > indented body\\n\\n' +
            '> [!important]  \\n> hard-break body'
        );
        await pause(80);
        const caseInsensitiveAlerts = root().querySelectorAll(':scope > blockquote.vmd-alert');
        expect(
          caseInsensitiveAlerts.length === 4 &&
            caseInsensitiveAlerts[0].dataset.vmdAlert === 'NOTE' &&
            caseInsensitiveAlerts[1].dataset.vmdAlert === 'WARNING' &&
            caseInsensitiveAlerts[2].dataset.vmdAlert === 'TIP' &&
            caseInsensitiveAlerts[3].dataset.vmdAlert === 'IMPORTANT',
          'GitHub-compatible case-insensitive Alert markers were not recognized'
        );
        expect(
          caseInsensitiveAlerts[0].querySelector(':scope > .vmd-alert-title')?.textContent === 'Note' &&
            caseInsensitiveAlerts[1].querySelector(':scope > .vmd-alert-title')?.textContent === 'Warning',
          'case-insensitive Alert markers did not use canonical display titles'
        );
        expect(
          window.vditor.getValue().includes('[!note]') &&
            window.vditor.getValue().includes('[!WaRnInG]'),
          'recognizing a case-insensitive Alert marker changed its Markdown spelling'
        );
        await selectAlertType(caseInsensitiveAlerts[0], 'TIP');
        expect(
          window.vditor.getValue().includes('[!TIP]') &&
            !window.vditor.getValue().includes('[!note]'),
          'switching a lowercase Alert type did not write the canonical uppercase marker'
        );

        for (const invalidAlertMarkdown of [
          '> [!NOTE]',
          '> [!NOTE]\\n>   ',
          '> [!NOTE] body',
          '> [!UNKNOWN]\\n> body',
          '> intro\\n> [!NOTE]\\n> body',
          '> [!NOTE]\\n> <!-- comment only -->',
          '>     [!NOTE]\\n> body',
          '    > [!NOTE]\\n    > body',
        ]) {
          await setMarkdown(invalidAlertMarkdown);
          await pause(80);
          expect(
            !root().querySelector('.vmd-alert') &&
              root().textContent.includes('[!'),
            'Markdown rendered as an Alert even though GitHub treats it as a plain quote: ' +
              JSON.stringify(invalidAlertMarkdown)
          );
        }

        await setMarkdown('> > [!NOTE]\\n> > nested quote body\\n\\n- > [!TIP]\\n  > nested list body');
        await pause(80);
        expect(
          !root().querySelector('.vmd-alert') &&
            root().querySelector('blockquote blockquote') &&
            root().querySelector('li blockquote'),
          'an Alert nested in a quote or list was not left as a plain blockquote'
        );
        const nestedAlertSource = window.vditor.getValue();
        selectTextOccurrence(root(), 'nested quote body', true);
        document.querySelector('.vditor-toolbar [data-type="vmd-alert"]').click();
        await pause(80);
        expect(
          window.vditor.getValue() === nestedAlertSource,
          'the Alert toolbar changed Markdown from a nested quote position'
        );

        await setMarkdown(
          '<details open>\\n<summary>Nested Alert</summary>\\n\\n' +
            '> [!IMPORTANT]\\n> details body\\n\\n</details>'
        );
        await pause(80);
        const detailsAlertQuote = root().querySelector(':scope > blockquote');
        expect(
          detailsAlertQuote?.classList.contains('vmd-details-content--open') &&
            !detailsAlertQuote.classList.contains('vmd-alert'),
          'an Alert inside details was not left as a plain blockquote'
        );
        const detailsAlertSource = window.vditor.getValue();
        selectTextOccurrence(detailsAlertQuote, 'details body', true);
        document.querySelector('.vditor-toolbar [data-type="vmd-alert"]').click();
        await pause(80);
        expect(
          window.vditor.getValue() === detailsAlertSource,
          'the Alert toolbar changed Markdown from inside details'
        );

        await setMarkdown(
          '> [!warning]\\nlazy continuation body\\n\\n' +
            '> [!TIP]\\n> # heading body\\n\\n' +
            '> [!CAUTION]\\n> ' + markerFence + '\\n> ' + markerFence + '\\n\\n' +
            '> [!IMPORTANT]\\n> <!-- ignored comment -->\\n> visible body'
        );
        await pause(80);
        expect(
          root().querySelectorAll(':scope > blockquote.vmd-alert').length === 4,
          'GitHub-supported lazy, heading, code, or comment-plus-content Alert bodies were rejected'
        );

        await setMarkdown('selected alert body');
        const alertBodyText = textNode(root().querySelector(':scope > p'));
        select(alertBodyText, 0, alertBodyText, alertBodyText.textContent.length);
        document.querySelector('.vditor-toolbar [data-type="vmd-alert"]').click();
        await pause(80);
        expect(
          window.vditor.getValue().includes('> [!NOTE]\\n> selected alert body') &&
            root().querySelector('blockquote.vmd-alert--note'),
          'the GitHub Alert toolbar did not insert and render the default Note alert: ' +
            JSON.stringify(window.vditor.getValue())
        );

        const deleteThroughBlockMenu = async (
          target,
          expectedKind,
          useKeyboard = false
        ) => {
          target.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: 40,
            clientY: 40,
          }));
          await pause();
          const menu = document.getElementById('vmd-block-context-menu');
          expect(
            menu?.dataset.kind === expectedKind &&
              getComputedStyle(menu).display !== 'none',
            'the block context menu did not target ' + expectedKind
          );
          const visibleActions = Array.from(
            menu.querySelectorAll('button[data-type]')
          ).filter((item) => getComputedStyle(item).display !== 'none');
          const editableKind = ['code-block', 'math-block', 'html-block'].includes(
            expectedKind
          );
          expect(
            visibleActions.length === (editableKind ? 2 : 1) &&
              visibleActions.every((item) => item.textContent.trim()),
            'the block context menu exposed stale or incomplete actions for ' +
              expectedKind + ': ' +
              JSON.stringify(visibleActions.map((item) => item.textContent.trim()))
          );
          const button = menu.querySelector('button[data-type="delete-block"]');
          expect(button, 'the block context menu has no whole-region delete action');
          if (useKeyboard) {
            const selectionBeforeMenuPointer = window.getSelection()?.rangeCount
              ? window.getSelection().getRangeAt(0).cloneRange()
              : null;
            const menuPointerDown = new PointerEvent('pointerdown', {
              bubbles: true,
              cancelable: true,
              pointerType: 'mouse',
            });
            button.dispatchEvent(menuPointerDown);
            const selectionAfterMenuPointer = window.getSelection();
            expect(
              menuPointerDown.defaultPrevented &&
                (!selectionBeforeMenuPointer ||
                  (selectionAfterMenuPointer?.rangeCount &&
                    selectionAfterMenuPointer.getRangeAt(0)
                      .compareBoundaryPoints(Range.START_TO_START, selectionBeforeMenuPointer) === 0)),
              'pressing a menu item did not preserve the editor selection'
            );
            document.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'ArrowDown',
              bubbles: true,
              cancelable: true,
            }));
            expect(
              document.activeElement === button,
              'ArrowDown did not focus the first block menu action'
            );
            button.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter',
              bubbles: true,
              cancelable: true,
            }));
          } else {
            button.click();
          }
          await pause(80);
        };

        await setMarkdown('before delete quote\\n\\n> quote first\\n> quote second\\n\\nafter delete quote');
        const deletedQuote = root().querySelector(':scope > blockquote');
        await deleteThroughBlockMenu(deletedQuote, 'quote', true);
        expect(
          window.vditor.getValue().replace(/\\n+$/, '') ===
            'before delete quote\\n\\nafter delete quote',
          'deleting a quote did not remove its complete source block: ' +
            JSON.stringify(window.vditor.getValue())
        );
        const afterQuoteSelection = window.getSelection();
        const afterQuoteSelectionElement = afterQuoteSelection?.rangeCount
          ? (afterQuoteSelection.getRangeAt(0).startContainer.nodeType === Node.ELEMENT_NODE
              ? afterQuoteSelection.getRangeAt(0).startContainer
              : afterQuoteSelection.getRangeAt(0).startContainer.parentElement)
          : null;
        expect(
          afterQuoteSelectionElement?.closest('p')?.textContent.includes('after delete quote'),
          'deleting a quote did not move the caret to the following block'
        );
        window.vditor.vditor.undo.undo(window.vditor.vditor);
        await pause(80);
        expect(
          window.vditor.getValue().includes('> quote first\\n> quote second'),
          'whole-region deletion could not be undone'
        );

        await setMarkdown('> only deleted quote');
        await deleteThroughBlockMenu(root().querySelector(':scope > blockquote'), 'quote');
        expect(
          !window.vditor.getValue().trim() &&
            root().children.length === 1 &&
            root().firstElementChild?.tagName === 'P',
          'deleting the only region did not leave one editable empty paragraph'
        );

        await setMarkdown('before delete alert\\n\\n> [!CAUTION]\\n> remove alert body\\n\\nafter delete alert');
        await pause(80);
        const deletedAlert = root().querySelector(':scope > blockquote.vmd-alert--caution');
        await deleteThroughBlockMenu(deletedAlert, 'alert');
        expect(
          window.vditor.getValue().replace(/\\n+$/, '') ===
            'before delete alert\\n\\nafter delete alert',
          'deleting a GitHub Alert left its marker or body in the document: ' +
            JSON.stringify(window.vditor.getValue())
        );

        await setMarkdown(
          'before delete details\\n\\n<details>\\n<summary>Outer delete title</summary>' +
            '\\n\\nouter delete body\\n\\n<details>\\n<summary>Inner delete title</summary>' +
            '\\n\\ninner delete body\\n\\n</details>\\n\\nouter delete tail\\n\\n</details>' +
            '\\n\\nafter delete details'
        );
        await pause(80);
        let deletionOpeners = root().querySelectorAll(':scope > .vmd-details-opener');
        expect(deletionOpeners.length === 2, 'nested deletion fixture did not render two details groups');
        await deleteThroughBlockMenu(deletionOpeners[1], 'details');
        expect(
          window.vditor.getValue().includes('Outer delete title') &&
            window.vditor.getValue().includes('outer delete tail') &&
            !window.vditor.getValue().includes('Inner delete title') &&
            !window.vditor.getValue().includes('inner delete body'),
          'deleting nested details did not remove only the innermost complete group: ' +
            JSON.stringify(window.vditor.getValue())
        );
        await pause(80);
        const remainingDetailsOpener = root().querySelector(':scope > .vmd-details-opener');
        remainingDetailsOpener.querySelector('summary').click();
        await pause(80);
        const outerDeleteBody = Array.from(root().querySelectorAll(':scope > p')).find(
          (paragraph) => paragraph.textContent.includes('outer delete body')
        );
        expect(
          outerDeleteBody &&
            !outerDeleteBody.classList.contains('vmd-details-content--hidden'),
          'the outer details body was not expanded before its context-menu test'
        );
        await deleteThroughBlockMenu(outerDeleteBody, 'details');
        expect(
          window.vditor.getValue().replace(/\\n+$/, '') ===
            'before delete details\\n\\nafter delete details',
          'right-clicking details content did not delete the complete details group: ' +
            JSON.stringify(window.vditor.getValue())
        );

        await setMarkdown(
          'before delete code\\n\\n' + markerFence + 'js\\nconst deleteCode = true;\\n' +
            markerFence + '\\n\\nafter delete code'
        );
        const deletedCode = root().querySelector(
          ':scope > .vditor-wysiwyg__block[data-type="code-block"]'
        );
        await deleteThroughBlockMenu(deletedCode, 'code-block');
        expect(
          window.vditor.getValue().replace(/\\n+$/, '') ===
            'before delete code\\n\\nafter delete code',
          'deleting a code block left its fence or content in the document: ' +
            JSON.stringify(window.vditor.getValue())
        );

        await setMarkdown('before delete math\\n\\n$$\\ndeleteMath\\n$$');
        const deletedMath = root().querySelector(
          ':scope > .vditor-wysiwyg__block[data-type="math-block"]'
        );
        await deleteThroughBlockMenu(deletedMath, 'math-block');
        expect(
          window.vditor.getValue().replace(/\\n+$/, '') === 'before delete math',
          'deleting a formula block left its delimiters or content in the document: ' +
            JSON.stringify(window.vditor.getValue())
        );
        const previousMathSelection = window.getSelection();
        const previousMathSelectionElement = previousMathSelection?.rangeCount
          ? (previousMathSelection.getRangeAt(0).startContainer.nodeType === Node.ELEMENT_NODE
              ? previousMathSelection.getRangeAt(0).startContainer
              : previousMathSelection.getRangeAt(0).startContainer.parentElement)
          : null;
        expect(
          previousMathSelectionElement?.closest('p')?.textContent.includes('before delete math'),
          'deleting the final region did not move the caret to the preceding block'
        );

        await setMarkdown(
          'before delete html\\n\\n<div>delete HTML block</div>\\n\\nafter delete html'
        );
        const deletedHtml = root().querySelector(
          ':scope > .vditor-wysiwyg__block[data-type="html-block"]'
        );
        await deleteThroughBlockMenu(deletedHtml, 'html-block');
        expect(
          window.vditor.getValue().replace(/\\n+$/, '') ===
            'before delete html\\n\\nafter delete html',
          'deleting an HTML block left its source in the document: ' +
            JSON.stringify(window.vditor.getValue())
        );

        await setMarkdown('| menu | priority |\\n| --- | --- |\\n| table | cell |');
        const contextTableCell = root().querySelector('td');
        contextTableCell.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 50,
          clientY: 50,
        }));
        await pause();
        const tableContextMenu = document.getElementById('vmd-table-context-menu');
        expect(
          getComputedStyle(tableContextMenu).display !== 'none' &&
            getComputedStyle(document.getElementById('vmd-block-context-menu')).display === 'none' &&
            tableContextMenu.querySelector('[data-type="default"]')
              .classList.contains('vmd-table-context-menu__current'),
          'the table menu lost priority or did not recognize implicit default alignment'
        );
        const tableMenuArrowDown = () =>
          (document.activeElement instanceof HTMLElement
            ? document.activeElement
            : document
          ).dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
          }));
        tableMenuArrowDown();
        tableMenuArrowDown();
        tableMenuArrowDown();
        const keyboardCenterAction = document.activeElement;
        expect(
          keyboardCenterAction?.dataset.type === 'center',
          'table menu arrow navigation did not reach center alignment'
        );
        const tableMenuSpace = new KeyboardEvent('keydown', {
          key: ' ',
          bubbles: true,
          cancelable: true,
        });
        keyboardCenterAction.dispatchEvent(tableMenuSpace);
        await pause(100);
        expect(
          tableMenuSpace.defaultPrevented,
          'Space did not execute the focused table menu action'
        );
        let alignedTable = root().querySelector('table');
        expect(
          Array.from(alignedTable.rows).every(
            (row) => row.cells[0]?.getAttribute('align') === 'center'
          ),
          'explicit center alignment did not apply to the complete Markdown column'
        );
        const defaultAlignmentCell = alignedTable.querySelector('td');
        defaultAlignmentCell.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 50,
          clientY: 50,
        }));
        tableContextMenu.querySelector('[data-type="default"]').click();
        await pause(100);
        alignedTable = root().querySelector('table');
        const defaultHeader = alignedTable.rows[0].cells[0];
        const defaultBody = alignedTable.rows[1].cells[0];
        const separatorCell = window.vditor.getValue()
          .split(/\\r?\\n/)
          .find((line) => line.includes('---'))
          .split('|')[1]
          .trim();
        expect(
          Array.from(alignedTable.rows).every(
            (row) => !row.cells[0]?.hasAttribute('align')
          ) &&
            !separatorCell.includes(':') &&
            getComputedStyle(defaultHeader).textAlign === 'center' &&
            ['left', 'start'].includes(getComputedStyle(defaultBody).textAlign),
          'default alignment did not restore centered headers with left-aligned body cells: ' +
            JSON.stringify({
              markdown: window.vditor.getValue(),
              header: getComputedStyle(defaultHeader).textAlign,
              body: getComputedStyle(defaultBody).textAlign,
            })
        );

        // Restore Vditor's original, standalone quote command and icon. GitHub
        // Alert remains an independent control with its own source transforms.
        const nativeQuoteButton = document.querySelector(
          '.vditor-toolbar [data-type="quote"]'
        );
        const alertButton = document.querySelector(
          '.vditor-toolbar [data-type="vmd-alert"]'
        );
        expect(nativeQuoteButton && alertButton, 'the standalone Quote/Alert buttons are missing');
        expect(
          !document.querySelector('.vditor-toolbar [data-type="vmd-quote-plain"]'),
          'the simplified custom Quote button is still rendered'
        );
        const nativeQuoteUse = nativeQuoteButton.querySelector('svg use');
        expect(
          nativeQuoteUse &&
            (nativeQuoteUse.getAttribute('href') || nativeQuoteUse.getAttribute('xlink:href')) ===
              '#vditor-icon-quote',
          "the Quote button did not restore Vditor's original icon"
        );
        expect(
          nativeQuoteButton.parentElement?.nextElementSibling === alertButton.parentElement,
          'the standalone Alert button is not immediately after the native Quote button'
        );
        expect(
          !document.querySelector(
            '.vditor-toolbar [data-type^="vmd-alert-"]'
          ),
          'the toolbar still exposes the old Alert type list'
        );
        const currentQuoteValue = () => window.vditor.getValue().replace(/\\n+$/, '');
        const caretBlockquote = () => {
          const selection = window.getSelection();
          if (!selection?.rangeCount) return null;
          const container = selection.getRangeAt(0).startContainer;
          const element = container.nodeType === Node.ELEMENT_NODE
            ? container
            : container.parentElement;
          return element?.closest?.('blockquote') || null;
        };

        await setMarkdown('before quote\\n\\ncurrent quote line\\n\\nafter quote');
        let currentQuoteText = textNode(root().querySelectorAll(':scope > p')[1]);
        select(currentQuoteText, 7, currentQuoteText, 7);
        nativeQuoteButton.click();
        await pause(80);
        expect(
          currentQuoteValue() === 'before quote\\n\\n> current quote line\\n\\nafter quote',
          "Vditor's native Quote command did not quote the caret block: " +
            JSON.stringify(window.vditor.getValue())
        );
        expect(
          nativeQuoteButton.classList.contains('vditor-menu--current') &&
            caretBlockquote()?.textContent.includes('current quote line'),
          'the native Quote command did not retain its active state and caret'
        );
        nativeQuoteButton.click();
        await pause(80);
        expect(
          currentQuoteValue() === 'before quote\\n\\ncurrent quote line\\n\\nafter quote' &&
            !nativeQuoteButton.classList.contains('vditor-menu--current'),
          'clicking the active native Quote command did not remove the quote: ' +
            JSON.stringify(window.vditor.getValue())
        );

        currentQuoteText = textNode(root().querySelectorAll(':scope > p')[1]);
        select(currentQuoteText, 7, currentQuoteText, 7);
        alertButton.click();
        await pause(80);
        expect(
          currentQuoteValue() === 'before quote\\n\\n> [!NOTE]\\n> current quote line\\n\\nafter quote',
          'GitHub Alert inserted a separate template instead of the default Note Alert: ' +
            JSON.stringify(window.vditor.getValue())
        );
        expect(
          caretBlockquote()?.classList.contains('vmd-alert--note'),
          'GitHub Alert projection lost the caret from the transformed line'
        );
        await selectAlertType(caretBlockquote(), 'TIP');
        expect(
          currentQuoteValue() === 'before quote\\n\\n> [!TIP]\\n> current quote line\\n\\nafter quote',
          'the in-place menu did not switch the Alert type: ' +
            JSON.stringify(window.vditor.getValue())
        );
        expect(
          caretBlockquote()?.classList.contains('vmd-alert--tip'),
          'switching the Alert type lost the body caret'
        );
        alertButton.click();
        await pause(80);
        expect(
          currentQuoteValue() === 'before quote\\n\\ncurrent quote line\\n\\nafter quote',
          'the independent Alert button did not remove the active Alert: ' +
            JSON.stringify(window.vditor.getValue())
        );

        await setMarkdown('before quote\\n\\n> current quote line\\n\\nafter quote');
        currentQuoteText = textNode(root().querySelector(':scope > blockquote p'));
        select(currentQuoteText, 7, currentQuoteText, 7);
        alertButton.click();
        await pause(80);
        expect(
          currentQuoteValue() === 'before quote\\n\\n> [!NOTE]\\n> current quote line\\n\\nafter quote',
          'the Alert button did not convert an existing plain quote to Note in place'
        );
        await selectAlertType(caretBlockquote(), 'WARNING');
        alertButton.click();
        await pause(80);
        expect(
          currentQuoteValue() === 'before quote\\n\\ncurrent quote line\\n\\nafter quote',
          'the independent Alert button did not remove an active non-Note Alert'
        );

        await setMarkdown('> [!NOTE]\\n> first duplicate alert\\n\\n> [!NOTE]\\n> second duplicate alert');
        await pause(80);
        const duplicateAlerts = root().querySelectorAll(':scope > blockquote.vmd-alert');
        const secondAlertWalker = document.createTreeWalker(
          duplicateAlerts[1].querySelector(':scope > p:last-of-type'),
          NodeFilter.SHOW_TEXT
        );
        let secondAlertText = secondAlertWalker.nextNode();
        while (secondAlertText && !secondAlertText.data.includes('second duplicate alert')) {
          secondAlertText = secondAlertWalker.nextNode();
        }
        expect(secondAlertText, 'the second duplicate Alert body was not rendered');
        select(secondAlertText, 4, secondAlertText, 4);
        await selectAlertType(duplicateAlerts[1], 'TIP');
        expect(
          currentQuoteValue() === '> [!NOTE]\\n> first duplicate alert\\n\\n> [!TIP]\\n> second duplicate alert',
          'switching a repeated Alert type changed the wrong block: ' +
            JSON.stringify(window.vditor.getValue())
        );

        await setMarkdown('> first quote line\\n> second quote line');
        const quoteTextWalker = document.createTreeWalker(
          root().querySelector(':scope > blockquote'),
          NodeFilter.SHOW_TEXT
        );
        let secondQuoteText = quoteTextWalker.nextNode();
        while (secondQuoteText && !secondQuoteText.data.includes('second quote line')) {
          secondQuoteText = quoteTextWalker.nextNode();
        }
        expect(secondQuoteText, 'the second plain-quote source line was not rendered');
        const secondQuoteOffset = secondQuoteText.data.indexOf('second quote line') + 4;
        select(secondQuoteText, secondQuoteOffset, secondQuoteText, secondQuoteOffset);
        secondQuoteText.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        }));
        await pause(80);
        const quoteContentLines = () => currentQuoteValue()
          .split('\\n')
          .filter((line) => !/^>+\\s*$/.test(line));
        expect(
          quoteContentLines().join('\\n').replace(/> >/g, '>>') ===
            '> first quote line\\n>> second quote line',
          'Tab indented more than the caret line in a plain quote: ' +
            JSON.stringify(window.vditor.getValue())
        );
        secondQuoteText = textNode(root().querySelector('blockquote blockquote p'));
        select(secondQuoteText, 4, secondQuoteText, 4);
        secondQuoteText.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }));
        await pause(80);
        expect(
          quoteContentLines().join('\\n') === '> first quote line\\n> second quote line',
          'Shift+Tab did not remove exactly one quote marker from the caret line: ' +
            JSON.stringify(window.vditor.getValue())
        );

        await setMarkdown('> first formatted quote\\n> **second formatted quote**');
        const formattedQuoteStrong = root().querySelector('blockquote strong');
        const formattedQuoteText = textNode(formattedQuoteStrong);
        select(formattedQuoteText, 4, formattedQuoteText, 4);
        formattedQuoteText.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        }));
        await pause(80);
        const formattedQuoteLines = currentQuoteValue()
          .split('\\n')
          .filter((line) => !/^>+\\s*$/.test(line));
        expect(
          formattedQuoteLines[0] === '> first formatted quote' &&
            formattedQuoteLines[1]?.replace(/> >/g, '>>') ===
              '>> **second formatted quote**',
          'Tab changed the wrong source line for formatted quote text: ' +
            JSON.stringify(window.vditor.getValue())
        );

        await setMarkdown('> only quote level');
        const onlyQuoteText = textNode(root().querySelector('blockquote p'));
        select(onlyQuoteText, 4, onlyQuoteText, 4);
        onlyQuoteText.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }));
        await pause(80);
        expect(
          currentQuoteValue() === '> only quote level',
          'Shift+Tab removed the final plain quote marker'
        );

        await setMarkdown('> [!NOTE]\\n> alert tab target');
        await pause(80);
        const alertTabBlock = root().querySelector('blockquote');
        expect(
          alertTabBlock,
          'GitHub Alert was not rendered before its Tab no-op check: ' +
            root().innerHTML
        );
        const alertTabText = textNode(alertTabBlock);
        select(alertTabText, 4, alertTabText, 4);
        alertTabText.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        }));
        await pause(80);
        expect(
          currentQuoteValue() === '> [!NOTE]\\n> alert tab target',
          'Tab changed a GitHub Alert block'
        );

        await setMarkdown('before empty\\n\\nempty line\\n\\nafter empty');
        const emptyQuoteLine = root().querySelectorAll(':scope > p')[1];
        const emptyQuoteText = textNode(emptyQuoteLine);
        select(emptyQuoteText, 0, emptyQuoteText, 0);
        alertButton.click();
        await pause(80);
        expect(
          currentQuoteValue() ===
            'before empty\\n\\n> [!NOTE]\\n> empty line\\n\\nafter empty',
          'GitHub Alert did not transform the caret line before the repeated action: ' +
            JSON.stringify(window.vditor.getValue())
        );
        expect(
          caretBlockquote()?.classList.contains('vmd-alert--note'),
          'new Alert projection reloaded the editor and lost its caret'
        );
        await selectAlertType(caretBlockquote(), 'TIP');
        expect(
          currentQuoteValue() ===
            'before empty\\n\\n> [!TIP]\\n> empty line\\n\\nafter empty',
          'the in-place type switch after Alert insertion changed the wrong block'
        );

        await setMarkdown('formula target');
        const formulaText = textNode(root().querySelector(':scope > p'));
        select(formulaText, 0, formulaText, 'formula'.length);
        document.querySelector('.vditor-toolbar [data-type="math-inline"]').click();
        await pause();
        expect(window.vditor.getValue().includes('$formula$'), 'inline formula toolbar did not wrap the selected text');

        await setMarkdown('block formula');
        const blockFormulaText = textNode(root().querySelector(':scope > p'));
        select(blockFormulaText, 0, blockFormulaText, blockFormulaText.textContent.length);
        document.querySelector('.vditor-toolbar [data-type="math-block"]').click();
        await pause();
        expect(window.vditor.getValue().includes('$$\\nblock formula\\n$$'), 'formula-block toolbar did not wrap the selected text');

        const detailsSelectionButton = document.querySelector(
          '.vditor-toolbar [data-type="details"]'
        );

        // A structural selection expands partial endpoints to complete blocks.
        // Touching one list item deliberately includes the complete list.
        await setMarkdown(
          'before mixed details\\n\\npartial paragraph body\\n\\n' +
            '- first list body\\n- second list body\\n\\nafter mixed details'
        );
        const mixedParagraph = root().querySelectorAll(':scope > p')[1];
        const mixedListItems = root().querySelectorAll(':scope > ul > li');
        const mixedStart = textNode(mixedParagraph);
        const mixedEnd = textNode(mixedListItems[1]);
        select(mixedStart, 8, mixedEnd, 6);
        detailsSelectionButton.click();
        await pause(80);
        const mixedDetailsValue = window.vditor.getValue().replace(/\\n+$/, '');
        expect(
          mixedDetailsValue.startsWith('before mixed details\\n\\n<details>') &&
            mixedDetailsValue.includes(
              '\\n\\npartial paragraph body\\n\\n- first list body\\n- second list body' +
                '\\n\\n</details>\\n\\nafter mixed details'
            ),
          'a partial paragraph/list selection did not fold complete blocks: ' +
            JSON.stringify(window.vditor.getValue())
        );

        await setMarkdown(
          'before single list\\n\\n- keep first item\\n- touched second item' +
            '\\n\\nafter single list'
        );
        const touchedListText = textNode(
          root().querySelectorAll(':scope > ul > li')[1]
        );
        select(touchedListText, 3, touchedListText, 9);
        detailsSelectionButton.click();
        await pause(80);
        const singleListDetailsValue = window.vditor.getValue().replace(/\\n+$/, '');
        expect(
          singleListDetailsValue.startsWith('before single list\\n\\n<details>') &&
            singleListDetailsValue.includes(
              '\\n\\n- keep first item\\n- touched second item' +
                '\\n\\n</details>\\n\\nafter single list'
            ),
          'touching one list item did not fold the complete list: ' +
            JSON.stringify(window.vditor.getValue())
        );

        await setMarkdown(
          'before table details\\n\\n| A | B |\\n| --- | --- |\\n| one | two |' +
            '\\n\\nafter table details'
        );
        const touchedTableCell = textNode(root().querySelector('tbody td'));
        select(touchedTableCell, 0, touchedTableCell, 1);
        detailsSelectionButton.click();
        await pause(80);
        const tableDetailsValue = window.vditor.getValue().replace(/\\n+$/, '');
        expect(
          tableDetailsValue.startsWith('before table details\\n\\n<details>') &&
            tableDetailsValue.includes('| A') &&
            tableDetailsValue.includes('| one') &&
            tableDetailsValue.includes('| --- | --- |') &&
            tableDetailsValue.endsWith('</details>\\n\\nafter table details'),
          'touching one table cell did not fold the complete table: ' +
            JSON.stringify(window.vditor.getValue())
        );

        await setMarkdown('collapsible body');
        const detailsText = textNode(root().querySelector(':scope > p'));
        select(detailsText, 0, detailsText, detailsText.textContent.length);
        window.vditor.vditor.wysiwyg.range = window.getSelection().getRangeAt(0).cloneRange();
        select(result.firstChild, 0, result.firstChild, 0);
        document.querySelector('.vditor-toolbar [data-type="details"]').click();
        await pause();
        expect(
          window.vditor.getValue().includes('<details>') &&
          window.vditor.getValue().includes('<summary>') &&
          window.vditor.getValue().includes('</summary>') &&
          window.vditor.getValue().includes('\\ncollapsible body\\n'),
          'collapsible-section toolbar did not wrap the selected text'
        );

        await setMarkdown('**formatted body**');
        const formattedText = textNode(root().querySelector(':scope > p'));
        select(formattedText, 0, formattedText, formattedText.textContent.length);
        document.querySelector('.vditor-toolbar [data-type="details"]').click();
        await pause();
        expect(
          window.vditor.getValue().includes('**formatted body**') &&
          !window.vditor.getValue().includes('**<details>'),
          'formatted selection was split by the collapsible-section insertion'
        );

        await setMarkdown('duplicate\\n\\nduplicate');
        const duplicateBlocks = Array.from(root().querySelectorAll(':scope > p'));
        const secondDuplicate = textNode(duplicateBlocks[1]);
        select(secondDuplicate, 0, secondDuplicate, secondDuplicate.textContent.length);
        document.querySelector('.vditor-toolbar [data-type="details"]').click();
        await pause();
        const duplicateValue = window.vditor.getValue();
        expect(
          duplicateValue.indexOf('<details>') > duplicateValue.indexOf('duplicate'),
          'the collapsible-section insertion wrapped the first duplicate instead of the selected one'
        );

        await setMarkdown('before block\\n\\ncaret target\\n\\nafter block');
        const caretText = textNode(root().querySelectorAll(':scope > p')[1]);
        select(caretText, 0, caretText, 0);
        window.vditor.vditor.wysiwyg.range = undefined;
        const detailsButton = document.querySelector('.vditor-toolbar [data-type="details"]');
        detailsButton.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerType: 'mouse',
        }));
        select(result.firstChild, 0, result.firstChild, 0);
        detailsButton.click();
        await pause();
        const caretInsertionValue = window.vditor.getValue();
        expect(
          caretInsertionValue.indexOf('<details>') > caretInsertionValue.indexOf('before block') &&
            caretInsertionValue.indexOf('<details>') < caretInsertionValue.indexOf('caret target') &&
            caretInsertionValue.indexOf('<details>') < caretInsertionValue.indexOf('after block'),
          'the WYSIWYG toolbar lost the middle-document caret and appended details at the end'
        );

        // A caret can land inside serializer-owned ordinary-code previews.
        // Destructive input now opens the exact in-place editor and edits at
        // that caret; whole-block clipboard/deletion remains available after an
        // explicit complete-code selection.
        const protectedCodeMarkdown =
          markerFence + 'js\\nconst protectedValue = true;\\n' + markerFence;
        await setMarkdown(protectedCodeMarkdown);
        await pause(100);
        let protectedCodeBlock = root().querySelector(
          ':scope > .vditor-wysiwyg__block[data-type="code-block"]'
        );
        const protectedCodeText = textNode(
          protectedCodeBlock.querySelector(':scope > .vditor-wysiwyg__preview > code')
        );
        select(protectedCodeText, 6, protectedCodeText, 6);
        const firstProtectedDelete = new KeyboardEvent('keydown', {
          key: 'Backspace',
          bubbles: true,
          cancelable: true,
        });
        protectedCodeText.dispatchEvent(firstProtectedDelete);
        await pause(80);
        protectedCodeBlock = root().querySelector(
          ':scope > .vditor-wysiwyg__block[data-type="code-block"]'
        );
        const protectedSourcePopover = document.querySelector(
          '.vmd-source-popover--code-overlay'
        );
        expect(
          firstProtectedDelete.defaultPrevented &&
            protectedSourcePopover?.style.display === 'block' &&
            protectedSourcePopover.querySelector('[name="content"]')?.value ===
              'constprotectedValue = true;' &&
            !protectedCodeBlock?.classList.contains('vmd-code-block--selected'),
          'Backspace inside ordinary code did not edit at the caret in place: ' +
            JSON.stringify({
              prevented: firstProtectedDelete.defaultPrevented,
              value: window.vditor.getValue(),
              block: protectedCodeBlock?.outerHTML.slice(0, 1200),
              popover: protectedSourcePopover?.outerHTML.slice(0, 800),
            })
        );
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }));
        await pause(80);
        window.vditor.vditor.undo.undo(window.vditor.vditor);
        await pause(100);
        protectedCodeBlock = root().querySelector(
          ':scope > .vditor-wysiwyg__block[data-type="code-block"]'
        );
        const protectedVisibleCode = protectedCodeBlock.querySelector(
          ':scope > .vditor-wysiwyg__preview > code'
        );
        const protectedWholeRange = document.createRange();
        protectedWholeRange.selectNodeContents(protectedVisibleCode);
        const protectedWholeSelection = window.getSelection();
        protectedWholeSelection.removeAllRanges();
        protectedWholeSelection.addRange(protectedWholeRange);
        await pause(40);
        expect(
          protectedCodeBlock.classList.contains('vmd-code-block--selected'),
          'an explicit complete ordinary-code selection did not select its block'
        );
        const protectedCopyTransfer = new DataTransfer();
        const protectedCopy = new ClipboardEvent('copy', {
          bubbles: true,
          cancelable: true,
          clipboardData: protectedCopyTransfer,
        });
        root().dispatchEvent(protectedCopy);
        expect(
          protectedCopy.defaultPrevented &&
            protectedCopyTransfer.getData('text/plain') === protectedCodeMarkdown &&
            protectedCopyTransfer.getData('text/html') === '',
          'whole-code-block copy did not preserve its complete Markdown as plain text: ' +
            JSON.stringify({
              plain: protectedCopyTransfer.getData('text/plain'),
              types: Array.from(protectedCopyTransfer.types),
            })
        );

        const afterProtectedRange = document.createRange();
        afterProtectedRange.selectNode(protectedCodeBlock);
        afterProtectedRange.collapse(false);
        const afterProtectedSelection = window.getSelection();
        afterProtectedSelection.removeAllRanges();
        afterProtectedSelection.addRange(afterProtectedRange);
        const enterAfterProtectedBlock = new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        });
        root().dispatchEvent(enterAfterProtectedBlock);
        await pause(80);
        protectedCodeBlock = root().querySelector(
          ':scope > .vditor-wysiwyg__block[data-type="code-block"]'
        );
        const paragraphAfterProtectedBlock = protectedCodeBlock?.nextElementSibling;
        expect(
          enterAfterProtectedBlock.defaultPrevented &&
            paragraphAfterProtectedBlock?.tagName === 'P' &&
            !window.vditor.getValue().replace(/\\n+$/, '').localeCompare(protectedCodeMarkdown),
          'Enter on a selected code block did not create an editable paragraph after it'
        );

        const pasteProtectedTransfer = new DataTransfer();
        pasteProtectedTransfer.setData('text/plain', protectedCodeMarkdown);
        const pasteProtectedBlock = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: pasteProtectedTransfer,
        });
        paragraphAfterProtectedBlock.dispatchEvent(pasteProtectedBlock);
        await pause(120);
        expect(
          root().querySelectorAll(
            ':scope > .vditor-wysiwyg__block[data-type="code-block"]'
          ).length === 2 &&
            window.vditor.getValue().split(protectedCodeMarkdown).length === 3,
          'pasting copied whole-block plain text did not recreate the same code block: ' +
            JSON.stringify(window.vditor.getValue())
        );

        const adjacentProtectedMarkdown = protectedCodeMarkdown + '\\n\\nafter protected block';
        await setMarkdown(adjacentProtectedMarkdown);
        protectedCodeBlock = root().querySelector(
          ':scope > .vditor-wysiwyg__block[data-type="code-block"]'
        );
        const adjacentParagraph = protectedCodeBlock.nextElementSibling;
        const adjacentText = textNode(adjacentParagraph);
        select(adjacentText, 0, adjacentText, 0);
        const adjacentBackspace = new KeyboardEvent('keydown', {
          key: 'Backspace',
          bubbles: true,
          cancelable: true,
        });
        adjacentText.dispatchEvent(adjacentBackspace);
        await pause(80);
        expect(
          adjacentBackspace.defaultPrevented &&
            protectedCodeBlock.classList.contains('vmd-code-block--selected') &&
            getComputedStyle(
              protectedCodeBlock.querySelector(':scope > pre:not(.vditor-wysiwyg__preview)')
            ).display === 'none' &&
            window.vditor.getValue().replace(/\\n+$/, '') === adjacentProtectedMarkdown,
          'Backspace at text immediately after an atomic block revealed its hidden source'
        );
        root().dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }));

        await setMarkdown(protectedCodeMarkdown);
        protectedCodeBlock = root().querySelector(
          ':scope > .vditor-wysiwyg__block[data-type="code-block"]'
        );
        const repeatedDeleteCode = protectedCodeBlock.querySelector(
          ':scope > .vditor-wysiwyg__preview > code'
        );
        const repeatedDeleteRange = document.createRange();
        repeatedDeleteRange.selectNodeContents(repeatedDeleteCode);
        const repeatedDeleteSelection = window.getSelection();
        repeatedDeleteSelection.removeAllRanges();
        repeatedDeleteSelection.addRange(repeatedDeleteRange);
        await pause(40);
        root().dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Delete',
          bubbles: true,
          cancelable: true,
        }));
        await pause(100);
        expect(
          !window.vditor.getValue().trim() &&
            !root().querySelector('[data-type="code-block"]') &&
            root().firstElementChild?.tagName === 'P',
          'Delete did not remove only an explicitly selected code block'
        );

        const cutBlockMarkdown =
          markerFence + 'python\\nprint("cut block")\\n' + markerFence;
        await setMarkdown('before cut block\\n\\n' + cutBlockMarkdown + '\\n\\nafter cut block');
        const cutCodeBlock = root().querySelector(
          ':scope > .vditor-wysiwyg__block[data-type="code-block"]'
        );
        const cutCode = cutCodeBlock.querySelector(
          ':scope > .vditor-wysiwyg__preview > code'
        );
        const cutCodeRange = document.createRange();
        cutCodeRange.selectNodeContents(cutCode);
        const cutCodeSelection = window.getSelection();
        cutCodeSelection.removeAllRanges();
        cutCodeSelection.addRange(cutCodeRange);
        await pause(40);
        const wholeBlockCutTransfer = new DataTransfer();
        const wholeBlockCut = new ClipboardEvent('cut', {
          bubbles: true,
          cancelable: true,
          clipboardData: wholeBlockCutTransfer,
        });
        root().dispatchEvent(wholeBlockCut);
        await pause(100);
        expect(
          wholeBlockCut.defaultPrevented &&
            wholeBlockCutTransfer.getData('text/plain') === cutBlockMarkdown &&
            wholeBlockCutTransfer.getData('text/html') === '' &&
            window.vditor.getValue().replace(/\\n+$/, '') ===
              'before cut block\\n\\nafter cut block',
          'cutting a selected code block did not copy exact plain Markdown and remove the block safely'
        );

        await setMarkdown(protectedCodeMarkdown);
        const draggedOrdinaryBlock = root().querySelector(
          ':scope > .vditor-wysiwyg__block[data-type="code-block"]'
        );
        const draggedOrdinaryCode = draggedOrdinaryBlock.querySelector(
          ':scope > .vditor-wysiwyg__preview > code'
        );
        const draggedOrdinaryRange = document.createRange();
        draggedOrdinaryRange.selectNodeContents(draggedOrdinaryCode);
        const draggedOrdinarySelection = window.getSelection();
        draggedOrdinarySelection.removeAllRanges();
        draggedOrdinarySelection.addRange(draggedOrdinaryRange);
        await pause(40);
        expect(
          draggedOrdinaryBlock.classList.contains('vmd-code-block--selected'),
          'selecting all visible ordinary-code text did not promote to whole-block selection'
        );

        const mermaidBlockMarkdown =
          markerFence + 'mermaid\\ngraph TD\\n  A --> B\\n' + markerFence;
        await setMarkdown(mermaidBlockMarkdown);
        await pause(120);
        const mermaidBlock = root().querySelector(
          ':scope > .vditor-wysiwyg__block[data-type="code-block"]'
        );
        const mermaidPreview = mermaidBlock.querySelector(
          ':scope > .vditor-wysiwyg__preview'
        );
        const mermaidRect = mermaidBlock.getBoundingClientRect();
        const mermaidDragX = mermaidRect.left + mermaidRect.width / 2;
        const mermaidDragY = mermaidRect.top + mermaidRect.height / 2;
        mermaidPreview.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: mermaidDragX,
          clientY: mermaidDragY,
          pointerId: 27,
          pointerType: 'mouse',
        }));
        document.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true,
          clientX: mermaidDragX + 20,
          clientY: mermaidDragY + 20,
          pointerId: 27,
          pointerType: 'mouse',
        }));
        document.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true,
          button: 0,
          clientX: mermaidDragX + 20,
          clientY: mermaidDragY + 20,
          pointerId: 27,
          pointerType: 'mouse',
        }));
        await pause(40);
        expect(
          mermaidBlock.classList.contains('vmd-code-block--rich') &&
            !mermaidBlock.classList.contains('vmd-code-block--selected') &&
            getComputedStyle(mermaidPreview).cursor === 'text',
          'the Mermaid preview retained pointer styling or promoted dragging to whole-block selection'
        );
        mermaidPreview.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: mermaidRect.right - 2,
          clientY: mermaidDragY,
          pointerType: 'mouse',
        }));
        root().dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Backspace',
          bubbles: true,
          cancelable: true,
        }));
        expect(
          mermaidBlock.classList.contains('vmd-code-block--selected'),
          'Backspace from a Mermaid boundary did not retain explicit whole-block selection'
        );
        const mermaidCopyTransfer = new DataTransfer();
        const mermaidCopy = new ClipboardEvent('copy', {
          bubbles: true,
          cancelable: true,
          clipboardData: mermaidCopyTransfer,
        });
        root().dispatchEvent(mermaidCopy);
        expect(
          mermaidCopyTransfer.getData('text/plain') === mermaidBlockMarkdown &&
            mermaidCopyTransfer.getData('text/html') === '',
          'whole-block Mermaid copy did not preserve its complete source'
        );

        for (const atomicFixture of [
          {
            source: '$$\\natomicMath\\n$$',
            selector: '[data-type="math-block"]',
            label: 'formula',
          },
          {
            source: '<div>atomic HTML source</div>',
            selector: '[data-type="html-block"]',
            label: 'HTML',
          },
        ]) {
          await setMarkdown(atomicFixture.source);
          await pause(80);
          const atomicBlock = root().querySelector(
            ':scope > .vditor-wysiwyg__block' + atomicFixture.selector
          );
          const atomicPreview = atomicBlock.querySelector(
            ':scope > .vditor-wysiwyg__preview'
          );
          const atomicRect = atomicBlock.getBoundingClientRect();
          atomicPreview.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: atomicRect.right - 2,
            clientY: atomicRect.top + atomicRect.height / 2,
            pointerType: 'mouse',
          }));
          root().dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Backspace',
            bubbles: true,
            cancelable: true,
          }));
          const atomicCopyTransfer = new DataTransfer();
          root().dispatchEvent(new ClipboardEvent('copy', {
            bubbles: true,
            cancelable: true,
            clipboardData: atomicCopyTransfer,
          }));
          expect(
            atomicBlock.classList.contains('vmd-code-block--selected') &&
              atomicCopyTransfer.getData('text/plain') === atomicFixture.source &&
              atomicCopyTransfer.getData('text/html') === '',
            atomicFixture.label +
              ' did not reuse whole-block selection and exact plain-source copy'
          );

          root().dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }));
          atomicPreview.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: atomicRect.left + 2,
            clientY: atomicRect.top + atomicRect.height / 2,
            pointerType: 'mouse',
          }));
          root().dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
          }));
          await pause(80);
          expect(
            atomicBlock.previousElementSibling?.tagName === 'P' &&
              window.vditor.getValue().includes(atomicFixture.source),
            'Enter at the left edge did not insert a paragraph before the ' +
              atomicFixture.label + ' block'
          );
        }

        // Clipboard behavior is normalized per mode. WYSIWYG exports Markdown
        // plus rich HTML, and cut falls back when Electron rejects execCommand.
        await setMarkdown('copy **bold** tail');
        const clipboardParagraph = root().querySelector(':scope > p');
        const clipboardStart = Array.from(clipboardParagraph.childNodes).find(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent.includes('copy')
        );
        const clipboardStrong = clipboardParagraph.querySelector('strong');
        const clipboardStrongText = textNode(clipboardStrong);
        select(clipboardStart, 0, clipboardStrongText, clipboardStrongText.length);
        const copyTransfer = new DataTransfer();
        const selectionCopy = new ClipboardEvent('copy', {
          bubbles: true,
          cancelable: true,
          clipboardData: copyTransfer,
        });
        clipboardStart.dispatchEvent(selectionCopy);
        expect(
          selectionCopy.defaultPrevented &&
            copyTransfer.getData('text/plain').includes('copy **bold**') &&
            copyTransfer.getData('text/html').includes('<strong>bold</strong>'),
          'WYSIWYG copy did not expose Markdown text and cleaned rich HTML: ' +
            JSON.stringify({
              plain: copyTransfer.getData('text/plain'),
              html: copyTransfer.getData('text/html'),
            })
        );

        select(clipboardStart, 0, clipboardStart, 4);
        const cutTransfer = new DataTransfer();
        window.__vmdForceDeleteFailure = true;
        const selectionCut = new ClipboardEvent('cut', {
          bubbles: true,
          cancelable: true,
          clipboardData: cutTransfer,
        });
        clipboardStart.dispatchEvent(selectionCut);
        window.__vmdForceDeleteFailure = false;
        await pause(100);
        expect(
          selectionCut.defaultPrevented &&
            cutTransfer.getData('text/plain') === 'copy' &&
            !window.vditor.getValue().startsWith('copy'),
          'WYSIWYG cut did not delete through the Range fallback: ' +
            JSON.stringify(window.vditor.getValue())
        );
        window.vditor.vditor.undo.undo(window.vditor.vditor);
        await pause(100);
        expect(
          window.vditor.getValue().includes('copy **bold** tail'),
          'the normalized WYSIWYG cut was not a single undoable edit'
        );

        await switchMode('sv');
        await setMarkdown('prefix\\nexact source\\nsuffix');
        const sourcePaneForClipboard = window.vditor.vditor.sv.element;
        const sourceSelectionNode = selectTextOccurrence(
          sourcePaneForClipboard,
          'exact source'
        );
        const sourceCopyTransfer = new DataTransfer();
        const sourceCopy = new ClipboardEvent('copy', {
          bubbles: true,
          cancelable: true,
          clipboardData: sourceCopyTransfer,
        });
        sourceSelectionNode.dispatchEvent(sourceCopy);
        expect(
          sourceCopyTransfer.getData('text/plain') === 'exact source' &&
            sourceCopyTransfer.getData('text/html') === '',
          'SV copy did not preserve exact source text only'
        );
        selectTextOccurrence(sourcePaneForClipboard, 'exact', true);
        const sourcePasteTransfer = new DataTransfer();
        sourcePasteTransfer.setData('text/plain', '<b>X</b>');
        sourcePasteTransfer.setData('text/html', '<b>X</b>');
        const sourcePaste = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: sourcePasteTransfer,
        });
        window.getSelection().getRangeAt(0).startContainer.dispatchEvent(sourcePaste);
        await pause(100);
        expect(
          sourcePaste.defaultPrevented &&
            window.vditor.getValue().includes('exact<b>X</b> source'),
          'SV paste interpreted clipboard HTML instead of inserting exact text: ' +
            JSON.stringify(window.vditor.getValue())
        );
        await switchMode('wysiwyg');

        await setMarkdown('find target');
        const nativeFindEvent = new KeyboardEvent('keydown', {
          key: 'f',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        });
        root().dispatchEvent(nativeFindEvent);
        expect(
          !nativeFindEvent.defaultPrevented &&
            !document.getElementById('vmd-search-bar'),
          'the removed custom search still intercepted Ctrl+F or mounted its UI'
        );

        const copyCodeFence = String.fromCharCode(96).repeat(3);
        await setMarkdown(copyCodeFence + 'js\\nconst copyTarget = 1;\\n' + copyCodeFence);
        await pause(120);
        const codeCopyButton = document.querySelector('.vditor-wysiwyg .vditor-copy .vditor-tooltipped');
        expect(codeCopyButton, 'the visual editor code block did not render a copy control');
        const copyAttemptsBefore = window.__vmdCodeCopyAttempts;
        const codeCopyIcon = codeCopyButton.querySelector('svg') || codeCopyButton;
        codeCopyIcon.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await pause();
        expect(window.__vmdCodeCopyAttempts === copyAttemptsBefore + 1, 'code block copy did not invoke the clipboard command');
        const copySuccessFeedback = codeCopyButton.querySelector(
          ':scope > .vmd-code-copy-feedback'
        );
        expect(
          codeCopyButton.getAttribute('aria-label') === (window.VditorI18n.copied || 'Copied') &&
            codeCopyButton.classList.contains('vmd-code-copy--success') &&
            copySuccessFeedback?.textContent ===
              '✓ ' + (window.VditorI18n.copied || 'Copied') &&
            getComputedStyle(copySuccessFeedback).display !== 'none',
          'code block copy did not show an explicit visible success status'
        );
        await pause(1600);
        expect(
          !codeCopyButton.classList.contains('vmd-code-copy--feedback') &&
            !codeCopyButton.querySelector('.vmd-code-copy-feedback') &&
            codeCopyButton.getAttribute('aria-label') ===
              (window.VditorI18n.copy || 'Copy'),
          'code block copy success status did not restore the normal control'
        );

        await setMarkdown('toolbar-only mode target');
        const shortcutParagraph = root().querySelector(':scope > p');
        const shortcutWalker = document.createTreeWalker(
          shortcutParagraph,
          NodeFilter.SHOW_TEXT
        );
        let shortcutText = shortcutWalker.nextNode();
        while (shortcutText && shortcutText.textContent.length < 2) {
          shortcutText = shortcutWalker.nextNode();
        }
        expect(shortcutText, 'the shortcut target did not contain selectable text');
        select(shortcutText, 2, shortcutText, 2);
        const removedMiddleShortcut = new KeyboardEvent('keydown', {
          key: '8',
          code: 'Digit8',
          ctrlKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true,
        });
        root().dispatchEvent(removedMiddleShortcut);
        expect(removedMiddleShortcut.defaultPrevented, 'the disabled mode shortcut was not consumed');
        expect(window.vditor.vditor.currentMode === 'wysiwyg', 'a disabled shortcut changed the editor mode');

        const savedModesBeforeShortcuts = window.__vmdMessages.filter(
          (message) => message.command === 'save-options'
        ).length;
        for (const code of ['Digit7', 'Digit8', 'Digit9']) {
          const shortcut = new KeyboardEvent('keydown', {
            key: code.replace('Digit', ''),
            code,
            ctrlKey: true,
            altKey: true,
            bubbles: true,
            cancelable: true,
          });
          root().dispatchEvent(shortcut);
          expect(shortcut.defaultPrevented, code + ' toolbar-only shortcut was not consumed');
          expect(
            window.vditor.vditor.currentMode === 'wysiwyg',
            code + ' bypassed the toolbar-only mode policy'
          );
        }
        await pause();
        expect(
          window.__vmdMessages.filter((message) => message.command === 'save-options').length === savedModesBeforeShortcuts,
          'disabled mode shortcuts emitted save-options'
        );

        await switchMode('sv');
        const svRoot = document.querySelector('.vditor-sv');
        const splitPreviewRoot = window.vditor.vditor.preview.previewElement;

        testCheckpoint = 'Split View Front Matter and GitHub Alert presentation';
        const splitPresentationMarkdown = lines(
          '---',
          'title: Split document',
          'published: true',
          'tags:',
          '  - first',
          '  - second',
          '---',
          '',
          '> [!NOTE] 自定义标题',
          '> Alert **body**',
          '',
          '> ordinary quote',
          '',
          '- > [!TIP]',
          '  > nested list Alert',
          '',
          '<details>',
          '',
          '> [!WARNING]',
          '> details Alert',
          '',
          '</details>',
          ''
        );
        await setMarkdown(splitPresentationMarkdown);
        await wait(() =>
          splitPreviewRoot.querySelector(':scope > .vmd-split-front-matter table') &&
          splitPreviewRoot.querySelector(':scope > blockquote.vmd-alert')
        );
        const splitFrontMatter = splitPreviewRoot.querySelector(
          ':scope > .vmd-split-front-matter'
        );
        const splitAlert = splitPreviewRoot.querySelector(
          ':scope > blockquote.vmd-alert'
        );
        const splitPlainQuote = Array.from(
          splitPreviewRoot.querySelectorAll(':scope > blockquote')
        ).find((quote) => quote.textContent.includes('ordinary quote'));
        expect(
          splitFrontMatter?.dataset.vmdMode === 'table' &&
            splitFrontMatter.querySelector('caption')?.textContent === 'Front Matter' &&
            splitFrontMatter.textContent.includes('Split document') &&
            splitFrontMatter.textContent.includes('published') &&
            !splitPreviewRoot.querySelector(':scope > pre.vditor-yml-front-matter'),
          'Split View did not replace native YAML source with the configured Front Matter table: ' +
            splitPreviewRoot.innerHTML.slice(0, 2000)
        );
        expect(
          splitAlert?.dataset.vmdAlert === 'NOTE' &&
            splitAlert.querySelector(':scope > .vmd-alert-title')?.tagName === 'DIV' &&
            splitAlert.querySelector(':scope > .vmd-alert-title')?.textContent === '自定义标题' &&
            !splitAlert.querySelector(':scope > .vmd-alert-title')?.hasAttribute('aria-haspopup') &&
            splitAlert.querySelector('strong')?.textContent === 'body' &&
            !splitAlert.textContent.includes('[!NOTE]') &&
            !splitPlainQuote?.classList.contains('vmd-alert') &&
            splitPreviewRoot.querySelector('li blockquote')?.textContent.includes('[!TIP]') &&
            splitPreviewRoot.querySelector('details blockquote')?.textContent.includes('[!WARNING]'),
          'Split View did not render only a top-level GitHub Alert as a read-only presentation: ' +
            splitPreviewRoot.innerHTML.slice(0, 3000)
        );
        expect(
          window.vditor.getValue().replace(/\\n+$/, '') ===
            splitPresentationMarkdown.replace(/\\n+$/, ''),
          'Split View presentation changed Front Matter or Alert Markdown source: ' +
            JSON.stringify(window.vditor.getValue())
        );

        const invalidSplitFrontMatter = lines(
          '---',
          'metadata: [unsupported, flow]',
          '---',
          '',
          'Invalid YAML body',
          ''
        );
        await setMarkdown(invalidSplitFrontMatter);
        await wait(() =>
          splitPreviewRoot.querySelector('.vmd-front-matter--error')
        );
        expect(
          splitPreviewRoot.querySelector('.vmd-front-matter__error')?.textContent.includes('解析失败') &&
            splitPreviewRoot.querySelector('.vmd-front-matter__raw')?.textContent ===
              'metadata: [unsupported, flow]' &&
            window.vditor.getValue().replace(/\\n+$/, '') ===
              invalidSplitFrontMatter.replace(/\\n+$/, ''),
          'Split View did not show invalid Front Matter source and its parse error'
        );

        const updatedSplitPresentation = lines(
          '---',
          'title: Updated split document',
          '---',
          '',
          '> [!CAUTION]',
          '> Updated Alert body',
          ''
        );
        await setMarkdown(updatedSplitPresentation);
        await wait(() =>
          splitPreviewRoot.querySelector('.vmd-front-matter')?.textContent.includes('Updated split document') &&
          splitPreviewRoot.querySelector(':scope > blockquote.vmd-alert--caution')
        );
        expect(
          splitPreviewRoot.querySelector(':scope > blockquote .vmd-alert-title')?.textContent === 'Caution' &&
            window.vditor.getValue().replace(/\\n+$/, '') ===
              updatedSplitPresentation.replace(/\\n+$/, ''),
          'Split View Front Matter or Alert presentation did not refresh after a source update'
        );
        testCheckpoint = 'Split View toolbar shortcuts';

        const savedModesBeforeSvShortcuts = window.__vmdMessages.filter(
          (message) => message.command === 'save-options'
        ).length;
        for (const code of ['Digit7', 'Digit8', 'Digit9']) {
          const shortcut = new KeyboardEvent('keydown', {
            key: code.replace('Digit', ''),
            code,
            ctrlKey: true,
            altKey: true,
            bubbles: true,
            cancelable: true,
          });
          svRoot.dispatchEvent(shortcut);
          expect(shortcut.defaultPrevented, code + ' toolbar-only Split View shortcut was not consumed');
          expect(
            window.vditor.vditor.currentMode === 'sv',
            code + ' bypassed the toolbar-only Split View policy'
          );
        }
        expect(
          window.__vmdMessages.filter((message) => message.command === 'save-options').length === savedModesBeforeSvShortcuts,
          'disabled Split View shortcuts emitted save-options'
        );
        const svQuoteValue = () => window.vditor.getValue().replace(/\\n+$/, '');
        const findSvText = (value) => {
          const walker = document.createTreeWalker(svRoot, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.data.includes(value)) return node;
          }
          throw new Error('Expected Split View text: ' + value);
        };

        await setMarkdown(
          'SV before details\\n\\nSV paragraph outside\\n\\n' +
            '- SV first list item\\n- SV touched list item\\n\\nSV after details'
        );
        const svTouchedListText = findSvText('SV touched list item');
        const svTouchedOffset = svTouchedListText.data.indexOf('touched');
        select(
          svTouchedListText,
          svTouchedOffset,
          svTouchedListText,
          svTouchedOffset + 4
        );
        document.querySelector('.vditor-toolbar [data-type="details"]').click();
        await pause(80);
        const svDetailsValue = window.vditor.getValue().replace(/\\n+$/, '');
        expect(
          svDetailsValue.startsWith(
            'SV before details\\n\\nSV paragraph outside\\n\\n<details>'
          ) &&
            svDetailsValue.includes(
              '\\n\\n- SV first list item\\n- SV touched list item\\n\\n</details>'
            ) &&
            svDetailsValue.endsWith('SV after details'),
          'Split View did not fold the complete list touched by a partial selection: ' +
            JSON.stringify(window.vditor.getValue())
        );

        await setMarkdown('SV before\\nSV current\\nSV after');
        let svCurrent = findSvText('SV current');
        let svCurrentOffset = svCurrent.data.indexOf('SV current') + 3;
        select(svCurrent, svCurrentOffset, svCurrent, svCurrentOffset);
        nativeQuoteButton.click();
        await pause(80);
        expect(
          svQuoteValue() === 'SV before\\n\\n> SV current\\n> SV after',
          'Split View plain quote did not transform the caret line in place: ' +
            JSON.stringify(window.vditor.getValue())
        );
        const svAfterPlainQuote = window.getSelection();
        expect(
          svAfterPlainQuote?.rangeCount &&
            svAfterPlainQuote.getRangeAt(0).startContainer.parentElement?.textContent.includes('SV current'),
          'Split View plain quote did not restore the caret to its transformed line: ' +
            JSON.stringify({
              container: svAfterPlainQuote?.rangeCount
                ? svAfterPlainQuote.getRangeAt(0).startContainer.textContent
                : null,
              root: svRoot.textContent,
            })
        );
        alertButton.click();
        await pause(80);
        expect(
          svQuoteValue() === 'SV before\\n\\n> [!NOTE]\\n> SV current\\n> SV after',
          'Split View plain quote did not switch to the default Note Alert in place: ' +
            JSON.stringify(window.vditor.getValue())
        );
        const svAfterAlert = window.getSelection();
        expect(
          svAfterAlert?.rangeCount &&
            svAfterAlert.getRangeAt(0).startContainer.parentElement?.textContent.includes('SV current'),
          'Split View Alert switch did not keep the caret on its content line'
        );
        alertButton.click();
        await pause(80);
        expect(
          svQuoteValue() === 'SV before\\n\\nSV current\\nSV after',
          'Split View active Alert did not toggle off in place: ' +
            JSON.stringify(window.vditor.getValue())
        );

        await setMarkdown('> > [!NOTE]\\n> > nested SV Alert body');
        const nestedSvAlertText = findSvText('nested SV Alert body');
        const nestedSvAlertOffset = nestedSvAlertText.data.indexOf('nested SV Alert body');
        select(
          nestedSvAlertText,
          nestedSvAlertOffset,
          nestedSvAlertText,
          nestedSvAlertOffset
        );
        const nestedSvAlertSource = window.vditor.getValue();
        alertButton.click();
        await pause(80);
        expect(
          window.vditor.getValue() === nestedSvAlertSource,
          'Split View Alert toolbar changed Markdown inside a nested quote'
        );

        await setMarkdown('<details>\\n\\nSV details Alert body\\n\\n</details>');
        const detailsSvAlertText = findSvText('SV details Alert body');
        const detailsSvAlertOffset = detailsSvAlertText.data.indexOf('SV details Alert body');
        select(
          detailsSvAlertText,
          detailsSvAlertOffset,
          detailsSvAlertText,
          detailsSvAlertOffset
        );
        const detailsSvAlertSource = window.vditor.getValue();
        alertButton.click();
        await pause(80);
        expect(
          window.vditor.getValue() === detailsSvAlertSource,
          'Split View Alert toolbar changed Markdown inside details'
        );

        await setMarkdown('SV plain Tab target');
        const svPlainText = textNode(svRoot, 3);
        select(svPlainText, 2, svPlainText, 2);
        const svPlainTabEvent = new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        });
        svRoot.dispatchEvent(svPlainTabEvent);
        expect(svPlainTabEvent.defaultPrevented, 'SV Tab outside a list was allowed to move focus');

        await setMarkdown('| first | second |\\n| --- | --- |\\n| one | two |');
        const svTableText = textNode(svRoot, 3);
        select(svTableText, 2, svTableText, 2);
        const svTableTabEvent = new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        });
        svRoot.dispatchEvent(svTableTabEvent);
        expect(svTableTabEvent.defaultPrevented, 'SV table-source Tab was allowed to move focus');

        await setMarkdown('- first\\n- source item');
        const sourceListText = svRoot.querySelectorAll('[data-type="text"]')[1];
        const sourceListBodyText = textNode(sourceListText);
        select(sourceListBodyText, 2, sourceListBodyText, 2);
        const sourceListBodyTabEvent = new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        });
        svRoot.dispatchEvent(sourceListBodyTabEvent);
        expect(sourceListBodyTabEvent.defaultPrevented, 'SV Tab in ordinary list text was allowed to move focus');
        const sourceListBodyShiftTabEvent = new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        });
        svRoot.dispatchEvent(sourceListBodyShiftTabEvent);
        expect(sourceListBodyShiftTabEvent.defaultPrevented, 'SV Shift+Tab in ordinary list text was allowed to move focus');

        const sourceListMarker = svRoot.querySelectorAll('[data-type="li-marker"]')[1];
        const sourceMarkerText = textNode(sourceListMarker);
        select(sourceMarkerText, sourceMarkerText.textContent.length, sourceMarkerText, sourceMarkerText.textContent.length);
        const sourceListTabEvent = new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        });
        svRoot.dispatchEvent(sourceListTabEvent);
        expect(sourceListTabEvent.defaultPrevented, 'SV list Tab did not remain in the editor');
        expect(!!svRoot.querySelector('[data-type="padding"]'), 'SV list Tab did not indent the source list item');

        await setMarkdown('- first\\n- source item');
        const sourceListTextStart = svRoot.querySelectorAll('[data-type="text"]')[1];
        const sourceListTextStartNode = textNode(sourceListTextStart);
        select(sourceListTextStartNode, 0, sourceListTextStartNode, 0);
        const sourceListTextStartTabEvent = new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        });
        svRoot.dispatchEvent(sourceListTextStartTabEvent);
        expect(sourceListTextStartTabEvent.defaultPrevented, 'SV list text-start Tab did not remain in the editor');
        expect(!!svRoot.querySelector('[data-type="padding"]'), 'SV list text-start Tab did not indent the source list item');

        const codeFence = String.fromCharCode(96).repeat(3);

        // Split View's renderer drops the indentation of a code block's first body
        // line, and Split View reads its value straight back out of that DOM, so
        // the loss becomes the document on the next keystroke. Indentation has to
        // survive the switch itself, the value, and a real edit elsewhere.
        const indentedBlock = lines(
          'Intro paragraph',
          '',
          codeFence + 'js',
          '    first();',
          '    second();',
          codeFence,
          ''
        );
        await switchMode('wysiwyg');
        await setMarkdown(indentedBlock);
        await pause(80);
        expect(
          window.vditor.getValue().indexOf('    first();') >= 0,
          'the fixture lost its code indentation before Split View was involved'
        );
        await switchMode('sv');
        await pause(120);
        expect(
          window.vditor.getValue().indexOf('    first();') >= 0,
          'switching to Split View flattened the first line of the code block: ' +
            JSON.stringify(window.vditor.getValue())
        );
        expect(
          document.querySelector('.vditor-sv').textContent.indexOf('    first();') >= 0,
          'the Split View pane shows the first code line without its indentation'
        );
        // An edit outside the block must not carry the flattening into the host.
        const svIndentRoot = document.querySelector('.vditor-sv');
        const svIntroText = textNode(svIndentRoot);
        select(svIntroText, svIntroText.textContent.length, svIntroText, svIntroText.textContent.length);
        svIntroText.textContent = svIntroText.textContent + '!';
        svIndentRoot.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '!' }));
        await pause(200);
        const indentEdits = window.__vmdMessages.filter((message) => message.command === 'edit');
        const lastIndentEdit = indentEdits[indentEdits.length - 1];
        expect(lastIndentEdit, 'editing in Split View posted no document update');
        expect(
          lastIndentEdit.content.indexOf('    first();') >= 0,
          'a Split View edit posted the code block with its first line flattened: ' +
            JSON.stringify(lastIndentEdit.content)
        );
        expect(
          lastIndentEdit.content.indexOf('    second();') >= 0,
          'a Split View edit flattened a later code line'
        );
        // Switching back must not hand the visual editor flattened text either.
        await switchMode('wysiwyg');
        await pause(120);
        expect(
          window.vditor.getValue().indexOf('    first();') >= 0,
          'returning from Split View left the code block flattened: ' +
            JSON.stringify(window.vditor.getValue())
        );

        // The repair is derived from the text handed to the renderer, never from an
        // earlier copy, so a deliberate dedent in Split View has to stick.
        await switchMode('sv');
        await pause(120);
        const dedentRoot = document.querySelector('.vditor-sv');
        const dedentTarget = Array.from(dedentRoot.querySelectorAll('[data-type="text"]'))
          .find((element) => element.textContent.indexOf('    first();') >= 0);
        expect(dedentTarget, 'could not find the code body in the Split View DOM');
        const dedentNode = Array.from(dedentTarget.childNodes)
          .find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.indexOf('    first();') >= 0);
        expect(dedentNode, 'the code body first line is not a single text node');
        dedentNode.textContent = dedentNode.textContent.replace('    first();', 'first();');
        select(dedentNode, 0, dedentNode, 0);
        dedentRoot.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        await pause(200);
        expect(
          window.vditor.getValue().indexOf('\\nfirst();') >= 0,
          'a deliberate dedent in Split View was reverted: ' +
            JSON.stringify(window.vditor.getValue())
        );
        expect(
          window.vditor.getValue().indexOf('    second();') >= 0,
          'dedenting one line also dropped the indent of the next'
        );

        // Each configured Front Matter mode must also apply when a document
        // opens directly into Split View, before the editor is revealed.
        const initializeSplitFrontMatterMode = async (display) => {
          const source = lines(
            '---',
            'title: ' + display + ' Split View',
            '---',
            '',
            '# ' + display + ' body',
            ''
          );
          hostGeneration += 1;
          window.dispatchEvent(new MessageEvent('message', {
            data: {
              command: 'update',
              type: 'init',
              content: source,
              documentVersion: hostGeneration,
              editorGeneration: hostGeneration,
              theme: 'light',
              options: {
                mode: 'sv',
                frontMatterDisplay: display,
                undoDelay: 0,
                preview: { delay: 0 },
                lang: 'en_US',
                cdn: location.origin,
              },
            },
          }));
          await wait(() =>
            window.vditor?.vditor?.currentMode === 'sv' &&
            window.vditor.vditor.preview?.previewElement?.textContent.includes(
              display + ' body'
            )
          );
          await pause(80);
          return {
            source,
            preview: window.vditor.vditor.preview.previewElement,
          };
        };

        testCheckpoint = 'Split View Front Matter code-block mode';
        const splitCodeFrontMatter = await initializeSplitFrontMatterMode('codeBlock');
        expect(
          splitCodeFrontMatter.preview.querySelector(
            ':scope > .vmd-split-front-matter[data-vmd-mode="codeBlock"] > .vmd-front-matter__code'
          )?.textContent === 'title: codeBlock Split View' &&
            !splitCodeFrontMatter.preview.querySelector('.vmd-front-matter') &&
            window.vditor.getValue().replace(/\\n+$/, '') ===
              splitCodeFrontMatter.source.replace(/\\n+$/, ''),
          'Split View did not render Front Matter as configured read-only YAML code'
        );

        testCheckpoint = 'Split View Front Matter hidden mode';
        const hiddenSplitFrontMatter = await initializeSplitFrontMatterMode('hide');
        expect(
          !hiddenSplitFrontMatter.preview.querySelector(
            ':scope > :is(.vmd-split-front-matter, .vditor-yml-front-matter)'
          ) &&
            hiddenSplitFrontMatter.preview.querySelector('h1')?.textContent === 'hide body' &&
            window.vditor.getValue().replace(/\\n+$/, '') ===
              hiddenSplitFrontMatter.source.replace(/\\n+$/, ''),
          'Split View hidden Front Matter leaked into the preview or changed source'
        );

        // Reinitialize once more with ordinary Markdown to cover stale host
        // generations after the two Split View startup projections.
        await switchMode('wysiwyg');
        const reopenedSource = lines(
          '# Reinitialized body',
          '',
          'Plain content.',
          ''
        );
        hostGeneration += 1;
        window.dispatchEvent(new MessageEvent('message', {
          data: {
            command: 'update',
            type: 'init',
            content: reopenedSource,
            documentVersion: hostGeneration,
            editorGeneration: hostGeneration,
            theme: 'light',
            options: {
              mode: 'wysiwyg',
              undoDelay: 0,
              preview: { delay: 0 },
              lang: 'en_US',
              cdn: location.origin,
            },
          },
        }));
        testCheckpoint = 'waiting for reinitialized document body';
        await wait(() => root() && root().textContent.indexOf('Reinitialized body') >= 0);
        testCheckpoint = 'startup';
        await pause(200);
        expect(
          window.vditor.getValue() === reopenedSource,
          'reinitializing with ordinary Markdown changed the document: ' +
            JSON.stringify(window.vditor.getValue())
        );
        const reopenedBaselines = window.__vmdMessages.filter(
          (message) => message.command === 'editor-baseline' && message.generation === hostGeneration
        );
        expect(
          reopenedBaselines.length === 1 && reopenedBaselines[0].documentVersion === hostGeneration,
          'reinitialized Vditor did not emit exactly one new-generation baseline'
        );
        window.dispatchEvent(new MessageEvent('message', {
          data: {
            command: 'update',
            type: 'update',
            content: 'stale generation content',
            documentVersion: 3,
            editorGeneration: 1,
          },
        }));
        await pause(80);
        expect(
          window.vditor.getValue() === reopenedSource,
          'a stale-generation host update replaced the reinitialized editor'
        );

        // Code source and language are edited only through the shared popover.
        testCheckpoint = 'ordinary code popover editing';
        await setMarkdown(
          'Before code\\n\\n' + markerFence +
            'js\\nconst a = 1;\\nconst b = 2;\\n' + markerFence +
            '\\n\\nAfter code'
        );
        await pause(120);
        codeBlock = root().querySelector(
          '.vditor-wysiwyg__block[data-type="code-block"]'
        );
        codeSource = codeBlock.querySelector(':scope > pre:not(.vditor-wysiwyg__preview)');
        codePreview = codeBlock.querySelector(':scope > .vditor-wysiwyg__preview');
        codePreviewCode = codePreview.querySelector(':scope > code');
        const codeRectBeforeEdit = codeBlock.getBoundingClientRect();
        codePreviewCode.click();
        codeBlock.querySelector('.vmd-code-language').click();
        await pause();
        sourcePopover = document.querySelector('.vditor-wysiwyg > .vmd-source-popover');
        expect(
          getComputedStyle(codeSource).display === 'none' &&
            sourcePopover?.style.display !== 'block' &&
            Math.abs(codeBlock.getBoundingClientRect().height - codeRectBeforeEdit.height) < 2,
          'clicking highlighted code or its language opened an editor or exposed source'
        );

        // Delete and printable input at a rendered-code selection enter the
        // exact in-place editor and apply the triggering key. They must not use
        // the atomic block's former select-first deletion path.
        selectTextOccurrence(codePreviewCode, 'a');
        const deleteTargetRect = codeBlock.getBoundingClientRect();
        codePreviewCode.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Delete',
          bubbles: true,
          cancelable: true,
        }));
        await pause();
        sourcePopover = document.querySelector('.vditor-wysiwyg > .vmd-source-popover');
        let keyboardContent = sourcePopover.querySelector('[name="content"]');
        let keyboardPopoverRect = sourcePopover.getBoundingClientRect();
        expect(
          sourcePopover.dataset.vmdPosition === 'code-overlay' &&
            keyboardContent.value.includes('const  = 1;') &&
            !codeBlock.classList.contains('vmd-code-block--selected') &&
            Math.abs(keyboardPopoverRect.left - deleteTargetRect.left) <= 2 &&
            Math.abs(keyboardPopoverRect.top - deleteTargetRect.top) <= 2 &&
            Math.abs(keyboardPopoverRect.width - deleteTargetRect.width) <= 2 &&
            Math.abs(keyboardPopoverRect.height - deleteTargetRect.height) <= 2,
          'Delete inside ordinary code selected the whole block or failed to open an exact editor: ' +
            JSON.stringify({
              content: keyboardContent?.value,
              selected: codeBlock.className,
              blockBefore: deleteTargetRect,
              blockCurrent: codeBlock.getBoundingClientRect(),
              popover: keyboardPopoverRect,
              popoverStyle: {
                width: sourcePopover.style.width,
                computedWidth: getComputedStyle(sourcePopover).width,
                maxWidth: getComputedStyle(sourcePopover).maxWidth,
              },
            })
        );
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await pause(100);
        window.vditor.vditor.undo.undo(window.vditor.vditor);
        await pause(100);

        codeBlock = root().querySelector(
          '.vditor-wysiwyg__block[data-type="code-block"]'
        );
        codeSource = codeBlock.querySelector(':scope > pre:not(.vditor-wysiwyg__preview)');
        codePreview = codeBlock.querySelector(':scope > .vditor-wysiwyg__preview');
        codePreviewCode = codePreview.querySelector(':scope > code');
        selectTextOccurrence(codePreviewCode, 'const a', true);
        codePreviewCode.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'X',
          bubbles: true,
          cancelable: true,
        }));
        await pause();
        sourcePopover = document.querySelector('.vditor-wysiwyg > .vmd-source-popover');
        keyboardContent = sourcePopover.querySelector('[name="content"]');
        expect(
          sourcePopover.dataset.vmdPosition === 'code-overlay' &&
            keyboardContent.value.includes('const aX = 1;') &&
            document.activeElement === keyboardContent,
          'printable input inside ordinary code did not enter editing at the rendered caret'
        );
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await pause(100);
        window.vditor.vditor.undo.undo(window.vditor.vditor);
        await pause(100);

        codeBlock = root().querySelector(
          '.vditor-wysiwyg__block[data-type="code-block"]'
        );
        codeSource = codeBlock.querySelector(':scope > pre:not(.vditor-wysiwyg__preview)');
        codePreview = codeBlock.querySelector(':scope > .vditor-wysiwyg__preview');
        codePreviewCode = codePreview.querySelector(':scope > code');
        codeBlock.querySelector('.vmd-source-edit-button').click();
        await pause();
        sourcePopover = document.querySelector('.vditor-wysiwyg > .vmd-source-popover');
        const codeRectAfterEdit = codeBlock.getBoundingClientRect();
        let sourceLanguage = sourcePopover.querySelector('[name="language"]');
        let sourceContent = sourcePopover.querySelector('[name="content"]');
        expect(
          sourcePopover.style.display === 'block' &&
            document.activeElement === sourceContent &&
            Math.abs(codeRectAfterEdit.height - codeRectBeforeEdit.height) < 2,
          'the code edit button did not open the popover without changing layout'
        );

        sourceContent.value = 'const edited = 2;';
        sourceContent.dispatchEvent(new InputEvent('input', { bubbles: true, data: '2' }));
        sourceLanguage.value = 'objective-c';
        sourceLanguage.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'objective-c' }));
        await pause(100);
        expect(
          getComputedStyle(codeSource).display === 'none' &&
            codeSource.textContent.includes('const edited = 2;') &&
            !codePreview.textContent.includes('const edited = 2;') &&
            Math.abs(codeBlock.getBoundingClientRect().height - codeRectBeforeEdit.height) < 2,
          'the in-place code input did not retain its draft without moving the rendered block'
        );
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }));
        await pause(100);
        codeBlock = root().querySelector(
          '.vditor-wysiwyg__block[data-type="code-block"]'
        );
        codeSource = codeBlock.querySelector(':scope > pre:not(.vditor-wysiwyg__preview)');
        codePreview = codeBlock.querySelector(':scope > .vditor-wysiwyg__preview');
        expect(
          window.vditor.getValue().includes(markerFence + 'objective-c\\nconst edited = 2;') &&
            getComputedStyle(codeSource).display === 'none' &&
            codePreview.textContent.includes('const edited = 2;') &&
            sourcePopover.style.display === 'none',
          'Escape did not commit and render the current legal in-place code draft'
        );

        const directCopyButton = codeBlock.querySelector(
          '.vmd-code-toolbar .vditor-copy .vditor-tooltipped'
        );
        directCopyButton.click();
        await pause();
        expect(
          window.__vmdClipboardText === 'const edited = 2;',
          'the code copy action did not use the latest popover content'
        );

        codeBlock.querySelector('.vmd-code-language').click();
        await pause();
        expect(
          sourcePopover.style.display !== 'block',
          'the static code language label reopened the source editor'
        );
        codeBlock.querySelector('.vmd-source-edit-button').click();
        await pause();
        sourceLanguage = sourcePopover.querySelector('[name="language"]');
        sourceLanguage.value = 'bad language';
        sourceLanguage.dispatchEvent(new InputEvent('input', { bubbles: true, data: ' ' }));
        expect(
          !sourcePopover.querySelector('.vmd-source-popover__error').hidden,
          'an invalid code language did not expose an accessible validation error'
        );
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await pause();
        expect(
          window.vditor.getValue().includes(markerFence + 'objective-c\\nconst edited = 2;') &&
            !window.vditor.getValue().includes('bad language'),
          'closing an invalid language draft corrupted the fenced Markdown'
        );
        expect(
          !window.vditor.getValue().includes('vmd-code-'),
          'the code editing controls leaked into Markdown'
        );
        window.vditor.vditor.undo.undo(window.vditor.vditor);
        await pause(100);
        expect(
          window.vditor.getValue().includes(markerFence + 'js\\nconst a = 1;\\nconst b = 2;') &&
            getComputedStyle(
              root().querySelector('[data-type="code-block"] > pre:not(.vditor-wysiwyg__preview)')
            ).display === 'none',
          'one undo did not restore the complete pre-popover code session'
        );

        // An editor taller than the viewport remains exactly as tall as its
        // rendered block and follows that block when the document scrolls.
        testCheckpoint = 'oversized in-place code editor';
        const tallCodeLines = Array.from(
          { length: 80 },
          (_, index) => 'const tallLine' + index + ' = ' + index + ';'
        );
        await setMarkdown(
          'Before tall code\\n\\n' + markerFence + 'js\\n' +
            tallCodeLines.join('\\n') + '\\n' + markerFence +
            '\\n\\nAfter tall code'
        );
        await pause(140);
        const tallEditorRoot = root();
        const tallCodeBlock = tallEditorRoot.querySelector(
          '.vditor-wysiwyg__block[data-type="code-block"]'
        );
        const tallBlockRectBefore = tallCodeBlock.getBoundingClientRect();
        tallCodeBlock.querySelector('.vmd-source-edit-button').click();
        await pause();
        sourcePopover = document.querySelector('.vditor-wysiwyg > .vmd-source-popover');
        const tallPopoverRectBefore = sourcePopover.getBoundingClientRect();
        expect(
          tallBlockRectBefore.height > tallEditorRoot.clientHeight &&
            Math.abs(tallPopoverRectBefore.left - tallBlockRectBefore.left) <= 2 &&
            Math.abs(tallPopoverRectBefore.top - tallBlockRectBefore.top) <= 2 &&
            Math.abs(tallPopoverRectBefore.width - tallBlockRectBefore.width) <= 2 &&
            Math.abs(tallPopoverRectBefore.height - tallBlockRectBefore.height) <= 2,
          'an oversized ordinary code editor was capped or displaced: ' +
            JSON.stringify({
              rootHeight: tallEditorRoot.clientHeight,
              rootScrollTop: tallEditorRoot.scrollTop,
              blockBefore: tallBlockRectBefore,
              blockCurrent: tallCodeBlock.getBoundingClientRect(),
              popover: tallPopoverRectBefore,
              popoverStyle: {
                top: sourcePopover.style.top,
                left: sourcePopover.style.left,
              },
            })
        );
        const tallScrollTop = Math.min(
          180,
          tallEditorRoot.scrollHeight - tallEditorRoot.clientHeight
        );
        tallEditorRoot.scrollTop = tallScrollTop;
        tallEditorRoot.dispatchEvent(new Event('scroll'));
        await pause();
        const tallBlockRectAfter = tallCodeBlock.getBoundingClientRect();
        const tallPopoverRectAfter = sourcePopover.getBoundingClientRect();
        expect(
          tallScrollTop > 0 &&
            tallBlockRectAfter.top < tallBlockRectBefore.top &&
            Math.abs(tallPopoverRectAfter.left - tallBlockRectAfter.left) <= 2 &&
            Math.abs(tallPopoverRectAfter.top - tallBlockRectAfter.top) <= 2 &&
            Math.abs(tallPopoverRectAfter.width - tallBlockRectAfter.width) <= 2 &&
            Math.abs(tallPopoverRectAfter.height - tallBlockRectAfter.height) <= 2,
          'the oversized in-place editor did not remain synchronized while scrolling: ' +
            JSON.stringify({
              scrollTop: tallEditorRoot.scrollTop,
              blockBefore: tallBlockRectBefore,
              blockAfter: tallBlockRectAfter,
              popoverBefore: tallPopoverRectBefore,
              popoverAfter: tallPopoverRectAfter,
            })
        );
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await pause();

        // This reproduces 00-docs/代码修复-20260813-031654.md: multiple ordinary
        // code blocks placed down the WYSIWYG document used to let Vditor's
        // off-screen copy textareas enlarge html/body and create a second,
        // document-external scrollbar.
        testCheckpoint = 'code copy outer scroll containment';
        const scrollContainmentMarkdown = [
          '# Code copy scroll containment',
          '',
          ...Array.from({ length: 8 }, (_, index) =>
            'Long paragraph ' + index + ' '.repeat(36)
          ),
          '',
          markerFence + 'html',
          '<details>',
          '<summary>Title</summary>',
          '',
          'Hidden body',
          '',
          '</details>',
          markerFence,
          '',
          ...Array.from({ length: 8 }, (_, index) =>
            'Middle paragraph ' + index + ' '.repeat(36)
          ),
          '',
          markerFence + 'text',
          'closed details did not render as a title-free thin horizontal bar',
          markerFence,
          '',
          'Last paragraph',
        ].join('\\n\\n');
        await setMarkdown(scrollContainmentMarkdown);
        await pause(160);
        const containedEditorRoot = root();
        const containmentCopyButtons = Array.from(
          containedEditorRoot.querySelectorAll(
            '.vditor-copy .vditor-tooltipped'
          )
        );
        const containmentTextareas = Array.from(
          containedEditorRoot.querySelectorAll('.vditor-copy > textarea')
        );
        const outerScrollRange = (element) =>
          Math.max(0, element.scrollHeight - element.clientHeight);
        expect(
          containmentCopyButtons.length === 2 &&
            containmentTextareas.length === 2 &&
            containmentTextareas.every((textarea) => {
              const style = getComputedStyle(textarea);
              return style.position === 'fixed' &&
                textarea.getBoundingClientRect().right < 0;
            }),
          'ordinary code copy textareas were not safely contained off-screen'
        );
        expect(
          outerScrollRange(containedEditorRoot) > 0 &&
            outerScrollRange(document.documentElement) === 0 &&
            outerScrollRange(document.body) === 0 &&
            outerScrollRange(document.getElementById('app')) === 0 &&
            outerScrollRange(document.querySelector('.vditor-content')) === 0 &&
            outerScrollRange(document.querySelector('.vditor-wysiwyg')) === 0,
          'code copy controls created a document-external scroll range: ' +
            JSON.stringify({
              html: outerScrollRange(document.documentElement),
              body: outerScrollRange(document.body),
              app: outerScrollRange(document.getElementById('app')),
              content: outerScrollRange(document.querySelector('.vditor-content')),
              wysiwyg: outerScrollRange(document.querySelector('.vditor-wysiwyg')),
              editor: outerScrollRange(containedEditorRoot),
            })
        );
        const containmentCopyAttempts = window.__vmdCodeCopyAttempts;
        containmentCopyButtons[1].click();
        await pause();
        expect(
          window.__vmdCodeCopyAttempts === containmentCopyAttempts + 1 &&
            window.__vmdClipboardText.trim() ===
              'closed details did not render as a title-free thin horizontal bar' &&
            containmentCopyButtons[1].classList.contains(
              'vmd-code-copy--success'
            ) &&
            containmentCopyButtons[1].querySelector(
              '.vmd-code-copy-feedback'
            )?.textContent === '✓ ' + (window.VditorI18n.copied || 'Copied'),
          'containing the code copy textarea broke copying or success feedback: ' +
            JSON.stringify({
              attemptsBefore: containmentCopyAttempts,
              attemptsAfter: window.__vmdCodeCopyAttempts,
              clipboard: window.__vmdClipboardText,
              label: containmentCopyButtons[1].getAttribute('aria-label'),
              feedback: containmentCopyButtons[1].querySelector(
                '.vmd-code-copy-feedback'
              )?.textContent,
              textarea: containmentTextareas[1].value,
            })
        );

        testCheckpoint = 'mode switch after ordinary code editing';
        await switchMode('sv');
        testCheckpoint = 'split scroll fixture after ordinary code editing';
        const splitMarkdown = Array.from({ length: 72 }, (_, index) =>
          '## Section ' + index + '\\n\\n' +
          'Long split-view paragraph ' + index + ' '.repeat(18) + '\\n\\n' +
          (index % 6 === 0 ? codeFence + 'ts\\nconst value = ' + index + '\\n' + codeFence : '')
        ).join('\\n\\n');
        await setMarkdown(splitMarkdown);
        await pause(100);
        const sourcePane = window.vditor.vditor.sv.element;
        const previewPane = window.vditor.vditor.preview.element;
        const maxScroll = (element) => Math.max(0, element.scrollHeight - element.clientHeight);
        const scrollProgress = (element) => {
          const maximum = maxScroll(element);
          return maximum === 0 ? 0 : element.scrollTop / maximum;
        };
        const setPaneProgress = async (element, progress) => {
          element.scrollTop = maxScroll(element) * progress;
          element.dispatchEvent(new Event('scroll'));
          await pause(40);
        };
        expect(maxScroll(sourcePane) > 0 && maxScroll(previewPane) > 0, 'split-view fixture did not create two scrollable panes');
        for (const progress of [0.25, 0.62, 1]) {
          await setPaneProgress(sourcePane, progress);
          expect(
            Math.abs(scrollProgress(previewPane) - progress) < 0.025,
            'source-to-preview split scroll drifted at ' + progress + ': source=' + scrollProgress(sourcePane) + ', preview=' + scrollProgress(previewPane)
          );
        }
        for (const progress of [0.2, 0.74, 1]) {
          await setPaneProgress(previewPane, progress);
          expect(
            Math.abs(scrollProgress(sourcePane) - progress) < 0.025,
            'preview-to-source split scroll did not synchronize at ' + progress + ': source=' + scrollProgress(sourcePane) + ', preview=' + scrollProgress(previewPane)
          );
        }

        document.body.dataset.vmdTest = 'passed';
        result.textContent = 'passed';
      } catch (error) {
        document.body.dataset.vmdTest = 'failed';
        const message = error?.stack || (error?.message ? error.message : String(error));
        result.textContent = 'failed [' + testCheckpoint + ']: ' + message +
          (window.__vmdRuntimeError ? ' | runtime: ' + window.__vmdRuntimeError : '');
      }
    })();
  </script>
</body>
</html>`
}

function startServer(resources) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const resource = resources[request.url || '/']
      if (!resource) {
        response.writeHead(404)
        response.end()
        return
      }
      response.writeHead(200, { 'Content-Type': resource.type })
      response.end(resource.content)
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

async function main() {
  const chrome = findChrome()
  if (!chrome) {
    const message = 'webview interaction tests require Chrome, Chromium, or Edge'
    if (process.env.CI) throw new Error(message)
    console.log(`${message}; skipped outside CI`)
    return
  }

  const [mainJs, mainCss, lute, i18n, highlightJs, highlightTheme] = await Promise.all([
    readFile(path.join(root, 'media/dist/main.js')),
    readFile(path.join(root, 'media/dist/main.css')),
    readFile(path.join(root, 'media-src/node_modules/vditor/dist/js/lute/lute.min.js')),
    readFile(path.join(root, 'media-src/node_modules/vditor/dist/js/i18n/en_US.js')),
    readFile(path.join(root, 'media-src/node_modules/vditor/dist/js/highlight.js/highlight.min.js')),
    readFile(path.join(root, 'media-src/node_modules/vditor/dist/js/highlight.js/styles/github.min.css')),
  ])
  const server = await startServer({
    '/': { type: 'text/html; charset=utf-8', content: testPage() },
    '/main.js': { type: 'text/javascript; charset=utf-8', content: mainJs },
    '/main.css': { type: 'text/css; charset=utf-8', content: mainCss },
    '/lute.min.js': { type: 'text/javascript; charset=utf-8', content: lute },
    '/dist/js/i18n/en_US.js': {
      type: 'text/javascript; charset=utf-8',
      content: i18n,
    },
    '/dist/js/highlight.js/highlight.min.js?v=11.7.0': {
      type: 'text/javascript; charset=utf-8',
      content: highlightJs,
    },
    '/dist/js/highlight.js/styles/github.min.css': {
      type: 'text/css; charset=utf-8',
      content: highlightTheme,
    },
  })
  const port = server.address().port
  const profile = await mkdtemp(path.join(tmpdir(), 'vmd-chrome-'))

  try {
    const { stdout } = await execFileAsync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profile}`,
        '--virtual-time-budget=24000',
        '--dump-dom',
        `http://127.0.0.1:${port}/`,
      ],
      { timeout: 60000, maxBuffer: 2 * 1024 * 1024 }
    )
    assert.match(
      stdout,
      /data-vmd-test="passed"/,
      (stdout.match(/<div id="vmd-test-result">[^<]*/) || [stdout])[0]
    )
    console.log('webview interaction tests passed')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(profile, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
