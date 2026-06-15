import JSZip from 'jszip';

// UI elements cache
const selectionBadge = document.getElementById("selection-badge") as HTMLSpanElement;
const selectionName = document.getElementById("selection-name") as HTMLDivElement;
const btnExport = document.getElementById("btn-export") as HTMLButtonElement;
const selectionCard = document.querySelector(".selection-card") as HTMLElement;

const statComponents = document.getElementById("stat-components") as HTMLSpanElement;
const statDirect = document.getElementById("stat-direct") as HTMLSpanElement;
const statFrames = document.getElementById("stat-frames") as HTMLSpanElement;

const optSlashes = document.getElementById("opt-slashes") as HTMLInputElement;
const optClean = document.getElementById("opt-clean") as HTMLInputElement;
const optFonts = document.getElementById("opt-fonts") as HTMLInputElement;
const optSplitEffects = document.getElementById("opt-split-effects") as HTMLInputElement;

const selectionFontsContainer = document.getElementById("selection-fonts-container") as HTMLDivElement;
const selectionFontsList = document.getElementById("selection-fonts-list") as HTMLSpanElement;

const progressPanel = document.getElementById("progress-panel") as HTMLDivElement;
const progressBar = document.getElementById("progress-bar") as HTMLDivElement;
const progressText = document.getElementById("progress-text") as HTMLSpanElement;
const progressPercent = document.getElementById("progress-percent") as HTMLSpanElement;

// Local Fonts Uploader Elements
const fontsUploadZone = document.getElementById("fonts-upload-zone") as HTMLDivElement;
const inputLocalFonts = document.getElementById("input-local-fonts") as HTMLInputElement;
const uploadedFontsListEl = document.getElementById("uploaded-fonts-list") as HTMLDivElement;
const uploadedCountBadge = document.getElementById("uploaded-count-badge") as HTMLSpanElement;

// State variables
let currentCounts = { components: 0, direct: 0, frames: 0 };
let currentSelectionName = "No selection active";
let currentTypeString = "PAGE";
let detectedSelectionFonts: Array<{ family: string, style: string }> = [];
let exportedFonts: Array<{ family: string, style: string }> = [];
const uploadedFonts: Array<{ name: string, data: Uint8Array }> = [];
let totalToExport = 0;
let zip: JSZip | null = null;
let metadataJson: Record<string, any> = {};
let usedFilenames = new Set<string>();

// Listen to selection radio option changes
const targetRadios = document.querySelectorAll('input[name="export-target"]');
targetRadios.forEach(radio => {
  radio.addEventListener("change", () => {
    updateButtonState();
  });
});

// Update export button label and disabled state based on current counts
function getSelectedFilter(): string {
  const checkedRadio = document.querySelector('input[name="export-target"]:checked') as HTMLInputElement;
  return checkedRadio ? checkedRadio.value : "components";
}

function updateButtonState() {
  const filter = getSelectedFilter();
  let count = 0;

  if (filter === "components") {
    count = currentCounts.components;
  } else if (filter === "direct") {
    count = currentCounts.direct;
  } else if (filter === "frames") {
    count = currentCounts.frames;
  }

  // Set button text dynamically
  if (count > 0) {
    btnExport.disabled = false;
    btnExport.textContent = `Export ${count} Asset${count > 1 ? 's' : ''}`;
  } else {
    btnExport.disabled = true;
    const filterLabel = filter === "components" 
      ? "components" 
      : filter === "direct" 
        ? "direct children" 
        : "frames/groups";
    btnExport.textContent = `No ${filterLabel} to export`;
  }
}

// Receive messages from Figma sandbox
// Use addEventListener instead of onmessage= so a thrown error inside
// never suppresses future message delivery.
window.addEventListener('message', (event) => {
  console.log("[Plugin UI] message event received:", event.data);
  try {
    const msg = event.data.pluginMessage;
    if (!msg) {
      console.log("[Plugin UI] event.data.pluginMessage is empty");
      return;
    }
    console.log("[Plugin UI] handling message type:", msg.type, msg);
    handlePluginMessage(msg);
  } catch (err) {
    console.error('[Plugin UI] Message handler top-level error:', err);
  }
});

