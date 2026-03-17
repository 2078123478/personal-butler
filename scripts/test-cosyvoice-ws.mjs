#!/usr/bin/env node
/**
 * CosyVoice WebSocket TTS 实测脚本
 * 测量：连接延迟、首字节延迟、总耗时、音频大小
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import WebSocket from "ws";

const API_KEY = process.env.TTS_API_KEY || "sk-5ee9759a496e4562b976cf3ba4dbebfc";
const ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/inference/";

const TESTS = [
  { model: "cosyvoice-v2", voice: "longxiaochun_v2", text: "你好，我是小音，很高兴认识你！", label: "短句-v2" },
  { model: "cosyvoice-v2", voice: "longxiaochun_v2", text: "币安刚刚发布了一个重要公告，BNB生态系统出现了新的空投机会，建议你立即查看详情。这个机会可能很快就会过期。", label: "中句-v2" },
  { model: "cosyvoice-v2", voice: "longwan_v2", text: "你好，我是小音，很高兴认识你！", label: "短句-v2-longwan" },
  { model: "cosyvoice-v1", voice: "longxiaochun", text: "你好，我是小音，很高兴认识你！", label: "短句-v1" },
];

async function testOne({ model, voice, text, label }) {
  const taskId = randomUUID();
  const t0 = performance.now();
  let tConnected = 0;
  let tFirstByte = 0;
  let tFinished = 0;
  const audioChunks = [];

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ENDPOINT, {
      headers: { Authorization: `bearer ${API_KEY}` },
    });

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("timeout 30s"));
    }, 30_000);

    ws.on("open", () => {
      tConnected = performance.now();
      ws.send(JSON.stringify({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
        payload: {
          task_group: "audio", task: "tts", function: "SpeechSynthesizer",
          model,
          parameters: { text_type: "PlainText", voice, format: "mp3", sample_rate: 22050, volume: 50, rate: 1, pitch: 1 },
          input: {},
        },
      }));
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        if (!tFirstByte) tFirstByte = performance.now();
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf.byteLength > 0) audioChunks.push(buf);
        return;
      }

      const msg = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
      const event = msg?.header?.event;

      if (event === "task-started") {
        ws.send(JSON.stringify({
          header: { action: "continue-task", task_id: taskId, streaming: "duplex" },
          payload: { input: { text } },
        }));
        ws.send(JSON.stringify({
          header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
          payload: { input: {} },
        }));
      } else if (event === "task-finished") {
        tFinished = performance.now();
        clearTimeout(timeout);
        ws.close();
        const audio = Buffer.concat(audioChunks);
        resolve({
          label,
          model,
          voice,
          textLen: text.length,
          connectMs: Math.round(tConnected - t0),
          firstByteMs: tFirstByte ? Math.round(tFirstByte - t0) : "N/A",
          totalMs: Math.round(tFinished - t0),
          audioBytes: audio.byteLength,
          audioKB: (audio.byteLength / 1024).toFixed(1),
          audio,
        });
      } else if (event === "task-failed") {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(`task-failed: ${JSON.stringify(msg.payload)}`));
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

console.log("🎤 CosyVoice WebSocket TTS 延迟测试\n");
console.log("=".repeat(80));

for (const test of TESTS) {
  try {
    const result = await testOne(test);
    console.log(`\n📊 ${result.label} (${result.model} / ${result.voice})`);
    console.log(`   文本长度: ${result.textLen} 字`);
    console.log(`   连接延迟: ${result.connectMs}ms`);
    console.log(`   首字节延迟: ${result.firstByteMs}ms`);
    console.log(`   总耗时: ${result.totalMs}ms`);
    console.log(`   音频大小: ${result.audioKB} KB (${result.audioBytes} bytes)`);

    // 保存最后一个音频文件用于试听
    const outPath = `/tmp/cosyvoice-test-${result.label}.mp3`;
    writeFileSync(outPath, result.audio);
    console.log(`   已保存: ${outPath}`);
  } catch (err) {
    console.log(`\n❌ ${test.label}: ${err.message}`);
  }
}

console.log("\n" + "=".repeat(80));
console.log("测试完成 ✅");
