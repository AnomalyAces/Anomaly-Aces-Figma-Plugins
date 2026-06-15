// Figma main sandbox thread code
console.log("[Plugin Main] Code sandbox starting...");

// Show the plugin UI - height increased to 720 to fit local fonts uploader
figma.showUI(__html__, { width: 360, height: 720, title: "Ace Figma Exporter" });

// Listen to selection changes on the canvas
figma.on("selectionchange", () => {
  console.log("[Plugin Main] Canvas selectionchange event fired");
  logToUI("Canvas selectionchange event fired");
  sendSelectionStatus();
});

// Listen to messages from the UI thread
figma.ui.onmessage = async (msg) => {
  console.log("[Plugin Main] Message received from UI:", msg);
  logToUI(`Message received from UI: ${msg.type}`);
  if (msg.type === "ui-ready") {
    sendSelectionStatus();
  } else if (msg.type === "start-export") {
    await runExport(msg.options);
  } else if (msg.type === "resize-window") {
    figma.ui.resize(msg.width, msg.height);
  }
};

type ContainerInfo =
  | { node: PageNode | SceneNode; name: string; type: string }
  | { nodes: readonly SceneNode[]; name: string; type: string };

/**
 * Scans the current selection and returns details about what is selected.
 */
function getSelectedContainerInfo(): ContainerInfo {
  const selection = figma.currentPage.selection;
  
  if (selection.length === 0) {
    // If nothing is selected, treat the current page as the container
    return {
      node: figma.currentPage,
      name: `Current Page (${figma.currentPage.name})`,
      type: "PAGE"
    };
  } else if (selection.length === 1) {
    const node = selection[0];
    return {
      node: node,
      name: `${node.name}`,
      type: node.type
    };
  } else {
    // Multiple selection
    return {
      nodes: selection,
      name: `${selection.length} layers selected`,
      type: "MULTIPLE"
    };
  }
}

/**
 * Sends current selection status to the UI.
 * Wrapped entirely in try/catch so a crash inside (e.g. remote library nodes)
 * never silently kills the update.
 */
function sendSelectionStatus() {
  console.log("[Plugin Main] sendSelectionStatus() triggered");
  logToUI("Calculating selection status...");
  try {
    const info = getSelectedContainerInfo();
    const typeStr = 'node' in info ? info.node.type : 'MULTIPLE';
    console.log("[Plugin Main] Container info parsed:", { name: info.name, type: typeStr });
    logToUI(`Selected Container: "${info.name}" (Type: ${typeStr})`);

    // Count how many components & instances are inside this container/selection
    let componentCount = 0;
    let directCount = 0;
    let frameCount = 0;

    const roots = 'node' in info ? [info.node] : info.nodes || [];
    console.log("[Plugin Main] Roots array length:", roots.length);

    roots.forEach(root => {
      // For direct children
      try {
        if ('children' in root && root.type !== "PAGE") {
          directCount += root.children.length;
        } else if (root.type === "PAGE") {
          directCount += root.children.length;
        } else {
          directCount += 1;
        }
      } catch (_) {}

      // Recursive traversal with per-node safety
      function traverse(node: SceneNode) {
        try {
          if (node.type === "COMPONENT" || node.type === "INSTANCE") {
            componentCount++;
            // Never walk into INSTANCE children — remote library instances
            // can throw when their children are accessed.
            return;
          }

          if (node.type === "FRAME" || node.type === "GROUP" ||
              node.type === "COMPONENT_SET") {
            frameCount++;
          }

          if ('children' in node) {
            for (const child of node.children) {
              traverse(child);
            }
          }
        } catch (err) {
          console.warn(`traverse error on ${node.name}:`, err);
        }
      }

      try {
        if (root.type === "PAGE") {
          for (const child of root.children) traverse(child);
        } else {
          traverse(root as SceneNode);
        }
      } catch (err) {
        console.warn(`root traverse error:`, err);
      }
    });

    console.log("[Plugin Main] Counts calculated:", {
      components: componentCount,
      direct: directCount,
      frames: frameCount
    });
    logToUI(`Scanned: ${componentCount} components, ${directCount} direct children, ${frameCount} frames`);

    const payload = {
      type: "selection-status",
      name: info.name,
      typeString: 'node' in info ? (info.node as any).type : "MULTIPLE",
      counts: { components: componentCount, direct: directCount, frames: frameCount }
    };
    console.log("[Plugin Main] Posting message to UI:", payload);
    logToUI("Sending selection-status payload to UI");
    figma.ui.postMessage(payload);
  } catch (err: any) {
    // Last-resort: send a safe empty status so the UI never stays stuck
    console.error("[Plugin Main] sendSelectionStatus crashed:", err);
    logToUI(`sendSelectionStatus crashed: ${err.message || err}`, "error");
    figma.ui.postMessage({
      type: "selection-status",
      name: "Selection error — try re-selecting",
      typeString: "PAGE",
      counts: { components: 0, direct: 0, frames: 0 }
    });
  }
}

