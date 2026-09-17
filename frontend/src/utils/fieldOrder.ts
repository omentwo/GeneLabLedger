export function fieldDropTargetIndex(
  sourceIndex: number,
  boundaryIndex: number,
  itemCount: number,
): number {
  if (
    itemCount <= 0 ||
    sourceIndex < 0 ||
    sourceIndex >= itemCount ||
    boundaryIndex < 0 ||
    boundaryIndex > itemCount
  ) return -1;
  const targetIndex = boundaryIndex > sourceIndex ? boundaryIndex - 1 : boundaryIndex;
  return Math.max(0, Math.min(itemCount - 1, targetIndex));
}

export function moveArrayItem<T>(items: readonly T[], sourceIndex: number, targetIndex: number): T[] {
  if (
    sourceIndex < 0 ||
    sourceIndex >= items.length ||
    targetIndex < 0 ||
    targetIndex >= items.length
  ) return items.slice();
  const reordered = items.slice();
  const [item] = reordered.splice(sourceIndex, 1);
  if (item === undefined) return items.slice();
  reordered.splice(targetIndex, 0, item);
  return reordered;
}
