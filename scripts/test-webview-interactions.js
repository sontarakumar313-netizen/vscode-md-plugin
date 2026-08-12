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
    const nativeExecCommand = document.execCommand.bind(document);
    document.execCommand = (command, ...args) => {
      if (command === 'copy') {
        window.__vmdCodeCopyAttempts += 1;
        return true;
      }
      return nativeExecCommand(command, ...args);
    };
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
        if (Date.now() >= deadline) return reject(new Error('Timed out waiting for editor state'));
        setTimeout(check, 10);
      };
      check();
    });
    const pause = (milliseconds = 20) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const root = () => document.querySelector('.vditor-wysiwyg .vditor-reset');
    const textNode = (element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
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
    const listButton = () => document.querySelector('.vditor-toolbar [data-type="list"]');
    const orderedListButton = () => document.querySelector('.vditor-toolbar [data-type="ordered-list"]');
    const selectedTableCell = () => {
      const range = window.getSelection().getRangeAt(0);
      const element = range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement;
      return element.closest('td, th');
    };
    const switchMode = async (mode) => {
      if (window.vditor.vditor.currentMode === mode) return;
      document.querySelector('.vditor-toolbar [data-type="vmd-edit-mode"]').click();
      await pause();
      document.querySelector('.vditor-toolbar [data-type="vmd-mode-' + mode + '"]').click();
      await wait(() => window.vditor.vditor.currentMode === mode);
      await pause();
    };
    const setMarkdown = async (markdown) => {
      window.vditor.setValue(markdown);
      await pause();
    };
    const expect = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const lines = (...values) => values.join(String.fromCharCode(10));
    const removedModeName = ['i', 'r'].join('');

    (async () => {
      try {
        await wait(() => window.__vmdMessages.some((message) => message.command === 'ready'));
        let hostGeneration = 1;
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
              undoDelay: 0,
              preview: { delay: 0 },
              lang: 'en_US',
              // cdn only covers renderers Vditor loads on demand, and is pinned
              // at the local origin so a test can never reach the network. The
              // parser path and the locale bundle are deliberately NOT set here:
              // the whole suite boots on the production defaults from main.ts.
              cdn: location.origin,
            },
          },
        }));
        await wait(() => root());
        await wait(() => window.__vmdMessages.some((message) => message.command === 'editor-baseline'));
        expect(
          window.vditor.vditor.currentMode === 'wysiwyg',
          'an unsupported initialization mode did not fall back to visual editing'
        );
        expect(
          !Object.prototype.hasOwnProperty.call(window.vditor.vditor, removedModeName),
          'the removed editor object was still constructed'
        );
        expect(
          !document.querySelector('.vditor-' + removedModeName),
          'the removed editor DOM was still mounted'
        );
        expect(
          !Object.prototype.hasOwnProperty.call(window.VditorI18n, 'instant' + 'Rendering'),
          'the removed editor label was still bundled'
        );
        const modeControl = document.querySelector('.vditor-toolbar [data-type="vmd-edit-mode"]');
        expect(modeControl, 'the two-mode editor control was not rendered');
        modeControl.click();
        await pause();
        const modeButtons = Array.from(
          document.querySelectorAll('.vditor-toolbar [data-type^="vmd-mode-"]')
        ).map((button) => button.getAttribute('data-type'));
        expect(
          modeButtons.join(',') === 'vmd-mode-wysiwyg,vmd-mode-sv',
          'the editor exposed a mode outside the supported pair: ' + modeButtons.join(',')
        );
        const initialBaselines = window.__vmdMessages.filter((message) => message.command === 'editor-baseline');
        expect(initialBaselines.length === 1, 'initial Vditor projection did not emit exactly one baseline');
        expect(
          initialBaselines[0].documentVersion === 1 &&
          initialBaselines[0].generation === hostGeneration &&
          initialBaselines[0].projectionSerial === 1 &&
          initialBaselines[0].content.replace(/\\n+$/, '') === 'initial',
          'initial editor baseline was not paired with the init snapshot'
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
        const codeBlock = root().querySelector(
          '.vditor-wysiwyg__block[data-type="code-block"]'
        );
        const codeSource = codeBlock.querySelector(':scope > pre:first-child');
        const codePreview = codeBlock.querySelector(
          ':scope > .vditor-wysiwyg__preview'
        );
        expect(
          getComputedStyle(codeSource).display === 'none',
          'the code source was visible before entering the code block'
        );
        expect(
          parseFloat(getComputedStyle(codePreview).borderTopWidth) === 0,
          'the code divider was visible before entering the code block'
        );
        codePreview.click();
        await pause();
        const sourceStyle = getComputedStyle(codeSource);
        const previewStyle = getComputedStyle(codePreview);
        expect(sourceStyle.display !== 'none', 'clicking the code preview did not reveal its source');
        expect(parseFloat(sourceStyle.marginBottom) === 0, "the expanded code source kept Vditor's negative bottom margin");
        expect(
          parseFloat(previewStyle.borderTopWidth) === 1 &&
            previewStyle.borderTopStyle === 'solid' &&
            parseFloat(previewStyle.paddingTop) > 0 &&
            parseFloat(previewStyle.paddingTop) <= 8 &&
            parseFloat(previewStyle.marginTop) > 0 &&
            parseFloat(previewStyle.marginTop) <= 8,
          'the expanded code source and preview divider is not compact and one pixel wide'
        );
        // Guard against over-hiding: heading labels are a different rule and stay.
        const heading = root().querySelector('h1');
        expect(heading, 'the heading fixture did not render');
        expect(
          window.getComputedStyle(heading, '::before').display !== 'none',
          'hiding the block markers also removed the heading level label'
        );

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
        await wait(() => document.querySelector('.jconfirm .jconfirm-buttons'));
        const confirmationButton = (label) => Array.from(
          document.querySelectorAll('.jconfirm .jconfirm-buttons button')
        ).filter((button) => button.textContent.trim() === label).pop();
        const cancelNormalize = confirmationButton('Cancel');
        expect(cancelNormalize, 'normalize confirmation has no Cancel button');
        cancelNormalize.click();
        await pause(80);
        expect(
          normalizeMessageCount() === normalizeBeforeConfirmation,
          'canceling normalization posted a destructive command'
        );

        normalizeToolbarItem.click();
        await wait(() => confirmationButton('Confirm'));
        const confirmNormalize = confirmationButton('Confirm');
        expect(confirmNormalize, 'normalize confirmation has no Confirm button');
        confirmNormalize.click();
        await wait(() => normalizeMessageCount() === normalizeBeforeConfirmation + 1);
        expect(
          normalizeMessageCount() === normalizeBeforeConfirmation + 1,
          'confirming normalization did not post exactly one command'
        );
        const toolbarIconSizes = Array.from(
          document.querySelectorAll('.vditor-toolbar .vditor-tooltipped > svg')
        ).map((icon) => [getComputedStyle(icon).width, getComputedStyle(icon).height]);
        expect(
          toolbarIconSizes.length > 0 && toolbarIconSizes.every(([width, height]) => width === '15px' && height === '15px'),
          'toolbar icons do not share the standard 15px size'
        );
        const customIcon = (type) => document.querySelector('.vditor-toolbar [data-type="' + type + '"] > svg');
        const customIconTypes = ['outline', 'line-numbers', 'save', 'math-block', 'math-inline', 'details', 'alerts', 'vmd-edit-mode'];
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
        expect(window.__vmdStructuredTabPolicy.tabMovesFocus(), 'Ctrl+M did not enable Tab-moves-focus');
        expect(!tabAfterToggle().defaultPrevented, 'Tab stayed trapped after Ctrl+M released it');
        focusToggle({ ctrlKey: true });
        expect(!window.__vmdStructuredTabPolicy.tabMovesFocus(), 'Ctrl+M did not toggle Tab-moves-focus back off');
        expect(tabAfterToggle().defaultPrevented, 'structural Tab handling did not resume after toggling back');
        // Escape must stay with Vditor: it owns hint dismissal and the esc option.
        const shiftM = focusToggle({ ctrlKey: true, shiftKey: true });
        expect(!shiftM.defaultPrevented, 'Ctrl+Shift+M was swallowed by the focus-mode toggle');
        expect(!window.__vmdStructuredTabPolicy.tabMovesFocus(), 'Ctrl+Shift+M changed the focus mode');

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
        expect(detailsSummary.contentEditable === 'true', 'the rendered details title is not directly editable');
        detailsSummary.click();
        await pause();
        expect(getComputedStyle(detailsSource).display === 'none', 'clicking the details title revealed raw HTML source');
        expect(detailsBody.classList.contains('vmd-details-content--hidden'), 'clicking editable title unexpectedly toggled the details body');
        const detailsTitleText = textNode(detailsSummary);
        detailsTitleText.data = 'Renamed';
        select(detailsTitleText, detailsTitleText.data.length, detailsTitleText, detailsTitleText.data.length);
        detailsSummary.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: 'Renamed',
        }));
        detailsTitleText.appendData(' title');
        select(detailsTitleText, detailsTitleText.data.length, detailsTitleText, detailsTitleText.data.length);
        detailsSummary.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: ' title',
        }));
        await pause(380);
        const committedSummary = detailsOpener.querySelector('summary');
        const committedSelection = window.getSelection();
        expect(
          window.vditor.getValue().includes('<summary>Renamed title</summary>'),
          'editing the rendered details title did not update its hidden HTML source'
        );
        expect(
          committedSummary.contains(committedSelection.anchorNode) && committedSelection.isCollapsed,
          'the details title lost its caret after the debounced commit'
        );
        let detailsUndoReachedRoot = false;
        const onDetailsUndo = () => { detailsUndoReachedRoot = true; };
        root().addEventListener('keydown', onDetailsUndo);
        committedSummary.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'z',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }));
        root().removeEventListener('keydown', onDetailsUndo);
        expect(!detailsUndoReachedRoot, 'Ctrl+Z escaped the editable details title');
        expect(
          !window.vditor.getValue().includes('vmd-details-toggle'),
          'the details editing control leaked into Markdown'
        );
        committedSummary.querySelector('.vmd-details-toggle').click();
        await pause();
        expect(!detailsBody.classList.contains('vmd-details-content--hidden'), 'details content does not open from its summary');
        expect(!/<details\\s+[^>]*\\bopen/.test(window.vditor.getValue()), 'opening details changed the Markdown source');

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

        const alertTypes = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'];
        const alertMarkdown = alertTypes.map((type) => '> [!' + type + ']\\n> ' + type.toLowerCase() + ' body').join('\\n\\n');
        await setMarkdown(alertMarkdown);
        await pause(80);
        const renderedAlerts = Array.from(root().querySelectorAll(':scope > blockquote.vmd-alert'));
        expect(renderedAlerts.length === alertTypes.length, 'not all five GitHub Alert types rendered');
        for (const [index, alert] of renderedAlerts.entries()) {
          expect(alert.dataset.vmdAlert === alertTypes[index], 'GitHub Alert type was decorated incorrectly');
          expect(alert.querySelector('.vmd-alert-title')?.textContent === alertTypes[index], 'GitHub Alert title is missing');
          expect(getComputedStyle(alert.querySelector('.vmd-alert-marker')).display === 'none', 'GitHub Alert source marker is visible');
        }
        const serializedAlerts = window.vditor.getValue();
        expect(
          alertTypes.every((type) => serializedAlerts.includes('[!' + type + ']')) &&
            !serializedAlerts.includes('vmd-alert'),
          'GitHub Alert rendering changed or polluted the Markdown source'
        );

        await setMarkdown('selected alert body');
        const alertBodyText = textNode(root().querySelector(':scope > p'));
        select(alertBodyText, 0, alertBodyText, alertBodyText.textContent.length);
        document.querySelector('.vditor-toolbar [data-type="vmd-alert-warning"]').click();
        await pause(80);
        expect(
          window.vditor.getValue().includes('> [!WARNING]\\n> selected alert body') &&
            root().querySelector('blockquote.vmd-alert--warning'),
          'the GitHub Alert toolbar did not insert and render the selected Warning alert: ' +
            JSON.stringify(window.vditor.getValue())
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

        await setMarkdown('find target');
        const searchText = textNode(root().querySelector(':scope > p'));
        const start = searchText.textContent.indexOf('target');
        select(searchText, start, searchText, start + 'target'.length);
        root().dispatchEvent(new KeyboardEvent('keydown', {
          key: 'f',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }));
        await pause();
        expect(document.getElementById('vmd-search-bar').classList.contains('vmd-search-bar--open'), 'Ctrl+F did not open search');
        expect(document.getElementById('vmd-search-input').value === 'target', 'Ctrl+F did not prefill the selected text');
        const replaceToggle = document.getElementById('vmd-search-replace-toggle');
        replaceToggle.click();
        expect(replaceToggle.getAttribute('aria-expanded') === 'true', 'replace toggle did not expand');
        expect(!document.getElementById('vmd-search-replace-row').hidden, 'replace row did not open');

        await setMarkdown('cat Cat cat');
        const findInput = document.getElementById('vmd-search-input');
        const replaceInput = document.getElementById('vmd-search-replace-input');
        findInput.value = 'cat';
        findInput.dispatchEvent(new Event('input', { bubbles: true }));
        await pause();
        expect(document.getElementById('vmd-search-count').textContent === '1/3', 'WYSIWYG find did not highlight visible matches');
        expect(
          document.getElementById('vmd-search-replace').disabled && document.getElementById('vmd-search-replace-all').disabled,
          'WYSIWYG replacement was enabled without a source-offset mapping'
        );
        replaceInput.value = 'dog';
        const beforeWysiwygKeyboardReplace = window.vditor.getValue();
        replaceInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }));
        await pause();
        expect(window.vditor.getValue() === beforeWysiwygKeyboardReplace, 'WYSIWYG Enter replacement changed Markdown');
        replaceInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }));
        await pause();
        expect(window.vditor.getValue() === beforeWysiwygKeyboardReplace, 'WYSIWYG Ctrl+Enter replacement changed Markdown');

        await switchMode('sv');
        findInput.dispatchEvent(new Event('input', { bubbles: true }));
        await pause();
        expect(!document.getElementById('vmd-search-replace').disabled, 'Split View source replacement was not enabled');
        replaceInput.value = 'dog';
        const editCountBeforeReplace = window.__vmdMessages.filter((message) => message.command === 'edit').length;
        document.getElementById('vmd-search-replace').click();
        await pause(110);
        expect(window.vditor.getValue().trimEnd() === 'dog Cat cat', 'Replace did not update only the active source match');
        expect(
          window.__vmdMessages.filter((message) => message.command === 'edit').length === editCountBeforeReplace + 1,
          'Replace did not enter the normal document synchronization queue'
        );
        document.getElementById('vmd-search-replace-all').click();
        await pause(110);
        expect(window.vditor.getValue().trimEnd() === 'dog dog dog', 'Replace All did not replace every remaining source match');
        expect(document.getElementById('vmd-search-count').textContent === '0/0', 'replace count did not refresh after Replace All');

        await setMarkdown('**cat** cat');
        findInput.value = '**cat';
        findInput.dispatchEvent(new Event('input', { bubbles: true }));
        await pause();
        expect(
          document.getElementById('vmd-search-count').textContent === '1/1',
          'Split View find missed a source match split across marker spans'
        );
        expect(
          !document.getElementById('vmd-search-replace').disabled,
          'a match spanning marker spans did not enable replacement'
        );
        replaceInput.value = 'dog';
        document.getElementById('vmd-search-replace').click();
        await pause(110);
        expect(
          window.vditor.getValue().trimEnd() === 'dog** cat',
          'Replace rewrote the wrong source offsets for a match spanning marker spans'
        );

        await switchMode('wysiwyg');
        await setMarkdown('[label](hidden-target)');
        findInput.value = 'hidden-target';
        findInput.dispatchEvent(new Event('input', { bubbles: true }));
        await pause();
        expect(document.getElementById('vmd-search-count').textContent === '0/0', 'WYSIWYG find exposed a hidden Markdown-only match');
        expect(
          document.getElementById('vmd-search-replace').disabled && document.getElementById('vmd-search-replace-all').disabled,
          'replace actions remained enabled for an ambiguous Markdown-only match'
        );

        await setMarkdown('\\\\*literal &amp;');
        findInput.value = '*';
        findInput.dispatchEvent(new Event('input', { bubbles: true }));
        await pause();
        expect(
          document.getElementById('vmd-search-replace').disabled,
          'WYSIWYG replacement was enabled for an escaped Markdown character'
        );
        findInput.value = '&';
        findInput.dispatchEvent(new Event('input', { bubbles: true }));
        await pause();
        expect(
          document.getElementById('vmd-search-replace').disabled,
          'WYSIWYG replacement was enabled for an HTML entity'
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
        expect(codeCopyButton.getAttribute('aria-label') === (window.VditorI18n.copied || 'Copied'), 'code block copy did not report success');

        await setMarkdown('two-mode shortcut target');
        const shortcutText = textNode(root().querySelector(':scope > p'));
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
        expect(removedMiddleShortcut.defaultPrevented, 'the removed middle mode shortcut was not consumed');
        expect(window.vditor.vditor.currentMode === 'wysiwyg', 'the removed middle shortcut changed the editor mode');

        const savedModesBeforeShortcuts = window.__vmdMessages.filter(
          (message) => message.command === 'save-options'
        ).length;
        root().dispatchEvent(new KeyboardEvent('keydown', {
          key: '9',
          code: 'Digit9',
          ctrlKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true,
        }));
        await wait(() => window.vditor.vditor.currentMode === 'sv');
        await pause();
        expect(
          window.__vmdMessages.filter((message) => message.command === 'save-options').at(-1)?.options?.mode === 'sv',
          'the Split View shortcut did not persist the selected mode'
        );
        document.querySelector('.vditor-sv').dispatchEvent(new KeyboardEvent('keydown', {
          key: '7',
          code: 'Digit7',
          ctrlKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true,
        }));
        await wait(() => window.vditor.vditor.currentMode === 'wysiwyg');
        await pause();
        const savedModeMessages = window.__vmdMessages.filter(
          (message) => message.command === 'save-options'
        );
        expect(
          savedModeMessages.length === savedModesBeforeShortcuts + 2 &&
          savedModeMessages.at(-1)?.options?.mode === 'wysiwyg',
          'the visual editing shortcut did not persist the selected mode'
        );

        await switchMode('sv');
        const svRoot = document.querySelector('.vditor-sv');
        await setMarkdown('SV plain Tab target');
        const svPlainText = textNode(svRoot);
        select(svPlainText, 2, svPlainText, 2);
        const svPlainTabEvent = new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        });
        svRoot.dispatchEvent(svPlainTabEvent);
        expect(svPlainTabEvent.defaultPrevented, 'SV Tab outside a list was allowed to move focus');

        await setMarkdown('| first | second |\\n| --- | --- |\\n| one | two |');
        const svTableText = textNode(svRoot);
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

        // YAML front matter renders as a table in WYSIWYG mode, and the table must
        // never reach the Markdown. The document text is the contract here: the
        // generated DOM lives in a preview container the serializer skips.
        await switchMode('wysiwyg');
        const frontMatterSource = lines(
          '---',
          'title: Front Matter',
          'draft: false',
          'priority: 1',
          'tags:',
          '  - alpha',
          '  - beta',
          'author:',
          '  name: Wu',
          '  contact:',
          '    email: wu@example.com',
          '---',
          '',
          '# Body heading',
          '',
          'Body paragraph.',
          ''
        );
        await setMarkdown(frontMatterSource);
        await pause(160);
        const fmBlock = () => root().querySelector('.vditor-wysiwyg__block[data-type="yaml-front-matter"]');
        expect(fmBlock(), 'front matter did not render as a yaml-front-matter block');
        const fmTable = () => fmBlock().querySelector('table.vmd-front-matter');
        expect(fmTable(), 'front matter did not render as a table');
        expect(
          fmBlock().querySelector('.vditor-wysiwyg__preview').contains(fmTable()),
          'the table was not placed inside a preview container, so it can leak into Markdown'
        );
        expect(
          window.getComputedStyle(fmBlock().querySelector(':scope > pre:not(.vditor-wysiwyg__preview)')).display === 'none',
          'the raw front matter source stayed visible next to the table'
        );
        const fmRowText = () => Array.from(fmTable().querySelectorAll('tr'))
          .map((row) => Array.from(row.children).map((cell) => cell.textContent).join('\\u0000'));
        expect(
          fmRowText().some((row) => row === 'title\\u0000Front Matter'),
          'the table is missing the title row: ' + JSON.stringify(fmRowText())
        );
        expect(
          fmRowText().some((row) => row === 'draft\\u0000false'),
          'draft: false did not reach the table as the text "false"'
        );
        expect(
          fmRowText().some((row) => row.indexOf('alpha') >= 0 && row.indexOf('beta') >= 0),
          'the tags sequence did not render on one row: ' + JSON.stringify(fmRowText())
        );
        expect(
          fmRowText().some((row) => row === 'email\\u0000wu@example.com'),
          'a doubly nested key did not reach the table'
        );
        expect(
          fmTable().querySelector('.vmd-front-matter__value--number'),
          'priority: 1 was not marked as a number'
        );
        // The parser deletes the blank line between the front matter and the body
        // on its own, with no plugin DOM involved. Pinned here so the assertion
        // below is known to be testing the plugin's repair and not a parser that
        // quietly started behaving. If this ever fails, the repair is redundant.
        const luteOnlyRoundTrip = window.vditor.vditor.lute.VditorDOM2Md(
          window.vditor.vditor.lute.Md2VditorDOM(frontMatterSource)
        );
        expect(
          luteOnlyRoundTrip.indexOf(lines('---', '# Body heading')) >= 0,
          'the parser no longer eats the blank line after the closing marker: ' +
            JSON.stringify(luteOnlyRoundTrip)
        );
        // The decisive assertion: with the table rendered, the document is byte
        // for byte what it was, blank line included.
        expect(
          window.vditor.getValue() === frontMatterSource,
          'rendering the front matter table changed the Markdown: ' +
            JSON.stringify(window.vditor.getValue())
        );
        // The table contributes nothing beyond that one separator: everything from
        // the body onward matches the parser's own output.
        expect(
          window.vditor.getValue().slice(window.vditor.getValue().indexOf('# Body heading')) ===
            luteOnlyRoundTrip.slice(luteOnlyRoundTrip.indexOf('# Body heading')),
          'the rendered table changed the document body relative to the parser'
        );
        expect(
          window.vditor.getValue().indexOf('<table') < 0 &&
            window.vditor.getValue().indexOf('vmd-front-matter') < 0,
          'the generated table leaked into the Markdown: ' +
            JSON.stringify(window.vditor.getValue())
        );

        // Editing the body must leave the front matter block alone, including the
        // blank line that separates it from the first heading.
        const bodyParagraph = Array.from(root().querySelectorAll(':scope > p'))
          .find((element) => element.textContent.indexOf('Body paragraph.') >= 0);
        expect(bodyParagraph, 'could not find the body paragraph');
        const bodyTextNode = textNode(bodyParagraph);
        select(bodyTextNode, bodyTextNode.textContent.length, bodyTextNode, bodyTextNode.textContent.length);
        bodyTextNode.textContent = bodyTextNode.textContent + ' Edited.';
        root().dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '.' }));
        await pause(220);
        const afterBodyEdit = window.vditor.getValue();
        expect(
          afterBodyEdit.indexOf(lines('---', 'title: Front Matter')) === 0,
          'editing the body rewrote the front matter block: ' + JSON.stringify(afterBodyEdit)
        );
        expect(
          afterBodyEdit.indexOf('  - alpha') >= 0 && afterBodyEdit.indexOf('    email: wu@example.com') >= 0,
          'editing the body reflowed the front matter indentation: ' + JSON.stringify(afterBodyEdit)
        );
        expect(
          afterBodyEdit.indexOf('Body paragraph. Edited.') >= 0,
          'the body edit itself was lost'
        );

        // Clicking the table swaps in the source so it can be edited as a code
        // area, and the caret lands inside that source.
        fmTable().dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await pause(160);
        expect(!fmTable(), 'clicking the table did not switch to the source view');
        const fmSourcePre = fmBlock().querySelector(':scope > pre:not(.vditor-wysiwyg__preview)');
        expect(
          window.getComputedStyle(fmSourcePre).display !== 'none',
          'the front matter source stayed hidden after clicking the table'
        );
        expect(
          fmSourcePre.contains(window.getSelection().getRangeAt(0).startContainer),
          'the caret was not placed inside the front matter source'
        );
        expect(
          window.vditor.getValue() === afterBodyEdit,
          'toggling to the source view changed the Markdown: ' +
            JSON.stringify(window.vditor.getValue())
        );

        // Moving the caret out brings the table back.
        const outsideNode = textNode(Array.from(root().querySelectorAll(':scope > p'))
          .find((element) => element.textContent.indexOf('Body paragraph.') >= 0));
        select(outsideNode, 0, outsideNode, 0);
        document.dispatchEvent(new Event('selectionchange'));
        await pause(160);
        expect(fmTable(), 'leaving the front matter did not restore the table');
        expect(
          window.vditor.getValue() === afterBodyEdit,
          'restoring the table changed the Markdown'
        );

        // Invalid YAML must say so and keep the source readable, per test07.
        const badFrontMatter = lines('---', 'title: [unclosed', 'items:', '  - first', '---', '', '# Body', '');
        await setMarkdown(badFrontMatter);
        await pause(200);
        expect(fmBlock(), 'invalid front matter was not recognized as a block');
        expect(!fmTable(), 'invalid YAML was rendered as a table anyway');
        const fmError = fmBlock().querySelector('.vmd-front-matter__error');
        expect(fmError, 'invalid YAML did not report an error');
        expect(
          fmError.textContent.indexOf('Front Matter') >= 0,
          'the error message does not name what failed: ' + JSON.stringify(fmError.textContent)
        );
        expect(
          fmBlock().querySelector('.vmd-front-matter__raw').textContent.indexOf('[unclosed') >= 0,
          'the raw source was not kept visible beside the error'
        );
        expect(
          window.vditor.getValue() === badFrontMatter,
          'the invalid front matter document was rewritten: ' +
            JSON.stringify(window.vditor.getValue())
        );

        // An unclosed block is not front matter, so nothing may be swallowed.
        const unclosed = lines('---', 'title: Unclosed', '', '# Still visible', '');
        await setMarkdown(unclosed);
        await pause(160);
        expect(
          root().textContent.indexOf('Still visible') >= 0,
          'an unclosed front matter block swallowed the document body'
        );

        // The other two display modes, per test05. Neither may touch the source.
        await setMarkdown(frontMatterSource);
        await pause(160);
        expect(fmTable(), 'the table mode did not restore before testing other modes');

        window.__vmdFrontMatter.setDisplay('codeBlock');
        await pause(160);
        expect(!fmTable(), 'codeBlock mode still rendered a table');
        expect(
          window.getComputedStyle(fmBlock().querySelector(':scope > pre:not(.vditor-wysiwyg__preview)')).display !== 'none',
          'codeBlock mode hid the YAML source instead of showing it'
        );
        expect(
          window.getComputedStyle(fmBlock()).display !== 'none',
          'codeBlock mode hid the whole block'
        );
        expect(
          window.vditor.getValue() === frontMatterSource,
          'codeBlock mode changed the Markdown: ' + JSON.stringify(window.vditor.getValue())
        );

        window.__vmdFrontMatter.setDisplay('hide');
        await pause(160);
        expect(!fmTable(), 'hide mode still rendered a table');
        expect(
          window.getComputedStyle(fmBlock()).display === 'none',
          'hide mode left the front matter block visible'
        );
        expect(
          root().textContent.indexOf('Body heading') >= 0,
          'hide mode hid the document body along with the front matter'
        );
        // The whole point of hide: invisible on screen, intact in the document.
        expect(
          window.vditor.getValue() === frontMatterSource,
          'hide mode changed the Markdown: ' + JSON.stringify(window.vditor.getValue())
        );

        window.__vmdFrontMatter.setDisplay('table');
        await pause(160);
        expect(fmTable(), 'returning to table mode did not render the table again');
        expect(
          window.getComputedStyle(fmBlock()).display !== 'none',
          'returning to table mode left the block hidden'
        );
        expect(
          window.vditor.getValue() === frontMatterSource,
          'cycling through the display modes changed the Markdown: ' +
            JSON.stringify(window.vditor.getValue())
        );

        // Opening a document that already has front matter goes through init, not
        // setValue, so the separator has to be captured from the host's own text.
        // Reading it back from the editor would read it after the parser already
        // collapsed it, and the blank line would be lost on the very first edit.
        // Kept last in this section: init replaces the document the assertions
        // above compare against.
        const openedSource = lines('---', 'title: Opened', '---', '', '# Opened body', '');
        hostGeneration = 2;
        window.dispatchEvent(new MessageEvent('message', {
          data: {
            command: 'update',
            type: 'init',
            content: openedSource,
            documentVersion: 2,
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
        await wait(() => root() && root().textContent.indexOf('Opened body') >= 0);
        await pause(200);
        expect(
          window.vditor.getValue() === openedSource,
          'a document opened with front matter lost its blank line: ' +
            JSON.stringify(window.vditor.getValue())
        );
        expect(
          root().querySelector('table.vmd-front-matter'),
          'a document opened with front matter did not render the table'
        );
        const reopenedBaselines = window.__vmdMessages.filter(
          (message) => message.command === 'editor-baseline' && message.generation === hostGeneration
        );
        expect(
          reopenedBaselines.length === 1 && reopenedBaselines[0].documentVersion === 2,
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
          window.vditor.getValue() === openedSource,
          'a stale-generation host update replaced the reinitialized editor'
        );

        await switchMode('sv');
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
        const message = error && error.message ? error.message : String(error);
        result.textContent = 'failed: ' + message +
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

  const [mainJs, mainCss, lute, i18n] = await Promise.all([
    readFile(path.join(root, 'media/dist/main.js')),
    readFile(path.join(root, 'media/dist/main.css')),
    readFile(path.join(root, 'media-src/node_modules/vditor/dist/js/lute/lute.min.js')),
    readFile(path.join(root, 'media-src/node_modules/vditor/dist/js/i18n/en_US.js')),
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
        '--virtual-time-budget=8000',
        '--dump-dom',
        `http://127.0.0.1:${port}/`,
      ],
      { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }
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
