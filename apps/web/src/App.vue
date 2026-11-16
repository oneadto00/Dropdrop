<script setup lang="ts">
import UploadPanel from "./UploadPanel.vue";
import PickupForm from "./PickupForm.vue";
const page = location.pathname;
</script>
<template>
  <header>
    <a class="brand" href="/">Dropdrop</a>
  </header>
  <main v-if="page === '/'" class="home">
    <nav class="choices" aria-label="文件传输">
      <a class="choice sender" href="/upload">
        <span class="direction" aria-hidden="true">↑</span>
        <strong>上传</strong>
      </a>
      <a class="choice receiver" href="/download">
        <span class="direction" aria-hidden="true">↓</span>
        <strong>下载</strong>
      </a>
    </nav>
  </main>
  <main v-else>
    <a class="back" href="/">← 首页</a>
    <UploadPanel v-if="page === '/upload'" /><PickupForm v-else />
  </main>
</template>
