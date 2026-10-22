import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readOrderFacts } from './rabbitmq';

describe('rabbitmq.readOrder: порядок чтения очереди', () => {
  const sent = [
    { id: 'normal', marker: 'm-1' },
    { id: 'urgent', marker: 'm-2' },
  ];

  it('порядок берётся из ответа очереди, а не из порядка публикации', () => {
    assert.deepEqual(readOrderFacts(sent, ['m-2', 'm-1']), { readOrder: ['urgent', 'normal'], missing: [] });
    assert.deepEqual(readOrderFacts(sent, ['m-1', 'm-2']), { readOrder: ['normal', 'urgent'], missing: [] });
  });

  it('чужие сообщения очереди пропускаются, не вернувшиеся попадают в missing', () => {
    assert.deepEqual(readOrderFacts(sent, ['чужое', 'm-2', 'ещё-чужое']), { readOrder: ['urgent'], missing: ['normal'] });
    assert.deepEqual(readOrderFacts(sent, []), { readOrder: [], missing: ['normal', 'urgent'] });
  });
});
