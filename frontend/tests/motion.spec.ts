import { effectScope, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prefersReducedMotion, useAnimatedNumber } from "@/utils/motion";

let rafCallbacks: Map<number, FrameRequestCallback>;
let clockNow = 0;

beforeEach(() => {
  rafCallbacks = new Map();
  clockNow = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = rafCallbacks.size + 1;
    rafCallbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafCallbacks.delete(id);
  });
  vi.stubGlobal("performance", { now: () => clockNow });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 执行当前所有挂起的动画帧，并把虚拟时钟推进到 timestamp。 */
function runFrame(timestamp: number): void {
  clockNow = timestamp;
  const callbacks = [...rafCallbacks.values()];
  rafCallbacks.clear();
  callbacks.forEach((callback) => callback(timestamp));
}

describe("useAnimatedNumber", () => {
  it("rolls from the previous value to the target with eased integer steps", async () => {
    const source = ref(0);
    const scope = effectScope();
    const display = scope.run(() => useAnimatedNumber(source, 900))!;
    expect(display.value).toBe(0);

    source.value = 100;
    await nextTick();
    runFrame(0);
    expect(display.value).toBe(0);
    runFrame(450);
    // easeOutCubic(0.5) = 0.875 → 88
    expect(display.value).toBe(88);
    runFrame(900);
    expect(display.value).toBe(100);
    expect(rafCallbacks.size).toBe(0);
    scope.stop();
  });

  it("continues from the displayed value when the target changes mid-flight", async () => {
    const source = ref(0);
    const scope = effectScope();
    const display = scope.run(() => useAnimatedNumber(source, 900))!;

    source.value = 100;
    await nextTick();
    runFrame(0);
    runFrame(180);
    // progress 0.2 → easeOutCubic 0.488 → 49
    expect(display.value).toBe(49);

    source.value = 200;
    await nextTick();
    runFrame(630);
    // 从当前 49 继续滚向 200，而不是回到 0 重来
    expect(display.value).toBe(181);
    runFrame(1080);
    expect(display.value).toBe(200);
    scope.stop();
  });

  it("jumps straight to the target when reduced motion is preferred", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const source = ref(0);
    const scope = effectScope();
    const display = scope.run(() => useAnimatedNumber(source, 900))!;

    source.value = 100;
    await nextTick();
    expect(display.value).toBe(100);
    expect(rafCallbacks.size).toBe(0);
    scope.stop();
  });
});

describe("prefersReducedMotion", () => {
  it("reflects the media query and tolerates a missing matchMedia", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    expect(prefersReducedMotion()).toBe(false);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    expect(prefersReducedMotion()).toBe(true);
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});
