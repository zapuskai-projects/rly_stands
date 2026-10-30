import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bpmnTypeOf, parseBpmn } from './bpmn';

const BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1">
  <bpmn:collaboration id="Collab">
    <bpmn:participant id="P1" name="Согласование" processRef="contract-approval" />
  </bpmn:collaboration>
  <bpmn:process id="contract-approval" isExecutable="true">
    <bpmn:laneSet id="Lanes">
      <bpmn:lane id="L1" name="Юрист">
        <bpmn:flowNodeRef>review</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="start" name="Договор получен" />
    <bpmn:userTask id="review" name="Проверить договор" />
    <bpmn:exclusiveGateway id="big" name="Сумма больше 100000?" />
    <bpmn:userTask id="director" name="Согласовать у директора" />
    <bpmn:endEvent id="end" name="Готово" />
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="review" />
    <bpmn:sequenceFlow id="f2" sourceRef="review" targetRef="big" />
    <bpmn:sequenceFlow id="f3" sourceRef="big" targetRef="director">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\${amount &gt; 100000}</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="f4" sourceRef="big" targetRef="end" />
    <bpmn:sequenceFlow id="f5" sourceRef="director" targetRef="end" />
  </bpmn:process>
</bpmn:definitions>`;

describe('parseBpmn', () => {
  const model = parseBpmn(BPMN);

  it('элементы идут в порядке документа с типом и названием', () => {
    assert.equal(model.parsed, true);
    assert.deepEqual(
      model.elements.map((item) => [item.id, item.type, item.name]),
      [
        ['start', 'startEvent', 'Договор получен'],
        ['review', 'userTask', 'Проверить договор'],
        ['big', 'exclusiveGateway', 'Сумма больше 100000?'],
        ['director', 'userTask', 'Согласовать у директора'],
        ['end', 'endEvent', 'Готово'],
      ],
    );
  });

  it('потоки с условием, пулы и дорожки', () => {
    assert.deepEqual(model.flows.find((flow) => flow.id === 'f3'), {
      id: 'f3',
      from: 'big',
      to: 'director',
      condition: '${amount > 100000}',
    });
    assert.equal(model.flows.find((flow) => flow.id === 'f4')?.condition, null);
    assert.deepEqual(model.participants, [{ id: 'P1', name: 'Согласование', process: 'contract-approval' }]);
    assert.deepEqual(model.lanes, [{ id: 'L1', name: 'Юрист', elements: ['review'] }]);
  });

  it('битый XML и не BPMN дают parsed=false', () => {
    assert.equal(parseBpmn('<a><b></a>').parsed, false);
    const other = parseBpmn('<root><x/></root>');
    assert.equal(other.parsed, false);
    assert.match(other.errors[0] ?? '', /definitions/);
  });
});

const REVIEW = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" id="D">
  <bpmn:process id="manualReview" isExecutable="true">
    <bpmn:startEvent id="start" />
    <bpmn:userTask id="operatorReview" name="Оператор" camunda:candidateGroups="operator" />
    <bpmn:boundaryEvent id="operatorTimer" attachedToRef="operatorReview">
      <bpmn:timerEventDefinition><bpmn:timeDuration>PT30M</bpmn:timeDuration></bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:userTask id="seniorReview" name="Старший" camunda:assignee="senior" />
    <bpmn:boundaryEvent id="seniorTimer" attachedToRef="seniorReview" cancelActivity="false">
      <bpmn:timerEventDefinition><bpmn:timeDuration>PT30M</bpmn:timeDuration></bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:exclusiveGateway id="decision" />
    <bpmn:endEvent id="approved" />
    <bpmn:endEvent id="rejected" />
    <bpmn:sequenceFlow id="a" sourceRef="start" targetRef="operatorReview" />
    <bpmn:sequenceFlow id="b" sourceRef="operatorReview" targetRef="decision" />
    <bpmn:sequenceFlow id="c" sourceRef="decision" targetRef="approved" />
    <bpmn:sequenceFlow id="d" sourceRef="decision" targetRef="rejected" />
  </bpmn:process>
</bpmn:definitions>`;

describe('parseBpmn: процесс с таймерами', () => {
  const model = parseBpmn(REVIEW);
  const byId = (id: string) => model.elements.find((item) => item.id === id);

  it('ключ процесса и число элементов по типам', () => {
    assert.deepEqual(model.processIds, ['manualReview']);
    assert.equal(model.counts.startEvent, 1);
    assert.equal(model.counts.endEvent, 2);
    assert.equal(model.counts.userTask, 2);
  });

  it('исполнители задач: группа и исполнитель', () => {
    assert.deepEqual(byId('operatorReview')?.actors, ['operator']);
    assert.deepEqual(byId('seniorReview')?.actors, ['senior']);
  });

  it('граничный таймер: длительность, прерывание, задача', () => {
    assert.deepEqual(byId('operatorTimer'), {
      id: 'operatorTimer',
      type: 'boundaryEvent',
      name: '',
      attachedTo: 'operatorReview',
      interrupting: true,
      timer: 'PT30M',
      durationSeconds: 1800,
    });
    assert.equal(byId('seniorTimer')?.interrupting, false);
    assert.deepEqual(byId('operatorReview')?.boundaryTimer, { timer: 'PT30M', durationSeconds: 1800, interrupting: true });
    assert.deepEqual(byId('seniorReview')?.boundaryTimer, { timer: 'PT30M', durationSeconds: 1800, interrupting: false });
  });

  it('фиксированные часы, минуты и секунды эквивалентны; 29 минут отличаются', () => {
    for (const [timer, expected] of [['PT30M', 1800], ['PT1800S', 1800], ['PT0H30M0S', 1800], ['PT29M', 1740]] as const) {
      const model = parseBpmn(REVIEW.replaceAll('PT30M', timer));
      assert.equal(model.elements.find((item) => item.id === 'operatorReview')?.boundaryTimer?.durationSeconds, expected);
      assert.equal(model.elements.find((item) => item.id === 'operatorReview')?.boundaryTimer?.timer, timer);
    }
  });

  it('дата, цикл, месяцы и непонятная длительность не получают фиксированные секунды', () => {
    for (const [kind, timer] of [['timeDate', '2026-10-30T12:00:00Z'], ['timeCycle', 'R3/PT30M'], ['timeDuration', 'P1M'], ['timeDuration', 'later']] as const) {
      const xml = REVIEW.replaceAll('<bpmn:timeDuration>PT30M</bpmn:timeDuration>', `<bpmn:${kind}>${timer}</bpmn:${kind}>`);
      const model = parseBpmn(xml);
      assert.equal(model.elements.find((item) => item.id === 'operatorReview')?.boundaryTimer?.durationSeconds, null);
    }
  });

  it('у шлюза считаются исходящие потоки', () => {
    assert.equal(byId('decision')?.outgoing, 2);
  });
});

describe('bpmnTypeOf', () => {
  it('типы истории Camunda приводятся к именам элементов BPMN', () => {
    assert.equal(bpmnTypeOf('noneEndEvent'), 'endEvent');
    assert.equal(bpmnTypeOf('messageEndEvent'), 'endEvent');
    assert.equal(bpmnTypeOf('intermediateTimer'), 'intermediateCatchEvent');
    assert.equal(bpmnTypeOf('intermediateMessageThrowEvent'), 'intermediateThrowEvent');
    assert.equal(bpmnTypeOf('boundaryTimer'), 'boundaryEvent');
    assert.equal(bpmnTypeOf('userTask'), 'userTask');
    assert.equal(bpmnTypeOf('exclusiveGateway'), 'exclusiveGateway');
  });
});
