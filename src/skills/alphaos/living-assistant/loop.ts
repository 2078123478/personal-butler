import { evaluateContactPolicy } from "./contact-policy";
import type {
  AttentionLevel,
  ContactChannel,
  ContactPolicyConfig,
  UserContext,
} from "./contact-policy";
import type { DigestBatch, DigestBatchScheduler, DigestQueueItem, DigestQueueSnapshot } from "./digest-batching";
import { executeDelivery } from "./delivery/delivery-executor";
import type { DeliveryExecutorConfig, DeliveryResult } from "./delivery/delivery-executor";
import type { NormalizedSignal } from "./signal-radar";
import type { TTSOptions, TTSProvider, TTSResult } from "./tts";
import { generateVoiceBrief } from "./voice-brief";
import type { VoiceBrief, VoiceBriefProtocol } from "./voice-brief";

export interface LivingAssistantLoopInput {
  signal: NormalizedSignal;
  userContext: UserContext;
  policyConfig: ContactPolicyConfig;
  briefProtocol?: VoiceBriefProtocol;
  ttsProvider?: TTSProvider;
  ttsOptions?: TTSOptions;
  deliveryExecutor?: DeliveryExecutorConfig;
  digestScheduler?: DigestBatchScheduler;
  demoMode?: boolean;
}

export interface LivingAssistantLoopOutput {
  signal: NormalizedSignal;
  decision: ReturnType<typeof evaluateContactPolicy>;
  brief?: VoiceBrief;
  audio?: TTSResult;
  delivery?: DeliveryResult;
  delivered: boolean;
  deliveryChannel?: ContactChannel;
  demoMode: boolean;
  digestQueue?: DigestQueueSnapshot;
  digestEnqueued?: DigestQueueItem;
  digestFlushed?: DigestBatch;
  timings: {
    policyMs: number;
    briefMs: number;
    ttsMs: number;
    deliveryMs: number;
    totalMs: number;
  };
  loopCompletedAt: string;
}

const ATTENTION_RANK: Record<AttentionLevel, number> = {
  silent: 0,
  digest: 1,
  text_nudge: 2,
  voice_brief: 3,
  strong_interrupt: 4,
  call_escalation: 5,
};

function shouldGenerateBrief(attentionLevel: AttentionLevel): boolean {
  return ATTENTION_RANK[attentionLevel] >= ATTENTION_RANK.voice_brief;
}

export async function runLivingAssistantLoop(
  input: LivingAssistantLoopInput,
): Promise<LivingAssistantLoopOutput> {
  const loopStart = performance.now();

  const policyStart = performance.now();
  const decision = evaluateContactPolicy(input.signal, input.userContext, input.policyConfig);
  const policyMs = performance.now() - policyStart;

  let digestQueue: DigestQueueSnapshot | undefined;
  let digestEnqueued: DigestQueueItem | undefined;
  let digestFlushed: DigestBatch | undefined;

  if (input.digestScheduler) {
    digestFlushed = input.digestScheduler.flushDue();
  }

  if (decision.attentionLevel === "digest" && input.digestScheduler) {
    const enqueueResult = input.digestScheduler.enqueue({
      signal: input.signal,
      decision,
      digestWindowMinutes: input.policyConfig.digestWindowMinutes,
    });
    digestEnqueued = enqueueResult.item;
  }

  if (input.digestScheduler) {
    digestQueue = input.digestScheduler.getSnapshot();
  }

  const briefStart = performance.now();
  const brief = shouldGenerateBrief(decision.attentionLevel)
    ? generateVoiceBrief(
        input.signal,
        decision,
        input.briefProtocol ? { protocol: input.briefProtocol } : undefined,
      )
    : undefined;
  const briefMs = performance.now() - briefStart;

  const deliveryChannel = decision.channels[0];
  const demoMode = Boolean(input.demoMode);
  let audio: TTSResult | undefined;
  let delivery: DeliveryResult | undefined;
  let ttsMs = 0;
  let deliveryMs = 0;

  if (brief && input.ttsProvider) {
    const ttsStart = performance.now();
    try {
      audio = await input.ttsProvider.synthesize(brief.text, input.ttsOptions);
    } catch {
      audio = undefined;
    } finally {
      ttsMs = performance.now() - ttsStart;
    }
  }

  if (!demoMode && input.deliveryExecutor) {
    const deliveryStart = performance.now();
    delivery = await executeDelivery(decision, brief, audio, input.deliveryExecutor);
    deliveryMs = performance.now() - deliveryStart;
  }

  const totalMs = performance.now() - loopStart;

  return {
    signal: input.signal,
    decision,
    brief,
    audio,
    delivery,
    delivered: demoMode ? false : Boolean(delivery?.sent),
    deliveryChannel,
    demoMode,
    digestQueue,
    digestEnqueued,
    digestFlushed,
    timings: {
      policyMs,
      briefMs,
      ttsMs,
      deliveryMs,
      totalMs,
    },
    loopCompletedAt: new Date().toISOString(),
  };
}
