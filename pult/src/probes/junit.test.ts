import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { groupCases, groupName, JUNIT_EXECUTORS, junitFacts, parseJunitFile, withoutTestngDuplicates, type JunitCase } from './junit';

const PYTEST = `<?xml version="1.0" encoding="utf-8"?>
<testsuites name="pytest tests">
  <testsuite name="pytest" errors="0" failures="1" skipped="1" tests="5">
    <testcase classname="tests.test_limit" name="test_daily_limit[49999-COMPLETED]" time="0.4"/>
    <testcase classname="tests.test_limit" name="test_daily_limit[50001-REJECTED]" time="0.3"/>
    <testcase classname="tests.test_limit" name="test_daily_limit[exact-COMPLETED]" time="0.5">
      <failure message="assert 'REJECTED' == 'COMPLETED'">traceback</failure>
    </testcase>
    <testcase classname="tests.test_login" name="test_login" time="0.1"/>
    <testcase classname="tests.test_login" name="test_later"><skipped type="pytest.skip" message="later"/></testcase>
  </testsuite>
</testsuites>`;

const SUREFIRE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="LimitTest" tests="2" errors="1" failures="0" skipped="0">
  <testcase name="limit(int)[1]" classname="bank.LimitTest" time="0.01"/>
  <testcase name="limit(int)[2]" classname="bank.LimitTest" time="0.02"><error message="NullPointerException" type="java.lang.NullPointerException">at ...</error></testcase>
</testsuite>`;

const JEST = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="jest tests" tests="1" failures="0">
  <testsuite name="accounts" tests="1">
    <testcase classname="accounts main account" name="accounts main account" time="0.2"></testcase>
  </testsuite>
</testsuites>`;

describe('junit: разбор отчётов разных фреймворков', () => {
  it('pytest: статусы, сообщение упавшего и пропущенный', () => {
    const { cases, error } = parseJunitFile(PYTEST, 'pytest.xml');
    assert.equal(error, null);
    assert.deepEqual(cases.map((item) => item.status), ['passed', 'passed', 'failed', 'passed', 'skipped']);
    assert.equal(cases[2]?.message, "assert 'REJECTED' == 'COMPLETED'");
  });

  it('surefire: error считается отдельно от failure, корень testsuite без testsuites', () => {
    const { cases } = parseJunitFile(SUREFIRE, 'TEST-LimitTest.xml');
    assert.deepEqual(cases.map((item) => item.status), ['passed', 'error']);
    assert.equal(cases[1]?.message, 'NullPointerException');
  });

  it('jest-junit: пустой testcase с открывающим и закрывающим тегом — прошедший', () => {
    assert.deepEqual(parseJunitFile(JEST, 'junit.xml').cases.map((item) => item.status), ['passed']);
  });

  it('не XML — ошибка разбора с именем файла, тестов нет', () => {
    const parsed = parseJunitFile('<testsuite><testcase', 'broken.xml');
    assert.equal(parsed.cases.length, 0);
    assert.match(parsed.error ?? '', /^broken\.xml:/);
  });
});