function handlePluginMessage(msg: any) {
  console.log("[Plugin UI] handlePluginMessage triggered for type:", msg.type);
  switch (msg.type) {
    case "selection-status":
      currentSelectionName = msg.name;
      currentCounts = msg.counts;
      currentTypeString = msg.typeString;

      selectionName.textContent = currentSelectionName;
      statComponents.textContent = String(currentCounts.components);
      statDirect.textContent = String(currentCounts.direct);
      statFrames.textContent = String(currentCounts.frames);

      // Update Selection Card & Badge styling
      if (currentTypeString === "PAGE") {
        selectionBadge.textContent = "Page Mode";
        selectionBadge.className = "badge badge-inactive";
        selectionCard.classList.remove("active");
      } else {
        const typeLabel = currentTypeString === "MULTIPLE"
          ? "Multi-Select"
          : `${currentTypeString.charAt(0) + currentTypeString.slice(1).toLowerCase()} Active`;
        selectionBadge.textContent = typeLabel;
        selectionBadge.className = "badge badge-active";
        selectionCard.classList.add("active");
      }

      // Hide font list on selection change — populated at export time
      if (selectionFontsContainer) selectionFontsContainer.classList.add("hidden");

      updateButtonState();
      break;

    case "export-progress-init":
      totalToExport = msg.total;
      exportedFonts = msg.fonts || [];
      zip = new JSZip();
      metadataJson = {};
      usedFilenames.clear();

      // Show fonts detected in the exported layers
      if (exportedFonts.length > 0 && selectionFontsList && selectionFontsContainer) {
        const uniqueFamilies = Array.from(new Set(exportedFonts.map((f: any) => f.family)));
        selectionFontsList.textContent = uniqueFamilies.join(", ");
        selectionFontsContainer.classList.remove("hidden");
      }

      // Update UI
      progressPanel.classList.remove("hidden");
      progressBar.style.width = "0%";
      progressPercent.textContent = "0%";
      progressText.textContent = `Starting export of ${totalToExport} layers...`;
      break;

    case "export-progress-chunk":
      if (!zip) return;

      const chunkData = msg.data as Array<{
        id: string;
        name: string;
        svgBytes: number[];
        metadata: Record<string, any>;
      }>;

      const slashesToFolders = optSlashes.checked;
      const cleanFilenames = optClean.checked;

      chunkData.forEach(item => {
        const svgUint8 = new Uint8Array(item.svgBytes);
        let rawName = item.name;

        // Check if it is a split asset (ends with /content or /effects)
        const isSplitContent = rawName.endsWith("/content");
        const isSplitEffects = rawName.endsWith("/effects");
        let baseName = rawName;
        let suffix = "";

        if (isSplitContent) {
          baseName = rawName.slice(0, -8);
          suffix = "/content";
        } else if (isSplitEffects) {
          baseName = rawName.slice(0, -8);
          suffix = "/effects";
        }

        let filename = baseName;

        // Apply clean/naming strategies
        if (cleanFilenames) {
          if (slashesToFolders) {
            filename = filename
              .split("/")
              .map(part => sanitizeFilenamePart(part))
              .join("/");
          } else {
            filename = sanitizeFilenamePart(filename.replace(/[\/\\]/g, "_"));
          }
        } else {
          if (!slashesToFolders) {
            filename = filename.replace(/[\/\\]/g, "_");
          }
        }

        if (!filename || filename.trim() === "") {
          filename = `layer_${item.id.replace(/:/g, "_")}`;
        }

        // Re-append folder group suffix for split layers
        if (suffix) {
          filename += suffix;
        }

        if (!filename.toLowerCase().endsWith(".svg")) {
          filename += ".svg";
        }

        let uniqueFilename = filename;
        let counter = 1;
        const dotIndex = filename.lastIndexOf(".svg");
        const base = filename.slice(0, dotIndex);
        const ext = filename.slice(dotIndex);

        while (usedFilenames.has(uniqueFilename.toLowerCase())) {
          uniqueFilename = `${base}_${counter}${ext}`;
          counter++;
        }
        usedFilenames.add(uniqueFilename.toLowerCase());

        zip!.file(uniqueFilename, svgUint8);
        metadataJson[uniqueFilename] = item.metadata;
      });

      const processed = msg.processedCount;
      const percent = Math.round((processed / totalToExport) * 100);
      progressBar.style.width = `${percent}%`;
      progressPercent.textContent = `${percent}%`;
      progressText.textContent = `Processed ${processed} of ${totalToExport} assets...`;
      break;

    case "export-complete":
      (async () => {
        if (optFonts && optFonts.checked && exportedFonts.length > 0) {
          await downloadGoogleFonts(exportedFonts);
        }
        await finalizeAndDownloadZip();
      })();
      break;

    case "export-error":
      alert(msg.message);
      resetExportUI();
      break;

    case "sandbox-log":
      addDebugLog(`[Sandbox] ${msg.message}`, msg.level || 'info');
      break;
  }
}

