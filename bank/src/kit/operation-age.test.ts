import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ageSecondsOf, hasKopecks } from './operation-age';

describe('возраст операции по банковскому времени', () => {
  const created = new Date('2026-10-20T10:00:00Z');

  it('целые секунды между созданием и банковским «сейчас», вниз', () => {
    assert.equal(ageSecondsOf(created, new Date('2026-10-20T10:00:45.900Z')), 45);
    assert.equal(ageSecondsOf(created, new Date('2026-10-20T10:01:00Z')), 60);
  });

  it('время банка раньше создания (часы отодвинули) даёт ноль, а не отрицательное число', () => {
    assert.equal(ageSecondsOf(created, new Date('2026-10-20T09:00:00Z')), 0);
  });
});

describe('сумма с копейками', () => {
  it('круглые рубли — без копеек, остальное — с копейками', () => {
    assert.equal(hasKopecks(150000n), false);
    assert.equal(hasKopecks(150050n), true);
    assert.equal(hasKopecks(1n), true);
    assert.equal(hasKopecks(0n), false);
  });
});
