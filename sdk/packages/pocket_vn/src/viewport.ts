import type { CharacterPosition } from "./types.ts";

export interface NovelDisplayInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface NovelViewportLayout {
  readonly insetL: number;
  readonly insetT: number;
  readonly width: number;
  readonly height: number;
  readonly artScale: number;
  readonly titleMenuWidth: number;
  readonly titleMenuLeft: number;
  readonly titleMenuTop: number;
  readonly titleMenuBottom: number;
  readonly titleMenuMaxHeight: number;
  readonly dialogueWidth: number;
  readonly dialogueLeft: number;
  readonly dialogueHeight: number;
  readonly dialogueBottom: number;
  readonly dialogueTextWidth: number;
  readonly choiceWidth: number;
  readonly choiceLeft: number;
  readonly choiceBottom: number;
  readonly choiceMaxHeight: number;
  readonly inputWidth: number;
  readonly inputLeft: number;
  readonly inputTop: number;
  readonly inputBottom: number;
  readonly inputHeight: number;
  readonly panelWidth: number;
  readonly panelLeft: number;
  readonly panelTop: number;
  readonly panelBottom: number;
  readonly panelHeight: number;
  readonly endingWidth: number;
  readonly endingLeft: number;
  readonly endingTop: number;
  readonly endingBottom: number;
  readonly endingHeight: number;
  readonly toolbarWidth: number;
  readonly toolbarLeft: number;
  readonly toolbarButtonWidth: number;
  readonly toolbarHeight: number;
}

export interface NovelImageDimensions {
  readonly width: number;
  readonly height: number;
}

