<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { api, explain, size, ApiError, prefix, type Claim } from "./api";
const code = ref(""),
  password = ref(""),
  claim = ref<Claim>(),
  message = ref(""),
  busy = ref(false),
  blocked = ref(false),
  cooldown = ref(0);
const existing = location.pathname.split("/")[2];
const polling = new AbortController();
let cooldownTimer: ReturnType<typeof setInterval> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined,
  disposed = false;
async function get() {
  busy.value = true;
  message.value = "";
  try {
    const c = await api<Claim>("/claims", "POST", {
      code: code.value,
      password: password.value,
    });
    location.assign("/receive/" + c.claimId);
  } catch (e) {
    message.value = explain(e);
    if (e instanceof ApiError && e.retryAfter > 0) {
      cooldown.value = e.retryAfter;
      clearInterval(cooldownTimer);
      cooldownTimer = setInterval(() => {
        if (--cooldown.value <= 0) clearInterval(cooldownTimer);
      }, 1000);
    }
  } finally {
    busy.value = false;
  }
}
function normalize(e: Event) {
  const input = e.target as HTMLInputElement;
  code.value = input.value.replace(/[\s-]/g, "");
  input.value = code.value;
}
async function refresh() {
  if (disposed) return;
  try {
    claim.value = await api<Claim>(
      "/claims/" + existing,
      "GET",
      undefined,
      polling.signal,
    );
    blocked.value = false;
    message.value = "";
  } catch (e) {
    if (claim.value?.completed) return;
    message.value = explain(e);
    blocked.value = true;
    if (
      e instanceof ApiError &&
      e.code !== "TRANSFER_BUSY" &&
      e.code !== "RATE_LIMITED"
    )
      return;
  }
  if (!disposed && !claim.value?.completed)
    timer = setTimeout(refresh, document.hidden ? 10000 : 1000);
}
const href = (id: string) =>
  prefix + "/claims/" + existing + "/files/" + id + "/content";
type Picker = (options: {
  suggestedName: string;
}) => Promise<{ createWritable: () => Promise<WritableStream<Uint8Array>> }>;
const picker = window.isSecureContext
  ? (window as Window & { showSaveFilePicker?: Picker }).showSaveFilePicker
  : undefined;
async function save(file: Claim["files"][number]) {
  try {
    if (!picker) return;
    const target = await picker.call(window, { suggestedName: file.name }),
      res = await fetch(href(file.id));
    if (!res.ok) {
      const err = await res.json();
      message.value = err.message;
      blocked.value = err.code === "QUOTA_EXHAUSTED";
      return;
    }
    const writer = await target.createWritable();
    if (res.body) await res.body.pipeTo(writer);
    else await writer.close();
  } catch (e) {
    if (!(e instanceof DOMException && e.name === "AbortError"))
      message.value = "保存中断，请重试";
  }
}
onMounted(() => {
  if (existing) void refresh();
});
onBeforeUnmount(() => {
  disposed = true;
  polling.abort();
  clearInterval(cooldownTimer);
  clearTimeout(timer);
});
</script>
<template>
  <h1>{{ existing ? "取件文件" : "下载文件" }}</h1>
  <form v-if="!existing" class="panel" @submit.prevent="get">
    <label
      >六位取件码<input
        autofocus
        type="password"
        inputmode="numeric"
        pattern="[0-9]{6}"
        required
        autocomplete="off"
        placeholder="请输入取件码"
        :value="code"
        @input="normalize"
    /></label>
    <label
      >访问密码（如有）<input
        v-model="password"
        type="password"
        maxlength="128"
        autocomplete="off" /></label
    ><button :disabled="busy || cooldown > 0">
      {{ cooldown ? cooldown + " 秒后重试" : busy ? "正在验证…" : "查看文件" }}
    </button>
  </form>
  <section v-else class="panel">
    <template v-if="claim">
      <p v-if="claim.completed">本次文件已由服务端发送完毕。</p>
      <p v-else-if="claim.counted && claim.state === 'exhausted' && !blocked">
        新下载名额已用完，你仍可继续本次下载
      </p>
      <p>有效至 {{ new Date(claim.expiresAt).toLocaleString() }}</p>
      <ul>
        <li v-for="f in claim.files" :key="f.id">
          <strong>{{ f.name }}</strong><small
            >{{ size(f.size) }} · 服务端已传
            {{
              size(
                claim.progress.find((p) => p.fileId === f.id)?.servedBytes ?? 0,
              )
            }}</small
          ><small v-if="claim.active.some((a) => a.fileId === f.id)"
            >当前请求已输出
            {{
              size(
                claim.active.find((a) => a.fileId === f.id)?.emittedBytes ?? 0,
              )
            }}</small
          >
          <div v-if="!blocked && !claim.completed" class="actions">
            <a class="action" :href="href(f.id)">下载文件</a
            ><button v-if="picker" class="secondary" @click="save(f)">
              选择保存位置
            </button>
          </div>
        </li>
      </ul> </template
    ><a href="/download">重新输入取件码</a>
  </section>
  <p role="status">{{ message }}</p>
</template>