/**
 * Helper to pause execution briefly to keep UI responsive
 */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Performs the actual export process
 */
async function runExport(options: { target: string, naming: string, slashesToFolders: boolean, splitEffects: boolean }) {
  const info = getSelectedContainerInfo();
  const roots = 'node' in info ? [info.node] : info.nodes || [];
  
  if (roots.length === 0) {
    figma.ui.postMessage({ type: "export-error", message: "No selection found." });
    return;
  }

  // Find all nodes to export based on target filter
  const targetNodes: SceneNode[] = [];
  
  roots.forEach(root => {
    if (options.target === "direct") {
      if ('children' in root && root.type !== "PAGE") {
        root.children.forEach(child => targetNodes.push(child));
      } else if (root.type === "PAGE") {
        root.children.forEach(child => targetNodes.push(child));
      } else {
        targetNodes.push(root); // If leaf node is selected directly, export it
      }
    } else {
      // Recursive traversal
      function traverse(node: SceneNode) {
        const isComponent = node.type === "COMPONENT" || node.type === "INSTANCE";
        const isFrameOrGroup = node.type === "FRAME" || node.type === "GROUP" || node.type === "COMPONENT_SET";

        if (options.target === "components") {
          if (isComponent) {
            targetNodes.push(node);
            return; // Do not traverse children of components/instances
          }
        } else if (options.target === "frames") {
          if (isComponent || isFrameOrGroup) {
            // We want to export frames, groups, components and instances
            targetNodes.push(node);
            // If it's a component set (container of variants) we do traverse to get its child variants
            if (node.type === "COMPONENT_SET") {
              for (const child of node.children) {
                traverse(child);
              }
              return;
            }
            // For normal frames/groups, we traverse. For instances, we don't.
            if (node.type === "INSTANCE") return;
          }
        }

        if ('children' in node) {
          for (const child of node.children) {
            traverse(child);
          }
        }
      }

      if (root.type === "PAGE") {
        for (const child of root.children) {
          traverse(child);
        }
      } else {
        traverse(root);
      }
    }
  });

  // Remove duplicate entries (e.g. if root itself is a component and got traversed)
  const uniqueNodes = Array.from(new Set(targetNodes));

  if (uniqueNodes.length === 0) {
    figma.ui.postMessage({ type: "export-error", message: "No layers found matching the selected filter." });
    return;
  }

  // Determine container reference coordinates for relative positions
  let containerX = 0;
  let containerY = 0;
  
  if ('node' in info && info.node.type !== "PAGE" && 'absoluteBoundingBox' in info.node && info.node.absoluteBoundingBox) {
    containerX = info.node.absoluteBoundingBox.x;
    containerY = info.node.absoluteBoundingBox.y;
  } else if ('nodes' in info && info.nodes && info.nodes[0] && 'absoluteBoundingBox' in info.nodes[0] && info.nodes[0].absoluteBoundingBox) {
    // If multiple selection, base the coordinates relative to the first selected node
    containerX = info.nodes[0].absoluteBoundingBox.x;
    containerY = info.nodes[0].absoluteBoundingBox.y;
  }

  const total = uniqueNodes.length;
  const exportedFonts = extractFontsFromNodes(uniqueNodes);
  figma.ui.postMessage({ type: "export-progress-init", total, fonts: exportedFonts });

  const batchSize = 10;
  
  for (let i = 0; i < total; i += batchSize) {
    const chunk = uniqueNodes.slice(i, i + batchSize);
    const chunkData = [];

    for (const node of chunk) {
      try {
        // Extract metadata properties
        const metadata: Record<string, any> = {
          id: node.id,
          name: node.name,
          type: node.type,
          width: node.width,
          height: node.height,
          x: node.x,
          y: node.y,
        };

        // Extract font information for text layers inside this node
        const nodeFonts = extractFontsFromNodes([node]);
        if (nodeFonts.length > 0) {
          metadata.fonts = nodeFonts.map(f => ({
            family: f.family,
            style: f.style
          }));
        }

        // Absolute Coordinates
        if ('absoluteBoundingBox' in node && node.absoluteBoundingBox) {
          metadata.absoluteBounds = {
            x: node.absoluteBoundingBox.x,
            y: node.absoluteBoundingBox.y,
            width: node.absoluteBoundingBox.width,
            height: node.absoluteBoundingBox.height
          };
          // Relative coordinates within the container
          metadata.relativePosition = {
            x: node.absoluteBoundingBox.x - containerX,
            y: node.absoluteBoundingBox.y - containerY
          };
        }

        // Component Description
        if (node.type === "COMPONENT") {
          metadata.description = node.description || "";
        }

        // Variant properties mapping
        let variantProperties: Record<string, string> = {};

        if (node.type === "INSTANCE") {
          // Extract instance properties
          if (node.componentProperties) {
            for (const [propName, propObj] of Object.entries(node.componentProperties)) {
              // Strip unique suffix if present (e.g. "Size#12:0" -> "Size")
              const cleanKey = propName.split("#")[0];
              variantProperties[cleanKey] = String(propObj.value);
            }
          }
          
          // Reference component info
          if (node.mainComponent) {
            metadata.mainComponent = {
              id: node.mainComponent.id,
              name: node.mainComponent.name,
              description: node.mainComponent.description || ""
            };
          }
        } else if (node.type === "COMPONENT" && node.parent && node.parent.type === "COMPONENT_SET") {
          // If component is a variant definition inside a variant group
          // Extract variant options by parsing variant name (Prop=Val, Prop2=Val2)
          node.name.split(",").forEach(part => {
            const parts = part.split("=");
            if (parts.length === 2) {
              const k = parts[0].trim();
              const v = parts[1].trim();
              variantProperties[k] = v;
            }
          });
          
          metadata.parentComponentSet = {
            id: node.parent.id,
            name: node.parent.name
          };
        }

        if (Object.keys(variantProperties).length > 0) {
          metadata.properties = variantProperties;
        }

        // Export and push layers
        if (options.splitEffects && hasEffects(node)) {
          console.log(`[Plugin Main] Node "${node.name}" has effects, performing split file export...`);
          logToUI(`Splitting effects layers for "${node.name}"...`);

          let contentClone: SceneNode | null = null;
          let effectsClone: SceneNode | null = null;

          // Export content layer (no effects)
          try {
            contentClone = node.clone();
            stripEffects(contentClone);
            const contentBytes = await contentClone.exportAsync({ format: "SVG" });
            chunkData.push({
              id: node.id,
              name: `${node.name}/content`,
              svgBytes: Array.from(contentBytes),
              metadata: metadata
            });
          } catch (err: any) {
            console.error(`Failed to export content layer for ${node.name}:`, err);
            logToUI(`Error exporting content layer for ${node.name}`, "error");
          } finally {
            if (contentClone) {
              try { contentClone.remove(); } catch (_) {}
            }
          }

          // Export effects layer (effects only)
          try {
            effectsClone = node.clone();

            // Find first visible shadow effect
            const shadow = findShadowEffect(node);
            let effectsBytes: Uint8Array;

            if (shadow) {
              // Scenario B: Recolor vector paths to solid shadow color
              detachInstancesAndRecolor(effectsClone, { r: shadow.color.r, g: shadow.color.g, b: shadow.color.b });

              // Strip all existing effects in the clone
              stripEffects(effectsClone);

              // Apply simple layer blur and set opacity
              if ('effects' in effectsClone) {
                (effectsClone as any).effects = [{
                  type: "LAYER_BLUR",
                  radius: shadow.radius,
                  visible: true
                }];
              }
              if ('opacity' in effectsClone) {
                (effectsClone as any).opacity = shadow.color.a;
              }

              // Offset the layer position
              effectsClone.x += shadow.offset.x;
              effectsClone.y += shadow.offset.y;

              const rawEffectsBytes = await effectsClone.exportAsync({ format: "SVG" });
              effectsBytes = rawEffectsBytes;
            } else {
              // Fallback to Scenario A if no shadow is found
              const rawEffectsBytes = await effectsClone.exportAsync({ format: "SVG" });
              const rawSvgStr = uint8ArrayToString(rawEffectsBytes);
              const modifiedSvgStr = hideSourceGraphicInSvg(rawSvgStr);
              effectsBytes = stringToUint8Array(modifiedSvgStr);
            }

            const copyMetadata = Object.assign({}, metadata, {
              isEffectsLayer: true,
              name: `${node.name}_effects`
            });
            chunkData.push({
              id: `${node.id}_effects`,
              name: `${node.name}/effects`,
              svgBytes: Array.from(effectsBytes),
              metadata: copyMetadata
            });
          } catch (err: any) {
            console.error(`Failed to export effects layer for ${node.name}:`, err);
            logToUI(`Error exporting effects layer for ${node.name}`, "error");
          } finally {
            if (effectsClone) {
              try { effectsClone.remove(); } catch (_) {}
            }
          }
        } else {
          // Normal export
          const svgBytes = await node.exportAsync({ format: "SVG" });
          chunkData.push({
            id: node.id,
            name: node.name,
            svgBytes: Array.from(svgBytes),
            metadata: metadata
          });
        }
      } catch (err: any) {
        console.error(`Failed to export node ${node.name} (${node.id}):`, err);
        // Continue exporting other elements even if one fails
      }
    }

    // Send the chunk to the UI thread
    figma.ui.postMessage({
      type: "export-progress-chunk",
      processedCount: Math.min(i + batchSize, total),
      data: chunkData
    });

    // Brief yield to keep Figma interface responsive
    await delay(20);
  }

  // Complete
  figma.ui.postMessage({ type: "export-complete" });
}

