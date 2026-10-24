import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OPENAPI_PATH, PARTNER_OPENAPI_PATH } from '../config';
import { PROBE_OPENAPI } from '../testing/release-spec';
import { loadContract, parseContract, type OperationSpec } from './contract';

const contract = loadContract(OPENAPI_PATH);
const firstRelease = contract.operations.filter((item) => item.release === null);
const operation = (id: string): OperationSpec => {
  const found = contract.operations.find((item) => item.operationId === id);
  if (!found) throw new Error(`нет операции ${id}`);
  return found;
};

const validPhoneTransfer = {
  type: 'PHONE_TRANSFER',
  fromAccount: '40817810800000001000',
  recipientPhone: '+79001110002',
  amount: 150000,
};

describe('контракт OpenAPI', () => {
  it('содержит все операции API с уникальными идентификаторами', () => {
    const ids = firstRelease.map((item) => item.operationId).sort();
    assert.equal(new Set(ids).size, ids.length);
    for (const id of [
      'approveReview', 'createTransfer', 'getAccount', 'getHealth', 'getOfficeClient', 'getOfficeOperation', 'getOfficeReview',
      'getOperation', 'getOperatorProfile', 'getProfile', 'getStatement', 'listAccounts', 'listBanks', 'listOfficeClients',
      'listOfficeNotifications', 'listOfficeOperations', 'listOfficeReviews', 'listOperations', 'listSandboxSms', 'listTariffs',
      'loginOperator', 'logout', 'logoutOperator', 'lookupRecipient', 'rejectReview', 'requestLoginCode', 'setClientDailyLimit',
      'updateTariff', 'verifyLoginCode',
    ]) {
      assert.ok(ids.includes(id), id);
    }
    assert.equal(ids.length, 29);
  });

  it('защищены токеном клиента или оператора все операции, кроме входа, справочных и учебных', () => {
    const open = firstRelease.filter((item) => item.auth === 'NONE').map((item) => item.operationId).sort();
    assert.deepEqual(open, ['getHealth', 'listSandboxSms', 'loginOperator', 'requestLoginCode', 'verifyLoginCode']);
    const operator = firstRelease.filter((item) => item.auth === 'OPERATOR').map((item) => item.operationId);
    assert.equal(operator.length, 14);
    assert.equal(operation('createTransfer').auth, 'CLIENT');
  });

  it('пути переведены в синтаксис Express', () => {
    assert.equal(operation('getStatement').expressPath, '/api/v1/accounts/:accountId/statement');
  });

  it('создание перевода требует заголовок Idempotency-Key', () => {
    const header = operation('createTransfer').params.find((param) => param.name === 'Idempotency-Key');
    assert.equal(header?.required, true);
    assert.equal(header?.location, 'header');
    assert.equal(header?.validator.validate('retry-key-1').ok, true);
    assert.equal(header?.validator.validate('short').ok, false);
  });
});

const NEXT_RELEASE_OPERATIONS = [
  'cancelAutopayment',
  'createAutopayment',
  'createTemplate',
  'createTemplateTransfer',
  'deleteTemplate',
  'listAutopaymentRuns',
  'listAutopayments',
  'listOfficeClientAutopayments',
  'listOfficeClientTemplates',
  'listTemplates',
  'pauseAutopayment',
  'resumeAutopayment',
  'runSandboxAutopayment',
  'updateTemplate',
];

