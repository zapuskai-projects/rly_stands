export const PROBE_OPENAPI = `openapi: 3.1.0
info:
  title: Проба релизов
  version: 1.0.0
security: []
paths:
  /api/v1/ping:
    get:
      operationId: getPing
      summary: Состояние
      responses:
        '200':
          description: Ответ
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Ping'
  /api/v1/release-probe:
    get:
      operationId: getReleaseProbe
      x-release: '1.1'
      summary: Проба следующего релиза
      responses:
        '200':
          description: Ответ
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ReleaseProbe'
        '404':
          $ref: '#/components/responses/ProbeMissing'
components:
  responses:
    ProbeMissing:
      description: Нет такого
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ProbeMissing'
  schemas:
    Ping:
      type: object
      required: [status, later]
      properties:
        status:
          type: string
        later:
          type: string
          x-release: '1.1'
    ReleaseProbe:
      type: object
      required: [probe]
      properties:
        probe:
          type: string
    ProbeMissing:
      type: object
      properties:
        code:
          type: string
    Unused:
      type: object
`;

export const PROBE_ASYNCAPI = `asyncapi: '2.6.0'
info:
  title: Проба релизов
  version: 1.0.0
channels:
  bank.probe.created:
    subscribe:
      message:
        $ref: '#/components/messages/ProbeCreated'
  bank.probe.later:
    x-release: '1.1'
    subscribe:
      message:
        $ref: '#/components/messages/ProbeLater'
components:
  messages:
    ProbeCreated:
      payload:
        $ref: '#/components/schemas/ProbeCreated'
    ProbeLater:
      payload:
        $ref: '#/components/schemas/ProbeLater'
  schemas:
    ProbeCreated:
      type: object
      required: [id]
      properties:
        id:
          type: string
        templateId:
          type: string
          x-release: '1.1'
    ProbeLater:
      type: object
      properties:
        id:
          type: string
`;

export const PROBE_DOCUMENT = `---
title: Проба
version: 1.0.0
updated: 2026-10-24
---
# Проба

Общий текст.

## Старый раздел

Остаётся всегда.

## Новый раздел {release=1.1}

Только с релиза 1.1.

### Подраздел

Тоже только с 1.1.

\`\`\`
## Не заголовок
\`\`\`

## Последний раздел

Остаётся всегда.
`;
