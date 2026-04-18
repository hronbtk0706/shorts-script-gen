import type { SubtitleStyle } from "../types";

const CANVAS_WIDTH = 1080;
const CANVAS_HEIGHT = 1920;
const FONT_FAMILY = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif';

const FONT_SIZE_MAP: Record<SubtitleStyle["font_size"], number> = {
  md: 64,
  lg: 88,
  xl: 112,
};

const EMOJI_FONT =
  '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const chars = [...text];
  const lines: string[] = [];
  let current = "";
  for (const ch of chars) {
    const test = current + ch;
    if (ctx.measureText(test).width > maxWidth && current.length > 0) {
      lines.push(current);
      current = ch;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

const DEFAULT_STYLE: SubtitleStyle = {
  primary_color: "#FFE600",
  outline_color: "#000000",
  font_size: "lg",
  emoji: "",
  background: "none",
  emphasis_keyword: "",
};

export type OverlayPosition = "top" | "bottom";

export function renderSubtitleCanvas(
  text: string,
  style: SubtitleStyle | undefined,
  position: OverlayPosition = "bottom",
): HTMLCanvasElement {
  const resolvedStyle: SubtitleStyle = style
    ? { ...DEFAULT_STYLE, ...style }
    : DEFAULT_STYLE;
  return renderInternal(text, resolvedStyle, position);
}

function renderInternal(
  text: string,
  style: SubtitleStyle,
  position: OverlayPosition,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  const fontSize = FONT_SIZE_MAP[style.font_size];
  const lineHeight = fontSize * 1.25;
  const maxTextWidth = CANVAS_WIDTH - 120;

  ctx.font = `900 ${fontSize}px ${FONT_FAMILY}`;
  const lines = wrapText(ctx, text, maxTextWidth);
  const emojiSize = Math.round(fontSize * 0.9);

  const totalTextHeight = lines.length * lineHeight;
  const emojiHeight = style.emoji ? emojiSize + 16 : 0;
  const blockHeight = totalTextHeight + emojiHeight;
  const blockTop =
    position === "top"
      ? 180
      : CANVAS_HEIGHT - blockHeight - 220;

  if (style.background === "dark") {
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    const padding = 40;
    const maxLineWidth = Math.max(
      ...lines.map((l) => ctx.measureText(l).width),
    );
    const boxWidth = maxLineWidth + padding * 2;
    const boxHeight = blockHeight + padding * 2;
    const boxX = (CANVAS_WIDTH - boxWidth) / 2;
    const boxY = blockTop - padding;
    roundRect(ctx, boxX, boxY, boxWidth, boxHeight, 24);
    ctx.fill();
  } else if (style.background === "highlight") {
    const padding = 30;
    for (let i = 0; i < lines.length; i++) {
      const lineWidth = ctx.measureText(lines[i]).width;
      const boxWidth = lineWidth + padding * 2;
      const boxX = (CANVAS_WIDTH - boxWidth) / 2;
      const boxY = blockTop + emojiHeight + i * lineHeight - 8;
      const boxHeight = lineHeight + 16;
      ctx.fillStyle = style.primary_color;
      roundRect(ctx, boxX, boxY, boxWidth, boxHeight, 12);
      ctx.fill();
    }
  }

  if (style.emoji) {
    ctx.font = `${emojiSize}px ${EMOJI_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#FFFFFF";
    ctx.fillText(style.emoji, CANVAS_WIDTH / 2, blockTop);
  }

  ctx.font = `900 ${fontSize}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
  ctx.shadowBlur = 12;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 6;

  const outlineWidth = Math.max(6, Math.round(fontSize * 0.12));
  const textFillColor =
    style.background === "highlight" ? "#111111" : style.primary_color;
  const outlineColor =
    style.background === "highlight" ? style.primary_color : style.outline_color;

  for (let i = 0; i < lines.length; i++) {
    const y = blockTop + emojiHeight + i * lineHeight;
    const line = lines[i];
    const centerX = CANVAS_WIDTH / 2;

    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = outlineWidth;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.strokeText(line, centerX, y);

    ctx.fillStyle = textFillColor;
    ctx.fillText(line, centerX, y);

    if (
      style.emphasis_keyword &&
      line.includes(style.emphasis_keyword) &&
      style.background !== "highlight"
    ) {
      drawHighlightedKeyword(
        ctx,
        line,
        style.emphasis_keyword,
        centerX,
        y,
        outlineColor,
        outlineWidth,
        style.primary_color,
      );
    }
  }

  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  return canvas;
}

function drawHighlightedKeyword(
  ctx: CanvasRenderingContext2D,
  line: string,
  keyword: string,
  centerX: number,
  y: number,
  outlineColor: string,
  outlineWidth: number,
  _baseColor: string,
) {
  const idx = line.indexOf(keyword);
  if (idx === -1) return;

  const totalWidth = ctx.measureText(line).width;
  const startX = centerX - totalWidth / 2;
  const prefixWidth = ctx.measureText(line.slice(0, idx)).width;
  const keywordWidth = ctx.measureText(keyword).width;

  ctx.textAlign = "left";
  const keywordX = startX + prefixWidth;

  ctx.strokeStyle = outlineColor;
  ctx.lineWidth = outlineWidth;
  ctx.strokeText(keyword, keywordX, y);

  const gradient = ctx.createLinearGradient(
    keywordX,
    y,
    keywordX + keywordWidth,
    y,
  );
  gradient.addColorStop(0, "#FFEE00");
  gradient.addColorStop(1, "#FF6B00");
  ctx.fillStyle = gradient;
  ctx.fillText(keyword, keywordX, y);

  ctx.textAlign = "center";
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function canvasToBase64Png(canvas: HTMLCanvasElement): string {
  const dataUrl = canvas.toDataURL("image/png");
  return dataUrl.replace(/^data:image\/png;base64,/, "");
}

const CAPTION_Y_RATIO = 0.70;
const CAPTION_MAX_LINES = 2;
const CAPTION_INITIAL_FONT = 56;
const CAPTION_MIN_FONT = 36;

export function renderCaptionCanvas(text: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  const maxTextWidth = CANVAS_WIDTH - 120;

  let fontSize = CAPTION_INITIAL_FONT;
  let lines: string[] = [];
  while (fontSize >= CAPTION_MIN_FONT) {
    ctx.font = `800 ${fontSize}px ${FONT_FAMILY}`;
    lines = wrapText(ctx, text, maxTextWidth);
    if (lines.length <= CAPTION_MAX_LINES) break;
    fontSize -= 4;
  }
  if (lines.length > CAPTION_MAX_LINES) {
    lines = lines.slice(0, CAPTION_MAX_LINES);
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.slice(0, Math.max(0, last.length - 1)) + "…";
  }

  ctx.font = `800 ${fontSize}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  const lineHeight = fontSize * 1.3;
  const blockTop = Math.round(CANVAS_HEIGHT * CAPTION_Y_RATIO);

  ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 4;

  const outlineWidth = Math.max(4, Math.round(fontSize * 0.12));
  for (let i = 0; i < lines.length; i++) {
    const y = blockTop + i * lineHeight;
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = outlineWidth;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.strokeText(lines[i], CANVAS_WIDTH / 2, y);

    ctx.fillStyle = "#FFFFFF";
    ctx.fillText(lines[i], CANVAS_WIDTH / 2, y);
  }
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  return canvas;
}