describe('junit: факты по отчётам', () => {
  const pytest = parseJunitFile(PYTEST, 'pytest.xml').cases;

  it('счётчики и имена упавших в коротком и полном виде', () => {
    const facts = junitFacts(['pytest.xml'], pytest, []);
    assert.equal(facts.tests, 5);
    assert.equal(facts.passed, 3);
    assert.equal(facts.failures, 1);
    assert.equal(facts.errors, 0);
    assert.equal(facts.skipped, 1);
    assert.equal(facts.failed, 1);
    assert.equal(facts.allPassed, false);
    assert.deepEqual(facts.failedNames, ['test_daily_limit[exact-COMPLETED]', 'tests.test_limit.test_daily_limit[exact-COMPLETED]']);
  });

  it('имена прошедших тестов одним текстом: упавшие и пропущенные в него не входят', () => {
    const facts = junitFacts(['pytest.xml'], pytest, []);
    assert.equal(facts.passedNamesText.split('\n').length, 3);
    assert.ok(!facts.passedNamesText.includes('exact-COMPLETED'));
  });

  it('параметризованные строки собираются в группу по имени до [ или (', () => {
    const facts = junitFacts(['pytest.xml'], pytest, []);
    assert.equal(facts.maxGroupSize, 3);
    assert.deepEqual(facts.largestGroup, { name: 'test_daily_limit', classname: 'tests.test_limit', count: 3, passed: 2, failed: 1 });
    assert.equal(groupName('limit(int)[2]'), 'limit');
    assert.equal(groupName('[1] 100'), '[1] 100');
    assert.equal(groupName('plain'), 'plain');
  });

  it('отчётов нет — exists=false и нули, а не сбой', () => {
    const facts = junitFacts([], [], []);
    assert.equal(facts.exists, false);
    assert.equal(facts.allPassed, false);
    assert.equal(facts.tests, 0);
    assert.equal(facts.maxGroupSize, 0);
    assert.equal(facts.largestGroup, null);
  });

  it('allPassed — отчёт есть и в нём нет упавших и ошибок', () => {
    const passed = parseJunitFile(PYTEST, 'pytest.xml').cases.filter((item) => item.status === 'passed');
    assert.equal(junitFacts(['pytest.xml'], passed, []).allPassed, true);
  });

  it('error тоже попадает в упавшие', () => {
    const facts = junitFacts(['a.xml'], parseJunitFile(SUREFIRE, 'a.xml').cases, []);
    assert.equal(facts.failed, 1);
    assert.equal(facts.errors, 1);
    assert.equal(facts.failures, 0);
  });
});

describe('junit: группы параметризованных тестов разных фреймворков', () => {
  const row = (name: string, classname: string): JunitCase => ({ name, classname, status: 'passed', message: '', file: 'a.xml' });

  it('Jest test.each: без явной пометки параметров названия не склеиваются, с [значение] — одна группа', () => {
    const plain = ['daily limit limit less_by_ruble', 'daily limit limit more_by_ruble', 'daily limit limit exact'].map((name) => row(name, name));
    assert.equal(groupCases(plain).length, 3);
    const marked = ['limit [less_by_ruble]', 'limit [more_by_ruble]', 'limit [exact]'].map((name) => row(name, name));
    const groups = groupCases(marked);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.count, 3);
  });

  it('Jest: разные тесты в одном describe не склеиваются, если названия короткие', () => {
    const groups = groupCases([row('login works', 'login works'), row('login fails', 'login fails'), row('logout works', 'logout works')]);
    assert.equal(groups.length, 3);
  });

  it('разные тесты с общим началом названия не склеиваются', () => {
    const groups = groupCases([row('user can log in with phone', 'a'), row('user can log in with card', 'a'), row('user can log out of app', 'a')]);
    assert.equal(groups.length, 3);
  });

  it('JUnit 5: строки [1] [2] [3] одного класса — одна группа; методы с (int)[1] — по имени метода', () => {
    const indexed = groupCases([row('[1] 100', 'LimitTest'), row('[2] 200', 'LimitTest'), row('[3] 300', 'LimitTest')]);
    assert.deepEqual(indexed.map((group) => group.count), [3]);
    const named = groupCases([row('dailyLimit(int, String)[1]', 'LimitTest'), row('dailyLimit(int, String)[2]', 'LimitTest'), row('other()', 'LimitTest')]);
    assert.deepEqual(named.map((group) => [group.name, group.count]), [['dailyLimit', 2], ['other', 1]]);
  });

  it('TestNG: одинаковые имена одного класса — одна группа', () => {
    const groups = groupCases([row('dailyLimit', 'NgTest'), row('dailyLimit', 'NgTest'), row('dailyLimit', 'NgTest'), row('broken', 'NgTest')]);
    assert.deepEqual(groups.map((group) => [group.name, group.count]), [['dailyLimit', 3], ['broken', 1]]);
  });

  it('TestNG пишет один отчёт трижды: остаются только файлы из junitreports', () => {
    const paths = [
      'junit5/TEST-junit-jupiter.xml',
      'testng/Command line suite/Command line test.xml',
      'testng/testng-failed.xml',
      'testng/junitreports/TEST-NgTest.xml',
      'testng/testng-results.xml',
    ];
    assert.deepEqual(withoutTestngDuplicates(paths), ['junit5/TEST-junit-jupiter.xml', 'testng/junitreports/TEST-NgTest.xml']);
    assert.deepEqual(withoutTestngDuplicates(['junit.xml', 'pytest/report.xml']), ['junit.xml', 'pytest/report.xml']);
    assert.deepEqual(withoutTestngDuplicates(['junit.xml', 'testng-results.xml', 'Suite/Test.xml']), ['junit.xml', 'Suite/Test.xml']);
  });

  it('testng-results.xml в корне папки отчётов: чужие отчёты остаются, отбрасываются только файлы testng-*', () => {
    const paths = ['junit5/TEST-a.xml', 'pytest/report.xml', 'junit.xml', 'testng-results.xml', 'testng-failed.xml', 'junitreports/TEST-NgTest.xml'];
    assert.deepEqual(withoutTestngDuplicates(paths), ['junit5/TEST-a.xml', 'pytest/report.xml', 'junit.xml', 'junitreports/TEST-NgTest.xml']);
  });
});

