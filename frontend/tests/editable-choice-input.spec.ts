import ElementPlus from "element-plus";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import EditableChoiceInput from "@/components/EditableChoiceInput.vue";

const mountedApps: Array<ReturnType<typeof createApp>> = [];

afterEach(() => {
  mountedApps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = "";
});

describe("EditableChoiceInput", () => {
  it("keeps arbitrary typed and pasted text without requiring a suggestion selection", async () => {
    const values: string[] = [];
    const changes: string[] = [];
    const Harness = defineComponent({
      setup() {
        const value = ref("");
        return () => h(EditableChoiceInput, {
          modelValue: value.value,
          options: ["备选值"],
          "onUpdate:modelValue": (next: string) => {
            value.value = next;
            values.push(next);
          },
          onChange: (next: string) => changes.push(next),
        });
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(Harness);
    app.use(ElementPlus);
    mountedApps.push(app);
    app.mount(container);

    const input = container.querySelector("input");
    expect(input).not.toBeNull();
    input!.value = "粘贴的自由文字";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    expect(values.at(-1)).toBe("粘贴的自由文字");
    expect(input!.value).toBe("粘贴的自由文字");

    input!.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    expect(changes.at(-1)).toBe("粘贴的自由文字");
  });
});
