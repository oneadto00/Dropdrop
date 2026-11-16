<script setup lang="ts">
import UploadPanel from "./UploadPanel.vue";
import PickupForm from "./PickupForm.vue";
const page = location.pathname;
</script>
<template>
  <header>
    <a class="brand" href="/"
      ><span class="symbol" aria-hidden="true">⇅</span>Dropdrop</a
    ><span class="network">局域网文件中转</span>
  </header>
  <main v-if="page === '/'" class="home">
    <h1>文件中转</h1>
    <p class="intro">在同一局域网内，上传文件或凭六位码取件。</p>
    <nav class="choices">
      <a class="choice sender" href="/upload"
        ><span class="direction" aria-hidden="true">↑</span><strong>上传</strong
        ><span>选择要发送的文件</span></a
      ><a class="choice receiver" href="/download"
        ><span class="direction" aria-hidden="true">↓</span><strong>下载</strong
        ><span>输入取件码接收文件</span></a
      >
    </nav>
  </main>
  <main v-else>
    <a class="back" href="/">← 首页</a
    ><UploadPanel v-if="page === '/upload'" /><PickupForm v-else />
  </main>
</template>