describe('операции релиза 1.1 в контракте', () => {
  it('все помечены релизом 1.1 и защищены токеном', () => {
    const marked = contract.operations.filter((item) => item.release === '1.1');
    assert.deepEqual(marked.map((item) => item.operationId).sort(), NEXT_RELEASE_OPERATIONS);
    assert.equal(marked.filter((item) => item.auth === 'OPERATOR').length, 2);
    assert.equal(marked.filter((item) => item.auth === 'CLIENT').length, 12);
  });

  it('создание шаблона принимает название с операцией или с видом и счётом, чужие поля отвергает', () => {
    const body = operation('createTemplate').body?.validator;
    assert.equal(body?.validate({ name: 'Аренда', fromOperationId: '0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b' }).ok, true);
    assert.equal(body?.validate({ name: 'Маме', kind: 'PHONE', fromAccount: '40817810800000001000', recipientPhone: '+79001110002', amount: 500000 }).ok, true);
    assert.equal(body?.validate({ kind: 'PHONE' }).ok, false);
    assert.equal(body?.validate({ name: '' }).ok, false);
    assert.equal(body?.validate({ name: 'я'.repeat(41) }).ok, false);
    assert.equal(body?.validate({ name: 'Х', kind: 'CARD' }).ok, false);
    assert.equal(body?.validate({ name: 'Х', extra: 1 }).ok, false);
  });

  it('изменение шаблона требует хотя бы одно поле и принимает сумму null', () => {
    const body = operation('updateTemplate').body?.validator;
    assert.equal(body?.validate({}).ok, false);
    assert.equal(body?.validate({ amount: null }).ok, true);
    assert.equal(body?.validate({ name: 'Новое' }).ok, true);
  });

  it('автоплатёж принимает день месяца от 1 до 28 и дату вида 2026-12-31', () => {
    const body = operation('createAutopayment').body?.validator;
    const base = { templateId: '0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b', dayOfMonth: 15 };
    assert.equal(body?.validate(base).ok, true);
    assert.equal(body?.validate({ ...base, amount: 100, endsOn: '2027-06-15' }).ok, true);
    for (const dayOfMonth of [0, 29, 31, 1.5]) assert.equal(body?.validate({ ...base, dayOfMonth }).ok, false, String(dayOfMonth));
    assert.equal(body?.validate({ ...base, endsOn: '15.06.2027' }).ok, false);
    assert.equal(body?.validate({ dayOfMonth: 5 }).ok, false);
  });

  it('перевод по шаблону требует ключ повтора, тело необязательно', () => {
    const spec = operation('createTemplateTransfer');
    assert.equal(spec.params.find((param) => param.name === 'Idempotency-Key')?.required, true);
    assert.equal(spec.body?.required, false);
    assert.equal(spec.body?.validator.validate({ amount: 0 }).ok, false);
    assert.equal(spec.body?.validator.validate({ amount: 100, comment: 'за июнь' }).ok, true);
  });
});

describe('операции релиза 1.2 в контракте', () => {
  it('оплата по QR помечена релизом 1.2 и защищена токеном клиента', () => {
    const marked = contract.operations.filter((item) => item.release === '1.2');
    assert.deepEqual(marked.map((item) => item.operationId).sort(), ['createQrPayment', 'lookupQrPayment']);
    assert.ok(marked.every((item) => item.auth === 'CLIENT'));
  });

  it('оплата требует ключ повтора, содержимое QR и счёт', () => {
    const spec = operation('createQrPayment');
    assert.equal(spec.params.find((param) => param.name === 'Idempotency-Key')?.required, true);
    const body = spec.body?.validator;
    const accountId = '0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
    assert.equal(body?.validate({ payload: 'zbqr://pay?id=7b0c5d12-3a4e-4f6a-9d21-5c8e1f0a2b34', accountId }).ok, true);
    assert.equal(body?.validate({ payload: '', accountId }).ok, false);
    assert.equal(body?.validate({ payload: 'zbqr://pay?id=x', accountId: 'не-идентификатор' }).ok, false);
    assert.equal(body?.validate({ payload: 'zbqr://pay?id=x' }).ok, false);
    assert.equal(body?.validate({ payload: 'zbqr://pay?id=x', accountId, extra: 1 }).ok, false);
  });
});

