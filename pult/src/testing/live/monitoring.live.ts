import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, it } from 'node:test';
import { READINESS } from '../../modules/readiness';
import { eventually, liveSuite } from './support';

type Facts = Record<string, any>;

const SHARE =
  'sum(rate(bank_transfers_total{channel="PHONE",status="COMPLETED"}[1m])) / sum(rate(bank_transfers_total{channel="PHONE",status=~"COMPLETED|FAILED|REJECTED|REFUNDED"}[1m]))';
const P95 = 'histogram_quantile(0.95, sum by (le) (rate(bank_transfer_duration_seconds_bucket{channel="PHONE"}[5m])))';

function rule(title: string, threshold: number) {
  return {
    title,
    condition: 'C',
    for: '1m',
    data: [
      {
        refId: 'A',
        relativeTimeRange: { from: 300, to: 0 },
        datasourceUid: 'prometheus',
        model: { refId: 'A', expr: SHARE, instant: true, intervalMs: 1000, maxDataPoints: 43200 },
      },
      {
        refId: 'C',
        relativeTimeRange: { from: 300, to: 0 },
        datasourceUid: '__expr__',
        model: {
          refId: 'C',
          type: 'threshold',
          expression: 'A',
          conditions: [{ evaluator: { type: 'lt', params: [threshold] } }],
          datasource: { type: '__expr__', uid: '__expr__' },
        },
      },
    ],
  };
}

const ready = [...(READINESS.monitoring ?? []), ...(READINESS.bank ?? [])];

liveSuite('monitoring', ready, 'Prometheus, Grafana и банк: правила тревоги и учения', (env) => {
  const { probe } = env;
  const phoneTransfer = (index: number) =>
    probe<Facts>('bank.transfer', {
      phone: '+79001110002',
      toPhone: '+79001110001',
      amountKop: 100,
      idempotencyKey: `live-mon-${Date.now()}-${index}`,
    });

  before(async () => {
    writeFileSync(join(env.dataDir(), 'bank-secret'), `${process.env.KIT_LIVE_BANK_SECRET ?? ''}\n`);
    await probe('bank.scenario', { reset: true, defects: [], bankTime: 'noon' });
    await probe('grafana.deleteAlertRules', { titleContains: 'live-sla' });
  });

  it('удаление правил по части названия: свои исчезают из списка, чужие остаются, повтор ничего не находит', async () => {
    await probe('grafana.createAlertRule', { rule: { ...rule('live-sla one', 0.95), ruleGroup: 'live-sla-one' } });
    await probe('grafana.createAlertRule', { rule: { ...rule('live-sla two', 0.9), ruleGroup: 'live-sla-two' } });
    await probe('grafana.createAlertRule', { rule: { ...rule('live-other', 0.9), ruleGroup: 'live-other' } });
    assert.equal((await probe<Facts>('grafana.alertRules', { titleContains: 'live-sla' })).count, 2);
    assert.deepEqual(await probe('grafana.deleteAlertRules', { titleContains: 'live-sla' }), { deleted: 2 });
    assert.equal((await probe<Facts>('grafana.alertRules', { titleContains: 'live-sla' })).count, 0);
    assert.equal((await probe<Facts>('grafana.alertRules', { titleContains: 'live-other' })).count, 1);
    assert.deepEqual(await probe('grafana.deleteAlertRules', { titleContains: 'live-sla' }), { deleted: 0 });
    await assert.rejects(probe('grafana.deleteAlertRules', { titleContains: 'live' }), /короче 8 символов/);
    assert.equal((await probe<Facts>('grafana.alertRules', { titleContains: 'live-other' })).count, 1);
    assert.deepEqual(await probe('grafana.deleteAlertRules', { titleContains: 'live-other' }), { deleted: 1 });
  });

  it('два запроса в файле: метрики банка собраны, у каждого строки свой результат, верхний уровень — первый запрос', async () => {
    for (let index = 0; index < 5; index += 1) await phoneTransfer(index);
    const sla = `${SHARE}\n${P95}\n`;
    env.write('sla.promql', sla);
    const facts = await eventually(
      () => probe<Facts>('prometheus.queryFile', { file: 'sla.promql' }),
      (value) =>
        value.queries?.length === 2 &&
        value.queries.every((item: Facts) => item.series > 0 && Number.isFinite(Number(item.value))),
      90_000,
      3000,
    );
    assert.equal(facts.queryError, null);
    assert.equal(facts.queries.length, 2);
    assert.equal(facts.queries[0].query, SHARE);
    assert.equal(facts.queries[1].query, P95);
    assert.equal(facts.value, facts.queries[0].value);
    assert.ok(Number(facts.queries[0].value) > 0.99, `доля успешных ${facts.queries[0].value}`);
    assert.ok(Number(facts.queries[1].value) > 0, 'время до конечного статуса больше нуля');
    env.write('broken.promql', `${SHARE}\nrate(no_such_metric[\n`);
    const broken = await probe<Facts>('prometheus.queryFile', { file: 'broken.promql' });
    assert.equal(broken.queries.length, 2);
    assert.equal(broken.queryError, null);
    assert.ok(broken.queries[1].queryError, 'ошибка второго запроса видна студенту');
  });

  it('учения для банка: правило с порогом молчит в спокойный период и срабатывает при сбое СБП', async () => {
    await probe('grafana.createAlertRule', { rule: { ...rule('live-sla drill', 0.95), ruleGroup: 'live-sla-drill' } });
    const drill = await probe<Facts>('monitoring.alertDrill', {
      ruleTitleContains: 'live-sla drill',
      scenario: 'bank-sbp-reject',
      calmSec: 30,
      incidentSec: 200,
      bankTime: 'noon',
    });
    assert.equal(drill.ruleFound, true);
    assert.equal(drill.firedInCalm, false, 'тревога в спокойный период');
    assert.equal(drill.firedInIncident, true, 'тревога при сбое СБП');
    assert.ok(drill.firedAfterSec > 0 && drill.firedAfterSec <= 200);
    assert.ok(drill.transfersSent > 10, `переводов за учения: ${drill.transfersSent}`);
  });

  it('учения: правило, которого нет, — ruleFound=false без переводов; правило без достижимого порога не срабатывает и при сбое', async () => {
    const absent = await probe<Facts>('monitoring.alertDrill', {
      ruleTitleContains: 'live-sla absent',
      scenario: 'bank-sbp-reject',
      calmSec: 5,
      incidentSec: 5,
    });
    assert.deepEqual(absent, { ruleFound: false, firedInCalm: false, firedInIncident: false, firedAfterSec: null, transfersSent: 0 });
    await probe('grafana.createAlertRule', { rule: { ...rule('live-sla never', -1), ruleGroup: 'live-sla-never' } });
    const drill = await probe<Facts>('monitoring.alertDrill', {
      ruleTitleContains: 'live-sla never',
      scenario: 'bank-sbp-reject',
      calmSec: 10,
      incidentSec: 110,
      bankTime: 'noon',
    });
    assert.equal(drill.ruleFound, true);
    assert.equal(drill.firedInCalm, false);
    assert.equal(drill.firedInIncident, false, 'порог ниже нуля не достижим');
  });

  it('уборка', async () => {
    await probe('grafana.deleteAlertRules', { titleContains: 'live-sla' });
    assert.equal((await probe<Facts>('grafana.alertRules', { titleContains: 'live-sla' })).count, 0);
    await probe('bank.scenario', { reset: true, defects: [], bankTime: 'noon' });
  });
});