/**
 * Extracts unique FontNames from a TextNode, handling remote instance children safely
 */
function getFontsFromTextNode(node: TextNode): FontName[] {
  try {
    // 1. Try to use getStyledTextSegments (standard, high performance, does not crash)
    if (typeof node.getStyledTextSegments === "function") {
      const segments = node.getStyledTextSegments(["fontName"]);
      const fonts: FontName[] = [];
      const seen = new Set<string>();
      for (const segment of segments) {
        const font = segment.fontName;
        if (font) {
          const key = `${font.family}-${font.style}`;
          if (!seen.has(key)) {
            seen.add(key);
            fonts.push(font);
          }
        }
      }
      return fonts;
    }
  } catch (err) {
    // This can happen if the text node is inside a remote component instance
    console.warn(`Failed to read styled text segments for ${node.name}:`, err);
  }

  // 2. Fallback to reading the fontName property directly
  try {
    if (node.fontName !== figma.mixed) {
      return node.fontName ? [node.fontName as FontName] : [];
    }
  } catch (err) {
    console.warn(`Failed to read direct fontName for ${node.name}:`, err);
  }

  // 3. Fallback to range reading (only for character 0 to 1) to avoid heavy loops
  try {
    if (node.characters.length > 0) {
      const font = node.getRangeFontName(0, 1);
      if (font && font !== figma.mixed) {
        return [font as FontName];
      }
    }
  } catch (err) {
    console.warn(`Failed to read range font name for ${node.name}:`, err);
  }

  return [];
}

