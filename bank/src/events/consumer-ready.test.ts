import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Consumer } from 'kafkajs';
import { trackGroupMembership } from './consumer-ready';

function fakeConsumer() {
  const handlers = new Map<string, (event: unknown) => void>();
  const events = {
    GROUP_JOIN: 'consumer.group_join',
    REBALANCING: 'consumer.rebalancing',
    STOP: 'consumer.stop',
    DISCONNECT: 'consumer.disconnect',
    CRASH: 'consumer.crash',
  };
  const consumer = {
    events,
    on: (name: string, handler: (event: unknown) => void) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
  } as unknown as Pick<Consumer, 'on' | 'events'>;
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event);
  return { consumer, emit, events };
}

const join = (assignment: Record<string, number[]>) => ({ payload: { memberAssignment: assignment } });

describe('потребитель Kafka в группе и читает', () => {
  it('до входа в группу не готов; готов, когда группа выдала разделы нужного топика', () => {
    const { consumer, emit, events } = fakeConsumer();
    const ready = trackGroupMembership(consumer, 'bank.payments.created');
    assert.equal(ready(), false);
    emit(events.GROUP_JOIN, join({ 'bank.payments.created': [0, 1, 2] }));
    assert.equal(ready(), true);
  });

  it('вход без разделов нужного топика не считается', () => {
    const { consumer, emit, events } = fakeConsumer();
    const ready = trackGroupMembership(consumer, 'bank.payments.created');
    emit(events.GROUP_JOIN, join({}));
    assert.equal(ready(), false);
    emit(events.GROUP_JOIN, join({ 'other.topic': [0] }));
    assert.equal(ready(), false);
    emit(events.GROUP_JOIN, join({ 'bank.payments.created': [] }));
    assert.equal(ready(), false);
  });

  it('перебалансировка, остановка, разрыв и сбой снимают готовность, повторный вход возвращает', () => {
    const { consumer, emit, events } = fakeConsumer();
    const ready = trackGroupMembership(consumer, 'bank.payments.created');
    for (const lost of [events.REBALANCING, events.STOP, events.DISCONNECT, events.CRASH]) {
      emit(events.GROUP_JOIN, join({ 'bank.payments.created': [0] }));
      assert.equal(ready(), true);
      emit(lost);
      assert.equal(ready(), false);
    }
    emit(events.GROUP_JOIN, join({ 'bank.payments.created': [0] }));
    assert.equal(ready(), true);
  });
});
