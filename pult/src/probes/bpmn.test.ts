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
