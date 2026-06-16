# AI Handoff - Ace Figma Exporter Plugin

This file contains the complete context, architecture, capabilities, and setup details for the **Ace Figma Exporter** plugin. It is designed to allow another AI coding agent to quickly pick up context and continue development on another machine.

---

## 1. Project Context & Purpose
The project is a Figma plugin located in `Anomaly-Aces-Figma-Plugins/`. 
* **Purpose**: Allows designers to select a container (or page/multi-select) on the Figma canvas, filters and packages layers into SVG assets, downloads Google Fonts or packages uploaded local fonts, and bundles everything into a single `.zip` archive alongside a structured `metadata.json` file.
* **Relationship**: The resulting ZIP package serves as the primary asset source for the **Godot Theme Generator** addon. The theme generator reads `metadata.json` and imports the SVGs as textures/icons and styles to generate native Godot Theme resources.

---

## 2. Plugin Architecture & Threads
The plugin is split into two runtime environments as required by Figma's model:

### A. Figma Sandbox Thread (`src/code.ts`)
* Runs in the main Figma sandbox (no access to browser APIs like `fetch`, `FileReader`, or `JSZip`).
* Monitors canvas selection changes (`selectionchange`) and counts available layers.
* Performs recursive traversal to filter target nodes (Components, Direct Children, or Frames/Groups).
* Handles relative coordinate mapping (relative to the container’s bounding box coordinates).
* Clones nodes, detaches component instances, recolors objects, and invokes `node.exportAsync({ format: "SVG" })` to get SVG byte arrays.
* Sends chunks of exported SVG bytes and metadata back to the UI thread via `figma.ui.postMessage`.

### B. UI Thread (`src/ui.ts` & `src/ui.html`)
* Runs in the browser frame of the plugin panel (has access to Web/DOM APIs, network, and files).
* Orchestrates JSZip building to pack files into `[SelectionName]_assets.zip`.
* **Google Fonts Downloader**: Takes detected text layer font families and styles, constructs a Google Fonts CSS v2 API query, fetches CSS, extracts WOFF2 urls, downloads the binary fonts, and bundles them inside `fonts/` in the ZIP.
* **Local Fonts Upload**: Allows drag-and-drop or file selection of local fonts (`.woff2`, `.woff`, `.ttf`, `.otf`), automatically matching them to detected canvas text styles or packing them as custom fonts inside the ZIP.
* **Metadata Builder**: Formulates `metadata.json` mapping filenames to element ids, width, height, font definitions, and instance/variant properties.
* Handles panel resizing via mouse drag handle.

---

## 3. Special Features & Visual Effects Splitting
* **Split Effects Option (`opt-split-effects`)**: If enabled, layers containing shadows or blurs are split into two separate SVGs:
  * **Content Layer (`[name]/content.svg`)**: The layer with all shadows/blurs stripped out.
  * **Effects Layer (`[name]/effects.svg`)**: 
    1. Detects drop shadows or inner shadows.
    2. Detaches instances and recolors vector shapes to the shadow's solid RGB color.
    3. Replaces shapes' internal effects with a single layer blur matching the shadow radius and applies the shadow's opacity.
    4. Offsets position to match shadow offsets.
    5. This provides clean visual components that Godot can blend natively.
* **Visual Effects Metadata (Normal Exports)**: When exporting normally (non-split), the plugin recursively scans the node and all of its nested children to extract details for active, visible visual effects (e.g. drop shadows, inner shadows, layer blurs, background blurs). These are recorded in `metadata.json` under the `effects` field, mapping the effect type, colors, coordinates, radius, and origin node info.

---

## 4. Development & Build Commands
* **Compilation**: Handled via `esbuild` using `build.js`.
* **Scripts**:
  * Build: `npm run build`
  * Watch mode: `npm run watch`
* **Dependencies**:
  * `jszip`: For ZIP archiving.
  * `@figma/plugin-typings`: Typings for Figma SDK.

---

## 5. File structure
* **Figma Main sandbox**: [code.ts](file:///c:/Users/Jerek/Documents/Anomaly-Aces-Figma-Plugins/src/code.ts)
* **UI Interface**: [ui.html](file:///c:/Users/Jerek/Documents/Anomaly-Aces-Figma-Plugins/src/ui.html)
* **UI Script**: [ui.ts](file:///c:/Users/Jerek/Documents/Anomaly-Aces-Figma-Plugins/src/ui.ts)
* **UI Styling**: [ui.css](file:///c:/Users/Jerek/Documents/Anomaly-Aces-Figma-Plugins/src/ui.css)
* **Manifest**: [manifest.json](file:///c:/Users/Jerek/Documents/Anomaly-Aces-Figma-Plugins/manifest.json)