/**
 * Sanitizes a single filename part (strips special characters, converts spaces to underscores)
 */
function sanitizeFilenamePart(part: string): string {
  // Allow letters, numbers, hyphens, underscores, and spaces
  let sanitized = part.replace(/[^a-zA-Z0-9\-_ ]/g, "").trim();
  // Replace multiple spaces with a single underscore
  sanitized = sanitized.replace(/\s+/g, "_");
  return sanitized;
}

/**
 * Finalizes the ZIP file by writing metadata.json, downloads it, and resets the export UI
 */
async function finalizeAndDownloadZip() {
  if (!zip) return;

  progressText.textContent = "Processing local uploaded fonts...";

  // 1. Bundle and match local uploaded fonts
  if (uploadedFonts.length > 0) {
    uploadedFonts.forEach(uploaded => {
      const zipPath = `fonts/${uploaded.name}`;
      zip!.file(zipPath, uploaded.data);

      let matched = false;
      const uploadedNameClean = uploaded.name.slice(0, uploaded.name.lastIndexOf(".")).toLowerCase().replace(/[^a-z0-9]/g, "");

      // Try matching with detected exportedFonts
      exportedFonts.forEach(f => {
        const familyClean = f.family.toLowerCase().replace(/[^a-z0-9]/g, "");
        const styleClean = f.style.toLowerCase().replace(/[^a-z0-9]/g, "");
        const targetClean = familyClean + styleClean;

        // Matches if uploaded file name (e.g. triakisregular) matches style target or family name
        if (uploadedNameClean === targetClean || uploadedNameClean === familyClean || 
            targetClean.includes(uploadedNameClean) || uploadedNameClean.includes(targetClean)) {
          
          metadataJson.fonts = metadataJson.fonts || {};
          metadataJson.fonts[`${f.family} ${f.style}`] = {
            family: f.family,
            style: f.style,
            downloaded: true,
            path: zipPath,
            source: "uploaded"
          };
          matched = true;
          console.log(`Matched uploaded local font "${uploaded.name}" to detected layer font "${f.family} ${f.style}"`);
        }
      });

      if (!matched) {
        // Record it as an extra custom font
        metadataJson.custom_uploaded_fonts = metadataJson.custom_uploaded_fonts || [];
        metadataJson.custom_uploaded_fonts.push(zipPath);
        console.log(`Bundled custom local font: "${uploaded.name}" (did not match any text layer styles directly)`);
      }
    });
  }

  progressText.textContent = "Compiling ZIP package...";
  
  try {
    // Add metadata.json to root of zip
    zip.file("metadata.json", JSON.stringify(metadataJson, null, 2));

    // Generate blob
    const content = await zip.generateAsync({ type: "blob" });
    
    progressText.textContent = "Triggering download...";

    // Trigger browser download
    const blobUrl = URL.createObjectURL(content);
    const link = document.createElement("a");
    link.href = blobUrl;
    
    // Format package filename using the active container name
    let zipName = currentSelectionName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "_")
      .replace(/_+/g, "_")
      .trim();
    if (zipName.startsWith("_")) zipName = zipName.slice(1);
    if (zipName.endsWith("_")) zipName = zipName.slice(0, -1);
    if (!zipName) zipName = "figma_export";
    
    link.download = `${zipName}_assets.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // Cleanup
    URL.revokeObjectURL(blobUrl);

    progressText.textContent = "Download complete!";
    progressBar.style.width = "100%";
    progressPercent.textContent = "100%";
    
    // Reset UI state after brief success feedback
    setTimeout(() => {
      resetExportUI();
    }, 2000);

  } catch (err) {
    console.error("ZIP creation failed:", err);
    alert("An error occurred while building the ZIP file.");
    resetExportUI();
  }
}

/**
 * Click handler for the export button
 */
btnExport.addEventListener("click", () => {
  // Disable options during export
  btnExport.disabled = true;
  document.querySelectorAll('input').forEach(input => input.disabled = true);

  // Send request
  parent.postMessage({
    pluginMessage: {
      type: "start-export",
      options: {
        target: getSelectedFilter(),
        slashesToFolders: optSlashes.checked,
        cleanFilenames: optClean.checked,
        splitEffects: optSplitEffects.checked
      }
    }
  }, "*");
});

/**
 * Resets the UI components after an export completes or fails
 */
function resetExportUI() {
  progressPanel.classList.add("hidden");
  document.querySelectorAll('input').forEach(input => input.disabled = false);
  updateButtonState();
}

/**
 * Maps common font weight names to numeric values
 */
function getStyleWeights(figmaStyle: string): { weight: number, italic: number } {
  const cleanStyle = figmaStyle.toLowerCase();
  let weight = 400;
  let italic = 0;

  if (cleanStyle.includes("italic")) {
    italic = 1;
  }

  if (cleanStyle.includes("thin") || cleanStyle.includes("hairline") || cleanStyle.includes("100")) {
    weight = 100;
  } else if (cleanStyle.includes("extra light") || cleanStyle.includes("extralight") || cleanStyle.includes("ultralight") || cleanStyle.includes("200")) {
    weight = 200;
  } else if (cleanStyle.includes("light") || cleanStyle.includes("300")) {
    weight = 300;
  } else if (cleanStyle.includes("medium") || cleanStyle.includes("500")) {
    weight = 500;
  } else if (cleanStyle.includes("semibold") || cleanStyle.includes("semi bold") || cleanStyle.includes("demibold") || cleanStyle.includes("600")) {
    weight = 600;
  } else if (cleanStyle.includes("bold") || cleanStyle.includes("700")) {
    weight = 700;
  } else if (cleanStyle.includes("extra bold") || cleanStyle.includes("extrabold") || cleanStyle.includes("ultrabold") || cleanStyle.includes("800")) {
    weight = 800;
  } else if (cleanStyle.includes("black") || cleanStyle.includes("heavy") || cleanStyle.includes("900")) {
    weight = 900;
  }

  return { weight, italic };
}

/**
 * Constructs a query string compatible with the Google Fonts CSS v2 API
 */
function buildGoogleFontsQuery(family: string, styles: string[]): string {
  const familyEscaped = family.replace(/\s+/g, "+");
  if (styles.length === 0) {
    return `family=${familyEscaped}`;
  }

  const specList: { ital: number, weight: number }[] = [];
  let hasItalic = false;
  let hasNormal = false;

  styles.forEach(s => {
    const { weight, italic } = getStyleWeights(s);
    if (italic === 1) hasItalic = true;
    else hasNormal = true;
    specList.push({ ital: italic, weight });
  });

  // Sort specs: first by ital, then by weight
  specList.sort((a, b) => {
    if (a.ital !== b.ital) return a.ital - b.ital;
    return a.weight - b.weight;
  });

  // De-duplicate specs
  const uniqueSpecs: { ital: number, weight: number }[] = [];
  const seen = new Set<string>();
  specList.forEach(spec => {
    const key = `${spec.ital},${spec.weight}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueSpecs.push(spec);
    }
  });

  if (hasItalic && hasNormal) {
    const specStr = uniqueSpecs.map(s => `${s.ital},${s.weight}`).join(";");
    return `family=${familyEscaped}:ital,wght@${specStr}`;
  } else if (hasItalic) {
    const specStr = uniqueSpecs.map(s => `1,${s.weight}`).join(";");
    return `family=${familyEscaped}:ital,wght@${specStr}`;
  } else {
    const specStr = uniqueSpecs.map(s => `${s.weight}`).join(";");
    return `family=${familyEscaped}:wght@${specStr}`;
  }
}

