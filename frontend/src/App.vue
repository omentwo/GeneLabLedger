<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { useAppStore } from "@/stores/app";

const appStore = useAppStore();
let stopped = false;
let timer: ReturnType<typeof setTimeout> | undefined;
async function checkHealth(): Promise<void> {
  await appStore.refreshHealth();
  if (!stopped) timer = setTimeout(() => void checkHealth(), 5000);
}
onMounted(() => { void checkHealth(); });
onUnmounted(() => { stopped = true; clearTimeout(timer); });
</script>

<template>
  <RouterView />
</template>
