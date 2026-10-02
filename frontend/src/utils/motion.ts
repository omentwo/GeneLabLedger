import { getCurrentScope, onScopeDispose, ref, watch, type Ref } from "vue";

const easeOutCubic = (progress: number): number => 1 - (1 - progress) ** 3;

/** 用户是否要求减少动效（实时读取，供 JS 动画与图表配置共用）。 */
export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 数字滚动：source 变化时从当前展示值缓动到新值（首个值从 0 起）。
 * 返回整数步进的展示值；尊重 prefers-reduced-motion，直接跳到终值。
 */
export function useAnimatedNumber(source: Ref<number>, duration = 900): Ref<number> {
  const display = ref(0);
  let frame = 0;

  const stop = (): void => {
    if (frame) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
  };

  watch(source, (target) => {
    stop();
    const goal = Number.isFinite(target) ? target : 0;
    if (prefersReducedMotion() || display.value === goal) {
      display.value = goal;
      return;
    }
    const from = display.value;
    const startedAt = performance.now();
    const step = (now: number): void => {
      const progress = Math.min(1, (now - startedAt) / duration);
      display.value = Math.round(from + (goal - from) * easeOutCubic(progress));
      frame = progress < 1 ? window.requestAnimationFrame(step) : 0;
    };
    frame = window.requestAnimationFrame(step);
  }, { immediate: true });

  if (getCurrentScope()) onScopeDispose(stop);
  return display;
}