/**
 * Queries the Google Fonts API, parses the font files, downloads WOFF2s, and stores them in the ZIP
 */
async function downloadGoogleFonts(fonts: Array<{ family: string, style: string }>) {
  if (fonts.length === 0) return;
  
  progressText.textContent = "Checking Google Fonts...";
  progressBar.style.width = "0%";
  progressPercent.textContent = "0%";

  // Group styles by font family
  const familyGroups = new Map<string, string[]>();
  fonts.forEach(f => {
    if (!familyGroups.has(f.family)) {
      familyGroups.set(f.family, []);
    }
    familyGroups.get(f.family)!.push(f.style);
  });

  const familiesList = Array.from(familyGroups.keys());
  let downloadedCount = 0;

  for (let i = 0; i < familiesList.length; i++) {
    const family = familiesList[i];
    const styles = familyGroups.get(family)!;

    progressText.textContent = `Searching Google Font: ${family}...`;
    progressBar.style.width = `${Math.round((i / familiesList.length) * 100)}%`;
    progressPercent.textContent = `${Math.round((i / familiesList.length) * 100)}%`;

    try {
      const queryParam = buildGoogleFontsQuery(family, styles);
      const cssUrl = `https://fonts.googleapis.com/css2?${queryParam}`;
      
      const response = await fetch(cssUrl);
      if (!response.ok) {
        console.warn(`Font ${family} not found on Google Fonts (CSS return code ${response.status})`);
        
        // Mark all requested styles of this family as local/skipped
        styles.forEach(style => {
          metadataJson.fonts = metadataJson.fonts || {};
          metadataJson.fonts[`${family} ${style}`] = {
            family,
            style,
            downloaded: false,
            reason: `Font not found on Google Fonts (CSS fetch status ${response.status})`
          };
        });
        continue;
      }

      const cssText = await response.text();
      
      // Parse @font-face blocks from the CSS
      const fontFaceBlocks = cssText.match(/@font-face\s*\{[^}]*\}/gi) || [];
      if (fontFaceBlocks.length === 0) {
        styles.forEach(style => {
          metadataJson.fonts = metadataJson.fonts || {};
          metadataJson.fonts[`${family} ${style}`] = {
            family,
            style,
            downloaded: false,
            reason: "Could not parse @font-face from Google Fonts CSS"
          };
        });
        continue;
      }

      progressText.textContent = `Downloading ${family} font files...`;

      // Download woff2 files in each block
      for (const block of fontFaceBlocks) {
        const styleMatch = block.match(/font-style:\s*([a-z]+)/i);
        const weightMatch = block.match(/font-weight:\s*(\d+)/i);
        const urlMatch = block.match(/src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/i);

        if (urlMatch) {
          const url = urlMatch[1];
          const style = styleMatch ? styleMatch[1] : 'normal';
          const weight = weightMatch ? weightMatch[1] : '400';

          try {
            const fontResponse = await fetch(url);
            if (fontResponse.ok) {
              const arrayBuffer = await fontResponse.arrayBuffer();
              const fontBytes = new Uint8Array(arrayBuffer);
              
              // ZIP filename format: fonts/Roboto-700-normal.woff2
              const cleanFamilyName = family.replace(/\s+/g, "_");
              const fontZipPath = `fonts/${cleanFamilyName}-${weight}-${style}.woff2`;
              
              zip!.file(fontZipPath, fontBytes);
              downloadedCount++;

              // Correlate with Figma styles to mark download success in metadata
              styles.forEach(figmaStyle => {
                const { weight: figmaWeight, italic: figmaItalic } = getStyleWeights(figmaStyle);
                const isItalicString = figmaItalic === 1 ? 'italic' : 'normal';
                
                if (Number(weight) === figmaWeight && style === isItalicString) {
                  metadataJson.fonts = metadataJson.fonts || {};
                  metadataJson.fonts[`${family} ${figmaStyle}`] = {
                    family,
                    style: figmaStyle,
                    downloaded: true,
                    path: fontZipPath,
                    url
                  };
                }
              });
            }
          } catch (err) {
            console.error(`Failed to download binary font from URL ${url}:`, err);
          }
        }
      }
    } catch (err) {
      console.error(`Google Fonts fetching failed for family ${family}:`, err);
    }
  }

  progressText.textContent = `Downloaded ${downloadedCount} Google Fonts files...`;
  progressBar.style.width = "100%";
  progressPercent.textContent = "100%";
  await new Promise(resolve => setTimeout(resolve, 600)); // Brief pause for readability
}

