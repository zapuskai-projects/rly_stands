import assert from 'node:assert/strict';
import { it } from 'node:test';
import { READINESS } from '../../modules/readiness';
import { liveSuite } from './support';

type Facts = Record<string, any>;

const PROCESS = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="defs" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="live_approval" name="Согласование заявки" isExecutable="true">
    <bpmn:startEvent id="start" name="Заявка получена"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:exclusiveGateway id="gateway" name="Сумма больше лимита?" default="f3"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing><bpmn:outgoing>f3</bpmn:outgoing></bpmn:exclusiveGateway>
    <bpmn:userTask id="director" name="Согласовать у директора"><bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f4</bpmn:outgoing></bpmn:userTask>
    <bpmn:endEvent id="end" name="Готово"><bpmn:incoming>f3</bpmn:incoming><bpmn:incoming>f4</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="gateway"/>
    <bpmn:sequenceFlow id="f2" name="Больше" sourceRef="gateway" targetRef="director"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">\${amount &gt; 100000}</bpmn:conditionExpression></bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f3" name="Иначе" sourceRef="gateway" targetRef="end"/>
    <bpmn:sequenceFlow id="f4" sourceRef="director" targetRef="end"/>
  </bpmn:process>
</bpmn:definitions>`;

liveSuite('camunda', READINESS.camunda ?? [], 'Camunda: проверки на живом движке', ({ probe, write }) => {
  it('пока схемы нет, процесса нет, прогон сообщает «не развёрнуто»', async () => {
    assert.equal((await probe<Facts>('camunda.process', { key: 'live_missing' })).exists, false);
    const run = await probe<Facts>('camunda.runPath', { key: 'live_missing', variables: { amount: 1 } });
    assert.equal(run.started, false);
    assert.equal(run.state, 'NOT_DEPLOYED');
  });

  it('схема разворачивается из файла и из текста, версия растёт', async () => {
    const before = (await probe<Facts>('camunda.process', { key: 'live_approval' })).version;
    write('approval.bpmn', PROCESS);
    assert.deepEqual(await probe('camunda.deploy', { file: 'approval.bpmn' }), { deployed: true });
    const first = await probe<Facts>('camunda.process', { key: 'live_approval' });
    assert.equal(first.exists, true);
    assert.equal(first.version, before + 1);
    assert.deepEqual(
      first.elements.map((element: Facts) => element.id),
      ['start', 'gateway', 'director', 'end'],
    );
    await probe('camunda.deploy', { bpmnXml: PROCESS });
    assert.equal((await probe<Facts>('camunda.process', { key: 'live_approval' })).version, before + 2);
  });

  it('развёртывание без файла и с битой схемой — отказ действия', async () => {
    await assert.rejects(probe('camunda.deploy', { file: 'absent.bpmn' }), /absent\.bpmn/);
    await assert.rejects(probe('camunda.deploy', { bpmnXml: '<bpmn:definitions' }), /развёртывание/);
  });

  it('малая сумма идёт по умолчательной ветке и завершается без людей', async () => {
    const run = await probe<Facts>('camunda.runPath', { key: 'live_approval', variables: { amount: 5000 } });
    assert.equal(run.started, true);
    assert.equal(run.ended, true);
    assert.equal(run.state, 'COMPLETED');
    assert.deepEqual(run.pathIds, ['start', 'gateway', 'end']);
    assert.deepEqual(run.pathNames, ['Заявка получена', 'Сумма больше лимита?', 'Готово']);
    assert.deepEqual(run.incidents, []);
  });

  it('большая сумма останавливается на задаче, а с автозавершением задач доходит до конца', async () => {
    const waiting = await probe<Facts>('camunda.runPath', {
      key: 'live_approval',
      variables: { amount: 500000 },
      waitMs: 1500,
    });
    assert.equal(waiting.ended, false);
    assert.equal(waiting.state, 'ACTIVE');
    assert.equal(waiting.pathIds.at(-1), 'director');
    const done = await probe<Facts>('camunda.runPath', {
      key: 'live_approval',
      variables: { amount: 500000 },
      completeUserTasks: true,
    });
    assert.equal(done.ended, true);
    assert.deepEqual(done.pathIds, ['start', 'gateway', 'director', 'end']);
    assert.equal(done.path[2].type, 'userTask');
  });
});
