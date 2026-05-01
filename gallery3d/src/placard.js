// Museum-style placard: a Canvas2D drawing of name + alt text + date +
// external-link icon, exported as a CanvasTexture suitable for a flat
// MeshBasicMaterial.

import * as THREE from 'three/webgpu';

export const PLACARD_PX_W = 720;
export const PLACARD_PX_H = 360;

function wrapTextLines(ctx, text, maxWidth, maxLines) {
  if (!text) return [];
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const test = cur ? cur + ' ' + words[i] : words[i];
    if (ctx.measureText(test).width <= maxWidth) {
      cur = test;
    } else {
      if (cur) lines.push(cur);
      cur = words[i];
      if (lines.length >= maxLines) {
        // Anything left → ellipsize the last line
        let last = lines[maxLines - 1];
        let withEllipsis = last + '…';
        while (ctx.measureText(withEllipsis).width > maxWidth && last.length > 1) {
          last = last.slice(0, -1);
          withEllipsis = last + '…';
        }
        lines[maxLines - 1] = withEllipsis;
        return lines;
      }
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines;
}

function ellipsizeLine(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 0 && ctx.measureText(s + '…').width > maxWidth) {
    s = s.slice(0, -1);
  }
  return s + '…';
}

// Lucide "square-arrow-out-up-right" — same icon the 2D gallery uses.
// Drawn via Path2D from the SVG path data on a 24×24 viewBox.
function drawExternalLinkIcon(ctx, x, y, size, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const p = new Path2D(
    'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6 ' +
    'M15 3h6v6 ' +
    'M10 14L21 3'
  );
  ctx.stroke(p);
  ctx.restore();
}

export function makePlacardTexture(item) {
  const canvas = document.createElement('canvas');
  canvas.width = PLACARD_PX_W;
  canvas.height = PLACARD_PX_H;
  const ctx = canvas.getContext('2d');

  // Card background
  ctx.fillStyle = '#eeeeee';
  ctx.fillRect(0, 0, PLACARD_PX_W, PLACARD_PX_H);

  const padX = 36;
  const padY = 32;
  const innerW = PLACARD_PX_W - padX * 2;
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#111';

  // Display name (bold, top) — single line, ellipsised if too long
  ctx.font = '700 48px Inter, system-ui, -apple-system, sans-serif';
  ctx.fillText(ellipsizeLine(ctx, item.displayName, innerW), padX, padY);

  // Body: alt text (preferred) or post text, cropped to 3 lines
  ctx.font = '400 32px Inter, system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#444';
  const body =
    (item.alt && item.alt.trim()) ||
    (item.postText && item.postText.trim()) ||
    'Untitled';
  const lines = wrapTextLines(ctx, body, innerW, 3);
  let by = padY + 70;
  for (const line of lines) {
    ctx.fillText(line, padX, by);
    by += 42;
  }

  // Footer divider
  const footerY = PLACARD_PX_H - padY - 40;
  ctx.fillStyle = '#e6e6e6';
  ctx.fillRect(padX, footerY, innerW, 1);

  // Date (left of footer)
  ctx.font = '500 28px Inter, system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#666';
  ctx.fillText(item.date, padX, footerY + 14);

  // External-link icon (right of footer)
  const ICON_SIZE = 28;
  drawExternalLinkIcon(ctx, PLACARD_PX_W - padX - ICON_SIZE, footerY + 8, ICON_SIZE, '#111');

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
