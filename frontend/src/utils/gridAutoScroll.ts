export type GridAutoScrollDirection = -1 | 0 | 1;

export type GridAutoScrollVector = {
  horizontal: GridAutoScrollDirection;
  vertical: GridAutoScrollDirection;
};

type GridScrollViewport = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export function gridAutoScrollVector(
  clientX: number,
  clientY: number,
  viewport: GridScrollViewport,
  edgeSize: number,
): GridAutoScrollVector {
  const horizontal =
    clientX < viewport.left + edgeSize
      ? -1
      : clientX > viewport.right - edgeSize
        ? 1
        : 0;
  const vertical =
    clientY < viewport.top + edgeSize
      ? -1
      : clientY > viewport.bottom - edgeSize
        ? 1
        : 0;
  return { horizontal, vertical };
}

export function nextGridScrollOffset(
  current: number,
  maximum: number,
  direction: GridAutoScrollDirection,
  step: number,
): number {
  return Math.max(0, Math.min(maximum, current + direction * step));
}