// Local Fonts Upload Handlers
if (fontsUploadZone && inputLocalFonts && uploadedFontsListEl && uploadedCountBadge) {
  // Trigger file dialog
  fontsUploadZone.addEventListener("click", () => {
    inputLocalFonts.click();
  });

  // Handle files selected via file dialog
  inputLocalFonts.addEventListener("change", () => {
    const files = inputLocalFonts.files;
    if (files) {
      handleFiles(Array.from(files));
    }
    inputLocalFonts.value = ""; // Reset to allow same file selection again
  });

  // Drag & Drop event handlers
  fontsUploadZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    fontsUploadZone.classList.add("dragover");
  });

  fontsUploadZone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    fontsUploadZone.classList.add("dragover");
  });

  fontsUploadZone.addEventListener("dragleave", () => {
    fontsUploadZone.classList.remove("dragover");
  });

  fontsUploadZone.addEventListener("dragend", () => {
    fontsUploadZone.classList.remove("dragover");
  });

  fontsUploadZone.addEventListener("drop", (e) => {
    e.preventDefault();
    fontsUploadZone.classList.remove("dragover");
    const files = e.dataTransfer?.files;
    if (files) {
      handleFiles(Array.from(files));
    }
  });
}

function handleFiles(files: File[]) {
  const fontExtensions = [".woff2", ".woff", ".ttf", ".otf"];
  files.forEach(file => {
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!fontExtensions.includes(ext)) {
      console.warn(`File "${file.name}" is not a supported font format (requires .woff2, .woff, .ttf, or .otf)`);
      return;
    }

    // Avoid duplicate file names
    if (uploadedFonts.some(f => f.name.toLowerCase() === file.name.toLowerCase())) {
      console.log(`Font "${file.name}" is already uploaded.`);
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      if (event.target?.result instanceof ArrayBuffer) {
        uploadedFonts.push({
          name: file.name,
          data: new Uint8Array(event.target.result)
        });
        console.log(`Successfully uploaded local font: ${file.name}`);
        renderUploadedFonts();
      }
    };
    reader.onerror = () => {
      console.error(`Error reading font file: ${file.name}`);
    };
    reader.readAsArrayBuffer(file);
  });
}