export interface NovelImageBounds {
  readonly insetL: number;
  readonly insetT: number;
  readonly width: number;
  readonly height: number;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function centeredLeft(containerWidth: number, width: number): number {
  return Math.max(0, (containerWidth - width) / 2);
}

/**
 * Adapt the VN's authored 360×640 scene coordinates to the current safe guest
 * viewport. Stage art remains proportional while interactive text and panels
 * keep natural font/control sizes and use bounded readable line widths.
 */
export function createNovelViewportLayout(
  viewport: { readonly width: number; readonly height: number; readonly keyboardInset?: number },
  safe: NovelDisplayInsets,
): NovelViewportLayout {
  const width = Math.max(1, Number.isFinite(viewport.width) ? viewport.width : 360);
  const height = Math.max(1, Number.isFinite(viewport.height) ? viewport.height : 640);
  const insetL = Math.min(nonNegative(safe.left), width - 1);
  const insetR = Math.min(nonNegative(safe.right), width - insetL - 1);
  const insetT = Math.min(nonNegative(safe.top), height - 1);
  const insetB = Math.min(nonNegative(safe.bottom), height - insetT - 1);
  const availableWidth = Math.max(1, width - insetL - insetR);
  // Native hosts report keyboardInset only when the guest canvas itself was
  // not already resized, so this subtraction does not double-count a resize.
  const keyboardInset = Math.min(nonNegative(viewport.keyboardInset ?? 0), Math.max(0, height - insetT - insetB - 1));
  const availableHeight = Math.max(1, height - insetT - insetB - keyboardInset);
  const artScale = Math.max(0.1, Math.min(1.35, availableWidth / 360, availableHeight / 640));
  const toolbarHeight = Math.min(48, Math.max(40, availableHeight * 0.14));

  const wideTitle = availableWidth >= 640;
  const titleMenuWidth = wideTitle
    ? Math.min(360, Math.max(300, availableWidth * 0.42))
    : Math.max(1, availableWidth - 32);
  const titleMenuLeft = wideTitle
    ? Math.min(48, Math.max(0, availableWidth - titleMenuWidth))
    : centeredLeft(availableWidth, titleMenuWidth);
  const titleMenuBottom = Math.min(36, Math.max(16, availableHeight * 0.05));
  const titleMenuMaxHeight = Math.max(1, Math.min(720, availableHeight - 32, availableHeight * 0.78));
  const titleMenuTop = Math.max(0, availableHeight - titleMenuBottom - titleMenuMaxHeight);

  const dialogueWidth = Math.min(960, Math.max(1, availableWidth - 24));
  const dialogueLeft = centeredLeft(availableWidth, dialogueWidth);
  const dialogueBottom = Math.min(Math.max(0, availableHeight - toolbarHeight - 1), toolbarHeight + 12);
  const desiredDialogueHeight = Math.min(164, Math.max(120, availableHeight * 0.32));
  const dialogueHeight = Math.max(1, Math.min(desiredDialogueHeight, availableHeight - dialogueBottom - toolbarHeight));

  const choiceWidth = Math.min(840, Math.max(1, availableWidth - 24));
  const choiceLeft = centeredLeft(availableWidth, choiceWidth);
  const choiceBottom = Math.min(
    Math.max(0, availableHeight - toolbarHeight - 1),
    Math.max(dialogueBottom + 8, toolbarHeight + 12),
  );
  const choiceMaxHeight = Math.max(1, availableHeight - choiceBottom - toolbarHeight - 8);

  const inputWidth = Math.min(720, Math.max(1, availableWidth - 24));
  const inputLeft = centeredLeft(availableWidth, inputWidth);
  const inputTop = Math.min(88, Math.max(24, availableHeight * 0.12));
  const inputBottom = Math.max(toolbarHeight + 10, 52);
  const inputHeight = Math.max(1, availableHeight - inputTop - inputBottom);

  const panelMargin = Math.min(24, Math.max(16, availableWidth * 0.06));
  const panelWidth = Math.min(640, Math.max(1, availableWidth - panelMargin * 2));
  const panelLeft = centeredLeft(availableWidth, panelWidth);
  const panelTop = Math.min(30, Math.max(8, availableHeight * 0.045));
  const panelBottom = panelTop;
  const panelHeight = Math.max(1, availableHeight - panelTop - panelBottom);

  const endingWidth = Math.min(840, Math.max(1, availableWidth - 24));
  const endingLeft = centeredLeft(availableWidth, endingWidth);
  const endingTop = Math.min(110, Math.max(8, availableHeight * 0.12));
  const endingBottom = Math.max(toolbarHeight + 10, Math.min(70, availableHeight * 0.12));
  const endingHeight = Math.max(1, availableHeight - endingTop - endingBottom);

  const toolbarWidth = Math.min(520, Math.max(1, availableWidth - 24));
  const toolbarLeft = centeredLeft(availableWidth, toolbarWidth);
  const toolbarButtonWidth = Math.max(1, (toolbarWidth - 24) / 4);

  return {
    insetL,
    insetT,
    width: availableWidth,
    height: availableHeight,
    artScale,
    titleMenuWidth,
    titleMenuLeft,
    titleMenuTop,
    titleMenuBottom,
    titleMenuMaxHeight,
    dialogueWidth,
    dialogueLeft,
    dialogueHeight,
    dialogueBottom,
    // A wide window should give the box more room while keeping paragraphs at
    // a comfortable line length instead of stretching one line across a TV.
    dialogueTextWidth: Math.max(1, Math.min(720, dialogueWidth - 48)),
    choiceWidth,
    choiceLeft,
    choiceBottom,
    choiceMaxHeight,
    inputWidth,
    inputLeft,
    inputTop,
    inputBottom,
    inputHeight,
    panelWidth,
    panelLeft,
    panelTop,
    panelBottom,
    panelHeight,
    endingWidth,
    endingLeft,
    endingTop,
    endingBottom,
    endingHeight,
    toolbarWidth,
    toolbarLeft,
    toolbarButtonWidth,
    toolbarHeight,
  };
}

export interface NovelCharacterBounds {
  readonly insetL: number;
  readonly insetT: number;
  readonly width: number;
  readonly height: number;
}

/** Preserve authored phone coordinates while giving wide scenes room to spread. */
export function novelCharacterBounds(
  position: CharacterPosition,
  authored: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  viewportWidth: number,
  artScale: number,
): NovelCharacterBounds {
  const width = authored.width * artScale;
  const height = authored.height * artScale;
  let insetL: number;
  let insetT: number;
  if (typeof position === "string") {
    insetL = position === "left"
      ? authored.x * artScale
      : position === "right"
        ? viewportWidth - width + 24 * artScale
        : (viewportWidth - width) / 2;
    insetT = authored.y * artScale;
  } else {
    insetL = (viewportWidth - 360 * artScale) / 2 + position.x * artScale;
    insetT = position.y * artScale;
  }
  return { insetL, insetT, width, height };
}

function validDimensions(dimensions: NovelImageDimensions | undefined): dimensions is NovelImageDimensions {
  return dimensions !== undefined && Number.isFinite(dimensions.width) && Number.isFinite(dimensions.height) &&
    dimensions.width > 0 && dimensions.height > 0;
}

/** Crop a declared image proportionally to cover a target rectangle. */
export function novelImageCoverBounds(
  width: number,
  height: number,
  dimensions?: NovelImageDimensions,
): NovelImageBounds {
  const targetWidth = Math.max(1, Number.isFinite(width) ? width : 1);
  const targetHeight = Math.max(1, Number.isFinite(height) ? height : 1);
  if (!validDimensions(dimensions)) return { insetL: 0, insetT: 0, width: targetWidth, height: targetHeight };
  const scale = Math.max(targetWidth / dimensions.width, targetHeight / dimensions.height);
  const imageWidth = dimensions.width * scale;
  const imageHeight = dimensions.height * scale;
  return {
    insetL: (targetWidth - imageWidth) / 2,
    insetT: (targetHeight - imageHeight) / 2,
    width: imageWidth,
    height: imageHeight,
  };
}

/** Fit a declared image proportionally inside an authored character frame. */
export function novelImageContainBounds(
  width: number,
  height: number,
  dimensions?: NovelImageDimensions,
): NovelImageBounds {
  const targetWidth = Math.max(1, Number.isFinite(width) ? width : 1);
  const targetHeight = Math.max(1, Number.isFinite(height) ? height : 1);
  if (!validDimensions(dimensions)) return { insetL: 0, insetT: 0, width: targetWidth, height: targetHeight };
  const scale = Math.min(targetWidth / dimensions.width, targetHeight / dimensions.height);
  const imageWidth = dimensions.width * scale;
  const imageHeight = dimensions.height * scale;
  return {
    insetL: (targetWidth - imageWidth) / 2,
    insetT: (targetHeight - imageHeight) / 2,
    width: imageWidth,
    height: imageHeight,
  };
}