/**
 * Traverses roots recursively to identify all unique fonts used in TextNodes, ignoring errors gracefully
 */
function extractFontsFromNodes(roots: readonly (SceneNode | PageNode)[]): FontName[] {
  const uniqueFonts = new Map<string, FontName>();
  
  function traverse(node: SceneNode | PageNode) {
    try {
      if (node.type === "TEXT") {
        const textNode = node as TextNode;
        const fonts = getFontsFromTextNode(textNode);
        fonts.forEach(font => {
          const key = `${font.family}-${font.style}`;
          uniqueFonts.set(key, font);
        });
      }
    } catch (err) {
      console.warn(`Failed to process fonts for node ${node.name}:`, err);
    }
    
    if ('children' in node) {
      try {
        for (const child of node.children) {
          traverse(child);
        }
      } catch (err) {
        console.warn(`Failed to traverse children of node ${node.name}:`, err);
      }
    }
  }
  
  roots.forEach(root => {
    try {
      traverse(root);
    } catch (err) {
      console.warn(`Failed to traverse root node:`, err);
    }
  });
  
  return Array.from(uniqueFonts.values());
}

/**
 * Sends a message log to the UI's visual debug console.
 */
function logToUI(message: string, level: 'info' | 'warn' | 'error' = 'info') {
  try {
    figma.ui.postMessage({ type: "sandbox-log", message, level });
  } catch (err) {
    console.error("Failed to send log to UI:", err);
  }
}

/**
 * Checks if a node or any of its children have active visual effects (shadows or blurs)
 */
function hasEffects(node: SceneNode): boolean {
  if ('effects' in node && Array.isArray(node.effects) && node.effects.length > 0) {
    return true;
  }
  if ('children' in node) {
    for (const child of node.children) {
      if (hasEffects(child)) return true;
    }
  }
  return false;
}

