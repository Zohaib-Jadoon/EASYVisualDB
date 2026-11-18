export interface SavedWindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

export interface DisplayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function clampWindowBounds(
  saved: Partial<SavedWindowState> | null | undefined,
  displays: DisplayWorkArea[],
  defaults: { width: number; height: number } = { width: 1440, height: 900 }
): SavedWindowState {
  const primary = displays[0] || { x: 0, y: 0, width: 1440, height: 900 };
  const width = Math.max(1024, Math.min(saved?.width ?? defaults.width, primary.width));
  const height = Math.max(680, Math.min(saved?.height ?? defaults.height, primary.height));
  const isMaximized = Boolean(saved?.isMaximized);

  if (typeof saved?.x === 'number' && typeof saved?.y === 'number') {
    const visibleOnSomeDisplay = displays.some(
      (d) =>
        saved.x! + width > d.x + 80 &&
        saved.x! < d.x + d.width - 80 &&
        saved.y! + height > d.y + 80 &&
        saved.y! < d.y + d.height - 80
    );
    if (visibleOnSomeDisplay) {
      return { x: saved.x, y: saved.y, width, height, isMaximized };
    }
  }

  return {
    x: primary.x + Math.max(0, Math.round((primary.width - width) / 2)),
    y: primary.y + Math.max(0, Math.round((primary.height - height) / 2)),
    width,
    height,
    isMaximized,
  };
}
