import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BASE_ERROR_RATE,
  SLOW_ROUTE,
  SPIKE_ERROR_RATE,
  errorRate,
  latencySeconds,
  memoryTargetMb,
  parseScenarioRequest,
  type ActiveScenario,
} from './model';

const START = 1_000_000;
const spike: ActiveScenario = { name: 'error-spike', label: 'k7f3qa', startedAt: START, durationSec: 120 };

describe('errorRate', () => {
  it('без сценария — фон ниже одного процента', () => {
    assert.equal(errorRate(null, START), BASE_ERROR_RATE);
    assert.ok(BASE_ERROR_RATE < 0.01);
  });

  it('error-spike растёт до 30 % и держится до конца', () => {
    assert.equal(errorRate(spike, START), BASE_ERROR_RATE);
    const middle = errorRate(spike, START + 15_000);
    assert.ok(middle > BASE_ERROR_RATE && middle < SPIKE_ERROR_RATE);
    assert.equal(errorRate(spike, START + 60_000), SPIKE_ERROR_RATE);
  });

  it('после окончания возвращается фон', () => {
    assert.equal(errorRate(spike, START + 121_000), BASE_ERROR_RATE);
  });

  it('другие сценарии долю ошибок не меняют', () => {
    const slow: ActiveScenario = { ...spike, name: 'slow-endpoint' };
    assert.equal(errorRate(slow, START + 60_000), BASE_ERROR_RATE);
  });
});

describe('latencySeconds', () => {
  const slow: ActiveScenario = { name: 'slow-endpoint', label: 'k7f3qa', startedAt: START, durationSec: 60 };

  it('медленный маршрут получает хвост больше 2 с, остальные нет', () => {
    assert.ok(latencySeconds(SLOW_ROUTE, slow, START + 1000, () => 0.1) > 2);
    assert.ok(latencySeconds('/api/orders', slow, START + 1000, () => 0.1) < 0.2);
    assert.ok(latencySeconds(SLOW_ROUTE, slow, START + 1000, () => 0.9) < 0.2);
  });

  it('без сценария задержка небольшая', () => {
    assert.ok(latencySeconds(SLOW_ROUTE, null, START, () => 0.1) < 0.2);
  });
});

describe('memoryTargetMb', () => {
  const growth: ActiveScenario = { name: 'memory-growth', label: 'k7f3qa', startedAt: START, durationSec: 100 };

  it('растёт линейно и обнуляется после конца', () => {
    assert.equal(memoryTargetMb(growth, START), 0);
    assert.equal(memoryTargetMb(growth, START + 50_000), 96);
    assert.equal(memoryTargetMb(growth, START + 101_000), 0);
    assert.equal(memoryTargetMb(null, START), 0);
  });
});

describe('parseScenarioRequest', () => {
  it('принимает корректный запрос', () => {
    assert.deepEqual(parseScenarioRequest({ name: 'error-spike', label: 'k7f3qa', durationSec: 90 }), {
      ok: true,
      value: { name: 'error-spike', label: 'k7f3qa', durationSec: 90 },
    });
  });

  it('отвергает неизвестный сценарий, плохую метку и длительность', () => {
    for (const body of [
      null,
      { name: 'boom', label: 'a', durationSec: 60 },
      { name: 'error-spike', label: 'Метка!', durationSec: 60 },
      { name: 'error-spike', label: 'a', durationSec: 5 },
      { name: 'error-spike', label: 'a', durationSec: 60.5 },
      { name: 'error-spike', label: 'a', durationSec: 7200 },
    ]) {
      assert.equal(parseScenarioRequest(body).ok, false);
    }
  });
});
