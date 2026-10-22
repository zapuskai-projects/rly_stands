import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OPENAPI_PATH } from '../config';
import { loadContract, type OperationSpec } from './contract';

const contract = loadContract(OPENAPI_PATH);
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
    const ids = contract.operations.map((item) => item.operationId).sort();
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
    const open = contract.operations.filter((item) => item.auth === 'NONE').map((item) => item.operationId).sort();
    assert.deepEqual(open, ['getHealth', 'listSandboxSms', 'loginOperator', 'requestLoginCode', 'verifyLoginCode']);
    const operator = contract.operations.filter((item) => item.auth === 'OPERATOR').map((item) => item.operationId);
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
