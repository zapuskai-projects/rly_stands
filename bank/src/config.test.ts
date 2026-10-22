import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from './config';

const BASE = { BANK_DATABASE_URL: 'postgres://u:p@h/db' };
const CORE = { ...BASE, BANK_KAFKA_BROKERS: 'redpanda:9092', BANK_RABBITMQ_URL: 'amqp://u:p@rabbit', SBP_URL: 'http://sbp:18402' };

describe('конфигурация банка', () => {
  it('без адреса базы банк не запускается, ошибка говорит о последствиях', () => {
    assert.throws(() => loadConfig({}), /BANK_DATABASE_URL не задан: банк не запустится без базы данных/);
  });

  it('роль core требует брокеры и адрес СБП, ошибка называет последствия', () => {
    assert.throws(() => loadConfig(BASE), /BANK_KAFKA_BROKERS не задан: события платежей некуда отправлять/);
    assert.throws(() => loadConfig({ ...BASE, BANK_KAFKA_BROKERS: 'k:1' }), /BANK_RABBITMQ_URL не задан: уведомления/);
    assert.throws(() => loadConfig({ ...BASE, BANK_KAFKA_BROKERS: 'k:1', BANK_RABBITMQ_URL: 'amqp://x' }), /SBP_URL не задан: переводы в другой банк/);
  });

  it('роль antifraud требует только Kafka, роль sbp — ничего кроме базы', () => {
    assert.equal(loadConfig({ ...BASE, BANK_ROLE: 'antifraud', BANK_KAFKA_BROKERS: 'k:1' }).port, 18401);
    assert.throws(() => loadConfig({ ...BASE, BANK_ROLE: 'antifraud' }), /BANK_KAFKA_BROKERS не задан: антифрод/);
    assert.equal(loadConfig({ ...BASE, BANK_ROLE: 'sbp' }).port, 18402);
  });

  it('порт по умолчанию зависит от роли и берётся из окружения', () => {
    assert.equal(loadConfig(CORE).port, 18400);
    assert.equal(loadConfig({ ...CORE, PORT: '18410' }).port, 18410);
    assert.throws(() => loadConfig({ ...CORE, PORT: '70000' }), /Неверная конфигурация банка/);
    assert.throws(() => loadConfig({ ...CORE, PORT: 'abc' }), /Неверная конфигурация банка/);
  });

  it('список брокеров разбирается, задержки СБП согласованы', () => {
    const config = loadConfig({ ...CORE, BANK_KAFKA_BROKERS: 'a:1, b:2', SBP_MIN_DELAY_MS: '5000', SBP_MAX_DELAY_MS: '100' });
    assert.deepEqual(config.kafkaBrokers, ['a:1', 'b:2']);
    assert.equal(config.sbpMaxDelayMs, 5000);
  });

  it('неизвестная роль и неверный префикс топиков отвергаются', () => {
    assert.throws(() => loadConfig({ ...CORE, BANK_ROLE: 'office' }), /Неверная конфигурация банка/);
    assert.throws(() => loadConfig({ ...CORE, TOPIC_PREFIX: 'a b' }), /Неверная конфигурация банка/);
  });
});