describe('junit.report: ограничения', () => {
  let work = '';
  before(() => {
    work = mkdtempSync(join(tmpdir(), 'kit-junit-'));
  });
  after(() => rmSync(work, { recursive: true, force: true }));
  const ctx = () => ({ workDir: work, label: 'k7f3qa', dataDir: work });
  const report = (dir: string) => JUNIT_EXECUTORS['junit.report']!({ dir }, ctx()) as Promise<Record<string, unknown>>;

  it('файл больше 5 МБ не читается: ошибка «отчёт слишком большой», остальные отчёты читаются', async () => {
    mkdirSync(join(work, 'big'), { recursive: true });
    writeFileSync(join(work, 'big', 'huge.xml'), `<testsuite>${' '.repeat(5 * 1024 * 1024 + 10)}</testsuite>`);
    writeFileSync(join(work, 'big', 'ok.xml'), '<testsuite><testcase classname="a" name="t"/></testsuite>');
    const facts = await report('big');
    assert.deepEqual(facts.files, ['ok.xml']);
    assert.match(String((facts.parseErrors as string[])[0]), /huge\.xml: отчёт слишком большой/);
    assert.equal(facts.tests, 1);
  });

  it('внешние сущности не раскрываются', async () => {
    mkdirSync(join(work, 'ent'), { recursive: true });
    writeFileSync(
      join(work, 'ent', 'bomb.xml'),
      '<?xml version="1.0"?><!DOCTYPE t [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><testsuite><testcase classname="c" name="&b;"/></testsuite>',
    );
    const facts = (await report('ent')) as { cases: Array<{ name: string }> };
    assert.equal(facts.cases[0]?.name, '&b;');
  });

  it('xml находятся среди сотен других файлов; больше 200 отчётов — ошибка, а не пропуск', async () => {
    mkdirSync(join(work, 'many'), { recursive: true });
    for (let index = 0; index < 250; index += 1) writeFileSync(join(work, 'many', `a${String(index).padStart(3, '0')}.log`), 'x');
    writeFileSync(join(work, 'many', 'z.xml'), '<testsuite><testcase classname="a" name="t"/></testsuite>');
    assert.equal(((await report('many')) as { tests: number }).tests, 1);
    mkdirSync(join(work, 'over'), { recursive: true });
    for (let index = 0; index < 201; index += 1) writeFileSync(join(work, 'over', `r${index}.xml`), '<testsuite/>');
    await assert.rejects(report('over'), /слишком много отчётов \(201\)/);
  });
});
