import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { queryErrorOf } from './clickhouse';

describe('queryErrorOf', () => {
  it('текст ошибки сервера без обвязки', () => {
    assert.equal(
      queryErrorOf("Code: 60. DB::Exception: Table student.live_missing does not exist. (UNKNOWN_TABLE) (version 24.8.14.39 (official build))\n"),
      'Table student.live_missing does not exist. (UNKNOWN_TABLE) (version 24.8.14.39 (official build))',
    );
  });

  it('ошибка внутри JSON-ответа не превращается в «{»', () => {
    const body = '{\n\t"meta":\n\t[\n\n\t],\n\t"rows": 0,\n\t"exception": "Code: 164. DB::Exception: student: Cannot execute query in readonly mode. (READONLY) (version 24.8)"\n}';
    assert.match(queryErrorOf(body) ?? '', /^student: Cannot execute query in readonly mode/);
  });

  it('текст без кода сервера — первая непустая строка, пустой ответ — null', () => {
    assert.equal(queryErrorOf('\n  плохой запрос\nвторая строка'), 'плохой запрос');
    assert.equal(queryErrorOf('  \n'), null);
  });
});