describe('партнёрский контракт', () => {
  const partner = loadContract(PARTNER_OPENAPI_PATH);
  const partnerOperation = (id: string): OperationSpec => partner.operations.find((item) => item.operationId === id) as OperationSpec;

  it('все операции помечены релизом 1.2 и защищены ключом магазина', () => {
    assert.deepEqual(partner.operations.map((item) => item.operationId).sort(), ['cancelPartnerQr', 'createPartnerQr', 'createPartnerQrRefund', 'getPartnerQr', 'listPartnerWebhookDeliveries', 'setPartnerWebhook']);
    assert.ok(partner.operations.every((item) => item.release === '1.2' && item.auth === 'PARTNER'));
    assert.equal(partnerOperation('getPartnerQr').expressPath, '/partner/v1/qr/:qrId');
  });

  it('возврат требует ключ повтора и сумму, настройка уведомлений — адрес и секрет', () => {
    const refund = partnerOperation('createPartnerQrRefund');
    assert.equal(refund.params.find((param) => param.name === 'Idempotency-Key')?.required, true);
    assert.equal(refund.body?.validator.validate({ amount: 1 }).ok, true);
    for (const body of [{}, { amount: 0 }, { amount: 1.5 }, { amount: 100_000_001 }, { amount: 1, extra: 1 }]) {
      assert.equal(refund.body?.validator.validate(body).ok, false, JSON.stringify(body));
    }
    const webhook = partnerOperation('setPartnerWebhook').body?.validator;
    assert.equal(webhook?.validate({ url: 'http://host.docker.internal:8080/h', secret: 's' }).ok, true);
    for (const body of [{ url: 'http://x' }, { secret: 's' }, { url: '', secret: 's' }, { url: 'http://x', secret: '' }, { url: 'http://x', secret: 's', extra: 1 }]) {
      assert.equal(webhook?.validate(body).ok, false, JSON.stringify(body));
    }
  });

  it('выставление QR принимает заказ, срок от 60 до 3600 и отвергает остальное', () => {
    const body = partnerOperation('createPartnerQr').body?.validator;
    const order = { orderId: 'order-1', amount: 1000, description: 'Заказ' };
    assert.equal(body?.validate(order).ok, true);
    assert.equal(body?.validate({ ...order, ttlSeconds: 60 }).ok, true);
    assert.equal(body?.validate({ ...order, ttlSeconds: 3600 }).ok, true);
    for (const patch of [{ ttlSeconds: 59 }, { ttlSeconds: 3601 }, { amount: 0 }, { amount: 100_000_001 }, { amount: 1.5 }, { orderId: 'с пробелом' }, { description: '' }, { extra: 1 }]) {
      assert.equal(body?.validate({ ...order, ...patch }).ok, false, JSON.stringify(patch));
    }
  });
});

describe('релиз операции в контракте', () => {
  it('пометка x-release попадает в операцию, без неё операция доступна с первого релиза', () => {
    const probe = parseContract(PROBE_OPENAPI);
    assert.equal(probe.operations.find((item) => item.operationId === 'getReleaseProbe')?.release, '1.1');
    assert.equal(probe.operations.find((item) => item.operationId === 'getPing')?.release, null);
  });

  it('неизвестный релиз в пометке не загружается', () => {
    assert.throws(() => parseContract(PROBE_OPENAPI.replace("x-release: '1.1'\n      summary", "x-release: '4.4'\n      summary")), /4\.4/);
  });
});

describe('проверка тела создания перевода по контракту', () => {
  const body = () => {
    const spec = operation('createTransfer').body;
    if (!spec) throw new Error('нет тела');
    return spec.validator;
  };

  it('принимает перевод по телефону и между своими счетами', () => {
    assert.equal(body().validate(validPhoneTransfer).ok, true);
    assert.equal(
      body().validate({ type: 'OWN_TRANSFER', fromAccount: '40817810800000001000', toAccount: '40817810100000001001', amount: 100 }).ok,
      true,
    );
    assert.equal(body().validate({ ...validPhoneTransfer, recipientBankCode: 'KEDR', comment: 'обед' }).ok, true);
  });

  it('сумма должна быть целым положительным числом копеек', () => {
    for (const amount of [0, -5, 10.5, '100', null]) {
      assert.equal(body().validate({ ...validPhoneTransfer, amount }).ok, false, String(amount));
    }
  });

  it('телефон только в формате +79XXXXXXXXX', () => {
    for (const recipientPhone of ['89001110002', '+7900111000', '+74951110002', '+79001110002 ', '']) {
      assert.equal(body().validate({ ...validPhoneTransfer, recipientPhone }).ok, false, recipientPhone);
    }
  });

  it('неизвестные поля и чужие поля вида перевода отвергаются', () => {
    assert.equal(body().validate({ ...validPhoneTransfer, extra: 1 }).ok, false);
    assert.equal(body().validate({ ...validPhoneTransfer, toAccount: '40817810100000001001' }).ok, false);
  });

  it('неизвестный вид перевода называет допустимые значения', () => {
    const result = body().validate({ ...validPhoneTransfer, type: 'CARD_TRANSFER' });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.issues[0]?.field, 'type');
      assert.match(result.issues[0]?.message ?? '', /OWN_TRANSFER, PHONE_TRANSFER/);
    }
  });

  it('ошибка указывает поле', () => {
    const result = body().validate({ ...validPhoneTransfer, fromAccount: '123' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.issues[0]?.field, 'fromAccount');
  });
});

