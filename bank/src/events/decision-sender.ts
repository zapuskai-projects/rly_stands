import type { Kafka, Producer } from 'kafkajs';
import { ensureTopics } from './kafka';
import type { DecisionSender } from './handlers';

export interface DecisionProducer {
  send: DecisionSender;
  warmUp(): void;
  isReady(): boolean;
  close(): Promise<void>;
}

export function createDecisionProducer(kafka: Kafka, topic: string): DecisionProducer {
  let ready: Promise<Producer> | null = null;
  let connected = false;
  const producer = (): Promise<Producer> => {
    if (!ready) {
      ready = (async () => {
        await ensureTopics(kafka, [topic]);
        const created = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
        await created.connect();
        connected = true;
        return created;
      })().catch((error: unknown) => {
        ready = null;
        connected = false;
        throw error;
      });
    }
    return ready;
  };
  return {
    warmUp() {
      producer().catch(() => undefined);
    },
    isReady: () => connected,
    async send(decision, headers) {
      const active = await producer();
      await active.send({ topic, acks: -1, messages: [{ key: decision.clientNumber, value: JSON.stringify(decision), headers }] });
    },
    async close() {
      await (await ready?.catch(() => null))?.disconnect().catch(() => undefined);
    },
  };
}