function renderUploadedFonts() {
  if (!uploadedFontsListEl || !uploadedCountBadge) return;

  const count = uploadedFonts.length;
  if (count === 0) {
    uploadedCountBadge.textContent = "0 Uploaded";
    uploadedCountBadge.className = "badge badge-inactive";
    uploadedFontsListEl.classList.add("hidden");
    uploadedFontsListEl.innerHTML = "";
    return;
  }

  uploadedCountBadge.textContent = `${count} Uploaded`;
  uploadedCountBadge.className = "badge badge-active";
  uploadedFontsListEl.classList.remove("hidden");
  uploadedFontsListEl.innerHTML = "";

  uploadedFonts.forEach((font, index) => {
    const item = document.createElement("div");
    item.className = "uploaded-font-item";

    const nameSpan = document.createElement("span");
    nameSpan.className = "uploaded-font-name";
    nameSpan.textContent = font.name;
    nameSpan.title = font.name;

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-remove-font";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation(); // Avoid triggering file select dialog
      uploadedFonts.splice(index, 1);
      console.log(`Removed local font: ${font.name}`);
      renderUploadedFonts();
    });

    item.appendChild(nameSpan);
    item.appendChild(removeBtn);
    uploadedFontsListEl.appendChild(item);
  });
}

// Debug Console Log Helpers
const debugLogsEl = document.getElementById("debug-logs") as HTMLDivElement;
const btnClearDebug = document.getElementById("btn-clear-debug") as HTMLButtonElement;