describe('проверка запросов оператора по контракту', () => {
  it('вход оператора требует логин и пароль', () => {
    const body = operation('loginOperator').body;
    assert.equal(body?.required, true);
    assert.equal(body?.validator.validate({ login: 'operator', password: 'operator-2026' }).ok, true);
    assert.equal(body?.validator.validate({ login: 'operator' }).ok, false);
    assert.equal(body?.validator.validate({ login: '', password: 'x' }).ok, false);
  });

  it('при отклонении комментарий обязателен, при одобрении — нет', () => {
    const reject = operation('rejectReview').body;
    assert.equal(reject?.required, true);
    assert.equal(reject?.validator.validate({}).ok, false);
    assert.equal(reject?.validator.validate({ comment: 'ab' }).ok, false);
    assert.equal(reject?.validator.validate({ comment: 'Подозрительный получатель' }).ok, true);
    const approve = operation('approveReview').body;
    assert.equal(approve?.required, false);
    assert.equal(approve?.validator.validate({ comment: 'Клиент подтвердил по телефону' }).ok, true);
    assert.equal(approve?.validator.validate({ extra: 1 }).ok, false);
  });

  it('конфликт 409 описан у обоих действий', () => {
    assert.ok(operation('approveReview').responses.get(409));
    assert.ok(operation('rejectReview').responses.get(409));
  });

  it('правка тарифа принимает только неотрицательные целые и ставку до 100 %', () => {
    const body = operation('updateTariff').body;
    const valid = { dailyPhoneTransferLimit: 15000000, freeMonthlyVolume: 10000000, commissionRateBps: 100, commissionMin: 3000, commissionMax: 150000 };
    assert.equal(body?.validator.validate(valid).ok, true);
    assert.equal(body?.validator.validate({ ...valid, commissionRateBps: 10001 }).ok, false);
    assert.equal(body?.validator.validate({ ...valid, commissionMin: -1 }).ok, false);
    assert.equal(body?.validator.validate({ ...valid, freeMonthlyVolume: 1.5 }).ok, false);
  });

  it('личный лимит клиента принимает число или null', () => {
    const body = operation('setClientDailyLimit').body;
    assert.equal(body?.validator.validate({ dailyPhoneTransferLimit: 1000000 }).ok, true);
    assert.equal(body?.validator.validate({ dailyPhoneTransferLimit: null }).ok, true);
    assert.equal(body?.validator.validate({ dailyPhoneTransferLimit: -5 }).ok, false);
    assert.equal(body?.validator.validate({}).ok, false);
  });
});

describe('проверка ответов по контракту', () => {
  it('операция создана: описаны коды 201 и 200 с телом и 422 с ошибкой', () => {
    const { responses } = operation('createTransfer');
    assert.ok(responses.get(201));
    assert.ok(responses.get(200));
    assert.ok(responses.get(422));
    assert.equal(responses.has(204), false);
  });

  it('выход описан ответом без тела', () => {
    assert.equal(operation('logout').responses.get(204), null);
  });

  it('ошибка требует код, сообщение и номер запроса', () => {
    const validator = operation('getOperation').responses.get(404);
    assert.equal(validator?.validate({ code: 'X', message: 'm', requestId: 'r' }).ok, true);
    assert.equal(validator?.validate({ code: 'X', message: 'm' }).ok, false);
    assert.equal(validator?.validate({ code: 'X', message: 'm', requestId: 'r', stack: 'трасса' }).ok, false);
  });

  it('параметры страницы приводятся к числам', () => {
    const limit = operation('listOperations').params.find((param) => param.name === 'limit');
    assert.equal(limit?.coerce, 'number');
    assert.equal(limit?.validator.validate(100).ok, true);
    assert.equal(limit?.validator.validate(101).ok, false);
  });
});