/**
 * Recursively strips all effects from a node and its children
 */
function stripEffects(node: SceneNode) {
  try {
    if ('effects' in node) {
      node.effects = [];
    }
  } catch (_) {}
  if ('children' in node) {
    try {
      node.children.forEach(stripEffects);
    } catch (_) {}
  }
}

/**
 * Finds the first visible shadow effect (DROP_SHADOW or INNER_SHADOW) in the node or its children.
 */
function findShadowEffect(node: SceneNode): DropShadowEffect | InnerShadowEffect | null {
  if ('effects' in node && Array.isArray(node.effects)) {
    for (const effect of node.effects) {
      if (effect.visible && (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW")) {
        return effect as DropShadowEffect | InnerShadowEffect;
      }
    }
  }
  if ('children' in node) {
    for (const child of node.children) {
      const effect = findShadowEffect(child);
      if (effect) return effect;
    }
  }
  return null;
}

/**
 * Recursively detaches instances and recolors all vector/text shapes to a single solid color.
 */
function detachInstancesAndRecolor(node: SceneNode, color: RGB) {
  let workingNode = node;
  if (workingNode.type === "INSTANCE") {
    try {
      workingNode = (workingNode as InstanceNode).detachInstance();
    } catch (err) {
      console.warn("Failed to detach instance:", err);
    }
  }

  // Recolor fills only if the node originally had visible fills
  if ('fills' in workingNode && Array.isArray(workingNode.fills)) {
    const hasVisibleFill = workingNode.fills.some(paint => paint.visible !== false);
    if (hasVisibleFill) {
      try {
        workingNode.fills = [{ type: 'SOLID', color: color }];
      } catch (err) {
        console.warn(`Failed to set fills on node ${workingNode.name}:`, err);
      }
    }
  }

  // Recolor strokes only if the node originally had visible strokes
  if ('strokes' in workingNode && Array.isArray(workingNode.strokes)) {
    const hasVisibleStroke = workingNode.strokes.some(paint => paint.visible !== false);
    if (hasVisibleStroke) {
      try {
        workingNode.strokes = [{ type: 'SOLID', color: color }];
      } catch (err) {
        console.warn(`Failed to set strokes on node ${workingNode.name}:`, err);
      }
    }
  }

  // Recolor children recursively
  if ('children' in workingNode) {
    const children = [...workingNode.children];
    for (const child of children) {
      detachInstancesAndRecolor(child, color);
    }
  }
}

/**
 * Modifies the SVG code to make the SourceGraphic inside filters transparent.
 * This preserves full drop shadow strength while hiding the fills/strokes.
 */
function hideSourceGraphicInSvg(svgStr: string): string {
  const pattern1 = /<feBlend\s+([^>]*?)in="SourceGraphic"\s+([^>]*?)in2="([^"]+)"\s+([^>]*?)result="shape"\s*\/?>/gi;
  let result = svgStr.replace(pattern1, (match, p1, p2, in2Val, p3) => {
    return `<feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0   0 0 0 0 0   0 0 0 0 0  0 0 0 0 0" result="transparentSourceGraphic"/>\n` +
           `    <feBlend ${p1}in="transparentSourceGraphic" ${p2}in2="${in2Val}" ${p3}result="shape"/>`;
  });

  const pattern2 = /<feBlend\s+([^>]*?)in2="([^"]+)"\s+([^>]*?)in="SourceGraphic"\s+([^>]*?)result="shape"\s*\/?>/gi;
  result = result.replace(pattern2, (match, p1, in2Val, p2, p3) => {
    return `<feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0   0 0 0 0 0   0 0 0 0 0  0 0 0 0 0" result="transparentSourceGraphic"/>\n` +
           `    <feBlend ${p1}in2="${in2Val}" ${p2}in="transparentSourceGraphic" ${p3}result="shape"/>`;
  });

  return result;
}

/**
 * Safely converts a Uint8Array to a string representation
 */
function uint8ArrayToString(arr: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder().decode(arr);
  }
  let str = "";
  const chunk = 8192;
  for (let i = 0; i < arr.length; i += chunk) {
    str += String.fromCharCode.apply(null, Array.from(arr.subarray(i, i + chunk)));
  }
  return str;
}

/**
 * Safely converts a string to a Uint8Array
 */
function stringToUint8Array(str: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(str);
  }
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    arr[i] = str.charCodeAt(i) & 0xff;
  }
  return arr;
}
