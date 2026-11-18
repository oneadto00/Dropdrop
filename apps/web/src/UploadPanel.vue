<script setup lang="ts">
import { ref, onBeforeUnmount } from "vue";
import { api, explain, sendFile, ApiError, type Batch } from "./api-client";
import { formatBytes } from "./format-bytes";
const files = ref<File[]>([]),
  limit = ref(1),
  ttl = ref(3600),
  password = ref(""),
  code = ref(""),
  busy = ref(false),
  message = ref(""),
  progress = ref(0),
  batch = ref<Batch>();
const polling = new AbortController();
let controller: AbortController | undefined,
  timer: ReturnType<typeof setTimeout> | undefined,
  disposed = false;
function choose(e: Event) {
  files.value = Array.from((e.target as HTMLInputElement).files ?? []);
  message.value = "";
}
async function poll() {
  if (disposed || !batch.value || !code.value) return;
  try {
    batch.value = await api<Batch>(
      "/uploads/" + batch.value.batchId,
      "GET",
      undefined,
      polling.signal,
    );
    message.value = "";
  } catch (e) {
    message.value = explain(e);
    if (
      e instanceof ApiError &&
      [
        "FORBIDDEN",
        "SESSION_REQUIRED",
        "BATCH_EXPIRED",
        "BATCH_REVOKED",
      ].includes(e.code)
    ) {
      if (e.code === "FORBIDDEN")
        message.value = "本批文件已不可用，可重新上传";
      batch.value = undefined;
      code.value = "";
      return;
    }
  }
  if (!disposed) timer = setTimeout(poll, document.hidden ? 10000 : 1000);
}
async function send() {
  if (!files.value.length || files.value.length > 20) {
    message.value = "请选择 1 至 20 个文件";
    return;
  }
  busy.value = true;
  message.value = "";
  progress.value = 0;
  controller = new AbortController();
  const signal = controller.signal;
  try {
    if (batch.value)
      batch.value = await api<Batch>("/uploads/" + batch.value.batchId);
    else
      batch.value = await api<Batch>("/uploads", "POST", {
        files: files.value.map((f) => ({ name: f.name, size: f.size })),
        maxDownloads: limit.value,
        expiresInSeconds: ttl.value,
        password: password.value,
      });
    const path = "/uploads/" + batch.value.batchId,
      total = files.value.reduce((n, f) => n + f.size, 0);
    let done = 0;
    for (const [index, file] of files.value.entries()) {
      if (batch.value.files[index].uploaded) {
        done += file.size;
        continue;
      }
      await sendFile(
        path + "/files/" + batch.value.files[index].id,
        file,
        signal,
        (n) =>
          (progress.value = total ? Math.floor((100 * (done + n)) / total) : 0),
      );
      done += file.size;
    }
    if (signal.aborted) throw Error("取消");
    const result = await api<{ code: string }>(path + "/finalize", "POST");
    if (signal.aborted) throw Error("取消");
    code.value = result.code;
    progress.value = 100;
    password.value = "";
    void poll();
  } catch (e) {
    if (signal.aborted) await revoke();
    else {
      message.value = explain(e);
      if (
        e instanceof ApiError &&
        [
          "FORBIDDEN",
          "SESSION_REQUIRED",
          "BATCH_EXPIRED",
          "BATCH_REVOKED",
        ].includes(e.code)
      )
        batch.value = undefined;
    }
  } finally {
    busy.value = false;
  }
}
async function revoke() {
  clearTimeout(timer);
  try {
    if (batch.value) await api("/uploads/" + batch.value.batchId, "DELETE");
    batch.value = undefined;
    code.value = "";
    message.value = "已取消或撤销本批文件";
  } catch (e) {
    message.value = explain(e);
  }
}
onBeforeUnmount(() => {
  disposed = true;
  polling.abort();
  clearTimeout(timer);
  controller?.abort();
});
</script>
<template>
  <h1>上传文件</h1>
  <section v-if="code && batch" class="panel">
    <h2>取件码</h2>
    <output class="code">{{ code }}</output>
    <p>已启动 {{ batch.startedDownloads }} / {{ batch.maxDownloads }} 次下载</p>
    <p>有效至 {{ new Date(batch.expiresAt).toLocaleString() }}</p>
    <button class="secondary" @click="revoke">撤销文件</button>
  </section>
  <form v-else class="panel" @submit.prevent="send">
    <label
      >选择文件<input
        type="file"
        multiple
        :disabled="busy || !!batch"
        @change="choose"
    /></label>
    <ul v-if="files.length">
      <li v-for="(f, i) in files" :key="i">
        {{ f.name }} <small>{{ formatBytes(f.size) }}</small>
      </li>
    </ul>
    <div class="fields">
      <label
        >最大下载次数<input
          type="number"
          v-model.number="limit"
          min="1"
          max="1000"
          required
          :disabled="busy || !!batch" /></label
      ><label
        >有效期<select v-model="ttl" :disabled="busy || !!batch">
          <option :value="60">1 分钟</option>
          <option :value="3600">1 小时</option>
          <option :value="21600">6 小时</option>
          <option :value="86400">24 小时</option>
        </select></label
      >
    </div>
    <label
      >访问密码（选填）<input
        type="password"
        v-model="password"
        maxlength="128"
        autocomplete="new-password"
        :disabled="busy || !!batch"
    /></label>
    <template v-if="busy"
      ><progress :value="progress" max="100"></progress>
      <p>
        {{ progress === 100 ? "正在发布文件…" : "正在上传 " + progress + "%" }}
      </p>
      <button type="button" class="secondary" @click="controller?.abort()">
        取消上传
      </button></template
    >
    <template v-else
      ><button>{{ batch ? "重试上传" : "开始上传" }}</button
      ><button v-if="batch" class="secondary" type="button" @click="revoke">
        取消批次
      </button></template
    >
  </form>
  <p role="status">{{ message }}</p>
</template>
