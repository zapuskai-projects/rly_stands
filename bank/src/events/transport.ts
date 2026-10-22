import type { EventTransport } from './outbox.publisher';
import type { OutboxRecord } from './outbox.repository';

export class RoutingTransport implements EventTransport {
  constructor(
    private readonly kafka: EventTransport,
    private readonly rabbit: EventTransport,
  ) {}

  send(record: OutboxRecord): Promise<void> {
    return record.destination === 'KAFKA' ? this.kafka.send(record) : this.rabbit.send(record);
  }
}
