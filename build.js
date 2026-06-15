const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');
const distDir = path.join(__dirname, 'dist');

function ensureDirectoryExistence(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function build() {
  console.log('[Build] Starting compilation...');
  try {
    ensureDirectoryExistence(distDir);

    // 1. Build code.ts (Figma Sandbox thread)
    esbuild.buildSync({
      entryPoints: [path.join(srcDir, 'code.ts')],
      bundle: true,
      minify: false, // Leave unminified for easy debugging
      platform: 'node',
      target: ['es2020'],
      outfile: path.join(distDir, 'code.js'),
    });
    console.log('[Build] Compiled code.ts -> dist/code.js');

    // 2. Bundle ui.ts (Figma UI thread, in-memory)
    const uiJsResult = esbuild.buildSync({
      entryPoints: [path.join(srcDir, 'ui.ts')],
      bundle: true,
      minify: false, // Leave unminified for easy debugging
      platform: 'browser',
      target: ['es2020'],
      write: false, // Do not write to file
    });

    const bundledUiJs = uiJsResult.outputFiles[0].text;
    console.log('[Build] Compiled ui.ts (in-memory bundle)');

    // 3. Read ui.css
    const uiCssPath = path.join(srcDir, 'ui.css');
    let bundledUiCss = '';
    if (fs.existsSync(uiCssPath)) {
      bundledUiCss = fs.readFileSync(uiCssPath, 'utf8');
    }
    console.log('[Build] Loaded ui.css');

    // 4. Read ui.html and replace placeholders
    const uiHtmlPath = path.join(srcDir, 'ui.html');
    if (!fs.existsSync(uiHtmlPath)) {
      throw new Error('src/ui.html not found!');
    }
    let uiHtml = fs.readFileSync(uiHtmlPath, 'utf8');

    // Replace the placeholders with inlined contents
    uiHtml = uiHtml.replace(
      '/* CSS_PLACEHOLDER */',
      bundledUiCss
    );
    uiHtml = uiHtml.replace(
      '/* JS_PLACEHOLDER */',
      bundledUiJs
    );

    // Write final ui.html to dist
    fs.writeFileSync(path.join(distDir, 'ui.html'), uiHtml, 'utf8');
    console.log('[Build] Inlined assets -> dist/ui.html');
    console.log('[Build] Successful!\n');
  } catch (error) {
    console.error('[Build] Failed:', error);
  }
}

// Check arguments
const isWatch = process.argv.includes('--watch');

build();

if (isWatch) {
  console.log('[Watch] Watching src/ directory for changes...');
  let debounceTimeout = null;
  fs.watch(srcDir, { recursive: true }, (eventType, filename) => {
    if (filename) {
      if (debounceTimeout) clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(() => {
        console.log(`[Watch] File change detected: ${filename}`);
        build();
      }, 100);
    }
  });
}
