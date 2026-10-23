import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkMemory, memoryRefusal } from './memory';

const kafka = { title: 'Kafka', minMemoryMb: 1200 };
const camunda = { title: 'Camunda', minMemoryMb: 800 };
const postgres = { title: 'PostgreSQL', minMemoryMb: 300 };

describe('checkMemory', () => {
  it('пускает, когда свободно с запасом 10 %', () => {
    assert.deepEqual(checkMemory(2100, [kafka], camunda), { ok: true });
    assert.deepEqual(checkMemory(8000, [], postgres), { ok: true });
  });

  it('отказывает, когда запаса 10 % не хватает', () => {
    const tight = checkMemory(2000, [kafka], camunda);
    assert.equal(tight.ok, false);
    if (!tight.ok) {
      assert.equal(tight.needMb, 880);
      assert.equal(tight.freeMb, 800);
    }
  });

  it('называет самые тяжёлые модули, которые освободят нужное', () => {
    const verdict = checkMemory(1500, [kafka, camunda], postgres);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.deepEqual(verdict.stopTitles, ['Kafka (1200 МБ)']);
      assert.equal(memoryRefusal(verdict), 'нужно 330 МБ, свободно 0 МБ. Остановите: Kafka (1200 МБ)');
    }
  });

  it('когда Docker отдано меньше, чем нужно модулю, остановка других не поможет', () => {
    const verdict = checkMemory(1500, [kafka], { title: 'Elasticsearch', minMemoryMb: 2200 });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.deepEqual(verdict.stopTitles, []);
      assert.equal(
        memoryRefusal(verdict),
        'нужно 2420 МБ, Docker отдано 1500 МБ. Прибавьте память Docker в настройках',
      );
    }
  });

  it('без запущенных модулей и малой памяти — тот же совет', () => {
    const verdict = checkMemory(200, [], postgres);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(
        memoryRefusal(verdict),
        'нужно 330 МБ, Docker отдано 200 МБ. Прибавьте память Docker в настройках',
      );
    }
  });

  it('не предлагает остановить то, без чего стенд не работает', () => {
    const broker = { key: 'kit-kafka', title: 'Kafka', minMemoryMb: 600 };
    const plant = { key: 'kit-contracts', title: 'Контракты', minMemoryMb: 400 };
    const bank = { key: 'kit-bank', title: 'ЗапускБанк', minMemoryMb: 400 };
    const withExtra = checkMemory(1200, [broker, plant], bank, ['kit-kafka']);
    assert.equal(withExtra.ok, false);
    if (!withExtra.ok) assert.deepEqual(withExtra.stopTitles, ['Контракты (400 МБ)']);
    const onlyDeps = checkMemory(1000, [broker], bank, ['kit-kafka']);
    assert.equal(onlyDeps.ok, false);
    if (!onlyDeps.ok) assert.match(memoryRefusal(onlyDeps), /Прибавьте память Docker/);
  });
});

