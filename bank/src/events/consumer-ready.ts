import type { Consumer } from 'kafkajs';

type EventSource = Pick<Consumer, 'on' | 'events'>;

export function trackGroupMembership(consumer: EventSource, topic: string): () => boolean {
  let ready = false;
  const { GROUP_JOIN, REBALANCING, STOP, DISCONNECT, CRASH } = consumer.events;
  consumer.on(GROUP_JOIN, (event) => {
    ready = (event.payload.memberAssignment[topic] ?? []).length > 0;
  });
  for (const lost of [REBALANCING, STOP, DISCONNECT, CRASH]) {
    consumer.on(lost, () => {
      ready = false;
    });
  }
  return () => ready;
}
