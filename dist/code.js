"use strict";

// src/code.ts
console.log("[Plugin Main] Code sandbox starting...");
figma.showUI(__html__, { width: 360, height: 720, title: "Ace Figma Exporter" });
figma.on("selectionchange", () => {
  console.log("[Plugin Main] Canvas selectionchange event fired");
  logToUI("Canvas selectionchange event fired");
  sendSelectionStatus();
});
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
function getSelectedContainerInfo() {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    return {
      node: figma.currentPage,
      name: `Current Page (${figma.currentPage.name})`,
      type: "PAGE"
    };
  } else if (selection.length === 1) {
    const node = selection[0];
    return {
      node,
      name: `${node.name}`,
      type: node.type
    };
  } else {
    return {
      nodes: selection,
      name: `${selection.length} layers selected`,
      type: "MULTIPLE"
    };
  }
}
function sendSelectionStatus() {
  console.log("[Plugin Main] sendSelectionStatus() triggered");
  logToUI("Calculating selection status...");
  try {
    const info = getSelectedContainerInfo();
    const typeStr = "node" in info ? info.node.type : "MULTIPLE";
    console.log("[Plugin Main] Container info parsed:", { name: info.name, type: typeStr });
    logToUI(`Selected Container: "${info.name}" (Type: ${typeStr})`);
    let componentCount = 0;
    let directCount = 0;
    let frameCount = 0;
    const roots = "node" in info ? [info.node] : info.nodes || [];
    console.log("[Plugin Main] Roots array length:", roots.length);
    roots.forEach((root) => {
      try {
        if ("children" in root && root.type !== "PAGE") {
          directCount += root.children.length;
        } else if (root.type === "PAGE") {
          directCount += root.children.length;
        } else {
          directCount += 1;
        }
      } catch (_) {
      }
      function traverse(node) {
        try {
          if (node.type === "COMPONENT" || node.type === "INSTANCE") {
            componentCount++;
            return;
          }
          if (node.type === "FRAME" || node.type === "GROUP" || node.type === "COMPONENT_SET") {
            frameCount++;
          }
          if ("children" in node) {
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
          for (const child of root.children)
            traverse(child);
        } else {
          traverse(root);
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
      typeString: "node" in info ? info.node.type : "MULTIPLE",
      counts: { components: componentCount, direct: directCount, frames: frameCount }
    };
    console.log("[Plugin Main] Posting message to UI:", payload);
    logToUI("Sending selection-status payload to UI");
    figma.ui.postMessage(payload);
  } catch (err) {
    console.error("[Plugin Main] sendSelectionStatus crashed:", err);
    logToUI(`sendSelectionStatus crashed: ${err.message || err}`, "error");
    figma.ui.postMessage({
      type: "selection-status",
      name: "Selection error \u2014 try re-selecting",
      typeString: "PAGE",
      counts: { components: 0, direct: 0, frames: 0 }
    });
  }
}
var delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function runExport(options) {
  const info = getSelectedContainerInfo();
  const roots = "node" in info ? [info.node] : info.nodes || [];
  if (roots.length === 0) {
    figma.ui.postMessage({ type: "export-error", message: "No selection found." });
    return;
  }
  const targetNodes = [];
  roots.forEach((root) => {
    if (options.target === "direct") {
      if ("children" in root && root.type !== "PAGE") {
        root.children.forEach((child) => targetNodes.push(child));
      } else if (root.type === "PAGE") {
        root.children.forEach((child) => targetNodes.push(child));
      } else {
        targetNodes.push(root);
      }
    } else {
      let traverse2 = function(node) {
        const isComponent = node.type === "COMPONENT" || node.type === "INSTANCE";
        const isFrameOrGroup = node.type === "FRAME" || node.type === "GROUP" || node.type === "COMPONENT_SET";
        if (options.target === "components") {
          if (isComponent) {
            targetNodes.push(node);
            return;
          }
        } else if (options.target === "frames") {
          if (isComponent || isFrameOrGroup) {
            targetNodes.push(node);
            if (node.type === "COMPONENT_SET") {
              for (const child of node.children) {
                traverse2(child);
              }
              return;
            }
            if (node.type === "INSTANCE")
              return;
          }
        }
        if ("children" in node) {
          for (const child of node.children) {
            traverse2(child);
          }
        }
      };
      var traverse = traverse2;
      if (root.type === "PAGE") {
        for (const child of root.children) {
          traverse2(child);
        }
      } else {
        traverse2(root);
      }
    }
  });
  const uniqueNodes = Array.from(new Set(targetNodes));
  if (uniqueNodes.length === 0) {
    figma.ui.postMessage({ type: "export-error", message: "No layers found matching the selected filter." });
    return;
  }
  let containerX = 0;
  let containerY = 0;
  if ("node" in info && info.node.type !== "PAGE" && "absoluteBoundingBox" in info.node && info.node.absoluteBoundingBox) {
    containerX = info.node.absoluteBoundingBox.x;
    containerY = info.node.absoluteBoundingBox.y;
  } else if ("nodes" in info && info.nodes && info.nodes[0] && "absoluteBoundingBox" in info.nodes[0] && info.nodes[0].absoluteBoundingBox) {
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
        const metadata = {
          id: node.id,
          name: node.name,
          type: node.type,
          width: node.width,
          height: node.height,
          x: node.x,
          y: node.y
        };
        const nodeFonts = extractFontsFromNodes([node]);
        if (nodeFonts.length > 0) {
          metadata.fonts = nodeFonts.map((f) => ({
            family: f.family,
            style: f.style
          }));
        }
        if ("absoluteBoundingBox" in node && node.absoluteBoundingBox) {
          metadata.absoluteBounds = {
            x: node.absoluteBoundingBox.x,
            y: node.absoluteBoundingBox.y,
            width: node.absoluteBoundingBox.width,
            height: node.absoluteBoundingBox.height
          };
          metadata.relativePosition = {
            x: node.absoluteBoundingBox.x - containerX,
            y: node.absoluteBoundingBox.y - containerY
          };
        }
        if (node.type === "COMPONENT") {
          metadata.description = node.description || "";
        }
        let variantProperties = {};
        if (node.type === "INSTANCE") {
          if (node.componentProperties) {
            for (const [propName, propObj] of Object.entries(node.componentProperties)) {
              const cleanKey = propName.split("#")[0];
              variantProperties[cleanKey] = String(propObj.value);
            }
          }
          if (node.mainComponent) {
            metadata.mainComponent = {
              id: node.mainComponent.id,
              name: node.mainComponent.name,
              description: node.mainComponent.description || ""
            };
          }
        } else if (node.type === "COMPONENT" && node.parent && node.parent.type === "COMPONENT_SET") {
          node.name.split(",").forEach((part) => {
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
        const nodeEffects = collectEffects(node);
        if (nodeEffects.length > 0) {
          metadata.effects = nodeEffects;
        }
        const { fills, childFills } = collectFills(node);
        if (fills.length > 0) {
          metadata.fills = fills;
        }
        if (childFills.length > 0) {
          metadata.childFills = childFills;
        }
        if (options.splitEffects && hasEffects(node)) {
          console.log(`[Plugin Main] Node "${node.name}" has effects, performing split file export...`);
          logToUI(`Splitting effects layers for "${node.name}"...`);
          let contentClone = null;
          let effectsClone = null;
          try {
            contentClone = node.clone();
            stripEffects(contentClone);
            const contentBytes = await contentClone.exportAsync({ format: "SVG" });
            chunkData.push({
              id: node.id,
              name: `${node.name}/content`,
              svgBytes: Array.from(contentBytes),
              metadata
            });
          } catch (err) {
            console.error(`Failed to export content layer for ${node.name}:`, err);
            logToUI(`Error exporting content layer for ${node.name}`, "error");
          } finally {
            if (contentClone) {
              try {
                contentClone.remove();
              } catch (_) {
              }
            }
          }
          try {
            effectsClone = node.clone();
            const shadow = findShadowEffect(node);
            let effectsBytes;
            if (shadow) {
              detachInstancesAndRecolor(effectsClone, { r: shadow.color.r, g: shadow.color.g, b: shadow.color.b });
              stripEffects(effectsClone);
              if ("effects" in effectsClone) {
                effectsClone.effects = [{
                  type: "LAYER_BLUR",
                  radius: shadow.radius,
                  visible: true
                }];
              }
              if ("opacity" in effectsClone) {
                effectsClone.opacity = shadow.color.a;
              }
              effectsClone.x += shadow.offset.x;
              effectsClone.y += shadow.offset.y;
              const rawEffectsBytes = await effectsClone.exportAsync({ format: "SVG" });
              effectsBytes = rawEffectsBytes;
            } else {
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
          } catch (err) {
            console.error(`Failed to export effects layer for ${node.name}:`, err);
            logToUI(`Error exporting effects layer for ${node.name}`, "error");
          } finally {
            if (effectsClone) {
              try {
                effectsClone.remove();
              } catch (_) {
              }
            }
          }
        } else {
          const svgBytes = await node.exportAsync({ format: "SVG" });
          chunkData.push({
            id: node.id,
            name: node.name,
            svgBytes: Array.from(svgBytes),
            metadata
          });
        }
      } catch (err) {
        console.error(`Failed to export node ${node.name} (${node.id}):`, err);
      }
    }
    figma.ui.postMessage({
      type: "export-progress-chunk",
      processedCount: Math.min(i + batchSize, total),
      data: chunkData
    });
    await delay(20);
  }
  figma.ui.postMessage({ type: "export-complete" });
}
function getFontsFromTextNode(node) {
  try {
    if (typeof node.getStyledTextSegments === "function") {
      const segments = node.getStyledTextSegments(["fontName"]);
      const fonts = [];
      const seen = /* @__PURE__ */ new Set();
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
    console.warn(`Failed to read styled text segments for ${node.name}:`, err);
  }
  try {
    if (node.fontName !== figma.mixed) {
      return node.fontName ? [node.fontName] : [];
    }
  } catch (err) {
    console.warn(`Failed to read direct fontName for ${node.name}:`, err);
  }
  try {
    if (node.characters.length > 0) {
      const font = node.getRangeFontName(0, 1);
      if (font && font !== figma.mixed) {
        return [font];
      }
    }
  } catch (err) {
    console.warn(`Failed to read range font name for ${node.name}:`, err);
  }
  return [];
}
function extractFontsFromNodes(roots) {
  const uniqueFonts = /* @__PURE__ */ new Map();
  function traverse(node) {
    try {
      if (node.type === "TEXT") {
        const textNode = node;
        const fonts = getFontsFromTextNode(textNode);
        fonts.forEach((font) => {
          const key = `${font.family}-${font.style}`;
          uniqueFonts.set(key, font);
        });
      }
    } catch (err) {
      console.warn(`Failed to process fonts for node ${node.name}:`, err);
    }
    if ("children" in node) {
      try {
        for (const child of node.children) {
          traverse(child);
        }
      } catch (err) {
        console.warn(`Failed to traverse children of node ${node.name}:`, err);
      }
    }
  }
  roots.forEach((root) => {
    try {
      traverse(root);
    } catch (err) {
      console.warn(`Failed to traverse root node:`, err);
    }
  });
  return Array.from(uniqueFonts.values());
}
function logToUI(message, level = "info") {
  try {
    figma.ui.postMessage({ type: "sandbox-log", message, level });
  } catch (err) {
    console.error("Failed to send log to UI:", err);
  }
}
function collectEffects(node) {
  const visibleEffects = [];
  function traverse(currNode) {
    if ("effects" in currNode && Array.isArray(currNode.effects)) {
      currNode.effects.forEach((eff) => {
        if (eff.visible !== false) {
          const baseEffect = {
            type: eff.type,
            visible: eff.visible,
            nodeId: currNode.id,
            nodeName: currNode.name
          };
          if (eff.type === "DROP_SHADOW" || eff.type === "INNER_SHADOW") {
            const shadow = eff;
            baseEffect.color = shadow.color;
            baseEffect.offset = shadow.offset;
            baseEffect.radius = shadow.radius;
            if ("spread" in shadow) {
              baseEffect.spread = shadow.spread;
            }
            baseEffect.blendMode = shadow.blendMode;
          } else if (eff.type === "LAYER_BLUR" || eff.type === "BACKGROUND_BLUR") {
            const blur = eff;
            baseEffect.radius = blur.radius;
          }
          visibleEffects.push(baseEffect);
        }
      });
    }
    if ("children" in currNode) {
      try {
        for (const child of currNode.children) {
          traverse(child);
        }
      } catch (_) {
      }
    }
  }
  traverse(node);
  return visibleEffects;
}
function collectFills(node) {
  const fills = [];
  const childFills = [];
  if ("fills" in node && Array.isArray(node.fills)) {
    node.fills.forEach((paint) => {
      if (paint.visible !== false) {
        const baseFill = {
          type: paint.type,
          opacity: paint.opacity !== void 0 ? paint.opacity : 1
        };
        if (paint.type === "SOLID") {
          baseFill.color = paint.color;
        }
        fills.push(baseFill);
      }
    });
  }
  function traverse(currNode) {
    if ("fills" in currNode && Array.isArray(currNode.fills)) {
      currNode.fills.forEach((paint) => {
        if (paint.visible !== false) {
          const baseFill = {
            type: paint.type,
            opacity: paint.opacity !== void 0 ? paint.opacity : 1,
            nodeId: currNode.id,
            nodeName: currNode.name
          };
          if (paint.type === "SOLID") {
            baseFill.color = paint.color;
          }
          childFills.push(baseFill);
        }
      });
    }
    if ("children" in currNode) {
      try {
        for (const child of currNode.children) {
          traverse(child);
        }
      } catch (_) {
      }
    }
  }
  if ("children" in node) {
    try {
      for (const child of node.children) {
        traverse(child);
      }
    } catch (_) {
    }
  }
  return { fills, childFills };
}
function hasEffects(node) {
  if ("effects" in node && Array.isArray(node.effects) && node.effects.length > 0) {
    return true;
  }
  if ("children" in node) {
    for (const child of node.children) {
      if (hasEffects(child))
        return true;
    }
  }
  return false;
}
function stripEffects(node) {
  try {
    if ("effects" in node) {
      node.effects = [];
    }
  } catch (_) {
  }
  if ("children" in node) {
    try {
      node.children.forEach(stripEffects);
    } catch (_) {
    }
  }
}
function findShadowEffect(node) {
  if ("effects" in node && Array.isArray(node.effects)) {
    for (const effect of node.effects) {
      if (effect.visible && (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW")) {
        return effect;
      }
    }
  }
  if ("children" in node) {
    for (const child of node.children) {
      const effect = findShadowEffect(child);
      if (effect)
        return effect;
    }
  }
  return null;
}
function detachInstancesAndRecolor(node, color) {
  let workingNode = node;
  if (workingNode.type === "INSTANCE") {
    try {
      workingNode = workingNode.detachInstance();
    } catch (err) {
      console.warn("Failed to detach instance:", err);
    }
  }
  if ("fills" in workingNode && Array.isArray(workingNode.fills)) {
    const hasVisibleFill = workingNode.fills.some((paint) => paint.visible !== false);
    if (hasVisibleFill) {
      try {
        workingNode.fills = [{ type: "SOLID", color }];
      } catch (err) {
        console.warn(`Failed to set fills on node ${workingNode.name}:`, err);
      }
    }
  }
  if ("strokes" in workingNode && Array.isArray(workingNode.strokes)) {
    const hasVisibleStroke = workingNode.strokes.some((paint) => paint.visible !== false);
    if (hasVisibleStroke) {
      try {
        workingNode.strokes = [{ type: "SOLID", color }];
      } catch (err) {
        console.warn(`Failed to set strokes on node ${workingNode.name}:`, err);
      }
    }
  }
  if ("children" in workingNode) {
    const children = [...workingNode.children];
    for (const child of children) {
      detachInstancesAndRecolor(child, color);
    }
  }
}
function hideSourceGraphicInSvg(svgStr) {
  const pattern1 = /<feBlend\s+([^>]*?)in="SourceGraphic"\s+([^>]*?)in2="([^"]+)"\s+([^>]*?)result="shape"\s*\/?>/gi;
  let result = svgStr.replace(pattern1, (match, p1, p2, in2Val, p3) => {
    return `<feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0   0 0 0 0 0   0 0 0 0 0  0 0 0 0 0" result="transparentSourceGraphic"/>
    <feBlend ${p1}in="transparentSourceGraphic" ${p2}in2="${in2Val}" ${p3}result="shape"/>`;
  });
  const pattern2 = /<feBlend\s+([^>]*?)in2="([^"]+)"\s+([^>]*?)in="SourceGraphic"\s+([^>]*?)result="shape"\s*\/?>/gi;
  result = result.replace(pattern2, (match, p1, in2Val, p2, p3) => {
    return `<feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0   0 0 0 0 0   0 0 0 0 0  0 0 0 0 0" result="transparentSourceGraphic"/>
    <feBlend ${p1}in2="${in2Val}" ${p2}in="transparentSourceGraphic" ${p3}result="shape"/>`;
  });
  return result;
}
function uint8ArrayToString(arr) {
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
function stringToUint8Array(str) {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(str);
  }
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    arr[i] = str.charCodeAt(i) & 255;
  }
  return arr;
}
