import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSequence } from './sequence';

const APPROVAL = `@startuml
title Согласование документа
actor Клиент
participant API
queue "Брокер" as Broker
participant "Сервис согласования" as Approver
database БД
Клиент -> API: POST /documents
API ->> Broker: doc.created
Broker ->> Approver: doc.created
alt согласовано
  Approver -> БД: сохранить решение
  Approver --> Broker: approved
else отклонено
  Approver -> БД: сохранить причину
end
loop пока есть уведомления
  Approver ->> Клиент: уведомление
end
@enduml`;

describe('parseSequence', () => {
  const diagram = parseSequence(APPROVAL);

  it('участники с типами и порядком объявления', () => {
    assert.deepEqual(diagram.participants, [
      { name: 'Клиент', alias: null, id: 'Клиент', kind: 'actor' },
      { name: 'API', alias: null, id: 'API', kind: 'participant' },
      { name: 'Брокер', alias: 'Broker', id: 'Broker', kind: 'queue' },
      { name: 'Сервис согласования', alias: 'Approver', id: 'Approver', kind: 'participant' },
      { name: 'БД', alias: null, id: 'БД', kind: 'database' },
    ]);
  });

  it('сообщения идут по порядку с признаками асинхронности и ответа', () => {
    assert.deepEqual(
      diagram.messages.map((m) => [m.from, m.to, m.label, m.async, m.reply]),
      [
        ['Клиент', 'API', 'POST /documents', false, false],
        ['API', 'Broker', 'doc.created', true, false],
        ['Broker', 'Approver', 'doc.created', true, false],
        ['Approver', 'БД', 'сохранить решение', false, false],
        ['Approver', 'Broker', 'approved', false, true],
        ['Approver', 'БД', 'сохранить причину', false, false],
        ['Approver', 'Клиент', 'уведомление', true, false],
      ],
    );
  });

  it('блоки alt и loop с ветками и границами по сообщениям', () => {
    assert.deepEqual(
      diagram.blocks.map(({ messages: _messages, ...block }) => block),
      [
        {
          kind: 'alt',
          label: 'согласовано',
          fromMessage: 3,
          toMessage: 6,
          branches: [{ label: 'отклонено', fromMessage: 5 }],
        },
        { kind: 'loop', label: 'пока есть уведомления', fromMessage: 6, toMessage: 7, branches: [] },
      ],
    );
    assert.deepEqual(diagram.errors, []);
  });

  it('у блока — сообщения внутри, у сообщения — блок, в котором оно лежит', () => {
    assert.deepEqual(
      diagram.blocks.map((block) => block.messages.map((m) => m.label)),
      [['сохранить решение', 'approved', 'сохранить причину'], ['уведомление']],
    );
    assert.deepEqual(
      diagram.messages.map((m) => m.block),
      [null, null, null, { index: 0, kind: 'alt' }, { index: 0, kind: 'alt' }, { index: 0, kind: 'alt' }, { index: 1, kind: 'loop' }],
    );
  });

  it('вложенный блок — внутренний, параллельные ветки лежат в одном par', () => {
    const nested = parseSequence(`par
  A -> B: первое
else
  A -> C: второе
end
alt отказ
  opt детали
    A -> D: письмо
  end
  A -> E: возврат
end`);
    assert.deepEqual(nested.blocks[0]?.messages.map((m) => m.to), ['B', 'C']);
    assert.deepEqual(
      nested.messages.map((m) => `${m.to}:${m.block?.kind}${m.block?.index}`),
      ['B:par0', 'C:par0', 'D:opt2', 'E:alt1'],
    );
  });

  it('обратная стрелка меняет отправителя и получателя', () => {
    const reversed = parseSequence('A <- B: ответ');
    assert.deepEqual(reversed.messages[0], { from: 'B', to: 'A', label: 'ответ', async: false, reply: false, block: null });
  });

  it('цветные стрелки сохраняют сообщения, направление и подписи', () => {
    for (const arrow of ['-[#blue]>', '-[#00AEEF]>']) {
      const parsed = parseSequence(`A ${arrow} B: запрос\nB --[#blue]> A: ответ`);
      assert.deepEqual(parsed.messages.map((m) => [m.from, m.to, m.label, m.reply]), [
        ['A', 'B', 'запрос', false], ['B', 'A', 'ответ', true],
      ]);
      assert.deepEqual(parsed.errors, []);
    }
  });

  it('удалённое и переставленное сообщение меняет последовательность', () => {
    const source = 'A -[#blue]> B: запрос\nB --[#blue]> A: ответ';
    const messages = (text: string) => parseSequence(text).messages.map((m) => [m.from, m.to, m.label]);
    assert.notDeepEqual(messages(source), messages('A -[#blue]> B: запрос'));
    assert.notDeepEqual(messages(source), messages('B --[#blue]> A: ответ\nA -[#blue]> B: запрос'));
  });

  it('участник с подписью и псевдонимом: в сообщениях и проверках он под псевдонимом, подпись остаётся именем', () => {
    const labelled = parseSequence('participant "Юрист" as lawyer\nactor Инициатор as initiator\nlawyer -> initiator: ответ\n"Юрист" -> initiator: ещё\ninitiator -> lawyer: вопрос');
    assert.deepEqual(labelled.participants, [
      { name: 'Юрист', alias: 'lawyer', id: 'lawyer', kind: 'participant' },
      { name: 'Инициатор', alias: 'initiator', id: 'initiator', kind: 'actor' },
    ]);
    assert.deepEqual(
      labelled.messages.map((m) => [m.from, m.to]),
      [['lawyer', 'initiator'], ['lawyer', 'initiator'], ['initiator', 'lawyer']],
    );
  });

  it('участник из сообщения без объявления создаётся сам', () => {
    const implicit = parseSequence('Foo -> Bar: привет');
    assert.deepEqual(
      implicit.participants.map((p) => [p.name, p.alias, p.id]),
      [['Foo', null, 'Foo'], ['Bar', null, 'Bar']],
    );
  });

  it('неперепутанный порядок отличается от перепутанного', () => {
    const swapped = parseSequence('A -> B: один\nB -> C: два');
    const original = parseSequence('B -> C: два\nA -> B: один');
    assert.notDeepEqual(
      swapped.messages.map((m) => m.label),
      original.messages.map((m) => m.label),
    );
  });

  it('незакрытый блок и лишний end попадают в ошибки', () => {
    assert.deepEqual(parseSequence('alt x\nA -> B: y').errors, ['блок alt не закрыт']);
    assert.deepEqual(parseSequence('end').errors, ['end без начала блока']);
  });
});