if (btnClearDebug && debugLogsEl) {
  btnClearDebug.addEventListener("click", () => {
    debugLogsEl.innerHTML = "";
  });
}

function addDebugLog(text: string, level: 'info' | 'warn' | 'error' = 'info') {
  if (!debugLogsEl) return;
  const item = document.createElement("div");
  item.className = `debug-item ${level}`;
  item.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  debugLogsEl.appendChild(item);
  debugLogsEl.scrollTop = debugLogsEl.scrollHeight;
}

// Redirect console logs to the debug console
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = (...args: any[]) => {
  originalLog.apply(console, args);
  const text = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
  addDebugLog(text, 'info');
};

console.warn = (...args: any[]) => {
  originalWarn.apply(console, args);
  const text = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
  addDebugLog(text, 'warn');
};

console.error = (...args: any[]) => {
  originalError.apply(console, args);
  const text = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
  addDebugLog(text, 'error');
};

console.log("UI Script initialized. Cached elements check:");
console.log("- Badge:", !!selectionBadge);
console.log("- Card:", !!selectionCard);
console.log("- Export Btn:", !!btnExport);
console.log("- optFonts Checkbox:", !!optFonts);
console.log("- optSplitEffects Checkbox:", !!optSplitEffects);
console.log("- fontsUploadZone:", !!fontsUploadZone);
console.log("- inputLocalFonts:", !!inputLocalFonts);
console.log("- uploadedFontsListEl:", !!uploadedFontsListEl);
console.log("- uploadedCountBadge:", !!uploadedCountBadge);

// Signal to Figma sandbox that we are ready to receive initial selection status
console.log("Posting 'ui-ready' handshake to main sandbox...");
parent.postMessage({ pluginMessage: { type: "ui-ready" } }, "*");

// Window Resize Handling
const resizeHandle = document.getElementById("resize-handle");
if (resizeHandle) {
  let isResizing = false;
  let startX = 0;
  let startY = 0;
  let startWidth = 0;
  let startHeight = 0;

  resizeHandle.addEventListener("mousedown", (e) => {
    isResizing = true;
    startX = e.clientX;
    startY = e.clientY;
    startWidth = window.innerWidth;
    startHeight = window.innerHeight;
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!isResizing) return;
    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;
    const newWidth = Math.max(320, startWidth + deltaX);
    const newHeight = Math.max(400, startHeight + deltaY);

    parent.postMessage({
      pluginMessage: {
        type: "resize-window",
        width: newWidth,
        height: newHeight
      }
    }, "*");
  });

  window.addEventListener("mouseup", () => {
    isResizing = false;
  });
}
